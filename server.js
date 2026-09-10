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
const getChromiumPath = () => process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const acquire = () => activeScrapesCount < MAX_CONCURRENT_SCRAPES ? (activeScrapesCount++, Promise.resolve()) : new Promise(r => scrapeQueue.push(r));
const release = () => { activeScrapesCount--; if(scrapeQueue.length){activeScrapesCount++;scrapeQueue.shift()();} };
async function getBrowser(){if(globalBrowser?.isConnected())return globalBrowser;globalBrowser=await puppeteer.launch({headless:'new',executablePath:getChromiumPath(),args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process','--disable-extensions','--blink-settings=imagesEnabled=false','--disable-remote-fonts']});return globalBrowser;}
function params(req){const q=req.query||{};return {id:String(q.id||''),type:String(q.type||'movie').toLowerCase(),isTv:['tv','series','show'].includes(String(q.type||'movie').toLowerCase()),season:Number(q.season||1),episode:Number(q.episode||1),title:q.title||'',url:q.url||''};}
async function resolveEmbed(url){const browser=await getBrowser();const interceptor=new HeadlessInterceptor({browser,executablePath:getChromiumPath(),timeout:18000});return interceptor.resolveEmbed(url);}
async function resolve(paramsObj){const key=JSON.stringify(paramsObj);const cached=streamCache.get(key);if(cached&&Date.now()-cached.ts<CACHE_TTL)return cached.value;if(pendingScrapes.has(key))return pendingScrapes.get(key);const work=(async()=>{await acquire();try{const urls=[];if(paramsObj.url)urls.push(paramsObj.url);if(paramsObj.id){if(paramsObj.isTv){urls.push(`https://vidsrc.to/embed/tv/${paramsObj.id}/${paramsObj.season}/${paramsObj.episode}`);urls.push(`https://vidsrc.me/embed/tv/${paramsObj.id}/${paramsObj.season}/${paramsObj.episode}`);}else{urls.push(`https://vidsrc.to/embed/movie/${paramsObj.id}`);urls.push(`https://vidsrc.me/embed/movie/${paramsObj.id}`);}}for(const u of urls){try{const r=await resolveEmbed(u);if(r?.url){const value={streamUrl:r.url,referer:r.referer||u,headers:r.headers||{},source:r.source||'network'};streamCache.set(key,{ts:Date.now(),value});return value;}}catch(e){console.error('resolver:',e.message)}}return null;}finally{release();}})();pendingScrapes.set(key,work);try{return await work}finally{pendingScrapes.delete(key)}}
app.use(cors());
app.get('/health',(req,res)=>res.json({ok:true,service:'universal-stream-scraper',browser:!!globalBrowser}));
app.get('/api/debug/extract',async(req,res)=>{try{const target=req.query.url;if(!target)return res.status(400).json({success:false,error:'url is required'});const result=await resolveEmbed(target);return res.json({success:!!result,...(result||{}),target});}catch(e){return res.status(500).json({success:false,error:e.message})}});
app.get('/api/v1/stream',async(req,res)=>{try{const p=params(req);if(!p.id&&!p.url)return res.status(400).send('Missing id or url');const result=await resolve(p);if(!result)return res.status(404).send('Stream not found.');return res.json({success:true,...result});}catch(e){console.error(e);res.status(500).send('Stream resolver error.')}});
app.get('/api/resolve',async(req,res)=>{try{const p=params(req);const result=await resolve(p);if(!result)return res.status(404).json({success:false,error:'Stream not found'});res.json({success:true,...result});}catch(e){res.status(500).json({success:false,error:e.message})}});
app.get('/',(req,res)=>res.json({service:'universal-stream-scraper',status:'ok',endpoints:['/health','/api/v1/stream','/api/resolve','/api/debug/extract']}));
app.listen(PORT,()=>console.log(`Universal Stream Scraper listening on ${PORT}`));
