const express = require('express');
const cors = require('cors');
const path = require('path');
let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('Puppeteer not available, using fetch fallback.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// TMDB URL পার্সার
function parseTmdbUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const pathname = u.pathname;
    const isTv = pathname.includes('/tv/') || u.searchParams.has('season') || pathname.includes('embedtv');
    
    let tmdbId = null;
    let season = 1;
    let episode = 1;

    if (u.searchParams.has('tmdb')) tmdbId = u.searchParams.get('tmdb');
    if (u.searchParams.has('id')) tmdbId = u.searchParams.get('id');
    if (u.searchParams.has('video_id')) tmdbId = u.searchParams.get('video_id');
    if (u.searchParams.has('s') || u.searchParams.has('season')) season = u.searchParams.get('s') || u.searchParams.get('season') || 1;
    if (u.searchParams.has('e') || u.searchParams.has('episode')) episode = u.searchParams.get('e') || u.searchParams.get('episode') || 1;

    if (!tmdbId) {
      const match = pathname.match(/\/(?:movie|tv|embed|v2\/embed)\/(\d+)(?:\/(\d+)\/(\d+))?/i) ||
                    pathname.match(/(\d+)/);
      if (match) {
        tmdbId = match[1];
        if (match[2]) season = match[2];
        if (match[3]) episode = match[3];
      }
    }

    if (tmdbId) {
      return { id: tmdbId, type: isTv ? 'tv' : 'movie', season, episode };
    }
  } catch(e) {}
  return null;
}

function getServerName(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    if (hostname.includes('vidnest')) return 'Vidnest';
    if (hostname.includes('vidrock')) return 'Vidrock';
    if (hostname.includes('videasy')) return 'Videasy';
    if (hostname.includes('1shows')) return '1Shows';
    if (hostname.includes('peakstorm')) return 'Peakstorm';
    if (hostname.includes('cloudorchestranova')) return 'CloudOrchestra';
    if (hostname.includes('vidsrc.sbs')) return 'VidSrc.sbs';
    if (hostname.includes('vidsrc.me')) return 'VidSrc.me';
    if (hostname.includes('vidsrc.cc')) return 'VidSrc.cc';
    if (hostname.includes('vidsrc.icu')) return 'VidSrc.icu';
    if (hostname.includes('vidsrc.to')) return 'VidSrc.to';
    if (hostname.includes('vidlink')) return 'VidLink.pro';
    if (hostname.includes('autoembed')) return 'AutoEmbed.cc';
    if (hostname.includes('embed.su')) return 'Embed.su';
    if (hostname.includes('multiembed')) return 'MultiEmbed';
    if (hostname.includes('smashystream')) return 'SmashyStream';
    if (hostname.includes('2embed')) return '2Embed';
    return hostname.replace('www.', '');
  } catch (e) {
    return 'Server';
  }
}

function isCandidateStreamUrl(url, contentType = '') {
  if (!url) return false;
  const u = url.toLowerCase();
  
  if (
    u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.jpeg') || 
    u.endsWith('.svg') || u.endsWith('.gif') || u.endsWith('.css') || 
    u.endsWith('.js') || u.endsWith('.ico') || u.endsWith('.woff') || u.endsWith('.ttf') ||
    u.includes('themoviedb.org') || u.includes('google-analytics') ||
    u.includes('doubleclick') || u.includes('adexchanger') || u.includes('histats.com') ||
    u.includes('demo-video') || u.includes('sample-video') || u.includes('placeholder') ||
    u.includes('trailer') || u.includes('test-video') || u.includes('ad-') ||
    u.includes('speedracelight.com') || u.includes('streamcrypto') || u.includes('/cdn/sources')
  ) {
    return false;
  }

  return (
    u.includes('.m3u8') || 
    u.includes('.mp4') || 
    contentType.includes('mpegurl') || 
    contentType.includes('video/') ||
    u.includes('workers.dev') ||
    u.includes('playlist') ||
    u.includes('chunk-stream') ||
    u.includes('master.txt') ||
    u.includes('manifest.mpd') ||
    u.includes('directstream.php')
  );
}

function selectBestStreamUrl(urls) {
  if (!urls || urls.length === 0) return null;
  const cleanUrls = urls.filter(u => {
    const lower = u.toLowerCase();
    return !lower.includes('demo-video') && !lower.includes('sample') && !lower.includes('placeholder') && !lower.includes('trailer');
  });

  const candidates = cleanUrls.length > 0 ? cleanUrls : urls;
  const unique = Array.from(new Set(candidates));
  
  const masterM3u8 = unique.find(u => (u.includes('master') || u.includes('index') || u.includes('playlist')) && u.includes('.m3u8'));
  if (masterM3u8) return masterM3u8;

  const anyM3u8 = unique.find(u => u.includes('.m3u8'));
  if (anyM3u8) return anyM3u8;

  const workerProxy = unique.find(u => u.includes('workers.dev'));
  if (workerProxy) return workerProxy;

  const mp4Url = unique.find(u => u.includes('.mp4'));
  if (mp4Url) return mp4Url;

  return unique[0];
}

async function fetchStreamFallback(targetUrl, depth = 0, maxDepth = 3, visited = new Set()) {
  if (depth > maxDepth || visited.has(targetUrl)) return null;
  visited.add(targetUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let origin = 'https://vidnest.fun/';
    try { origin = new URL(targetUrl).origin + '/'; } catch(e){}

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': origin
      }
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const html = await response.text();

    const mediaRegex = /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/gi;
    const matches = [...html.matchAll(mediaRegex)].map(m => m[1]);
    if (matches.length > 0) {
      const best = selectBestStreamUrl(matches);
      if (best) return best;
    }

    const workerRegex = /(https?:\/\/[^\s"'<>]*workers\.dev\/[^\s"'<>]*)/gi;
    const workerMatches = [...html.matchAll(workerRegex)].map(m => m[1]);
    if (workerMatches.length > 0) return workerMatches[0];

    return null;
  } catch (err) {
    return null;
  }
}

async function extractStream(targetUrl) {
  if (!puppeteer) return await fetchStreamFallback(targetUrl);

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    let streamUrls = [];
    const handleNetworkItem = (url, contentType = '') => {
      if (isCandidateStreamUrl(url, contentType)) {
        streamUrls.push(url);
      }
    };

    browser.on('targetcreated', async (target) => {
      try {
        const targetPage = await target.page();
        if (targetPage) {
          targetPage.on('response', (res) => handleNetworkItem(res.url(), res.headers()['content-type'] || ''));
          targetPage.on('request', (req) => handleNetworkItem(req.url()));
        }
      } catch(e) {}
    });

    const page = await browser.newPage();
    let origin = 'https://vidnest.fun/';
    try { origin = new URL(targetUrl).origin + '/'; } catch(e){}

    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'referer': origin
    });
    
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    page.on('response', (res) => handleNetworkItem(res.url(), res.headers()['content-type'] || ''));
    page.on('request', (req) => handleNetworkItem(req.url()));

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 7000 });
    } catch (e) {}

    const frames = page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(() => {
          const selectors = ['video', 'iframe', '.play-button', 'div[class*="play"]', 'button', 'canvas', '.jw-display-icon', '.vjs-big-play-button', '#player', '#vplayer', '.play-btn', 'div[id*="player"]'];
          selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
              try { el.click(); } catch(e){}
            });
          });
        });
      } catch(e) {}
    }
    try { await page.mouse.click(640, 360); } catch(e) {}

    let waitTime = 0;
    while (streamUrls.length === 0 && waitTime < 5000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    await browser.close();

    if (streamUrls.length > 0) {
      const bestUrl = selectBestStreamUrl(streamUrls);
      if (bestUrl) return bestUrl;
    }

    return await fetchStreamFallback(targetUrl);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return await fetchStreamFallback(targetUrl);
  }
}

// প্রক্সি টানেল ও হেডার রিরাইট
app.get(['/api/proxy-stream', '/api/stream-proxy'], async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('URL is required');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const targetUrlObj = new URL(streamUrl);
    let customReferer = req.query.referer;

    if (!customReferer) {
      if (streamUrl.includes('1shows.app') || streamUrl.includes('vidrock')) {
        customReferer = 'https://vidrock.net/';
      } else if (streamUrl.includes('workers.dev') || streamUrl.includes('vidnest')) {
        customReferer = 'https://vidnest.fun/';
      } else if (streamUrl.includes('vidsrc.sbs')) {
        customReferer = 'https://vidsrc.sbs/';
      } else if (streamUrl.includes('vidlink')) {
        customReferer = 'https://vidlink.pro/';
      } else if (streamUrl.includes('autoembed')) {
        customReferer = 'https://autoembed.cc/';
      } else {
        customReferer = `${targetUrlObj.protocol}//${targetUrlObj.host}/`;
      }
    }

    let origin = customReferer;
    try { origin = new URL(customReferer).origin; } catch(e) {}

    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': customReferer,
      'Origin': origin,
      'Accept': '*/*'
    };

    if (req.headers.range) reqHeaders['Range'] = req.headers.range;

    const response = await fetch(streamUrl, { signal: controller.signal, headers: reqHeaders });
    clearTimeout(timeout);

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send(`Stream fetch error: ${response.statusText}`);
    }

    let contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    
    // Disguised ইমেজ বা অক্টেট-হেডার বাইপাস
    if (!streamUrl.includes('.m3u8')) {
      if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
        contentType = streamUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);

    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
    if (response.headers.get('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));
    if (response.status === 206) res.status(206);

    if (streamUrl.includes('.m3u8')) {
      const content = await response.text();
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      
      const rewrittenContent = content.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          let absoluteChunkUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            absoluteChunkUrl = trimmed.startsWith('/') ? `${targetUrlObj.protocol}//${targetUrlObj.host}${trimmed}` : `${baseUrl}${trimmed}`;
          }
          return `${hostUrl}/api/proxy-stream?url=${encodeURIComponent(absoluteChunkUrl)}&referer=${encodeURIComponent(customReferer)}`;
        }
        return line;
      }).join('\n');

      return res.send(rewrittenContent);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).send(`Stream Proxy Error: ${err.message}`);
  }
});

const SERVER_GENERATORS = {
  'vidnest': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidnest.fun/tv/${id}/${s}/${e}` : `https://vidnest.fun/movie/${id}`,
  'vidrock': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidrock.net/tv/${id}/${s}/${e}` : `https://vidrock.net/movie/${id}`,
  'videasy': (t, id, s = 1, e = 1) => t === 'tv' ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/movie/${id}`,
  '1shows': (t, id, s = 1, e = 1) => t === 'tv' ? `https://1shows.app/tv/${id}/${s}/${e}` : `https://1shows.app/movie/${id}`,
  'vidlink': (t, id, s = 1, e = 1) => t === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`,
  'autoembed': (t, id, s = 1, e = 1) => t === 'tv' ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`
};

// ইউনিভার্সাল এপিআই এন্ডপয়েন্ট
app.all(['/api/resolve-stream', '/api/v1/extract'], async (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const tmdbId = params.id || params.tmdb_id;
  const type = (params.type || 'movie').toLowerCase();
  const season = params.season || params.s || 1;
  const episode = params.episode || params.e || 1;
  const serverKey = (params.server || 'vidnest').toLowerCase();

  if (!tmdbId) {
    return res.status(400).json({ success: false, error: 'Media TMDB ID required' });
  }

  const gen = SERVER_GENERATORS[serverKey] || SERVER_GENERATORS['vidnest'];
  let targetUrl = gen(type, tmdbId, season, episode);
  let streamUrl = await extractStream(targetUrl);
  let actualServer = serverKey;

  if (!streamUrl) {
    const fallbackKeys = ['vidnest', 'vidrock', 'vidlink', 'autoembed'];
    for (const fbKey of fallbackKeys) {
      if (fbKey !== serverKey) {
        const fbUrl = SERVER_GENERATORS[fbKey](type, tmdbId, season, episode);
        const fbStream = await extractStream(fbUrl);
        if (fbStream) {
          streamUrl = fbStream;
          actualServer = fbKey;
          targetUrl = fbUrl;
          break;
        }
      }
    }
  }

  const host = `${req.protocol}://${req.get('host')}`;

  if (streamUrl) {
    return res.json({
      success: true,
      isEmbed: false,
      server: actualServer,
      streamUrl: `${host}/api/proxy-stream?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`,
      rawUrl: streamUrl,
      type
    });
  }

  return res.status(404).json({ success: false, error: 'Stream link not captured from server.' });
});

app.get('/', (req, res) => res.send('🚀 High-Availability Stream Engine Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
