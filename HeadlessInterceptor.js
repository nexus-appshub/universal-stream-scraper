const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const StreamResolver = require('./StreamResolver');

puppeteer.use(StealthPlugin());

class HeadlessInterceptor {
  constructor(options = {}) {
    this.browser = options.browser || null;
    this.executablePath = options.executablePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    this.timeout = options.timeout || 15000;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;

    this.browser = await puppeteer.launch({
      headless: 'new',
      executablePath: this.executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--blink-settings=imagesEnabled=false',
        '--disable-remote-fonts',
        '--disable-features=IsolateOrigins,site-per-process',
        '--js-flags=--max-old-space-size=128'
      ].filter(Boolean)
    });

    return this.browser;
  }

  async resolveEmbed(targetUrl) {
    if (!targetUrl) throw new Error('targetUrl is required');

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    let resolved = null;

    const finish = (streamUrl, response = null) => {
      if (!StreamResolver.isManifest(streamUrl) || resolved) return false;
      if (/trailer|demo/i.test(streamUrl)) return false;
      const request = response?.request?.();
      resolved = {
        streamUrl: StreamResolver.normalize(streamUrl),
        referer: response?.url?.() || request?.headers?.()?.referer || targetUrl,
        headers: request?.headers?.() || {}
      };
      return true;
    };

    try {
      await page.setViewport({ width: 1280, height: 720 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
      );

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.open = () => null;

        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const clone = response.clone();
            const text = await clone.text();
            if (/\.m3u8|\/hls\//i.test(text)) {
              window.__capturedStreamPayloads = window.__capturedStreamPayloads || [];
              window.__capturedStreamPayloads.push(text.slice(0, 1000000));
            }
          } catch (_) {}
          return response;
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__captureUrl = url;
          return originalOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener('load', function() {
            try {
              const text = typeof this.responseText === 'string' ? this.responseText : '';
              if (/\.m3u8|\/hls\//i.test(text)) {
                window.__capturedStreamPayloads = window.__capturedStreamPayloads || [];
                window.__capturedStreamPayloads.push(text.slice(0, 1000000));
              }
            } catch (_) {}
          });
          return originalSend.apply(this, args);
        };
      });

      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const type = request.resourceType();
        const url = request.url();
        if (['image', 'font'].includes(type) || /google-analytics|doubleclick|googlesyndication|facebook\.net/i.test(url)) {
          request.abort().catch(() => {});
        } else {
          request.continue().catch(() => {});
        }
      });

      page.on('response', async (response) => {
        if (resolved) return;
        const url = response.url();
        if (StreamResolver.isManifest(url)) {
          finish(url, response);
          return;
        }

        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        if (/json|javascript|text|ajax|source|stream/i.test(contentType) || /api|ajax|source|stream/i.test(url)) {
          try {
            const body = await response.text();
            const manifest = StreamResolver.extractManifestUrl(body);
            if (manifest) finish(manifest, response);
          } catch (_) {}
        }
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout }).catch(() => {});

      const selectors = [
        'video', '.jwplayer', '.plyr', '.vjs-player', '.player', '.play',
        '[aria-label*="play" i]', 'button[class*="play" i]', '.server',
        '.server-item', '[class*="server" i]'
      ];

      for (let i = 0; i < 10 && !resolved; i++) {
        for (const frame of page.frames()) {
          for (const selector of selectors) {
            try {
              const el = await frame.$(selector);
              if (el) await el.click({ delay: 20 }).catch(() => {});
            } catch (_) {}
          }
        }

        const payloads = await page.evaluate(() => window.__capturedStreamPayloads || []).catch(() => []);
        for (const payload of payloads) {
          const manifest = StreamResolver.extractManifestUrl(payload);
          if (manifest) finish(manifest);
        }

        if (resolved) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!resolved) throw new Error('No HLS manifest detected');
      return resolved;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}

module.exports = HeadlessInterceptor;
