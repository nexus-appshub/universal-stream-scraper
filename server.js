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
app.set('trust proxy', 1);

const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">মূল সমস্যাটা হচ্ছে **৩টি জায়গায়**:

1. **অটোমেটিক ফ্রেম লোডিং ও বাটন ক্লিক ফেইলিওর:** VidLink, VidSrc, Vidnest-এর মতো বেশিরভাগ আধুনিক প্রোভাইডার ক্লাউডফ্লেয়ার বা নেস্টেড আইফ্রেম (`iframe`) ব্যবহার করে। আপনার স্ক্রিপ্ট মাত্র ৫ সেকেন্ড অপেক্ষা করে এবং আইফ্রেম লোড হওয়ার আগেই টাইমআউট হয়ে যাচ্ছিল। 
2. **ডাইরেক্ট API/হাইডেন ডিক্রিপশন রিকোয়েস্ট মিসিং:** আধুনিক প্লেয়ারগুলো শুধু `.m3u8` লোড করে না, অনেক সময় পেজের ভেতরের API/WebSocket বা JSON রেসপন্স থেকে স্ট্রিম লিংক জেনারেট করে।
3. **M3U8 রি-রাইট হেডার সমস্যা:** M3U8 মেনিফেস্ট থেকে সেগমেন্ট রুট করার সময় সঠিক `Origin`, `Accept`, ও রিলেটিভ পাথ মিস হচ্ছিল যার কারণে ব্রাউজারে শুধু ইনফিনিট লোডার ঘুরতে থাকে।

এই আপডেটেড কোডে **কাস্টম নেভিগেশন ওয়েটার**, **সব আইফ্রেমের ডিপ-ইনস্পেকশন**, **ফাস্ট-ফেইল ব্যাকআপ** এবং **ফুল রিলায়েবল প্রক্সি টানেল** যোগ করে দেওয়া হয়েছে।

```javascript
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
app.set('trust proxy', 1);

const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Access Denied - HOME AIR TV</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Poppins', sans-serif; }
    body { background: #0b0c10; min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; padding: 20px; text-align: center; }
    .card { background: #151821; border: 1px solid #ff5500; border-radius: 24px; padding: 40px; max-width: 440px; width: 100%; box-shadow: 0 10px 40px rgba(255,85,0,0.2); }
    h2 { font-size: 24px; color: #ff5500; margin-bottom: 12px; }
    p { font-size: 14px; color: #8c93a8; margin-bottom: 24px; line-height: 1.6; }
    a { display: block; background: linear-gradient(135deg, #ff8800, #ff4500); color: #fff; text-decoration: none; padding: 14px; border-radius: 12px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚫 Protected Stream</h2>
    <p>Direct unauthorized hotlinking is restricted. Stream directly through the official media platform.</p>
    <a href="[https://2.0.hmair.xyz](https://2.0.hmair.xyz)">Open Official Platform</a>
  </div>
</body>
</html>`;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const memoryCache = new Map();
const activeResolutions = new Map();
let clusterBrowser = null;

async function getClusterBrowser() {
  if (clusterBrowser && clusterBrowser.isConnected()) return clusterBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cluster-'));
  clusterBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts'
    ]
  });
  return clusterBrowser;
}

getClusterBrowser().catch(() => {});

function getGlobalProviders(params) {
  const { id, isTv, season, episode } = params;
  if (isTv) {
    return [
      { name: 'VidSrc.sbs', url: `[https://vidsrc.sbs/embed/tv/$](https://vidsrc.sbs/embed/tv/$){id}/${season}/${episode}` },
      { name: 'VidLink', url: `[https://vidlink.pro/tv/$](https://vidlink.pro/tv/$){id}/${season}/${episode}` },
      { name: 'Vidnest', url: `[https://vidnest.fun/tv/$](https://vidnest.fun/tv/$){id}/${season}/${episode}` },
      { name: 'Videasy', url: `[https://player.videasy.net/tv/$](https://player.videasy.net/tv/$){id}/${season}/${episode}` },
      { name: 'VidRock', url: `[https://vidrock.net/embed/tv/$](https://vidrock.net/embed/tv/$){id}/${season}/${episode}` },
      { name: 'AutoEmbed', url: `[https://player.autoembed.cc/embed/tv/$](https://player.autoembed.cc/embed/tv/$){id}/${season}/${episode}` }
    ];
  }

  return [
    { name: 'VidSrc.sbs', url: `[https://vidsrc.sbs/embed/movie/$](https://vidsrc.sbs/embed/movie/$){id}` },
    { name: 'VidLink', url: `[https://vidlink.pro/movie/$](https://vidlink.pro/movie/$){id}` },
    { name: 'Vidnest', url: `[https://vidnest.fun/movie/$](https://vidnest.fun/movie/$){id}` },
    { name: 'Videasy', url: `[https://player.videasy.net/movie/$](https://player.videasy.net/movie/$){id}` },
    { name: 'VidRock', url: `[https://vidrock.net/embed/movie/$](https://vidrock.net/embed/movie/$){id}` },
    { name: 'AutoEmbed', url: `[https://player.autoembed.cc/embed/movie/$](https://player.autoembed.cc/embed/movie/$){id}` }
  ];
}

async function executeTargetScrape(browser, provider) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url().toLowerCase();
      if (['image', 'font', 'stylesheet'].includes(type) || url.includes('analytics') || url.includes('google-analytics') || url.includes('clarity')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    return await new Promise((resolve) => {
      let resolved = false;

      const finish = async (result) => {
        if (!resolved) {
          resolved = true;
          if (page) await page.close().catch(() => {});
          resolve(result);
        }
      };

      page.on('response', async (response) => {
        const u = response.url();
        const lowerU = u.toLowerCase();
        
        const isMedia = (lowerU.includes('.m3u8') || lowerU.includes('/master.m3u8') || lowerU.includes('/index.m3u8') || lowerU.includes('/hls/') || (lowerU.includes('.mp4') && !lowerU.includes('google'))) &&
                        !lowerU.includes('demo') && !lowerU.includes('trailer') && !lowerU.includes('preview');

        if (isMedia && !resolved) {
          await finish({ streamUrl: u, usedUrl: provider.url, providerName: provider.name });
        }
      });

      page.goto(provider.url, { waitUntil: 'networkidle2', timeout: 12000 })
        .then(async () => {
          if (resolved) return;
          const frames = [page.mainFrame(), ...page.frames()];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const selectors = ['video', 'button', '#play', '.play-btn', '.jw-display-icon-container', '.vjs-big-play-button', '[class*="play"]', '.vidsrc-stream'];
                selectors.forEach(s => {
                  document.querySelectorAll(s).forEach(el => el.click());
                });
              });
            } catch (e) {}
          }
        })
        .catch(() => {});

      setTimeout(() => {
        finish(null);
      }, 9000);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

async function raceAllProviders(browser, providers) {
  for (let i = 0; i < providers.length; i += 2) {
    const batch = providers.slice(i, i + 2);
    const results = await Promise.all(batch.map(p => executeTargetScrape(browser, p)));
    const winner = results.find(r => r !== null);
    if (winner) return winner;
  }
  return null;
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || '640146';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const isTv = typeStr === 'tv' || typeStr === 'series';
  const season = parseInt(query.s || query.season || 1);
  const episode = parseInt(query.e || query.episode || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();

  return { id: targetId, typeStr, isTv, season, episode, lang };
}

app.get('/api/resolve-stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;

  if (memoryCache.has(cacheKey)) {
    const cached = memoryCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      provider: cached.provider,
      type: params.typeStr
    });
  }

  if (activeResolutions.has(cacheKey)) {
    try {
      const result = await activeResolutions.get(cacheKey);
      if (result) {
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          rawUrl: result.url,
          provider: result.provider,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  const scrapeTask = (async () => {
    try {
      const browser = await getClusterBrowser();
      const providers = getGlobalProviders(params);
      const result = await raceAllProviders(browser, providers);
      if (result) {
        const data = { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() };
        memoryCache.set(cacheKey, data);
        return data;
      }
      return null;
    } catch (err) {
      return null;
    } finally {
      activeResolutions.delete(cacheKey);
    }
  })();

  activeResolutions.set(cacheKey, scrapeTask);
  const finalResult = await scrapeTask;

  if (finalResult) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      rawUrl: finalResult.url,
      provider: finalResult.provider,
      type: params.typeStr
    });
  }

  const fallbackEmbed = params.isTv 
    ? `[https://vidsrc.sbs/embed/tv/$](https://vidsrc.sbs/embed/tv/$){params.id}/${params.season}/${params.episode}`
    : `[https://vidsrc.sbs/embed/movie/$](https://vidsrc.sbs/embed/movie/$){params.id}`;

  return res.json({
    success: true,
    isEmbed: true,
    streamUrl: fallbackEmbed,
    embedUrl: fallbackEmbed,
    type: params.typeStr
  });
});

async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    let cleanUrl = targetUrl;
    while (cleanUrl.includes('%3A') || cleanUrl.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(cleanUrl);
        if (decoded === cleanUrl) break;
        cleanUrl = decoded;
      } catch (e) {
        break;
      }
    }

    const domain = new URL(cleanUrl).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.get('host');
    const proxyBase = `${protocol}://${host}/api/stream-proxy`;

    const requestHeaders = {
      'Referer': ref,
      'Origin': ref.replace(/\/$/, ''),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };

    if (req.headers['range']) {
      requestHeaders['Range'] = req.headers['range'];
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: cleanUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: requestHeaders,
      timeout: 25000
    });

    if (cleanUrl.includes('.m3u8') || (typeof response.data === 'string' && response.data.includes('#EXTM3U'))) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                let absUrl = p1;
                if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) {
                  absUrl = new URL(p1, baseUrl).href;
                }
                return `URI="${proxyBase}?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(ref)}"`;
              } catch {
                return match;
              }
            });
          }
          return line;
        }

        try {
          let segmentUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            segmentUrl = new URL(trimmed, baseUrl).href;
          }
          return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        } catch {
          return line;
        }
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      return res.send(rewritten);
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    if (response.headers['content-range']) {
      res.set('Content-Range', response.headers['content-range']);
      res.status(206);
    }

    response.data.pipe(res);
  } catch (error) {
    res.status(502).send('Stream Tunnel Error');
  }
}

app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/api/moviebox/play', async (req, res) => {
  const params = parseParams(req.query);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;
  let cached = memoryCache.get(cacheKey);

  if (cached) {
    return pipeMediaTunnel(req, res, cached.url, cached.ref);
  }

  try {
    const browser = await getClusterBrowser();
    const providers = getGlobalProviders(params);
    const result = await raceAllProviders(browser, providers);
    if (result) {
      memoryCache.set(cacheKey, { url: result.streamUrl, ref: result.usedUrl, provider: result.providerName, time: Date.now() });
      return pipeMediaTunnel(req, res, result.streamUrl, result.usedUrl);
    }
  } catch (e) {}

  return res.status(404).send('Stream Offline');
});

app.get('/', (req, res) => res.send('🚀 Home Air Ultra Scraper Core Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Ultra Engine Active on ${PORT}`));
