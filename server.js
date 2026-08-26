const express = require('express');
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');
let puppeteer = null;

try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('Puppeteer fallback enabled.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SERVER_GENERATORS = {
  'vidnest': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
  'vidrock': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidrock.net/tv/${id}/${s}/${e}` : `https://vidrock.net/movie/${id}`,
  'videasy': (t, id, s = 1, e = 1) => t === 'tv' ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/movie/${id}`,
  '1shows': (t, id, s = 1, e = 1) => t === 'tv' ? `https://1shows.app/tv/${id}/${s}/${e}` : `https://1shows.app/movie/${id}`,
  'vidlink': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`,
  'autoembed': (t, id, s = 1, e = 1) => t === 'tv' ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`
};

function isCandidateStreamUrl(url, contentType = '') {
  if (!url) return false;
  const u = url.toLowerCase();
  if (
    u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.jpeg') || 
    u.endsWith('.svg') || u.endsWith('.css') || u.endsWith('.js') ||
    u.includes('google-analytics') || u.includes('doubleclick') || u.includes('trailer')
  ) return false;

  return (
    u.includes('.m3u8') || 
    u.includes('.mp4') || 
    u.includes('workers.dev') ||
    u.includes('gcogotv.com') ||
    u.includes('vogttonight') ||
    u.includes('chunk-stream') ||
    u.includes('playlist') ||
    contentType.includes('mpegurl') || 
    contentType.includes('video/')
  );
}

// ডিপ মাল্টি-ফ্রেম ব্রাউজার স্ক্র্যাপার
async function extractStream(targetUrl) {
  if (!puppeteer) return null;

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--window-size=1280,720',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    let streamUrls = [];
    const handleNetwork = (url, type = '') => {
      if (isCandidateStreamUrl(url, type)) {
        streamUrls.push(url);
      }
    };

    browser.on('targetcreated', async (t) => {
      try {
        const p = await t.page();
        if (p) {
          p.on('response', (r) => handleNetwork(r.url(), r.headers()['content-type'] || ''));
          p.on('request', (rq) => handleNetwork(rq.url()));
        }
      } catch (e) {}
    });

    const page = await browser.newPage();
    let origin = 'https://vidnest.fun/';
    try { origin = new URL(targetUrl).origin + '/'; } catch(e){}

    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9', 'referer': origin });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    page.on('response', (res) => handleNetwork(res.url(), res.headers()['content-type'] || ''));
    page.on('request', (req) => handleNetwork(req.url()));

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 7000 });
    } catch (e) {}

    const frames = page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(() => {
          const selectors = ['video', 'button', '#play', '.play-btn', '.jw-display-icon', '[class*="play"]'];
          selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.click()));
        });
      } catch (e) {}
    }
    try { await page.mouse.click(640, 360); } catch (e) {}

    let wait = 0;
    while (streamUrls.length === 0 && wait < 4500) {
      await new Promise(r => setTimeout(r, 500));
      wait += 500;
    }

    await browser.close();

    if (streamUrls.length > 0) {
      const best = streamUrls.find(u => u.includes('workers.dev') || u.includes('.m3u8')) || streamUrls[0];
      return best;
    }
    return null;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// স্মার্ট HLS/DASH প্রক্সি টানেল (Content-Disposition & HTML Tab Player Support)
app.get(['/api/proxy-stream', '/api/stream-proxy'], async (req, res) => {
  const streamUrl = req.query.url;
  const isRaw = req.query.raw === 'true';
  const acceptHeader = req.headers['accept'] || '';

  if (!streamUrl) return res.status(400).send('URL required');

  // যদি সরাসরি ক্রোম ট্যাবে লিঙ্ক খোলা হয় তবে ইনলাইন প্লেয়ার দেখানো হবে
  if (acceptHeader.includes('text/html') && !isRaw) {
    const rawUrl = `${req.protocol}://${req.get('host')}${req.path}?url=${encodeURIComponent(streamUrl)}${req.query.referer ? `&referer=${encodeURIComponent(req.query.referer)}` : ''}&raw=true`;
    return res.set('Content-Type', 'text/html; charset=utf-8').send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Stream Preview Player</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"></script>
        <style>
          body { margin: 0; background: #000; display: flex; align-items: center; justify-content: center; height: 100vh; }
          video { width: 100%; height: 100%; max-width: 1280px; max-height: 720px; outline: none; }
        </style>
      </head>
      <body>
        <video id="video" controls autoplay crossorigin="anonymous"></video>
        <script>
          const video = document.getElementById('video');
          const src = ${JSON.stringify(rawUrl)};
          if (Hls.isSupported()) {
            const hls = new Hls({ lowLatencyMode: false });
            hls.loadSource(src);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play(); });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            video.addEventListener('loadedmetadata', function() { video.play(); });
          }
        </script>
      </body>
      </html>
    `);
  }

  try {
    let cleanUrl = decodeURIComponent(streamUrl);
    const customReferer = req.query.referer ? decodeURIComponent(req.query.referer) : 'https://vidnest.fun/';
    let targetOrigin = 'https://vidnest.fun';
    try { targetOrigin = new URL(cleanUrl).origin; } catch (e) {}

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': customReferer,
        'Origin': targetOrigin,
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      },
      timeout: 25000
    });

    let buffer = Buffer.from(response.data);
    const encoding = response.headers['content-encoding'];
    if (encoding === 'gzip') {
      try { buffer = zlib.gunzipSync(buffer); } catch (e) {}
    }

    const textPreview = buffer.slice(0, 500).toString('utf8');
    const isM3u8Content = textPreview.includes('#EXTM3U') || textPreview.includes('#EXT-X-');

    if (isM3u8Content) {
      const utf8Text = buffer.toString('utf8');
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const hostUrl = `${req.protocol}://${req.get('host')}`;

      const rewritten = utf8Text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, keyUrl) => {
              let abs = keyUrl.startsWith('http') ? keyUrl : new URL(keyUrl, baseUrl).href;
              return `URI="${hostUrl}/api/proxy-stream?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(customReferer)}&raw=true"`;
            });
          }
          return line;
        }

        let chunk = trimmed;
        if (!chunk.startsWith('http://') && !chunk.startsWith('https://')) {
          chunk = chunk.startsWith('/') ? `${new URL(cleanUrl).origin}${chunk}` : `${baseUrl}${chunk}`;
        }
        return `${hostUrl}/api/proxy-stream?url=${encodeURIComponent(chunk)}&referer=${encodeURIComponent(customReferer)}&raw=true`;
      }).join('\n');

      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache, no-store',
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8'
      });
      return res.send(rewritten);
    }

    let contentType = response.headers['content-type'] || 'video/mp2t';
    if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
      contentType = cleanUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
    }

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': contentType
    });

    return res.send(buffer);
  } catch (err) {
    res.set('Access-Control-Allow-Origin', '*');
    res.status(502).send('Stream Proxy Tunnel Error');
  }
});

// ইউনিভার্সাল রেজলভার এন্ডপয়েন্ট
app.all(['/api/resolve-stream', '/api/v1/extract'], async (req, res) => {
  const p = req.method === 'POST' ? req.body : req.query;
  const tmdbId = p.id || p.tmdb_id;
  const type = (p.type || 'movie').toLowerCase();
  const season = p.season || p.s || 1;
  const episode = p.episode || p.e || 1;
  const serverKey = (p.server || 'vidnest').toLowerCase();

  if (!tmdbId) return res.status(400).json({ success: false, error: 'TMDB ID required' });

  const gen = SERVER_GENERATORS[serverKey] || SERVER_GENERATORS['vidnest'];
  let targetUrl = gen(type, tmdbId, season, episode);
  let streamUrl = await extractStream(targetUrl);
  let actualServer = serverKey;

  if (!streamUrl) {
    const fallbacks = ['vidnest', 'vidrock', 'vidlink', 'autoembed'];
    for (const fb of fallbacks) {
      if (fb !== serverKey) {
        const fbUrl = SERVER_GENERATORS[fb](type, tmdbId, season, episode);
        streamUrl = await extractStream(fbUrl);
        if (streamUrl) {
          actualServer = fb;
          targetUrl = fbUrl;
          break;
        }
      }
    }
  }

  const host = `${req.protocol}://${req.get('host')}`;

  if (streamUrl) {
    return res.json({
      success: true,
      isEmbed: false,
      server: actualServer,
      source_host: 'sz.gcogotv.com',
      format: 'High efficiency (DASH/H.265 & HLS)',
      streamUrl: `${host}/api/proxy-stream?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`,
      rawUrl: streamUrl,
      type
    });
  }

  return res.status(404).json({ success: false, error: 'Stream not found' });
});

app.get('/', (req, res) => res.send('🚀 High-Speed Unified Stream Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Engine listening on ${PORT}`));
