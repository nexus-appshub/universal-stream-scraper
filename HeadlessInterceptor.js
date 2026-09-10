const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const StreamResolver = require('./StreamResolver');

puppeteer.use(StealthPlugin());

class HeadlessInterceptor {
  constructor(options = {}) {
    this.browser = options.browser || null;
    this.executablePath = options.executablePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    this.timeout = options.timeout || 30000;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await puppeteer.launch({
      headless: 'new',
      executablePath: this.executablePath,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--disable-extensions','--blink-settings=imagesEnabled=false','--disable-remote-fonts','--disable-features=IsolateOrigins,site-per-site','--js-flags=--max-old-space-size=128'].filter(Boolean)
    });
    return this.browser;
  }

  async resolveEmbed(targetUrl) {
    if (!targetUrl) throw new Error('targetUrl is required');
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    let resolved = null;
    const candidates = [];
    const seenCandidates = new Set();
    let responseCount = 0;
    let frameCount = 0;

    const addCandidate = (url, source, response = null) => {
      if (!url || typeof url !== 'string') return;
      const normalized = StreamResolver.normalize(url);
      if (!normalized || !StreamResolver.isManifest(normalized) || /trailer|demo/i.test(normalized) || seenCandidates.has(normalized)) return;
      seenCandidates.add(normalized);
      candidates.push({url:normalized,source,referer:response?.url?.()||targetUrl,contentType:response?.headers?.()['content-type']||null});
      if (!resolved) {
        const request = response?.request?.();
        resolved = {
          streamUrl: normalized,
          referer: response?.url?.() || request?.headers?.()?.referer || targetUrl,
          headers: request?.headers?.() || {},
          source
        };
      }
    };

    const inspectBody = (body, source, response = null) => {
      if (!body) return;
      const manifest = StreamResolver.extractManifestUrl(body);
      if (manifest) addCandidate(manifest, source, response);
    };

    try {
      await page.setViewport({width:1280,height:720});
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
        window.open=()=>null;
        window.__capturedStreamPayloads=[];
        const originalFetch=window.fetch;
        window.fetch=async(...args)=>{
          const response=await originalFetch(...args);
          try{const clone=response.clone();const text=await clone.text();if(/\.m3u8|\/hls\//i.test(text)||/\.m3u8|\/hls\//i.test(String(args[0]||'')))window.__capturedStreamPayloads.push({url:String(args[0]||''),body:text.slice(0,2000000)});}catch(_){}
          return response;
        };
        const originalOpen=XMLHttpRequest.prototype.open;
        const originalSend=XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open=function(method,url,...rest){this.__captureUrl=String(url||'');return originalOpen.call(this,method,url,...rest)};
        XMLHttpRequest.prototype.send=function(...args){this.addEventListener('load',function(){try{const text=typeof this.responseText==='string'?this.responseText:'';if(/\.m3u8|\/hls\//i.test(text)||/\.m3u8|\/hls\//i.test(this.__captureUrl||''))window.__capturedStreamPayloads.push({url:this.__captureUrl||'',body:text.slice(0,2000000)});}catch(_){} });return originalSend.apply(this,args)};
      });

      await page.setRequestInterception(true);
      page.on('request',request=>{
        const type=request.resourceType();
        const url=request.url();
        if(['image','font'].includes(type)||/google-analytics|doubleclick|googlesyndication|facebook\.net|hotjar/i.test(url)) request.abort().catch(()=>{});
        else request.continue().catch(()=>{});
      });

      page.on('response',async response=>{
        responseCount++;
        if(resolved) return;
        const url=response.url();
        const headers=response.headers();
        const contentType=String(headers['content-type']||'').toLowerCase();
        const resourceType=response.request().resourceType();
        if(StreamResolver.isManifest(url)||/mpegurl|vnd\.apple\.mpegurl|application\/x-mpegurl|x-mpegurl/i.test(contentType)){addCandidate(url,'network-response',response);return;}
        if(/json|javascript|text|ajax|source|stream/i.test(contentType)||/api|ajax|source|stream|playlist|manifest/i.test(url)||resourceType==='xhr'||resourceType==='fetch'){
          try{const body=await response.text();inspectBody(body,'network-body',response)}catch(_){}
        }
      });
      page.on('frameattached',()=>{frameCount++});

      await page.goto(targetUrl,{waitUntil:'domcontentloaded',timeout:this.timeout}).catch(()=>{});
      await new Promise(r=>setTimeout(r,1500));

      const selectors=['video','.jwplayer','.jw-icon-play','.plyr','.vjs-player','.player','.play','.play-button','.btn-play','[aria-label*="play" i]','button[class*="play" i]','[class*="play" i]','.server','.server-item','[class*="server" i]','[data-server]','[data-embed]','[data-url]'];
      for(let round=0;round<24&&!resolved;round++){
        for(const frame of page.frames()){
          for(const selector of selectors){
            try{const elements=await frame.$$(selector);for(const el of elements.slice(0,4))await el.click({delay:20}).catch(()=>{})}catch(_){}
          }
          try{await frame.evaluate(()=>{for(const video of Array.from(document.querySelectorAll('video'))){try{video.muted=true;video.play().catch(()=>{})}catch(_){}}})}catch(_){}
        }
        for(const frame of page.frames()){
          try{const payloads=await frame.evaluate(()=>window.__capturedStreamPayloads||[]);for(const payload of payloads){if(typeof payload==='string')inspectBody(payload,'page-hook');else{if(StreamResolver.isManifest(payload?.url))addCandidate(payload.url,'fetch-url');inspectBody(payload?.body,'fetch-xhr-body')}}}catch(_){}
        }
        if(resolved) break;
        await new Promise(r=>setTimeout(r,750));
      }

      if(!resolved){const error=new Error('No HLS manifest detected');error.diagnostics={targetUrl,responseCount,frameCount:page.frames().length,candidates:candidates.slice(0,20)};throw error}

      // Preserve the browser session state required by many tokenized CDNs.
      const cookies=await page.cookies().catch(()=>[]);
      const safeCookies=cookies.map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,secure:c.secure,httpOnly:c.httpOnly}));
      return {...resolved,cookies:safeCookies,diagnostics:{targetUrl,responseCount,frameCount:page.frames().length,candidates:candidates.slice(0,20)}};
    } finally { await page.close().catch(()=>{}); }
  }

  async close(){if(this.browser)await this.browser.close().catch(()=>{});this.browser=null}
}
module.exports=HeadlessInterceptor;
