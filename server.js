const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
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

// মুভিবক্স সহ সকল সাপোর্টেড সার্ভার জেনারেটর
const SERVER_GENERATORS = {
  'moviebox': (t, id, s = 1, e = 1) => t === 'tv' ? `https://netfilm.world/spa/videoPlayPage/movies/tv-${id}?id=${id}&detailSe=${s}&detailEp=${e}&type=tv` : `https://netfilm.world/spa/videoPlayPage/movies/movie-${id}?id=${id}&type=movie`,
  'vidnest': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
  'vidrock': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidrock.net/tv/${id}/${s}/${e}` : `https://vidrock.net/movie/${id}`,
  'videasy': (t, id, s = 1, e = 1) => t === 'tv' ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/movie/${id}`,
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
    u.includes('gcogotv.com') ||
    u.includes('hisavana.com') ||
    u.includes('workers.dev') ||
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

    // প্লে বাটন এবং ইন্টারেকশন ট্রিগার
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
      const best = streamUrls.find(u => u.includes('master') || u.includes('.m3u8')) || streamUrls[0];
      return best;
    }
    return null;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// প্রক্সি টানেল (HLS, DASH, ও অক্টেট সেগমেন্ট রিরাইটার)
app.get(['/api/proxy-stream', '/api/stream-proxy'], async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('URL required');

  try {
    const customReferer = req.query.referer || 'https://vidnest.fun/';
    const targetObj = new URL(streamUrl);

    const response = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: streamUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': customReferer,
        'Origin': new URL(customReferer).origin,
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      },
      timeout: 25000
    });

    let contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
    if (!streamUrl.includes('.m3u8')) {
      if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
        contentType = streamUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
      }
    }

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType
    });

    if (streamUrl.includes('.m3u8')) {
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      
      const rewritten = response.data.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          let chunkUrl = trimmed.startsWith('http') ? trimmed : (trimmed.startsWith('/') ? `${targetObj.protocol}//${targetObj.host}${trimmed}` : `${baseUrl}${trimmed}`);
          return `${hostUrl}/api/proxy-stream?url=${encodeURIComponent(chunkUrl)}&referer=${encodeURIComponent(customReferer)}`;
        }
        return line;
      }).join('\n');

      return res.send(rewritten);
    }

    response.data.pipe(res);
  } catch (err) {
    res.status(502).send('Gateway Error');
  }
});

// মেইন রেজলভার এন্ডপয়েন্ট
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

  // ফলব্যাক চেইন
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

app.get('/', (req, res) => res.send('🚀 MovieBox & Multi-Server Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Engine live on ${PORT}`));
