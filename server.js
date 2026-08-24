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
// 1. MOVIEBOX ENGINE CONFIG
// ==========================================
const MBOX_HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream'
};

let cachedMboxToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

// অটোমেটিক টোকেন জেনারেটর
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

// মুভির নাম দিয়ে সার্চ
async function searchMovieBoxSubjectId(keyword, token) {
  try {
    const res = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/search/result', {
      params: { keyword, page: 1, perPage: 10 },
      headers: { ...MBOX_HEADERS, 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });
    const items = res.data?.data?.items || [];
    if (items.length > 0) {
      return items[0].subjectId;
    }
  } catch (err) {}
  return null;
}

// 🟢 সরাসরি ব্রাউজারে ভিডিও প্লে করার মেইন রুট (Direct Video Stream)
app.get('/api/moviebox/play', async (req, res) => {
  let { subjectId, title, se = 0, ep = 0 } = req.query;

  try {
    const token = await getFreshMboxToken();

    if (!subjectId && title) {
      subjectId = await searchMovieBoxSubjectId(title, token);
    }

    if (!subjectId) {
      return res.status(400).send('Movie subjectId or valid title required');
    }

    // MovieBox থেকে লাইভ প্লে ইনফো আনা
    const response = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: { ...MBOX_HEADERS, 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });

    const data = response.data?.data;
    const mp4Url = data?.resources?.[0]?.url;
    const dashUrl = data?.streams?.[0]?.url;
    const signCookie = data?.streams?.[0]?.signCookie || '';
    const videoTarget = mp4Url || dashUrl;

    if (!videoTarget) {
      return res.status(404).send('Movie stream not available');
    }

    // সরাসরি ভিডিও স্ট্রিম ব্রাউজারে পাঠানো
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
    res.status(500).send('Streaming error: ' + err.message);
  }
});

// JSON API (যদি ফ্রন্টএন্ডে মেটাডেটা দরকার হয়)
app.get('/api/moviebox', async (req, res) => {
  const { subjectId, se = 0, ep = 0 } = req.query;
  if (!subjectId) return res.status(400).json({ error: 'subjectId required' });

  try {
    const token = await getFreshMboxToken();
    const response = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: { ...MBOX_HEADERS, 'Authorization': `Bearer ${token}` }
    });

    const data = response.data?.data;
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      title: data.title,
      playUrl: `${hostUrl}/api/moviebox/play?subjectId=${subjectId}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };
    if (signCookie) headers['Cookie'] = signCookie;
    if (referer) headers['Referer'] = ref;

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
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. TMDB SCRAPER ENDPOINT (Vidnest/Vidrock)
// ==========================================
function resolveProviderUrl(provider, id, s = 1, e = 1, type = 'movie') {
  const isTv = type === 'tv';
  switch (provider.toLowerCase()) {
    case 'vidnest': return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
    case 'vidrock': return isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`;
    default: return isTv ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`;
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

app.get('/', (req, res) => res.send('⚡ Stealth Scraper & MovieBox Engine Online'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Active on port ${PORT}`));
