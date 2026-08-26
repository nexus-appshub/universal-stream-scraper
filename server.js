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

// ফুল ওপেন CORS যাতে ব্রাউজার কোনো সেগমেন্ট ব্লক না করে
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ব্রাউজার পুল
class FastBrowserPool {
  constructor() {
    this.browser = null;
    this.launching = null;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-cluster-'));
      this.browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        userDataDir: tempDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--disable-web-security',
          '--blink-settings=imagesEnabled=false',
          '--disable-remote-fonts',
          '--mute-audio'
        ]
      });
      this.launching = null;
      return this.browser;
    })();

    return this.launching;
  }
}

const pool = new FastBrowserPool();
pool.getBrowser().catch(() => {});

const streamCache = new Map();
const pendingResolvers = new Map();

// মাল্টি-প্রোভাইডার রেজিস্ট্রি
const PROVIDERS = [
  {
    name: 'Vidnest',
    buildUrl: (p) => p.isTv ? `https://vidnest.fun/tv/${p.id}/${p.s}/${p.e}` : `https://vidnest.fun/movie/${p.id}`,
    referer: 'https://vidnest.fun/'
  },
  {
    name: 'VidRock',
    buildUrl: (p) => p.isTv ? `https://vidrock.net/embed/tv/${p.id}/${p.s}/${p.e}` : `https://vidrock.net/embed/movie/${p.id}`,
    referer: 'https://vidrock.net/'
  },
  {
    name: 'AutoEmbed',
    buildUrl: (p) => p.isTv ? `https://player.autoembed.cc/embed/tv/${p.id}/${p.s}/${p.e}` : `https://player.autoembed.cc/embed/movie/${p.id}`,
    referer: 'https://autoembed.cc/'
  },
  {
    name: 'VidLink',
    buildUrl: (p) => p.isTv ? `https://vidlink.pro/tv/${p.id}/${p.s}/${p.e}` : `https://vidlink.pro/movie/${p.id}`,
    referer: 'https://vidlink.pro/'
  }
];

async function fastBrowserScrape(browser, targetUrl, referer) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    return await new Promise((resolve, reject) => {
      let resolved = false;

      const finish = (url) => {
        if (!resolved) {
          resolved = true;
          page.close().catch(() => {});
          resolve({ streamUrl: url, referer });
        }
      };

      const checkUrl = (u) => {
        const lower = u.toLowerCase();
        if (
          (lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('nasty.m3u8')) &&
          !lower.includes('trailer') && !lower.includes('preview')
        ) {
          finish(u);
        }
      };

      page.on('request', (req) => {
        const type = req.resourceType();
        const u = req.url();
        checkUrl(u);

        if (['image', 'font', 'stylesheet', 'media'].includes(type) || u.includes('analytics') || u.includes('ads')) {
          req.abort();
        } else {
          req.continue();
        }
      });

      page.on('response', (res) => checkUrl(res.url()));

      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 6000 })
        .then(async () => {
          if (resolved) return;
          const frames = [page.mainFrame(), ...page.frames()];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const el = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container, [class*="play"]');
                if (el) el.click();
              });
            } catch (e) {}
          }
        })
        .catch(() => {});

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          page.close().catch(() => {});
          reject(new Error('Timeout on ' + targetUrl));
        }
      }, 5000);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    throw err;
  }
}

async function resolveFastestStream(params) {
  const browser = await pool.getBrowser();
  const raceTasks = PROVIDERS.map(p => fastBrowserScrape(browser, p.buildUrl(params), p.referer));
  try {
    return await Promise.any(raceTasks);
  } catch (err) {
    return null;
  }
}

// মিডিয়া টানেল প্রক্সি (M3U8 / AES Key / Media Track Rewriter)
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    let cleanUrl = targetUrl;
    while (cleanUrl.includes('%3A') || cleanUrl.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(cleanUrl);
        if (decoded === cleanUrl) break;
        cleanUrl = decoded;
      } catch (e) { break; }
    }

    const domain = new URL(cleanUrl).origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const proxyBase = `${protocol}://${host}/api/stream-proxy`;

    const isHls = cleanUrl.includes('.m3u8') || req.query.type === 'm3u8';

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: isHls ? 'text' : 'stream',
      headers: {
        'Referer': ref,
        'Origin': ref.replace(/\/$/, ''),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 25000
    });

    if (isHls || (typeof response.data === 'string' && response.data.includes('#EXTM3U'))) {
      const baseUrl = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);
      const lines = response.data.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // AES-128 এনক্রিপশন কী ও ট্র্যাক রিরাইট
        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, keyUrl) => {
              let abs = keyUrl.startsWith('http') ? keyUrl : new URL(keyUrl, baseUrl).href;
              return `URI="${proxyBase}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(ref)}"`;
            });
          }
          return line;
        }

        // সেগমেন্ট রিরাইট
        let seg = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
        return `${proxyBase}?url=${encodeURIComponent(seg)}&referer=${encodeURIComponent(ref)}`;
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

    response.data.pipe(res);
  } catch (error) {
    res.status(502).send('Gateway Error: Unreachable Stream');
  }
}

// API Routes
app.get('/api/resolve-stream', async (req, res) => {
  const { id, s = 1, e = 1, type = 'movie' } = req.query;

  if (!id) return res.status(400).json({ success: false, error: 'TMDB ID required' });

  const params = {
    id: id.toString(),
    isTv: type.toLowerCase() === 'tv' || type.toLowerCase() === 'series',
    s: parseInt(s, 10) || 1,
    e: parseInt(e, 10) || 1,
    type: type.toLowerCase()
  };

  const cacheKey = `stream_${params.id}_${params.type}_${params.s}_${params.e}`;
  const hostUrl = `${req.protocol}://${req.get('host')}`;

  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.streamUrl)}&referer=${encodeURIComponent(cached.referer)}`,
      rawUrl: cached.streamUrl,
      cached: true,
      type: params.type
    });
  }

  if (pendingResolvers.has(cacheKey)) {
    const result = await pendingResolvers.get(cacheKey);
    if (result) {
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
        rawUrl: result.streamUrl,
        type: params.type
      });
    }
  }

  const task = resolveFastestStream(params);
  pendingResolvers.set(cacheKey, task);

  const finalResult = await task;
  pendingResolvers.delete(cacheKey);

  if (finalResult && finalResult.streamUrl) {
    streamCache.set(cacheKey, finalResult);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.streamUrl)}&referer=${encodeURIComponent(finalResult.referer)}`,
      rawUrl: finalResult.streamUrl,
      cached: false,
      type: params.type
    });
  }

  const fallbackEmbed = params.isTv
    ? `https://player.autoembed.cc/embed/tv/${params.id}/${params.s}/${params.e}`
    : `https://player.autoembed.cc/embed/movie/${params.id}`;

  return res.json({
    success: true,
    isEmbed: true,
    streamUrl: fallbackEmbed,
    embedUrl: fallbackEmbed,
    type: params.type
  });
});

app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/', (req, res) => res.send('⚡ Native Stream Engine Running.'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Engine online on port ${PORT}`));
