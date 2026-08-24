const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// MovieBox হেডার কনফিগারেশন
const HEADERS = {
  'User-Agent': 'com.community.mbox.tv/50040011 (Linux; U; Android 9; en_US; 23078RKD5C; Build/PQ3B.190801.07131748; Cronet/151.0.7922.47)',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream'
};

// মেমোরিতে টোকেন ক্যাশ রাখা
let cachedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';

// ১. অটোমেটিক গেস্ট টোকেন জেনারেটর ফাংশন
async function getFreshToken() {
  try {
    const res = await axios.post('https://tv.aoneroom.com/wefeed-tv-bff/user/visitor-login', {}, {
      headers: HEADERS,
      timeout: 5000
    });
    if (res.data?.data?.token) {
      cachedToken = res.data.data.token;
    }
  } catch (err) {
    console.log('Using fallback auth token');
  }
  return cachedToken;
}

// ২. মেইন এপিআই এন্ডপয়েন্ট: মুভির ফ্রেশ স্ট্রিম ডেটা আনা
app.get('/api/moviebox', async (req, res) => {
  const { subjectId, se = 0, ep = 0 } = req.query;

  if (!subjectId) {
    return res.status(400).json({ success: false, error: 'subjectId param missing' });
  }

  try {
    const token = await getFreshToken();

    const response = await axios.get('https://tv.aoneroom.com/wefeed-tv-bff/subject/play-info', {
      params: { subjectId, se, ep },
      headers: {
        ...HEADERS,
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const data = response.data?.data;
    if (!data) {
      return res.status(404).json({ success: false, message: 'No media streams found' });
    }

    const hostUrl = `${req.protocol}://${req.get('host')}`;
    const mp4Url = data.resources?.[0]?.url;
    const dashStream = data.streams?.[0];

    // ফ্রন্টএন্ড প্লেয়ারের জন্য রেডি রেসপন্স
    res.json({
      success: true,
      title: data.title,
      // আমাদের সার্ভার দিয়ে প্রক্সি করা লিংক (যা সরাসরি প্লে হবে)
      streamUrl: `${hostUrl}/api/stream?url=${encodeURIComponent(dashStream ? dashStream.url : mp4Url)}&cookie=${encodeURIComponent(dashStream?.signCookie || '')}`,
      rawDirectMp4: mp4Url,
      dashManifest: dashStream?.url || null
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৩. লাইভ ভিডিও পাইপ প্রক্সি (CloudFront Cookie & CORS হ্যান্ডলার)
app.get('/api/stream', async (req, res) => {
  const { url, cookie } = req.query;
  if (!url) return res.status(400).send('Stream URL missing');

  try {
    const target = decodeURIComponent(url);
    const signCookie = cookie ? decodeURIComponent(cookie) : '';

    const streamResponse = await axios({
      method: 'GET',
      url: target,
      responseType: 'stream',
      headers: {
        'Cookie': signCookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    // সঠিক ভিডিও হেডার রিটার্ন করা
    res.set({
      'Content-Type': streamResponse.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    streamResponse.data.pipe(res);
  } catch (err) {
    res.status(500).send('Stream relay error');
  }
});

// হেলথ চেক রুট
app.get('/', (req, res) => {
  res.send('🎬 MovieBox API Server is Live & Running!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
