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
// 1. UNIVERSAL CDN / STREAM PROXY PIPE
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
    res.status(500).json({ error: 'Stream Proxy Pipe Failed', message: error.message });
  }
});

// ==========================================
// 2. DIRECT MOVIE / STREAM PLAYER ROUTE
// ==========================================
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

// 🟢 ব্রাউজারে সরাসরি ভিডিও প্লে করার এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const { id = '550', provider = 'vidnest', type = 'movie', s = 1, e = 1 } = req.query;

  const targetUrl = resolveProviderUrl(provider, id, s, e, type);
  let browser = null;

  try {
    browser = await puppeteer.launch({
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
      const isBlacklisted = u.includes('githubusercontent.com') || u.includes('analytics') || u.includes('doubleclick') || u.includes('demo-video.mp4');

      if (isMedia && !isBlacklisted) {
        streamUrl = u;
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    } catch (err) {}

    try {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const domSource = await frame.evaluate(() => {
            const v = document.querySelector('video');
            return v ? v.src : null;
          });
          if (domSource && domSource.startsWith('http') && !domSource.includes('demo-video.mp4')) {
            streamUrl = domSource;
            break;
          }
          await frame.evaluate(() => {
            const els = document.querySelectorAll('video, button, #play, .play-btn, .art-video-player');
            els.forEach(el => el.click && el.click());
          });
        } catch (fe) {}
      }
    } catch (err) {}

    let waitTime = 0;
    while (!streamUrl && waitTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (!streamUrl) {
      return res.status(404).send('Stream could not be captured. Please try another provider.');
    }

    // সরাসরি স্ট্রিম প্রক্সি করে ব্রাউজারে ভিডিও প্লে শুরু করা
    const proxyStreamResponse = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'Referer': targetUrl,
        'Origin': new URL(targetUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    });

    res.set({
      'Content-Type': proxyStreamResponse.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    proxyStreamResponse.data.pipe(res);

  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).send('Streaming error: ' + error.message);
  }
});

// JSON API
app.get('/api/get-stream', async (req, res) => {
  const { provider = 'vidnest', id = '550', s = 1, e = 1, type = 'movie' } = req.query;
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    directPlayUrl: `${hostUrl}/api/moviebox/play?id=${id}&provider=${provider}&type=${type}&s=${s}&e=${e}`
  });
});

app.get('/', (req, res) => res.send('🚀 Universal Stream Scraper is Live & Healthy!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on port ${PORT}`));
