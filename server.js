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

const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Access Denied - HOME AIR TV</title>
  <style>
    body { background: #0b0c10; min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; font-family: sans-serif; text-align: center; }
    .card { background: #151821; border: 1px solid #ff5500; border-radius: 24px; padding: 40px; max-width: 440px; width: 100%; box-shadow: 0 10px 40px rgba(255,85,0,0.2); }
    h2 { font-size: 24px; color: #ff5500; margin-bottom: 12px; }
    p { font-size: 14px; color: #8c93a8; margin-bottom: 24px; line-height: 1.6; }
    a { display: block; background: linear-gradient(135deg, #ff8800, #ff4500); color: #fff; text-decoration: none; padding: 14px; border-radius: 12px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚫 Protected Stream</h2>
    <p>Direct unauthorized hotlinking is restricted. Stream directly through the official media platform.</p>
    <a href="https://hmair.xyz">Open Official Platform</a>
  </div>
</body>
</html>`;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const streamCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const pendingScrapes = new Map();

let globalBrowser = null;

async function getWarmBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));
  globalBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUT shame shame shame shame shame shame shame shame shame shame shame shame shame shame shame shameBased on the complete file inspection of your Next.js frontend (`HOME AIR 2.0`) and your Puppeteer backend scraper service (`universal-stream-scraper`), here is the root-cause analysis and workable solutions.

---

### Root Causes Analysis

* **The Double-Proxy Pitfall**: When the backend resolves a `.m3u8` playlist, it already rewrites each TS segment to run through `https://universal-stream-scraper-production.up.railway.app/api/stream-proxy?url=...`[cite: 1]. If your frontend wraps that returned `streamUrl` inside `/api/proxy?url=...`, segment requests become double-encoded, causing `403 Forbidden` / `502 Tunnel Error` and freezing the player at `0:00`[cite: 1, 2].
* **Autoplay Policy Hang**: Modern desktop and mobile browsers reject unmuted autoplay on direct `<video>` tags without prior user gesture, holding HLS.js in an infinite buffering spinner state[cite: 1].
* **Puppeteer Over-blocking in Scraper**: In the backend scraper, dropping XHR or specific helper scripts during request interception prevents players like VidSrc/Vidnest from initializing media elements and generating playback keys[cite: 1].

---

### Workable Solution 1: Frontend Video Player (`components/VideoPlayer.tsx`)

Replace your current `components/VideoPlayer.tsx` with this implementation. It directly consumes the backend stream without double proxying, provides automatic unmuted-to-muted autoplay fallback, and switches to backup embeds gracefully if the live scraper encounters missing/unreleased media[cite: 1].

```tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { useAdsConfig } from '@/lib/adsConfig';
import { saveWatchProgress } from '@/lib/storage';
import DownloadModal from '@/components/DownloadModal';
import {
  ShieldCheck,
  Zap,
  Radio,
  AlertCircle,
  Download,
  ChevronLeft,
  ChevronRight,
  Server,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
} from 'lucide-react';

const SERVERS = [
  { id: 'SR-1', name: 'Server 1', badge: 'Ultra HD' },
  { id: 'SR-2', name: 'Server 2', badge: 'Multi Dub' },
  { id: 'SR-3', name: 'Server 3', badge: 'Fast Load' },
  { id: 'SR-4', name: 'Server 4', badge: 'Backup 1' },
  { id: 'SR-5', name: 'Server 5', badge: 'Backup 2' },
  { id: 'SR-6', name: 'Server 6', badge: 'Auto 1080p' },
];

function getEmbedUrl(providerId: string, mediaId: string | number, season = 1, episode = 1, type = 'movie') {
  const isTv = type === 'tv' || type === 'series' || type === 'anime';
  switch (providerId) {
    case 'SR-2':
      return isTv
        ? `[https://vidsrc.sbs/embed/tv/$](https://vidsrc.sbs/embed/tv/$){mediaId}/${season}/${episode}`
        : `[https://vidsrc.sbs/embed/movie/$](https://vidsrc.sbs/embed/movie/$){mediaId}`;
    case 'SR-3':
      return isTv
        ? `[https://vidnest.fun/tv/$](https://vidnest.fun/tv/$){mediaId}/${season}/${episode}`
        : `[https://vidnest.fun/movie/$](https://vidnest.fun/movie/$){mediaId}`;
    case 'SR-4':
      return isTv
        ? `[https://player.autoembed.cc/embed/tv/$](https://player.autoembed.cc/embed/tv/$){mediaId}/${season}/${episode}`
        : `[https://player.autoembed.cc/embed/movie/$](https://player.autoembed.cc/embed/movie/$){mediaId}`;
    case 'SR-5':
      return isTv
        ? `[https://vidsrc.me/embed/tv?tmdb=$](https://vidsrc.me/embed/tv?tmdb=$){mediaId}&season=${season}&episode=${episode}`
        : `[https://vidsrc.me/embed/movie?tmdb=$](https://vidsrc.me/embed/movie?tmdb=$){mediaId}`;
    case 'SR-6':
      return isTv
        ? `[https://vidlink.pro/tv/$](https://vidlink.pro/tv/$){mediaId}/${season}/${episode}`
        : `[https://vidlink.pro/movie/$](https://vidlink.pro/movie/$){mediaId}`;
    default:
      return '';
  }
}

interface VideoPlayerProps {
  mediaId: string | number;
  type?: 'movie' | 'tv' | 'series' | string;
  season?: number;
  episode?: number;
  title?: string;
  onStreamLoaded?: () => void;
  onSelectEpisode?: (season: number, episode: number) => void;
  malId?: string | number;
  isAnime?: boolean;
  onStreamUrlChange?: (url: string | null) => void;
  posterPath?: string;
  backdropPath?: string;
  seasons?: any[];
}

export default function VideoPlayer({
  mediaId,
  type = 'movie',
  season = 1,
  episode = 1,
  title = 'Media Stream',
  onStreamLoaded,
  onSelectEpisode,
  malId,
  isAnime = false,
  onStreamUrlChange,
}: VideoPlayerProps) {
  const { isAdEnabled } = useAdsConfig();
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<boolean>(false);
  const [activeServer, setActiveServer] = useState<string>('SR-1');
  const [lang, setLang] = useState<'sub' | 'dub'>('sub');
  const [isEmbed, setIsEmbed] = useState<boolean>(false);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState<boolean>(false);
  const [currentStreamUrl, setCurrentStreamUrl] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement null |>(null);
  const isTvNormalized = type === 'tv' || type === 'series' || isAnime;
  const s = season || 1;
  const ep = episode || 1;

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const sRem = Math.floor(secs % 60);
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${sRem < 10 ? '0' : ''}${sRem}`;
    }
    return `${mins}:${sRem < 10 ? '0' : ''}${sRem}`;
  };

  const getActivePlayingUrl = useCallback(() => {
    if (activeServer === 'SR-1') {
      return isEmbed ? embedUrl : currentStreamUrl;
    }
    return getEmbedUrl(activeServer, mediaId, s, ep, isTvNormalized ? 'tv' : 'movie');
  }, [activeServer, isEmbed, embedUrl, currentStreamUrl, mediaId, s, ep, isTvNormalized]);

  useEffect(() => {
    if (onStreamUrlChange) {
      onStreamUrlChange(getActivePlayingUrl());
    }
  }, [getActivePlayingUrl, onStreamUrlChange]);

  const handleLanguageChange = (newLang: 'sub' | 'dub') => {
    if (newLang === lang) return;
    setLang(newLang);
    setIsEmbed(false);
    setEmbedUrl(null);
    setCurrentStreamUrl(null);
    if (activeServer !== 'SR-1') {
      setActiveServer('SR-1');
    }
  };

  useEffect(() => {
    let isMounted = true;
    let hls: Hls | null = null;
    const video = videoRef.current;

    setIsLoading(true);
    setLoadError(false);

    if (activeServer !== 'SR-1') {
      setIsEmbed(true);
      const timer = setTimeout(() => {
        if (isMounted) setIsLoading(false);
      }, 500);
      return () => clearTimeout(timer);
    }

    const fetchStream = async () => {
      try {
        const queryParams = new URLSearchParams({
          id: String(mediaId),
          type: isTvNormalized ? 'tv' : 'movie',
          s: String(s),
          e: String(ep),
          lang: lang,
          title: title === 'Media Stream' ? '' : title,
        });
        if (malId) queryParams.append('mal_id', String(malId));

        const apiUrl = `[https://universal-stream-scraper-production.up.railway.app/api/resolve-stream?$](https://universal-stream-scraper-production.up.railway.app/api/resolve-stream?$){queryParams.toString()}`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error('Stream offline');
        const data = await res.json();

        if (!isMounted) return;

        if (data.isEmbed && data.embedUrl) {
          setIsEmbed(true);
          setEmbedUrl(data.embedUrl);
          setCurrentStreamUrl(data.embedUrl);
          setIsLoading(false);
          if (onStreamLoaded) onStreamLoaded();
          return;
        }

        const directHlsUrl = data.streamUrl;
        if (!directHlsUrl) throw new Error('No stream found');

        setIsEmbed(false);
        setEmbedUrl(null);
        setCurrentStreamUrl(directHlsUrl);

        if (!video) return;

        if (Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 30 * 1000 * 1000,
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
            fragLoadingTimeOut: 20000,
          });

          hls.loadSource(directHlsUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!isMounted) return;
            setIsLoading(false);
            video
              .play()
              .then(() => setIsPlaying(true))
              .catch(() => {
                video.muted = true;
                setIsMuted(true);
                video.play().then(() => setIsPlaying(true)).catch(() => {});
              });
          });

          if (onStreamLoaded) onStreamLoaded();

          hls.on(Hls.Events.ERROR, (_evt, dataErr) => {
            if (dataErr.fatal) {
              switch (dataErr.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  hls?.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  hls?.recoverMediaError();
                  break;
                default:
                  if (!isMounted) return;
                  setIsEmbed(true);
                  setEmbedUrl(getEmbedUrl('SR-2', mediaId, s, ep, isTvNormalized ? 'tv' : 'movie'));
                  setIsLoading(false);
                  break;
              }
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = directHlsUrl;
          video.addEventListener('loadedmetadata', () => {
            if (!isMounted) return;
            setIsLoading(false);
            video.play().catch(() => {
              video.muted = true;
              video.play().catch(() => {});
            });
            if (onStreamLoaded) onStreamLoaded();
          });
        }
      } catch (err) {
        if (!isMounted) return;
        setIsEmbed(true);
        setEmbedUrl(getEmbedUrl('SR-2', mediaId, s, ep, isTvNormalized ? 'tv' : 'movie'));
        setIsLoading(false);
      }
    };

    fetchStream();

    return () => {
      isMounted = false;
      if (hls) {
        hls.stopLoad();
        hls.detachMedia();
        hls.destroy();
      }
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [mediaId, isTvNormalized, s, ep, malId, lang, onStreamLoaded, activeServer, title]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const toggleFullscreen = () => {
    if (!videoRef.current) return;
    if (!document.fullscreenElement) {
      videoRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div className="w-full space-y-3 font-sans">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">
            AUDIO / LANGUAGE:
          </span>
          <div className="inline-flex rounded-lg bg-[#0e1017] p-1 border border-white/10 shadow-lg gap-1">
            <button
              onClick={() => handleLanguageChange('sub')}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                lang === 'sub'
                  ? 'bg-gradient-to-r from-orange-600 to-amber-500 text-white shadow-lg shadow-orange-500/30'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              JP SUB (Original)
            </button>
            <button
              onClick={() => handleLanguageChange('dub')}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                lang === 'dub'
                  ? 'bg-gradient-to-r from-orange-600 to-amber-500 text-white shadow-lg shadow-orange-500/30'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              US DUB (English)
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono font-bold tracking-widest uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          SCRAPER CORE ACTIVE
        </div>
      </div>

      {isTvNormalized && onSelectEpisode && (
        <div className="flex items-center justify-between bg-[#0e1017] border border-white/10 rounded-2xl px-4 py-2.5 shadow-lg">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-orange-600/10 px-3 py-1 rounded-xl border border-orange-500/20">
              <Radio className="w-3.5 h-3.5 text-orange-500 animate-pulse"/>
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Season {s} • Episode {ep}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => ep > 1 && onSelectEpisode(s, ep - 1)}
              disabled={ep <= 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-bold text-white disabled:opacity-40 transition-all border border-white/10"
            >
              <ChevronLeft className="w-3.5 h-3.5"/>
              <span>Prev Ep</span>
            </button>
            <button
              onClick={() => onSelectEpisode(s, ep + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-bold text-white transition-all border border-white/10"
            >
              <span>Next Ep</span>
              <ChevronRight className="w-3.5 h-3.5"/>
            </button>
          </div>
        </div>
      )}

      <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
        {isLoading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm pointer-events-none">
            <div className="w-10 h-10 border-3 border-orange-500 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-white text-xs font-semibold uppercase tracking-wider">CONNECTING CINEMA STREAM...</p>
            <p className="text-white/50 text-[10px] mt-0.5">Buffering direct native HLS video stream</p>
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-950 p-6 text-center">
            <h3 className="text-white font-bold text-base mb-1">Playback Interrupted</h3>
            <p className="text-zinc-400 text-xs mb-3">Retrying direct connection or switch server.</p>
            <button
              onClick={() => setActiveServer('SR-2')}
              className="px-4 py-2 bg-gradient-to-r from-orange-600 to-amber-500 text-white text-xs font-bold rounded-xl"
            >
              Switch to Backup Server (SR-2)
            </button>
          </div>
        )}

        {activeServer === 'SR-1' && !isEmbed ? (
          <>
            <video
              ref={videoRef}
              className="w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onTimeUpdate={() => {
                const cur = videoRef.current?.currentTime || 0;
                const dur = videoRef.current?.duration || 0;
                setCurrentTime(cur);
                if (dur > 0 && cur > 2) {
                  saveWatchProgress(
                    { id: Number(mediaId), title, name: title, media_type: isTvNormalized ? 'tv' : 'movie' } as any,
                    s,
                    ep,
                    cur,
                    dur
                  );
                }
              }}
              onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
              playsInline
            />
            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent p-4 opacity-0 hover:opacity-100 transition-opacity flex flex-col gap-2">
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={(e) => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = Number(e.target.value);
                    setCurrentTime(Number(e.target.value));
                  }
                }}
                className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-orange-500"
              />
              <div className="flex items-center justify-between text-white text-xs font-medium">
                <div className="flex items-center gap-3">
                  <button onClick={togglePlay} className="hover:text-orange-400 transition-colors">
                    {isPlaying ? <Pause className="w-4 h-4 fill-white"/> : <Play className="w-4 h-4 fill-white"/>}
                  </button>
                  <span className="font-mono text-zinc-300">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.muted = !videoRef.current.muted;
                        setIsMuted(videoRef.current.muted);
                      }
                    }}
                    className="hover:text-orange-400 transition-colors"
                  >
                    {isMuted ? <VolumeX className="w-4 h-4"/> : <Volume2 className="w-4 h-4"/>}
                  </button>
                  <button onClick={toggleFullscreen} className="hover:text-orange-400 transition-colors">
                    {isFullscreen ? <Minimize className="w-4 h-4"/> : <Maximize className="w-4 h-4"/>}
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <iframe
            src={embedUrl || getEmbedUrl(activeServer, mediaId, s, ep, isTvNormalized ? 'tv' : 'movie')}
            title={title}
            className="w-full h-full border-0"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            onLoad={() => setIsLoading(false)}
          />
        )}
      </div>

      <div className="bg-[#0e1017] border border-white/10 rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-orange-500"/>
            <h4 className="text-xs font-bold text-white uppercase tracking-wider">
              Select Streaming Server
            </h4>
          </div>
          <div className="flex items-center gap-2">
            {isAdEnabled('playerOverlay') && (
              <button
                onClick={() => setShowDownloadModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/30 rounded-xl transition-all shadow-md group active:scale-95"
              >
                <Download className="w-3.5 h-3.5 text-orange-400 group-hover:scale-110 transition-transform"/>
                <span>HD Download</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex sm:grid sm:grid-cols-3 lg:grid-cols-6 gap-2 overflow-x-auto no-scrollbar pt-1">
          {SERVERS.map((srv) => {
            const isActive = activeServer === srv.id;
            return (
              <button
                key={srv.id}
                onClick={() => {
                  setActiveServer(srv.id);
                  setLoadError(false);
                  setIsLoading(true);
                }}
                className={`flex-shrink-0 min-w-[105px] sm:min-w-0 flex-1 flex flex-col items-center justify-center p-2.5 rounded-xl text-xs font-semibold transition-all duration-200 border ${
                  isActive
                    ? 'bg-gradient-to-r from-orange-600 to-amber-500 text-white border-orange-500 shadow-lg shadow-orange-600/30 scale-105'
                    : 'bg-white/5 hover:bg-white/10 text-gray-300 border-white/5 hover:border-white/20'
                }`}
              >
                <div className="flex items-center gap-1">
                  <Zap ${isActive 'text-gray-400'}`} 'text-yellow-200' : ? className="{`w-3" h-3/>
                  <span className="truncate">{srv.name}</span>
                </div>
                <span className={`text-[9px] mt-0.5 font-normal ${isActive ? 'text-orange-100' : 'text-gray-400'}`}>
                  {srv.badge}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <DownloadModal isOpen="{showDownloadModal}" onClose="{()"> setShowDownloadModal(false)}
        title={title}
        streamUrl={getActivePlayingUrl()}
        mediaId={mediaId}
        type={isTvNormalized ? 'tv' : 'movie'}
        season={s}
        episode={ep}
      />
    </div>
  );
}
