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
// 1. LIVE VIDEO PROXY PIPE (CORS & BUFFER FIX)
// ==========================================
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Stream URL is required');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;

    const streamResponse = await axios({
      method: 'GET',
      url: target,
      responseType: 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });

    res.set({
      'Content-Type': streamResponse.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    streamResponse.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'CDN Pipe Error', message: error.message });
  }
});

// ==========================================
// 2. UNIVERSAL MOVIE SCRAPER & DIRECT PLAYER
// ==========================================
function resolveProviderUrl(title, id) {
  if (id) return `https://vidnest.fun/movie/${id}`;
  const query = encodeURIComponent(title);
  return `https://vidsrc.to/embed/movie/${query}`;
}

// 🟢 সরাসরি যেকোনো ব্রাউজার ট্যাবে লাইভ মুভি প্লে করার এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const { title = 'The Odyssey', id } = req.query;
  const targetUrl = resolveProviderUrl(title, id);
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let streamUrl = null;

    // ট্রাফিক থেকে রিয়েল .mp4 / .m3u8 ক্যাপচার করা
    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      const isBlacklisted = u.includes('analytics') || u.includes('doubleclick') || u.includes('demo');

      if (isMedia && !isBlacklisted) {
        streamUrl = u;
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {}

    // প্লেয়ার ট্রিগার
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const domSource = await frame.evaluate(() => {
          const v = document.querySelector('video');
          return v ? v.src : null;
        });
        if (domSource && domSource.startsWith('http')) {
          streamUrl = domSource;
          break;
        }
        await frame.evaluate(() => {
          const btn = document.querySelector('video, button, #play, .play-btn');
          if (btn) btn.click();
        });
      }
    } catch (e) {}

    let waitTime = 0;
    while (!streamUrl && waitTime < 8000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (!streamUrl) {
      return res.status(404).send(`Unable to extract live video stream for "${title}".`);
    }

    // সরাসরি ভিডিও স্ট্রিম ব্রাউজারে রিটার্ন করা
    const videoStream = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'Referer': targetUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    });

    res.set({
      'Content-Type': videoStream.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    videoStream.data.pipe(res);

  } catch (error) {
    if (browser) await browser.close();
    res.status(500).send('Stream error: ' + error.message);
  }
});

// JSON API
app.get('/api/moviebox', (req, res) => {
  const { title = 'The Odyssey', id } = req.query;
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    title,
    streamUrl: `${hostUrl}/api/moviebox/play?title=${encodeURIComponent(title)}${id ? `&id=${id}` : ''}`
  });
});

app.get('/', (req, res) => res.send('🚀 Universal Stream Engine Live!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Live on port ${PORT}`));
