const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. MOVIEBOX OFFICIAL NATIVE ENGINE
// ==========================================
const MBOX_BASE = 'https://tv.aoneroom.com';
const APP_KEY = '50040011';
const SECRET = 'd2a8141bcc71715a997c2f34ae3bad3a';

function getMboxSign(params = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sortedKeys = Object.keys(params).sort();
  let str = '';
  for (const k of sortedKeys) {
    if (params[k] !== undefined && params[k] !== null) {
      str += `${k}=${params[k]}&`;
    }
  }
  str += `key=${SECRET}&time=${ts}`;
  const sign = crypto.createHash('md5').update(str).digest('hex');
  return { sign, ts };
}

const NATIVE_HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream',
  'X-Client-Info': JSON.stringify({
    package_name: "com.community.mbox.tv",
    version_name: "1.1.6.0723.03",
    version_code: 50040011,
    os: "android",
    brand: "Redmi"
  })
};

let cachedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

// ১. মুভির নাম দিয়ে MovieBox Subject ID সার্চ
async function searchMovieBox(query) {
  try {
    const { sign, ts } = getMboxSign({ keyword: query, page: 1, perPage: 10 });
    const res = await axios.get(`${MBOX_BASE}/wefeed-tv-bff/search/result`, {
      params: { keyword: query, page: 1, perPage: 10 },
      headers: {
        ...NATIVE_HEADERS,
        'Authorization': `Bearer ${cachedToken}`,
        'X-Sign': sign,
        'X-Time': ts
      },
      timeout: 7000
    });

    const items = res.data?.data?.items || [];
    if (items.length > 0) {
      return {
        subjectId: items[0].subjectId,
        title: items[0].title
      };
    }
  } catch (err) {
    console.error('MovieBox Search Fallback:', err.message);
  }
  return null;
}

// ২. Subject ID দিয়ে রিয়েল স্ট্রিম ও কুকি বের করা
async function getMovieBoxStream(subjectId, se = 0, ep = 0) {
  const { sign, ts } = getMboxSign({ subjectId, se, ep });
  const res = await axios.get(`${MBOX_BASE}/wefeed-tv-bff/subject/play-info`, {
    params: { subjectId, se, ep },
    headers: {
      ...NATIVE_HEADERS,
      'Authorization': `Bearer ${cachedToken}`,
      'X-Sign': sign,
      'X-Time': ts
    },
    timeout: 8000
  });

  const data = res.data?.data;
  if (!data) return null;

  const mp4Url = data.resources?.[0]?.url;
  const dash = data.streams?.[0];

  return {
    title: data.title,
    streamTarget: dash?.url || mp4Url,
    cookie: dash?.signCookie || ''
  };
}

// ==========================================
// 2. DIRECT BROWSER STREAM & PIPING ENGINE
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
  let { title, subjectId, id, se = 0, ep = 0 } = req.query;

  try {
    // যদি আইডি না থাকে, নাম দিয়ে খুঁজে বের করবে
    if (!subjectId && title) {
      const found = await searchMovieBox(title);
      if (found) {
        subjectId = found.subjectId;
      }
    }

    // ডিফল্ট ডেমো সাবজেক্ট আইডি (The Odyssey / 2026 মুভি ফলব্যাক)
    if (!subjectId && !title) {
      subjectId = '8826677989518759008';
    }

    let streamData = null;
    if (subjectId) {
      streamData = await getMovieBoxStream(subjectId, se, ep);
    }

    if (!streamData || !streamData.streamTarget) {
      return res.status(404).send(`Video stream could not be loaded for: ${title || subjectId}`);
    }

    // সরাসরি ক্লাউডফ্রন্ট সিকিউরিটি বাইপাস করে ভিডিও পাইপ করা
    const videoPipe = await axios({
      method: 'GET',
      url: streamData.streamTarget,
      responseType: 'stream',
      headers: {
        'Cookie': streamData.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 20000
    });

    res.set({
      'Content-Type': videoPipe.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    videoPipe.data.pipe(res);

  } catch (err) {
    res.status(500).send('Streaming Engine Error: ' + err.message);
  }
});

// JSON এন্ডপয়েন্ট
app.get('/api/moviebox', async (req, res) => {
  const { title = 'The Odyssey', subjectId } = req.query;
  const host = `${req.protocol}://${req.get('host')}`;
  
  res.json({
    success: true,
    server: 'MovieBox Official Stream Engine',
    directPlayerUrl: `${host}/api/moviebox/play?${subjectId ? `subjectId=${subjectId}` : `title=${encodeURIComponent(title)}`}`
  });
});

// লাইভ হেলথ চেক
app.get('/', (req, res) => {
  res.send('🎬 MovieBox Official Universal Engine is Live!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Scraper Server Online on ${PORT}`));
