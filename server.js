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
// ১. TMDB ID -> ANILIST / MAL ID অটো কনভার্টার (Jikan/Anilist)
// ========================================================
async function getAnimeExternalIds(tmdbId, title = '') {
  try {
    // নাম অথবা TMDB আইডি দিয়ে দ্রুত AniList সার্চ
    const query = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          id
          idMal
          title { english romaji }
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
      if (media) {
        return { malId: media.idMal, anilistId: media.id };
      }
    }
  } catch (e) {}
  return { malId: null, anilistId: null };
}

// ========================================================
// ২. ANIKOTO DUB/SUB রেজলভার
// ========================================================
async function resolveAnimeStream(params) {
  const { id, episode = 1, lang = 'dub', title } = params;
  let { malId, anilistId } = params;

  // যদি সরাসরি MAL/AniList আইডি না থাকে, তবে অটো কনভার্ট করা
  if (!malId && !anilistId) {
    const ext = await getAnimeExternalIds(id, title);
    malId = ext.malId;
    anilistId = ext.anilistId;
  }

  // ১. MAL Endpoint (ডকুমেন্টেশন অনুযায়ী সবচেয়ে নিখুঁত DUB/SUB প্রদান করে)
  if (malId) {
    return {
      embedUrl: `https://megaplay.buzz/stream/mal/${malId}/${episode}/${lang}`, //
      isEmbed: true,
      lang
    };
  }

  // ২. AniList Endpoint
  if (anilistId) {
    return {
      embedUrl: `https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${lang}`, //
      isEmbed: true,
      lang
    };
  }

  // ৩. সরাসরি Anikoto API
  try {
    const res = await axios.get(`https://anikotoapi.site/series/${id}`, { timeout: 4000 }); //
    const episodes = res.data?.episodes || res.data?.data?.episodes;
    if (episodes && episodes.length > 0) {
      const ep = episodes.find(e => Number(e.number) === Number(episode)) || episodes[episode - 1] || episodes[0];
      const embedId = ep?.episode_embed_id || ep?.id;
      if (embedId) {
        return {
          embedUrl: `https://megaplay.buzz/stream/s-2/${embedId}/${lang}`, //
          isEmbed: true,
          lang
        };
      }
    }
  } catch (err) {}

  // ফলব্যাক DUB মেগাপ্লে
  return {
    embedUrl: `https://megaplay.buzz/stream/s-2/${id}/${lang}`, //
    isEmbed: true,
    lang
  };
}

// ========================================================
// ৩. মুভি ও টিভি সিরিজ প্রোভাইডার
// ========================================================
function getWebProviderUrls(params) {
  const { id, isTv, season, episode } = params;

  if (isTv) {
    return [
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`
    ];
  }

  return [
    `https://vidnest.fun/movie/${id}`,
    `https://player.autoembed.cc/embed/movie/${id}`,
    `https://vidsrc.sbs/embed/movie/${id}`,
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
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4');

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

function parseParams(query) {
  const targetId = query.id || query.subjectId || query.tmdbId || '223564';
  const typeStr = (query.type || query.media_type || 'tv').toLowerCase();
  const title = query.title || '';
  const isAnime = typeStr === 'anime' || query.isAnime === 'true' || title.toLowerCase().includes('anime');
  const isTv = typeStr === 'tv' || typeStr === 'series' || isAnime;
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  const malId = query.mal_id || query.malId;
  const anilistId = query.anilist_id || query.anilistId;

  return { id: targetId, typeStr, isAnime, isTv, season, episode, lang, malId, anilistId, title };
}

// ========================================================
// ৪. মেইন JSON RESOLVER API
// ========================================================
app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  // ১. এনিমে DUB / SUB স্পেসিফিক হ্যান্ডলার
  if (params.isAnime || params.malId || params.anilistId || req.query.lang) {
    const animeStream = await resolveAnimeStream(params);
    if (animeStream && animeStream.embedUrl) {
      return res.json({
        success: true,
        isEmbed: true,
        streamUrl: animeStream.embedUrl,
        embedUrl: animeStream.embedUrl,
        lang: params.lang,
        type: 'anime',
        season: params.season,
        episode: params.episode
      });
    }
  }

  // ২. মুভি ও নরমাল টিভি সিরিজ হ্যান্ডলার
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

    const fallbackEmbed = `https://player.autoembed.cc/embed/tv/${params.id}/${params.season}/${params.episode}`;
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

// টানেল হ্যান্ডলার
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  if (params.isAnime || req.query.lang) {
    const animeStream = await resolveAnimeStream(params);
    return res.redirect(animeStream.embedUrl);
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

app.get('/', (req, res) => res.send('🚀 Universal Anime & Cinema DUB Core Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
