const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

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
    case 'vidsrc_me':
      return isTv ? `https://vidsrc.me/embed/tv?tmdb=${id}&sea=${s}&epi=${e}` : `https://vidsrc.me/embed/movie?tmdb=${id}`;
    case 'autoembed':
      return isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`;
    case 'videasy':
      return isTv ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/movie/${id}`;
    default:
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
  }
}

app.get('/', (req, res) => {
  res.send('⚡ Stealth Scraper Engine Online');
});

// CDN প্রক্সি পাইপ
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL is required');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;

    const response = await axios({
      method: 'GET',
      url: target,
      responseType: 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*'
    });

    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'CDN Proxy Pipe Failed', message: error.message });
  }
});

// মেইন স্ক্র্যাপার
app.get('/api/get-stream', async (req, res) => {
  const { provider = 'vidnest', id, s = 1, e = 1, type = 'movie', url: directUrl } = req.query;

  if (!id && !directUrl) {
    return res.status(400).json({ success: false, error: 'Media ID or direct URL is required' });
  }

  const targetUrl = directUrl ? decodeURIComponent(directUrl) : resolveProviderUrl(provider, id, s, e, type);
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

    // ১. রেসপন্স লিসেনার
    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || u.includes('master.m3u8') || (u.includes('.mp4') && !u.includes('google'));
      const isBlacklisted = u.includes('githubusercontent.com') || u.includes('analytics') || u.includes('doubleclick') || u.includes('demo-video.mp4');

      if (isMedia && !isBlacklisted) {
        streamUrl = u;
      }
    });

    // ২. পেজ নেভিগেশন
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    } catch (e) {}

    // ৩. রিয়েল মাউস ক্লিক ও প্লেয়ার অ্যাক্টিভেশন
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
    } catch (e) {}

    // ৪. স্ট্রিমিং ইউআরএল ইন্টারসেপ্ট ওয়েট লুপ
    let waitTime = 0;
    while (!streamUrl && waitTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (streamUrl) {
      return res.json({
        success: true,
        provider,
        streamUrl,
        proxyStreamUrl: `/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`
      });
    } else {
      return res.status(404).json({
        success: false,
        provider,
        error: 'Target uses secured stream token. Recommend using direct iframe fallback.',
        embedUrl: targetUrl
      });
    }

  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Stealth Scraper running on port ${PORT}`));
