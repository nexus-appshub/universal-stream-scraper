const express = require('express');
const cors = require('cors');
const axios = require('axios');

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

// ============================================================================
// ১. লাইভ ডাইরেক্ট HLS এক্সট্রাক্টর (Unpacked Raw Streams)
// ============================================================================
async function fetchRawMediaStream(id, isTv, season = 1, episode = 1) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  // নেটওয়ার্ক ১: VidSrc ICU / CC API
  try {
    const apiUrl = isTv
      ? `https://vidsrc.icu/embed/tv/${id}/${season}/${episode}`
      : `https://vidsrc.icu/embed/movie/${id}`;
    const res = await axios.get(apiUrl, { headers, timeout: 6000 });
    const match = res.data.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i) || res.data.match(/src:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (match && match[1]) {
      return { streamUrl: match[1], referer: apiUrl };
    }
  } catch (e) {}

  // নেটওয়ার্ক ২: 2Embed / SuperEmbed Direct Gateway
  try {
    const twoEmbedUrl = isTv
      ? `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`
      : `https://www.2embed.cc/embed/${id}`;
    const res = await axios.get(twoEmbedUrl, { headers, timeout: 6000 });
    const match = res.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i) || res.data.match(/src:\s*["']([^"']+)["']/i);
    if (match && match[1] && match[1].includes('.m3u8')) {
      return { streamUrl: match[1], referer: twoEmbedUrl };
    }
  } catch (e) {}

  // নেটওয়ার্ক ৩: SmashyStream Direct API
  try {
    const smashUrl = isTv
      ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${season}&episode=${episode}`
      : `https://embed.smashystream.com/playere.php?tmdb=${id}`;
    const res = await axios.get(smashUrl, { headers: { ...headers, Referer: 'https://smashystream.com/' }, timeout: 6000 });
    const match = res.data.match(/file:\s*["']([^"']+)["']/i) || res.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (match && (match[1] || match[0])) {
      const found = match[1] || match[0];
      if (found.includes('.m3u8')) {
        return { streamUrl: found, referer: smashUrl };
      }
    }
  } catch (e) {}

  // নেটওয়ার্ক ৪: AutoEmbed Native Feed
  try {
    const autoEmbedUrl = isTv
      ? `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`
      : `https://player.autoembed.cc/embed/movie/${id}`;
    const res = await axios.get(autoEmbedUrl, { headers: { ...headers, Referer: 'https://autoembed.cc/' }, timeout: 6000 });
    const match = res.data.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (match && match[1]) {
      return { streamUrl: match[1], referer: autoEmbedUrl };
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
// ২. মেইন রেজলভার JSON API
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

  const result = await fetchRawMediaStream(params.id, params.isTv, params.season, params.episode);

  if (result && result.streamUrl && result.streamUrl.includes('.m3u8')) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
      rawUrl: result.streamUrl,
      type: params.typeStr,
    });
  }

  return res.status(404).json({
    success: false,
    error: 'Raw stream extraction failed on scraper networks',
  });
});

// ============================================================================
// ৩. ডাইরেক্ট নেটিভ প্লে এন্ডপয়েন্ট (`/api/moviebox/play`)
// ============================================================================
app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.lang}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  const result = await fetchRawMediaStream(params.id, params.isTv, params.season, params.episode);
  if (result && result.streamUrl && result.streamUrl.includes('.m3u8')) {
    streamCache.set(cacheKey, { url: result.streamUrl, ref: result.referer, time: Date.now() });
    return pipeMediaTunnel(req, res, result.streamUrl, result.referer);
  }

  return res.status(404).send('Stream Offline');
});

// ============================================================================
// ৪. সেফ মিডিয়া টানেল প্রক্সি (সেগমেন্ট ও মাস্টার রিরাইটার)
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

    const requestHeaders = {
      'Referer': ref,
      'Origin': ref.replace(/\/$/, ''),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (req.headers['range']) {
      requestHeaders['Range'] = req.headers['range'];
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: requestHeaders,
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

app.get('/', (req, res) => res.send('🚀 Pure Raw Stream Scraper Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on ${PORT}`));
