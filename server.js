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
// 1. MOVIEBOX AUTO SEARCH & STREAM ENGINE
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
  } catch (err) {
    // fallback to cache
  }
  return cachedMboxToken;
}

// মুভির নাম দিয়ে স্বয়ংক্রিয়ভাবে MovieBox-এ সার্চ করা (/search/result)
async function searchMovieBoxSubjectId(keyword, token) {
  try {
    const res = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/search/result', {
      params: {
        keyword: keyword,
        page: 1,
        perPage: 10
      },
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const items = res.data?.data?.items || [];
    if (items.length > 0) {
      return {
        subjectId: items[0].subjectId,
        title: items[0].title
      };
    }
  } catch (err) {
    console.error('MovieBox Search Error:', err.message);
  }
  return null;
}

// মেইন MovieBox API (subjectId অথবা title যেকোনো একটি দিলেই কাজ করবে)
app.get('/api/moviebox', async (req, res) => {
  let { subjectId, title, se = 0, ep = 0 } = req.query;

  try {
    const token = await getFreshMboxToken();

    // যদি subjectId না থাকে কিন্তু মুভির নাম (title) থাকে, তবে অটো সার্চ করবে
    if (!subjectId && title) {
      const searchResult = await searchMovieBoxSubjectId(title, token);
      if (searchResult) {
        subjectId = searchResult.subjectId;
      } else {
        return res.status(404).json({ success: false, message: `No movie found for title: "${title}"` });
      }
    }

    if (!subjectId) {
      return res.status(400).json({ success: false, error: 'Either "subjectId" or "title" is required' });
    }

    // প্লে-ইনফো কল করা
    const response = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const data = response.data?.data;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Stream not found' });
    }

    const hostUrl = `${req.protocol}://${req.get('host')}`;
    const mp4Url = data.resources?.[0]?.url;
    const dashStream = data.streams?.[0];

    return res.json({
      success: true,
      title: data.title,
      subjectId: subjectId,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(dashStream ? dashStream.url : mp4Url)}&cookie=${encodeURIComponent(dashStream?.signCookie || '')}`,
      rawDirectMp4: mp4Url,
      dashManifest: dashStream?.url || null,
      resources: data.resources || []
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. UNIVERSAL WEB SCRAPPER CONFIG
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
  res.send('⚡ Stealth Scraper & MovieBox Auto Engine Online');
});

// ==========================================
// 3. UNIVERSAL CDN / STREAM PROXY PIPE
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
// 4. WEB PUPPETEER SCRAPER ENDPOINT
// ==========================================
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
    } catch (e) {}

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
app.listen(PORT, () => console.log(`🚀 Universal Engine Active on port ${PORT}`));
