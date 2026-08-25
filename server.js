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

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const streamCache = new Map();
const activeResolutions = new Map();
let globalBrowser = null;

async function getBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ultra-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  return globalBrowser;
}
getBrowser().catch(() => {});

// ============================================================================
// ১. টপ ৩টি হাই-স্পিড প্রোভাইডার (যেগুলো সরাসরি .m3u8 ডেলিভার করে)
// ============================================================================
function getFastEndpoints(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      { name: 'Vidnest', url: `https://vidnest.fun/tv/${id}/${season}/${episode}` },
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${season}/${episode}` },
      { name: 'VidRock', url: `https://vidrock.net/embed/tv/${id}/${season}/${episode}` },
      { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` }
    ];
  }
  return [
    { name: 'Vidnest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/embed/movie/${id}` },
    { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/movie/${id}` }
  ];
}

// ============================================================================
// ২. আল্ট্রা-ফাস্ট মিডিয়া নেটওয়ার্ক স্নিফার (No Interception Block)
// ============================================================================
async function sniffProvider(browser, provider) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    return await new Promise((resolve) => {
      let resolved = false;

      const captureMedia = async (url) => {
        const lower = url.toLowerCase();
        const isMedia = (lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('master.m3u8') || (lower.includes('.mp4') && !lower.includes('google'))) &&
                        !lower.includes('demo') && !lower.includes('trailer') && !lower.includes('preview');
        if (isMedia && !resolved) {
          resolved = true;
          if (page) await page.close().catch(() => {});
          resolve({ streamUrl: url, referer: provider.url, provider: provider.name });
        }
      };

      page.on('response', (res) => {
        captureMedia(res.url());
      });

      page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 7000 })
        .then(async () => {
          for (let step = 0; step < 2; step++) {
            if (resolved) break;
            const frames = [page.mainFrame(), ...page.frames()];
            for (const frame of frames) {
              try {
                await frame.evaluate(() => {
                  const elements = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button, [class*="play"]'));
                  elements.forEach((el) => { try { el.click(); } catch (e) {} });
                });
              } catch (e) {}
            }
            await new Promise((r) => setTimeout(r, 800));
          }
        })
        .catch(() => {});

      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          if (page) await page.close().catch(() => {});
          resolve(null);
        }
      }, 5500);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

// প্যারালাল ফাস্ট-রেস (যে প্রোভাইডার সবার আগে লিংক দেবে সেটিই তাৎক্ষণিক রিটার্ন হবে)
async function raceFastProviders(browser, providers) {
  const batch1 = providers.slice(0, 2);
  const results1 = await Promise.all(batch1.map((p) => sniffProvider(browser, p)));
  const winner1 = results1.find((r) => r !== null);
  if (winner1) return winner1;

  const batch2 = providers.slice(2, 4);
  const results2 = await Promise.all(batch2.map((p) => sniffProvider(browser, p)));
  return results2.find((r) => r !== null) || null;
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
// ৩. মেইন রেজলভার API (০.০১ সেকেন্ড ক্যাশ + ৪ সেকেন্ড ফাস্ট স্ক্র্যাপ)
// ============================================================================
app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;

  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      provider: cached.provider,
      type: params.typeStr,
    });
  }

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
          type: params.typeStr,
        });
      }
    } catch (e) {}
  }

  const scrapeTask = (async () => {
    try {
      const browser = await getBrowser();
      const endpoints = getFastEndpoints(params);
      const result = await raceFastProviders(browser, endpoints);
      if (result) {
        const data = { url: result.streamUrl, ref: result.referer, provider: result.provider, time: Date.now() };
        streamCache.set(cacheKey, data);
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
      type: params.typeStr,
    });
  }

  return res.status(404).json({
    success: false,
    error: 'Stream not found on native scraper networks',
  });
});

// ============================================================================
// ৪. ডাইরেক্ট নেটিভ প্লে এন্ডপয়েন্ট (`/api/moviebox/play`)
// ============================================================================
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  try {
    const browser = await getBrowser();
    const endpoints = getFastEndpoints(params);
    const result = await raceFastProviders(browser, endpoints);
    if (result) {
      streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, provider: result.provider, time: Date.now() });
      return pipeMediaTunnel(req, res, result.streamUrl, result.referer);
    }
  } catch (e) {}

  return res.status(404).send('Stream Offline');
});

// ============================================================================
// ৫. ডাইনামিক HLS সেগমেন্ট ও মাস্টার রিরাইট প্রক্সি
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (req.headers['range']) {
      requestHeaders['Range'] = req.headers['range'];
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: requestHeaders,
      timeout: 25000,
    });

    if (cleanUrl.includes('.m3u8') || (typeof response.data === 'string' && response.data.includes('#EXTM3U'))) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines
        .map((line) => {
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
        })
        .join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
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
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/', (req, res) => res.send('🚀 Universal Stream Scraper Engine Active!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
