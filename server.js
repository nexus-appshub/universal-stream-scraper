const express = require('express');
const cors = require('cors');
const axios = require('axios');
const CryptoJS = require('crypto-js');

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
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ============================================================================
// ১. ডাইরেক্ট মাল্টি-প্রোভাইডার API এক্সট্রাক্টর (No Cloudflare Block)
// ============================================================================
async function resolveDirectHls(tmdbId, isTv, season = 1, episode = 1) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  // প্রোভাইডার ১: AutoEmbed API
  try {
    const autoUrl = isTv 
      ? `https://player.autoembed.cc/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://player.autoembed.cc/embed/movie/${tmdbId}`;
    
    const res = await axios.get(autoUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://autoembed.cc/' },
      timeout: 5000
    });
    const match = res.data.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i) || res.data.match(/source:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (match && match[1]) {
      return { streamUrl: match[1], referer: autoUrl };
    }
  } catch (e) {}

  // প্রোভাইডার ২: VidSrc Pro Resolver
  try {
    const vidsrcUrl = isTv 
      ? `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
      : `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`;
    
    const res = await axios.get(vidsrcUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://vidsrc.xyz/' },
      timeout: 5000
    });
    const match = res.data.match(/src:\s*["']([^"']+\.m3u8[^"']*)["']/i) || res.data.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
    if (match) {
      return { streamUrl: match[1] || match[0], referer: 'https://vidsrc.xyz/' };
    }
  } catch (e) {}

  // প্রোভাইডার ৩: 2Embed/VidCloud Stream Gateway
  try {
    const twoEmbedUrl = isTv
      ? `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`
      : `https://www.2embed.cc/embed/${tmdbId}`;
    const res = await axios.get(twoEmbedUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://www.2embed.cc/' },
      timeout: 5000
    });
    const match = res.data.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
    if (match) {
      return { streamUrl: match[0], referer: twoEmbedUrl };
    }
  } catch (e) {}

  // প্রোভাইডার ৪: VidRock Network
  try {
    const vidrockUrl = isTv
      ? `https://vidrock.net/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://vidrock.net/embed/movie/${tmdbId}`;
    const res = await axios.get(vidrockUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://vidrock.net/' },
      timeout: 5000
    });
    const match = res.data.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
    if (match) {
      return { streamUrl: match[0], referer: vidrockUrl };
    }
  } catch (e) {}

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
  return { id: targetId, typeStr, isTv, season, episode, lang, title };
}

// ============================================================================
// ২. মেইন JSON রেজলভার API
// ============================================================================
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
      type: params.typeStr,
    });
  }

  const result = await resolveDirectHls(params.id, params.isTv, params.season, params.episode);

  if (result && result.streamUrl) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
      rawUrl: result.streamUrl,
      type: params.typeStr,
    });
  }

  // ফাস্ট-ফলব্যাক
  const fallbackUrl = `https://vidsrc.sbs/embed/${params.isTv ? 'tv' : 'movie'}/${params.id}${params.isTv ? `/${params.season}/${params.episode}` : ''}`;
  return res.json({
    success: true,
    isEmbed: false,
    streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(fallbackUrl)}&referer=${encodeURIComponent(fallbackUrl)}`,
    rawUrl: fallbackUrl,
    type: params.typeStr,
  });
});

// ============================================================================
// ৩. ডাইরেক্ট নেটিভ প্লে এন্ডপয়েন্ট (`/api/moviebox/play`)
// ============================================================================
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  const result = await resolveDirectHls(params.id, params.isTv, params.season, params.episode);
  if (result && result.streamUrl) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return pipeMediaTunnel(req, res, result.streamUrl, result.referer);
  }

  return res.status(404).send('Stream Offline');
});

// ============================================================================
// ৪. সেফ মিডিয়া টানেল প্রক্সি (সেগমেন্ট রিরাইটার)
// ============================================================================
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
        Referer: ref,
        Origin: ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 25000,
    });

    if (cleanUrl.includes('.m3u8')) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');
      const rewritten = lines
        .map((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            let segmentUrl = trimmed;
            if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
              segmentUrl = new URL(trimmed, baseUrl).href;
            }
            return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
          }
          return line;
        })
        .join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    });
    response.data.pipe(res);
  } catch (error) {
    res.status(502).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/', (req, res) => res.send('🚀 Universal Native Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on ${PORT}`));
