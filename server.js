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
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ২৪ ঘণ্টা মেমোরি ক্যাশ এবং Concurrency Pool
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const pendingScrapes = new Map();

let globalBrowser = null;
let activePagesCount = 0;
const MAX_CONCURRENT_PAGES = 6;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-prof-'));
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
      '--disable-remote-fonts',
      '--disable-background-networking',
      '--mute-audio'
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

// প্রোভাইডার লিস্ট
function getWebProviderUrls(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
      `https://vidlink.pro/tv/${id}/${season}/${episode}`
    ];
  }
  return [
    `https://vidsrc.sbs/embed/movie/${id}`,
    `https://vidnest.fun/movie/${id}`,
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    `https://vidlink.pro/movie/${id}`
  ];
}

// প্যারালাল ফাস্ট স্ক্র্যাপার ফাংশন
async function scrapeSingleUrl(browser, targetUrl) {
  if (activePagesCount >= MAX_CONCURRENT_PAGES) {
    await new Promise(r => setTimeout(r, 600));
  }

  activePagesCount++;
  let page = null;

  return new Promise(async (resolve) => {
    let isDone = false;

    const cleanup = async (result = null) => {
      if (!isDone) {
        isDone = true;
        activePagesCount = Math.max(0, activePagesCount - 1);
        if (page) {
          try {
            page.removeAllListeners();
            await page.close();
          } catch (e) {}
        }
        resolve(result);
      }
    };

    // ৫ সেকেন্ড হার্ড টাইমআউট
    const timer = setTimeout(() => cleanup(null), 5500);

    try {
      page = await browser.newPage();
      await page.setRequestInterception(true);

      page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();
        if (['image', 'stylesheet', 'font', 'media'].includes(type) || url.includes('analytics') || url.includes('doubleclick') || url.includes('adservice')) {
          req.abort();
        } else {
          req.continue();
        }
      });

      page.on('response', (response) => {
        const u = response.url();
        const isMedia = (u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'))) &&
                        !u.includes('demo') && !u.includes('trailer');
        if (isMedia) {
          clearTimeout(timer);
          cleanup(u);
        }
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 4500 }).catch(() => {});

      // ক্লিক ট্রিগার
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, video, .play-btn, #play, [class*="play"]');
        if (btns.length > 0) btns[0].click();
      }).catch(() => {});

    } catch (err) {
      clearTimeout(timer);
      cleanup(null);
    }
  });
}

// প্যারালাল রেস রেজলভার
async function parallelScrape(browser, urls) {
  try {
    const promises = urls.map(url => scrapeSingleUrl(browser, url).then(res => res ? { url: res, ref: url } : null));
    const results = await Promise.all(promises);
    return results.find(r => r !== null) || null;
  } catch (e) {
    return null;
  }
}

// প্যারামিটার পার্সিং
function parseParams(query) {
  const targetId = query.id || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'anime';
  const season = parseInt(query.s || query.season || 1);
  const episode = parseInt(query.e || query.episode || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  const server = query.server || 'AwsPly';

  return { id: targetId, typeStr, isTv, season, episode, lang, server };
}

// ১. মেইন রেজলভার এন্ডপয়েন্ট
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
      type: params.typeStr
    });
  }

  if (pendingScrapes.has(cacheKey)) {
    const result = await pendingScrapes.get(cacheKey);
    if (result) {
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
        rawUrl: result.url,
        type: params.typeStr
      });
    }
  }

  const task = (async () => {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(params);
      const matched = await parallelScrape(browser, urls);
      if (matched) {
        streamCache.set(cacheKey, { url: matched.url, ref: matched.ref, time: Date.now() });
        return matched;
      }
      return null;
    } finally {
      pendingScrapes.delete(cacheKey);
    }
  })();

  pendingScrapes.set(cacheKey, task);
  const finalResult = await task;

  if (finalResult) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      rawUrl: finalResult.url,
      type: params.typeStr
    });
  }

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

// ২. অপ্টিমাইজড মিডিয়া টানেল প্রক্সি
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');

  try {
    const cleanUrl = decodeURIComponent(url);
    const domain = new URL(cleanUrl).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const proxyBase = `${req.protocol}://${req.get('host')}/api/stream-proxy`;

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'Referer': ref,
        'Origin': domain,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    if (cleanUrl.includes('.m3u8')) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const absoluteUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
          return `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(ref)}`;
        }
        return line;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (err) {
    res.status(502).send('Proxy Stream Failed');
  }
});

app.get('/', (req, res) => res.send('🚀 Universal Turbo Stream Scraper is Live!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
