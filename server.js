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
// 1. MOVIEBOX NATIVE API CLIENT (1ST PRIORITY)
// ==========================================
const MBOX_HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream'
};

let cachedMboxToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

// MovieBox থেকে সরাসরি প্লে স্ট্রিম আনা
async function getMovieBoxStream(subjectId, se = 0, ep = 0) {
  try {
    const res = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${cachedMboxToken}`
      },
      timeout: 6000
    });

    const data = res.data?.data;
    if (!data) return null;

    const mp4Url = data.resources?.[0]?.url;
    const dashStream = data.streams?.[0];

    return {
      streamUrl: dashStream ? dashStream.url : mp4Url,
      cookie: dashStream?.signCookie || ''
    };
  } catch (err) {
    console.log('MovieBox direct API error/fallback:', err.message);
    return null;
  }
}

// ==========================================
// 2. WEB PROVIDERS FALLBACK (2ND PRIORITY)
// ==========================================
function getWebProviderUrls(id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  return [
    isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
    isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`,
    isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`
  ];
}

async function scrapeWebStream(browser, targetUrl) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  let streamUrl = null;

  page.on('response', (response) => {
    const u = response.url();
    const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
    if (isMedia && !u.includes('analytics') && !u.includes('doubleclick') && !u.includes('demo')) {
      streamUrl = u;
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
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
        const btn = document.querySelector('video, button, #play, .play-btn');
        if (btn) btn.click();
      });
    }
  } catch (e) {}

  let waitTime = 0;
  while (!streamUrl && waitTime < 6000) {
    await new Promise(r => setTimeout(r, 400));
    waitTime += 400;
  }

  await page.close();
  return streamUrl;
}

// ==========================================
// 3. MAIN DIRECT STREAM PIPELINE
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
  const { subjectId, id, type = 'movie', s = 1, e = 1 } = req.query;
  const targetId = subjectId || id || '8826677989518759008';

  // ১ম ধাপ: সরাসরি MovieBox অফিশিয়াল সার্ভার ট্রাই করা
  const mboxData = await getMovieBoxStream(targetId, s, e);
  if (mboxData && mboxData.streamUrl) {
    try {
      const streamRes = await axios({
        method: 'GET',
        url: mboxData.streamUrl,
        responseType: 'stream',
        headers: {
          'Cookie': mboxData.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 20000
      });

      res.set({
        'Content-Type': streamRes.headers['content-type'] || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes'
      });

      return streamRes.data.pipe(res);
    } catch (err) {
      console.log('MBox pipe failed, falling back to Puppeteer Scraper...');
    }
  }

  // ২য় ধাপ: ফলব্যাক হিসেবে Puppeteer Web Scraper চালানো
  let browser = null;
  let finalStream = null;
  let usedUrl = '';
  const webUrls = getWebProviderUrls(targetId, s, e, type);

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    for (const url of webUrls) {
      finalStream = await scrapeWebStream(browser, url);
      if (finalStream) {
        usedUrl = url;
        break;
      }
    }

    await browser.close();

    if (!finalStream) {
      return res.status(404).send('Movie stream not available on MovieBox or Web Providers.');
    }

    const fallbackStream = await axios({
      method: 'GET',
      url: finalStream,
      responseType: 'stream',
      headers: {
        'Referer': usedUrl,
        'Origin': new URL(usedUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 20000
    });

    res.set({
      'Content-Type': fallbackStream.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    return fallbackStream.data.pipe(res);

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).send('Streaming error: ' + err.message);
  }
});

// সরাসরি CDN প্রক্সি
app.get('/api/stream-proxy', async (req, res) => {
  const { url, cookie } = req.query;
  if (!url) return res.status(400).send('URL missing');

  try {
    const response = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      responseType: 'stream',
      headers: {
        'Cookie': cookie ? decodeURIComponent(cookie) : '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy error');
  }
});

app.get('/', (req, res) => res.send('🎬 MovieBox Official & Universal Hybrid Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Engine online on ${PORT}`));
