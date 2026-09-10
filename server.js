const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const fs = require('fs');
const StreamResolver = require('./StreamResolver');
const HeadlessInterceptor = require('./HeadlessInterceptor');

puppeteer.use(StealthPlugin());
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const pendingScrapes = new Map();
let globalBrowser = null;
let activeScrapesCount = 0;
const MAX_CONCURRENT_SCRAPES = 1;
const scrapeQueue = [];

function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function getWarmBrowser() {
  if (globalBrowser?.isConnected()) return globalBrowser;
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: getChromiumPath(),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-zygote', '--single-process', '--disable-extensions',
      '--blink-settings=imagesEnabled=false', '--disable-remote-fonts'
    ]
  });
  return globalBrowser;
}

function acquireScrapeSlot() {
  if (activeScrapesCount < MAX_CONCURRENT_SCRAPES) {
    activeScrapesCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => scrapeQueue.push(resolve));
}

function releaseScrapeSlot() {
  activeScrapesCount--;
  if (scrapeQueue.length) {
    activeScrapesCount++;
    scrapeQueue.shift()();
  }
}

async function deepResolve(url) {
  const browser = await getWarmBrowser();
  const interceptor = new HeadlessInterceptor({
    browser,
    executablePath: getChromiumPath(),
    timeout: 30000
  });
  return interceptor.resolveEmbed(url);
}

function parseParams(req) {
  const q = req.query || {};
  const type = String(q.type || 'movie').toLowerCase();
  return {
    id: String(q.id || ''),
    type,
    isTv: ['tv', 'series', 'show'].includes(type),
    season: Number(q.season || 1),
    episode: Number(q.episode || 1),
    url: String(q.url || ''),
    title: String(q.title || '')
  };
}

function providerUrls(p) {
  const out = [];
  if (p.url) out.push(p.url);

  // Include the same deep-embed target used by the successful debug extractor.
  if (p.id && !p.isTv) out.push(`https://vidnest.fun/movie/${encodeURIComponent(p.id)}`);
  if (p.id && p.isTv) out.push(`https://vidnest.fun/tv/${encodeURIComponent(p.id)}/${p.season}/${p.episode}`);

  if (p.id) {
    if (p.isTv) {
      out.push(`https://vidsrc.to/embed/tv/${encodeURIComponent(p.id)}/${p.season}/${p.episode}`);
      out.push(`https://vidsrc.me/embed/tv/${encodeURIComponent(p.id)}/${p.season}/${p.episode}`);
    } else {
      out.push(`https://vidsrc.to/embed/movie/${encodeURIComponent(p.id)}`);
      out.push(`https://vidsrc.me/embed/movie/${encodeURIComponent(p.id)}`);
    }
  }

  return [...new Set(out)];
}

async function resolveStream(p) {
  const key = JSON.stringify(p);
  const cached = streamCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value;
  if (pendingScrapes.has(key)) return pendingScrapes.get(key);

  const job = (async () => {
    await acquireScrapeSlot();
    try {
      for (const target of providerUrls(p)) {
        try {
          const result = await deepResolve(target);
          // HeadlessInterceptor returns streamUrl; accept url as a compatibility fallback.
          const streamUrl = result?.streamUrl || result?.url;
          if (!streamUrl) continue;

          const value = {
            streamUrl,
            referer: result.referer || target,
            headers: result.headers || {},
            source: result.source || 'network-response',
            diagnostics: result.diagnostics || undefined
          };
          streamCache.set(key, { ts: Date.now(), value });
          return value;
        } catch (error) {
          console.error(`deep resolver failed ${target}:`, error.message);
        }
      }
      return null;
    } finally {
      releaseScrapeSlot();
    }
  })();

  pendingScrapes.set(key, job);
  try {
    return await job;
  } finally {
    pendingScrapes.delete(key);
  }
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  return accept.includes('text/html');
}

function renderPlayer(streamUrl, title = 'Universal Stream') {
  const safeUrl = JSON.stringify(streamUrl).replace(/</g, '\\u003c');
  const safeTitle = String(title).replace(/[&<>\"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'
  }[c]));

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>html,body{margin:0;background:#000;width:100%;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain;background:#000}</style>
</head><body><video id="video" controls autoplay playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.2/dist/hls.min.js"></script>
<script>
const src=${safeUrl}; const video=document.getElementById('video');
if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src=src; video.play().catch(()=>{}); }
else if (window.Hls && Hls.isSupported()) { const hls=new Hls({enableWorker:true}); hls.loadSource(src); hls.attachMedia(video); hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{})); }
else { document.body.innerHTML='<div style="color:white;font:16px sans-serif;padding:24px">HLS playback is not supported by this browser.</div>'; }
</script></body></html>`;
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'universal-stream-scraper',
  browser: !!globalBrowser
}));

app.get('/api/debug/extract', async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ success: false, error: 'url is required' });
    const result = await deepResolve(String(req.query.url));
    res.json({ success: true, target: req.query.url, ...result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      diagnostics: error.diagnostics || null
    });
  }
});

app.get('/api/v1/stream', async (req, res) => {
  try {
    const params = parseParams(req);
    if (!params.id && !params.url) return res.status(400).send('Missing id or url');

    const result = await resolveStream(params);
    if (!result) return res.status(404).send('Stream not found.');

    // Opening the endpoint directly in a browser now gives a playable HLS.js page.
    if (wantsHtml(req)) {
      return res.type('html').send(renderPlayer(result.streamUrl, params.title || `${params.type} ${params.id}`));
    }

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('stream resolver error:', error);
    res.status(500).send('Stream resolver error.');
  }
});

app.get('/api/resolve', async (req, res) => {
  try {
    const params = parseParams(req);
    const result = await resolveStream(params);
    if (!result) return res.status(404).json({ success: false, error: 'Stream not found' });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.json({
  service: 'universal-stream-scraper',
  status: 'ok',
  endpoints: ['/health', '/api/v1/stream', '/api/resolve', '/api/debug/extract']
}));

getWarmBrowser().catch(error => console.error('browser warmup:', error.message));
app.listen(PORT, () => console.log(`Universal Stream Scraper listening on ${PORT}`));
