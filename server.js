const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. AUTO TITLE-TO-TMDB RESOLVER ENGINE
// ==========================================
async function getTmdbIdByTitle(title) {
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
      params: {
        api_key: '15d2de7784e4e9a0ec49d4432a50c822', // Universal Public TMDB Key
        query: title
      },
      timeout: 5000
    });
    if (res.data?.results?.length > 0) {
      return res.data.results[0].id;
    }
  } catch (e) {
    console.error('TMDB Search fallback error:', e.message);
  }
  return null;
}

function resolveProviderUrl(provider, id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  switch (provider.toLowerCase()) {
    case 'vidnest':
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
    case 'vidrock':
      return isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`;
    case 'vidsrc':
    case 'vidsrc_to':
      return isTv ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/movie/${id}`;
    case 'autoembed':
      return isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`;
    default:
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
  }
}

// ==========================================
// 2. HIGH-SPEED STREAM PROXY PIPE
// ==========================================
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer, cookie } = req.query;
  if (!url) return res.status(400).send('URL is required');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const signCookie = cookie ? decodeURIComponent(cookie) : '';

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    if (signCookie) headers['Cookie'] = signCookie;
    if (referer) {
      headers['Referer'] = ref;
      headers['Origin'] = ref.replace(/\/$/, '');
    }

    const response = await axios({
      method: 'GET',
      url: target,
      responseType: 'stream',
      headers,
      timeout: 20000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Proxy Pipe Failed', message: error.message });
  }
});

// ==========================================
// 3. DIRECT PLAY STREAM ROUTE (TITLE & ID)
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
  let { title, id, provider = 'vidnest', type = 'movie', s = 1, e = 1 } = req.query;

  try {
    // মুভির নাম থাকলে অটো TMDB ID বের করবে
    if (!id && title) {
      id = await getTmdbIdByTitle(title);
    }

    if (!id) {
      return res.status(404).send(`Movie not found for title: "${title || 'Unknown'}"`);
    }

    const targetUrl = resolveProviderUrl(provider, id, s, e, type);

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    let streamUrl = null;

    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || u.includes('master.m3u8') || (u.includes('.mp4') && !u.includes('google'));
      const isBlacklisted = u.includes('analytics') || u.includes('doubleclick') || u.includes('demo');

      if (isMedia && !isBlacklisted) {
        streamUrl = u;
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {}

    try {
      const frames = page.frames();
      for (const frame of frames) {
        const domSource = await frame.evaluate(() => {
          const v = document.querySelector('video');
          return v ? v.src : null;
        });
        if (domSource && domSource.startsWith('http') && !domSource.includes('demo')) {
          streamUrl = domSource;
          break;
        }
        await frame.evaluate(() => {
          const btn = document.querySelector('video, button, #play, .play-btn, .art-video-player');
          if (btn) btn.click();
        });
      }
    } catch (e) {}

    let waitTime = 0;
    while (!streamUrl && waitTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (!streamUrl) {
      return res.status(404).send('Stream could not be captured. Please retry.');
    }

    // সরাসরি ক্লাউডফ্রন্ট/এইচএলএস প্রক্সি করে ব্রাউজারে ভিডিও প্লে করা
    const videoStream = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'Referer': targetUrl,
        'Origin': new URL(targetUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 20000
    });

    res.set({
      'Content-Type': videoStream.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    videoStream.data.pipe(res);

  } catch (error) {
    res.status(500).send('Streaming error: ' + error.message);
  }
});

// JSON API Endpoint
app.get('/api/moviebox', (req, res) => {
  const { title = 'Fight Club', id } = req.query;
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const param = id ? `id=${id}` : `title=${encodeURIComponent(title)}`;
  res.json({
    success: true,
    title,
    streamUrl: `${hostUrl}/api/moviebox/play?${param}`
  });
});

app.get('/', (req, res) => {
  res.send('⚡ Stealth Universal Stream Scraper Engine is Online!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Universal Engine Active on port ${PORT}`));
