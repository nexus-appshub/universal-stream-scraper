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

function getGlobalProviders(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      { name: 'Vidnest', url: `https://vidnest.fun/tv/${id}/${season}/${episode}` },
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${season}/${episode}` },
      { name: 'VidRock', url: `https://vidrock.net/embed/tv/${id}/${season}/${episode}` },
      { name: 'Videasy', url: `https://player.videasy.net/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}` }
    ];
  }
  return [
    { name: 'Vidnest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/embed/movie/${id}` },
    { name: 'Videasy', url: `https://player.videasy.net/movie/${id}` },
    { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/movie/${id}` },
    { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/movie?tmdb=${id}` }
  ];
}

async function executeTargetScrape(browser, provider) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (['image', 'font'].includes(type) || url.includes('analytics') || url.includes('doubleclick')) {
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

      page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 9000 })
        .then(async () => {
          const frames = [page.mainFrame(), ...page.frames()];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button'));
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
      }, 6000);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

async function raceAllProviders(browser, providers) {
  const batch1 = providers.slice(0, 3);
  const results1 = await Promise.all(batch1.map((p) => executeTargetScrape(browser, p)));
  const winner1 = results1.find((r) => r !== null);
  if (winner1) return winner1;

  const batch2 = providers.slice(3);
  const results2 = await Promise.all(batch2.map((p) => executeTargetScrape(browser, p)));
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

// ১০০% পিওর নেটিভ স্ক্র্যাপ API (জিরো এম্বেড)
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

  const scrapeTask = (async () => {
    try {
      const browser = await getClusterBrowser();
      const providers = getGlobalProviders(params);
      const result = await raceAllProviders(browser, providers);
      if (result) {
        const data = { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() };
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

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        Referer: ref,
        Origin: ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 25000,
    });

    if (cleanUrl.includes('.m3u8')) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');
      const rewritten = lines
        .map((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            let segmentUrl = trimmed;
            if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
              segmentUrl = new URL(trimmed, baseUrl).href;
            }
            return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
          }
          return line;
        })
        .join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    });
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Pure Native Scraper Online on ${PORT}`));
