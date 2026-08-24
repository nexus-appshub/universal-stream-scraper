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

// সম্পূর্ণ ওপেন CORS কনফিগারেশন (যাতে যেকোনো ওয়েবসাইট ও অ্যাপ থেকে চলে)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: '*'
}));
app.use(express.json());

// ==========================================
// 1. INSTANT STREAM CACHE
// ==========================================
const streamCache = new Map();
const CACHE_TTL = 3 * 60 * 60 * 1000;

// ==========================================
// 2. WARM BROWSER POOL
// ==========================================
let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }
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
    if (
      ['image', 'stylesheet', 'font'].includes(type) ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
      url.includes('adservice')
    ) {
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
      if (isMedia && !u.includes('analytics') && !u.includes('doubleclick') && !u.includes('demo') && !resolved) {
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
// 3. MAIN DIRECT STREAM PIPELINE (DIRECT RAW MEDIA)
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
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
      const webUrls = getWebProviderUrls(id, s, e, type);

      for (const url of webUrls) {
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
      return res.status(500).json({ error: 'Scraper Error', message: err.message });
    }
  }

  if (!streamUrl) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // সরাসরি প্রক্সি লিংকে রিডাইরেক্ট (পিওর HLS/MP4 স্ট্রিম হিসেবে)
  const proxyStreamUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`;
  return res.redirect(proxyStreamUrl);
});

// ==========================================
// 4. TS SEGMENT RE-WRITING STREAM PROXY WITH FULL CORS
// ==========================================
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;

    const response = await axios({
      method: 'GET',
      url: target,
      responseType: target.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 25000
    });

    // M3U8 প্লেলিস্টের ভেতর থাকা সমস্ত সেগমেন্ট লিংক রি-রাইট করা
    if (target.includes('.m3u8')) {
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const segmentUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          return `${req.protocol}://${req.get('host')}/api/stream-proxy?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        }
        return line;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy Segment Error');
  }
});

app.get('/', (req, res) => res.send('🚀 Video Core Active!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
