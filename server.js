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

// ========================================================
// কাস্টম ACCESS DENIED HTML টেমপ্লেট
// ========================================================
const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied - HOME AIR TV</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Poppins', sans-serif; }
    body { background: radial-gradient(circle at top right, #fff5f0, #ffffff 60%, #fff0e6); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #333333; padding: 20px; }
    .card { background: rgba(255, 255, 255, 0.95); border: 1px solid rgba(255, 107, 0, 0.15); box-shadow: 0 20px 50px rgba(255, 107, 0, 0.12); border-radius: 28px; padding: 45px 35px; max-width: 480px; width: 100%; text-align: center; position: relative; overflow: hidden; }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, #ff8800, #ff4500); }
    .header-logo { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; margin-bottom: 25px; }
    .logo-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #ff8800, #ff4500); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    .logo-icon svg { width: 22px; height: 22px; fill: #ffffff; }
    .logo-text { font-size: 26px; font-weight: 800; background: linear-gradient(90deg, #ff5500, #ff8800); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { background: #ff5500; color: white; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; }
    .icon-box { width: 75px; height: 75px; background: #fff4ed; border: 2px dashed #ff8800; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .icon-box svg { width: 36px; height: 36px; stroke: #ff5500; }
    h2 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666666; font-size: 14px; line-height: 1.6; margin-bottom: 25px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #ff8800 0%, #ff5500 100%); color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 14px; width: 100%; margin-bottom: 12px; }
    .btn-tg { display: inline-block; background: #229ED9; color: white; text-decoration: none; font-weight: 700; font-size: 13px; padding: 10px 20px; border-radius: 10px; width: 100%; }
    .footer-note { margin-top: 25px; font-size: 12px; color: #999999; }
  </style>
</head>
<body>
  <div class="card">
    <a href="https://hmair.xyz" class="header-logo">
      <div class="logo-icon"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>
      <div class="logo-text">HOME AIR <span class="badge">TV</span></div>
    </a>
    <div class="icon-box">
      <svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h2>🚫 Access Denied ✋</h2>
    <p>ভাই লিংক কপি করে লাভ নেই! দয়া করে অফিসিয়াল প্ল্যাটফর্মে স্ট্রিম করুন।</p>
    <a href="https://hmair.xyz" class="btn">Watch on Official Website</a>
    <a href="https://t.me/homeairtv" class="btn-tg" target="_blank" rel="noopener noreferrer">JOIN TG</a>
    <div class="footer-note">Protected by Stream Proxy Shield • 2026</div>
  </div>
</body>
</html>`;

const ALLOWED_ORIGINS = [
  'https://homeairtv.xubilaswebdevcorp.shop',
  'https://anime.hmair.xyz',
  'https://hmair.xyz',
  'https://www.hmair.xyz',
  'https://2.0.hmair.xyz',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || origin.includes('xubilas') || origin.includes('hmair')) {
      return callback(null, true);
    }
    return callback(new Error('Access Denied: Hotlinking Prohibited'));
  },
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: '*'
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const streamCache = new Map();
const pendingScrapes = new Map();
let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

// সুপার-ফাস্ট ডাইরেক্ট API + Puppeteer হাইব্রিড এক্সট্রাক্টর
async function fetchBestStream(id, isTv, season = 1, episode = 1) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  // প্রথমে সরাসরি API গেটওয়ে চেক করবে (সবচেয়ে দ্রুত)
  try {
    const apiUrl = isTv
      ? `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`
      : `https://player.autoembed.cc/embed/movie/${id}`;
    
    const res = await axios.get(apiUrl, { headers: { ...headers, Referer: 'https://autoembed.cc/' }, timeout: 4000 });
    const match = res.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (match && match[0]) {
      return { streamUrl: match[0], referer: apiUrl };
    }
  } catch (e) {}

  // যদি API থেকে না আসে, তবে ব্রাউজার স্নিফার দিয়ে রিয়েল-টাইম ধরবে
  try {
    const browser = await getWarmBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);

    const targetUrl = isTv 
      ? `https://vidnest.fun/tv/${id}/${season}/${episode}` 
      : `https://vidnest.fun/movie/${id}`;

    return await new Promise((resolve) => {
      let resolved = false;

      page.on('request', (req) => {
        const u = req.url();
        const lower = u.toLowerCase();
        if ((lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('streamraiwind')) && !resolved) {
          resolved = true;
          page.close().catch(() => {});
          resolve({ streamUrl: u, referer: targetUrl });
        }
        if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      page.on('response', (res) => {
        const u = res.url();
        const lower = u.toLowerCase();
        if ((lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('streamraiwind')) && !resolved) {
          resolved = true;
          page.close().catch(() => {});
          resolve({ streamUrl: u, referer: targetUrl });
        }
      });

      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          page.close().catch(() => {});
          resolve(null);
        }
      }, 5000);
    });
  } catch (err) {
    return null;
  }
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const title = query.title || '';
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'anime';
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  return { id: targetId, typeStr, isTv, season, episode, lang, title };
}

// ========================================================
// মেইন API রেজলভার (Direct M3U8 JSON)
// ========================================================
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
    try {
      const result = await pendingScrapes.get(cacheKey);
      if (result) {
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
          rawUrl: result.streamUrl,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  const scrapeTask = fetchBestStream(params.id, params.isTv, params.season, params.episode);
  pendingScrapes.set(cacheKey, scrapeTask);
  const result = await scrapeTask;
  pendingScrapes.delete(cacheKey);

  if (result && result.streamUrl) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
      rawUrl: result.streamUrl,
      type: params.typeStr
    });
  }

  // একদম না পেলে Vidnest সরাসরি এমবেড ফলব্যাক
  const fallbackUrl = params.isTv
    ? `https://vidnest.fun/tv/${params.id}/${params.season}/${params.episode}`
    : `https://vidnest.fun/movie/${params.id}`;

  return res.json({
    success: true,
    isEmbed: true,
    streamUrl: fallbackUrl,
    embedUrl: fallbackUrl,
    type: params.typeStr
  });
});

// ========================================================
// মিডিয়া টানেল প্রক্সি (Segment & Master Rewriter)
// ========================================================
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    let cleanUrl = targetUrl;
    while (cleanUrl.includes('%3A') || cleanUrl.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(cleanUrl);
        if (decoded === cleanUrl) break;
        cleanUrl = decoded;
      } catch (e) { break; }
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
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 20000
    });

    if (cleanUrl.includes('.m3u8')) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
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
    res.status(502).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const refererHeader = req.headers['referer'] || req.headers['origin'] || '';
  const acceptHeader = req.headers['accept'] || '';

  const isAuthorized = 
    ALLOWED_ORIGINS.some(allowed => refererHeader.startsWith(allowed)) ||
    refererHeader.includes('xubilas') ||
    refererHeader.includes('hmair');

  if (!isAuthorized && (acceptHeader.includes('text/html') || !refererHeader)) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send(ACCESS_DENIED_HTML);
  }

  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

// MovieBox Native Play Endpoint
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  const result = await fetchBestStream(params.id, params.isTv, params.season, params.episode);
  if (result && result.streamUrl) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return pipeMediaTunnel(req, res, result.streamUrl, result.referer);
  }

  return res.status(404).send('Stream Offline');
});

app.get('/', (req, res) => res.send('🚀 Hybrid Stream Scraper & Proxy Active!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
