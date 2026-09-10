const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
function getChromiumPath(){if(process.env.PUPPETEER_EXECUTABLE_PATH)return process.env.PUPPETEER_EXECUTABLE_PATH;for(const p of ['/usr/bin/chromium','/usr/bin/chromium-browser'])if(fs.existsSync(p))return p;return undefined;}
async function getWarmBrowser(){if(globalBrowser?.isConnected())return globalBrowser;globalBrowser=await puppeteer.launch({headless:'new',executablePath:getChromiumPath(),args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process','--disable-extensions','--blink-settings=imagesEnabled=false','--disable-remote-fonts']});return globalBrowser;}
function acquireScrapeSlot(){if(activeScrapesCount<MAX_CONCURRENT_SCRAPES){activeScrapesCount++;return Promise.resolve();}return new Promise(r=>scrapeQueue.push(r));}
function releaseScrapeSlot(){activeScrapesCount--;if(scrapeQueue.length){activeScrapesCount++;scrapeQueue.shift()();}}
async function deepResolve(url){const browser=await getWarmBrowser();const interceptor=new HeadlessInterceptor({browser,executablePath:getChromiumPath(),timeout:20000});return interceptor.resolveEmbed(url);}
function parseParams(req){const q=req.query||{};const type=String(q.type||'movie').toLowerCase();return{id:String(q.id||''),type,isTv:['tv','series','show'].includes(type),season:Number(q.season||1),episode:Number(q.episode||1),url:String(q.url||''),title:String(q.title||'')};}
function providerUrls(p){const out=[];if(p.url)out.push(p.url);if(p.id){if(p.isTv){out.push(`https://vidsrc.to/embed/tv/${p.id}/${p.season}/${p.episode}`);out.push(`https://vidsrc.me/embed/tv/${p.id}/${p.season}/${p.episode}`);}else{out.push(`https://vidsrc.to/embed/movie/${p.id}`);out.push(`https://vidsrc.me/embed/movie/${p.id}`);}}return [...new Set(out)];}
async function resolveStream(p){const key=JSON.stringify(p);const c=streamCache.get(key);if(c&&Date.now()-c.ts<CACHE_TTL)return c.value;if(pendingScrapes.has(key))return pendingScrapes.get(key);const job=(async()=>{await acquireScrapeSlot();try{for(const u of providerUrls(p)){try{const r=await deepResolve(u);if(r?.url){const v={streamUrl:r.url,referer:r.referer||u,headers:r.headers||{},source:r.source||'network'};streamCache.set(key,{ts:Date.now(),value:v});return v;}}catch(e){console.error(`deep resolver failed ${u}:`,e.message);}}return null;}finally{releaseScrapeSlot();}})();pendingScrapes.set(key,job);try{return await job}finally{pendingScrapes.delete(key);}}
app.use(cors({origin:'*',methods:['GET','POST','OPTIONS','HEAD'],allowedHeaders:'*'}));
app.get('/health',(req,res)=>res.json({ok:true,service:'universal-stream-scraper',browser:!!globalBrowser}));
app.get('/api/debug/extract',async(req,res)=>{try{if(!req.query.url)return res.status(400).json({success:false,error:'url is required'});const result=await deepResolve(String(req.query.url));res.json({success:!!result,target:req.query.url,...(result||{})});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/v1/stream',async(req,res)=>{try{const p=parseParams(req);if(!p.id&&!p.url)return res.status(400).send('Missing id or url');const result=await resolveStream(p);if(!result)return res.status(404).send('Stream not found.');res.json({success:true,...result});}catch(e){console.error('stream resolver error:',e);res.status(500).send('Stream resolver error.');}});
app.get('/api/resolve',async(req,res)=>{try{const p=parseParams(req);const result=await resolveStream(p);if(!result)return res.status(404).json({success:false,error:'Stream not found'});res.json({success:true,...result});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/',(req,res)=>res.json({service:'universal-stream-scraper',status:'ok',endpoints:['/health','/api/v1/stream','/api/resolve','/api/debug/extract']}));
getWarmBrowser().catch(e=>console.error('browser warmup:',e.message));
app.listen(PORT,()=>console.log(`Universal Stream Scraper listening on ${PORT}`));
