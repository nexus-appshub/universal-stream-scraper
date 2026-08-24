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
// 1. MOVIEBOX FULL AUTH & HEADERS
// ==========================================
const MBOX_HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Build': '1787583110033868490.2da8141bcc71715a997c2f34ae3bad3a-1787582559504118222.61ede1b697ede0681bcf08de51af83f6',
  'X-Client-Info': JSON.stringify({
    package_name: "com.community.mbox.tv",
    version_name: "1.1.6.0723.03",
    version_code: 50040011,
    os: "android",
    os_version: "9",
    install_ch: "google-play",
    device_id: "501f992004b12de5c061c895d82502d7",
    brand: "Redmi",
    model: "23078RKD5C",
    system_language: "en",
    net: "NETWORK_WIFI",
    timezone: "Asia/Dhaka",
    country_iso_code: "US"
  }),
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream',
  'X-Family-Mode': '0',
  'X-Idle-Data': '1'
};

let cachedMboxToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

// অটোমেটিক ভিজিটর লগইন
async function getFreshMboxToken() {
  try {
    const res = await axios.post('https://tv.aoneroom.com/wefeed-tv-bff/user/visitor-login', {}, {
      headers: MBOX_HEADERS,
      timeout: 5000
    });
    if (res.data?.data?.token) {
      cachedMboxToken = res.data.data.token;
    }
  } catch (err) {}
  return cachedMboxToken;
}

// 🟢 সরাসরি ভিডিও প্লে করার ডিরেক্ট স্ট্রিম এন্ডপয়েন্ট
app.get('/api/moviebox/play', async (req, res) => {
  const { subjectId = '8826677989518759008', se = 0, ep = 0 } = req.query;

  try {
    const token = await getFreshMboxToken();

    // প্লে ইনফো কল
    const response = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${token}`
      },
      timeout: 10000
    });

    const data = response.data?.data;
    const mp4Url = data?.resources?.[0]?.url;
    const dashUrl = data?.streams?.[0]?.url;
    const signCookie = data?.streams?.[0]?.signCookie || '';
    const videoTarget = mp4Url || dashUrl;

    if (!videoTarget) {
      return res.status(404).send('No streaming stream found for this movie');
    }

    // সরাসরি ক্লাউডফ্রন্ট বাইপাস করে ভিডিও স্ট্রিম পাইপ করা
    const streamRes = await axios({
      method: 'GET',
      url: videoTarget,
      responseType: 'stream',
      headers: {
        'Cookie': signCookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    res.set({
      'Content-Type': streamRes.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    streamRes.data.pipe(res);

  } catch (err) {
    res.status(500).send('Streaming error: ' + (err.response?.data?.message || err.message));
  }
});

// ==========================================
// 2. UNIVERSAL CDN / STREAM PROXY PIPE
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
      timeout: 15000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'CDN Proxy Pipe Failed', message: error.message });
  }
});

// ==========================================
// 3. TMDB SCRAPER ENDPOINT (Vidnest/Vidrock)
// ==========================================
function resolveProviderUrl(provider, id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  switch (provider.toLowerCase()) {
    case 'vidnest':
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
    case 'vidrock':
      return isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`;
    default:
      return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
  }
}

app.get('/api/get-stream', async (req, res) => {
  const { provider = 'vidnest', id, s = 1, e = 1, type = 'movie' } = req.query;

  if (!id) return res.status(400).json({ success: false, error: 'Media ID is required' });

  const targetUrl = resolveProviderUrl(provider, id, s, e, type);
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    let streamUrl = null;

    page.on('response', async (response) => {
      const u = response.url();
      if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('analytics') && !u.includes('doubleclick')) {
        streamUrl = u;
      }
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    
    let waitTime = 0;
    while (!streamUrl && waitTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (streamUrl) {
      return res.json({
        success: true,
        streamUrl,
        proxyStreamUrl: `/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`
      });
    } else {
      return res.status(404).json({ success: false, embedUrl: targetUrl });
    }
  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('⚡ MovieBox Direct Video Engine Active'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on port ${PORT}`));
