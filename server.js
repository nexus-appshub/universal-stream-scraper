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

// ১০০K ট্রাফিকের জন্য ২৪ ঘণ্টা মেমোরি ক্যাশ
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// সমসাময়িক রিকোয়েস্ট লকার (একই টাইটেলে মাল্টিপল ব্রাউজার ওপেন বন্ধ রাখার জন্য)
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
  const { id, episode = 1, title, malId: paramMal, anilistId: paramAni } = params;
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

  return `https://vidsrc.sbs/embed/tv/${id}/${params.season}/${episode}?dub=1`;
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
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    // ইমেজ, ফন্ট এবং সিএসএস ব্লক করি - কিন্তু স্ক্রিপ্ট ও মিডিয়া সচল রাখি
    if (['image', 'font', 'stylesheet'].includes(type) || url.includes('analytics') || url.includes('doubleclick') || url.includes('ads')) {
      req.abort();
    } else {
      req.continue();
    }
  });

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
      // পেজ লোড হওয়ার জন্য ১০ সেকেন্ড সময় দিই
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      
      // প্লেয়ার রেন্ডার হওয়া পর্যন্ত লুপ করে সর্বোচ্চ ৪ সেকেন্ড অপেক্ষা ও ক্লিক করা
      await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 20; i++) {
          const btn = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button');
          if (btn) {
            btn.click();
            break;
          }
          await sleep(200);
        }
      });
    } catch (e) {}

    // টোটাল স্ক্র্যাপার টাইমআউট বাড়িয়ে ১০ সেকেন্ড করা হলো
    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 10000);
  });
}

// ========================================================
// ৩. VIDSRC.SBS DEEP MULTI-LANG SCRAPER
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
    }, 10000);
  });
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || query.tmdb_id || '27205';
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
// ৪. মেইন RESOLVER API
// ========================================================
async function handleResolveStream(req, res) {
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
      proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      stream_url: cached.url,
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
          proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          stream_url: result.url,
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
      proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      stream_url: finalResult.url,
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
    proxy_stream_url: fallbackEmbed,
    stream_url: fallbackEmbed,
    type: params.typeStr
  });
}

app.get(['/api/resolve-stream', '/api/v1/extract'], handleResolveStream);

// ডাইরেক্ট স্ট্রিম রিডাইরেক্ট রাউট
app.get('/api/v1/stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;
  
  let targetStream = streamCache.get(cacheKey);
  if (!targetStream) {
    const browser = await getWarmBrowser();
    const urls = getWebProviderUrls(params);
    for (const url of urls) {
      const streamUrl = await fastScrape(browser, url);
      if (streamUrl) {
        targetStream = { url: streamUrl, ref: url, time: Date.now() };
        streamCache.set(cacheKey, targetStream);
        break;
      }
    }
  }

  if (targetStream) {
    return res.redirect(`${hostUrl}/api/stream-proxy?url=${encodeURIComponent(targetStream.url)}&referer=${encodeURIComponent(targetStream.ref)}`);
  }
  return res.status(404).send('Stream not found.');
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

// টোকেন ও রিলেটিভ পাথ রিজলভার হেল্পার
function resolveChunkWithToken(chunk, parentUrlObj) {
  try {
    let resolved;
    if (chunk.startsWith('http://') || chunk.startsWith('https://')) {
      resolved = new URL(chunk);
    } else {
      resolved = new URL(chunk, parentUrlObj.href);
    }
    // প্যারেন্ট M3U8-এর টোকেন সেগমেন্টে ইনহেরিট করা
    if (!resolved.search && parentUrlObj.search) {
      resolved.search = parentUrlObj.search;
    }
    return resolved.href;
  } catch (e) {
    return chunk;
  }
}

// ========================================================
// ৬. টোকেন-প্রিজার্ভিং মিডিয়া টানেল প্রক্সি
// ========================================================
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    let cleanUrl = targetUrl;
    while (cleanUrl.includes('%3A') || cleanUrl.includes('%2F')) {
      try {
        const d = decodeURIComponent(cleanUrl);
        if (d === cleanUrl) break;
        cleanUrl = d;
      } catch (e) { break; }
    }

    const targetUrlObj = new URL(cleanUrl);
    const domain = targetUrlObj.origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const proxyBase = `${protocol}://${host}/api/stream-proxy`;

    // ক্রোম ব্রাউজার ট্যাবে সরাসরি লিঙ্ক খুললে অটো-প্লেয়ার প্রদান
    const acceptHeader = req.headers['accept'] || '';
    if (acceptHeader.includes('text/html') && !req.headers.range && !cleanUrl.includes('.ts')) {
      const htmlPlayer = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Stream Preview</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { margin:0; background:#000; display:flex; align-items:center; justify-content:center; height:100vh; overflow:hidden; }
    video { width:100%; height:100%; object-fit:contain; }
  </style>
</head>
<body>
  <video id="v" controls autoplay playsinline></video>
  <script>
    const v = document.getElementById('v');
    const src = "${proxyBase}?url=${encodeURIComponent(cleanUrl)}&referer=${encodeURIComponent(ref)}&raw=1";
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(()=>{}));
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    }
  </script>
</body>
</html>`;
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(htmlPlayer);
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: 'arraybuffer',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      },
      timeout: 25000
    });

    const buffer = Buffer.from(response.data);
    const textPreview = buffer.slice(0, 500).toString('utf8');
    const isM3u8 = textPreview.includes('#EXTM3U') || textPreview.includes('#EXT-X-');

    if (isM3u8) {
      const utf8Text = buffer.toString('utf8');
      const lines = utf8Text.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // AES-128 কী এবং সাব-প্লেলিস্ট টোকেন হ্যান্ডলার
        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
              const absKey = resolveChunkWithToken(p1, targetUrlObj);
              return `URI="${proxyBase}?url=${encodeURIComponent(absKey)}&referer=${encodeURIComponent(ref)}"`;
            });
          }
          return line;
        }

        // সেগমেন্ট লিঙ্ক রিরাইটিং ও টোকেন ধরে রাখা
        const absChunk = resolveChunkWithToken(trimmed, targetUrlObj);
        return `${proxyBase}?url=${encodeURIComponent(absChunk)}&referer=${encodeURIComponent(ref)}`;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      return res.send(rewritten);
    }

    let contentType = response.headers['content-type'] || 'video/mp2t';
    if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
      contentType = cleanUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
    }

    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Accept-Ranges': 'bytes'
    });

    return res.send(buffer);
  } catch (error) {
    res.status(502).send('Stream Tunnel Gateway Error');
  }
}

app.get(['/api/stream-proxy', '/api/proxy-stream'], async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/', (req, res) => res.send('🚀 High-Load Universal Scraper Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
