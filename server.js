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

function getHostUrl(req) {
  if (!req) return '';
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : (req.protocol || 'https'));
  let host = req.headers['x-forwarded-host'] || req.get('host') || '';
  if (host.includes(',')) {
    host = host.split(',')[0].trim();
  }
  return host ? `${proto}://${host}` : '';
}

// ========================================================
// ⏰ 24/7 KEEP-ALIVE AUTO-PINGER ENGINE (RENDER.COM & CLOUD SLEEP PREVENTION)
// ========================================================
const keepAliveState = {
  startTime: Date.now(),
  intervalMinutes: Math.max(1, Math.min(14, Number(process.env.PING_INTERVAL_MINUTES) || 8)),
  configuredUrl: (process.env.PING_URL || process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || process.env.APP_URL || '').trim().replace(/\/$/, ''),
  autoDetectedUrl: '',
  lastPingTime: null,
  lastPingDurationMs: null,
  lastPingStatus: 'idle',
  lastPingStatusCode: null,
  lastPingError: null,
  totalPings: 0,
  successfulPings: 0,
  failedPings: 0,
  history: [],
  enabled: process.env.DISABLE_SELF_PING !== 'true',
  nextPingTime: null
};

function getActiveKeepAliveUrl() {
  if (keepAliveState.configuredUrl) return keepAliveState.configuredUrl;
  if (keepAliveState.autoDetectedUrl) return keepAliveState.autoDetectedUrl;
  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}`;
}

async function executeKeepAlivePing(isManual = false) {
  const targetBase = getActiveKeepAliveUrl();
  const pingUrl = targetBase.endsWith('/ping') ? targetBase : `${targetBase}/ping`;
  const startTime = Date.now();
  
  try {
    const res = await axios.get(pingUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Render-24-7-KeepAlive-Worker/1.0',
        'Cache-Control': 'no-cache',
        'X-KeepAlive-Ping': 'true'
      }
    });
    
    const duration = Date.now() - startTime;
    keepAliveState.lastPingTime = Date.now();
    keepAliveState.lastPingDurationMs = duration;
    keepAliveState.lastPingStatus = 'success';
    keepAliveState.lastPingStatusCode = res.status;
    keepAliveState.lastPingError = null;
    keepAliveState.totalPings++;
    keepAliveState.successfulPings++;
    
    const logItem = {
      timestamp: new Date().toISOString(),
      url: pingUrl,
      status: 'success',
      statusCode: res.status,
      durationMs: duration,
      manual: isManual
    };
    keepAliveState.history.unshift(logItem);
    if (keepAliveState.history.length > 20) keepAliveState.history.pop();
    
    console.log(`📡 [Keep-Alive 24/7] 🟢 Ping success: ${pingUrl} (${duration}ms) | Total: ${keepAliveState.totalPings}`);
    return { success: true, duration, statusCode: res.status, url: pingUrl };
  } catch (err) {
    const duration = Date.now() - startTime;
    keepAliveState.lastPingTime = Date.now();
    keepAliveState.lastPingDurationMs = duration;
    keepAliveState.lastPingStatus = 'failed';
    keepAliveState.lastPingStatusCode = err.response ? err.response.status : 500;
    keepAliveState.lastPingError = err.message;
    keepAliveState.totalPings++;
    keepAliveState.failedPings++;
    
    const logItem = {
      timestamp: new Date().toISOString(),
      url: pingUrl,
      status: 'failed',
      statusCode: err.response ? err.response.status : null,
      error: err.message,
      durationMs: duration,
      manual: isManual
    };
    keepAliveState.history.unshift(logItem);
    if (keepAliveState.history.length > 20) keepAliveState.history.pop();
    
    console.warn(`📡 [Keep-Alive 24/7] ⚠️ Ping warning on ${pingUrl}: ${err.message} | Duration: ${duration}ms`);
    return { success: false, duration, error: err.message, url: pingUrl };
  }
}

function startKeepAliveEngine() {
  if (!keepAliveState.enabled) {
    console.log('📡 [Keep-Alive 24/7] Self-pinging is disabled by DISABLE_SELF_PING=true');
    return;
  }

  const intervalMs = keepAliveState.intervalMinutes * 60 * 1000;
  keepAliveState.nextPingTime = Date.now() + 30000;

  console.log(`📡 [Keep-Alive 24/7] Engine initialized. Ping interval: every ${keepAliveState.intervalMinutes} minutes (Render sleep threshold is ~15 min).`);
  console.log(`📡 [Keep-Alive 24/7] Target URL: ${getActiveKeepAliveUrl()}`);

  // Initial warm-up ping after 30 seconds
  setTimeout(async () => {
    await executeKeepAlivePing(false);
    keepAliveState.nextPingTime = Date.now() + intervalMs;
  }, 30000);

  // Recurring ping interval (every 8 mins by default)
  setInterval(async () => {
    await executeKeepAlivePing(false);
    keepAliveState.nextPingTime = Date.now() + intervalMs;
  }, intervalMs);
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');

  // Auto-detect public URL for 24/7 keep-alive self-pinging if not explicitly configured
  if (!keepAliveState.configuredUrl && !keepAliveState.autoDetectedUrl) {
    try {
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      if (host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('0.0.0.0')) {
        const cleanHost = host.includes(',') ? host.split(',')[0].trim() : host.trim();
        keepAliveState.autoDetectedUrl = `${proto}://${cleanHost}`;
        console.log(`🌐 [Keep-Alive] Auto-detected public host for 24/7 pinging: ${keepAliveState.autoDetectedUrl}`);
      }
    } catch (e) {}
  }

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ১০০K ট্রাফিকের জন্য ২৪ ঘণ্টা মেমোরি ক্যাশ
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// সমসাময়িক রিকোয়েস্ট লকার (একই টাইটেলে মাল্টিপল ব্রাউজার ওপেন বন্ধ রাখার জন্য)
const pendingScrapes = new Map();

let globalBrowser = null;
let currentProfileDir = null;

// Concurrency Control to prevent Out Of Memory on 1GB RAM instances
let activeScrapesCount = 0;
const MAX_CONCURRENT_SCRAPES = 1; // 1 tab at a time ensures Chromium fits comfortably in low-memory containers
const scrapeQueue = [];

function acquireScrapeSlot() {
  if (activeScrapesCount < MAX_CONCURRENT_SCRAPES) {
    activeScrapesCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    scrapeQueue.push(resolve);
  });
}

function releaseScrapeSlot() {
  activeScrapesCount--;
  if (scrapeQueue.length > 0) {
    const next = scrapeQueue.shift();
    activeScrapesCount++;
    next();
  }
}

function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const defaultPath = '/root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  try {
    const rootCache = '/root/.cache/puppeteer';
    if (fs.existsSync(rootCache)) {
      const globFiles = (dir) => {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat && stat.isDirectory()) {
            results = results.concat(globFiles(filePath));
          } else {
            if (path.basename(filePath) === 'chrome' || path.basename(filePath) === 'chromium') {
              results.push(filePath);
            }
          }
        });
        return results;
      };
      const found = globFiles(rootCache);
      if (found.length > 0) return found[0];
    }
  } catch (e) {}
  return '/usr/bin/chromium';
}

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;

  // Clean up any old profile directory to free disk/memory space
  if (currentProfileDir) {
    try {
      fs.rmSync(currentProfileDir, { recursive: true, force: true });
    } catch (e) {}
  }

  currentProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: getChromiumPath(),
    userDataDir: currentProfileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts',
      '--disable-features=IsolateOrigins,site-per-process', // Disable process site isolation to save ~70% Chromium RAM
      '--js-flags="--max-old-space-size=128"' // Limit JS VM heap memory in browser pages to 128MB
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

// ========================================================
// ১. DUB এর জন্য MAL / ANILIST / MEGAPLAY রেজলভার
// ========================================================
async function getAnimeExternalIds(title = '') {
  const query = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        idMal
      }
    }
  `;
  const cleanTitle = title.trim();
  if (!cleanTitle) return { malId: null, anilistId: null };

  const tryAniList = async (searchTerm) => {
    try {
      const res = await axios.post('https://graphql.anilist.co', {
        query,
        variables: { search: searchTerm }
      }, { timeout: 4000 });
      return res.data?.data?.Media;
    } catch (e) {
      return null;
    }
  };

  // 1. Try with full title
  let media = await tryAniList(cleanTitle);
  if (media) return { malId: media.idMal, anilistId: media.id };

  // 2. Try with first 2 words if title has multiple words
  const words = cleanTitle.split(/\s+/);
  if (words.length > 2) {
    const fallbackTitle = words.slice(0, 2).join(' ');
    media = await tryAniList(fallbackTitle);
    if (media) return { malId: media.idMal, anilistId: media.id };
  }

  // 3. Try with first word
  if (words.length > 0) {
    media = await tryAniList(words[0]);
    if (media) return { malId: media.idMal, anilistId: media.id };
  }

  return { malId: null, anilistId: null };
}

async function resolveDubStream(params) {
  const { id, episode = 1, title, malId: paramMal, anilistId: paramAni } = params;
  let malId = paramMal;
  let anilistId = paramAni;

  if (!malId && !anilistId && title) {
    const ext = await getAnimeExternalIds(title);
    malId = ext.malId;
    anilistId = ext.anilistId;
  }

  if (malId) return `https://megaplay.buzz/stream/mal/${malId}/${episode}/dub`;
  if (anilistId) return `https://megaplay.buzz/stream/ani/${anilistId}/${episode}/dub`;

  try {
    const res = await axios.get(`https://anikotoapi.site/series/${id}`, { timeout: 4000 });
    const episodes = res.data?.episodes || res.data?.data?.episodes;
    if (episodes && episodes.length > 0) {
      const ep = episodes.find(e => Number(e.number) === Number(episode)) || episodes[episode - 1] || episodes[0];
      const embedId = ep?.episode_embed_id || ep?.id;
      if (embedId) return `https://megaplay.buzz/stream/s-2/${embedId}/dub`;
    }
  } catch (e) {}

  return `https://vidsrc.sbs/embed/tv/${id}/${params.season}/${episode}?dub=1`;
}

// ========================================================
// ২. ANIKOTO (anikoto.cz) ওয়াচ পেজ রেজলভার
// ========================================================
async function getAnikotoWatchUrl(title, episode = 1) {
  try {
    const cleanTitle = title.trim();
    const tryAnikotoSearch = async (term) => {
      let combinedHtml = '';
      try {
        const suggestUrl = `https://anikoto.cz/ajax/search/suggest?keyword=${encodeURIComponent(term)}`;
        const suggestRes = await axios.get(suggestUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: 4000
        });
        if (suggestRes && suggestRes.data) {
          if (typeof suggestRes.data === 'string') {
            combinedHtml += suggestRes.data;
          } else if (suggestRes.data.html) {
            combinedHtml += suggestRes.data.html;
          } else {
            combinedHtml += JSON.stringify(suggestRes.data);
          }
        }
      } catch (e) {}

      try {
        const filterUrl = `https://anikoto.cz/filter?keyword=${encodeURIComponent(term)}`;
        const filterRes = await axios.get(filterUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
          },
          timeout: 4000
        });
        if (filterRes && filterRes.data) {
          combinedHtml += filterRes.data;
        }
      } catch (e) {}

      return combinedHtml;
    };

    // 1. Try full title first
    let html = await tryAnikotoSearch(cleanTitle);

    // 2. If no /watch/ slug in results, try first 2 words
    const words = cleanTitle.split(/\s+/);
    if ((!html || !html.includes('/watch/')) && words.length > 2) {
      const fallbackTerm = words.slice(0, 2).join(' ');
      html = await tryAnikotoSearch(fallbackTerm);
    }

    // 3. If still no watch slug, try first word
    if ((!html || !html.includes('/watch/')) && words.length > 0) {
      html = await tryAnikotoSearch(words[0]);
    }

    // Extract matching /watch/{anime-slug} patterns
    const regex = /\/watch\/([a-zA-Z0-9-]+)/g;
    let match;
    const slugs = [];
    while ((match = regex.exec(html)) !== null) {
      const slug = match[1];
      if (slug && !slugs.includes(slug) && slug !== 'ep') {
        slugs.push(slug);
      }
    }

    if (slugs.length > 0) {
      // Find the best matching slug
      const searchNorm = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestSlug = slugs[0];
      for (const slug of slugs) {
        const slugNorm = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (slugNorm.includes(searchNorm) || searchNorm.includes(slugNorm)) {
          bestSlug = slug;
          break;
        }
      }
      return `https://anikoto.cz/watch/${bestSlug}/ep-${episode}`;
    }
  } catch (err) {
    console.error("Anikoto resolver error:", err.message);
  }
  return null;
}

// ========================================================
// ৩. TMDB ডাটাবেস স্ক্র্যাপার প্রোভাইডার (SUB, Movies, TV Series & Anime)
// ========================================================
async function getWebProviderUrls(params) {
  const { id, isTv, season, episode, title, lang, isAnime } = params;
  const regularUrls = [];
  const animeUrls = [];
  const debugInfo = {
    anilistId: null,
    anikotoUrl: null,
    urlsTried: []
  };

  // Build regular TV/Movie URLs with cluster server support
  const isImdb = String(id).startsWith('tt');
  const serverParam = (params.server || 'flixer').toLowerCase();
  const vidnestBase = isTv ? `https://vidnest.fun/tv/${id}/${season}/${episode}` : `https://vidnest.fun/movie/${id}`;
  const autoembedUrl = isTv ? `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` : `https://player.autoembed.cc/embed/movie/${id}`;
  const vidsrcSbsUrl = isTv ? `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}` : `https://vidsrc.sbs/embed/movie/${id}`;
  const vidrockUrl = isTv ? `https://vidrock.net/embed/tv/${id}/${season}/${episode}` : `https://vidrock.net/embed/movie/${id}`;
  const vidsrcXyzUrl = isTv 
    ? (isImdb ? `https://vidsrc.xyz/embed/tv?imdb=${id}&season=${season}&episode=${episode}` : `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`)
    : (isImdb ? `https://vidsrc.xyz/embed/movie?imdb=${id}` : `https://vidsrc.xyz/embed/movie?tmdb=${id}`);

  // Prioritize selected server cluster
  if (serverParam === 'lambda') {
    regularUrls.push(`${vidnestBase}?server=lambda`);
  } else if (serverParam === 'gamma') {
    regularUrls.push(`${vidnestBase}?server=gamma`);
  } else if (serverParam === 'sigma') {
    regularUrls.push(`${vidnestBase}?server=sigma`);
  } else if (serverParam === 'delta') {
    regularUrls.push(`${vidnestBase}?server=delta`);
  } else if (serverParam === 'autoembed') {
    regularUrls.push(autoembedUrl);
  } else if (serverParam === 'vidrock') {
    regularUrls.push(vidrockUrl);
  } else if (serverParam === 'vidsrc') {
    regularUrls.push(vidsrcSbsUrl, vidsrcXyzUrl);
  } else {
    // Default flixer
    regularUrls.push(`${vidnestBase}?server=flixer`);
  }

  // Fallback cluster servers
  const clusterPool = [
    `${vidnestBase}?server=flixer`,
    `${vidnestBase}?server=lambda`,
    `${vidnestBase}?server=gamma`,
    `${vidnestBase}?server=sigma`,
    `${vidnestBase}?server=delta`,
    vidnestBase,
    autoembedUrl,
    vidrockUrl,
    vidsrcSbsUrl,
    vidsrcXyzUrl
  ];
  for (const cUrl of clusterPool) {
    if (!regularUrls.includes(cUrl)) {
      regularUrls.push(cUrl);
    }
  }

  // If the user explicitly requested Anime OR we want to build anime URLs:
  const fetchAnimeUrls = async () => {
    if (!title) return;
    try {
      const ext = await getAnimeExternalIds(title);
      debugInfo.anilistId = ext?.anilistId || null;
      if (ext && ext.anilistId) {
        const ep = isTv ? episode : 1;
        if (lang === 'dub') {
          animeUrls.push(`https://vidnest.fun/anime/${ext.anilistId}/${ep}/dub`);
          animeUrls.push(`https://vidnest.fun/anime/${ext.anilistId}/${ep}/sub`);
        } else {
          animeUrls.push(`https://vidnest.fun/anime/${ext.anilistId}/${ep}/sub`);
          animeUrls.push(`https://vidnest.fun/anime/${ext.anilistId}/${ep}/dub`);
        }
      }
    } catch (e) {
      console.error("Error resolving AniList ID for vidnest anime url:", e);
    }

    try {
      const ep = isTv ? episode : 1;
      const anikotoUrl = await getAnikotoWatchUrl(title, ep);
      debugInfo.anikotoUrl = anikotoUrl;
      if (anikotoUrl) {
        animeUrls.push(anikotoUrl);
      }
    } catch (e) {
      console.error("Error fetching Anikoto watch url:", e);
    }
  };

  if (isAnime) {
    await fetchAnimeUrls();
    const urls = [...animeUrls, ...regularUrls];
    debugInfo.urlsTried = urls;
    return { urls, debugInfo, fetchAnimeUrlsFn: fetchAnimeUrls, regularUrls, animeUrls };
  } else {
    const urls = [...regularUrls];
    debugInfo.urlsTried = urls;
    return { urls, debugInfo, fetchAnimeUrlsFn: fetchAnimeUrls, regularUrls, animeUrls };
  }
}

async function fastScrape(browser, targetUrl, sharedState) {
  if (!browser) return null;
  if (sharedState && sharedState.resolved) return null;

  const page = await browser.newPage();
  if (sharedState) {
    sharedState.pages = sharedState.pages || [];
    sharedState.pages.push(page);
  }

  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (sharedState && sharedState.resolved) {
      req.abort().catch(() => {});
      return;
    }
    const type = req.resourceType();
    const url = req.url();
    // ইমেজ এবং ফন্ট ব্লক করি - কিন্তু সিএসএস, স্ক্রিপ্ট ও মিডিয়া সচল রাখি
    if (['image', 'font'].includes(type) || url.includes('analytics') || url.includes('doubleclick') || url.includes('ads')) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });

  return new Promise(async (resolve) => {
    let localResolved = false;

    page.on('response', async (response) => {
      if (sharedState && sharedState.resolved) {
        if (!localResolved) {
          localResolved = true;
          await page.close().catch(() => {});
          resolve(null);
        }
        return;
      }
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4') || u.includes('trailer');

      if (isMedia && !isFake && !localResolved) {
        localResolved = true;
        if (sharedState) {
          sharedState.resolved = true;
        }
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      if (sharedState && sharedState.resolved) {
        localResolved = true;
        await page.close().catch(() => {});
        return resolve(null);
      }
      // পেজ লোড হওয়ার জন্য ১০ সেকেন্ড সময় দিই
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch (navErr) {
        // Navigation timeout or network error - page may still have loaded frames
      }
      
      // Multi-frame play button click trigger to support deep-nested player iframes (Vidnest, Vidrock, Autoembed, etc.)
      const clickPlayAcrossFrames = async () => {
        if (localResolved || (sharedState && sharedState.resolved)) return;
        const frames = page.frames();
        for (const frame of frames) {
          try {
            await frame.evaluate(() => {
              const selectors = [
                'video', 'button', '#play', '.play-btn', '.jw-display-icon-container', 
                '.vjs-big-play-button', '.play-icon', '#player', '.iframe-player',
                '.play_btn', '.playButton', '.play-button', '[aria-label="Play"]',
                '.play', '.clickable', '.plyr__control--overlaid', 'div[role="button"]'
              ];
              for (const selector of selectors) {
                const els = document.querySelectorAll(selector);
                els.forEach(el => {
                  try {
                    el.click();
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  } catch (e) {}
                });
              }
            });
          } catch (e) {}
        }
      };

      // Poll and click across frames every 350ms
      for (let i = 0; i < 10; i++) {
        if (localResolved || (sharedState && sharedState.resolved)) break;
        await clickPlayAcrossFrames();
        await new Promise(r => setTimeout(r, 350));
      }
    } catch (e) {}

    // টোটাল স্ক্র্যাপার টাইমআউট ৮.৫ সেকেন্ড করা হলো
    setTimeout(async () => {
      if (!localResolved) {
        localResolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 8500);
  });
}

// ৪. সমান্তরাল রেজোলিউশন রেসার (Parallel Resolution Racer)
async function raceScrapeUrls(browser, urls) {
  if (!browser || !urls || urls.length === 0) return null;
  
  const sharedState = { resolved: false, pages: [] };
  
  // Stage 1: Try the first URL (usually Vidnest or direct high-speed provider)
  try {
    const firstUrl = urls[0];
    const streamUrl = await fastScrape(browser, firstUrl, sharedState);
    if (streamUrl) {
      // Clean up others just in case
      sharedState.resolved = true;
      if (sharedState.pages) {
        for (const p of sharedState.pages) {
          try { await p.close().catch(() => {}); } catch(err){}
        }
      }
      return { url: streamUrl, ref: firstUrl };
    }
  } catch (e) {
    console.error("Stage 1 race error:", e);
  }
  
  if (sharedState.resolved) return null;
  
  // Stage 2: Try the next 2 URLs in parallel (safe for memory & CPU)
  const nextUrls = urls.slice(1, 3);
  if (nextUrls.length > 0) {
    const promises = nextUrls.map(async (url) => {
      try {
        const streamUrl = await fastScrape(browser, url, sharedState);
        if (streamUrl) {
          return { url: streamUrl, ref: url };
        }
      } catch (e) {}
      return null;
    });
    
    const stage2Res = await new Promise((resolve) => {
      let completed = 0;
      let finished = false;
      promises.forEach(async (p) => {
        const res = await p;
        if (res && res.url && !finished) {
          finished = true;
          resolve(res);
        } else {
          completed++;
          if (completed === promises.length && !finished) {
            finished = true;
            resolve(null);
          }
        }
      });
      setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve(null);
        }
      }, 7000);
    });
    
    if (stage2Res) {
      sharedState.resolved = true;
      if (sharedState.pages) {
        for (const p of sharedState.pages) {
          try { await p.close().catch(() => {}); } catch(err){}
        }
      }
      return stage2Res;
    }
  }
  
  if (sharedState.resolved) return null;
  
  // Stage 3: Try remaining URLs in parallel as fallback
  const remainingUrls = urls.slice(3);
  if (remainingUrls.length > 0) {
    const promises = remainingUrls.map(async (url) => {
      try {
        const streamUrl = await fastScrape(browser, url, sharedState);
        if (streamUrl) {
          return { url: streamUrl, ref: url };
        }
      } catch (e) {}
      return null;
    });
    
    const stage3Res = await new Promise((resolve) => {
      let completed = 0;
      let finished = false;
      promises.forEach(async (p) => {
        const res = await p;
        if (res && res.url && !finished) {
          finished = true;
          resolve(res);
        } else {
          completed++;
          if (completed === promises.length && !finished) {
            finished = true;
            resolve(null);
          }
        }
      });
      setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve(null);
        }
      }, 7000);
    });
    
    if (stage3Res) {
      sharedState.resolved = true;
      if (sharedState.pages) {
        for (const p of sharedState.pages) {
          try { await p.close().catch(() => {}); } catch(err){}
        }
      }
      return stage3Res;
    }
  }
  
  // Final safety cleanup of any stray pages
  sharedState.resolved = true;
  if (sharedState.pages) {
    for (const p of sharedState.pages) {
      try { await p.close().catch(() => {}); } catch(err){}
    }
  }
  
  return null;
}

// ========================================================
// ৩. VIDSRC.SBS DEEP MULTI-LANG SCRAPER
// ========================================================
async function scrapeVidSrcMultiLang(browser, targetUrl, preferredServer = 'AwsPly') {
  if (!browser) return null;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  return new Promise(async (resolve) => {
    let resolved = false;

    page.on('response', async (response) => {
      const u = response.url();
      const isMedia = u.includes('.m3u8') || u.includes('/hls/') || (u.includes('.mp4') && !u.includes('google'));
      const isFake = u.includes('demo-video.mp4') || u.includes('demo.mp4') || u.includes('trailer');

      if (isMedia && !isFake && !resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(u);
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

      const triggerPlayback = async () => {
        const frames = [page.mainFrame(), ...page.frames()];
        for (const frame of frames) {
          try {
            await frame.evaluate((srvName) => {
              const btn = document.querySelector('video, button, #play, .play-btn, .jw-display-icon-container, .vjs-big-play-button');
              if (btn) btn.click();

              const allElements = Array.from(document.querySelectorAll('*'));
              const dropdown = allElements.find(el => {
                const t = (el.innerText || el.textContent || '').trim();
                return t.includes('Pro Multi') || t.includes('Server') || el.classList.contains('server-item');
              });
              if (dropdown) dropdown.click();

              const serverOption = allElements.find(el => {
                const t = (el.innerText || el.textContent || '').trim();
                return (
                  t.toLowerCase().includes(srvName.toLowerCase()) ||
                  t.includes('Multi-Lang') ||
                  t.includes('AwsPly') ||
                  t.includes('Nitro') ||
                  t.includes('VidHindi') ||
                  t.includes('VidEmd')
                );
              });
              if (serverOption) serverOption.click();
            }, preferredServer);
          } catch (e) {}
        }
      };

      await triggerPlayback();
      await new Promise(r => setTimeout(r, 1200));
      await triggerPlayback();

    } catch (e) {}

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 10000);
  });
}

function parseParams(query) {
  const targetId = query.id || query.tmdbId || query.tmdb_id || '27205';
  const typeStr = (query.type || query.media_type || 'movie').toLowerCase();
  const title = query.title || '';
  const isTv = typeStr === 'tv' || typeStr === 'series' || typeStr === 'anime';
  const season = parseInt(query.s || query.season || query.se || 1);
  const episode = parseInt(query.e || query.episode || query.ep || 1);
  const lang = (query.lang || (query.dub === 'true' ? 'dub' : 'sub')).toLowerCase();
  const malId = query.mal_id || query.malId;
  const anilistId = query.anilist_id || query.anilistId;
  const rawServer = query.server || query.srv || 'flixer';
  const server = String(rawServer).replace('vidnest-', '').replace('-pro', '').replace('-vip', '').replace('-sbs', '').replace('-xyz', '').toLowerCase();
  const isAnime = typeStr === 'anime' || query.isAnime === 'true' || query.is_anime === 'true' || query.genre === 'anime' || query.genre === 'animation';

  return { id: targetId, typeStr, isTv, season, episode, lang, malId, anilistId, title, server, isAnime };
}

// ========================================================
// ৪. মেইন RESOLVER API (100% Direct M3U8 / Expo Stream - No Iframe)
// ========================================================
async function handleResolveStream(req, res) {
  const params = parseParams(req.query);
  const hostUrl = getHostUrl(req);
  let activeDebugInfo = null;

  if (params.lang === 'dub') {
    const dubEmbed = await resolveDubStream(params);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: dubEmbed,
      rawUrl: dubEmbed,
      expoStreamUrl: dubEmbed,
      vlcStreamUrl: dubEmbed,
      server: params.server,
      lang: 'dub',
      type: params.typeStr,
      season: params.season,
      episode: params.episode
    });
  }

  const serverSlug = params.server || 'flixer';
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}_${serverSlug}`;
  const generalCacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;

  // Check cache for this server or general key
  const cached = streamCache.get(cacheKey) || streamCache.get(generalCacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    const streamProxyUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`;
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: streamProxyUrl,
      rawUrl: cached.url,
      proxy_stream_url: streamProxyUrl,
      stream_url: cached.url,
      expoStreamUrl: streamProxyUrl,
      vlcStreamUrl: streamProxyUrl,
      server: serverSlug,
      type: params.typeStr
    });
  }

  if (pendingScrapes.has(cacheKey)) {
    try {
      const result = await pendingScrapes.get(cacheKey);
      if (result) {
        const streamProxyUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`;
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: streamProxyUrl,
          rawUrl: result.url,
          proxy_stream_url: streamProxyUrl,
          stream_url: result.url,
          expoStreamUrl: streamProxyUrl,
          vlcStreamUrl: streamProxyUrl,
          server: serverSlug,
          type: params.typeStr
        });
      }
    } catch (e) {}
  }

  const scrapeTask = (async () => {
    let acquired = false;
    try {
      await acquireScrapeSlot();
      acquired = true;
      const browser = await getWarmBrowser();
      const { urls, debugInfo, fetchAnimeUrlsFn, animeUrls } = await getWebProviderUrls(params);
      activeDebugInfo = debugInfo;
      
      // ১. সমান্তরাল রেজোলিউশন রেসার দিয়ে স্ক্র্যাপ করি
      const raceResult = await raceScrapeUrls(browser, urls);
      if (raceResult && raceResult.url) {
        const data = { url: raceResult.url, ref: raceResult.ref, time: Date.now() };
        streamCache.set(cacheKey, data);
        streamCache.set(generalCacheKey, data);
        return data;
      }

      // ২. এনিমে ফলব্যাক লোড
      if (!params.isAnime) {
        await fetchAnimeUrlsFn();
        if (animeUrls && animeUrls.length > 0) {
          const fallbackResult = await raceScrapeUrls(browser, animeUrls);
          if (fallbackResult && fallbackResult.url) {
            const data = { url: fallbackResult.url, ref: fallbackResult.ref, time: Date.now() };
            streamCache.set(cacheKey, data);
            streamCache.set(generalCacheKey, data);
            return data;
          }
        }
      }

      return null;
    } catch (err) {
      activeDebugInfo = { error: err.message, stack: err.stack };
      return null;
    } finally {
      if (acquired) {
        releaseScrapeSlot();
      }
      pendingScrapes.delete(cacheKey);
    }
  })();

  pendingScrapes.set(cacheKey, scrapeTask);
  const finalResult = await scrapeTask;

  if (finalResult) {
    const streamProxyUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`;
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: streamProxyUrl,
      rawUrl: finalResult.url,
      proxy_stream_url: streamProxyUrl,
      stream_url: finalResult.url,
      expoStreamUrl: streamProxyUrl,
      vlcStreamUrl: streamProxyUrl,
      server: serverSlug,
      type: params.typeStr,
      debugInfo: activeDebugInfo
    });
  }

  // Fallback: Check if general cache has another server's stream
  const fallbackCached = streamCache.get(generalCacheKey);
  if (fallbackCached) {
    const streamProxyUrl = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(fallbackCached.url)}&referer=${encodeURIComponent(fallbackCached.ref)}`;
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: streamProxyUrl,
      rawUrl: fallbackCached.url,
      proxy_stream_url: streamProxyUrl,
      stream_url: fallbackCached.url,
      expoStreamUrl: streamProxyUrl,
      vlcStreamUrl: streamProxyUrl,
      server: serverSlug,
      type: params.typeStr
    });
  }

  // If no stream could be captured directly from this cluster, return informative direct stream proxy
  return res.status(404).json({
    success: false,
    isEmbed: false,
    error: 'Stream could not be scraped from this mirror. Please switch to another server (e.g. Flixer, Lambda, or Gamma).',
    server: serverSlug,
    type: params.typeStr,
    debugInfo: activeDebugInfo
  });
}

app.get(['/api/resolve-stream', '/api/v1/extract'], handleResolveStream);

// ডাইরেক্ট স্ট্রিম রিডাইরেক্ট রাউট
app.get('/api/v1/stream', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = getHostUrl(req);
  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;
  
  let targetStream = streamCache.get(cacheKey);
  if (!targetStream) {
    let acquired = false;
    try {
      await acquireScrapeSlot();
      acquired = true;
      const browser = await getWarmBrowser();
      const { urls } = await getWebProviderUrls(params);
      const raceResult = await raceScrapeUrls(browser, urls);
      if (raceResult && raceResult.url) {
        targetStream = { url: raceResult.url, ref: raceResult.ref, time: Date.now() };
        streamCache.set(cacheKey, targetStream);
      }
    } finally {
      if (acquired) {
        releaseScrapeSlot();
      }
    }
  }

  if (targetStream) {
    return res.redirect(`${hostUrl}/api/stream-proxy?url=${encodeURIComponent(targetStream.url)}&referer=${encodeURIComponent(targetStream.ref)}`);
  }
  return res.status(404).send('Stream not found.');
});

// ========================================================
// ৫. VIDSRC.SBS ডাইরেক্ট স্ক্র্যাপ এন্ডপয়েন্ট
// ========================================================
app.get('/api/vidsrc/scrape', async (req, res) => {
  const params = parseParams(req.query);
  const hostUrl = getHostUrl(req);
  const cacheKey = `vidsrc_${params.id}_${params.typeStr}_${params.season}_${params.episode}_${params.server}`;

  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      server: params.server,
      type: params.typeStr
    });
  }

  try {
    let streamUrl = null;
    let acquired = false;
    const targetUrl = params.isTv
      ? `https://vidsrc.sbs/embed/tv/${params.id}/${params.season}/${params.episode}`
      : `https://vidsrc.sbs/embed/movie/${params.id}`;

    try {
      await acquireScrapeSlot();
      acquired = true;
      const browser = await getWarmBrowser();
      streamUrl = await scrapeVidSrcMultiLang(browser, targetUrl, params.server);
    } finally {
      if (acquired) {
        releaseScrapeSlot();
      }
    }

    if (streamUrl) {
      streamCache.set(cacheKey, { url: streamUrl, ref: targetUrl, time: Date.now() });
      return res.json({
        success: true,
        isEmbed: false,
        streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`,
        rawUrl: streamUrl,
        server: params.server,
        type: params.typeStr
      });
    }

    return res.json({
      success: true,
      isEmbed: true,
      streamUrl: targetUrl,
      embedUrl: targetUrl,
      server: params.server,
      type: params.typeStr
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// টোকেন ও রিলেটিভ পাথ রিজলভার হেল্পার
function resolveChunkWithToken(chunk, parentUrlObj) {
  try {
    let resolved;
    if (chunk.startsWith('http://') || chunk.startsWith('https://')) {
      resolved = new URL(chunk);
    } else {
      resolved = new URL(chunk, parentUrlObj.href);
    }
    // প্যারেন্ট M3U8-এর টোকেন সেগমেন্টে ইনহেরিট করা
    if (!resolved.search && parentUrlObj.search) {
      resolved.search = parentUrlObj.search;
    }
    return resolved.href;
  } catch (e) {
    return chunk;
  }
}

// ========================================================
// ৬. টোকেন-প্রিজার্ভিং মিডিয়া টানেল প্রক্সি
// ========================================================
async function pipeMediaTunnel(req, res, targetUrl, referer) {
  try {
    // We keep targetUrl as is (already single decoded by Express).
    // If it contains double encoded starts like http%3A%2F%2F, decode it once.
    let cleanUrl = targetUrl;
    if (cleanUrl.startsWith('http%3A%2F%2F') || cleanUrl.startsWith('https%3A%2F%2F')) {
      cleanUrl = decodeURIComponent(cleanUrl);
    }

    let parsedHeaders = {};

    // Robust unwrapping of any remote proxy wrappers to fetch directly from unblocked CDN
    let prevUrl = "";
    while (cleanUrl !== prevUrl) {
      prevUrl = cleanUrl;
      if (cleanUrl.includes('proxy?url=') || cleanUrl.includes('ts-proxy?url=')) {
        try {
          const parsedUrl = new URL(cleanUrl);
          const innerHeaders = parsedUrl.searchParams.get('headers');
          if (innerHeaders) {
            try {
              const decodedHeaders = JSON.parse(decodeURIComponent(innerHeaders));
              parsedHeaders = { ...parsedHeaders, ...decodedHeaders };
            } catch (eh) {
              try {
                const directHeaders = JSON.parse(innerHeaders);
                parsedHeaders = { ...parsedHeaders, ...directHeaders };
              } catch (err) {}
            }
          }
          const innerUrl = parsedUrl.searchParams.get('url');
          if (innerUrl) {
            cleanUrl = decodeURIComponent(innerUrl);
          }
        } catch (e) {
          const match = cleanUrl.match(/(?:ts-)?proxy\?url=([^&]+)/);
          if (match && match[1]) {
            cleanUrl = decodeURIComponent(match[1]);
          }
          const headersMatch = cleanUrl.match(/headers=([^&]+)/);
          if (headersMatch && headersMatch[1]) {
            try {
              const decodedHeaders = JSON.parse(decodeURIComponent(headersMatch[1]));
              parsedHeaders = { ...parsedHeaders, ...decodedHeaders };
            } catch (eh) {}
          }
        }
      }
    }

    const targetUrlObj = new URL(cleanUrl);
    const domain = targetUrlObj.origin;
    const ref = referer ? decodeURIComponent(referer) : domain;
    const proxyBase = '/api/stream-proxy';

    // Extract and parse custom headers encoded in query parameter if present
    const headersParam = req.query.headers || targetUrlObj.searchParams.get('headers');
    if (headersParam) {
      try {
        const decodedHeaders = JSON.parse(decodeURIComponent(headersParam));
        parsedHeaders = { ...parsedHeaders, ...decodedHeaders };
      } catch (e) {
        try {
          const directHeaders = JSON.parse(headersParam);
          parsedHeaders = { ...parsedHeaders, ...directHeaders };
        } catch (err) {
          console.error("Error parsing headers parameter inside proxy:", err);
        }
      }
    }

    if (req.query.headers) {
      try {
        const queryHeaders = JSON.parse(decodeURIComponent(req.query.headers));
        parsedHeaders = { ...parsedHeaders, ...queryHeaders };
      } catch (e) {
        try {
          const directQueryHeaders = JSON.parse(req.query.headers);
          parsedHeaders = { ...parsedHeaders, ...directQueryHeaders };
        } catch (err) {}
      }
    }

    const headersParamStr = parsedHeaders ? JSON.stringify(parsedHeaders) : '';
    const headersQuery = headersParamStr ? `&headers=${encodeURIComponent(headersParamStr)}` : '';

    // Prepare case-insensitive request headers
    const requestHeaders = {
      'referer': ref,
      'origin': ref.replace(/\/$/, ''),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    if (parsedHeaders) {
      for (const [k, v] of Object.entries(parsedHeaders)) {
        requestHeaders[k.toLowerCase()] = v;
      }
    }

    if (req.headers.range) {
      requestHeaders['range'] = req.headers.range;
    }

    // ক্রোম ব্রাউজার ট্যাবে সরাসরি লিঙ্ক খুললে অটো-প্লেয়ার প্রদান
    const acceptHeader = req.headers['accept'] || '';
    if (acceptHeader.includes('text/html') && !req.headers.range && !cleanUrl.includes('.ts') && !req.query.raw) {
      const htmlPlayer = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Stream Preview</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { margin:0; background:#000; display:flex; align-items:center; justify-content:center; height:100vh; overflow:hidden; }
    video { width:100%; height:100%; object-fit:contain; }
  </style>
</head>
<body>
  <video id="v" controls autoplay playsinline></video>
  <script>
    const v = document.getElementById('v');
    const src = "${proxyBase}?url=${encodeURIComponent(cleanUrl)}&referer=${encodeURIComponent(ref)}&raw=1${headersQuery}";
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(()=>{}));
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    }
  </script>
</body>
</html>`;
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(htmlPlayer);
    }

    const isM3u8Url = cleanUrl.toLowerCase().includes('.m3u8') || cleanUrl.toLowerCase().includes('playlist');

    if (!isM3u8Url) {
      // Direct binary streaming bypass to prevent memory bloating / Out Of Memory
      try {
        const response = await axios({
          method: 'GET',
          url: cleanUrl,
          responseType: 'stream',
          headers: requestHeaders,
          timeout: 25000
        });

        let contentType = response.headers['content-type'] || 'video/mp2t';
        if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
          contentType = cleanUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
        }

        res.set({
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Accept-Ranges': 'bytes',
          ...(response.headers['content-range'] ? { 'Content-Range': response.headers['content-range'] } : {}),
          ...(response.headers['content-length'] ? { 'Content-Length': response.headers['content-length'] } : {})
        });

        if (response.status) {
          res.status(response.status);
        }

        response.data.pipe(res);
        response.data.on('error', () => {
          res.end();
        });
        return;
      } catch (streamErr) {
        return res.status(502).send('Stream Tunnel Gateway Error');
      }
    }

    const response = await axios({
      method: 'GET',
      url: cleanUrl,
      responseType: 'arraybuffer',
      headers: requestHeaders,
      timeout: 25000
    });

    const buffer = Buffer.from(response.data);
    const textPreview = buffer.slice(0, 500).toString('utf8');
    const isM3u8 = textPreview.includes('#EXTM3U') || textPreview.includes('#EXT-X-');

    if (isM3u8) {
      const utf8Text = buffer.toString('utf8');
      const lines = utf8Text.split('\n');

      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // AES-128 কী এবং সাব-প্লেলিস্ট টোকেন হ্যান্ডলার
        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
              const absKey = resolveChunkWithToken(p1, targetUrlObj);
              return `URI="${proxyBase}?url=${encodeURIComponent(absKey)}&referer=${encodeURIComponent(ref)}${headersQuery}"`;
            });
          }
          return line;
        }

        // সেগমেন্ট লিঙ্ক রিরাইটিং ও টোকেন ধরে রাখা
        const absChunk = resolveChunkWithToken(trimmed, targetUrlObj);
        return `${proxyBase}?url=${encodeURIComponent(absChunk)}&referer=${encodeURIComponent(ref)}${headersQuery}`;
      }).join('\n');

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      return res.send(rewritten);
    }

    let contentType = response.headers['content-type'] || 'video/mp2t';
    if (contentType.includes('image') || contentType.includes('text/html') || contentType.includes('octet-stream')) {
      contentType = cleanUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t';
    }

    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Accept-Ranges': 'bytes'
    });

    return res.send(buffer);
  } catch (error) {
    res.status(502).send('Stream Tunnel Gateway Error: ' + error.message);
  }
}

app.get(['/api/stream-proxy', '/api/proxy-stream'], async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL missing');
  return pipeMediaTunnel(req, res, url, referer || '');
});

// ========================================================
// 🎬 TMDB API PROXY ENDPOINTS (CORS-Bypassed Gateway)
// ========================================================
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'a359b11d9aa4c4803d25ef86cf7fb19c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

async function fetchTmdb(endpoint, queryParams = {}) {
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    ...queryParams
  });
  const url = `${TMDB_BASE_URL}${endpoint}?${params.toString()}`;
  const response = await axios.get(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    timeout: 12000
  });
  return response.data;
}

app.get('/api/tmdb/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const timeWindow = req.query.time || 'day';
    const data = await fetchTmdb(`/trending/all/${timeWindow}`, { page });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/popular-movies', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const data = await fetchTmdb('/movie/popular', { page });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/popular-tv', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const data = await fetchTmdb('/tv/popular', { page });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/top-rated', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const data = await fetchTmdb('/movie/top_rated', { page });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/discover', async (req, res) => {
  try {
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const genre = req.query.genre || '';
    const page = parseInt(req.query.page) || 1;
    const params = { page, sort_by: 'popularity.desc' };
    if (genre) params.with_genres = genre;
    const data = await fetchTmdb(`/discover/${type}`, params);
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/search', async (req, res) => {
  try {
    const query = req.query.query || '';
    const page = parseInt(req.query.page) || 1;
    if (!query) return res.json({ results: [], page: 1, total_pages: 0 });
    const data = await fetchTmdb('/search/multi', { query, page });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/details', async (req, res) => {
  try {
    const id = req.query.id;
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    if (!id) return res.status(400).json({ error: 'Missing ID' });
    const data = await fetchTmdb(`/${type}/${id}`, { append_to_response: 'credits,recommendations,similar,videos' });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/tmdb/tv-season', async (req, res) => {
  try {
    const id = req.query.id;
    const season = parseInt(req.query.season) || 1;
    if (!id) return res.status(400).json({ error: 'Missing ID' });
    const data = await fetchTmdb(`/tv/${id}/season/${season}`, {});
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ========================================================
// 🎛️ MULTI-SERVER REGISTRY API (VidNest & Cloud Mirrors)
// ========================================================
app.get('/api/servers', async (req, res) => {
  const { id, type = 'movie', season = '1', episode = '1', title = '' } = req.query;
  if (!id) return res.status(400).json({ success: false, error: 'Missing id parameter' });
  const isTv = type === 'tv' || type === 'series';
  const hostUrl = getHostUrl(req);
  const cacheKey = `${id}_${isTv ? 'tv' : 'movie'}_${season}_${episode}`;

  // Check if direct scraped M3U8 is already available in cache
  let directM3U8Url = null;
  const cachedStream = streamCache.get(cacheKey);
  if (cachedStream && Date.now() - cachedStream.time < CACHE_TTL) {
    directM3U8Url = `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cachedStream.url)}&referer=${encodeURIComponent(cachedStream.ref)}`;
  }

  const isImdb = String(id).startsWith('tt');
  const vidnestPath = isTv ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
  const autoembedPath = isTv ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
  const vidsrcPath = isTv ? `tv/${id}/${season}/${episode}` : `movie/${id}`;

  const servers = [
    {
      id: 'flixer',
      name: 'VidNest (Flixer)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Primary HD',
      quality: '1080p',
      status: 'active',
      isDefault: true,
      description: 'Ultra fast VidNest Flixer cluster with adaptive bitrate (Direct M3U8 / Expo)'
    },
    {
      id: 'lambda',
      name: 'VidNest (Lambda)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Fast VIP',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'High-speed cloud server with instant start (Direct M3U8 / Expo)'
    },
    {
      id: 'gamma',
      name: 'VidNest (Gamma)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Cloud Global',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'Primary VidNest global distribution node (Direct M3U8 / Expo)'
    },
    {
      id: 'sigma',
      name: 'VidNest (Sigma)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Multi-Audio',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'Multi-language audio tracks & subtitle selector (Direct M3U8 / Expo)'
    },
    {
      id: 'delta',
      name: 'VidNest (Delta)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Direct CDN',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'Direct stream CDN node (Direct M3U8 / Expo)'
    },
    {
      id: 'anikoto',
      name: 'VidNest (Anime)',
      provider: 'VidNest',
      type: 'stream',
      badge: 'Anime Dub/Sub',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'VidNest specialized anime & animation stream cluster'
    },
    {
      id: 'autoembed',
      name: 'AutoEmbed VIP',
      provider: 'AutoEmbed',
      type: 'stream',
      badge: 'VIP Server',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'Ultra stable multi-source cloud fallback (Direct M3U8 / Expo)'
    },
    {
      id: 'vidrock',
      name: 'VidRock Mirror',
      provider: 'VidRock',
      type: 'stream',
      badge: 'Fast Mirror',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'High availability media streaming (Direct M3U8 / Expo)'
    },
    {
      id: 'vidsrc',
      name: 'VidSrc Multi',
      provider: 'VidSrc',
      type: 'stream',
      badge: 'Multi-Lang',
      quality: '1080p',
      status: 'active',
      isDefault: false,
      description: 'Multi-lingual audio & subtitle streams (Direct M3U8 / Expo)'
    }
  ];

  res.json({
    success: true,
    target: { id, type: isTv ? 'tv' : 'movie', season, episode, title },
    hasDirectM3u8: !!directM3U8Url,
    directM3U8Url,
    activeServerId: 'flixer',
    servers
  });
});

// ========================================================
// ⏰ 24/7 KEEP-ALIVE & HEALTH ENDPOINTS
// ========================================================
app.get('/ping', (req, res) => {
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-KeepAlive-Response': 'true'
  });
  if (req.query.json === 'true' || req.query.json === '1') {
    return res.json({
      status: 'pong',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - keepAliveState.startTime) / 1000)
    });
  }
  return res.status(200).send('pong');
});

app.get(['/health', '/api/health'], (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - keepAliveState.startTime) / 1000),
    uptimeFormatted: formatUptime(Math.floor((Date.now() - keepAliveState.startTime) / 1000)),
    memoryUsageMb: {
      rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100
    },
    keepAlive: {
      enabled: keepAliveState.enabled,
      intervalMinutes: keepAliveState.intervalMinutes,
      targetUrl: getActiveKeepAliveUrl(),
      configuredUrl: keepAliveState.configuredUrl || null,
      autoDetectedUrl: keepAliveState.autoDetectedUrl || null,
      totalPings: keepAliveState.totalPings,
      successfulPings: keepAliveState.successfulPings,
      failedPings: keepAliveState.failedPings,
      lastPingStatus: keepAliveState.lastPingStatus,
      lastPingTime: keepAliveState.lastPingTime ? new Date(keepAliveState.lastPingTime).toISOString() : null,
      lastPingDurationMs: keepAliveState.lastPingDurationMs,
      nextPingInSeconds: keepAliveState.nextPingTime ? Math.max(0, Math.round((keepAliveState.nextPingTime - Date.now()) / 1000)) : 0
    }
  });
});

app.get(['/api/keepalive', '/api/keepalive/status'], (req, res) => {
  res.json({
    success: true,
    data: {
      ...keepAliveState,
      targetUrl: getActiveKeepAliveUrl(),
      activePort: process.env.PORT || 3000,
      uptimeSeconds: Math.floor((Date.now() - keepAliveState.startTime) / 1000),
      uptimeFormatted: formatUptime(Math.floor((Date.now() - keepAliveState.startTime) / 1000)),
      nextPingInSeconds: keepAliveState.nextPingTime ? Math.max(0, Math.round((keepAliveState.nextPingTime - Date.now()) / 1000)) : 0
    }
  });
});

app.all(['/api/keepalive/ping', '/api/ping-trigger'], async (req, res) => {
  const result = await executeKeepAlivePing(true);
  res.json({
    success: result.success,
    message: result.success ? 'Keep-alive ping sent successfully!' : 'Keep-alive ping encountered an error',
    pingResult: result,
    keepAliveSummary: {
      totalPings: keepAliveState.totalPings,
      lastPingTime: new Date(keepAliveState.lastPingTime).toISOString(),
      targetUrl: getActiveKeepAliveUrl()
    }
  });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ========================================================
// 🖥️ MOVIE WEBSITE & 24/7 MONITOR ROUTES
// ========================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/monitor', '/keepalive', '/api/keepalive/dashboard'], (req, res) => {
  const hostUrl = getHostUrl(req);
  const targetUrl = getActiveKeepAliveUrl();
  const uptimeSec = Math.floor((Date.now() - keepAliveState.startTime) / 1000);
  const uptimeStr = formatUptime(uptimeSec);
  const mem = process.memoryUsage();
  const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);

  const html = `<!DOCTYPE html>
<html lang="bn" class="h-full bg-slate-900 text-slate-100">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Universal Stream Scraper & 24/7 Keep-Alive Engine</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', 'Hind Siliguri', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="min-h-full flex flex-col bg-slate-950 text-slate-100 antialiased selection:bg-emerald-500 selection:text-slate-950">
  
  <!-- Navigation Header -->
  <header class="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
          <svg class="w-6 h-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div>
          <h1 class="font-bold text-slate-100 text-lg leading-tight flex items-center gap-2">
            Universal Stream Scraper
            <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">24/7 Online</span>
          </h1>
          <p class="text-xs text-slate-400">Render.com Sleep-Prevention & Auto-Ping Engine</p>
        </div>
      </div>
      
      <div class="flex items-center gap-3">
        <button id="pingNowBtn" onclick="triggerManualPing()" class="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-semibold px-3.5 py-2 rounded-lg shadow-sm transition-all">
          <svg id="pingIcon" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span id="pingBtnText">Ping Now</span>
        </button>
        <a href="/health" target="_blank" class="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800/80 border border-slate-700/60 px-3 py-2 rounded-lg transition-colors">
          <span>Health JSON</span>
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </a>
      </div>
    </div>
  </header>

  <!-- Main Container -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
    
    <!-- Hero Status Banner -->
    <div class="bg-gradient-to-r from-emerald-950/40 via-slate-900 to-cyan-950/40 border border-emerald-500/20 rounded-2xl p-6 relative overflow-hidden shadow-xl">
      <div class="absolute -right-12 -bottom-12 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"></div>
      
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
        <div class="space-y-2">
          <div class="flex items-center gap-2.5">
            <span class="relative flex h-3 w-3">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span class="text-xs uppercase tracking-wider text-emerald-400 font-bold">24/7 Keep-Alive Auto-Ping Active</span>
          </div>
          <h2 class="text-2xl font-extrabold text-white tracking-tight">
            রেন্ডার স্লিপ প্রিভেনশন সিস্টেম সক্রিয় আছে
          </h2>
          <p class="text-sm text-slate-300 max-w-2xl leading-relaxed">
            Render.com-এর ফ্রি সার্ভার ১৫ মিনিট কোনো রিকোয়েস্ট না পেলে স্লিপ মোডে চলে যায়। আপনার সার্ভারটি প্রতি <strong>${keepAliveState.intervalMinutes} মিনিট</strong> পরপর স্বয়ংক্রিয়ভাবে সেলফ-পিং পাঠিয়ে সার্ভারকে <strong>২৪x৭ সম্পূর্ণ সজাগ (Awake)</strong> রাখবে।
          </p>
        </div>

        <!-- Next Ping Countdown Box -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-4 min-w-[240px] flex flex-col items-center justify-center text-center shadow-inner">
          <span class="text-xs text-slate-400 font-medium">পরবর্তী স্বয়ংক্রিয় পিং</span>
          <div id="countdownTimer" class="text-3xl font-mono font-bold text-emerald-400 my-1">
            --:--
          </div>
          <span class="text-[11px] text-slate-500">ইন্টারভাল: প্রতি ${keepAliveState.intervalMinutes} মিনিট</span>
        </div>
      </div>
    </div>

    <!-- Live Metrics Grid -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      
      <!-- Metric 1: Target URL -->
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span>Target Ping Host</span>
          <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
        </div>
        <div class="font-mono text-sm font-semibold text-slate-200 truncate" id="targetUrlDisplay" title="${targetUrl}">
          ${targetUrl}
        </div>
        <span class="text-[11px] text-emerald-400/90 mt-2 flex items-center gap-1">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          ${keepAliveState.configuredUrl ? 'Custom / Render Env' : 'Auto-Detected / Local'}
        </span>
      </div>

      <!-- Metric 2: Total Pings -->
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span>Total Pings Sent</span>
          <svg class="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
        </div>
        <div class="text-2xl font-bold text-slate-100 font-mono" id="totalPingsCount">
          ${keepAliveState.totalPings}
        </div>
        <span class="text-[11px] text-slate-400 mt-2">
          সফল: <strong class="text-emerald-400" id="successPingsCount">${keepAliveState.successfulPings}</strong> | ব্যর্থ: <strong class="text-rose-400" id="failedPingsCount">${keepAliveState.failedPings}</strong>
        </span>
      </div>

      <!-- Metric 3: Latency -->
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span>Last Ping Latency</span>
          <svg class="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </div>
        <div class="text-2xl font-bold text-slate-100 font-mono" id="lastLatencyDisplay">
          ${keepAliveState.lastPingDurationMs !== null ? `${keepAliveState.lastPingDurationMs} ms` : 'Standby'}
        </div>
        <span class="text-[11px] text-slate-400 mt-2" id="lastPingStatusBadge">
          স্ট্যাটাস: <span class="text-emerald-400 font-semibold">${keepAliveState.lastPingStatus.toUpperCase()}</span>
        </span>
      </div>

      <!-- Metric 4: Uptime -->
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span>Server Uptime / Memory</span>
          <svg class="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" /></svg>
        </div>
        <div class="text-2xl font-bold text-slate-100 font-mono" id="uptimeDisplay">
          ${uptimeStr}
        </div>
        <span class="text-[11px] text-slate-400 mt-2">
          Heap: <strong class="text-slate-200">${heapUsedMb} MB</strong>
        </span>
      </div>

    </div>

    <!-- Instructions & Configuration Guide -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      
      <!-- Guide Card: Render Setup -->
      <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
        <div class="flex items-center gap-2 text-emerald-400 font-bold text-base">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span>Render.com-এ ২৪/৭ চালু রাখার নির্দেশিকা</span>
        </div>
        
        <ul class="text-xs sm:text-sm text-slate-300 space-y-3 leading-relaxed">
          <li class="flex items-start gap-2">
            <span class="text-emerald-400 font-bold mt-0.5">১.</span>
            <span><strong>স্বয়ংক্রিয় সেটআপ:</strong> Render-এ ডেপ্লয় করলে Render স্বয়ংক্রিয়ভাবে <code>RENDER_EXTERNAL_URL</code> এনভায়রনমেন্ট ভেরিয়েবল সরবরাহ করে। আমাদের কোড এটি নিজে থেকেই ডিটেক্ট করে নেয়।</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="text-emerald-400 font-bold mt-0.5">২.</span>
            <span><strong>এনভায়রনমেন্ট ভেরিয়েবল (ঐচ্ছিক):</strong> Render ড্যাশবোর্ডের <em>Environment</em> সেকশনে চাইলে <code>PING_URL=https://your-service.onrender.com</code> এবং <code>PING_INTERVAL_MINUTES=8</code> সেট করে দিতে পারেন।</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="text-emerald-400 font-bold mt-0.5">৩.</span>
            <span><strong>এক্সটার্নাল ব্যাকআপ (১০০% গ্যারান্টি):</strong> আরো ১০০% নিশ্চিত থাকার জন্য বিনামূল্যে <a href="https://uptimerobot.com" target="_blank" class="text-emerald-400 underline font-semibold">UptimeRobot.com</a> বা <a href="https://cron-job.org" target="_blank" class="text-emerald-400 underline font-semibold">Cron-Job.org</a>-এ গিয়ে আপনার <code>https://your-app.onrender.com/ping</code> লিঙ্কটি প্রতি ৫ মিনিটে মনিটর করতে দিয়ে রাখতে পারেন।</span>
          </li>
        </ul>
      </div>

      <!-- Quick API Reference Card -->
      <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
        <div class="flex items-center gap-2 text-cyan-400 font-bold text-base">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          <span>গুরুত্বপূর্ণ API এন্ডপয়েন্টসমূহ</span>
        </div>

        <div class="space-y-2.5 text-xs font-mono">
          <div class="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800/80 flex items-center justify-between">
            <span class="text-emerald-400 font-bold">GET /ping</span>
            <span class="text-slate-400 text-[11px]">লাইটওয়েট কিপ-অ্যালাইভ পিং</span>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800/80 flex items-center justify-between">
            <span class="text-cyan-400 font-bold">GET /health</span>
            <span class="text-slate-400 text-[11px]">সার্ভার হেলথ ও মেমরি স্ট্যাটাস</span>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800/80 flex items-center justify-between">
            <span class="text-purple-400 font-bold">GET /api/keepalive/status</span>
            <span class="text-slate-400 text-[11px]">পিং হিস্টোরি ও টাইমার ডেটা</span>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800/80 flex items-center justify-between">
            <span class="text-amber-400 font-bold">GET /api/resolve-stream</span>
            <span class="text-slate-400 text-[11px]">হাই-স্পিড মিডিয়া রেজলভার</span>
          </div>
        </div>
      </div>

    </div>

    <!-- Live Ping History Section -->
    <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="font-bold text-slate-100 text-sm flex items-center gap-2">
          <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          সর্বশেষ পিং লগ (Live Keep-Alive Activity)
        </h3>
        <span class="text-xs text-slate-500 font-mono" id="lastUpdated">আপডেট হচ্ছে...</span>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800 bg-slate-950/40">
            <tr>
              <th class="py-2.5 px-3">সময়</th>
              <th class="py-2.5 px-3">স্ট্যাটাস</th>
              <th class="py-2.5 px-3">রেসপন্স কোড</th>
              <th class="py-2.5 px-3">ল্যাটেন্সি</th>
              <th class="py-2.5 px-3">টার্গেট লিঙ্ক</th>
              <th class="py-2.5 px-3">টাইপ</th>
            </tr>
          </thead>
          <tbody id="pingHistoryBody" class="divide-y divide-slate-800/60 font-mono">
            <!-- Dynamic rows will be inserted here -->
            <tr>
              <td colspan="6" class="py-4 text-center text-slate-500 font-sans">লগ লোড হচ্ছে...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-800/80 bg-slate-900/40 py-4 text-center text-xs text-slate-500">
    Universal Stream Scraper Engine &bull; Render 24/7 Sleep Prevention Keep-Alive Active
  </footer>

  <script>
    let nextPingTime = ${keepAliveState.nextPingTime || Date.now() + 30000};
    
    function updateCountdown() {
      const now = Date.now();
      const diffMs = nextPingTime - now;
      const el = document.getElementById('countdownTimer');
      if (!el) return;

      if (diffMs <= 0) {
        el.innerText = "00:00 (পিং চলছে...)";
      } else {
        const totalSec = Math.floor(diffMs / 1000);
        const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
        const s = (totalSec % 60).toString().padStart(2, '0');
        el.innerText = m + ":" + s;
      }
    }
    setInterval(updateCountdown, 1000);
    updateCountdown();

    async function fetchKeepAliveStatus() {
      try {
        const res = await fetch('/api/keepalive/status');
        const json = await res.json();
        if (json && json.data) {
          const d = json.data;
          if (d.nextPingTime) nextPingTime = d.nextPingTime;
          
          document.getElementById('totalPingsCount').innerText = d.totalPings;
          document.getElementById('successPingsCount').innerText = d.successfulPings;
          document.getElementById('failedPingsCount').innerText = d.failedPings;
          document.getElementById('targetUrlDisplay').innerText = d.targetUrl;
          document.getElementById('uptimeDisplay').innerText = d.uptimeFormatted;

          if (d.lastPingDurationMs !== null) {
            document.getElementById('lastLatencyDisplay').innerText = d.lastPingDurationMs + ' ms';
          }
          
          const badge = document.getElementById('lastPingStatusBadge');
          if (d.lastPingStatus === 'success') {
            badge.innerHTML = 'স্ট্যাটাস: <span class="text-emerald-400 font-semibold">SUCCESS (200 OK)</span>';
          } else if (d.lastPingStatus === 'failed') {
            badge.innerHTML = 'স্ট্যাটাস: <span class="text-rose-400 font-semibold">FAILED</span>';
          }

          renderHistory(d.history || []);
          document.getElementById('lastUpdated').innerText = 'আপডেট: ' + new Date().toLocaleTimeString();
        }
      } catch (e) {}
    }

    function renderHistory(list) {
      const tbody = document.getElementById('pingHistoryBody');
      if (!tbody) return;
      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-slate-500 font-sans">এখনও কোনো পিং রেকর্ড তৈরি হয়নি। পিং রানিং আছে...</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => {
        const isOk = item.status === 'success';
        const statusBadge = isOk 
          ? '<span class="inline-flex items-center gap-1 text-emerald-400"><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Success</span>'
          : '<span class="inline-flex items-center gap-1 text-rose-400"><span class="h-1.5 w-1.5 rounded-full bg-rose-400"></span> Error</span>';
        
        const dateStr = new Date(item.timestamp).toLocaleTimeString();
        return \`<tr class="hover:bg-slate-800/30 transition-colors">
          <td class="py-2.5 px-3 text-slate-300">\${dateStr}</td>
          <td class="py-2.5 px-3">\${statusBadge}</td>
          <td class="py-2.5 px-3 text-slate-300">\${item.statusCode || '-'}</td>
          <td class="py-2.5 px-3 text-slate-200 font-bold">\${item.durationMs !== undefined ? item.durationMs + 'ms' : '-'}</td>
          <td class="py-2.5 px-3 text-slate-400 truncate max-w-[200px]" title="\${item.url}">\${item.url}</td>
          <td class="py-2.5 px-3 text-slate-400 text-[11px]">\${item.manual ? '⚡ Manual' : '⏰ Auto'}</td>
        </tr>\`;
      }).join('');
    }

    async function triggerManualPing() {
      const btn = document.getElementById('pingNowBtn');
      const text = document.getElementById('pingBtnText');
      const icon = document.getElementById('pingIcon');

      btn.disabled = true;
      text.innerText = 'Pinging...';
      icon.classList.add('animate-spin');

      try {
        const res = await fetch('/api/keepalive/ping', { method: 'POST' });
        const result = await res.json();
        await fetchKeepAliveStatus();
      } catch (e) {
        alert('Ping error: ' + e.message);
      } finally {
        btn.disabled = false;
        text.innerText = 'Ping Now';
        icon.classList.remove('animate-spin');
      }
    }

    // Initial fetch & poll every 10 seconds
    fetchKeepAliveStatus();
    setInterval(fetchKeepAliveStatus, 10000);
  </script>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Active on ${PORT}`);
  startKeepAliveEngine();
});

