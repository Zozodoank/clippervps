import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
export { getYtDlpPath, getFFmpegPath };
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
  if (process.env.DISABLE_COOKIES === 'true' || process.env.NO_COOKIES === 'true') {
    return null;
  }
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
 * Fast zero-overhead check if a local port is listening via /proc/net/tcp (Linux/Termux)
 */
export function isLocalPortListening(port) {
  try {
    const hexPort = Number(port).toString(16).toUpperCase().padStart(4, '0');
    if (fs.existsSync('/proc/net/tcp')) {
      const tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
      if (tcp.includes(`:${hexPort} `) || tcp.includes(`:${hexPort}\t`)) {
        return true;
      }
    }
    if (fs.existsSync('/proc/net/tcp6')) {
      const tcp6 = fs.readFileSync('/proc/net/tcp6', 'utf8');
      if (tcp6.includes(`:${hexPort} `) || tcp6.includes(`:${hexPort}\t`)) {
        return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Returns proxy args with automatic fallback:
 * If a local reverse SOCKS5 proxy (e.g. 127.0.0.1:10808) is defined, checks if port is listening.
 * If not connected yet via SSH -R, safely omits --proxy to avoid connection refused errors.
 */
export function getSmartProxyArgs() {
  const proxy = (process.env.RESIDENTIAL_PROXY || process.env.PROXY_URL || '').trim();
  if (!proxy) return [];

  if (proxy.includes('127.0.0.1') || proxy.includes('localhost')) {
    const match = proxy.match(/:(\d+)/);
    const port = match ? parseInt(match[1], 10) : 10808;
    if (fs.existsSync('/proc/net/tcp')) {
      const isListening = isLocalPortListening(port);
      if (!isListening) {
        return [];
      }
    }
  }

  return ['--proxy', proxy];
}

/**
 * Base yt-dlp args used for all requests (search + download).
 * Stripped of --remote-components and --js-runtimes which break on Android/Termux.
 */
function getYtDlpArgs(clientSpoof = null) {
  const proxyArgs = getSmartProxyArgs();

  const foundCookies = findCookiesFile();
  const cookiesArgs = foundCookies ? ['--cookies', foundCookies] : [];

  if (foundCookies) {
    console.log(`[Downloader] 🍪 Found active session cookies: ${foundCookies}`);
  }
  if (proxyArgs.length) {
    console.log(`[Downloader] 🛡️ Active Anti-Block Proxy: ${proxyArgs[1]}`);
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

  // Enable Node.js JS runtime to solve YouTube n-token signature challenges without throttle
  args.push('--js-runtimes', 'node');

  // Standard Chrome desktop User-Agent to mimic browser / IDM
  if (clientSpoof && (clientSpoof.startsWith('android') || clientSpoof.includes('mweb'))) {
    args.push('--user-agent', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36');
  } else {
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');
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
 * Download args with IDM-style progressive buffering, rate-limiting, and anti-bot human pacing.
 * - Simulates a real browser player buffering chunks (10MB progressive chunks)
 * - Throttles download rate to ~2.2 MB/s (approx 18 Mbps, 3-4x real-time 1080p playback speed)
 * - Adds human-like request pacing (sleep between DASH fragment requests)
 * - Avoids sudden 50-100 Mbps burst spikes that trigger YouTube SABR bot detection
 */
function getDownloadArgs(clientProfile = 'default') {
  const args = [
    ...getYtDlpArgs(clientProfile),
    '--concurrent-fragments', '4',
    '--buffer-size', '16M',
    '--rm-cache-dir',
  ];

  // Enable Node.js JS runtime to solve YouTube n-token signature challenges without throttle
  args.push('--js-runtimes', 'node');

  // If rate limit is explicitly specified in env, apply it
  if (process.env.YTDLP_RATE_LIMIT) {
    args.push('--limit-rate', process.env.YTDLP_RATE_LIMIT);
  }

  // Micro sleep jitter if specified in env
  if (process.env.YTDLP_SLEEP_REQUESTS) {
    args.push('--sleep-requests', process.env.YTDLP_SLEEP_REQUESTS);
  }

  return args;
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
  '-cara',
  '-tutorial',
  '-diy',
  '-resep',
  '-recipe',
  '-mukbang',
  '-makanan',
  '-minuman',
  '-kuliner',
  '-jajanan',
  '-streetfood',
  '-vlog',
  '-repair',
  '-blackstone',
  '-weber',
  '-smoker',
  '-barbecue',
  '-"alat berat"',
  '-"mesin pabrik besar"',
  '-"industrial machine"',
  '-"factory machine"',
  '-"production machine"',
  '-"packing machine"',
  '-"packaging machine"',
  '-industrial',
  '-machinery',
  '-"mesin industri"',
  '-"mesin pabrik"',
  '-"mesin produksi"',
  '-"mesin packing"',
  '-"mesin pengemas"',
  '-"mesin besar"',
  '-"mesin raksasa"',
  '-"conveyor"',
  '-"cnc machine"',
  '-"bubble wrap"',
  '-kardus',
  '-cardboard',
  '-packaging',
  '-slideshow',
  '-traktor',
  '-"pakan ternak"',
  '-"chopper pakan"',
  '-"chopper rumput"',
  '-"mesin chopper"',
  '-selep',
  '-perontok',
  '-pemanen',
  '-traktor',
  '-silase',
  '-set',
  '-pack',
  '-paket',
  '-bundle',
  '-amazon',
  '-walmart',
  '-target',
  '-bestbuy',
  '-homedepot',
  '-"amazon finds"',
  '-"amazon must haves"',
  '-rutinitas',
  '-keseharian',
  '-beberes',
  '-"beres-beres"'
];

export function buildCleanYouTubeQuery(baseQuery) {
  if (!baseQuery) return '';
  const lower = baseQuery.toLowerCase();
  const isMoldOrFoodTool = /cetakan|dumpling|pastel|tamagoyaki|baking|kue|bakso|pembuat|maker|chopper|parutan|slicer|peeler|cutter|pemotong|pengupas|pemeras|wajan|panci|dispenser|sealer/i.test(lower);
  const isBrandedOrReview = /review|unboxing|tes|demo|hands on|spesifikasi|hp|smartphone|b-roll/i.test(lower);

  // 1. Bersihkan kata-kata sampah tanpa mematikan unboxing atau review (karena intro/penutup sudah diskip)
  const stripRegex = isMoldOrFoodTool
    ? /\b(?:diy|how\s+to|do\s+it\s+yourself|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|repair|reparasi|bongkar|mukbang|bubble\s*wrap|kardus|cardboard|packaging|blackstone|weber|smoker|pabrik|factory|manufacturing|industri|industrial|machinery|mesin\s+industri|alat\s+berat|mesin\s+usaha|mesin\s+pabrik|mesin\s+produksi|mesin\s+packing|mesin\s+pengemas|pakan|ternak|limbah|chopper\s+pakan|chopper\s+rumput|mesin\s+chopper|selep|perontok|pemanen|traktor|set|pack|packs|package|paket|bundle|bundling|kombo|combo|isi\s*\d+|\d+\s*pcs|amazon|walmart|target|bestbuy|homedepot)\b/gi
    : /\b(?:diy|how\s+to|do\s+it\s+yourself|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|repair|reparasi|bongkar|resep|recipe|mukbang|kuliner|bubble\s*wrap|kardus|cardboard|packaging|pabrik|factory|manufacturing|industrial|machinery|mesin\s+industri|alat\s+berat|mesin\s+usaha|mesin\s+pabrik|mesin\s+produksi|mesin\s+packing|mesin\s+pengemas|pakan|ternak|limbah|chopper\s+pakan|chopper\s+rumput|mesin\s+chopper|selep|perontok|pemanen|traktor|set|pack|packs|package|paket|bundle|bundling|kombo|combo|isi\s*\d+|\d+\s*pcs|amazon|walmart|target|bestbuy|homedepot)\b/gi;

  let cleaned = String(baseQuery)
    .replace(stripRegex, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate overly long combinatorial keywords
  const words = cleaned.split(' ');
  if (words.length > 7) {
    cleaned = words.slice(0, 7).join(' ');
  }

  // Jika query sudah spesifik berupa review produk/merk, JANGAN tambahkan operator negatif berlebihan
  // karena operator negatif membingungkan ranking YouTube search dan menyebabkan 0 hasil
  if (isBrandedOrReview) {
    return cleaned.trim();
  }

  // 2. Pilih operator negatif yang relevan untuk keyword umum non-merk
  const sensitiveFoodOperators = ['-cara', '-tutorial', '-resep', '-recipe', '-makanan', '-minuman', '-kuliner', '-jajanan', '-streetfood'];
  const relevantOperators = DIRTY_NEGATIVE_OPERATORS.filter(op => {
    if (isMoldOrFoodTool && sensitiveFoodOperators.includes(op)) {
      return false;
    }
    return true;
  });

  const existingLower = cleaned.toLowerCase();
  const toAdd = relevantOperators
    .filter(op => !existingLower.includes(op.toLowerCase()))
    .slice(0, 4); // Maksimal 4 operator untuk menjaga broad coverage

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
    console.log(`[Downloader] Searching YouTube Data API v3: "${cleanQuery}" (type=video&videoDefinition=high)`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDefinition=high&maxResults=${limit}&q=${encodeURIComponent(cleanQuery)}&key=${apiKey}`;
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



// ── Direct Native YouTube Web Search Scraper (With Stealth Headers & Human Pacing) ───

async function searchDirectYouTubeWeb(query, limit = 10) {
  try {
    const cleanQuery = buildCleanYouTubeQuery(query);

    // Natural human pacing delay before request (1.2s - 2.5s) to avoid bot rate-limits
    await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 1300)));

    const stealthHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    };

    // sp=EgIQAQ%253D%253D enforces YouTube Video filter (all durations, from 35s upwards)
    let res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}&sp=EgIQAQ%253D%253D`, {
      headers: stealthHeaders,
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    let html = await res.text();
    let match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    let parsedData = match ? JSON.parse(match[1]) : null;
    let sections = parsedData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    let hasVideos = sections.some(sec => (sec.itemSectionRenderer?.contents || []).some(item => item.videoRenderer));

    // Fallback: If filtered query returned 0 items, query standard search without sp
    if (!hasVideos) {
      await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      const fallbackRes = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`, {
        headers: stealthHeaders,
        signal: AbortSignal.timeout(15000)
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

          // Filter out videos with known duration < 35s or > 15 min (900s)
          if (duration > 0 && (duration < 35 || duration > 900)) {
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
 * Searches YouTube candidates using YouTube Data API v3, yt-dlp, or Native Web Search.
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

  // 2. Fallback to direct yt-dlp search with human sleep and player client rotation
  try {
    const cleanQuery = buildCleanYouTubeQuery(query);
    const ytDlpPath = await getYtDlpPath(reportProgress);
    const searchTarget = `ytsearch${safeLimit}:${cleanQuery}`;

    reportProgress({
      step: 'auto_youtube_search',
      message: `Searching YouTube candidates: ${query}`,
      progress: 8,
    });

    const isTermuxOrMobile = process.platform === 'android' ||
      Boolean(process.env.TERMUX_VERSION) ||
      (process.platform === 'linux' && !process.env.DISPLAY);

    const foundCookies = findCookiesFile();

    const baseArgs = [
      '--no-check-certificates',
      '--geo-bypass',
      '--flat-playlist',
      '--dump-json',
      '--no-playlist',
      '--skip-download',
      '--sleep-requests', '1.5',
      '--extractor-args', isTermuxOrMobile
        ? 'youtube:player_client=android,mweb,web'
        : (foundCookies ? 'youtube:player_client=web,mweb,android' : 'youtube:player_client=mweb,android,web'),
      '--match-filter', 'duration >= 50 & duration <= 900',
      searchTarget
    ];

    if (foundCookies) baseArgs.push('--cookies', foundCookies);

    const result = await runYtDlp(ytDlpPath, baseArgs);

    if (result.code === 0 && result.stdout) {
      const candidates = result.stdout
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
        .filter((item) => item.id && item.url && (item.duration === 0 || (item.duration >= 35 && item.duration <= 900)));

      if (candidates.length > 0) {
        return candidates;
      }
    }
  } catch (err) {
    console.warn(`[Downloader] yt-dlp search fallback warning: ${err.message}`);
  }

  // 4. Secondary fallback: Direct fast native YouTube web search parser with stealth headers
  const webResults = await searchDirectYouTubeWeb(query, safeLimit);
  if (webResults && webResults.length > 0) {
    return webResults;
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
  // First attempt uses yt-dlp default (visionos/desktop) which reliably extracts 1080p+, 720p HD without SABR blocks.
  // Fallbacks use web and web_safari desktop clients. We avoid mobile profiles (android, ios) which trigger SABR 403.
  const clientProfiles = [
    'default',
    'mweb',
    'web',
    'web_safari',
  ];

  let lastDownloadError = '';

  for (let attempt = 0; attempt < clientProfiles.length; attempt++) {
    const clientType = clientProfiles[attempt];
    const attemptLabel = attempt > 0 ? ` (Retry ${attempt + 1}/${clientProfiles.length} via ${clientType})` : '';

    // Anti-bot human pacing: pause with random jitter between retry attempts
    if (attempt > 0) {
      const jitterMs = 2500 + Math.floor(Math.random() * 2500); // 2.5s - 5.0s natural pause
      console.log(`[Downloader] ⏳ Human pacing delay before retry (${attempt + 1}/${clientProfiles.length}): ${(jitterMs / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, jitterMs));
    }

    onProgress({
      step: 'download',
      message: `Downloading (${qualityLabel})${attemptLabel}...`,
      progress: Math.min(25, 12 + (attempt * 4))
    });

    const dlBaseArgs = getDownloadArgs(clientType);

    // Resilient format selector: 360p preview for AI analysis vs High Quality HD (strictly capped at 1080p to avoid bloated 4K/1440p downloads)
    const formatSelector = isPreview
      ? '18/bestvideo[height<=360]+bestaudio/best[height<=360]/bestvideo[height<=480]+bestaudio/best[height<=480]/worstvideo+worstaudio/worst/best'
      : 'bestvideo[height<=1080][height>=720]+bestaudio/bestvideo[width<=1920][width>=1280]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080][height>=720]/best[height<=1080]/best';

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
            const isHD = dims.height >= 720 || dims.width >= 720 || dims.is1080pOrHigher;
            if (isHD) {
              console.log(`[Downloader] ✅ Resolusi ${dims.width}x${dims.height} memenuhi standar minimal HD 720p/1080p+. Siap di-render.`);
            } else {
              // Video is below 720p (e.g. 480p, 360p). Strictly reject and delete it!
              console.warn(`[Downloader] ❌ Resolusi video (${dims.width}x${dims.height}) di bawah standar HD 720p. Menolak video...`);
              try { fs.unlinkSync(downloadedFile); } catch {}
              lastDownloadError = `Resolusi video (${dims.width}x${dims.height}) di bawah standar HD 720p. Wajib minimal HD 720p/1080p ke atas.`;
              continue;
            }
          }
        }
        const videoSize = fs.statSync(downloadedFile).size;
        trackBandwidth('videoDownload', videoSize, `Download video HD (${path.basename(downloadedFile)} - ${(videoSize / (1024 * 1024)).toFixed(2)} MB)`);

        onProgress({ step: 'download', message: `Video download (${qualityLabel}) completed successfully.`, progress: 35 });
        return { filePath: downloadedFile, metadata };
      }
    }

    lastDownloadError = downloadResult.stderr || `Exit code ${downloadResult.code}`;
    console.warn(`[Downloader] Profile ${clientType} failed: ${lastDownloadError.slice(-200)}`);
  }


  // Format clean human-readable error with actionable advice for IP block / bot detection
  const lowerErr = (lastDownloadError || '').toLowerCase();
  const isBotOrIpBlock =
    lowerErr.includes('sign in to confirm') ||
    lowerErr.includes('automated queries') ||
    lowerErr.includes('http error 429') ||
    lowerErr.includes('status: 429');

  if (isBotOrIpBlock) {
    throw new Error(
      `YouTube membatasi/memblokir IP Anda sementara (Bot Detection/HTTP 429).\n` +
      `Solusi cepat:\n` +
      `1. Aktifkan Mode Pesawat (Airplane Mode) di HP selama 5 detik lalu matikan lagi untuk mendapatkan IP operator seluler baru.\n` +
      `2. Atau letakkan file cookies.txt dari browser YouTube ke folder project.`
    );
  }

  if (lowerErr.includes('standar hd 720p') || lowerErr.includes('requested format is not available') || lowerErr.includes('only images are available')) {
    throw new Error(`Video sumber tidak memiliki format HD 720p/1080p yang valid di YouTube (hanya tersedia resolusi rendah).`);
  }

  throw new Error(`Download video gagal (${qualityLabel}): ${lastDownloadError.slice(-400)}`);
}
