const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.set('trust proxy', 1);

// ============================================================================
// ১. সিকিউরিটি ও মিডলওয়্যার কনফিগারেশন
// ============================================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));

const ALLOWED_ORIGINS = [
  'https://homeairtv.xubilaswebdevcorp.shop',
  'https://anime.hmair.xyz',
  'https://hmair.xyz',
  'https://www.hmair.xyz',
  'https://2.0.hmair.xyz',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || origin.includes('xubilas') || origin.includes('hmair')) {
      return callback(null, true);
    }
    return callback(new Error('Access Denied: Hotlinking Prohibited'));
  },
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: '*'
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// ============================================================================
// ২. হাই-পারফরম্যান্স ব্রাউজার পুল ও লাইফসাইকেল কন্ট্রোলার
// ============================================================================
class BrowserPool {
  constructor() {
    this.browser = null;
    this.isLaunching = false;
    this.launchPromise = null;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.isLaunching) {
      return this.launchPromise;
    }

    this.isLaunching = true;
    this.launchPromise = (async () => {
      try {
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
            '--disable-features=IsolateOrigins,site-per-process',
            '--blink-settings=imagesEnabled=false',
            '--disable-remote-fonts',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--mute-audio'
          ]
        });

        this.browser.on('disconnected', () => {
          this.browser = null;
        });

        return this.browser;
      } finally {
        this.isLaunching = false;
      }
    })();

    return this.launchPromise;
  }

  async createStealthPage() {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url().toLowerCase();

      if (
        ['image', 'font', 'stylesheet', 'media'].includes(resourceType) ||
        url.includes('google-analytics') ||
        url.includes('doubleclick') ||
        url.includes('adsystem') ||
        url.includes('popunder') ||
        url.includes('histats')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    return page;
  }
}

const pool = new BrowserPool();

// ============================================================================
// ৩. ইন-মেমোরি LRU ক্যাশিং এবং রিকোয়েস্ট ডি-ডুপ্লিকেশন
// ============================================================================
class StreamCacheManager {
  constructor(ttl = 12 * 60 * 60 * 1000) {
    this.cache = new Map();
    this.ttl = ttl;
    this.pendingResolvers = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.time > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item;
  }

  set(key, data) {
    this.cache.set(key, { ...data, time: Date.now() });
    if (this.cache.size > 2000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async executeDeduplicated(key, taskFn) {
    if (this.pendingResolvers.has(key)) {
      return this.pendingResolvers.get(key);
    }

    const taskPromise = (async () => {
      try {
        return await taskFn();
      } finally {
        this.pendingResolvers.delete(key);
      }
    })();

    this.pendingResolvers.set(key, taskPromise);
    return taskPromise;
  }
}

const streamCache = new StreamCacheManager();

// ============================================================================
// ৪. মাল্টি-প্রোভাইডার স্ক্র্যাপিং ইঞ্জিন (Race + Fallback Strategy)
// ============================================================================
const PROVIDER_REGISTRY = [
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
  },
  {
    name: 'VidSrcSBS',
    buildUrl: (p) => p.isTv ? `https://vidsrc.sbs/embed/tv/${p.id}/${p.s}/${p.e}` : `https://vidsrc.sbs/embed/movie/${p.id}`,
    referer: 'https://vidsrc.sbs/'
  }
];

async function executeStealthScrape(targetUrl, refererUrl, timeoutMs = 12000) {
  let page = null;
  try {
    page = await pool.createStealthPage();
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'referer': refererUrl
    });

    return await new Promise((resolve) => {
      let resolved = false;

      const evaluateStreamUrl = (u) => {
        const lower = u.toLowerCase();
        const isMediaStream = (
          lower.includes('.m3u8') ||
          lower.includes('/hls/') ||
          lower.includes('master.m3u8') ||
          lower.includes('playlist.m3u8') ||
          lower.includes('nasty.m3u8') ||
          (lower.includes('.mp4') && !lower.includes('google') && !lower.includes('trailer'))
        ) && !lower.includes('preview') && !lower.includes('demo');

        if (isMediaStream && !resolved) {
          resolved = true;
          page.close().catch(() => {});
          resolve({ streamUrl: u, referer: refererUrl });
        }
      };

      page.on('response', (res) => evaluateStreamUrl(res.url()));
      page.on('request', (req) => evaluateStreamUrl(req.url()));

      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .then(async () => {
          for (let step = 0; step < 3; step++) {
            if (resolved) break;
            const frames = [page.mainFrame(), ...page.frames()];
            for (const frame of frames) {
              try {
                await frame.evaluate(() => {
                  const selectors = ['video', 'button', '#play', '.play-btn', '.jw-display-icon-container', '.vjs-big-play-button', '[class*="play"]'];
                  document.querySelectorAll(selectors.join(',')).forEach(el => el.click());
                });
              } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 800));
          }
        })
        .catch(() => {});

      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          if (page) await page.close().catch(() => {});
          resolve(null);
        }
      }, timeoutMs);
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

async function resolveMasterStream(params) {
  for (const provider of PROVIDER_REGISTRY) {
    const targetUrl = provider.buildUrl(params);
    const result = await executeStealthScrape(targetUrl, provider.referer, 8500);
    if (result && result.streamUrl) {
      return {
        streamUrl: result.streamUrl,
        referer: provider.referer,
        provider: provider.name
      };
    }
  }
  return null;
}

// ============================================================================
// ৫. অ্যাডভান্সড মিডিয়া টানেল প্রক্সি (HLS Playlist, AES-128 & Chunk Rewriter)
// ============================================================================
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

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // AES-128 এনক্রিপশন কী ও সাব-স্ট্রিম রিরাইট
        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, keyUrl) => {
              try {
                let absKeyUrl = keyUrl;
                if (!absKeyUrl.startsWith('http://') && !absKeyUrl.startsWith('https://')) {
                  absKeyUrl = new URL(keyUrl, baseUrl).href;
                }
                return `URI="${proxyBase}?url=${encodeURIComponent(absKeyUrl)}&referer=${encodeURIComponent(ref)}"`;
              } catch {
                return match;
              }
            });
          }
          return line;
        }

        // মিডিয়া সেগমেন্ট (.ts / .m4s / সাব-প্লেলিস্ট) প্রক্সির মাধ্যমে রিরাইট
        try {
          let segmentUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            segmentUrl = new URL(trimmed, baseUrl).href;
          }
          return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(ref)}`;
        } catch {
          return line;
        }
      });

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return res.send(rewrittenLines.join('\n'));
    }

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });

    response.data.pipe(res);
  } catch (error) {
    res.status(502).send('Gateway Stream Error: Segment Unreachable');
  }
}

// ============================================================================
// ৬. পাবলিক API এন্ডপয়েন্ট
// ============================================================================
app.get('/api/resolve-stream', async (req, res) => {
  const { id, s = 1, e = 1, type = 'movie', lang = 'sub' } = req.query;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Media TMDB ID is required.' });
  }

  const params = {
    id: id.toString(),
    isTv: type.toLowerCase() === 'tv' || type.toLowerCase() === 'series',
    s: parseInt(s, 10) || 1,
    e: parseInt(e, 10) || 1,
    type: type.toLowerCase(),
    lang: lang.toLowerCase()
  };

  const cacheKey = `stream_${params.id}_${params.type}_${params.s}_${params.e}`;
  const cached = streamCache.get(cacheKey);

  const hostUrl = `${req.protocol}://${req.get('host')}`;

  if (cached) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.streamUrl)}&referer=${encodeURIComponent(cached.referer)}`,
      rawUrl: cached.streamUrl,
      provider: cached.provider,
      cached: true,
      type: params.type
    });
  }

  try {
    const result = await streamCache.executeDeduplicated(cacheKey, async () => {
      return await resolveMasterStream(params);
    });

    if (result && result.streamUrl) {
      streamCache.set(cacheKey, result);
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(result.referer)}`,
        rawUrl: result.streamUrl,
        provider: result.provider,
        cached: false,
        type: params.type
      });
    }

    // অলটারনেটিভ ফলব্যাক এমবেড
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
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal resolver exception.' });
  }
});

app.get('/api/stream-proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Stream Target URL missing.');
  return pipeMediaTunnel(req, res, decodeURIComponent(url), referer ? decodeURIComponent(referer) : '');
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cacheSize: streamCache.cache.size
  });
});

app.get('/', (req, res) => {
  res.send('🚀 Enterprise Multi-Provider Stream Tunnel Engine Online.');
});

// ============================================================================
// ৭. প্রসেস রানার ও গ্রেসফুল শাটডাউন
// ============================================================================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`🚀 Production Server listening on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning browser pool and shutting down...');
  if (pool.browser) {
    await pool.browser.close().catch(() => {});
  }
  server.close(() => process.exit(0));
});
