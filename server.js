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

function getWebProviderUrls(id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  return [
    isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
    isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`,
    isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`
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
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.evaluate(() => {
        const btn = document.querySelector('video, button, #play, .play-btn');
        if (btn) btn.click();
      });
    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 5000);
  });
}

// ==========================================
// ১. JSON রেজলভার API (যাতে ব্রাউজার সরাসরি Raw URL পায়)
// ==========================================
app.get('/api/resolve-stream', async (req, res) => {
  const { id = '27205', type = 'movie', s = 1, e = 1 } = req.query;
  const cacheKey = `${id}_${type}_${s}_${e}`;
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
      const urls = getWebProviderUrls(id, s, e, type);

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
    return res.status(404).json({ success: false, message: 'Stream Offline' });
  }

  const directProxiedUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`;
  return res.json({
    success: true,
    streamUrl: directProxiedUrl,
    rawUrl: streamUrl,
    referer: usedUrl
  });
});

// মেইন প্লে এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const { id = '27205', type = 'movie', s = 1, e = 1 } = req.query;
  const cacheKey = `${id}_${type}_${s}_${e}`;

  let streamUrl = null;
  let usedUrl = '';

  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    streamUrl = cached.url;
    usedUrl = cached.ref;
  } else {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(id, s, e, type);

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

app.get('/', (req, res) => res.send('🚀 Scraper Native Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
