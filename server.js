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

async function getBrowserInstance() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-runner-'));
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
      '--disable-extensions'
    ]
  });
  return globalBrowser;
}
getBrowserInstance().catch(() => {});

function getScrapeEndpoints(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidlink.pro/tv/${id}/${season}/${episode}`,
      `https://player.videasy.net/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
      `https://vidrock.net/embed/tv/${id}/${season}/${episode}`
    ];
  }
  return [
    `https://vidnest.fun/movie/${id}`,
    `https://vidsrc.sbs/embed/movie/${id}`,
    `https://vidlink.pro/movie/${id}`,
    `https://player.videasy.net/movie/${id}`,
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    `https://vidrock.net/embed/movie/${id}`
  ];
}

async function scrapeProvider(browser, targetUrl) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    return await new Promise((resolve) => {
      let resolved = false;

      page.on('response', async (response) => {
        try {
          const u = response.url();
          const lower = u.toLowerCase();
          const isMedia = (lower.includes('.m3u8') || lower.includes('/hls/') || (lower.includes('.mp4') && !lower.includes('google'))) &&
                          !lower.includes('demo') && !lower.includes('trailer') && !lower.includes('preview');

          if (isMedia && !resolved) {
            resolved = true;
            await page.close().catch(() => {});
            resolve({ streamUrl: u, usedUrl: targetUrl });
          }
        } catch (e) {}
      });

      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
        .then(async () => {
          for (let i = 0; i < 3; i++) {
            if (resolved) break;
            const frames = [page.mainFrame(), ...page.frames()];
            for (const frame of frames) {
              try {
                await frame.evaluate(() => {
                  const elements = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button, [class*="play"]'));
                  elements.forEach(el => el.click());
                });
              } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        })
        .catch(() => {});

      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          await page.close().catch(() => {});
          resolve(null);
        }
      }, 7500);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

async function executeScrapePipeline(browser, urls) {
  for (const url of urls) {
    const result = await scrapeProvider(browser, url);
    if (result && result.streamUrl) return result;
  }
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

// ১. মেইন JSON রেজলভার API
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
          type: params.typeStr,
        });
      }
    } catch (e) {}
  }

  const scrapeTask = (async () => {
    try {
      const browser = await getBrowserInstance();
      const urls = getScrapeEndpoints(params);
      const result = await executeScrapePipeline(browser, urls);
      if (result) {
        const data = { url: result.streamUrl, ref: result.usedUrl, time: Date.now() };
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
      type: params.typeStr,
    });
  }

  return res.status(404).json({
    success: false,
    error: 'Stream not found on native scraper networks',
  });
});

// ২. ডাইরেক্ট নেটিভ প্লে এন্ডপয়েন্ট (`/api/moviebox/play`)
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  try {
    const browser = await getBrowserInstance();
    const urls = getScrapeEndpoints(params);
    const result = await executeScrapePipeline(browser, urls);
    if (result) {
      streamCache.set(cacheKey, { url: result.streamUrl, ref: result.usedUrl, time: Date.now() });
      return pipeMediaTunnel(req, res, result.streamUrl, result.usedUrl);
    }
  } catch (e) {}

  return res.status(404).send('Stream Offline');
});

// ৩. সেফ মিডিয়া টানেল প্রক্সি (হটলিংক গার্ড ও সেগমেন্ট ডিকোড)
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

app.get('/', (req, res) => res.send('🚀 Universal Stream Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on ${PORT}`));
