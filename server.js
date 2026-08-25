const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.set('trust proxy', 1);

// ============================================================================
// ১. সিকিউরিটি ও কাস্টম ACCESS DENIED শিল্ড
// ============================================================================
const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Access Denied - HOME AIR TV</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Poppins', sans-serif; }
    body { background: #0b0c10; min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; padding: 20px; text-align: center; }
    .card { background: #151821; border: 1px solid #ff5500; border-radius: 24px; padding: 40px; max-width: 440px; width: 100%; box-shadow: 0 10px 40px rgba(255,85,0,0.2); }
    h2 { font-size: 24px; color: #ff5500; margin-bottom: 12px; }
    p { font-size: 14px; color: #8c93a8; margin-bottom: 24px; line-height: 1.6; }
    a { display: block; background: linear-gradient(135deg, #ff8800, #ff4500); color: #fff; text-decoration: none; padding: 14px; border-radius: 12px; font-weight: 700; transition: transform 0.2s; }
    a:hover { transform: scale(1.02); }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚫 Protected Stream</h2>
    <p>Direct unauthorized hotlinking is restricted. Stream directly through the official media platform.</p>
    <a href="https://hmair.xyz">Open Official Platform</a>
  </div>
</body>
</html>`;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================================
// ২. মেমোরি ক্যাশ ও ব্রাউজার পুল
// ============================================================================
const memoryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const activeResolutions = new Map();

let clusterBrowser = null;

async function getClusterBrowser() {
  if (clusterBrowser && clusterBrowser.isConnected()) return clusterBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cluster-'));
  clusterBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts'
    ]
  });
  return clusterBrowser;
}

getClusterBrowser().catch(() => {});

// ============================================================================
// ৩. অ্যানিমে ও টিভি সিরিজের জন্য গ্লোবাল প্রোভাইডার তালিকা
// ============================================================================
function getGlobalProviders(params) {
  const { id, isTv, season, episode } = params;

  if (isTv) {
    return [
      { name: 'Vidnest', url: `https://vidnest.fun/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}` },
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${season}/${episode}` },
      { name: 'VidRock', url: `https://vidrock.net/embed/tv/${id}/${season}/${episode}` },
      { name: 'Videasy', url: `https://player.videasy.net/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}` },
      { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` }
    ];
  }

  return [
    { name: 'Vidnest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/movie/${id}` },
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/embed/movie/${id}` },
    { name: 'Videasy', url: `https://player.videasy.net/movie/${id}` },
    { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/movie?tmdb=${id}` },
    { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/movie/${id}` }
  ];
}

// ============================================================================
// ৪. আল্ট্রা-ফাস্ট সিঙ্গেল পেজ স্ক্র্যাপার রানার
// ============================================================================
async function executeTargetScrape(browser, provider) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (['image', 'font'].includes(type) || url.includes('analytics') || url.includes('doubleclick') || url.includes('clarity')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    return await new Promise((resolve) => {
      let resolved = false;

      page.on('response', async (response) => {
        const u = response.url();
        const isMedia = (u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'))) &&
                        !u.includes('demo') && !u.includes('trailer') && !u.includes('preview');

        if (isMedia && !resolved) {
          resolved = true;
          await page.close().catch(() => {});
          resolve({ streamUrl: u, usedUrl: provider.url, providerName: provider.name });
        }
      });

      page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 8000 })
        .then(async () => {
          const frames = [page.mainFrame(), ...page.frames()];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button, [class*="play"]'));
                if (elements.length > 0) elements[0].click();
              });
            } catch (e) {}
          }
        })
        .catch(() => {});

      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          await page.close().catch(() => {});
          resolve(null);
        }
      }, 5000);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

// ============================================================================
// ৫. প্যারালাল ফাস্ট-রেস স্ক্র্যাপার ইঞ্জিন
// ============================================================================
async function raceAllProviders(browser, providers) {
  const batch1 = providers.slice(0, 3);
  const batch2 = providers.slice(3);

  const promisesBatch1 = batch1.map(p => executeTargetScrape(browser, p));
  const resultsBatch1 = await Promise.all(promisesBatch1);
  const winner1 = resultsBatch1.find(r => r !== null);
  if (winner1) return winner1;

  const promisesBatch2 = batch2.map(p => executeTargetScrape(browser, p));
  const resultsBatch2 = await Promise.all(promisesBatch2);
  const winner2 = resultsBatch2.find(r => r !== null);
  if (winner2) return winner2;

  return null;
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'anime';
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  const title = query.title || '';

  return { id: targetId, typeStr, isTv, season, episode, lang, title };
}

// ============================================================================
// ৬. মেইন রেজলভার API (অ্যানিমে এবং টিভি সিরিজ সরাসরি স্ক্র্যাপ করবে)
// ============================================================================
app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;

  // ১. মেমোরি ক্যাশ হিট চেক
  if (memoryCache.has(cacheKey)) {
    const cached = memoryCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      provider: cached.provider,
      type: params.typeStr
    });
  }

  // ২. কনকারেন্সি লকার
  if (activeResolutions.has(cacheKey)) {
    try {
      const result = await activeResolutions.get(cacheKey);
      if (result) {
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          rawUrl: result.url,
          provider: result.provider,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  // ৩. লাইভ প্যারালাল স্ক্র্যাপিং (অ্যানিমে ও মুভির জন্য সরাসরি .m3u8 খুঁজবে)
  const scrapeTask = (async () => {
    try {
      const browser = await getClusterBrowser();
      const providers = getGlobalProviders(params);
      const result = await raceAllProviders(browser, providers);
      if (result) {
        const data = { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() };
        memoryCache.set(cacheKey, data);
        return data;
      }
      return null;
    } catch (err) {
      return null;
    } finally {
      activeResolutions.delete(cacheKey);
    }
  })();

  activeResolutions.set(cacheKey, scrapeTask);
  const finalResult = await scrapeTask;

  if (finalResult) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      rawUrl: finalResult.url,
      provider: finalResult.provider,
      type: params.typeStr
    });
  }

  // ৪. কোনো প্রোভাইডারে মিডিয়া স্ট্রিম না পেলে সেফ এম্বেড
  const fallbackEmbed = params.isTv 
    ? `https://vidsrc.sbs/embed/tv/${params.id}/${params.season}/${params.episode}`
    : `https://vidsrc.sbs/embed/movie/${params.id}`;

  return res.json({
    success: true,
    isEmbed: true,
    streamUrl: fallbackEmbed,
    embedUrl: fallbackEmbed,
    type: params.typeStr
  });
});

// ============================================================================
// ৭. ফুল ডিপ-লেভেল HLS মাস্টার ও সেগমেন্ট প্রক্সি টানেল
// ============================================================================
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    let cleanUrl = targetUrl;
    while (cleanUrl.includes('%3A') || cleanUrl.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(cleanUrl);
        if (decoded === cleanUrl) break;
        cleanUrl = decoded;
      } catch (e) {
        break;
      }
    }

    const domain = new URL(cleanUrl).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.get('host');
    const proxyBase = `${protocol}://${host}/api/stream-proxy`;

    const requestHeaders = {
      'Referer': ref,
      'Origin': ref.replace(/\/$/, ''),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };

    if (req.headers['range']) {
      requestHeaders['Range'] = req.headers['range'];
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: requestHeaders,
      timeout: 25000
    });

    if (cleanUrl.includes('.m3u8') || (typeof response.data === 'string' && response.data.includes('#EXTM3U'))) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                let absUrl = p1;
                if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) {
                  absUrl = new URL(p1, baseUrl).href;
                }
                return `URI="${proxyBase}?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(ref)}"`;
              } catch {
                return match;
              }
            });
          }
          return line;
        }

        try {
          let segmentUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            segmentUrl = new URL(trimmed, baseUrl).href;
          }
          return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        } catch {
          return line;
        }
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    if (response.headers['content-range']) {
      res.set('Content-Range', response.headers['content-range']);
      res.status(206);
    }

    response.data.pipe(res);
  } catch (error) {
    res.status(502).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const refererHeader = req.headers['referer'] || req.headers['origin'] || '';
  const acceptHeader = req.headers['accept'] || '';
  
  const isDirectBrowserDoc = acceptHeader.includes('text/html') && (!refererHeader || (!refererHeader.includes('hmair') && !refererHeader.includes('xubilas') && !refererHeader.includes('localhost')));

  if (isDirectBrowserDoc) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send(ACCESS_DENIED_HTML);
  }

  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

// ============================================================================
// ৮. ডাইরেক্ট নেটিভ প্লে এন্ডপয়েন্ট (`/api/moviebox/play`)
// ============================================================================
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = memoryCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  try {
    const browser = await getClusterBrowser();
    const providers = getGlobalProviders(params);
    const result = await raceAllProviders(browser, providers);
    if (result) {
      memoryCache.set(cacheKey, { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() });
      return pipeMediaTunnel(req, res, result.streamUrl, result.usedUrl);
    }
  } catch (e) {}

  return res.status(404).send('Stream Offline');
});

app.get('/', (req, res) => res.send('🚀 Universal Ultra Scraper Core 5.0 Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Ultra Engine Active on ${PORT}`));
