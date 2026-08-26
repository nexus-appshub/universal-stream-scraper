const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.set('trust proxy', 1);
app.use(cors());

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
    <p>ভাই লিংক কপি করে লাভ নেই! দয়া করে অফিসিয়াল প্ল্যাটফর্মে স্ট্রিম করুন।</p>
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

const streamCache = new Map();

app.get('/', (req, res) => {
  res.send('Multi-Provider Stream Scraper API is running smoothly.');
});

// মাল্টি-প্রোভাইডার স্ক্র্যাপার ফাংশন
async function scrapeStreamUrl(targetUrl, refererUrl) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720'
      ]
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'referer': refererUrl
    });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let streamUrl = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (
        url.includes('.m3u8') ||  
        url.includes('master.m3u8') ||  
        url.includes('/hls/') ||  
        url.includes('playlist.m3u8')
      ) {
        streamUrl = url;
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 12000 });
    } catch (e) {}

    try {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          await frame.click('video, #play, .play-btn, .jw-display-icon-container, div[class*="play"]', { timeout: 1000 });
        } catch (fErr) {}
      }
      await page.mouse.click(640, 360);
    } catch (e) {}

    let waitTime = 0;
    while (!streamUrl && waitTime < 7000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();
    return streamUrl;
  } catch (error) {
    if (browser) await browser.close();
    return null;
  }
}

// ১. Resolver API with Fallback Providers
app.get('/api/resolve-stream', async (req, res) => {
  const { id, s = 1, e = 1, type = 'movie' } = req.query;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Media ID is required' });
  }

  const cacheKey = `${id}_${type}_${s}_${e}`;
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      type
    });
  }

  // প্রোভাইডার চেইন (Vidnest -> Autoembed -> VidLink)
  const providers = type === 'tv' ? [
    { url: `https://vidnest.fun/tv/${id}/${s}/${e}`, ref: 'https://vidnest.fun/' },
    { url: `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`, ref: 'https://autoembed.cc/' },
    { url: `https://vidlink.pro/tv/${id}/${s}/${e}`, ref: 'https://vidlink.pro/' }
  ] : [
    { url: `https://vidnest.fun/movie/${id}`, ref: 'https://vidnest.fun/' },
    { url: `https://player.autoembed.cc/embed/movie/${id}`, ref: 'https://autoembed.cc/' },
    { url: `https://vidlink.pro/movie/${id}`, ref: 'https://vidlink.pro/' }
  ];

  let foundUrl = null;
  let activeRef = '';

  for (const provider of providers) {
    foundUrl = await scrapeStreamUrl(provider.url, provider.ref);
    if (foundUrl) {
      activeRef = provider.ref;
      break;
    }
  }

  if (foundUrl) {
    streamCache.set(cacheKey, { url: foundUrl, ref: activeRef, time: Date.now() });
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(foundUrl)}&referer=${encodeURIComponent(activeRef)}`,
      rawUrl: foundUrl,
      type
    });
  } else {
    return res.status(404).json({ success: false, error: 'Direct stream link not captured from any provider.' });
  }
});

// ========================================================
// সেফ মিডিয়া টানেল প্রক্সি (M3U8 Segments Rewriter)
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

// MovieBox Play Route
app.get('/api/moviebox/play', async (req, res) => {
  const { id, s = 1, e = 1, type = 'movie' } = req.query;
  const cacheKey = `${id}_${type}_${s}_${e}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  return res.status(404).send('Stream Offline');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
