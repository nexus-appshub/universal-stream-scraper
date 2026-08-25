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

// ========================================================
// কাস্টম ACCESS DENIED HTML টেমপ্লেট
// ========================================================
const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied - HOME AIR TV</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Poppins', sans-serif;
    }
    body {
      background: radial-gradient(circle at top right, #fff5f0, #ffffff 60%, #fff0e6);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #333333;
      padding: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid rgba(255, 107, 0, 0.15);
      box-shadow: 0 20px 50px rgba(255, 107, 0, 0.12);
      border-radius: 28px;
      padding: 45px 35px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(90deg, #ff8800, #ff4500);
    }
    .header-logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      margin-bottom: 25px;
      transition: transform 0.2s ease;
    }
    .header-logo:hover {
      transform: scale(1.04);
    }
    .logo-icon {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #ff8800, #ff4500);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 15px rgba(255, 107, 0, 0.35);
    }
    .logo-icon svg {
      width: 22px;
      height: 22px;
      fill: #ffffff;
      margin-left: 3px;
    }
    .logo-text {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.5px;
      background: linear-gradient(90deg, #ff5500, #ff8800);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .badge {
      background: #ff5500;
      color: white;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 6px;
      vertical-align: middle;
      -webkit-text-fill-color: white;
    }
    .icon-box {
      width: 75px;
      height: 75px;
      background: #fff4ed;
      border: 2px dashed #ff8800;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-box svg {
      width: 36px;
      height: 36px;
      stroke: #ff5500;
    }
    h2 {
      font-size: 22px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 10px;
    }
    p {
      color: #666666;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 25px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: linear-gradient(135deg, #ff8800 0%, #ff5500 100%);
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      padding: 14px 32px;
      border-radius: 14px;
      box-shadow: 0 8px 25px rgba(255, 85, 0, 0.35);
      transition: all 0.25s ease;
      width: 100%;
      margin-bottom: 12px;
    }
    .btn:hover {
      box-shadow: 0 12px 30px rgba(255, 85, 0, 0.45);
      transform: translateY(-2px);
      filter: brightness(1.05);
    }
    .btn-tg {
      display: inline-block;
      background: #229ED9;
      color: white;
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      padding: 10px 20px;
      border-radius: 10px;
      transition: background 0.2s;
      width: 100%;
    }
    .btn-tg:hover {
      background: #1c88bd;
    }
    .footer-note {
      margin-top: 25px;
      font-size: 12px;
      color: #999999;
    }
  </style>
</head>
<body>
  <div class="card">
    <a href="https://hmair.xyz" class="header-logo" title="Go to Home Air TV">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </div>
      <div class="logo-text">HOME AIR <span class="badge">TV</span></div>
    </a>
    <div class="icon-box">
      <svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h2>🚫Access Denied🤚</h2>
    <p>
      🤦‍♂️ভাই লিংক কপি করে লাভ নেই!<br>
      যদি লিংকের এতই প্রয়োজন হয় তবে ডেভেলপারকে সরাসরি কন্টাক্ট করেন, তাও এভাবে নেটওয়ার্ক ট্যাব ঘেঁটে লিংক খোঁজা বাদ দেন 😒 Please stream seamlessly through the official platform.
    </p>
    <a href="https://hmair.xyz" class="btn">
      <span>Watch on Official Website</span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
    </a>
    <a href="https://t.me/homeairtv" class="btn-tg" target="_blank" rel="noopener noreferrer">JOIN TG 😜</a>
    <div class="footer-note">Protected by Stream Proxy Shield • 2026</div>
  </div>
</body>
</html>`;

// ========================================================
// সিকিউরিটি: অনুমোদিত ডোমেইন তালিকা (Anti-Hotlink Guard)
// ========================================================
const ALLOWED_ORIGINS = [
  'https://homeairtv.xubilaswebdevcorp.shop',
  'https://anime.hmair.xyz',
  'https://hmair.xyz',
  'https://www.hmair.xyz',
  'https://2.0.hmair.xyz',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ১০০K ট্রাফিকের জন্য ২৪ ঘণ্টা মেমোরি ক্যাশ
const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// কনকারেন্সি লকার
const pendingScrapes = new Map();

let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts'
    ]
  });
  return globalBrowser;
}

getWarmBrowser().catch(() => {});

// ========================================================
// ১. DUB এর জন্য MAL / ANILIST / MEGAPLAY রেজলভার
// ========================================================
async function getAnimeExternalIds(title = '') {
  try {
    const query = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          id
          idMal
        }
      }
    `;
    const cleanTitle = title.replace(/[^\w\s]/gi, '');
    if (cleanTitleআপনার দেওয়া কোডটির আর্কিটেকচার এবং লজিক স্ট্রাকচার বেশ গোছানো। এটি সব ক্ষেত্রে কাজ করার পেছনে কিছু নির্দিষ্ট কারণ রয়েছে, পাশাপাশি প্রোডাকশনে আরও দীর্ঘস্থায়ী ও স্ট্যাবল রাখার জন্য কয়েকটি রিস্ক ফ্যাক্টরও রয়েছে।

---

### কেন এই সার্ভারটি কাজ করছিল

* **মাল্টি-লেভেল স্ক্র্যাপিং ফলব্যাক:** কোডে একের পর এক প্রোভাইডার চেক করার লজিক রয়েছে (`vidnest`, `vidsrc.sbs`, `vidsrc.xyz`, `vidrock`, `vidlink`)। একটি ফেইল করলে স্বয়ংক্রিয়ভাবে পরেরটি চেষ্টা করে।
* **ডুপ্লিকেট রিকোয়েস্ট ব্লকিং (`pendingScrapes`):** একই ভিডিওর জন্য একাধিক ব্যবহারকারী একই সাথে রিকোয়েস্ট পাঠালে ব্রাউজার একাধিকবার চালু না হয়ে আগের প্রমিজটি শেয়ার করে, যা মেমোরি বাঁচায়।
* **হেডলেস অপ্টিমাইজেশন:** স্ক্র্যাপিংয়ের সময় ছবি, ফন্ট, সিএসএস এবং অ্যানালিটিক্স স্ক্রিপ্ট বন্ধ (`abort`) রাখা হয়েছে, যার কারণে ৫–৭ সেকেন্ডের মধ্যেই স্ট্রিম ডিটেক্ট করা সম্ভব হয়।
* **M3U8 রি-রাইটিং ও প্রক্সিং:** মাস্টার প্লেলিস্ট এবং সেগমেন্টগুলোকে রিকার্সিভলি লোকাল প্রক্সি রুটের মাধ্যমে টানেল করায় ব্রাউজারে `CORS` বা `Referer Forbidden (403)` এরর আসত না।
* **ব্রাউজার প্রি-ওয়ার্মিং:** সিঙ্গেল গ্লোবাল ব্রাউজার ইনস্ট্যান্স পুনরায় ব্যবহার করায় প্রতি রিকোয়েস্টে নতুন করে ক্রোমিয়াম চালু হওয়ার ভারী ওভারহেড কমে যায়।

---

### যেসব কারণে ভবিষ্যতে সমস্যা হতে পারে (Potential Risks)

* **মেমোরি লিক (Puppeteer Zombie Tabs/Caches):** 
  কোডের `userDataDir` একটি টেম্প ফোল্ডারে সেট করা। দীর্ঘ সময় চলার পর ক্যাশ ফাইল ও ক্র্যাশড পেজের কারণে ডিস্ক ও র‌্যাম ফুল হয়ে ক্র্যাশ করতে পারে। ব্রাউজারকে নির্দিষ্ট ইন্টারভালে (যেমন প্রতি ৫০০–১০০০ স্ক্র্যাপ পর) রিস্টার্ট দেওয়ার মেকানিজম দরকার।
* **ইন-মেমোরি ক্যাশ ওভারফ্লো (`streamCache`):** 
  `streamCache` একটি সাধারণ `Map`। এখানে ডেটা শুধু জমা হচ্ছে, কিন্তু মেয়াদ শেষ হলেও মেমোরি থেকে স্বয়ংক্রিয়ভাবে রিমুভ (Eviction) হচ্ছে না। দীর্ঘ মেয়াদে সার্ভার মেমোরি ফুল হতে পারে। এর জন্য **LRU Cache** বা **Redis** ব্যবহার করা নিরাপদ।
* **প্রোভাইডার সাইটের ক্লাউডফ্লেয়ার/ক্যাপচা আপডেট:**
  `fastScrape`-এ `vidsrc` বা অন্য প্ল্যাটফর্মগুলো যদি টার্নস্টাইল (Turnstile) বা ক্লাউডফ্লেয়ার চ্যালেঞ্জ কঠোর করে, তবে হেডলেস ব্রাউজার স্ট্রিম লিংক ইন্টারসেপ্ট করার আগেই টাইমআউট হয়ে যাবে।
* **HLS লাইভ সেগমেন্ট প্রক্সিং লোড:** 
  প্রতিটি ছোট `.ts` ভিডিও চাংক নোড সার্ভারের ব্যান্ডউইথ দিয়ে পাস হচ্ছে। ট্রাফিক খুব বেড়ে গেলে নোড জেএস ইভেন্ট লুপ ব্লক হয়ে সার্ভার স্লো হতে পারে।

---

আপনার অ্যাপে যদি কোনো নির্দিষ্ট প্রোভাইডারে সমস্যা দেখা দিয়ে থাকে অথবা কোডটিকে আরও লো-রিসোর্স (Low CPU/RAM) অপ্টিমাইজ করতে চান, তা জানাতে পারেন।
