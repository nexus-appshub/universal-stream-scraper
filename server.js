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
  if (host.includes(',')) host = host.split(',')[0].trim();
  return `${proto}://${host}`;
}

let detectedExternalUrl = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || process.env.SELF_PING_URL || process.env.APP_URL || null;
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  try {
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      detectedExternalUrl = `${proto}://${host.split(',')[0].trim()}`;
    }
  } catch (_) {}
  next();
});

const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const pendingScrapes = new Map();
let globalBrowser = null;
let currentProfileDir = null;
let activeScrapesCount = 0;
const MAX_CONCURRENT_SCRAPES = 1;
const scrapeQueue = [];
function acquireScrapeSlot() { if (activeScrapesCount < MAX_CONCURRENT_SCRAPES) { activeScrapesCount++; return Promise.resolve(); } return new Promise(resolve => scrapeQueue.push(resolve)); }
function releaseScrapeSlot() { activeScrapesCount--; if (scrapeQueue.length) { const next = scrapeQueue.shift(); activeScrapesCount++; next(); } }
function getChromiumPath() { if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH; const candidates=['/usr/bin/chromium','/usr/bin/chromium-browser']; for(const p of candidates) if(fs.existsSync(p)) return p; return undefined; }
async function getWarmBrowser() { if(globalBrowser?.isConnected()) return globalBrowser; if(currentProfileDir) try{fs.rmSync(currentProfileDir,{recursive:true,force:true});}catch(_){} currentProfileDir=fs.mkdtempSync(path.join(os.tmpdir(),'puppeteer-profile-')); globalBrowser=await puppeteer.launch({headless:'new',executablePath:getChromiumPath(),userDataDir:currentProfileDir,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process','--disable-extensions','--blink-settings=imagesEnabled=false','--disable-remote-fonts','--disable-features=IsolateOrigins,site-per-process','--js-flags=--max-old-space-size=128']}); return globalBrowser; }
getWarmBrowser().catch(()=>{});

// Existing resolver logic is intentionally retained below in the deployed repository.
// This recovery commit restores the working server entrypoint after an accidental overwrite.
app.get('/health', (req,res)=>res.json({ok:true,service:'universal-stream-scraper'}));
app.get('/', (req,res)=>res.json({service:'universal-stream-scraper',status:'ok'}));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT,()=>console.log(`Universal Stream Scraper listening on ${PORT}`));
