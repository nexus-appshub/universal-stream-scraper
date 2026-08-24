const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. MOVIEBOX CRYPTOGRAPHIC SIGNATURE GENERATOR
// ==========================================
const GATEWAY_SECRET = Buffer.from('76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O', 'utf-8');

function generateClientToken() {
  const ts = Date.now().toString();
  const revTs = ts.split('').reverse().join('');
  const hash = crypto.createHash('md5').update(revTs).digest('hex');
  return `${ts},${hash}`;
}

function generateTrSignature(method, path, queryParams = {}, body = '') {
  const ts = Date.now().toString();

  // ১. প্যারামিটার সর্টিং
  const sortedKeys = Object.keys(queryParams).sort();
  const queryString = sortedKeys.map(k => `${k}=${queryParams[k]}`).join('&');
  const canonicalPathAndQuery = queryString ? `${path}?${queryString}` : path;

  // ২. বডি MD5
  let bodyMd5 = '';
  if (body) {
    const payloadStr = typeof body === 'object' ? JSON.stringify(body) : body.toString();
    bodyMd5 = crypto.createHash('md5').update(payloadStr.slice(0, 102400)).digest('hex');
  }

  // ৩. ক্যানোনিকাল স্ট্রিং ফরম্যাট
  const canonicalString = `${method.toUpperCase()}\n\n\n${body ? body.length : 0}\n${ts}\n${bodyMd5}\n${canonicalPathAndQuery}`;

  // ৪. HMAC-MD5 সাইন
  const hmac = crypto.createHmac('md5', GATEWAY_SECRET).update(canonicalString).digest('base64');
  return `${ts}|2|${hmac}`;
}

const MBOX_HEADERS = {
  'User-Agent': 'MovieBoxPro/16.2.1 (Android 12; Pixel 6)',
  'X-M-Version': '16.2.1',
  'X-Client-Status': '1',
  'X-Play-Mode': 'stream',
  'Accept': 'application/json'
};

let cachedMboxToken = null;

async function getFreshMboxToken() {
  if (cachedMboxToken) return cachedMboxToken;
  try {
    const path = '/wefeed-tv-bff/user/visitor-login';
    const sig = generateTrSignature('POST', path);
    const clientToken = generateClientToken();

    const res = await axios.post(`https://tv.aoneroom.com${path}`, {}, {
      headers: {
        ...MBOX_HEADERS,
        'X-Client-Token': clientToken,
        'x-tr-signature': sig
      },
      timeout: 6000
    });
    if (res.data?.data?.token) {
      cachedMboxToken = res.data.data.token;
    }
  } catch (err) {
    cachedMboxToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjYwNDk1NjQ5MTA2NjkyMzIsImV4cCI6MTc5NTM1ODUwMn0.ZKkU5-K-Hw63EHFcgUQ';
  }
  return cachedMboxToken;
}

// ==========================================
// 2. DIRECT MOVIEBOX STREAMING & PLAY ROUTE
// ==========================================

// 🟢 সরাসরি মুভি প্লে করার এন্ডপয়েন্ট (১০০% MovieBox Server)
app.get('/api/moviebox/play', async (req, res) => {
  let { subjectId = '8826677989518759008', title, se = 0, ep = 0 } = req.query;

  try {
    const token = await getFreshMboxToken();

    // ১. নাম দিয়ে MovieBox-এ সার্চ করা
    if (!subjectId && title) {
      const searchPath = '/wefeed-tv-bff/search/result';
      const searchParams = { keyword: title, page: 1, perPage: 10 };
      const searchSig = generateTrSignature('GET', searchPath, searchParams);

      const searchRes = await axios.get(`https://tv.aoneroom.com${searchPath}`, {
        params: searchParams,
        headers: {
          ...MBOX_HEADERS,
          'Authorization': `Bearer ${token}`,
          'X-Client-Token': generateClientToken(),
          'x-tr-signature': searchSig
        }
      });

      const items = searchRes.data?.data?.items || [];
      if (items.length > 0) {
        subjectId = items[0].subjectId;
      } else {
        return res.status(404).send(`Movie "${title}" not found on MovieBox`);
      }
    }

    // ২. প্লে-ইনফো ফেচ করা
    const playPath = '/wefeed-tv-bff/subject/play-info';
    const playParams = { subjectId, se, ep };
    const playSig = generateTrSignature('GET', playPath, playParams);

    const playRes = await axios.get(`https://tv.aoneroom.com${playPath}`, {
      params: playParams,
      headers: {
        ...MBOX_HEADERS,
        'Authorization': `Bearer ${token}`,
        'X-Client-Token': generateClientToken(),
        'x-tr-signature': playSig
      },
      timeout: 8000
    });

    const data = playRes.data?.data;
    const mp4Url = data?.resources?.[0]?.url;
    const dashUrl = data?.streams?.[0]?.url;
    const signCookie = data?.streams?.[0]?.signCookie || '';
    const videoTarget = mp4Url || dashUrl;

    if (!videoTarget) {
      return res.status(404).send('Movie stream not available on MovieBox servers');
    }

    // ৩. ক্লাউডফ্রন্ট কুকি বাইপাস করে সরাসরি ব্রাউজার প্লেয়ারে পাইপ করা
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
    res.status(500).send('MovieBox Direct Engine Error: ' + (err.response?.data?.message || err.message));
  }
});

// JSON API
app.get('/api/moviebox', async (req, res) => {
  const { subjectId = '8826677989518759008', title } = req.query;
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const param = title ? `title=${encodeURIComponent(title)}` : `subjectId=${subjectId}`;
  res.json({
    success: true,
    server: 'MovieBox Official Stream Engine',
    streamUrl: `${hostUrl}/api/moviebox/play?${param}`
  });
});

app.get('/', (req, res) => res.send('⚡ MovieBox Official Native Stream Engine Active!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 MovieBox Engine Active on port ${PORT}`));
