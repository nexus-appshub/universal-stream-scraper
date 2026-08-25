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
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Poppins', sans-serif;
    }
    body {
      background: radial-gradient(circle at top right, #fff5f0, #ffffff 60%, #fff0e6);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #333333;
      padding: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid rgba(255, 107, 0, 0.15);
      box-shadow: 0 20px 50px rgba(255, 107, 0, 0.12);
      border-radius: 28px;
      padding: 45px 35px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(90deg, #ff8800, #ff4500);
    }
    .header-logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      margin-bottom: 25px;
      transition: transform 0.2s ease;
    }
    .header-logo:hover {
      transform: scale(1.04);
    }
    .logo-icon {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #ff8800, #ff4500);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 15px rgba(255, 107, 0, 0.35);
    }
    .logo-icon svg {
      width: 22px;
      height: 22px;
      fill: #ffffff;
      margin-left: 3px;
    }
    .logo-text {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.5px;
      background: linear-gradient(90deg, #ff5500, #ff8800);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .badge {
      background: #ff5500;
      color: white;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 6px;
      vertical-align: middle;
      -webkit-text-fill-color: white;
    }
    .icon-box {
      width: 75px;
      height: 75px;
      background: #fff4ed;
      border: 2px dashed #ff8800;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-box svg {
      width: 36px;
      height: 36px;
      stroke: #ff5500;
    }
    h2 {
      font-size: 22px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 10px;
    }
    p {
      color: #666666;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 25px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: linear-gradient(135deg, #ff8800 0%, #ff5500 100%);
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      padding: 14px 32px;
      border-radius: 14px;
      box-shadow: 0 8px 25px rgba(255, 85, 0, 0.35);
      transition: all 0.25s ease;
      width: 100%;
      margin-bottom: 12px;
    }
    .btn:hover {
      box-shadow: 0 12px 30px rgba(255, 85, 0, 0.45);
      transform: translateY(-2px);
      filter: brightness(1.05);
    }
    .btn-tg {
      display: inline-block;
      background: #229ED9;
      color: white;
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      padding: 10px 20px;
      border-radius: 10px;
      transition: background 0.2s;
      width: 100%;
    }
    .btn-tg:hover {
      background: #1c88bd;
    }
    .footer-note {
      margin-top: 25px;
      font-size: 12px;
      color: #999999;
    }
  </style>
</head>
<body>
  <div class="card">
    <a href="https://hmair.xyz" class="header-logo" title="Go to Home Air TV">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </div>
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
// সিকিউরিটি: অনুমোদিত ডোমেইন তালিকা (Anti-Hotlink Guard)
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

// ১০০K ট্রাফিকের জন্য ২৪ ঘণ্টা মেমোরি ক্যাশ
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// কনকারেন্সি লকার
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
// ১. DUB এর জন্য MAL / ANILIST / MEGAPLAY রেজলভার
// ========================================================
async function getAnimeExternalIds(title = '') {
  try {
    const query = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          id
          idMal
        }
      }
    `;
    const cleanTitle = title.replace(/[^\w\s]/gi, '');
    if (cleanTitle) {
      const res = await axios.post('https://graphql.anilist.co', {
        query,
        variables: { search: cleanTitle }
      }, { timeout: 4000 });

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
    const res = await axios.get(`https://anikotoapi.site/series/${id}`, { timeout: 4000 });
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
// ২. TMDB ডাটাবেস স্ক্র্যাপার প্রোভাইডার (SUB, Movies, TV Series)
// ========================================================
function getWebProviderUrls(params) {
  const { id, isTv, season, episode } = params;

  if (isTv) {
    return [
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
      `https://vidrock.net/embed/tv/${id}/${season}/${episode}`,
      `https://vidlink.pro/tv/${id}/${season}/${episode}`
    ];
  }

  return [
    `https://vidnest.fun/movie/${id}`,
    `https://vidsrc.sbs/embed/movie/${id}`,
    `https://vidrock.net/embed/movie/${id}`,
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    `https://vidlink.pro/movie/${id}`
  ];
}

// ৩. হাইপার-অপ্টিমাইজড ফাস্ট স্ক্র্যাপার (সব এপিসোড ক্যাপচার নিশ্চিত করবে)
async function fastScrape(browser, targetUrl) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setRequestInterception(true);
  
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    if (['image', 'stylesheet', 'font'].includes(type) || url.includes('analytics') || url.includes('doubleclick') || url.includes('ads')) {
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
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4') || u.includes('trailer');

      if (isMedia && !isFake && !resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 9000 });

      const triggerPlay = async () => {
        const frames = [page.mainFrame(), ...page.frames()];
        for (const frame of frames) {
          try {
            await frame.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button, [class*="play"]'));
              if (buttons.length > 0) {
                buttons[0].click();
              }
            });
          } catch (e) {}
        }
      };

      await triggerPlay();
      await new Promise(r => setTimeout(r, 1200));
      await triggerPlay();

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

// ========================================================
// ৪. VIDSRC.SBS DEEP MULTI-LANG SCRAPER
// ========================================================
async function scrapeVidSrcMultiLang(browser, targetUrl, preferredServer = 'AwsPly') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  return new Promise(async (resolve) => {
    let resolved = false;

    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4') || u.includes('trailer');

      if (isMedia && !isFake && !resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

      const triggerPlayback = async () => {
        const frames = [page.mainFrame(), ...page.frames()];
        for (const frame of frames) {
          try {
            await frame.evaluate((srvName) => {
              const btn = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button');
              if (btn) btn.click();

              const allElements = Array.from(document.querySelectorAll('*'));
              const dropdown = allElements.find(el => {
                const t = (el.innerText || el.textContent || '').trim();
                return t.includes('Pro Multi') || t.includes('Server') || el.classList.contains('server-item');
              });
              if (dropdown) dropdown.click();

              const serverOption = allElements.find(el => {
                const t = (el.innerText || el.textContent || '').trim();
                return (
                  t.toLowerCase().includes(srvName.toLowerCase()) ||
                  t.includes('Multi-Lang') ||
                  t.includes('AwsPly') ||
                  t.includes('Nitro') ||
                  t.includes('VidHindi') ||
                  t.includes('VidEmd')
                );
              });
              if (serverOption) serverOption.click();
            }, preferredServer);
          } catch (e) {}
        }
      };

      await triggerPlayback();
      await new Promise(r => setTimeout(r, 1200));
      await triggerPlayback();

    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 7000);
  });
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const title = query.title || '';
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'anime';
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  const malId = query.mal_id || query.malId;
  const anilistId = query.anilist_id || query.anilistId;
  const server = query.server || 'AwsPly';

  return { id: targetId, typeStr, isTv, season, episode, lang, malId, anilistId, title, server };
}

// ========================================================
// ৫. মেইন JSON RESOLVER API
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
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          rawUrl: result.url,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  const scrapeTask = (async () => {
    try {
      const browser = await getWarmBrowser();
      const urls = getWebProviderUrls(params);
      for (const url of urls) {
        const streamUrl = await fastScrape(browser, url);
        if (streamUrl) {
          const data = { url: streamUrl, ref: url, time: Date.now() };
          streamCache.set(cacheKey, data);
          return data;
        }
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
      type: params.typeStr
    });
  }

  // Active Safe Fallback Embed (No dead autoembed.cc)
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
// ৬. VIDSRC.SBS ডাইরেক্ট স্ক্র্যাপ এন্ডপয়েন্ট
// ========================================================
app.get('/api/vidsrc/scrape', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const cacheKey = `vidsrc_${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.server}`;

  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      server: params.server,
      type: params.typeStr
    });
  }

  try {
    const browser = await getWarmBrowser();
    const targetUrl = params.isTv
      ? `https://vidsrc.sbs/embed/tv/${params.id}/${params.season}/${params.episode}`
      : `https://vidsrc.sbs/embed/movie/${params.id}`;

    const strea
