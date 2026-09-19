import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { trackBandwidth, trackSavedBandwidth } from './bandwidthTracker.js';
import { extractCoreProductInfo, isTitleMatchingProduct } from './discoveryService.js';
import { getSmartProxyArgs } from './downloader.js';
import { classifyPipelineError } from './networkDiagnosticService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

/**
 * Konfigurasi Terpusat AI Local Gatekeeper & Runtime Filtering
 */
export const GATEKEEPER_CONFIG = {
  SAMPLE_INTERVAL_SEC: 2.0,
  MIN_CONSECUTIVE_CLEAN_FRAMES: 3,
  MIN_CLEAN_DURATION_SEC: 4.0,
  MAX_ALLOWED_DIRTY_FRAMES: 0,
  CLEAN_CONF_THRESHOLD: 0.78,
  UNCERTAIN_CONF_THRESHOLD: 0.62,
  TIMEOUT_SEC: 25,
};

/**
 * Scan common locations for cookies.txt
 */
export function findCookiesFile() {
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
 * Base yt-dlp arguments with residential proxy and cookies
 */
function getYtDlpBaseArgs() {
  const proxyArgs = getSmartProxyArgs();

  const foundCookies = findCookiesFile();
  const cookiesArgs = foundCookies ? ['--cookies', foundCookies] : [];

  const isTermuxOrMobile = process.platform === 'android' ||
    Boolean(process.env.TERMUX_VERSION) ||
    (process.platform === 'linux' && !process.env.DISPLAY);

  const args = [
    '--no-check-certificates',
    '--geo-bypass',
    '--extractor-args', isTermuxOrMobile
      ? 'youtube:player_client=mweb,android,web;formats=missing_pot'
      : 'youtube:player_client=web,mweb,android;formats=missing_pot',
    '--sleep-requests', '1.0',
    '--user-agent', isTermuxOrMobile
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  ];

  if (cookiesArgs.length) args.push(...cookiesArgs);
  if (proxyArgs.length) args.push(...proxyArgs);

  return args;
}

/**
 * ── TAHAP 1: FETCH METADATA & DIRECT STREAM URL (0 VIDEO DOWNLOAD) ───────────
 * Fetches YouTube metadata and 360p direct HTTP stream URL using yt-dlp.
 */
export async function fetchVideoMetadataAndStream(url, { onProgress = () => {} } = {}) {
  const ytDlpPath = await getYtDlpPath();

  onProgress({
    step: 'metadata_fetch',
    message: 'Membaca metadata & stream URL YouTube tanpa download...',
    progress: 10,
  });

  // Step 1: Dump single JSON for metadata
  const metaArgs = [
    ...getYtDlpBaseArgs(),
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    url
  ];

  const metaResult = await new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, metaArgs);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

    proc.on('close', (code) => {
      if (code === 0 && stdout) {
        try {
          const parsedMeta = JSON.parse(stdout.trim());
          const metaBytes = Buffer.byteLength(stdout || '', 'utf-8');
          trackBandwidth('metadata', metaBytes, `Metadata video: ${(parsedMeta.title || '').slice(0, 40)}`);
          resolve(parsedMeta);
        } catch (e) {
          reject(new Error(`Gagal membaca metadata JSON yt-dlp: ${e.message}`));
        }
      } else {
        const diag = classifyPipelineError(stderr);
        const err = new Error(`${diag.userFriendlyReason} (${diag.failureCode}): ${stderr.slice(-300)}`);
        err.failureCode = diag.failureCode;
        err.sourceStatus = diag.sourceStatus;
        err.isNetworkOrIpIssue = diag.isNetworkOrIpIssue;
        err.actionableAdvice = diag.actionableAdvice;
        reject(err);
      }
    });

    proc.on('error', reject);
  });

  const duration = Number(metaResult.duration) || 60;
  const formats = Array.isArray(metaResult.formats) ? metaResult.formats : [];
  const maxAvailableHeight = Math.max(
    Number(metaResult.height) || 0,
    ...formats.map(f => Number(f.height) || 0)
  );
  const metadata = {
    id: metaResult.id,
    title: metaResult.title || 'YouTube Video',
    duration,
    maxHeight: maxAvailableHeight,
    description: (metaResult.description || '').slice(0, 1000),
    channel: metaResult.uploader || metaResult.channel || '',
    tags: Array.isArray(metaResult.tags) ? metaResult.tags : [],
    subtitles: metaResult.subtitles || {},
    automatic_captions: metaResult.automatic_captions || {},
  };

  // Step 2: Extract direct stream URL for low-resolution 360p (Fast & Quota-efficient)
  let streamUrl = null;
  const rawFormats = Array.isArray(metaResult.formats) ? metaResult.formats : [];
  
  // Memprioritaskan progressive direct HTTPS MP4/WebM stream (googlevideo.com/videoplayback).
  // SANGAT PENTING: Jangan gunakan HLS m3u8 playlist karena FFmpeg akan timeout 8 detik saat seek frame!
  const isDirectStream = (f) =>
    Boolean(f?.url &&
      f.url.startsWith('http') &&
      f.vcodec &&
      f.vcodec !== 'none' &&
      !f.format_id?.startsWith('sb') &&
      !f.url.includes('/sb/') &&
      !f.url.includes('.m3u8') &&
      !f.manifest_url &&
      f.protocol === 'https' &&
      !f.protocol?.includes('m3u8'));

  const directVideoFormats = rawFormats.filter(isDirectStream);

  if (directVideoFormats.length > 0) {
    const chosenFormat =
      directVideoFormats.find(f => f.format_id === '18') ||
      directVideoFormats.find(f => f.ext === 'mp4' && f.height && f.height <= 360) ||
      directVideoFormats.find(f => f.ext === 'mp4' && f.height && f.height <= 480) ||
      directVideoFormats.find(f => f.height && f.height <= 360) ||
      directVideoFormats.find(f => f.height && f.height <= 480) ||
      directVideoFormats[0];
    if (chosenFormat?.url) {
      streamUrl = chosenFormat.url;
    }
  }

  if (!streamUrl) {
    onProgress({
      step: 'stream_url_fetch',
      message: 'Mengambil stream URL preview 360p langsung dari YouTube...',
      progress: 14,
    });

    const streamArgs = [
      ...getYtDlpBaseArgs(),
      '-g',
      '-f', '18/bestvideo[ext=mp4][protocol=https][height<=360]/bestvideo[ext=mp4][protocol=https][height<=480]/best[protocol=https][height<=360]/bestvideo[protocol=https][height<=360]/worstvideo[protocol=https]/best',
      '--no-playlist',
      url
    ];

    streamUrl = await new Promise((resolve, reject) => {
      const proc = spawn(ytDlpPath, streamArgs);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          const firstLine = stdout.trim().split(/\r?\n/)[0].trim();
          if (firstLine.startsWith('http')) {
            resolve(firstLine);
          } else {
            reject(new Error(`Stream URL tidak valid: ${firstLine}`));
          }
        } else {
          const diag = classifyPipelineError(stderr);
          const err = new Error(`${diag.userFriendlyReason} (${diag.failureCode}): ${stderr.slice(-300)}`);
          err.failureCode = diag.failureCode;
          err.sourceStatus = diag.sourceStatus;
          err.isNetworkOrIpIssue = diag.isNetworkOrIpIssue;
          err.actionableAdvice = diag.actionableAdvice;
          reject(err);
        }
      });

      proc.on('error', reject);
    });
  }

  return { metadata, streamUrl };
}

/**
 * ── TAHAP 1: FILTER KASAR METADATA (0 KUOTA VIDEO, 0 TOKEN AI) ───────────────
 * Checks duration, tags, captions, and title/description for compliance.
 */
export function checkVideoMetadataCompliance(metadata, productTitle = '', options = {}) {
  if (!metadata) {
    return { eligible: false, reason: 'Metadata video kosong atau tidak tersedia.' };
  }

  const isGadget = options.niche === 'gadget_smartphone';

  // 1. Durasi Video (Wajib antara 3 menit s/d 10 menit: 150s - 600s)
  const duration = Number(metadata.duration) || 0;
  if (duration > 0 && duration < 150) {
    return { eligible: false, reason: `Durasi video terlalu pendek (${Math.round(duration)} detik). Sesuai target, minimal durasi 3 menit (150-180 detik) agar footage peragaan produk memadai.` };
  }
  if (duration > 600) {
    return { eligible: false, reason: `Durasi video terlalu panjang (${(duration / 60).toFixed(1)} menit). Sesuai target, durasi video dibatasi 3-10 menit (maksimal 600 detik).` };
  }

  // 1B. Resolusi Maksimal Video Sumber (Wajib minimal HD 720p/1080p ke atas)
  if (metadata.maxHeight && metadata.maxHeight < 720) {
    return {
      eligible: false,
      reason: `Resolusi maksimal video YouTube (${metadata.maxHeight}p) di bawah standar minimal HD 720p/1080p. Video berkualitas rendah buram tidak dapat digunakan.`
    };
  }

  const titleLower = (metadata.title || '').toLowerCase();
  const descLower = (metadata.description || '').toLowerCase();
  const tagsLower = (metadata.tags || []).map(t => String(t).toLowerCase());
  const combinedText = `${titleLower} ${descLower} ${tagsLower.join(' ')}`;

  // 2. Filter Subtitle Hardburned pada Judul / Deskripsi / Tags
  // Catatan: Soft Closed Captions (CC) di YouTube (metadata.subtitles) adalah teks eksternal yang TIDAK
  // ter-render pada pixel stream/MP4. Subtitle hardburned yang sesungguhnya dideteksi via OCR di Tahap 2.
  const subtitleKeywords = [
    'sub indo', 'subtitle', 'subtitles', 'sub english', 'eng sub',
    'terjemahan', 'lirik', 'lyrics', 'lyric', 'cc sub'
  ];
  if (subtitleKeywords.some(kw => combinedText.includes(kw))) {
    return { eligible: false, reason: 'Terdeteksi indikasi teks subtitle bawaan pada judul/deskripsi/tags.' };
  }

  // 2B. Filter Kata Kunci Terlarang pada Judul Video
  // IZINKAN unboxing (karena AI visual memiliki filter Criterion 4B untuk membuang frame kardus/kertas dan hanya mengambil demonstrasi produk).
  const bannedKeywordRegex = isGadget
    ? /\b(cara|tutorial|diy|how\s+to|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti lcd|ganti baterai|repair|reparasi|bongkar mesin|mati total|matot|bypass|bootloop)\b/i
    : /\b(cara|tutorial|diy|how\s+to|do\s+it\s+yourself|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti|repair|reparasi|bongkar)\b/i;

  if (bannedKeywordRegex.test(titleLower)) {
    return { eligible: false, reason: `Terdeteksi kata kunci terlarang (${isGadget ? 'perbaikan / servis / mati total / bypass' : 'cara / tutorial / DIY / perbaikan / servis'}) pada judul video.` };
  }

  // 2C. Filter Konten Perbaikan / Servis / Barang Rusak pada Deskripsi
  // Bersihkan URL terlebih dahulu agar link domain seperti service.kompernass.com tidak memicu false positive
  const descNoUrls = descLower.replace(/https?:\/\/[^\s]+/g, '');
  const repairDescRegex = /\b(perbaikan|penggantian|pergantian|mengganti|rusak|kerusakan|bengkel|jasa\s+servis|tempat\s+servis|reparasi|bongkar\s+mesin|mati\s+total|matot|ganti\s+lcd)\b/i;
  if (repairDescRegex.test(descNoUrls.slice(0, 500))) {
    return { eligible: false, reason: 'Terdeteksi indikasi konten perbaikan / servis / penggantian alat rusak pada deskripsi video.' };
  }

  // 2D. Filter Resep Makanan, Kuliner, Mukbang & Minuman Tanpa Review Alat (Khusus Kitchen Tools)
  if (!isGadget) {
    const foodRecipeRegex = /\b(resep|recipe|mukbang|kuliner|jajanan|street food|food review|drink review|asmr makan|asmr eat|resep masakan|menu buka puasa|menu sahur|boba milk tea|minuman kekinian|olahan makanan)\b/i;
    if (foodRecipeRegex.test(titleLower)) {
      return { eligible: false, reason: 'Judul video mengindikasikan konten resep makanan, kuliner, mukbang, atau review minuman (bukan demonstrasi produk alat dapur).' };
    }
  }

  // 2E. Filter Produk Set, Multi-Pack, Bundle, dan Kombo
  const bundleSetRegex = /\b(1\s*set|satu\s*set|1\s*paket|1\s*pack|bundle|bundling|kombo|combo|isi\s*\d+|isi\s+banyak|\d+\s*pcs|lusin|renteng|grosir|multipack)\b/i;
  if (bundleSetRegex.test(titleLower)) {
    return { eligible: false, reason: 'Judul video mengindikasikan produk set/bundle/multi-pack/kombo (sulit dicocokkan dengan link shopee tunggal).' };
  }

  // 2F. Khusus Gadget/Smartphone: Filter Aksesoris (Casing / Tempered Glass / Skin jika target adalah smartphone)
  if (isGadget && productTitle) {
    const isTargetAccessory = /\b(case|casing|softcase|hardcase|tempered glass|hydrogel|skin|charger|kabel|headset|earphone|tws|holder)\b/i.test(productTitle);
    const isVideoAccessory = /\b(casing|case|softcase|hardcase|tempered glass|hydrogel|skin hp|anti gores)\b/i.test(titleLower);
    if (!isTargetAccessory && isVideoAccessory && !/\b(unboxing|review|spesifikasi|tes gaming|kamera)\b/i.test(titleLower.replace(/\b(case|casing|tempered glass)\b/gi, ''))) {
      return { eligible: false, reason: 'Judul video mengindikasikan aksesoris pelindung HP (casing/tempered glass), bukan unit smartphone target.' };
    }
  }

  // 2G. Filter Mesin Industri, Pabrik, Alat Berat, dan Manufaktur Skala Usaha (Cegah Buang Token AI)
  const industrialRegex = /\b(pabrik|factory|manufacturing|mesin\s+industri|alat\s+berat|bengkel|mesin\s+usaha|mesin\s+umkm|mesin\s+produksi|mesin\s+pabrik|mesin\s+selep|pakan\s+ternak|mesin\s+ternak|traktor|perontok\s+padi|pemipil\s+jagung|chopper\s+pakan|chopper\s+rumput|silase|mesin\s+otomatis\s+pabrik|industri\s+makanan)\b/i;
  if (industrialRegex.test(titleLower)) {
    return { eligible: false, reason: 'Judul video mengindikasikan mesin industri / peralatan pabrik / alat berat (bukan alat dapur praktis rumah tangga).' };
  }
  if (industrialRegex.test(descNoUrls.slice(0, 500))) {
    return { eligible: false, reason: 'Deskripsi video mengindikasikan mesin industri / peralatan pabrik / alat berat.' };
  }

  // 3. Filter Iklan & Sponsor Komersial
  const adKeywords = [
    'sponsored', 'promoted', 'paid promotion', 'endorsement', 'iklan',
    'kolaborasi berbayar', 'afiliasi tutorial', 'cara jualan', 'cara live'
  ];
  if (adKeywords.some(kw => combinedText.includes(kw))) {
    return { eligible: false, reason: 'Terdeteksi indikasi konten iklan berbayar atau promosi sponsor.' };
  }

  // 4. Filter Wajah Manusia / Vlog / Format yang dilarang
  // Untuk gadget_smartphone: IZINKAN kata 'gameplay' pada judul (Slot 4 benchmark performa gaming).
  const faceAndVlogKeywords = isGadget
    ? [
        'vlog', 'daily vlog', 'a day in my life', 'podcast', 'reaction',
        'facecam', 'webcam', 'selfie', 'muka', 'wajah', 'grwm', 'get ready with me',
        'try on haul', 'try on', 'outfit', 'ootd', 'mukbang', 'skincare routine',
        'makeup tutorial', 'live stream',
        'pengalaman pribadi', 'kulitku', 'mukaku', 'wajahku',
        'curhat', 'keseharianku', 'kenalan', 'ngobrol', 'bincang', 'q&a', 'storytime',
        'talking head', 'vlogger', 'blogger',
        'haul with me', 'watch me'
      ]
    : [
        'vlog', 'daily vlog', 'a day in my life', 'podcast', 'reaction',
        'facecam', 'webcam', 'selfie', 'muka', 'wajah', 'grwm', 'get ready with me',
        'try on haul', 'try on', 'outfit', 'ootd', 'mukbang', 'skincare routine',
        'makeup tutorial', 'gameplay', 'live stream',
        'pengalaman pribadi', 'kulitku', 'mukaku', 'wajahku',
        'curhat', 'keseharianku', 'kenalan', 'ngobrol', 'bincang', 'q&a', 'storytime',
        'halo guys', 'halo teman', 'halo semuanya', 'sama aku', 'bareng aku',
        'unbox with me', 'talking head', 'vlogger', 'blogger',
        'haul with me', 'watch me'
      ];

  // Honorific/persona standalone words must use word boundaries (\b) so "memasang", "memasak", "kemasan" don't falsely match "mas"
  const personaRegex = /\b(mas|mbak|abang|bunda|mamah|teteh|kakak|host|creator)\b/i;

  const descPreview = descLower.slice(0, 500);
  const isFaceTitle = faceAndVlogKeywords.some(kw => titleLower.includes(kw)) || (!isGadget && personaRegex.test(titleLower));
  // Jangan tolak video sebelum diinspeksi visual hanya karena sapaan santai ("Halo guys", "Halo teman") di deskripsi.
  // Hanya tolak jika deskripsi secara tegas menyatakan format podcast atau daily vlog pribadi.
  const isFaceDesc = /\b(daily vlog|podcast|facecam|live stream|a day in my life)\b/i.test(descPreview);

  if (isFaceTitle || isFaceDesc) {
    return { eligible: false, reason: 'Format video terindikasi berpusat pada wajah / vlogger / persona manusia.' };
  }

  // 5. Filter Watermark & Repost Sosmed
  const watermarkKeywords = [
    'tiktok', 'douyin', 'kuaishou', 'capcut', 'repost', 'watermark',
    'shorts tiktok', 'video tiktok', 'vt tiktok'
  ];
  if (watermarkKeywords.some(kw => titleLower.includes(kw))) {
    return { eligible: false, reason: 'Judul video mengindikasikan watermark/repost dari platform sosial media lain.' };
  }

  // 6. Filter AI-Generated & Animasi / Kartun
  const aiKeywords = [
    'ai generated', 'ai video', 'sora', 'runway', 'kling', 'hailuo',
    'pika', 'animasi', '3d animation', 'cgi', 'cartoon', 'kartun', 'anime'
  ];
  if (aiKeywords.some(kw => combinedText.includes(kw))) {
    return { eligible: false, reason: 'Video terindikasi animasi, kartun, atau buatan AI.' };
  }

  // 7. Kesesuaian Kategori Produk Target & Konflik Produk Berbeda
  if (productTitle && productTitle.trim()) {
    const prodInfo = extractCoreProductInfo(productTitle, metadata.description || '');
    const coreNounLower = (prodInfo.coreProductNoun || '').toLowerCase();
    const targetTitleLower = productTitle.toLowerCase();

    // Deteksi benturan jenis produk dapur yang tidak kompatibel (Hanya untuk kitchen_tools)
    if (!isGadget) {
      const isTargetStorage = /\b(toples|stoples|wadah|tempat bumbu|kotak bumbu|botol bumbu|organizer|dispenser beras|jar|canister)\b/i.test(targetTitleLower) || /\b(toples|wadah)\b/i.test(coreNounLower);
      const isCandCookwareOrTableware = /\b(panci|wajan|kuali|frypan|saucepan|katel|vicenza|fiorenza|prasmanan|piring|mangkok|cangkir|teko)\b/i.test(titleLower);
      if (isTargetStorage && isCandCookwareOrTableware) {
        return {
          eligible: false,
          reason: `Benturan produk: Target adalah wadah/toples penyimpanan ("${prodInfo.coreProductNoun}"), tetapi video YouTube adalah alat masak/makan ("${metadata.title}").`
        };
      }

      const isTargetCookware = /\b(wajan|panci|kuali|frypan|saucepan|katel|penggorengan)\b/i.test(targetTitleLower);
      const isCandStorageOrKnife = /\b(toples|stoples|tempat bumbu|wadah bumbu|rak bumbu|pisau|gunting|parutan|chopper)\b/i.test(titleLower);
      if (isTargetCookware && isCandStorageOrKnife) {
        return {
          eligible: false,
          reason: `Benturan produk: Target adalah wajan/panci masak ("${prodInfo.coreProductNoun}"), tetapi video YouTube adalah wadah/alat lain ("${metadata.title}").`
        };
      }

      const isTargetChopper = /\b(chopper|blender|food processor|pelumat|penggiling daging)\b/i.test(targetTitleLower);
      const isCandUnrelatedTool = /\b(wajan|panci|toples|rak|spons|piring|mangkok|botol minyak)\b/i.test(titleLower);
      if (isTargetChopper && isCandUnrelatedTool) {
        return {
          eligible: false,
          reason: `Benturan produk: Target adalah chopper/blender ("${prodInfo.coreProductNoun}"), tetapi video YouTube adalah alat lain ("${metadata.title}").`
        };
      }

      const isTargetOilDispenser = /\b(botol minyak|oil dispenser|oil spray|botol kecap)\b/i.test(targetTitleLower);
      const isCandOilMismatch = /\b(wajan|panci|piring|mangkok|rak gantung|pisau)\b/i.test(titleLower) && !/\b(minyak|oil|kuas)\b/i.test(titleLower);
      if (isTargetOilDispenser && isCandOilMismatch) {
        return {
          eligible: false,
          reason: `Benturan produk: Target adalah botol/dispenser minyak ("${prodInfo.coreProductNoun}"), tetapi video YouTube adalah alat masak/makan ("${metadata.title}").`
        };
      }
    }

    const coreWords = prodInfo.multilingualWords || prodInfo.coreWords || [];

    // Cek pengecualian kategori silang non-dapur terlarang
    const crossCategoryPass = isTitleMatchingProduct(metadata.title, coreWords, {
      description: metadata.description,
      tags: metadata.tags,
      isVisualSearch: Boolean(options.isVisualSearch),
      niche: options.niche,
    });

    if (!crossCategoryPass) {
      return {
        eligible: false,
        reason: `Judul / deskripsi video YouTube ("${metadata.title}") tidak sesuai produk atau terindikasi kategori lain yang dilarang.`
      };
    }
  }

  return { eligible: true };
}

/**
 * ── TAHAP 2: SAMPLING FRAME LANGSUNG DARI STREAM URL (~2MB KUOTA) ────────────
 * Uses FFmpeg to extract 30 frames directly from the stream URL without downloading full video.
 */
export async function sampleFramesFromStream(streamUrl, outputDir, {
  duration = 60,
  maxSampleFrames = 25,
  customTimestamps = null,
  onProgress = () => {}
} = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean old frames in directory
  const existingFiles = fs.readdirSync(outputDir);
  for (const f of existingFiles) {
    try { fs.unlinkSync(path.join(outputDir, f)); } catch {}
  }

  const ffmpegPath = getFFmpegPath();
  const isMobile = process.platform === 'android' || Boolean(process.env.TERMUX_VERSION) || os.cpus().length <= 4;
  const safeDuration = Math.max(10, Number(duration) || 60);

  // Dense Temporal Sampling untuk Video Target 3 - 10 Menit (150s - 600s):
  // Menjamin seluruh rekaman demonstrasi fisik produk terinspeksi tanpa blind spot besar,
  // sekaligus melewati iklan/intro bumper awal (skip first 6-12s).
  const requestedMax = Number(maxSampleFrames) > 0 ? Number(maxSampleFrames) : (isMobile ? 38 : 45);
  const safeMax = Math.max(15, Math.min(55, requestedMax));

  const samplePoints = [];
  if (Array.isArray(customTimestamps) && customTimestamps.length > 0) {
    customTimestamps.forEach((ts, idx) => {
      samplePoints.push({ index: idx + 1, timestamp: Math.round(ts * 10) / 10 });
    });
  } else {
    // Lewati intro bumper / sponsor di awal video (6-12 detik) dan outro cards di akhir (8 detik)
    const safeStart = Math.max(6.0, Math.min(12.0, safeDuration * 0.04));
    const safeEnd = Math.max(safeStart + 15.0, safeDuration - 8.0);
    const effectiveSpan = Math.max(1, safeEnd - safeStart);

    if (safeDuration <= 300) {
      // Video 3 - 5 menit (150s - 300s): Sampling sekuensial rapat tiap ~4-6 detik di seluruh video
      const step = Math.max(3.5, Math.min(6.5, effectiveSpan / safeMax));
      let cur = safeStart;
      let pIdx = 1;
      while (cur <= safeEnd && pIdx <= safeMax) {
        samplePoints.push({ index: pIdx++, timestamp: Math.round(cur * 10) / 10 });
        cur += step;
      }
    } else {
      // Video 5 - 10 menit (300s - 600s): 8-10 kluster temporal rapat (4 frame per kluster: ts, ts+1.8s, ts+3.6s, ts+5.4s)
      // Memberikan toleransi tinggi: jika 1 frame terkena glitch, 3 frame lainnya tetap membentuk Clean Temporal Segment
      const numClusters = Math.max(6, Math.min(10, Math.floor(safeMax / 4)));
      const clusterSpan = effectiveSpan - 6.0;
      const clusterInterval = clusterSpan > 0 ? (clusterSpan / (numClusters + 1)) : 0;
      let pIdx = 1;
      for (let c = 1; c <= numClusters; c++) {
        const baseTs = Math.round((safeStart + (c * clusterInterval)) * 10) / 10;
        samplePoints.push({ index: pIdx++, timestamp: baseTs });
        if (baseTs + 1.8 <= safeEnd && pIdx <= safeMax) {
          samplePoints.push({ index: pIdx++, timestamp: Math.round((baseTs + 1.8) * 10) / 10 });
        }
        if (baseTs + 3.6 <= safeEnd && pIdx <= safeMax) {
          samplePoints.push({ index: pIdx++, timestamp: Math.round((baseTs + 3.6) * 10) / 10 });
        }
        if (baseTs + 5.4 <= safeEnd && pIdx <= safeMax) {
          samplePoints.push({ index: pIdx++, timestamp: Math.round((baseTs + 5.4) * 10) / 10 });
        }
      }
    }
  }

  onProgress({
    step: 'stream_sampling',
    message: `Sampling ${samplePoints.length} keyframe visual adaptif langsung dari stream URL (${isMobile ? 'mode mobile efisien' : 'fast seek'})...`,
    progress: 25,
  });

  console.log(`[VideoFilterService] Fast seek cluster sampling ${samplePoints.length} frames across ${safeDuration}s from stream (${isMobile ? 'Mobile 2-core' : 'Multi-core'})...`);

  const browserUserAgent = isMobile
    ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
  const browserHeaders = 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com/\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n';

  // Fast seek each timestamp with adaptive concurrency (2 parallel workers on mobile/Termux to prevent CPU heating)
  const concurrency = isMobile ? 2 : 4;
  const executing = [];
  for (const point of samplePoints) {
    // Micro pacing delay (human-like pacing)
    await new Promise(r => setTimeout(r, isMobile ? 35 : 15));

    const frameFile = `frame_${String(point.index).padStart(4, '0')}.jpg`;
    const outputPath = path.join(outputDir, frameFile);

    const p = new Promise((resolve) => {
      // Input seeking (-ss before -i) fetches only the keyframe near timestamp via HTTP Range headers
      // -an -sn -dn omits audio and subtitle parsing for maximum keyframe seek speed
      // scale=-2:270 provides optimal balance of speed and visual clarity for AI gatekeeper
      const proc = spawn(ffmpegPath, [
        '-y',
        '-user_agent', browserUserAgent,
        '-headers', browserHeaders,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '2',
        '-ss', String(point.timestamp),
        '-i', streamUrl,
        '-an',
        '-sn',
        '-dn',
        '-frames:v', '1',
        '-vf', 'scale=-2:270',
        '-q:v', '3',
        outputPath
      ]);
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }
      }, 8000);
      proc.on('close', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve();
        }
      });
      proc.on('error', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  let frameFiles = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
    .sort();

  // Percobaan kedua internal: Jika fast input seek menghasilkan 0 frame, coba mode output seek
  if (frameFiles.length === 0) {
    console.warn('[VideoFilterService] Fast input seek menghasilkan 0 frame, mencoba mode output seek...');
    const fallbackPoints = samplePoints.slice(0, 10);
    for (const point of fallbackPoints) {
      const frameFile = `frame_${String(point.index).padStart(4, '0')}.jpg`;
      const outputPath = path.join(outputDir, frameFile);
      await new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
          '-y',
          '-user_agent', browserUserAgent,
          '-headers', browserHeaders,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '4',
          '-i', streamUrl,
          '-ss', String(point.timestamp),
          '-frames:v', '1',
          '-vf', 'scale=-2:360',
          '-q:v', '3',
          outputPath
        ]);
        let finished = false;
        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            try { proc.kill('SIGKILL'); } catch {}
            resolve();
          }
        }, 15000);
        proc.on('close', () => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            resolve();
          }
        });
        proc.on('error', () => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    frameFiles = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
      .sort();
  }

  if (frameFiles.length === 0) {
    throw new Error('Tidak ada frame yang berhasil diekstrak dari stream URL.');
  }

  const pointMap = new Map(samplePoints.map(p => [`frame_${String(p.index).padStart(4, '0')}.jpg`, p.timestamp]));

  const frames = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const filename = frameFiles[i];
    const filePath = path.join(outputDir, filename);

    const frameNumber = parseInt(filename.replace('frame_', '').replace('.png', '').replace('.jpg', ''), 10);
    const timestampInSeconds = pointMap.get(filename) !== undefined
      ? pointMap.get(filename)
      : Math.max(0, Math.round(i * interval));

    const mins = Math.floor(timestampInSeconds / 60).toString().padStart(2, '0');
    const secs = Math.floor(timestampInSeconds % 60).toString().padStart(2, '0');
    const timeFormatted = `${mins}:${secs}`;

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    frames.push({
      index: i + 1,
      frameNumber,
      timestamp: timestampInSeconds,
      timeFormatted,
      base64: dataUrl,
      filePath,
    });
  }

  // Track internet data used by stream sampling (~0.8-1.5 MB)
  let sampledBytes = 0;
  for (const f of frameFiles) {
    try {
      sampledBytes += fs.statSync(path.join(outputDir, f)).size;
    } catch {}
  }
  // Include network packet overhead (~200KB)
  sampledBytes = Math.max(sampledBytes, 0.8 * 1024 * 1024);
  trackBandwidth('streamSampling', sampledBytes, `Sampling 20 frame stream URL (~${(sampledBytes / (1024 * 1024)).toFixed(2)} MB)`);

  onProgress({
    step: 'stream_sampling_done',
    message: `Berhasil mengambil ${frames.length} frame visual dari stream URL (~${(sampledBytes / (1024 * 1024)).toFixed(1)} MB kuota).`,
    progress: 35,
  });

  return { frames, totalFrames: frames.length, framesDir: outputDir };
}

/**
 * ── TAHAP 2B: ANALISA LOKAL 9:16 (0 TOKEN AI, HEMAT KUOTA GEMINI) ─────────────
 * Per instruksi pengguna: Verifikasi grafis visual (logo channel, watermark, stiker grafis,
/**
 * Memanggil AI Local Frame Gatekeeper microservice di port 5050 (MediaPipe + DBNet + MobileNetV3).
 * Mengembalikan hasil pra-pemrosesan AI jika service aktif di background (PM2/daemon).
 */
export async function callAIGatekeeperMicroservice(frames, { timeoutSec = 25, onProgress = () => {}, niche = 'kitchen_tools' } = {}) {
  try {
    const validFrames = frames.filter(f => f && f.filePath && fs.existsSync(f.filePath));
    if (validFrames.length === 0) return null;

    const payload = JSON.stringify({
      niche,
      minConsecutiveClean: GATEKEEPER_CONFIG.MIN_CONSECUTIVE_CLEAN_FRAMES,
      minCleanDuration: GATEKEEPER_CONFIG.MIN_CLEAN_DURATION_SEC,
      frames: validFrames.map(f => ({
        filePath: f.filePath,
        timestamp: f.timestamp || 0
      }))
    });

    const res = await fetch('http://127.0.0.1:5050/filter-frames', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutSec * 1000)
    });

    if (res.ok) {
      const parsed = await res.json();
      if (parsed && parsed.status === 'success') {
        return parsed;
      }
    } else {
      console.warn(`[Gatekeeper] Microservice HTTP ${res.status}. Falling back to heuristic.`);
    }
  } catch (err) {
    // Graceful fallback to heuristic checks with informative log
    console.log(`[Gatekeeper] Microservice fallback to heuristic (${err.message || 'offline'}).`);
  }
  return null;
}

/**
 * ── TAHAP 2: INSPEKSI & FILTER FRAME LOKAL (AI GATEKEEPER + HEURISTIK FALLBACK) ──
 * Memeriksa frame visual yang telah disampel di server lokal sebelum mengirim ke AI utama.
 * Tahap 1: MediaPipe Face Detection (100% faceless).
 * Tahap 2: DBNet Text Detection (membuang subtitle terbakar & promo overlay).
 * Tahap 3: MobileNetV3 (membuang bumper foto statis & kartun/animasi).
 * Tahap 4: Clean Temporal Segment Validation (hanya meloloskan segmen kontinu >= 3 frame / 4.0s).
 */
export async function inspectFramesLocally(frames, { aspectRatio = '9:16', allowPartialClean = false, onProgress = () => {}, niche = 'kitchen_tools' } = {}) {
  if (!Array.isArray(frames) || frames.length < 5) {
    return { eligible: false, cleanFrames: [], discardedFrames: [], reason: 'Jumlah frame visual tidak mencukupi untuk dianalisa.' };
  }

  // ── 0. COBA EVALUASI DENGAN AI LOCAL GATEKEEPER (MediaPipe + DBNet + MobileNetV3) ──
  const aiResult = await callAIGatekeeperMicroservice(frames, { timeoutSec: 25, onProgress, niche });
  if (aiResult && aiResult.allFrames && aiResult.allFrames.length > 0) {
    const frameByPath = new Map(frames.map(f => [f.filePath, f]));
    const cleanFrames = aiResult.allFrames
      .filter(f => f.status === 'clean')
      .map(f => {
        const orig = frameByPath.get(f.filePath) || {};
        let b64 = orig.base64 || f.base64;
        if (!b64 && f.filePath && fs.existsSync(f.filePath)) {
          const mime = f.filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
          b64 = `data:${mime};base64,${fs.readFileSync(f.filePath).toString('base64')}`;
        }
        return {
          ...orig,
          ...f,
          base64: b64,
        };
      });

    const discardedFrames = aiResult.allFrames
      .filter(f => f.status !== 'clean')
      .map(f => ({
        ...(frameByPath.get(f.filePath) || {}),
        ...f,
      }));

    const verifiedSegments = aiResult.verifiedSegments || [];
    // Syarat ketat: Video HANYA eligible jika microservice menyetujui, terdapat minimal 1 Clean Temporal Segment,
    // dan jumlah frame VERIFIED_CLEAN mencukupi minimal segmen temporal kontinu!
    const isEligible = (aiResult.eligible === true) && (verifiedSegments.length > 0) && (cleanFrames.length >= (allowPartialClean ? 2 : GATEKEEPER_CONFIG.MIN_CONSECUTIVE_CLEAN_FRAMES));

    if (isEligible) {
      console.log(`[inspectFramesLocally] 🤖 AI Local Gatekeeper: ${cleanFrames.length}/${frames.length} frame VERIFIED_CLEAN dalam ${verifiedSegments.length} segmen kontinu (${aiResult.benchmarks?.totalMs || 0}ms).`);
    } else {
      console.warn(`[inspectFramesLocally] ⛔ AI Local Gatekeeper menolak video: ${aiResult.reason} (${cleanFrames.length}/${frames.length} frame bersih, ${verifiedSegments.length} segmen).`);
    }

    const discardedFaceTimestamps = discardedFrames
      .filter(f => f.stage === 'face' || f.reason?.includes('Wajah') || f.reason?.includes('presenter'))
      .map(f => f.timestamp);
    const discardedViolationTimestamps = discardedFrames
      .filter(f => f.timestamp !== undefined)
      .map(f => f.timestamp);

    return {
      eligible: isEligible,
      cleanFrames,
      discardedFrames,
      reason: aiResult.reason,
      verifiedSegments,
      discardedFaceTimestamps,
      discardedViolationTimestamps,
      hasOpeningIntro: Boolean(aiResult.hasOpeningIntro),
      introCutoffSec: aiResult.introCutoffSec || 0.0,
      gatekeeperBackend: 'ai_gatekeeper_v2_temporal'
    };
  }

  // ── FALLBACK KE HEURISTIK PIKSEL FFmpeg (Jika Gatekeeper Python offline) ──
  const ffmpeg = getFFmpegPath();
  const W = 80;
  const H = 144;
  const frameBuffers = [];
  const cleanFrames = [];
  const discardedFrames = [];

  let subtitleBandCount = 0;
  let floatingTextCount = 0;
  let animatedGraphicCount = 0;
  let humanFaceSkinCount = 0;
  let blackFrameCount = 0;
  let bumperSlideCount = 0;
  let staticLogoCount = 0;
  let staticLogoReason = '';

  // Ekstrak area 9:16 tengah sekali saja per frame dalam RGB24 (80x144, 34 KB per frame)
  for (const f of frames) {
    if (!f.filePath || !fs.existsSync(f.filePath)) continue;

    const res = spawnSync(ffmpeg, [
      '-y',
      '-i', f.filePath,
      '-vf', `crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='(iw-ow)/2':y='(ih-oh)/2',scale=${W}:${H}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-'
    ]);

    if (res.status === 0 && res.stdout && res.stdout.length === W * H * 3) {
      frameBuffers.push(Buffer.from(res.stdout));
    }
  }

  if (frameBuffers.length < 4) {
    return { eligible: false, cleanFrames: [], discardedFrames: [], reason: 'Gagal mengekstrak frame visual untuk analisa lokal.' };
  }

  // ── 1. PEMERIKSAAN FOTO BUMPER & FRAME BEKU STATIS (TEMPORAL GLOBAL DIFFERENCE) ──
  // Membedakan kartu intro pembuka (detik 0-5) dengan bumper / slideshow di badan video
  let openingBumperCount = 0;
  let bodyBumperCount = 0;
  const staticFrameIndices = new Set();

  for (let i = 0; i < frameBuffers.length - 1; i++) {
    const ts1 = frames[i]?.timestamp ?? (i * 3);
    const ts2 = frames[i + 1]?.timestamp ?? ((i + 1) * 3);

    // Deteksi frame diam hanya valid jika frame bersebelahan waktu (<= 2.5 detik)
    if (Math.abs(ts2 - ts1) <= 2.5) {
      const b1 = frameBuffers[i];
      const b2 = frameBuffers[i + 1];
      let diff = 0;
      for (let j = 0; j < b1.length; j++) {
        diff += Math.abs(b1[j] - b2[j]);
      }
      const mad = diff / b1.length;
      // Jika MAD < 6.0 (selisih < 2.5% piksel), frame identik diam / bumper hold / foto statis
      if (mad < 6.0) {
        staticFrameIndices.add(i);
        staticFrameIndices.add(i + 1);
        if (ts1 <= 5.0 || i <= 1) {
          openingBumperCount++;
        } else {
          bodyBumperCount++;
        }
      }
    }
  }

  // ── 2. PEMERIKSAAN LOGO / WATERMARK / IDENTITAS CHANNEL STATIS DI AREA TENGAH 9:16 ──
  // Menyelidiki seluruh area tengah 9:16 (termasuk 4 sudut dan area atas/bawah) dengan persistensi multi-frame
  const pixelPersistence = new Uint8Array(W * H);
  let boldStaticLogoPairCount = 0;

  for (let t = 0; t < frameBuffers.length - 1; t++) {
    const ts = frames[t]?.timestamp ?? (t * 3);
    if (openingBumperCount > 0 && (ts <= 5.0 || t <= 1)) {
      continue;
    }

    const bt1 = frameBuffers[t];
    const bt2 = frameBuffers[t + 1];
    let boldStaticCornerEdges = 0;

    for (let y = 3; y < H - 3; y++) {
      for (let x = 3; x < W - 3; x++) {
        const isCorner = (x < 24 && y < 35) || (x > 56 && y < 35) || (x < 24 && y > 108) || (x > 56 && y > 108);
        const idx = (y * W + x) * 3;
        const leftIdx = (y * W + (x - 1)) * 3;
        const upIdx = ((y - 1) * W + x) * 3;

        const r1 = bt1[idx], g1 = bt1[idx + 1], b1 = bt1[idx + 2];
        const rLeft = bt1[leftIdx], gLeft = bt1[leftIdx + 1], bLeft = bt1[leftIdx + 2];
        const rUp = bt1[upIdx], gUp = bt1[upIdx + 1], bUp = bt1[upIdx + 2];

        const dx = (Math.abs(r1 - rLeft) + Math.abs(g1 - gLeft) + Math.abs(b1 - bLeft)) / 3;
        const dy = (Math.abs(r1 - rUp) + Math.abs(g1 - gUp) + Math.abs(b1 - bUp)) / 3;
        const spatialEdge = Math.max(dx, dy);

        // 1. Akumulasi persistensi temporal lintas frame (spatialEdge >= 22, temporalDiff <= 10)
        // Menangkap logo channel semi-transparan, watermark teks, dan badge digital
        if (spatialEdge >= 22) {
          const r2 = bt2[idx], g2 = bt2[idx + 1], b2 = bt2[idx + 2];
          const temporalDiff = (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2)) / 3;
          if (temporalDiff <= 10) {
            pixelPersistence[y * W + x]++;
            // 2. Cek logo sudut kontras sangat tinggi per pair (spatialEdge >= 55, temporalDiff <= 7)
            if (isCorner && spatialEdge >= 55 && temporalDiff <= 7) {
              boldStaticCornerEdges++;
            }
          }
        }
      }
    }

    if (boldStaticCornerEdges >= 15) {
      boldStaticLogoPairCount++;
    }
  }

  // Hitung piksel dengan persistensi tinggi lintas banyak frame (>= 4 pasangan frame sepanjang video)
  let totalPersistent = 0;
  let topLeftPersistent = 0;
  let topRightPersistent = 0;
  let bottomLeftPersistent = 0;
  let bottomRightPersistent = 0;

  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (pixelPersistence[y * W + x] >= 4) {
        totalPersistent++;
        if (x < 24 && y < 35) topLeftPersistent++;
        if (x > 56 && y < 35) topRightPersistent++;
        if (x < 24 && y > 108) bottomLeftPersistent++;
        if (x > 56 && y > 108) bottomRightPersistent++;
      }
    }
  }

  const isCornerLogo = topLeftPersistent >= 10 || topRightPersistent >= 10 || bottomLeftPersistent >= 10 || bottomRightPersistent >= 10;
  const isWatermarkOverlay = totalPersistent >= 28;
  const isBoldLogo = boldStaticLogoPairCount >= 3;

  if (isCornerLogo) {
    staticLogoCount = Math.max(topLeftPersistent, topRightPersistent, bottomLeftPersistent, bottomRightPersistent);
    staticLogoReason = `Analisa visual lokal mendeteksi logo channel statis di area sudut frame 9:16 (TL:${topLeftPersistent}, TR:${topRightPersistent}, BL:${bottomLeftPersistent}, BR:${bottomRightPersistent} piksel persisten).`;
  } else if (isWatermarkOverlay) {
    staticLogoCount = totalPersistent;
    staticLogoReason = `Analisa visual lokal mendeteksi watermark / identitas channel statis di frame 9:16 (${totalPersistent} piksel persisten).`;
  } else if (isBoldLogo) {
    staticLogoCount = boldStaticLogoPairCount;
    staticLogoReason = `Analisa visual lokal mendeteksi logo sudut statis kontras tinggi di frame 9:16 (${boldStaticLogoPairCount} perbandingan frame).`;
  }

  // ── 3. PEMERIKSAAN PER-FRAME KONTEN (SUBTITLE, FLOATING TEXT, GRAFIS ANIMASI & WAJAH) ──
  const subStartY = Math.floor(H * 0.75); // y >= 108
  const floatStartY = Math.floor(H * 0.12); // y >= 17
  const floatEndY = Math.floor(H * 0.72); // y <= 104
  const faceEndY = Math.floor(H * 0.65); // y <= 93 (Area atas hingga dada/leher)

  for (let i = 0; i < frameBuffers.length; i++) {
    const ts = frames[i]?.timestamp ?? (i * 3);
    const isOpeningFrame = openingBumperCount > 0 && (ts <= 5.0 || i <= 1);
    const buf = frameBuffers[i];
    let subWhitePixels = 0;
    let floatTextWhitePixels = 0;
    let floatTextEdges = 0;
    let animatedGraphicPixels = 0;
    let upperGenuineSkinPixels = 0;
    let totalBrightness = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 3;
        const r = buf[idx];
        const g = buf[idx + 1];
        const b = buf[idx + 2];
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        totalBrightness += gray;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        const sat = max > 0 ? delta / max : 0;
        const val = max;

        // A. Subtitle bawah (y >= 75%)
        if (y >= subStartY) {
          if (gray > 220) subWhitePixels++;
        }

        // B. Teks mengambang tengah (12% <= y <= 72%)
        if (y >= floatStartY && y <= floatEndY) {
          if (gray > 225) floatTextWhitePixels++;
          if (x > 0) {
            const prevGray = Math.round(0.299 * buf[idx - 3] + 0.587 * buf[idx - 2] + 0.114 * buf[idx - 1]);
            if (Math.abs(gray - prevGray) > 130) floatTextEdges++;
          }
        }

        // C. Grafis Animasi Overlay / Stiker Digital
        const isHyperSaturatedGraphic = (sat > 0.72 && val > 130 && (
          (r > 210 && g > 170 && b < 60) || // Emoji/cartoon yellow
          (r > 200 && g < 70 && b < 70) ||   // Pure graphic red
          (r < 60 && g > 200 && b < 90) ||   // Neon green sticker
          (r < 60 && g > 180 && b > 210) ||  // Cyan/sky graphic
          (r > 210 && g < 60 && b > 180)     // Magenta/purple graphic
        ));
        if (isHyperSaturatedGraphic) animatedGraphicPixels++;

        // D. Wajah / Tubuh Manusia di Area Atas 65%
        if (y < faceEndY) {
          const isSkin = (
            r > 75 && g > 45 && b > 25 &&
            (r > g) && (g > b) &&
            (r - g >= 10) && (r - g <= 80) &&
            (r - b >= 15) && (r - b <= 125) &&
            (sat >= 0.15 && sat <= 0.70) &&
            (val >= 55 && val <= 250)
          );
          if (isSkin) upperGenuineSkinPixels++;
        }
      }
    }

    const subTotal = (H - subStartY) * W;
    const floatTotal = (floatEndY - floatStartY + 1) * W;
    const upperTotal = faceEndY * W;
    const avgBrightness = totalBrightness / (W * H);

    if (avgBrightness < 8) blackFrameCount++;
    if (!isOpeningFrame) {
      if ((subWhitePixels / subTotal) > 0.05 && avgBrightness > 25) subtitleBandCount++;
      if ((floatTextWhitePixels / floatTotal) > 0.06 && (floatTextEdges / floatTotal) > 0.05) floatingTextCount++;
      if ((animatedGraphicPixels / (W * H)) > 0.03) animatedGraphicCount++;
      if ((upperGenuineSkinPixels / upperTotal) > 0.07) humanFaceSkinCount++;
    }

    // ── Klasifikasi granular per-frame (face, black, intro bumper, static frame, watermark, subtitle) ──
    const isFrameFace = (upperGenuineSkinPixels / upperTotal) > 0.055;
    const isFrameBlack = avgBrightness < 8;
    const isFrameIntro = Boolean(isOpeningFrame);
    const isFrameStatic = staticFrameIndices.has(i) && !isFrameIntro;
    const isFrameSubtitle = (subWhitePixels / subTotal) > 0.038 && avgBrightness > 25;
    const isFrameFloatingText = (floatTextWhitePixels / floatTotal) > 0.045 && (floatTextEdges / floatTotal) > 0.04;
    const isFrameGraphic = (animatedGraphicPixels / (W * H)) > 0.025;
    const isFrameWatermark = isCornerLogo || isWatermarkOverlay || isBoldLogo;

    if (isFrameFace || isFrameBlack || isFrameIntro || isFrameStatic || isFrameSubtitle || isFrameFloatingText || isFrameGraphic || isFrameWatermark) {
      let rReason = 'dirty_frame';
      if (isFrameFace) rReason = 'face';
      else if (isFrameBlack) rReason = 'black';
      else if (isFrameStatic) rReason = 'static_frame';
      else if (isFrameIntro) rReason = 'intro_bumper';
      else if (isFrameSubtitle) rReason = 'subtitle';
      else if (isFrameWatermark) rReason = 'watermark';
      else if (isFrameFloatingText) rReason = 'floating_text';
      else if (isFrameGraphic) rReason = 'animated_graphic';

      discardedFrames.push({
        ...frames[i],
        index: i,
        timestamp: ts,
        filePath: frames[i]?.filePath,
        stage: rReason,
        reason: rReason,
        status: 'discarded',
        decision: 'REJECT',
      });
    } else {
      cleanFrames.push({
        ...frames[i],
        index: i,
        timestamp: ts,
        filePath: frames[i]?.filePath,
        status: 'candidate_clean',
      });
    }
  }

  // ── VALIDASI SEGMEN TEMPORAL PADA HEURISTIK FALLBACK ──
  // Hanya loloskan frame yang berada di dalam rentang waktu kontinu (>= 3 frame berurutan / 3.5s)
  const sortedCandidates = [...cleanFrames].sort((a, b) => a.timestamp - b.timestamp);
  const verifiedSegments = [];
  let currentStreak = [];

  for (const f of sortedCandidates) {
    if (currentStreak.length === 0) {
      currentStreak.push(f);
    } else {
      const prevTs = currentStreak[currentStreak.length - 1].timestamp;
      if (Math.abs(f.timestamp - prevTs) <= 3.5) {
        currentStreak.push(f);
      } else {
        if (currentStreak.length >= 3 && (currentStreak[currentStreak.length - 1].timestamp - currentStreak[0].timestamp) >= 3.5) {
          verifiedSegments.push({
            startSec: currentStreak[0].timestamp,
            endSec: currentStreak[currentStreak.length - 1].timestamp,
            frameCount: currentStreak.length,
            cleanTimestamps: currentStreak.map(c => c.timestamp),
          });
        }
        currentStreak = [f];
      }
    }
  }
  if (currentStreak.length >= 3 && (currentStreak[currentStreak.length - 1].timestamp - currentStreak[0].timestamp) >= 3.5) {
    verifiedSegments.push({
      startSec: currentStreak[0].timestamp,
      endSec: currentStreak[currentStreak.length - 1].timestamp,
      frameCount: currentStreak.length,
      cleanTimestamps: currentStreak.map(c => c.timestamp),
    });
  }

  // Filter hanya frame yang masuk ke dalam verifiedSegments
  const verifiedTimestamps = new Set();
  for (const seg of verifiedSegments) {
    for (const ts of seg.cleanTimestamps) {
      verifiedTimestamps.add(ts);
    }
  }

  const finalClean = [];
  for (const f of cleanFrames) {
    if (verifiedTimestamps.has(f.timestamp)) {
      finalClean.push({ ...f, status: 'clean', decision: 'VERIFIED_CLEAN' });
    } else {
      discardedFrames.push({
        ...f,
        status: 'discarded',
        stage: 'temporal_inconsistency',
        decision: 'ISOLATED_CLEAN_REJECT',
        reason: 'Frame bersih terisolasi tanpa konsistensi temporal (kurang dari syarat minimal 3 frame berurutan)'
      });
    }
  }

  const totalBumperFrames = openingBumperCount + bodyBumperCount;
  const bumperRatio = totalBumperFrames / Math.max(1, frameBuffers.length - 1);
  if (bodyBumperCount >= 3 || bumperRatio >= 0.35) {
    return {
      eligible: false,
      cleanFrames: [],
      discardedFrames,
      verifiedSegments: [],
      reason: `Analisa visual lokal mendeteksi video berupa slideshow foto statis / gambar diam (${bodyBumperCount} frame beku).`
    };
  }

  const blackRatio = blackFrameCount / frameBuffers.length;
  if (blackRatio > 0.75) {
    return {
      eligible: false,
      cleanFrames: [],
      discardedFrames,
      verifiedSegments: [],
      reason: `Analisa visual lokal mendeteksi video kosong / rusak (${Math.round(blackRatio * 100)}% frame hitam pekat).`
    };
  }

  const isEligible = verifiedSegments.length > 0 && finalClean.length >= (allowPartialClean ? 2 : GATEKEEPER_CONFIG.MIN_CONSECUTIVE_CLEAN_FRAMES);

  return {
    eligible: isEligible,
    reason: isEligible ? undefined : 'Tidak ditemukan Clean Temporal Segment kontinu (minimal 3 frame berurutan / 4.0s bebas watermark/wajah/subtitle).',
    cleanFrames: finalClean,
    discardedFrames,
    verifiedSegments,
    cleanFrameCount: finalClean.length,
    discardedFrameCount: discardedFrames.length,
    discardedFaceTimestamps: discardedFrames.filter(f => f.stage === 'face' || f.reason === 'face' || f.reason?.includes('Wajah')).map(f => f.timestamp),
    discardedViolationTimestamps: discardedFrames.filter(f => f.timestamp !== undefined).map(f => f.timestamp),
    hasOpeningIntro: openingBumperCount > 0,
    introCutoffSec: openingBumperCount > 0 ? 5.0 : 0,
    hasOccasionalFace: humanFaceSkinCount > 0,
    faceFrameCount: humanFaceSkinCount,
    hasStaticLogo: Boolean(staticLogoReason),
    hasSubtitles: subtitleBandCount >= 2,
    hasFloatingText: floatingTextCount >= 2,
    hasAnimatedGraphic: animatedGraphicCount >= 2,
  };
}

/**
 * Memfilter frame visual dari 1 kandidat secara granular per frame:
 * Hanya mengembalikan kandidat yang memiliki Clean Temporal Segments yang terverifikasi.
 */
export async function filterCandidateFramesPerFrame(frames, { candidateIndex = 0, candidate = null, niche = 'kitchen_tools' } = {}) {
  const result = await inspectFramesLocally(frames, { allowPartialClean: false, niche });
  if (!result.eligible) {
    return { candidateIndex, candidate, cleanFrames: [], eligible: false, reason: result.reason, verifiedSegments: [] };
  }

  const clean = (result.cleanFrames || []).map(f => ({
    ...f,
    candidateIndex,
    candidateTitle: candidate?.title || '',
    candidateUrl: candidate?.url || '',
    videoId: candidate?.id || '',
    candidate,
  }));

  return {
    candidateIndex,
    candidate,
    eligible: clean.length >= GATEKEEPER_CONFIG.MIN_CONSECUTIVE_CLEAN_FRAMES,
    cleanFrames: clean,
    verifiedSegments: result.verifiedSegments || [],
    discardedCount: frames.length - clean.length,
    totalFrames: frames.length,
  };
}

/**
 * Menggabungkan (pooling) frame-frame bersih dari hingga 5 kandidat video menjadi satu kumpulan ~30 frame pilihan.
 * Menjamin distribusi berimbang antar kandidat dan menyematkan metadata sumber agar AI dapat menandai klipnya.
 *
 * @param {Array<{ candidateIndex: number, candidate: object, cleanFrames: Array }>} candidateResults
 * @param {{ maxTotalFrames?: number }} options
 * @returns {Array<{ candidateIndex: number, candidate: object, timestamp: number, filePath: string, displayLabel: string }>}
 */
export function poolMultiCandidateFrames(candidateResults, { maxTotalFrames = 30 } = {}) {
  const valid = (candidateResults || []).filter(c => Array.isArray(c.cleanFrames) && c.cleanFrames.length > 0);
  if (valid.length === 0) return [];

  const perCand = Math.max(4, Math.floor(maxTotalFrames / valid.length));
  const pooled = [];

  // 1. Ambil porsi berimbang dari masing-masing kandidat
  for (const item of valid) {
    const cand = item.candidate || {};
    const idx = item.candidateIndex;
    const frames = item.cleanFrames;

    const candTitle = cand.title || '';
    const candUrl = cand.url || '';
    const vidId = cand.id || candUrl || '';

    if (frames.length <= perCand) {
      for (const f of frames) {
        pooled.push({
          ...f,
          candidateIndex: idx,
          candidate: cand,
          candidateTitle: candTitle,
          candidateUrl: candUrl,
          videoId: vidId,
          displayLabel: `Video #${idx + 1} (${formatSecondsLocal(f.timestamp)})`,
        });
      }
    } else {
      const step = frames.length / perCand;
      for (let s = 0; s < perCand; s++) {
        const frameIdx = Math.min(frames.length - 1, Math.floor(s * step));
        const f = frames[frameIdx];
        pooled.push({
          ...f,
          candidateIndex: idx,
          candidate: cand,
          candidateTitle: candTitle,
          candidateUrl: candUrl,
          videoId: vidId,
          displayLabel: `Video #${idx + 1} (${formatSecondsLocal(f.timestamp)})`,
        });
      }
    }
  }

  // 2. Jika total belum mencapai maxTotalFrames, isi sisa kuota dari kandidat yang memiliki banyak frame bersih
  if (pooled.length < maxTotalFrames) {
    for (const item of valid) {
      const cand = item.candidate || {};
      const idx = item.candidateIndex;
      const candTitle = cand.title || '';
      const candUrl = cand.url || '';
      const vidId = cand.id || candUrl || '';

      for (const f of item.cleanFrames) {
        if (!pooled.some(p => p.filePath === f.filePath)) {
          pooled.push({
            ...f,
            candidateIndex: idx,
            candidate: cand,
            candidateTitle: candTitle,
            candidateUrl: candUrl,
            videoId: vidId,
            displayLabel: `Video #${idx + 1} (${formatSecondsLocal(f.timestamp)})`,
          });
          if (pooled.length >= maxTotalFrames) break;
        }
      }
      if (pooled.length >= maxTotalFrames) break;
    }
  }

  return pooled.slice(0, maxTotalFrames);
}

function formatSecondsLocal(secs) {
  const s = Math.max(0, Math.floor(secs || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Melakukan sampling frame rapat (dense 1 frame per 1-1.5s) di sekitar timestamp frame yang lolos Gatekeeper.
 * Memverifikasi kontinuitas gerakan fisik dan memberikan rangkaian frame adegan nyata ke AI Storyboard.
 *
 * @param {string} streamUrl
 * @param {string} outputDir
 * @param {Array<{ timestamp: number }>} cleanFrames
 * @param {{ duration?: number, onProgress?: Function }} options
 * @returns {Promise<Array<object>>}
 */
export async function sampleDenseClustersAroundCleanFrames(streamUrl, outputDir, cleanFrames = [], {
  duration = 60,
  onProgress = () => {}
} = {}) {
  if (!Array.isArray(cleanFrames) || cleanFrames.length === 0 || !streamUrl) {
    return [];
  }

  // Pilih hingga 4 anchor timestamp bersih terbaik (sebarkan secara temporal)
  const sorted = [...cleanFrames].sort((a, b) => a.timestamp - b.timestamp);
  const anchors = [];
  for (const f of sorted) {
    const ts = f.timestamp || 0;
    if (ts < 3.0 || ts > duration - 3.0) continue;
    // Beri jarak minimal 10s antar anchor agar tidak menumpuk di 1 titik
    if (anchors.every(a => Math.abs(a - ts) >= 10.0)) {
      anchors.push(ts);
      if (anchors.length >= 4) break;
    }
  }

  if (anchors.length === 0 && sorted.length > 0) {
    anchors.push(sorted[0].timestamp || 5.0);
  }

  // Untuk setiap anchor, buat 1-2 timestamp rapat (+1.2s, +2.4s)
  const denseTimestamps = [];
  for (const a of anchors) {
    if (a + 1.2 < duration - 2.0) denseTimestamps.push(Math.round((a + 1.2) * 10) / 10);
    if (a + 2.4 < duration - 2.0) denseTimestamps.push(Math.round((a + 2.4) * 10) / 10);
  }

  if (denseTimestamps.length === 0) return [];

  const denseDir = path.join(outputDir, 'dense_clusters');
  if (!fs.existsSync(denseDir)) fs.mkdirSync(denseDir, { recursive: true });

  onProgress({
    step: 'stream_sampling_dense',
    message: `Sampling rapat ${denseTimestamps.length} frame di sekitar kandidat aksi fisik...`,
    progress: 30,
  });

  const ffmpegPath = getFFmpegPath();
  const isMobile = process.platform === 'android' || Boolean(process.env.TERMUX_VERSION) || os.cpus().length <= 4;
  const concurrency = isMobile ? 2 : 4;
  const executing = [];
  const densePoints = denseTimestamps.map((ts, idx) => ({ index: idx + 1, timestamp: ts }));

  const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
  const browserHeaders = 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com/\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n';

  for (const point of densePoints) {
    const frameFile = `dense_${String(point.index).padStart(4, '0')}.jpg`;
    const outputPath = path.join(denseDir, frameFile);

    const p = new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-y',
        '-user_agent', browserUserAgent,
        '-headers', browserHeaders,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '2',
        '-ss', String(point.timestamp),
        '-i', streamUrl,
        '-an', '-sn', '-dn',
        '-frames:v', '1',
        '-vf', 'scale=-2:270',
        '-q:v', '3',
        outputPath
      ]);
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }
      }, 7000);
      proc.on('close', () => {
        if (!finished) { finished = true; clearTimeout(timer); resolve(); }
      });
      proc.on('error', () => {
        if (!finished) { finished = true; clearTimeout(timer); resolve(); }
      });
    });

    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  const denseFiles = fs.readdirSync(denseDir).filter(f => f.startsWith('dense_') && f.endsWith('.jpg')).sort();
  if (denseFiles.length === 0) return [];

  const densePointMap = new Map(densePoints.map(p => [`dense_${String(p.index).padStart(4, '0')}.jpg`, p.timestamp]));
  const denseFrames = [];

  for (let i = 0; i < denseFiles.length; i++) {
    const filename = denseFiles[i];
    const filePath = path.join(denseDir, filename);
    const ts = densePointMap.get(filename) || 0;
    const mins = Math.floor(ts / 60).toString().padStart(2, '0');
    const secs = Math.floor(ts % 60).toString().padStart(2, '0');
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    denseFrames.push({
      index: 1000 + i + 1,
      frameNumber: 1000 + i + 1,
      timestamp: ts,
      timeFormatted: `${mins}:${secs}`,
      base64: `data:image/jpeg;base64,${base64Data}`,
      filePath,
      isDenseCompanion: true,
    });
  }

  // Verifikasi cepat dengan AI Gatekeeper jika aktif
  try {
    const gkRes = await callAIGatekeeperMicroservice(denseFrames, { timeoutSec: 10 });
    if (gkRes && Array.isArray(gkRes.allFrames)) {
      const cleanPaths = new Set(gkRes.allFrames.filter(f => f.status === 'clean').map(f => f.filePath));
      return denseFrames.filter(f => cleanPaths.has(f.filePath));
    }
  } catch {}

  return denseFrames;
}
