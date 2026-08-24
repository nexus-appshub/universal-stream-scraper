const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. INSTANT IN-MEMORY CACHE (<0.5s Response)
// ==========================================
const streamCache = new Map();
const CACHE_TTL = 3 * 60 * 60 * 1000; // ৩ ঘণ্টা ক্যাশ থাকবে

// ==========================================
// 2. MOVIEBOX API ENGINE
// ==========================================
const MBOX_HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream'
};

let cachedMboxToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

async function getFreshMboxToken() {
  try {
    const res = await axios.post('https://tv.aoneroom.com/wefeed-tv-bff/user/visitor-login', {}, {
      headers: MBOX_HEADERS,
      timeout: 4000
    });
    if (res.data?.data?.token) {
      cachedMboxToken = res.data.data.token;
    }
  } catch (err) {}
  return cachedMboxToken;
}

async function getMovieBoxStream(subjectId, se = 0, ep = 0) {
  try {
    const token = await getFreshMboxToken();
    const res = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${token}`
      },
      timeout: 6000
    });

    const data = res.data?.data;
    if (!data) return null;

    const mp4Url = data.resources?.[0]?.url;
    const dashStream = data.streams?.[0];

    return {
      streamUrl: mp4Url || dashStream?.url,
      cookie: dashStream?.signCookie || '',
      isMpd: !mp4Url && !!dashStream?.url
    };
  } catch (err) {
    return null;
  }
}

// ==========================================
// 3. WARM BROWSER POOL & FAST SCRAPER
// ==========================================
let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts'
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

function getWebProviderUrls(id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  return [
    isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
    isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`,
    isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`,
    isTv ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/movie/${id}`
  ];
}

async function scrapeWebStream(browser, targetUrl) {
  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    if (
      ['image', 'stylesheet', 'font'].includes(type) ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
      url.includes('clarity') ||
      url.includes('adservice')
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  return new Promise(async (resolve) => {
    let resolved = false;

    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      if (isMedia && !u.includes('analytics') && !u.includes('doubleclick') && !u.includes('demo') && !resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.evaluate(() => {
        const btn = document.querySelector('video, button, #play, .play-btn');
        if (btn) btn.click();
      });
    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 4500);
  });
}

// ==========================================
// 4. MAIN STREAM CONTROLLER
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
  const { subjectId, id, type = 'movie', s = 1, e = 1 } = req.query;
  const targetId = subjectId || id || '8826677989518759008';
  const cacheKey = `${targetId}_${type}_${s}_${e}`;
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  // ১. মেমোরি ক্যাশ চেক
  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    return pipeMediaStream(cached.url, cached.ref, cached.cookie, res);
  }

  // ২. MovieBox ডিরেক্ট চেক
  const mboxData = await getMovieBoxStream(targetId, s, e);
  if (mboxData && mboxData.streamUrl) {
    streamCache.set(cacheKey, { url: mboxData.streamUrl, ref: 'https://tv.aoneroom.com/', cookie: mboxData.cookie, time: Date.now() });
    return pipeMediaStream(mboxData.streamUrl, 'https://tv.aoneroom.com/', mboxData.cookie, res);
  }

  // ৩. ফাস্ট ওয়েব স্ক্র্যাপার
  let browser = null;
  let finalStream = null;
  let usedUrl = '';
  const webUrls = getWebProviderUrls(targetId, s, e, type);

  try {
    browser = await getWarmBrowser();

    for (const url of webUrls) {
      finalStream = await scrapeWebStream(browser, url);
      if (finalStream) {
        usedUrl = url;
        break;
      }
    }

    if (!finalStream) {
      return res.status(404).send('Movie stream not available.');
    }

    streamCache.set(cacheKey, { url: finalStream, ref: usedUrl, cookie: '', time: Date.now() });

    if (finalStream.includes('.m3u8')) {
      const proxyTarget = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalStream)}&referer=${encodeURIComponent(usedUrl)}`;
      return res.redirect(proxyTarget);
    }

    return pipeMediaStream(finalStream, usedUrl, '', res);

  } catch (err) {
    return res.status(500).send('Streaming error: ' + err.message);
  }
});

// সরাসরি স্ট্রিম পাইপ হেল্পার
async function pipeMediaStream(streamUrl, referer, cookie, res) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };
    if (cookie) headers['Cookie'] = cookie;
    if (referer) {
      headers['Referer'] = referer;
      headers['Origin'] = new URL(referer).origin;
    }

    const streamRes = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers,
      timeout: 20000
    });

    res.set({
      'Content-Type': streamRes.headers['content-type'] || (streamUrl.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    streamRes.data.pipe(res);
  } catch (error) {
    res.status(500).send('Stream pipe error');
  }
}

// JSON API
app.get('/api/get-stream', async (req, res) => {
  const { id = '550', type = 'movie', s = 1, e = 1 } = req.query;
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    success: true,
    id,
    type,
    directStreamUrl: `${hostUrl}/api/moviebox/play?id=${id}&type=${type}&s=${s}&e=${e}`
  });
});

// CDN প্রক্সি
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer, cookie } = req.query;
  if (!url) return res.status(400).send('URL missing');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;

    const response = await axios({
      method: 'GET',
      url: target,
      responseType: 'stream',
      headers: {
        'Cookie': cookie ? decodeURIComponent(cookie) : '',
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 20000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || (target.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

app.get('/', (req, res) => res.send('🚀 Turbo 2s Ultra Fast Scraper Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
