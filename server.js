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
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  let host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  if (host.includes(',')) {
    host = host.split(',')[0].trim();
  }
  return `${proto}://${host}`;
}

// Auto-detect public domain for 24/7 self-pinging on Render / Cloud Run
let detectedExternalUrl = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || process.env.SELF_PING_URL || process.env.APP_URL || null;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);

  // Capture public domain dynamically from request headers
  try {
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const cleanHost = host.split(',')[0].trim();
      detectedExternalUrl = `${proto}://${cleanHost}`;
    }
  } catch (e) {}

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

  // Build regular TV/Movie URLs (instant)
  if (isTv) {
    regularUrls.push(
      `https://vidnest.fun/tv/${id}/${season}/${episode}`,
      `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.sbs/embed/tv/${id}/${season}/${episode}`,
      `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
      `https://vidrock.net/embed/tv/${id}/${season}/${episode}`
    );
  } else {
    regularUrls.push(
      `https://vidnest.fun/movie/${id}`,
      `https://player.autoembed.cc/embed/movie/${id}`,
      `https://vidsrc.sbs/embed/movie/${id}`,
      `https://vidrock.net/embed/movie/${id}`,
      `https://vidsrc.xyz/embed/movie?tmdb=${id}`
    );
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
      // পেজ লোড হওয়ার জন্য ৫ সেকেন্ড সময় দিই
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
      
      // Multi-frame play button click trigger to support deep-nested player iframes (Anikoto, Vidnest, Megacloud, etc.)
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
                '.play', '.clickable', '.plyr__control--overlaid'
              ];
              for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el) {
                  el.click();
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
              }
            });
          } catch (e) {}
        }
      };

      // Poll and click across frames every 400ms for 3.2 seconds
      for (let i = 0; i < 8; i++) {
        if (localResolved || (sharedState && sharedState.resolved)) break;
        await clickPlayAcrossFrames();
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (e) {}

    // টোটাল স্ক্র্যাপার টাইমআউট ৫ সেকেন্ড করা হলো
    setTimeout(async () => {
      if (!localResolved) {
        localResolved = true;
        await page.close().catch(() => {});
        resolve(null);
      }
    }, 5500);
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
  const server = query.server || 'AwsPly';
  const isAnime = typeStr === 'anime' || query.isAnime === 'true' || query.is_anime === 'true' || query.genre === 'anime' || query.genre === 'animation';

  return { id: targetId, typeStr, isTv, season, episode, lang, malId, anilistId, title, server, isAnime };
}

// ========================================================
// ৪. মেইন RESOLVER API
// ========================================================
async function handleResolveStream(req, res) {
  const params = parseParams(req.query);
  const hostUrl = getHostUrl(req);
  let activeDebugInfo = null;

  if (params.lang === 'dub') {
    const dubEmbed = await resolveDubStream(params);
    return res.json({
      success: true,
      isEmbed: true,
      streamUrl: dubEmbed,
      embedUrl: dubEmbed,
      lang: 'dub',
      type: params.typeStr,
      season: params.season,
      episode: params.episode
    });
  }

  const cacheKey = `${params.id}_${params.typeStr}_${params.season}_${params.episode}`;

  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      rawUrl: cached.url,
      proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(cached.url)}&referer=${encodeURIComponent(cached.ref)}`,
      stream_url: cached.url,
      type: params.typeStr
    });
  }

  if (pendingScrapes.has(cacheKey)) {
    try {
      const result = await pendingScrapes.get(cacheKey);
      if (result) {
        return res.json({
          success: true,
          isEmbed: false,
          streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          rawUrl: result.url,
          proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(result.ref)}`,
          stream_url: result.url,
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
      
      // ১. সমান্তরাল রেজোলিউশন রেসার (Parallel Resolution Racer) দিয়ে একসাথে সব লিংক স্ক্র্যাপ করি (ম্যাক্সিমাম স্পিড!)
      const raceResult = await raceScrapeUrls(browser, urls);
      if (raceResult && raceResult.url) {
        const data = { url: raceResult.url, ref: raceResult.ref, time: Date.now() };
        streamCache.set(cacheKey, data);
        return data;
      }

      // ২. যদি কোনো স্ট্রিম না পাওয়া যায় এবং এটি এনিমে ডিক্লেয়ার করা না হয়ে থাকে, তবে এনিমে ফলব্যাক লোড করি
      if (!params.isAnime) {
        console.log("No regular stream found. Trying lazy anime fallback search...");
        await fetchAnimeUrlsFn();
        if (animeUrls && animeUrls.length > 0) {
          const fallbackResult = await raceScrapeUrls(browser, animeUrls);
          if (fallbackResult && fallbackResult.url) {
            const data = { url: fallbackResult.url, ref: fallbackResult.ref, time: Date.now() };
            streamCache.set(cacheKey, data);
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
    return res.json({
      success: true,
      isEmbed: false,
      streamUrl: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      rawUrl: finalResult.url,
      proxy_stream_url: `${hostUrl}/api/stream-proxy?url=${encodeURIComponent(finalResult.url)}&referer=${encodeURIComponent(finalResult.ref)}`,
      stream_url: finalResult.url,
      type: params.typeStr,
      debugInfo: activeDebugInfo
    });
  }

  const fallbackEmbed = params.isTv 
    ? `https://player.autoembed.cc/embed/tv/${params.id}/${params.season}/${params.episode}`
    : `https://player.autoembed.cc/embed/movie/${params.id}`;

  return res.json({
    success: true,
    isEmbed: true,
    streamUrl: fallbackEmbed,
    embedUrl: fallbackEmbed,
    proxy_stream_url: fallbackEmbed,
    stream_url: fallbackEmbed,
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
    const proxyBase = `${getHostUrl(req)}/api/stream-proxy`;

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
// 24/7 Render Anti-Sleep & Self-Ping Keep-Alive Engine
// ========================================================
const keepAliveStats = {
  startedAt: new Date().toISOString(),
  totalPings: 0,
  successfulPings: 0,
  failedPings: 0,
  lastPingTime: null,
  lastPingStatus: 'initialized',
  lastPingTarget: null
};

async function performKeepAlivePing() {
  const targets = [];
  const port = process.env.PORT || 3000;

  // 1. External public URL (Render free tier sleeps on lack of external incoming traffic)
  if (detectedExternalUrl) {
    targets.push(`${detectedExternalUrl.replace(/\/+$/, '')}/api/ping`);
  }
  
  // 2. Local fallback loop
  targets.push(`http://127.0.0.1:${port}/api/ping`);

  keepAliveStats.totalPings++;
  keepAliveStats.lastPingTime = new Date().toISOString();

  for (const target of targets) {
    try {
      const response = await axios.get(target, {
        headers: {
          'User-Agent': 'Render-24-7-KeepAlive/1.0',
          'X-Keep-Alive': 'true'
        },
        timeout: 10000
      });
      if (response.status === 200) {
        keepAliveStats.successfulPings++;
        keepAliveStats.lastPingStatus = 'success (200 OK)';
        keepAliveStats.lastPingTarget = target;
        console.log(`[24/7 Keep-Alive] Ping SUCCESS -> ${target} (Uptime: ${Math.floor(process.uptime() / 60)}m, Ping #${keepAliveStats.totalPings})`);
        break;
      }
    } catch (err) {
      console.warn(`[24/7 Keep-Alive] Ping note for ${target}:`, err.message);
      keepAliveStats.failedPings++;
      keepAliveStats.lastPingStatus = `error: ${err.message}`;
    }
  }
}

function start247KeepAlive() {
  console.log('🚀 24/7 Render Anti-Sleep Keep-Alive Engine Activated!');
  // First ping after 20 seconds
  setTimeout(() => {
    performKeepAlivePing().catch(() => {});
  }, 20000);

  // Ping every 4 minutes (240,000 ms) — Render sleeps after 15m, so 4m guarantees 0 seconds downtime
  const PING_INTERVAL = 4 * 60 * 1000;
  setInterval(() => {
    performKeepAlivePing().catch(() => {});
  }, PING_INTERVAL);
}

// 24/7 Ping & Health Check Endpoints
app.get(['/api/ping', '/ping', '/api/health', '/health'], (req, res) => {
  res.json({
    status: 'ok',
    message: '🚀 24/7 High-Load Scraper Server is Awake and Active!',
    uptimeSeconds: Math.floor(process.uptime()),
    uptimeFormatted: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    timestamp: new Date().toISOString(),
    keepAlive: {
      totalPings: keepAliveStats.totalPings,
      successfulPings: keepAliveStats.successfulPings,
      lastPingTime: keepAliveStats.lastPingTime,
      lastPingStatus: keepAliveStats.lastPingStatus,
      detectedUrl: detectedExternalUrl
    }
  });
});

app.get('/api/keep-alive/status', (req, res) => {
  res.json({
    engine: '24/7 Render Anti-Sleep Engine',
    status: 'ACTIVE',
    serverUptime: `${Math.floor(process.uptime() / 60)} minutes`,
    detectedExternalUrl: detectedExternalUrl || 'Waiting for first request or RENDER_EXTERNAL_URL env var',
    stats: keepAliveStats,
    memoryUsage: process.memoryUsage()
  });
});

app.get('/api/keep-alive/trigger', async (req, res) => {
  await performKeepAlivePing();
  res.json({ message: 'Keep-alive ping executed manually', stats: keepAliveStats });
});

app.get('/', (req, res) => res.send('🚀 High-Load Universal Scraper Online (24/7 Keep-Alive Active)!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Active on ${PORT}`);
  start247KeepAlive();
});
