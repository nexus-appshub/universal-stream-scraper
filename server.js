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

// পূর্ণাঙ্গ উন্মুক্ত CORS কনফিগারেশন
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==========================================
// 1. মেমোরি ক্যাশিং ও ব্রাউজার পুল
// ==========================================
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

// ==========================================
// 2. মাল্টি-সোর্স প্রোভাইডার ইউআরএল জেনারেটর (VidSrc + Anikoto)
// ==========================================
function getWebProviderUrls(params) {
  const { id, isTv, isAnime, season, episode, lang, anilistId, malId } = params;

  // অ্যানিমে স্ক্র্যাপিং (Anikoto MegaPlay Engine)
  if (isAnime) {
    const urls = [];
    if (malId) urls.push(`https://megaplay.buzz/stream/mal/${malId}/${episode}/${lang}`); //
    if (anilistId) urls.push(`https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${lang}`); //
    urls.push(`https://megaplay.buzz/stream/s-2/${id}/${lang}`); //
    return urls;
  }

  // টিভি সিরিজ স্ক্র্যাপিং (VidSrc.sbs, AutoEmbed, Vidnest, Vidrock)
  if (isTv) {
    return [
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`,
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://vidrock.net/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`
    ];
  }

  // মুভি স্ক্র্যাপিং
  return [
    `https://vidsrc.sbs/embed/movie/${id}`,
    `https://player.autoembed.cc/embed/movie/${id}`,
    `https://vidnest.fun/movie/${id}`,
    `https://vidrock.net/embed/movie/${id}`,
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`
  ];
}

// ==========================================
// 3. ফাস্ট স্ক্র্যাপার ইঞ্জিন
// ==========================================
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
      
      // অটোপ্লে এবং প্লে বাটন ক্লিক
      await page.evaluate(() => {
        const btn = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container');
        if (btn) btn.click();
      });
    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 5500);
  });
}

// কুয়েরি প্যারামিটার নরমালাইজার
function parseParams(query) {
  const targetId = query.id || query.subjectId || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const isAnime = typeStr === 'anime';
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'show';
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || query.dub === 'true' ? 'dub' : 'sub').toLowerCase();
  const malId = query.mal_id || query.malId;
  const anilistId = query.anilist_id || query.anilistId;

  return { id: targetId, typeStr, isAnime, isTv, season, episode, lang, malId, anilistId };
}

// ==========================================
// 4. JSON রেজলভার API (Movie, TV Series, Anime DUB/SUB)
// ==========================================
app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
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
      const urls = getWebProviderUrls(params);

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
    return res.status(404).json({ success: false, message: 'Stream not found on Scraper providers' });
  }

  const directProxiedUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`;
  return res.json({
    success: true,
    streamUrl: directProxiedUrl,
    rawUrl: streamUrl,
    referer: usedUrl,
    type: params.typeStr,
    season: params.season,
    episode: params.episode,
    lang: params.lang
  });
});

// মেইন প্লে এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;

  let streamUrl = null;
  let usedUrl = '';

  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    streamUrl = cached.url;
    usedUrl = cached.ref;
  } else {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(params);

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

// ==========================================
// 5. সেগমেন্ট রিরাইট প্রক্সি টানেল
// ==========================================
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

app.get('/', (req, res) => res.send('🚀 Universal Anime/TV/Movie Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
