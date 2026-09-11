import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { getVideoDimensions } from './videoRenderer.js';
import { trackBandwidth } from './bandwidthTracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

const IS_LINUX = process.platform === 'linux';

/**
 * Scan all common directory locations and filename variations for cookies.txt
 */
function findCookiesFile() {
  const rootDir = path.resolve(serverDir, '..');
  const candidatePaths = [
    path.join(serverDir, 'cookies.txt'),
    path.join(rootDir, 'cookies.txt'),
    path.join(serverDir, 'Cookies.txt'),
    path.join(rootDir, 'Cookies.txt'),
    path.join(serverDir, 'cookie.txt'),
    path.join(rootDir, 'cookie.txt'),
    path.join(serverDir, 'cookies.txt.txt'),
    path.join(rootDir, 'cookies.txt.txt'),
    path.join(serverDir, 'youtube_cookies.txt'),
    path.join(rootDir, 'youtube_cookies.txt'),
    path.join(process.cwd(), 'server', 'cookies.txt'),
    path.join(process.cwd(), 'cookies.txt')
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const stats = fs.statSync(p);
        if (stats.size > 10) {
          return p;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Returns yt-dlp args configured with:
 * 1. Human-like rate pacing (--sleep-requests 3, --sleep-interval 3, --max-sleep-interval 6)
 * 2. Bandwidth throttling (--limit-rate 5M) to mimic natural video browsing
 * 3. Client manipulation (web, mweb, ios, android)
 * 4. Optional Residential Proxy support (via RESIDENTIAL_PROXY or PROXY_URL)
 * 5. Automatic detection of session cookies.txt across root and server/ folders
 */
/**
 * Base yt-dlp args used for all requests (search + download).
 * Stripped of --remote-components and --js-runtimes which break on Android/Termux.
 */
function getYtDlpArgs(clientSpoof = null) {
  const residentialProxy = (process.env.RESIDENTIAL_PROXY || process.env.PROXY_URL || '').trim();
  const proxyArgs = residentialProxy ? ['--proxy', residentialProxy] : [];

  const foundCookies = findCookiesFile();
  const cookiesArgs = foundCookies ? ['--cookies', foundCookies] : [];

  if (foundCookies) {
    console.log(`[Downloader] 🍪 Found active session cookies: ${foundCookies}`);
  }

  const args = [
    '--no-check-certificates',
    '--geo-bypass',
  ];

  if (clientSpoof && clientSpoof !== 'default') {
    args.push('--extractor-args', `youtube:player_client=${clientSpoof};formats=missing_pot`);
  } else {
    args.push('--extractor-args', 'youtube:formats=missing_pot');
  }

  if (cookiesArgs.length) args.push(...cookiesArgs);
  if (proxyArgs.length) args.push(...proxyArgs);

  // Only supply custom Android User Agent if clientSpoof explicitly starts with android
  if (clientSpoof && clientSpoof.startsWith('android')) {
    args.push('--user-agent', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36');
  }

  return args;
}

/**
 * Minimal fast args for search-only / metadata-only calls (no sleep delay).
 */
function getFastArgs() {
  return [
    ...getYtDlpArgs('default'),
    '--rm-cache-dir',
  ];
}

/**
 * Download args with gentle rate-limiting and anti-bot spoofing.
 */
function getDownloadArgs(clientProfile = 'default') {
  return [
    ...getYtDlpArgs(clientProfile),
    '--limit-rate', '6M',
    '--rm-cache-dir',
  ];
}


/**
 * Merge separate video and audio files using FFmpeg.
 */
function mergeStreamsWithFfmpeg(videoFile, audioFile, outputFile) {
  const ffmpegPath = getFFmpegPath();
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputFile
    ];
    console.log(`[Downloader] Merging streams with FFmpeg:\n${ffmpegPath} ${args.join(' ')}`);
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        resolve(outputFile);
      } else {
        reject(new Error(`FFmpeg merge failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
    proc.on('error', reject);
  });
}

function runYtDlp(ytDlpPath, args, { onStdout = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) onStdout(text);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

export function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return match ? match[1] : null;
}

// ── Clean YouTube Query Helper & Banned/Negative Operators ──────────────────

export const DIRTY_NEGATIVE_OPERATORS = [
  '-watermark',
  '-lyric',
  '-subtitle',
  '-logo',
  '-intro',
  '-overlay',
  '-cara',
  '-tutorial',
  '-unboxing',
  '-perbaikan',
  '-penggantian',
  '-rusak',
  '-service',
  '-servis',
  '-ganti',
  '-repair',
  '-reparasi',
  '-bongkar'
];

export function buildCleanYouTubeQuery(baseQuery) {
  if (!baseQuery) return '';
  // 1. Strip banned keywords: cara, tutorial, unboxing, perbaikan, penggantian, rusak, service, ganti, repair, etc.
  let cleaned = String(baseQuery)
    .replace(/\b(?:cara|tutorial|unboxing|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti|repair|reparasi|bongkar)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Append negative operators if not already included
  const existingLower = cleaned.toLowerCase();
  const toAdd = DIRTY_NEGATIVE_OPERATORS.filter(op => !existingLower.includes(op.toLowerCase()));
  if (toAdd.length > 0) {
    cleaned = `${cleaned} ${toAdd.join(' ')}`;
  }
  return cleaned.trim();
}

// ── Google YouTube Data API v3 Search Helper ───────────────────────────────

async function searchWithYouTubeDataApi(query, limit = 10) {
  const apiKey = (process.env.YOUTUBE_API_KEY || process.env.GOOGLE_YOUTUBE_API_KEY)?.trim();
  if (!apiKey) return null;

  try {
    const cleanQuery = buildCleanYouTubeQuery(query);
    console.log(`[Downloader] Searching YouTube Data API v3: "${cleanQuery}" (type=video&videoDefinition=high&videoDuration=medium)`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDefinition=high&videoDuration=medium&maxResults=${limit}&q=${encodeURIComponent(cleanQuery)}&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    return items
      .filter(item => item.id?.videoId)
      .map(item => ({
        id: item.id.videoId,
        title: item.snippet?.title || 'YouTube Video',
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        duration: 0,
        channel: item.snippet?.channelTitle || '',
        description: (item.snippet?.description || '').slice(0, 500)
      }))
      .slice(0, limit);
  } catch (e) {
    return null;
  }
}

// ── RapidAPI Search Helper ──────────────────────────────────────────────────

async function searchWithRapidApi(query, limit = 10) {
  const apiKey = process.env.RAPIDAPI_KEY?.trim();
  const host = process.env.RAPIDAPI_HOST?.trim() || 'yt-api.p.rapidapi.com';
  if (!apiKey) return null;

  try {
    const cleanQuery = buildCleanYouTubeQuery(query);
    console.log(`[Downloader] Searching YouTube via RapidAPI: "${cleanQuery}" (type=video&videoDefinition=high&videoDuration=medium)`);
    const res = await fetch(`https://${host}/search?query=${encodeURIComponent(cleanQuery)}&type=video&videoDefinition=high&videoDuration=medium`, {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': host
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.data || data.results || [];
    return items
      .filter(item => item.type === 'video' || item.videoId || item.id)
      .map(item => ({
        id: item.videoId || item.id,
        title: item.title || 'YouTube Video',
        url: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : (item.url || ''),
        duration: Number(item.lengthSeconds || item.duration) || 0,
        channel: item.channelTitle || item.author || '',
        description: (item.description || '').slice(0, 500)
      }))
      .filter(item => item.id && item.url && (item.duration === 0 || (item.duration >= 300 && item.duration <= 900)))
      .slice(0, limit);
  } catch (e) {
    return null;
  }
}

// ── Native Stream Downloader Helper ──────────────────────────────────────────

async function downloadFileFromUrl(streamUrl, outputPath, { onProgress = () => {} } = {}) {
  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch video stream: HTTP ${res.status}`);
  }

  const totalBytes = Number(res.headers.get('content-length')) || 0;
  let downloadedBytes = 0;

  const fileStream = fs.createWriteStream(outputPath);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
    downloadedBytes += value.length;
    if (totalBytes > 0) {
      const pct = Math.round((downloadedBytes / totalBytes) * 100);
      const scaledProgress = 15 + Math.round(pct * 0.20);
      onProgress({ step: 'download', message: `Downloading video stream: ${pct}%`, progress: scaledProgress });
    }
  }

  fileStream.end();
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  return outputPath;
}

// ── Cobalt API Downloader ───────────────────────────────────────────────────

async function downloadWithCobaltApi(url, outputPath, onProgress) {
  const cobaltEndpoint = process.env.COBALT_API_URL?.trim();
  const cobaltApiKey = process.env.COBALT_API_KEY?.trim();
  if (!cobaltEndpoint) return null;

  try {
    onProgress({ step: 'download', message: 'Delegating extraction to Cobalt API...', progress: 12 });
    console.log(`[Downloader] Requesting delegated extraction via Cobalt API: ${cobaltEndpoint}`);

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    if (cobaltApiKey) {
      headers['Authorization'] = `Bearer ${cobaltApiKey}`;
    }

    const res = await fetch(cobaltEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url,
        videoQuality: '1080',
        downloadMode: 'auto'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      console.warn(`[Downloader] Cobalt API returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const downloadUrl = data.url || (data.status === 'redirect' ? data.url : null);
    if (!downloadUrl) {
      console.warn(`[Downloader] Cobalt API did not return a stream URL`);
      return null;
    }

    onProgress({ step: 'download', message: 'Downloading stream from Cobalt server...', progress: 20 });
    await downloadFileFromUrl(downloadUrl, outputPath, { onProgress });

    return {
      filePath: outputPath,
      metadata: {
        title: data.filename || 'YouTube Video',
        duration: 60
      }
    };
  } catch (err) {
    console.warn(`[Downloader] Cobalt API error: ${err.message}`);
    return null;
  }
}

// ── YouTube Downloader via RapidAPI (yt-api) ──

async function downloadWithYouTubeMediaDownloader(url, outputPath, onProgress, { quality = '1080p' } = {}) {
  const apiKey = process.env.RAPIDAPI_KEY?.trim();
  const host = process.env.RAPIDAPI_HOST?.trim() || 'yt-api.p.rapidapi.com';
  if (!apiKey) return null;

  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    onProgress({ step: 'download', message: 'Fetching video stream link from RapidAPI...', progress: 12 });

    const detailRes = await fetch(`https://${host}/dl?id=${videoId}`, {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': host
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!detailRes.ok) {
      console.warn(`[Downloader] yt-api returned HTTP ${detailRes.status}`);
      return null;
    }

    const data = await detailRes.json();
    if (!data.formats || data.formats.length === 0) {
      console.warn(`[Downloader] yt-api error: No formats returned`);
      return null;
    }

    const metadata = {
      title: data.title || 'YouTube Video',
      duration: Math.round(Number(data.lengthSeconds) || 60),
      description: (data.description || '').slice(0, 500),
      channel: data.channelTitle || '',
      tags: []
    };

    const isPreview = quality === 'preview' || quality === 'low';
    let best = null;
    if (isPreview) {
      best = data.formats.find(f => f.qualityLabel === '360p' && f.audioQuality) ||
             data.formats.find(f => f.qualityLabel === '360p') ||
             data.formats.find(f => f.audioQuality) || 
             data.formats[0];
    } else {
      // Strictly require 1080p or higher formats (1080p, 1440p, 2160p)
      best = data.formats.find(f => (f.qualityLabel === '1080p' || f.qualityLabel === '1440p' || f.qualityLabel === '2160p') && f.audioQuality) ||
             data.formats.find(f => f.qualityLabel === '1080p' || f.qualityLabel === '1440p' || f.qualityLabel === '2160p');
    }

    if (!best || !best.url) {
      console.warn(`[Downloader] yt-api notice: Tidak ada stream minimal 1080p pada RapidAPI`);
      return null;
    }

    onProgress({ step: 'download', message: `Downloading video via RapidAPI stream (${best.qualityLabel || '1080p'})...`, progress: 18 });
    console.log(`[Downloader] yt-api stream: ${best.qualityLabel}, hasAudio=${!!best.audioQuality}`);

    await downloadFileFromUrl(best.url, outputPath, { onProgress });

    return { filePath: outputPath, metadata };
  } catch (e) {
    console.warn(`[Downloader] RapidAPI download error: ${e.message}`);
    return null;
  }
}


// ── Direct Native YouTube Web Search Scraper (0-second lag & 0 dependency) ───

async function searchDirectYouTubeWeb(query, limit = 10) {
  try {
    const cleanQuery = buildCleanYouTubeQuery(query);

    // sp=CAMSAggD enforces YouTube Video + High Definition (HD) + Medium Duration (4-20m)
    let res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}&sp=CAMSAggD`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    let html = await res.text();
    let match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    let parsedData = match ? JSON.parse(match[1]) : null;
    let sections = parsedData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    let hasVideos = sections.some(sec => (sec.itemSectionRenderer?.contents || []).some(item => item.videoRenderer));

    // Fallback: If HD filter returned 0 items, query with Medium Duration filter sp=EgQQASgB
    if (!hasVideos) {
      const fallbackRes = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}&sp=EgQQASgB`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (fallbackRes.ok) {
        html = await fallbackRes.text();
        match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
        if (match) {
          parsedData = JSON.parse(match[1]);
          sections = parsedData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        }
      }
    }

    if (!parsedData) return null;
    const videos = [];
    for (const sec of sections) {
      const items = sec.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const v = item.videoRenderer;
        if (v && v.videoId) {
          const title = v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || 'YouTube Video';
          const durationStr = v.lengthText?.simpleText || '';
          const parts = durationStr.replace(/[^0-9:]/g, ':').split(':').map(Number);
          let duration = 0;
          if (parts.length === 3) duration = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
          else if (parts.length === 2) duration = (parts[0] * 60) + parts[1];
          else if (parts.length === 1 && parts[0] > 0) duration = parts[0];

          // Filter out videos with known duration < 5 min (300s) or > 15 min (900s)
          if (duration > 0 && (duration < 300 || duration > 900)) {
            continue;
          }

          const channel = v.ownerText?.runs?.[0]?.text || '';
          const desc = v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') || '';
          videos.push({
            id: v.videoId,
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
            duration: duration || 0,
            channel,
            description: desc.slice(0, 500)
          });
          if (videos.length >= limit) break;
        }
      }
      if (videos.length >= limit) break;
    }
    return videos;
  } catch (err) {
    console.warn(`[Downloader] Direct YouTube search notice: ${err.message}`);
    return null;
  }
}

/**
 * Searches YouTube candidates using YouTube Data API v3, RapidAPI, Native Web Search, or yt-dlp.
 * @param {string} query - Search query text
 * @param {{ limit?: number, onProgress?: Function }} options
 * @returns {Promise<Array<{ id: string, title: string, url: string, duration: number, channel: string, description: string }>>}
 */
export async function searchYouTubeVideos(query, { limit = 10, onProgress = () => {} } = {}) {
  const reportProgress = (data) => {
    if (typeof data === 'string') {
      onProgress({ step: 'auto_youtube_search', message: data, progress: 5 });
    } else {
      onProgress(data);
    }
  };

  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 16));

  // 1. Prioritize YouTube Data API v3 if key is configured
  const ytDataResults = await searchWithYouTubeDataApi(query, safeLimit);
  if (ytDataResults && ytDataResults.length > 0) {
    return ytDataResults;
  }

  // 2. Prioritize RapidAPI search if key is configured
  const rapidResults = await searchWithRapidApi(query, safeLimit);
  if (rapidResults && rapidResults.length > 0) {
    return rapidResults;
  }

  // 3. Direct fast native YouTube web search parser (0-second lag, 0 external binary dependency)
  const webResults = await searchDirectYouTubeWeb(query, safeLimit);
  if (webResults && webResults.length > 0) {
    return webResults;
  }

  // 4. Fallback to direct yt-dlp search
  try {
    const cleanQuery = buildCleanYouTubeQuery(query);
    const ytDlpPath = await getYtDlpPath(reportProgress);
    const searchTarget = `ytsearch${safeLimit}:${cleanQuery}`;

    reportProgress({
      step: 'auto_youtube_search',
      message: `Searching YouTube candidates: ${query}`,
      progress: 8,
    });

    const baseArgs = [
      '--no-check-certificates',
      '--geo-bypass',
      '--flat-playlist',
      '--dump-json',
      '--no-playlist',
      '--skip-download',
      '--match-filter', 'duration >= 60 & duration <= 900',
      searchTarget
    ];

    const foundCookies = findCookiesFile();
    if (foundCookies) baseArgs.push('--cookies', foundCookies);

    const result = await runYtDlp(ytDlpPath, baseArgs);

    if (result.code === 0 && result.stdout) {
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map((item) => ({
          id: item.id,
          title: item.title || 'YouTube Video',
          url: item.webpage_url || item.original_url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : ''),
          duration: Number(item.duration) || 0,
          channel: item.uploader || item.channel || '',
          description: (item.description || '').slice(0, 500),
        }))
        .filter((item) => item.id && item.url && (item.duration === 0 || (item.duration >= 300 && item.duration <= 900)));
    }
  } catch (err) {
    console.warn(`[Downloader] yt-dlp search fallback warning: ${err.message}`);
  }

  return [];
}

/**
 * Downloads a YouTube video with configurable quality (preview 360p vs full 1080p Full HD).
 */
export async function downloadYouTubeVideo(url, outputDir, videoId, onProgress = () => {}, { quality = '1080p', prefix = 'raw' } = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const isPreview = quality === 'preview' || quality === 'low' || quality === '240p';
  const finalExpectedPath = path.join(outputDir, `${prefix}_${videoId}.mp4`);

  // Tier 1: Try Cobalt API if configured (only for full download)
  if (process.env.COBALT_API_URL && !isPreview) {
    const cobaltRes = await downloadWithCobaltApi(url, finalExpectedPath, onProgress);
    if (cobaltRes) {
      onProgress({ step: 'download', message: 'Video downloaded via Cobalt API.', progress: 35 });
      return cobaltRes;
    }
  }

  const ytDlpPath = await getYtDlpPath(onProgress);
  const ffmpegPath = getFFmpegPath();
  const outputTemplate = path.join(outputDir, `${prefix}_${videoId}.%(ext)s`);

  const qualityLabel = isPreview ? '360p Preview' : '1080p Full HD';
  onProgress({
    step: 'download',
    message: isPreview ? `Downloading preview (${qualityLabel})...` : `Downloading direct 1080p Full HD source video from YouTube...`,
    progress: 10
  });

  // For full 1080p: fetch metadata first for scripting
  let metadata = { title: 'YouTube Video', duration: 60 };
  if (!isPreview) {
    const infoArgs = [
      ...getFastArgs(),
      '--dump-json',
      '--no-playlist',
      url
    ];
    const infoResult = await runYtDlp(ytDlpPath, infoArgs);
    if (infoResult.code === 0 && infoResult.stdout) {
      try {
        const parsed = JSON.parse(infoResult.stdout);
        metadata = {
          title: parsed.title || 'YouTube Video',
          duration: parsed.duration || 60,
          description: (parsed.description || '').slice(0, 500),
          channel: parsed.uploader || parsed.channel || '',
          tags: parsed.tags || [],
        };
      } catch (e) {
        console.warn('[Downloader] Warning: Could not parse video metadata JSON');
      }
    }
  }

  // Multi-profile rotation:
  // First attempt uses yt-dlp default (visionos) which reliably extracts 1080p+, 1440p, 4K without SABR / PO-token blocks.
  // Fallbacks try android, ios, mweb. We avoid tv_embedded (deprecated in yt-dlp) and web_creator (forces sign-in).
  const clientProfiles = [
    'default',
    'android,web',
    'ios,mweb',
    'mweb',
  ];

  let lastDownloadError = '';

  for (let attempt = 0; attempt < clientProfiles.length; attempt++) {
    const clientType = clientProfiles[attempt];
    const attemptLabel = attempt > 0 ? ` (Retry ${attempt + 1}/${clientProfiles.length} via ${clientType})` : '';

    onProgress({
      step: 'download',
      message: `Downloading (${qualityLabel})${attemptLabel}...`,
      progress: Math.min(25, 12 + (attempt * 4))
    });

    const dlBaseArgs = getDownloadArgs(clientType);

    // Resilient format selector: 360p preview for AI analysis vs STRICT 1080p+ Full HD for final rendering
    // NOTE: Strictly requires >=1080p (no 720p, no 480p, no 360p).
    const formatSelector = isPreview
      ? '18/bestvideo[height<=360]+bestaudio/best[height<=360]/bestvideo[height<=480]+bestaudio/best[height<=480]/worstvideo+worstaudio/worst/best'
      : 'bestvideo[height>=1080]+bestaudio/bestvideo[width>=1080]+bestaudio/bestvideo[height>=1080]/bestvideo[width>=1080]/best[height>=1080]/best[width>=1080]';

    const dlArgs = [
      '--ffmpeg-location',
      ffmpegPath,
      ...dlBaseArgs,
      '-f',
      formatSelector,
      '--merge-output-format',
      'mp4',
      '--no-playlist',
      '--no-part',
      '--no-mtime',
      '--retries', '2',
      '--fragment-retries', '2',
      '-o',
      outputTemplate,
      url,
    ];

    console.log(`[Downloader] Spawning yt-dlp [Profile: ${clientType}] (${qualityLabel}): ${ytDlpPath} ${dlArgs.join(' ')}`);

    const downloadResult = await runYtDlp(ytDlpPath, dlArgs, {
      onStdout: (text) => {
        const match = text.match(/(\d+(\.\d+)?)%/);
        if (match) {
          const percent = parseFloat(match[1]);
          const scaledProgress = 15 + Math.round(percent * 0.20);
          onProgress({ step: 'download', message: `Downloading video: ${Math.round(percent)}%`, progress: scaledProgress });
        }
      },
    });

    if (downloadResult.code === 0) {
      let downloadedFile = finalExpectedPath;

      if (!fs.existsSync(downloadedFile)) {
        const videoFiles = fs.readdirSync(outputDir).filter(f =>
          f.startsWith(`${prefix}_${videoId}`) &&
          !f.endsWith('.m4a') &&
          !f.endsWith('.mp3') &&
          !f.endsWith('.aac') &&
          !f.endsWith('.opus') &&
          !f.endsWith('.part') &&
          !f.endsWith('.ytdl') &&
          (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv') || f.endsWith('.mov'))
        );

        const audioFiles = fs.readdirSync(outputDir).filter(f =>
          f.startsWith(`${prefix}_${videoId}`) &&
          (f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.aac') || f.endsWith('.opus'))
        );

        if (videoFiles.length > 0) {
          const primaryVideo = path.join(outputDir, videoFiles[0]);
          if (audioFiles.length > 0) {
            onProgress({ step: 'download', message: 'Merging video & audio streams with FFmpeg...', progress: 32 });
            try {
              await mergeStreamsWithFfmpeg(primaryVideo, path.join(outputDir, audioFiles[0]), finalExpectedPath);
              downloadedFile = finalExpectedPath;
            } catch (mErr) {
              downloadedFile = primaryVideo;
            }
          } else {
            downloadedFile = primaryVideo;
          }
        }
      }

      if (fs.existsSync(downloadedFile) && fs.statSync(downloadedFile).size > 100000) {
        if (!isPreview) {
          const dims = await getVideoDimensions(downloadedFile, ffmpegPath);
          if (dims) {
            console.log(`[Downloader] Video resolution: ${dims.width}x${dims.height} (1080p+: ${dims.is1080pOrHigher})`);
            const isStrict1080p = dims.is1080pOrHigher;
            if (isStrict1080p) {
              console.log(`[Downloader] ✅ Resolusi ${dims.width}x${dims.height} memenuhi standar minimal 1080p Full HD ke atas. Siap di-render.`);
            } else {
              // Video is below 1080p (e.g. 720p, 480p, 360p). Strictly reject and delete it!
              console.warn(`[Downloader] ❌ Resolusi video (${dims.width}x${dims.height}) di bawah 1080p Full HD. Menolak video dan mencoba profil lain untuk 1080p+...`);
              try { fs.unlinkSync(downloadedFile); } catch {}
              lastDownloadError = `Resolusi video (${dims.width}x${dims.height}) di bawah standar 1080p Full HD. Wajib minimal 1080p ke atas.`;
              continue;
            }
          }
        }
        const videoSize = fs.statSync(downloadedFile).size;
        trackBandwidth('videoDownload', videoSize, `Download video 1080p (${path.basename(downloadedFile)} - ${(videoSize / (1024 * 1024)).toFixed(2)} MB)`);

        onProgress({ step: 'download', message: `Video download (${qualityLabel}) completed successfully.`, progress: 35 });
        return { filePath: downloadedFile, metadata };
      }
    }

    lastDownloadError = downloadResult.stderr || `Exit code ${downloadResult.code}`;
    console.warn(`[Downloader] Profile ${clientType} failed: ${lastDownloadError.slice(-200)}`);
  }

  // Tier 3: Try RapidAPI fallback if available
  if (process.env.RAPIDAPI_KEY) {
    onProgress({ step: 'download', message: 'Mencoba pengunduhan cadangan via RapidAPI Stream Proxy...', progress: 28 });
    const rapidDl = await downloadWithYouTubeMediaDownloader(url, finalExpectedPath, onProgress, { quality });
    if (rapidDl && fs.existsSync(rapidDl.filePath)) {
      if (!isPreview) {
        const dims = await getVideoDimensions(rapidDl.filePath, ffmpegPath);
        if (dims && !dims.is1080pOrHigher) {
          try { fs.unlinkSync(rapidDl.filePath); } catch {}
          throw new Error(`Resolusi video RapidAPI (${dims.width}x${dims.height}) di bawah standar minimal 1080p Full HD.`);
        }
      }
      return rapidDl;
    }
  }

  // Format clean human-readable error with actionable advice for IP block / bot detection
  const isBotOrIpBlock = (lastDownloadError || '').includes('Sign in to confirm') ||
    (lastDownloadError || '').includes('429') ||
    (lastDownloadError || '').includes('403') ||
    (lastDownloadError || '').includes('block') ||
    (lastDownloadError || '').includes('bot') ||
    (lastDownloadError || '').includes('rate limit');

  if (isBotOrIpBlock) {
    throw new Error(
      `YouTube membatasi/memblokir IP Anda sementara (Bot Detection/HTTP 429).\n` +
      `Solusi cepat:\n` +
      `1. Aktifkan Mode Pesawat (Airplane Mode) di HP selama 5 detik lalu matikan lagi untuk mendapatkan IP operator seluler baru.\n` +
      `2. Atau letakkan file cookies.txt dari browser YouTube ke folder project.`
    );
  }

  throw new Error(`Download video gagal (${qualityLabel}): ${lastDownloadError.slice(-400)}`);
}
