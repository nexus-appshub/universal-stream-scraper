const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

function resolveProviderUrl(provider, id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  switch (provider.toLowerCase()) {
    case 'vidrock':
      return isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`;
    case 'vidnest':
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
    case 'vidsrc':
    case 'vidsrc_to':
      return isTv ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/movie/${id}`;
    case 'vidsrc_me':
      return isTv ? `https://vidsrc.me/embed/tv?tmdb=${id}&sea=${s}&epi=${e}` : `https://vidsrc.me/embed/movie?tmdb=${id}`;
    case 'vidsrc_in':
    case 'vixsrc':
      return isTv ? `https://vidsrc.in/embed/tv/${id}/${s}/${e}` : `https://vidsrc.in/embed/movie/${id}`;
    case 'autoembed':
      return isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`;
    case 'videasy':
      return isTv ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/movie/${id}`;
    case 'cinesu':
      return isTv ? `https://cinesrc.stream/embed/tv/${id}/${s}/${e}` : `https://cinesrc.stream/embed/movie/${id}`;
    case 'moviebox':
      return `https://themoviebox.xyz/movies/${id}`;
    case 'anikoto':
      return `https://anikoto.fun/watch/${id}-episode-${e}`;
    default:
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
  }
}

app.get('/', (req, res) => {
  res.send('Universal Stream Scraper Engine Running');
});

// সুরক্ষিত সিডিএন বাইপাস প্রক্সি
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Target stream URL is required');

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

// ডিপ স্ক্র্যাপার এন্ডপয়েন্ট
app.get('/api/get-stream', async (req, res) => {
  const { provider = 'vidnest', id, s = 1, e = 1, type = 'movie' } = req.query;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Media ID is required' });
  }

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
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720'
      ]
    });

    const page = await browser.newPage();
    
    // বট ডিটেকশন শিল্ড
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    let streamUrl = null;

    // সব ফ্রেম ও আইফ্রেমের নেটওয়ার্ক রেসপন্স ইন্টারসেপ্ট করা
    page.on('response', async (response) => {
      const url = response.url();
      if (
        (url.includes('.m3u8') || url.includes('/hls/') || url.includes('master.m3u8') || (url.includes('.mp4') && !url.includes('google'))) &&
        !url.includes('analytics') &&
        !url.includes('doubleclick')
      ) {
        streamUrl = url;
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch (navErr) {}

    // আইফ্রেমের ভেতরের প্লেয়ার বাটন ট্রিগার করা
    try {
      await page.evaluate(() => {
        const elements = document.querySelectorAll('button, video, .play, .jw-preview, iframe');
        elements.forEach(el => el.click && el.click());
      });
    } catch (e) {}

    // স্ট্রিম পাওয়ার জন্য সর্বোচ্চ ১০ সেকেন্ড অপেক্ষা
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
      return res.status(404).json({ success: false, error: `Could not capture stream for ${provider}` });
    }

  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Universal Scraper online on port ${PORT}`));
