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

// ফুল উন্মুক্ত CORS
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
const CACHE_TTL = 3 * 60 * 60 * 1000;
let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
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
      '--single-process',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts'
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

// মুভি ও টিভি সিরিজের জন্য মাল্টি-প্রোভাইডার পুলে সঠিক ম্যাপিং
function getWebProviderUrls(id, s = 1, e = 1, isTv = false) {
  if (isTv) {
    return [
      `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
      `https://vidnest.fun/tv/${id}/${s}/${e}`,
      `https://vidrock.net/embed/tv/${id}/${s}/${e}`,
      `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`
    ];
  }
  return [
    `https://player.autoembed.cc/embed/movie/${id}`,
    `https://vidnest.fun/movie/${id}`,
    `https://vidrock.net/embed/movie/${id}`,
    `https://vidsrc.to/embed/movie/${id}`
  ];
}

async function fastScrape(browser, targetUrl) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    if (['image', 'stylesheet', 'font'].includes(type) || url.includes('analytics') || url.includes('doubleclick')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  return new Promise(async (resolve) => {
    let resolved = false;

    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      if (isMedia && !resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 9000 });
      
      // টিভি সিরিজের অটো-প্লে ও ফ্রেম ক্লিক ট্রিগার
      await page.evaluate(() => {
        const btn = document.querySelector('video, button, #play, .play-btn, .server-item');
        if (btn) btn.click();
      });
    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 6000);
  });
}

// প্যারামিটার নরমালাইজার
function normalizeParams(query) {
  const targetId = query.id || query.subjectId || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'show';
  const season = query.s || query.season || query.se || 1;
  const episode = query.e || query.episode || query.ep || 1;

  return { targetId, isTv, season, episode, typeStr };
}

// ==========================================
// ১. JSON রেজলভার API (TV + Movie Supported)
// ==========================================
app.get('/api/resolve-stream', async (req, res) => {
  const { targetId, isTv, season, episode, typeStr } = normalizeParams(req.query);
  const cacheKey = `${targetId}_${typeStr}_${season}_${episode}`;
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  let streamUrl = null;
  let usedUrl = '';

  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    streamUrl = cached.url;
    usedUrl = cached.ref;
  } else {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(targetId, season, episode, isTv);

      for (const url of urls) {
        streamUrl = await fastScrape(browser, url);
        if (streamUrl) {
          usedUrl = url;
          break;
        }
      }

      if (streamUrl) {
        streamCache.set(cacheKey, { url: streamUrl, ref: usedUrl, time: Date.now() });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!streamUrl) {
    return res.status(404).json({ success: false, message: 'TV Episode / Movie Stream Offline' });
  }

  const directProxiedUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`;
  return res.json({
    success: true,
    streamUrl: directProxiedUrl,
    rawUrl: streamUrl,
    referer: usedUrl,
    isTv,
    season,
    episode
  });
});

// মেইন প্লে এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const { targetId, isTv, season, episode, typeStr } = normalizeParams(req.query);
  const cacheKey = `${targetId}_${typeStr}_${season}_${episode}`;

  let streamUrl = null;
  let usedUrl = '';

  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    streamUrl = cached.url;
    usedUrl = cached.ref;
  } else {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(targetId, season, episode, isTv);

      for (const url of urls) {
        streamUrl = await fastScrape(browser, url);
        if (streamUrl) {
          usedUrl = url;
          break;
        }
      }

      if (streamUrl) {
        streamCache.set(cacheKey, { url: streamUrl, ref: usedUrl, time: Date.now() });
      }
    } catch (err) {
      return res.status(500).send('Scraper Error');
    }
  }

  if (!streamUrl) return res.status(404).send('Stream Offline');
  return pipeMediaTunnel(req, res, streamUrl, usedUrl);
});

// টানেল হ্যান্ডলার
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    const domain = new URL(targetUrl).origin;
    const ref = referer || domain;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.get('host');
    const proxyBase = `${protocol}://${host}/api/stream-proxy`;

    const response = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: targetUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 20000
    });

    if (targetUrl.includes('.m3u8')) {
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          let segmentUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            segmentUrl = new URL(trimmed, baseUrl).href;
          }
          return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        }
        return line;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (error) {
    res.status(500).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/', (req, res) => res.send('🚀 Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
