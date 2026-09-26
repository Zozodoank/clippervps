import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { trackBandwidth, trackSavedBandwidth } from './bandwidthTracker.js';
import { extractCoreProductInfo, isTitleMatchingProduct } from './discoveryService.js';
import { getSmartProxyArgs } from './downloader.js';
import { classifyPipelineError } from './networkDiagnosticService.js';
import { getNichePreset } from '../config/nichePresets.js';

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
      ? 'youtube:player_client=tv,web_safari,android,web;formats=missing_pot'
      : (foundCookies ? 'youtube:player_client=web,mweb,android;formats=missing_pot' : 'youtube:player_client=tv,web_safari,mweb,android,web;formats=missing_pot'),
    '--sleep-requests', '1.0',
    '--user-agent', isTermuxOrMobile
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  ];

  if (cookiesArgs.length) args.push(...cookiesArgs);
  if (proxyArgs.length) args.push(...proxyArgs);

  // Enable Node.js JS runtime to solve YouTube n-token signature challenges without throttle and expose full HD formats
  args.push('--js-runtimes', 'node');

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
  const maxAvailableWidth = Math.max(
    Number(metaResult.width) || 0,
    ...formats.map(f => Number(f.width) || 0)
  );
  const metadata = {
    id: metaResult.id,
    title: metaResult.title || 'YouTube Video',
    duration,
    maxHeight: maxAvailableHeight,
    maxWidth: maxAvailableWidth,
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
      directVideoFormats.find(f => f.format_id === '135') || // 480p
      directVideoFormats.find(f => f.ext === 'mp4' && f.height && f.height === 480) ||
      directVideoFormats.find(f => f.format_id === '18') || // 360p
      directVideoFormats.find(f => f.ext === 'mp4' && f.height && f.height <= 480) ||
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
      '-f', '135/18/bestvideo[ext=mp4][protocol=https][height<=480]/bestvideo[ext=mp4][protocol=https][height<=360]/best[protocol=https][height<=480]/bestvideo[protocol=https][height<=480]/worstvideo[protocol=https]/best',
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

  // 1. Durasi Video (Wajib antara 50 detik s/d 15 menit: 50s - 900s, harmonis dengan discovery & downloader)
  const duration = Number(metadata.duration) || 0;
  if (duration > 0 && duration < 50) {
    return { eligible: false, reason: `Durasi video terlalu pendek (${Math.round(duration)} detik). Minimal 50 detik agar footage peragaan produk memadai.` };
  }
  if (duration > 900) {
    return { eligible: false, reason: `Durasi video terlalu panjang (${(duration / 60).toFixed(1)} menit). Durasi video dibatasi maksimal 15 menit (900 detik).` };
  }

  // 1A. Resolusi Maksimal Video (WAJIB tersedia minimal 720p HD; tolak sumber buram 144p/240p/360p/480p).
  //     Diperiksa dari resolusi MAKSIMAL YANG TERSEDIA di YouTube (maxHeight/maxWidth), BUKAN dari stream
  //     preview 480p yang sengaja dipakai untuk sampling hemat kuota. Render akhir tetap men-scale ke 1080x1920.
  //     Aturan orientation-agnostic: sisi TERPENDEK dari sumber maksimal harus >= 720p (720p landscape 1280x720,
  //     maupun short vertikal 720x1280 lolos; sedangkan 854x480 / 540x960 yang buram ditolak).
  //     PENTING: daftar format anonim (TANPA cookies) sering dibatasi YouTube sampai 360p (PO-token gate),
  //     sehingga resolusi maksimal yang terlihat TIDAK mencerminkan kualitas asli video. Karena itu gerbang
  //     keras ini hanya ditegakkan bila probe dapat dipercaya (ada file cookies). Tanpa cookies, lewati penolakan
  //     (cukup peringatan) agar tidak semua kandidat tertolak; downloader tetap mengambil format terbaik yang
  //     tersedia dan render akhir men-upscale ke 1080x1920.
  const hasTrustedProbe = (typeof options.enforceResolution === 'boolean')
    ? options.enforceResolution
    : Boolean(findCookiesFile());
  const knownDims = [Number(metadata.maxWidth) || 0, Number(metadata.maxHeight) || 0].filter(d => d > 0);
  const shortSide = knownDims.length > 0 ? Math.min(...knownDims) : 0;
  if (shortSide > 0 && shortSide < 720) {
    if (hasTrustedProbe) {
      return { eligible: false, reason: `Resolusi maksimal video (${metadata.maxWidth}x${metadata.maxHeight}) di bawah standar 720p (sisi terpendek ${shortSide}p). Sumber buram ditolak; sistem akan mencari kandidat lebih tajam.` };
    }
    console.warn(`[Gate Resolusi] Kandidat "${(metadata.title || '').slice(0, 40)}" hanya terlihat ${metadata.maxWidth}x${metadata.maxHeight} pada probe anonim (tanpa cookies, dibatasi 360p). TIDAK ditolak — kualitas asli tidak dapat dipastikan tanpa cookies; lanjut unduh format terbaik.`);
  }

  const titleLower = (metadata.title || '').toLowerCase();
  const descLower = (metadata.description || '').toLowerCase();
  const tagsLower = (metadata.tags || []).map(t => String(t).toLowerCase());
  const combinedText = `${titleLower} ${descLower} ${tagsLower.join(' ')}`;

  // 1B. Filter Bahasa & Aksara Asing Non-Latin (Hanzi / Mandarin, Devanagari, Thai, Arabic, Cyrillic, Hangul, Kana)
  // Per requirement: Brand kebanyakan produk China/marketplace, tapi video WAJIB bukan berbahasa China/asing!
  const foreignScriptRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u0900-\u097F\u0980-\u09FF\u0E00-\u0E7F\u0600-\u06FF\u0400-\u04FF\uAC00-\uD7AF\u3040-\u30ff]/;
  if (foreignScriptRegex.test(metadata.title || '')) {
    return { eligible: false, reason: 'Judul video terdeteksi berbahasa non-Latin (tulisan Mandarin / Hanzi / aksara asing). Video wajib berbahasa Indonesia atau Inggris.' };
  }

  // Filter platform media sosial China & indikasi bahasa Mandarin
  const chinesePlatformRegex = /\b(douyin|kuaishou|bilibili|xiaohongshu|weibo|mandarin|bahasa mandarin|chinese version|china version|cn version|chinesecooking)\b/i;
  if (chinesePlatformRegex.test(combinedText)) {
    return { eligible: false, reason: 'Video terindikasi dari platform video China (Douyin/Bilibili/Kuaishou) atau berbahasa Mandarin.' };
  }

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
  // Catatan: Pembukaan kardus & intro awal (0-12s) serta outro (8s) sudah otomatis dilewati saat sampling frame.
  // Video unboxing/hands-on SANGAT DITERIMA karena memuat footage b-roll fisik produk yang kaya & variatif.
  // Hanya tolak konten sampah tanpa produk fisik nyata (seperti kardus kosong atau packing pesanan olshop).
  const pureTrashPackagingRegex = /\b(kardus\s+kosong|bubble\s*wrap\s+only|packing\s+pesanan|bungkus\s+paket\s+olshop|koleksi\s+kardus)\b/i;
  if (pureTrashPackagingRegex.test(titleLower)) {
    return { eligible: false, reason: 'Judul video mengindikasikan kemasan kosong / packing pesanan tanpa produk nyata.' };
  }

  const isToolDemoTitle = /\b(alat|cetakan|maker|chopper|slicer|parutan|peeler|presser|cutter|pisau|gunting|wajan|panci|dispenser|sealer|praktis|review|demo|pakai|menggunakan)\b/i.test(titleLower);

  const bannedKeywordRegex = isGadget
    ? /\b(perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti lcd|ganti baterai|repair|reparasi|bongkar mesin|mati total|matot|bypass|bootloop)\b/i
    : /\b(perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti|repair|reparasi|bongkar)\b/i;

  if (bannedKeywordRegex.test(titleLower)) {
    return { eligible: false, reason: `Terdeteksi kata kunci terlarang (${isGadget ? 'perbaikan / servis / mati total / bypass' : 'perbaikan / servis / bongkar'}) pada judul video.` };
  }

  // Khusus kata 'cara' atau 'tutorial': hanya dilarang jika BUKAN peragaan alat/produk fisik
  if (!isToolDemoTitle && /\b(cara|tutorial|diy|how\s+to|do\s+it\s+yourself)\b/i.test(titleLower)) {
    return { eligible: false, reason: 'Terdeteksi kata kunci tutorial/cara/DIY umum pada judul video.' };
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

  // 2G. Blacklist mesin/factory/industrial footage at metadata stage.
  // Compact countertop appliances remain allowed only when the TARGET explicitly describes
  // a compact machine/appliance; generic machine footage is noise for ordinary hand-tools.
  const targetCompactMachine =
    /\b(mesin|machine|appliance|alat\s+elektrik|elektrik)\b/i.test(productTitle) &&
    /\b(mini|portable|compact|countertop|kitchen|dapur|handheld|usb|electric|elektrik|chopper|blender|mixer|frother|sealer|toaster|waffle|food\s+processor)\b/i.test(productTitle);

  const machineTitleRegex =
    /\b(?:industrial\s+machine|factory\s+machine|production\s+machine|packing\s+machine|packaging\s+machine|commercial\s+machine|industrial|machinery|mesin\s+industri|mesin\s+pabrik|mesin\s+produksi|mesin\s+packing|mesin\s+pengemas|mesin\s+komersial|mesin\s+besar|mesin\s+raksasa|cnc|conveyor|hydraulic\s+press|lathe\s+machine|milling\s+machine|washing\s+machine|mesin\s+cuci|\bmesin\b|\bmachine\b|\bmachinery\b)\b/i;

  if (machineTitleRegex.test(titleLower) && !targetCompactMachine) {
    return { eligible: false, reason: 'Video terindikasi footage mesin/machinery, bukan demonstrasi alat rumah tangga yang sesuai.' };
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
        'talking head', 'vlogger', 'blogger',
        'haul with me', 'watch me'
      ];

  const descPreview = descLower.slice(0, 500);
  // Jangan tolak video sebelum diinspeksi visual hanya karena sapaan santai ("Halo guys", "bunda", "kakak") di judul atau deskripsi.
  // Hanya tolak jika judul atau deskripsi secara tegas menyatakan format vlog personal, podcast, atau facecam.
  const isFaceTitle = faceAndVlogKeywords.some(kw => titleLower.includes(kw));
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
  // NOTE: dilewati khusus untuk OEM manual (skipProductIdentityGates) karena manusia sudah
  // menjamin kecocokan produk. Semua guard kualitas di atas (durasi/resolusi/format/vlog/
  // watermark/asing/iklan) TETAP ditegakkan. Kandidat otomatis tidak pernah menyetel flag ini.
  if (productTitle && productTitle.trim() && !options.skipProductIdentityGates) {
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
 * Budget frame yang benar-benar akan DIPROSES Gatekeeper, dihitung dari effectiveSpan
 * (bukan durasi mentah) agar basis hulu == basis hilir (spanSec aktual di
 * inspectFramesLocally). Divisor 3.25 (BUKAN 3.2): interval grid jadi >= 3.25s sehingga
 * intervalCap hilir (floor(span/3.2)+1) punya margin keketatan terhadap noise floating-point.
 * Dengan 3.2, durasi yang eff/3.2-nya tepat integer (mis. span 96/560/640/720s) memicu
 * off-by-one: span aktual grid (N-1)/N*span jatuh ke bawah kelipatan 3.2 saat di-floor.
 * +1 juga dibuang: grid N titik menghasilkan span aktual (N-1)/N*span, bukan span penuh.
 * Interval hasil tetap < 3.5s => invariant pairing statis Gatekeeper tidak pernah tembus.
 *
 * JAMINAN "subsample hilir = no-op" hanya berlaku di domain budget murni,
 * yaitu ketika floor(effectiveSpan/3.25) berada di antara floor 15 dan cap GK_MAX_BATCH_FRAMES
 * (dengan default 240: span efektif ~52s - 780s). Di luar rentang itu, clamp max(15)/min(cap)
 * mengambil alih: input GK tetap identik dengan perilaku hari ini (subsample hilir sudah
 * terjadi tanpa flag), tapi log "Batch gatekeeper dipangkas" mungkin masih muncul - BUKAN regresi.
 */
export function gatekeeperFrameBudget(effectiveSpanSec) {
  const maxGk = Math.max(20, Number(process.env.GK_MAX_BATCH_FRAMES) || 240);
  return Math.max(15, Math.min(maxGk, Math.floor(effectiveSpanSec / 3.25)));
}

/**
 * ── TAHAP 2: SAMPLING FRAME LANGSUNG DARI STREAM URL ─────────────────────────
 * Uses FFmpeg to extract frames densely ( caller-requested dur/1.5 -> 200@5mnt, 240@6mnt, cap 500 )
 * directly from the stream URL without downloading the full video.
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
  // BUDGET HEMAT (20 titik per menit): 10 menit (600s) = 200 frame (interval ~3s).
  // Cap 200 menggantikan 150 lama; caller passing dur/3.0 sehingga rasio per menit konsisten.
  const requestedMax = Number(maxSampleFrames) > 0 ? Number(maxSampleFrames) : (isMobile ? 38 : 45);
  const safeMax = Math.max(15, Math.min(200, requestedMax));

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

    // GK_ALIGN_SAMPLING (default OFF): samakan JUMLAH SEEK dengan budget yang bakal
    // diproses Gatekeeper - frame di atas batchCap toh tidak pernah dibaca downstream
    // (inspectFramesLocally meng-subsample merata, hanya hasil GK yang mengalir ke Stage F).
    // Basis: effectiveSpan SETELAH trim tepi - sama persis dengan spanSec aktual di
    // inspectFramesLocally, sehingga subsample hilir jadi no-op & log validasi bersih.
    let maxPoints = safeMax;
    if (process.env.GK_ALIGN_SAMPLING === '1') {
      const budget = gatekeeperFrameBudget(effectiveSpan);
      if (budget < maxPoints) {
        console.log(`[VideoFilterService] 🧮 GK_ALIGN_SAMPLING: seek ${maxPoints} -> ${budget} frame (span efektif ${effectiveSpan.toFixed(0)}s, interval ~${(effectiveSpan / budget).toFixed(2)}s < 3.5s).`);
        maxPoints = budget;
      }
    }

    // Sampling seragam RAPAT di SELURUH video (bukan klaster hemat) untuk semua durasi & perangkat.
    // interval = rentang aman / jumlah frame target (mis. 280s / 200 = 1.4s). Floor 0.5s jaga-jaga.
    const interval = Math.max(0.5, effectiveSpan / maxPoints);
    let cur = safeStart;
    let pIdx = 1;
    while (cur <= safeEnd && pIdx <= maxPoints) {
      samplePoints.push({ index: pIdx++, timestamp: Math.round(cur * 10) / 10 });
      cur += interval;
    }
  }

  onProgress({
    step: 'stream_sampling',
    message: `Sampling padat ${samplePoints.length} keyframe visual langsung dari stream URL (${isMobile ? 'Termux - padat penuh' : 'fast seek - padat penuh'})...`,
    progress: 25,
  });

  console.log(`[VideoFilterService] Fast seek cluster sampling ${samplePoints.length} frames across ${safeDuration}s from stream (${isMobile ? 'Mobile 2-core' : 'Multi-core'})...`);

  const browserUserAgent = isMobile
    ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  // Build cookie string from cookies.txt so googlevideo accepts FFmpeg's request.
  let cookieHdr = '';
  const cookiePath = findCookiesFile();
  if (cookiePath) {
    try {
      const cLines = fs.readFileSync(cookiePath, 'utf-8').split(/\r?\n/);
      const pairs = [];
      for (const line of cLines) {
        if (line.startsWith('#') || !line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        const [domain, , , , , name, value] = parts;
        if (/youtube|google/i.test(domain)) pairs.push(`${name}=${value}`);
      }
      if (pairs.length) cookieHdr = `Cookie: ${pairs.join('; ')}\r\n`;
    } catch {}
  }
  const browserHeaders = 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com/\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n' + cookieHdr;

  // ── BATCH DOWNLOAD: single sequential read, seek lokal (167× hemat vs 150 remote seeks) ──
  // Empiris rxbench_pc 2026-09: 150 remote spawns × ~5.9 MB/spawn = 890 MB utk 5.3 MB JPEG.
  // Download 1× ~130 MB (480p/648s) → seek lokal instant (zero network per frame).
  // Matikan: SAMPLE_BATCH_MODE=0 (fall back per-spawn remote seek).
  const batchEnabled = process.env.SAMPLE_BATCH_MODE !== '0';
  const tempStreamFile = path.join(outputDir, '_stream_cache.mp4');
  let seekInput = streamUrl;
  let networkArgs = [
    '-user_agent', browserUserAgent, '-headers', browserHeaders,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', isMobile ? '4' : '2',
  ];
  let downloadedBytes = 0;

  if (batchEnabled) {
    console.log(`[VideoFilterService] 📥 Download stream 1× (hemat vs ${samplePoints.length} remote seeks)...`);
    console.log(`[VideoFilterService] 🔗 streamUrl: ${streamUrl.slice(0, 80)}...`);
    onProgress({ step: 'stream_sampling', message: 'Mengunduh 1× stream video langsung ke file lokal...', progress: 22 });
    const dlResult = await new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-y',
        '-user_agent', browserUserAgent, '-headers', browserHeaders,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', streamUrl,
        '-map', '0:v', '-c:v', 'copy', '-an', '-f', 'mp4',
        tempStreamFile,
      ]);
      let dlStderr = '';
      proc.stderr.on('data', d => { dlStderr += d.toString(); if (dlStderr.length > 4000) dlStderr = dlStderr.slice(-2000); });
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve({ ok: false, reason: 'timeout_180s' }); }, 180000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        const exists = fs.existsSync(tempStreamFile);
        const sz = exists ? fs.statSync(tempStreamFile).size : 0;
        if (code === 0 && sz > 50000) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, reason: `exit=${code} size=${sz}`, stderr: dlStderr.slice(-500) });
        }
      });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
    });
    if (dlResult.ok) {
      downloadedBytes = fs.statSync(tempStreamFile).size;
      seekInput = tempStreamFile;
      networkArgs = [];
      console.log(`[VideoFilterService] ✅ Stream lokal: ${(downloadedBytes / 1e6).toFixed(1)} MB. ${samplePoints.length} seek lokal (instant).`);
    } else {
      console.warn(`[VideoFilterService] ⚠️ Download stream gagal (${dlResult.reason}), fallback ke remote per-spawn seek.`);
      if (dlResult.stderr) console.warn(`[VideoFilterService]   ffmpeg stderr tail: ${dlResult.stderr.replace(/\n/g, ' | ')}`);
      try { fs.unlinkSync(tempStreamFile); } catch {}
    }
  }

  // ── (#2) WATERMARK PROBE STATELESS — hemat bandwidth/decode SEBELUM dense sampling dibayar ──
  // 5 frame tersebar dari daftar samplePoints -> /filter-watermark-probe (crop_9_16 + DBNet
  // produksi, TANPA state temporal). Bila >=3/5 ber-watermark -> logo channel persisten ->
  // matikan kandidat SEKARANG (lewati ~N seek FFmpeg). Guard KETAT: error/timeout/service mati
  // atau decoded<5 => FALL THROUGH (jangan tolak kandidat hanya karena probe gagal). Matikan: GK_WATERMARK_PROBE=0.
  if (process.env.GK_WATERMARK_PROBE !== '0' && samplePoints.length > 20) {
    const probeFramePaths = [];
    const cleanProbe = () => { for (const fp of probeFramePaths) { try { fs.unlinkSync(fp); } catch {} } };
    try {
      const pick = (frac) => samplePoints[Math.min(samplePoints.length - 1, Math.max(0, Math.round(frac * (samplePoints.length - 1))))];
      const extractOne = (point, outPath) => new Promise((resolve) => {
        const probeSeekArgs = networkArgs.length === 0
          ? ['-ss', point.timestamp.toFixed(2), '-i', seekInput]
          : ['-ss', Math.max(0, point.timestamp - 1.2).toFixed(2), '-i', seekInput, '-ss', Math.min(point.timestamp, 1.2).toFixed(2)];
        const proc = spawn(ffmpegPath, [
          '-y', ...networkArgs,
          ...probeSeekArgs,
          '-an', '-sn', '-dn', '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '3', outPath,
        ]);
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; try { proc.kill('SIGKILL'); } catch {} resolve(); } }, 8000);
        proc.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
        proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
      });
      const probes = [0.10, 0.30, 0.50, 0.70, 0.90].map((f, i) => {
        const p = pick(f);
        return { timestamp: p.timestamp, file: path.join(outputDir, `probe_${String(i).padStart(2, '0')}.jpg`) };
      });
      for (const pr of probes) {
        await extractOne(pr, pr.file);
        if (fs.existsSync(pr.file) && fs.statSync(pr.file).size > 0) probeFramePaths.push(pr.file);
      }
      if (probeFramePaths.length >= 5) {
        const res = await callWatermarkProbe(probeFramePaths.map(fp => ({ filePath: fp, timestamp: 0 })), { timeoutSec: 60 });
        if (res && res.decoded >= 5 && res.wmCount >= 3) {
          throw new Error(`PROBE_WATERMARK_REJECT:${res.wmCount}/${res.decoded}`);
        }
        console.log(`[VideoFilterService] 🔎 Probe watermark: ${res ? `${res.wmCount}/${res.decoded} titik kena` : 'service offline/degraded -> lanjut'}; dense sampling tetap jalan.`);
      }
      cleanProbe();
    } catch (probeErr) {
      cleanProbe();
      const msg = String(probeErr?.message || '');
      if (msg.startsWith('PROBE_WATERMARK_REJECT')) {
        const frac = msg.split(':')[1] || '?/?';
        console.warn(`[VideoFilterService] ⛔ Probe menolak kandidat: watermark persisten ${frac} titik awal -> hemat ${samplePoints.length} seek FFmpeg.`);
        throw new Error(`Watermark persisten terdeteksi pada probe awal (${frac} titik tersebar). Candidate ditolak sebelum sampling padat demi hemat bandwidth/decode.`);
      }
      console.warn(`[VideoFilterService] Probe watermark dilewati (${msg || 'error'}); lanjut dense sampling.`);
    }
  }

  // Seek: remote = two-stage (coarse HTTP range + fine decode); local = single input-seek (instant moov).
  const concurrency = networkArgs.length === 0 ? 8 : (isMobile ? 2 : 4);
  const executing = [];
  for (const point of samplePoints) {
    // Micro pacing delay (only needed for remote to avoid rate-limit; local skips)
    if (networkArgs.length > 0) await new Promise(r => setTimeout(r, isMobile ? 25 : 15));

    const frameFile = `frame_${String(point.index).padStart(4, '0')}.jpg`;
    const outputPath = path.join(outputDir, frameFile);

    const p = new Promise((resolve) => {
      const seekArgs = networkArgs.length === 0
        ? ['-ss', String(point.timestamp.toFixed(2)), '-i', seekInput]
        : ['-ss', String(Math.max(0, point.timestamp - 1.2).toFixed(2)), '-i', seekInput, '-ss', String(Math.min(point.timestamp, 1.2).toFixed(2))];

      const proc = spawn(ffmpegPath, [
        '-y',
        ...networkArgs,
        ...seekArgs,
        '-an',
        '-sn',
        '-dn',
        '-frames:v', '1',
        '-vf', 'scale=-2:480',
        '-q:v', '3',
        outputPath
      ]);
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) { finished = true; try { proc.kill('SIGKILL'); } catch {} resolve(); }
      }, networkArgs.length === 0 ? 5000 : 8000);
      proc.on('close', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } });
      proc.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } });
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

  // Helper: hash-dedupe daftar file (buang frame byte-identik) dari outputDir.
  const dedupeFrameFiles = (files) => {
    const uniq = [];
    const seen = new Set();
    for (const filename of files) {
      const filePath = path.join(outputDir, filename);
      try {
        const buf = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (seen.has(hash)) {
          try { fs.unlinkSync(filePath); } catch {}
          console.warn(`[VideoFilterService] ♻️ Drop duplicate visual frame: ${filename}`);
          continue;
        }
        seen.add(hash);
        uniq.push(filename);
      } catch {
        // Keep unreadable/partial files out of the downstream AI pool.
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    return uniq;
  };
  const listFrameFiles = () => fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
    .sort();

  // Tahap 1: hash-dedupe hasil fast input-seek.
  frameFiles = dedupeFrameFiles(frameFiles);

  // BUGFIX: fallback output-seek dulu DEAD CODE — selalu terhalang 'throw <5' di atasnya.
  // Saat '-ss' pra-input (HTTP range) ditolak googlevideo (403 / keyframe sama), kode menyerah
  // tanpa mencoba mode output-seek ('-ss' SETELAH '-i', baca sekuensial dari byte 0) yang justru
  // sering lolos. Fallback kini dijalankan bila hasil < 5 unik, menyasar ~15 titik TERSEBAR di
  // SELURUH durasi (bukan hanya awal video), lalu hasil gabungan di-dedupe ulang.
  if (frameFiles.length < 5) {
    console.warn(`[VideoFilterService] Fast input-seek hanya ${frameFiles.length} frame unik (<5). Mencoba fallback output-seek sekuensial di ~15 titik tersebar...`);
    const wantPoints = 15;
    const step = Math.max(1, Math.floor(samplePoints.length / wantPoints));
    const fallbackPoints = samplePoints.filter((_, idx) => idx % step === 0).slice(0, wantPoints);
    for (const point of fallbackPoints) {
      const outputPath = path.join(outputDir, `frame_${String(point.index).padStart(4, '0')}.jpg`);
      await new Promise((resolve) => {
        const fbArgs = networkArgs.length === 0
          ? ['-ss', String(point.timestamp), '-i', seekInput]
          : ['-i', seekInput, '-ss', String(point.timestamp)];
        const proc = spawn(ffmpegPath, [
          '-y', ...networkArgs,
          ...fbArgs,
          '-frames:v', '1',
          '-vf', 'scale=-2:480',
          '-q:v', '3',
          outputPath
        ]);
        let finished = false;
        const timer = setTimeout(() => {
          if (!finished) { finished = true; try { proc.kill('SIGKILL'); } catch {} resolve(); }
        }, 15000);
        proc.on('close', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } });
        proc.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } });
      });
    }
    frameFiles = dedupeFrameFiles(listFrameFiles());
  }

  if (frameFiles.length < 5) {
    if (downloadedBytes > 0) { try { fs.unlinkSync(tempStreamFile); } catch {} }
    throw new Error(`Frame visual unik tidak mencukupi setelah input-seek + fallback output-seek (${frameFiles.length}/5). Candidate ditolak agar sistem tidak mengulang frame yang sama.`);
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

  // Cleanup temp stream file after all seeks complete.
  if (downloadedBytes > 0) { try { fs.unlinkSync(tempStreamFile); } catch {} }

  // Track bandwidth: batch mode = actual download size; remote = JPEG estimate.
  let sampledBytes;
  if (downloadedBytes > 0) {
    sampledBytes = downloadedBytes;
  } else {
    sampledBytes = 0;
    for (const f of frameFiles) { try { sampledBytes += fs.statSync(path.join(outputDir, f)).size; } catch {} }
    sampledBytes = Math.max(sampledBytes, 0.8 * 1024 * 1024);
  }
  trackBandwidth('streamSampling', sampledBytes, `Sampling ${frames.length} frame (${downloadedBytes > 0 ? 'lokal 1\u00d7 download' : 'remote seek'}) ~${(sampledBytes / 1e6).toFixed(1)} MB`);

  onProgress({
    step: 'stream_sampling_done',
    message: `Berhasil mengambil ${frames.length} frame visual (~${(sampledBytes / 1e6).toFixed(1)} MB kuota).`,
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
export async function callAIGatekeeperMicroservice(frames, { timeoutSec = 300, onProgress = () => {}, niche = 'kitchen_tools', facePolicy = 'strict' } = {}) {
  try {
    const validFrames = frames.filter(f => f && f.filePath && fs.existsSync(f.filePath));
    if (validFrames.length === 0) return null;

    const payload = JSON.stringify({
      niche,
      facePolicy,
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
 * (#2) Panggil endpoint probe watermark STATELESS di gatekeeper (port 5050).
 * Return {hits, wmCount, total, decoded, backend, benchmarks} atau NULL saat service mati /
 * timeout / HTTP error / JSON tak valid. PEMANGGIL WAJIB memperlakukan null sebagai
 * "fall-through": kandidat TIDAK boleh ditolak hanya karena probe gagal (gatekeeper degraded).
 */
export async function callWatermarkProbe(frames, { niche = 'kitchen_tools', timeoutSec = 60 } = {}) {
  try {
    const valid = (frames || []).filter(f => f && f.filePath && fs.existsSync(f.filePath));
    if (valid.length === 0) return null;
    const res = await fetch('http://127.0.0.1:5050/filter-watermark-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ niche, frames: valid.map(f => ({ filePath: f.filePath, timestamp: f.timestamp || 0 })) }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!res.ok) return null;
    const parsed = await res.json();
    return (parsed && parsed.status === 'success') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tentukan face policy untuk satu niche (Fase 3, data-driven — TANPA if(niche) di service):
 * 'presenter_only' bila ada slot dengan facePolicy tersebut di preset (gadget: slot 5 review kamera),
 * selain itu 'strict' (perilaku lama — kitchen tidak pernah berubah).
 */
export function resolveNicheFacePolicy(niche) {
  const preset = getNichePreset(niche);
  const slots = Array.isArray(preset?.slotsConfig) ? preset.slotsConfig : [];
  const nonStrict = slots.find(s => s.facePolicy && s.facePolicy !== 'strict');
  return nonStrict ? nonStrict.facePolicy : 'strict';
}

/**
 * ── TAHAP 2: INSPEKSI & FILTER FRAME LOKAL (AI GATEKEEPER + HEURISTIK FALLBACK) ──
 * Memeriksa frame visual yang telah disampel di server lokal sebelum mengirim ke AI utama.
 * Tahap 1: MediaPipe Face Detection (100% faceless).
 * Tahap 2: DBNet Text Detection (membuang subtitle terbakar & promo overlay).
 * Tahap 3: MobileNetV3 (membuang bumper foto statis & kartun/animasi).
 * Tahap 4: Clean Temporal Segment Validation (hanya meloloskan segmen kontinu >= 3 frame / 4.0s).
 */
export async function inspectFramesLocally(frames, { aspectRatio = '9:16', allowPartialClean = false, onProgress = () => {}, niche = 'kitchen_tools', facePolicy = null } = {}) {
  if (!Array.isArray(frames) || frames.length < 5) {
    return { eligible: false, cleanFrames: [], cameraResultEligibleFrames: [], discardedFrames: [], reason: 'Jumlah frame visual tidak mencukupi untuk dianalisa.' };
  }

  // Policy diturunkan dari preset niche (data-driven) kecuali caller eksplisit mengirim nilai lain
  const activeFacePolicy = facePolicy || resolveNicheFacePolicy(niche);

  // ── CAP BATCH GATEKEEPER (Fase 1 hemat CPU) ──
  // Batch 500 frame (video ~12 menit, sampling dur/1.5) membuat Termux 2-core bekerja
  // bermenit-menit dan Node harus memegang timeout raksasa. Pool frame di-subsample MERATA
  // supaya tidak melewati GK_MAX_BATCH_FRAMES (default 240), TETAPI jarak antar frame hasil
  // pemangkasan tidak boleh melewati 3.2s: gatekeeper hanya membandingkan pasangan frame
  // berjarak <= 3.5s untuk mendeteksi foto statis - kalau jaraknya diregangkan lebih lebar,
  // dedup statis mati dan AI justru bekerja penuh untuk semua frame.
  const MAX_GATEKEEPER_FRAMES = Math.max(20, Number(process.env.GK_MAX_BATCH_FRAMES) || 240);
  const spanSec = Math.max(0, Number(frames[frames.length - 1]?.timestamp || 0) - Number(frames[0]?.timestamp || 0));
  const intervalCap = spanSec > 0 ? Math.floor(spanSec / 3.2) + 1 : frames.length;
  const batchCap = Math.max(5, Math.min(MAX_GATEKEEPER_FRAMES, intervalCap));
  let gkFrames = frames;
  if (frames.length > batchCap) {
    const step = frames.length / batchCap;
    gkFrames = Array.from({ length: batchCap }, (_, i) => frames[Math.min(frames.length - 1, Math.floor(i * step))]);
    console.log(`[inspectFramesLocally] 🧮 Batch gatekeeper dipangkas ${frames.length} -> ${gkFrames.length} frame (cap ${MAX_GATEKEEPER_FRAMES}, jarak hasil ~${(spanSec / Math.max(1, gkFrames.length)).toFixed(2)}s/frame)`);
  }

  // ── 0. COBA EVALUASI DENGAN AI LOCAL GATEKEEPER (MediaPipe + DBNet + MobileNetV3) ──
  // Timeout SKALIK dengan jumlah frame: sampling padat (~200 frame/5mnt) di CPU 2-core Termux
  // bisa melewati batas lama 300s; saat Node abort, gatekeeper menulis ke socket mati ->
  // ConnectionAbortedError & hasil batch terbuang sia-sia. Beri jatah ~4s/frame + buffer, min 300s.
  const gkTimeoutSec = Math.max(300, gkFrames.length * 4 + 120);
  const aiResult = await callAIGatekeeperMicroservice(gkFrames, { timeoutSec: gkTimeoutSec, onProgress, niche, facePolicy: activeFacePolicy });
  if (aiResult && aiResult.allFrames && aiResult.allFrames.length > 0) {
    const frameByPath = new Map(frames.map(f => [f.filePath, f]));
    const allClean = aiResult.allFrames
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

    // FACE POLICY (Fase 3): frame clean yang flagged cameraResultEligible (lolos presenter_only:
    // ada wajah konten tapi wajah kreator TETAP terblokir) TIDAK digabung ke cleanFrames utama.
    // Keduanya tetap object frame yang sama (identitas objek) sehingga pool terpisah aman.
    // Perbandingan eksplisit === true: flag cacat (misal string dari gatekeeper) dianggap frame bersih biasa.
    const cleanFrames = allClean.filter(f => f.cameraResultEligible !== true);
    const cameraResultEligibleFrames = allClean.filter(f => f.cameraResultEligible === true);

    const discardedFrames = aiResult.allFrames
      .filter(f => f.status !== 'clean')
      .map(f => ({
        ...(frameByPath.get(f.filePath) || {}),
        ...f,
      }));

    const verifiedSegments = aiResult.verifiedSegments || [];
    // Syarat kelayakan: Minimal 3 frame bersih atau minimal 1 segmen terverifikasi bersih
    // Menghindari pembuatan video dari 1-2 frame diam yang kemudian dipotong berulang kali secara monoton.
    const isEligible = cleanFrames.length >= 3 || (verifiedSegments.length > 0 && cleanFrames.length >= 2);
    const rejectReason = isEligible
      ? undefined
      : (aiResult.reason || `Video ditolak: Cuplikan bersih terlalu sedikit (${cleanFrames.length} frame peragaan). Tidak cukup variasi visual.`);

    if (isEligible) {
      console.log(`[inspectFramesLocally] 🤖 AI Local Gatekeeper: ${cleanFrames.length}/${frames.length} frame VERIFIED_CLEAN (${verifiedSegments.length} segmen kontinu, ${aiResult.benchmarks?.totalMs || 0}ms)${cameraResultEligibleFrames.length > 0 ? ` + ${cameraResultEligibleFrames.length} frame eligible-camera (pool terpisah)` : ''}.`);
    } else {
      console.warn(`[inspectFramesLocally] ⛔ AI Local Gatekeeper: Hanya ${cleanFrames.length}/${frames.length} frame bersih (${rejectReason}).`);
    }

    // (#5) Instrumentasi per-tahap: bongkar ke mana CPU habis (decode/statis vs yunet/dbnet/scene)
    // dan gate mana over-reject. Muncul hanya bila gatekeeper mengirim bench baru (kompatibel mundur).
    if (aiResult.benchmarks && (aiResult.benchmarks.stageMs || aiResult.benchmarks.rejectsByStage)) {
      const bm = aiResult.benchmarks;
      console.log(`[inspectFramesLocally] 📊 per-tahap(ms)=${JSON.stringify(bm.stageMs || {})} | calls=${JSON.stringify(bm.stageCounts || {})} | catchFullOnly=${bm.stageCounts?.face_caught_by_full_only ?? 0} | reject/stage=${JSON.stringify(bm.rejectsByStage || {})}`);
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
      cameraResultEligibleFrames,
      discardedFrames,
      reason: rejectReason || aiResult.reason,
      verifiedSegments,
      discardedFaceTimestamps,
      discardedViolationTimestamps,
      hasOpeningIntro: Boolean(aiResult.hasOpeningIntro),
      introCutoffSec: aiResult.introCutoffSec || 0.0,
      facePolicy: activeFacePolicy,
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

  const isCornerLogo = topLeftPersistent >= 7 || topRightPersistent >= 7 || bottomLeftPersistent >= 8 || bottomRightPersistent >= 8;
  const isWatermarkOverlay = totalPersistent >= 24;
  const isBoldLogo = boldStaticLogoPairCount >= 2;

  if (isCornerLogo) {
    staticLogoCount = Math.max(topLeftPersistent, topRightPersistent, bottomLeftPersistent, bottomRightPersistent);
    staticLogoReason = `Analisa visual lokal mendeteksi logo channel statis / angka mengambang di sudut frame 9:16 (TL:${topLeftPersistent}, TR:${topRightPersistent}, BL:${bottomLeftPersistent}, BR:${bottomRightPersistent} piksel persisten).`;
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
    let cornerGraphicPixels = 0;
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

        // C. Grafis Animasi Overlay / Stiker Digital / Angka Mengambang di Sudut
        const isCornerArea = (x < 24 && y < 35) || (x > 56 && y < 35);
        const isHyperSaturatedGraphic = (sat > 0.65 && val > 120 && (
          (r > 200 && g > 155 && b < 70) || // Emoji/cartoon yellow / angka teks 99
          (r > 190 && g < 75 && b < 75) ||   // Pure graphic red
          (r < 70 && g > 190 && b < 95) ||   // Neon green sticker
          (r < 70 && g > 170 && b > 200) ||  // Cyan/sky graphic
          (r > 200 && g < 70 && b > 170)     // Magenta/purple graphic
        ));
        if (isHyperSaturatedGraphic) {
          animatedGraphicPixels++;
          if (isCornerArea) cornerGraphicPixels++;
        }

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
      if ((animatedGraphicPixels / (W * H)) > 0.025 || cornerGraphicPixels >= 6) animatedGraphicCount++;
      if ((upperGenuineSkinPixels / upperTotal) > 0.07) humanFaceSkinCount++;
    }

    // ── Klasifikasi granular per-frame (face, black, intro bumper, static frame, watermark, subtitle, floating text/number) ──
    const isFrameFace = (upperGenuineSkinPixels / upperTotal) > 0.055;
    const isFrameBlack = avgBrightness < 8;
    const isFrameIntro = Boolean(isOpeningFrame);
    const isFrameStatic = staticFrameIndices.has(i) && !isFrameIntro;
    const isFrameSubtitle = (subWhitePixels / subTotal) > 0.038 && avgBrightness > 25;
    const isFrameFloatingText = (floatTextWhitePixels / floatTotal) > 0.045 && (floatTextEdges / floatTotal) > 0.04;
    const isFrameGraphic = (animatedGraphicPixels / (W * H)) > 0.022 || cornerGraphicPixels >= 6;
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
      else if (isFrameGraphic) rReason = cornerGraphicPixels >= 6 ? 'floating_corner_graphic' : 'animated_graphic';

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
      // USER MANDATE: JANGAN buang frame bersih sebagai ISOLATED_CLEAN_REJECT!
      // Setiap frame yang lolos deteksi wajah, teks, dan bukan bumper statis adalah frame aksi produk yang valid.
      finalClean.push({ ...f, status: 'clean', decision: 'CLEAN_ACTION_FRAME' });
    }
  }

  const totalBumperFrames = openingBumperCount + bodyBumperCount;
  const bumperRatio = totalBumperFrames / Math.max(1, frameBuffers.length - 1);
  if (bodyBumperCount >= 3 || bumperRatio >= 0.50) {
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

  const isEligible = finalClean.length >= 3 || (verifiedSegments.length > 0 && finalClean.length >= 2);
  const rejectReason = isEligible
    ? undefined
    : (finalClean.length === 0
      ? 'Tidak ditemukan frame peragaan produk yang bersih (bebas watermark/wajah/subtitle).'
      : `Video ditolak: Cuplikan peragaan bersih terlalu sedikit (${finalClean.length} frame / < 10 detik). Tidak cukup variasi visual.`);

  return {
    eligible: isEligible,
    reason: rejectReason,
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
 * Membuang frame yang tidak sesuai (wajah/bumper/teks), dan MENYIMPAN seluruh frame peragaan produk yang bersih!
 */
export async function filterCandidateFramesPerFrame(frames, { candidateIndex = 0, candidate = null, niche = 'kitchen_tools', facePolicy = null } = {}) {
  const result = await inspectFramesLocally(frames, { allowPartialClean: true, niche, facePolicy });

  const stampCandidate = (f) => ({
    ...f,
    candidateIndex,
    candidateTitle: candidate?.title || '',
    candidateUrl: candidate?.url || '',
    videoId: candidate?.id || '',
    candidate,
  });

  const clean = (result.cleanFrames || []).map(stampCandidate);
  // Pool terpisah: frame bebas-wajah-kreator tapi ada wajah konten (khusus niche dengan slot presenter_only)
  const eligibleCamera = (result.cameraResultEligibleFrames || []).map(f => ({
    ...stampCandidate(f),
    isCameraResultEligible: true,
  }));

  const isEligible = clean.length > 0;
  return {
    candidateIndex,
    candidate,
    eligible: isEligible,
    cleanFrames: clean,
    cameraResultEligibleFrames: eligibleCamera,
    verifiedSegments: result.verifiedSegments || [],
    discardedFaceTimestamps: result.discardedFaceTimestamps || [],
    discardedViolationTimestamps: result.discardedViolationTimestamps || [],
    discardedCount: frames.length - clean.length,
    totalFrames: frames.length,
    reason: isEligible ? undefined : (result.reason || 'Tidak ada frame peragaan bersih yang terdeteksi.'),
  };
}

/**
 * Menggabungkan (pooling) frame-frame bersih dari hingga 5 kandidat video menjadi satu kumpulan ~30 frame pilihan.
 * Menjamin distribusi berimbang antar kandidat dan menyematkan metadata sumber agar AI dapat menandai klipnya.
 *
 * @param {Array<{ candidateIndex: number, candidate: object, cleanFrames: Array, cameraResultEligibleFrames?: Array }>} candidateResults
 * @param {{ maxTotalFrames?: number, includeEligible?: boolean }} options
 * @returns {Array<{ candidateIndex: number, candidate: object, timestamp: number, filePath: string, displayLabel: string }>}
 */
export function poolMultiCandidateFrames(candidateResults, { maxTotalFrames = 30, includeEligible = false } = {}) {
  const valid = (candidateResults || []).filter(c => Array.isArray(c.cleanFrames) && c.cleanFrames.length > 0);
  if (valid.length === 0) return [];

  const perCand = Math.max(4, Math.floor(maxTotalFrames / valid.length));
  const pooled = [];

  // 1. Ambil porsi berimbang, tetapi INTERLEAVE sumber video.
  // Tujuan: AI Vision menerima frame dari Video 1 -> Video 2 -> Video 3,
  // bukan blok panjang Video 1 yang membuatnya cenderung memilih satu sumber saja.
  const prepared = valid.map((item) => {
    const cand = item.candidate || {};
    const idx = item.candidateIndex;
    const candTitle = cand.title || '';
    const candUrl = cand.url || '';
    const vidId = cand.id || candUrl || '';
    const frames = Array.isArray(item.cleanFrames) ? item.cleanFrames : [];
    const selected = frames.length <= perCand
      ? [...frames]
      : Array.from({ length: perCand }, (_, s) => {
          const frameIdx = Math.min(frames.length - 1, Math.floor((s * frames.length) / perCand));
          return frames[frameIdx];
        });
    return {
      idx,
      cand,
      candTitle,
      candUrl,
      vidId,
      selected,
    };
  });

  const maxRounds = Math.max(0, ...prepared.map((x) => x.selected.length));
  for (let round = 0; round < maxRounds && pooled.length < maxTotalFrames; round++) {
    for (const item of prepared) {
      if (round >= item.selected.length || pooled.length >= maxTotalFrames) continue;
      const f = item.selected[round];
      if (!f) continue;
      pooled.push({
        ...f,
        candidateIndex: item.idx,
        candidate: item.cand,
        candidateTitle: item.candTitle,
        candidateUrl: item.candUrl,
        videoId: item.vidId,
        displayLabel: `Video #${item.idx + 1} (${formatSecondsLocal(f.timestamp)})`,
      });
    }
  }

  // 2. Isi sisa kuota tetap dengan round-robin, bukan mengosongkan seluruh slot ke Video #1.
  if (pooled.length < maxTotalFrames) {
    let cursor = 0;
    while (pooled.length < maxTotalFrames && prepared.some((item) => item.selected.length > 0)) {
      let addedThisRound = false;
      for (let offset = 0; offset < prepared.length && pooled.length < maxTotalFrames; offset++) {
        const item = prepared[(cursor + offset) % prepared.length];
        const usedPaths = new Set(pooled.map((x) => x.filePath));
        const next = item.selected.find((f) => f && !usedPaths.has(f.filePath));
        if (!next) continue;
        pooled.push({
          ...next,
          candidateIndex: item.idx,
          candidate: item.cand,
          candidateTitle: item.candTitle,
          candidateUrl: item.candUrl,
          videoId: item.vidId,
          displayLabel: `Video #${item.idx + 1} (${formatSecondsLocal(next.timestamp)})`,
        });
        addedThisRound = true;
      }
      cursor++;
      if (!addedThisRound) break;
    }
  }

  const eligiblePool = [];
  if (includeEligible) {
    // FACE POLICY (Fase 3): frame cameraResultEligible DITAMBAHKAN setelah pool utama (bukan digabung
    // ke distribusi round-robin) agar slot storyboard dengan policy presenter_only tetap punya stok.
    for (const item of valid) {
      for (const f of (item.cameraResultEligibleFrames || [])) {
        if (!f) continue;
        eligiblePool.push({
          ...f,
          candidateIndex: item.candidateIndex,
          candidate: item.candidate || {},
          candidateTitle: item.candidate?.title || '',
          candidateUrl: item.candidate?.url || '',
          videoId: item.candidate?.id || item.candidate?.url || '',
          displayLabel: `Video #${item.candidateIndex + 1} (${formatSecondsLocal(f.timestamp)}) [camera-result]`,
          isCameraResultEligible: true,
        });
      }
    }
  }

  return pooled.slice(0, maxTotalFrames).concat(eligiblePool);
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
        '-vf', 'scale=-2:480',
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
    const gkRes = await callAIGatekeeperMicroservice(denseFrames, { timeoutSec: 300 });
    if (gkRes && Array.isArray(gkRes.allFrames)) {
      const cleanPaths = new Set(gkRes.allFrames.filter(f => f.status === 'clean').map(f => f.filePath));
      return denseFrames.filter(f => cleanPaths.has(f.filePath));
    }
  } catch {}

  return denseFrames;
}
