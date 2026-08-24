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
  const { id, episode = 1, title, malId: paramMal, anilistId: paramAni } = params;
  let malId = paramMal;
  let anilistId = paramAni;

  if (!malId && !anilistId && title) {
    const ext = await getAnimeExternalIds(title);
    malId = ext.malId;
    anilistId = ext.anilistId;
  }

  // MAL / AniList Endpoint (DUB Only)
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

  return `https://megaplay.buzz/stream/s-2/${id}/dub`;
}

// ========================================================
// ২. TMDB ডাটাবেস স্ক্র্যাপার প্রোভাইডার (SUB, Movies, TV Series)
// ========================================================
function getWebProviderUrls(params) {
  const { id, isTv, season, episode } = params;

  if (isTv) {
    return [
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
      `https://vidrock.net/embed/tv/${id}/${season}/${episode}`
    ];
  }

  return [
    `https://vidnest.fun/movie/${id}`,
    `https://player.autoembed.cc/embed/movie/${id}`,
    `https://vidsrc.sbs/embed/movie/${id}`,
    `https://vidrock.net/embed/movie/${id}`,
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`
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
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4') || u.includes('trailer');

      if (isMedia && !isFake && !resolved) {
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

// ========================================================
// ৩. VIDSRC.SBS DEEP MULTI-LANG SCRAPER (ROBUST AUTO-TRIGGER)
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
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });

      // মাল্টি-ফ্রেম অটো ক্লিক ইঞ্জিন
      const triggerPlayback = async () => {
        const frames = [page.mainFrame(), ...page.frames()];
        for (const frame of frames) {
          try {
            await frame.evaluate((srvName) => {
              // ১. প্লে বোতাম ক্লিক
              const btn = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button');
              if (btn) btn.click();

              // ২. সার্ভার ড্রপডাউন বাটন ওপেন
              const allElements = Array.from(document.querySelectorAll('*'));
              const dropdown = allElements.find(el => {
                const t = (el.innerText || el.textContent || '').trim();
                return t.includes('Pro Multi') || t.includes('Server') || el.classList.contains('server-item');
              });
              if (dropdown) dropdown.click();

              // ৩. টার্গেট সার্ভার নির্বাচন
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
      await new Promise(r => setTimeout(r, 1500));
      await triggerPlayback();

    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 9000);
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
// ৪. মেইন JSON RESOLVER API
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
  const cached = streamCache.get(cacheKey);

  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      type: params.typeStr
    });
  }

  try {
    const browser = await getWarmBrowser();
    const urls = getWebProviderUrls(params);
    let streamUrl = null;
    let usedUrl = '';

    for (const url of urls) {
      streamUrl = await fastScrape(browser, url);
      if (streamUrl) {
        usedUrl = url;
        break;
      }
    }

    if (streamUrl) {
      streamCache.set(cacheKey, { url: streamUrl, ref: usedUrl, time: Date.now() });
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`,
        rawUrl: streamUrl,
        type: params.typeStr
      });
    }

    const fallbackEmbed = params.isTv 
      ? `https://player.autoembed.cc/embed/tv/${params.id}/${params.season}/${params.episode}`
      : `https://player.autoembed.cc/embed/movie/${params.id}`;

    return res.json({
      success: true,
      isEmbed: true,
      streamUrl: fallbackEmbed,
      embedUrl: fallbackEmbed,
      type: params.typeStr
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// ৫. VIDSRC.SBS ডাইরেক্ট স্ক্র্যাপ এন্ডপয়েন্ট
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

    const streamUrl = await scrapeVidSrcMultiLang(browser, targetUrl, params.server);

    if (streamUrl) {
      streamCache.set(cacheKey, { url: streamUrl, ref: targetUrl, time: Date.now() });
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`,
        rawUrl: streamUrl,
        server: params.server,
        type: params.typeStr
      });
    }

    // যদি স্ট্রিম ডিরেক্ট স্ক্র্যাপ না হয় তবে সেফ ফলব্যাক ডাইরেক্ট এম্বেড রিটার্ন করবে
    return res.json({
      success: true,
      isEmbed: true,
      streamUrl: targetUrl,
      embedUrl: targetUrl,
      server: params.server,
      type: params.typeStr
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// টানেল হ্যান্ডলার
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  if (params.lang === 'dub') {
    const dubEmbed = await resolveDubStream(params);
    return res.redirect(dubEmbed);
  }
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;
  const cached = streamCache.get(cacheKey);
  if (cached) return pipeMediaTunnel(req, res, cached.url, cached.ref);
  return res.status(404).send('Stream Offline');
});

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

app.get('/', (req, res) => res.send('🚀 Universal TMDB Scraper & DUB Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
