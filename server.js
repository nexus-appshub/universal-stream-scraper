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
    body {
      background: radial-gradient(circle at top right, #fff5f0, #ffffff 60%, #fff0e6);
      min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: #333333; padding: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95); border: 1px solid rgba(255, 107, 0, 0.15);
      box-shadow: 0 20px 50px rgba(255, 107, 0, 0.12); border-radius: 28px; padding: 45px 35px;
      max-width: 480px; width: 100%; text-align: center; position: relative; overflow: hidden;
    }
    .card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px;
      background: linear-gradient(90deg, #ff8800, #ff4500);
    }
    .header-logo { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; margin-bottom: 25px; }
    .logo-icon {
      width: 44px; height: 44px; background: linear-gradient(135deg, #ff8800, #ff4500);
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 15px rgba(255, 107, 0, 0.35);
    }
    .logo-icon svg { width: 22px; height: 22px; fill: #ffffff; margin-left: 3px; }
    .logo-text {
      font-size: 26px; font-weight: 800; letter-spacing: 0.5px;
      background: linear-gradient(90deg, #ff5500, #ff8800);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .badge {
      background: #ff5500; color: white; font-size: 11px; font-weight: 700;
      padding: 2px 7px; border-radius: 6px; vertical-align: middle; -webkit-text-fill-color: white;
    }
    .icon-box {
      width: 75px; height: 75px; background: #fff4ed; border: 2px dashed #ff8800;
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-box svg { width: 36px; height: 36px; stroke: #ff5500; }
    h2 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666666; font-size: 14px; line-height: 1.6; margin-bottom: 25px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      background: linear-gradient(135deg, #ff8800 0%, #ff5500 100%); color: #ffffff;
      text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px;
      border-radius: 14px; box-shadow: 0 8px 25px rgba(255, 85, 0, 0.35);
      transition: all 0.25s ease; width: 100%; margin-bottom: 12px;
    }
    .btn-tg {
      display: inline-block; background: #229ED9; color: white; text-decoration: none;
      font-weight: 700; font-size: 13px; padding: 10px 20px; border-radius: 10px; width: 100%;
    }
    .footer-note { margin-top: 25px; font-size: 12px; color: #999999; }
  </style>
</head>
<body>
  <div class="card">
    <a href="https://hmair.xyz" class="header-logo" title="Go to Home Air TV">
      <div class="logo-icon"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>
      <div class="logo-text">HOME AIR <span class="badge">TV</span></div>
    </a>
    <div class="icon-box">
      <svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h2>🚫Access Denied🤚</h2>
    <p>
      🤦‍♂️ভাই লিংক কপি করে লাভ নেই!<br>
      যদি লিংকের এতই প্রয়োজন হয় তবে ডেভেলপারকে সরাসরি কন্টাক্ট করেন, তাও এভাবে নেটওয়ার্ক ট্যাব ঘেঁটে লিংক খোঁজা বাদ দেন 😒 Please stream seamlessly through the official platform.
    </p>
    <a href="https://hmair.xyz" class="btn">
      <span>Watch on Official Website</span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
    </a>
    <a href="https://t.me/homeairtv" class="btn-tg" target="_blank" rel="noopener noreferrer">JOIN TG 😜</a>
    <div class="footer-note">Protected by Stream Proxy Shield • 2026</div>
  </div>
</body>
</html>`;

// ========================================================
// সিকিউরিটি: অনুমোদিত ডোমেইন তালিকা
// ========================================================
const ALLOWED_ORIGINS = [
  'https://homeairtv.xubilaswebdevcorp.shop',
  'https://anime.hmair.xyz',
  'https://hmair.xyz',
  'https://www.hmair.xyz',
  'https://2.0.hmair.xyz',
  'http://localhost:3000',
  'http://localhost:5173'
];

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
const CACHE_TTL = 24 * 60 * 60 * 1000;
const pendingScrapes = new Map();

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

// ========================================================
// ১. DUB রেজলভার (Anime & Shows)
// ========================================================
async function getAnimeExternalIds(title = '') {
  try {
    const cleanTitle = title.replace(/[^\w\s]/gi, '');
    if (cleanTitle) {
      const res = await axios.post('https://graphql.anilist.co', {
        query: `query ($search: String) { Media (search: $search, type: ANIME) { id idMal } }`,
        variables: { search: cleanTitle }
      }, { timeout: 3500 });
      const media = res.data?.data?.Media;
      if (media) return { malId: media.idMal, anilistId: media.id };
    }
  } catch (e) {}
  return { malId: null, anilistId: null };
}

async function resolveDubStream(params) {
  const { id, episode = 1, title, malId: paramMal, anilistId: paramAni, season = 1 } = params;
  let malId = paramMal;
  let anilistId = paramAni;

  if (!malId && !anilistId && title) {
    const ext = await getAnimeExternalIds(title);
    malId = ext.malId;
    anilistId = ext.anilistId;
  }

  if (malId) return `https://megaplay.buzz/stream/mal/${malId}/${episode}/dub`;
  if (anilistId) return `https://megaplay.buzz/stream/ani/${anilistId}/${episode}/dub`;

  try {
    const res = await axios.get(`https://anikotoapi.site/series/${id}`, { timeout: 3500 });
    const episodes = res.data?.episodes || res.data?.data?.episodes;
    if (episodes && episodes.length > 0) {
      const ep = episodes.find(e => Number(e.number) === Number(episode)) || episodes[episode - 1] || episodes[0];
      const embedId = ep?.episode_embed_id || ep?.id;
      if (embedId) return `https://megaplay.buzz/stream/s-2/${embedId}/dub`;
    }
  } catch (e) {}

  return `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}?dub=1`;
}

// ========================================================
// ২. মাল্টি-সার্ভার প্রোভাইডার তালিকা (১টির পর ১টি স্ক্র্যাপ করার জন্য)
// ========================================================
function getAllProviderUrls(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      { name: 'Vidnest', url: `https://vidnest.fun/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}` },
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${season}/${episode}` },
      { name: 'VidRock', url: `https://vidrock.net/embed/tv/${id}/${season}/${episode}` },
      { name: 'Videasy', url: `https://player.videasy.net/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}` },
      { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` }
    ];
  }
  return [
    { name: 'Vidnest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidSrc.sbs', url: `https://vidsrc.sbs/embed/movie/${id}` },
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/embed/movie/${id}` },
    { name: 'Videasy', url: `https://player.videasy.net/movie/${id}` },
    { name: 'VidSrc.xyz', url: `https://vidsrc.xyz/embed/movie?tmdb=${id}` },
    { name: 'AutoEmbed', url: `https://player.autoembed.cc/embed/movie/${id}` }
  ];
}

// ========================================================
// ৩. সিঙ্গেল প্রোভাইডার স্ক্র্যাপার ইঞ্জিন
// ========================================================
async function fastScrapeSingle(browser, targetUrl) {
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

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    return await new Promise((resolve) => {
      let resolved = false;

      page.on('response', async (response) => {
        const u = response.url();
        const isMedia = (u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'))) &&
                        !u.includes('demo') && !u.includes('trailer');

        if (isMedia && !resolved) {
          resolved = true;
          await page.close().catch(() => {});
          resolve(u);
        }
      });

      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 7000 })
        .then(async () => {
          const frames = [page.mainFrame(), ...page.frames()];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button, [class*="play"]'));
                if (btns.length > 0) btns[0].click();
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
      }, 4500);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

// ========================================================
// ৪. একের পর এক সব সার্ভার স্ক্র্যাপার (Sequential Multi-Server Scraper)
// ========================================================
async function resolveAnyStream(browser, providers) {
  for (const provider of providers) {
    try {
      const streamUrl = await fastScrapeSingle(browser, provider.url);
      if (streamUrl) {
        return { streamUrl, usedUrl: provider.url, providerName: provider.name };
      }
    } catch (e) {}
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
  const malId = query.mal_id || query.malId;
  const anilistId = query.anilist_id || query.anilistId;

  return { id: targetId, typeStr, isTv, season, episode, lang, title, malId, anilistId };
}

// ========================================================
// ৫. মেইন RESOLVE API
// ========================================================
app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  if (params.lang === 'dub') {
    const dubEmbed = await resolveDubStream(params);
    return res.json({
      success: true,
      isEmbed: true,
      streamUrl: dubEmbed,
      embedUrl: dubEmbed,
      lang: 'dub',
      type: params.typeStr,
      season: params.season,
      episode: params.episode
    });
  }

  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;

  // ১. মেমোরি ক্যাশ হিট চেক
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      provider: cached.provider,
      type: params.typeStr
    });
  }

  // ২. কনকারেন্সি লকার
  if (pendingScrapes.has(cacheKey)) {
    try {
      const result = await pendingScrapes.get(cacheKey);
      if (result) {
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          rawUrl: result.url,
          provider: result.provider,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  // ৩. সব সার্ভার একের পর এক ট্রাই করে স্ট্রিম বের করা
  const scrapeTask = (async () => {
    try {
      const browser = await getWarmBrowser();
      const providers = getAllProviderUrls(params);
      const result = await resolveAnyStream(browser, providers);
      if (result) {
        const data = { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() };
        streamCache.set(cacheKey, data);
        return data;
      }
      return null;
    } catch (err) {
      return null;
    } finally {
      pendingScrapes.delete(cacheKey);
    }
  })();

  pendingScrapes.set(cacheKey, scrapeTask);
  const finalResult = await scrapeTask;

  if (finalResult) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      rawUrl: finalResult.url,
      provider: finalResult.provider,
      type: params.typeStr
    });
  }

  // কোনো সার্ভারে স্ক্র্যাপ না হলে নির্ভরযোগ্য বিকল্প এম্বেড
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

// ========================================================
// ৬. সেফ মিডিয়া টানেল প্রক্সি (হটলিংক গার্ড ও সেগমেন্ট ডিকোড)
// ========================================================
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
  } catch (error) {
    res.status(502).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const refererHeader = req.headers['referer'] || req.headers['origin'] || '';
  const acceptHeader = req.headers['accept'] || '';
  
  const isDirectBrowserDoc = acceptHeader.includes('text/html') && (!refererHeader || (!refererHeader.includes('hmair') && !refererHeader.includes('xubilas') && !refererHeader.includes('localhost')));

  if (isDirectBrowserDoc) {
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
  if (params.lang === 'dub') {
    const dubEmbed = await resolveDubStream(params);
    return res.redirect(dubEmbed);
  }

  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  try {
    const browser = await getWarmBrowser();
    const providers = getAllProviderUrls(params);
    const result = await resolveAnyStream(browser, providers);
    if (result) {
      streamCache.set(cacheKey, { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() });
      return pipeMediaTunnel(req, res, result.streamUrl, result.usedUrl);
    }
  } catch (e) {}

  return res.status(404).send('Stream Offline');
});

app.get('/', (req, res) => res.send('🚀 High-Load Multi-Server Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
