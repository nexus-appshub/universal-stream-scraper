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
// 1. INSTANT STREAM CACHE
// ==========================================
const streamCache = new Map();
const CACHE_TTL = 3 * 60 * 60 * 1000;

// ==========================================
// 2. WARM BROWSER POOL
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
    isTv ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`,
    isTv ? `https://vidrock.net/embed/tv/${id}/${s}/${e}` : `https://vidrock.net/embed/movie/${id}`
  ];
}

async function fastScrape(browser, targetUrl) {
  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    if (
      ['image', 'stylesheet', 'font'].includes(type) ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
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
    }, 5000);
  });
}

// ==========================================
// 3. MAIN DIRECT STREAM PIPELINE (HLS PLAYER EMBEDDED)
// ==========================================
app.get('/api/moviebox/play', async (req, res) => {
  const { id = '27205', type = 'movie', s = 1, e = 1, raw } = req.query;
  const cacheKey = `${id}_${type}_${s}_${e}`;
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  let streamUrl = null;
  let usedUrl = '';

  // ১. মেমোরি ক্যাশ চেক
  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    streamUrl = cached.url;
    usedUrl = cached.ref;
  } else {
    // ২. ফাস্ট স্ক্র্যাপ
    try {
      const browser = await getWarmBrowser();
      const webUrls = getWebProviderUrls(id, s, e, type);

      for (const url of webUrls) {
        streamUrl = await fastScrape(browser, url);
        if (streamUrl) {
          usedUrl = url;
          break;
        }
      }

      if (streamUrl) {
        streamCache.set(cacheKey, { url: streamUrl, ref: usedUrl, time: Date.now() });
      }
    } catch (err) {
      return res.status(500).send('Scraper Error: ' + err.message);
    }
  }

  if (!streamUrl) {
    return res.status(404).send('Movie stream currently offline. Please retry.');
  }

  const proxyStreamUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(usedUrl)}`;

  // Android অ্যাপ যদি raw stream চায়
  if (raw === 'true') {
    return res.redirect(proxyStreamUrl);
  }

  // ডেস্কটপ/মোবাইল ব্রাউজারের জন্য সরাসরি বিল্ট-ইন প্রিমিয়াম 4K Hls.js প্লেয়ার
  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Home Air Cinema Player</title>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        video { width: 100%; height: 100%; object-fit: contain; }
      </style>
    </head>
    <body>
      <video id="player" controls autoplay playsinline></video>
      <script>
        const video = document.getElementById('player');
        const streamUrl = '${proxyStreamUrl}';

        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.loadSource(streamUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = streamUrl;
          video.addEventListener('loadedmetadata', () => video.play());
        } else {
          video.src = streamUrl;
        }
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// 4. TS SEGMENT RE-WRITING STREAM PROXY
// ==========================================
app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');

  try {
    const target = decodeURIComponent(url);
    const domain = new URL(target).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;

    const response = await axios({
      method: 'GET',
      url: target,
      responseType: target.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });

    // m3u8 ফাইলের ভেতরের TS সেগমেন্টগুলো রি-রাইট করা যাতে 403 ব্লক না হয়
    if (target.includes('.m3u8')) {
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const segmentUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          return `${req.protocol}://${req.get('host')}/api/stream-proxy?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        }
        return line;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy Segment Error');
  }
});

app.get('/', (req, res) => res.send('🚀 Home Air Video Core Active!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Active on ${PORT}`));
