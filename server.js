const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const StreamResolver = require('./StreamResolver');
const HeadlessInterceptor = require('./HeadlessInterceptor');

puppeteer.use(StealthPlugin());
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const streamCache = new Map();
const playerTokens = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const PLAYER_TTL = 2 * 60 * 60 * 1000;
const pendingScrapes = new Map();
let globalBrowser = null;
let activeScrapesCount = 0;
const MAX_CONCURRENT_SCRAPES = 1;
const scrapeQueue = [];

function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) if (fs.existsSync(p)) return p;
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
  const interceptor = new HeadlessInterceptor({ browser, executablePath: getChromiumPath(), timeout: 30000 });
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
          const streamUrl = result?.streamUrl || result?.url;
          if (!streamUrl) continue;
          const value = {
            streamUrl,
            referer: result.referer || target,
            headers: result.headers || {},
            manifestHeaders: result.manifestHeaders || {},
            manifestBody: result.manifestBody || null,
            cookies: result.cookies || [],
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
  try { return await job; } finally { pendingScrapes.delete(key); }
}

function cleanupTokens() {
  const now = Date.now();
  for (const [token, value] of playerTokens) if (now - value.ts > PLAYER_TTL) playerTokens.delete(token);
}

function createPlayerToken(result) {
  cleanupTokens();
  const token = crypto.randomBytes(18).toString('hex');
  playerTokens.set(token, {
    ts: Date.now(),
    streamUrl: result.streamUrl,
    referer: result.referer,
    headers: result.headers || {},
    manifestHeaders: result.manifestHeaders || {},
    manifestBody: result.manifestBody || null,
    cookies: result.cookies || []
  });
  return token;
}

function getPlayerToken(token) {
  const item = playerTokens.get(token);
  if (!item) return null;
  if (Date.now() - item.ts > PLAYER_TTL) {
    playerTokens.delete(token);
    return null;
  }
  return item;
}

function cookieHeader(cookies) {
  return (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
}

function upstreamHeaders(item, req) {
  const original = item.headers || {};
  const h = {};

  // Preserve the browser request context instead of reducing it to only UA/referer.
  for (const [key, value] of Object.entries(original)) {
    const lower = String(key).toLowerCase();
    if (!value || ['host', 'content-length', 'connection'].includes(lower)) continue;
    h[lower] = value;
  }

  const cookies = cookieHeader(item.cookies);
  if (cookies) h.cookie = cookies;
  if (item.referer) h.referer = item.referer;

  try {
    if (item.referer) h.origin = new URL(item.referer).origin;
  } catch (_) {}

  if (req.headers.range) h.range = req.headers.range;
  return h;
}

function localProxyUrl(token, upstreamUrl) {
  return `/api/hls/${token}?u=${encodeURIComponent(upstreamUrl)}`;
}

function rewritePlaylist(text, baseUrl, token) {
  return String(text).split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
        try { return `URI="${localProxyUrl(token, new URL(uri, baseUrl).href)}"`; }
        catch (_) { return `URI="${uri}"`; }
      });
    }
    try { return localProxyUrl(token, new URL(trimmed, baseUrl).href); }
    catch (_) { return line; }
  }).join('\n');
}

async function proxyHls(req, res) {
  const item = getPlayerToken(req.params.token);
  if (!item) return res.status(404).send('Player session expired.');

  let upstream;
  try {
    upstream = req.query.u ? new URL(String(req.query.u)).href : item.streamUrl;
  } catch (_) {
    return res.status(400).send('Invalid upstream URL.');
  }

  // The resolver already received the first manifest through Chromium.
  // Serve that exact browser-observed body so tokenized/anti-bot manifests
  // do not have to be fetched a second time by Node.
  if (!req.query.u && item.manifestBody && item.streamUrl === upstream) {
    const rewritten = rewritePlaylist(item.manifestBody, upstream, req.params.token);
    res.set('Content-Type', item.manifestHeaders?.['content-type'] || 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', '*');
    res.set('X-Stream-Proxy-Status', 'captured-manifest');
    return res.send(rewritten);
  }

  try {
    const response = await axios.get(upstream, {
      responseType: 'arraybuffer',
      timeout: 25000,
      maxRedirects: 5,
      headers: upstreamHeaders(item, req),
      validateStatus: () => true
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const body = Buffer.from(response.data || '');
    const textPrefix = body.toString('utf8', 0, Math.min(body.length, 2000));
    const looksLikePlaylist = /mpegurl|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|x-mpegurl/i.test(contentType) || /^\s*#EXTM3U/i.test(textPrefix);

    if (response.status < 200 || response.status >= 400) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Expose-Headers', '*');
      res.set('X-Stream-Proxy-Status', `upstream-${response.status}`);
      return res.status(response.status || 502).send(body.toString('utf8').slice(0, 2000) || 'Upstream stream error');
    }

    if (looksLikePlaylist) {
      const rewritten = rewritePlaylist(body.toString('utf8'), upstream, req.params.token);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Expose-Headers', '*');
      res.set('X-Stream-Proxy-Status', 'upstream-playlist');
      return res.send(rewritten);
    }

    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (response.headers[key]) res.set(key, response.headers[key]);
    }
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', '*');
    res.set('X-Stream-Proxy-Status', 'upstream-segment');
    return res.status(response.status).send(body);
  } catch (error) {
    console.error('HLS proxy error:', error.message);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', '*');
    res.set('X-Stream-Proxy-Status', 'proxy-error');
    return res.status(502).send(`Upstream stream unavailable: ${error.message}`);
  }
}

function wantsHtml(req) {
  return String(req.headers.accept || '').toLowerCase().includes('text/html');
}

function renderPlayer(token, title = 'Universal Stream') {
  const safeTitle = String(title).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  const source = `/api/hls/${token}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>html,body{margin:0;background:#000;width:100%;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain;background:#000}#error{display:none;position:fixed;left:20px;right:20px;bottom:20px;padding:12px;background:#222;color:#fff;font:14px Arial;border-radius:8px;z-index:9;white-space:pre-wrap}</style></head><body><video id="video" controls autoplay playsinline></video><div id="error"></div><script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.2/dist/hls.min.js"></script><script>
const src=${JSON.stringify(source)},video=document.getElementById('video'),err=document.getElementById('error');
function show(e){err.textContent='Stream error: '+e;err.style.display='block';console.error(e)}
if(window.Hls&&Hls.isSupported()){
  const hls=new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:90,manifestLoadingMaxRetry:4,manifestLoadingRetryDelay:1000,levelLoadingMaxRetry:5,levelLoadingRetryDelay:1000,fragLoadingMaxRetry:6,fragLoadingRetryDelay:1000});
  hls.on(Hls.Events.ERROR,(_,data)=>{
    console.error('HLS error',data);
    if(data.fatal){
      if(data.type===Hls.ErrorTypes.NETWORK_ERROR){show((data.details||'network error')+' ['+(data.response?.code||'no-status')+']');hls.startLoad();}
      else if(data.type===Hls.ErrorTypes.MEDIA_ERROR){show(data.details||'media error');hls.recoverMediaError();}
      else show((data.type||'HLS')+' / '+(data.details||'fatal error'));
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));
  hls.loadSource(src);
  hls.attachMedia(video);
}else if(video.canPlayType('application/vnd.apple.mpegurl')){
  video.src=src;
  video.addEventListener('error',()=>show('Browser could not load the HLS stream'));video.play().catch(()=>{});
}else show('HLS playback is not supported by this browser');
</script></body></html>`;
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'universal-stream-scraper', browser: !!globalBrowser }));

app.get('/api/debug/extract', async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ success: false, error: 'url is required' });
    const result = await deepResolve(String(req.query.url));
    res.json({ success: true, target: req.query.url, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, diagnostics: error.diagnostics || null });
  }
});

app.get('/api/hls/:token', proxyHls);
app.get('/api/hls/:token/*', proxyHls);

app.get('/api/v1/stream', async (req, res) => {
  try {
    const p = parseParams(req);
    if (!p.id && !p.url) return res.status(400).send('Missing id or url');
    const result = await resolveStream(p);
    if (!result) return res.status(404).send('Stream not found.');
    const token = createPlayerToken(result);
    if (wantsHtml(req)) return res.type('html').send(renderPlayer(token, p.title || `${p.type} ${p.id}`));
    res.json({
      success: true,
      streamUrl: result.streamUrl,
      referer: result.referer,
      source: result.source,
      diagnostics: result.diagnostics,
      playerUrl: `/api/v1/stream?id=${encodeURIComponent(p.id)}&type=${encodeURIComponent(p.type)}${p.isTv ? `&season=${p.season}&episode=${p.episode}` : ''}`,
      hlsProxy: `/api/hls/${token}`
    });
  } catch (error) {
    console.error('stream resolver error:', error);
    res.status(500).send('Stream resolver error.');
  }
});

app.get('/api/resolve', async (req, res) => {
  try {
    const p = parseParams(req);
    const result = await resolveStream(p);
    if (!result) return res.status(404).json({ success: false, error: 'Stream not found' });
    const token = createPlayerToken(result);
    res.json({
      success: true,
      streamUrl: result.streamUrl,
      referer: result.referer,
      source: result.source,
      diagnostics: result.diagnostics,
      playerUrl: `/api/v1/stream?id=${encodeURIComponent(p.id)}&type=${encodeURIComponent(p.type)}`,
      hlsProxy: `/api/hls/${token}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.json({ service: 'universal-stream-scraper', status: 'ok', endpoints: ['/health', '/api/v1/stream', '/api/resolve', '/api/debug/extract'] }));

getWarmBrowser().catch(error => console.error('browser warmup:', error.message));
app.listen(PORT, () => console.log(`Universal Stream Scraper listening on ${PORT}`));
