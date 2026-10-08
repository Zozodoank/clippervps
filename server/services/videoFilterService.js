import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { tempDir } from '../utils/paths.js';
import { trackBandwidth, trackSavedBandwidth } from './bandwidthTracker.js';
import { extractCoreProductInfo, isTitleMatchingProduct } from './discoveryService.js';
import { getSmartProxyArgs } from './downloader.js';
import { classifyPipelineError } from './networkDiagnosticService.js';
import { getNichePreset } from '../config/nichePresets.js';
import { getMinVideoDurationSec, getMaxVideoDurationSec } from '../config/videoLimits.js';
import { hasRepairIntent, hasStrongRepairIntent, hasTutorialIntent } from '../config/forbiddenTerms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

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

  // 1. Durasi Video (DEFAULT minimal 5 menit s/d 15 menit: 300s - 900s).
  //    Video pendek (Shorts < 5 mnt) sengaja ditolak di AUTO MODE: sedikit frame,
  //    sumber beresolusi rendah (~270p), dan memicu adegan berulang. Ubah via env
  //    MIN_VIDEO_DURATION_SEC / MAX_VIDEO_DURATION_SEC. Mode manual OEM melewati
  //    fungsi ini (skip compliance), jadi URL pendek pilihan user tak terpengaruh.
  const minDurSec = getMinVideoDurationSec();
  const maxDurSec = getMaxVideoDurationSec();
  const duration = Number(metadata.duration) || 0;
  if (minDurSec > 0 && duration > 0 && duration < minDurSec) {
    return { eligible: false, reason: `Durasi video terlalu pendek (${Math.round(duration)} detik). Minimal ${Math.round(minDurSec / 60)} menit (${minDurSec} detik) agar footage peragaan produk memadai & sumber beresolusi tinggi.` };
  }
  if (duration > maxDurSec) {
    return { eligible: false, reason: `Durasi video terlalu panjang (${(duration / 60).toFixed(1)} menit). Durasi video dibatasi maksimal ${(maxDurSec / 60).toFixed(0)} menit (${maxDurSec} detik).` };
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

  // Daftar kata terlarang tidak lagi ditulis ulang di sini - sumbernya
  // config/forbiddenTerms.js, daftar yang sama dengan generator query dan filter
  // judul di discoveryService. Dulu ketiganya berbeda isi, itulah penyebab kata
  // "servis/matot" tetap muncul di hasil pencarian niche non-gadget.
  if (hasRepairIntent(titleLower, { includeGadgetJargon: isGadget })) {
    return { eligible: false, reason: `Terdeteksi kata kunci terlarang (${isGadget ? 'perbaikan / servis / mati total / bypass' : 'perbaikan / servis / bongkar'}) pada judul video.` };
  }

  // Khusus kata 'cara' atau 'tutorial': hanya dilarang jika BUKAN peragaan alat/produk fisik
  if (!isToolDemoTitle && hasTutorialIntent(titleLower)) {
    return { eligible: false, reason: 'Terdeteksi kata kunci tutorial/cara/DIY umum pada judul video.' };
  }

  // 2C. Filter Konten Perbaikan / Servis / Barang Rusak pada Deskripsi
  // Bersihkan URL terlebih dahulu agar link domain seperti service.kompernass.com tidak memicu false positive
  const descNoUrls = descLower.replace(/https?:\/\/[^\s]+/g, '');
  if (hasStrongRepairIntent(descNoUrls.slice(0, 500))) {
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
 * Sampling frame langsung dari stream URL.
 * FFmpeg mengambil keyframe merata, tanpa inspeksi AI lokal.
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
  // SAMPLING DENSE (20 titik per menit): interval ~3.0s -> DURASI menentukan JUMLAH,
  // dibatasi ceiling SAMPLE_MAX_FRAMES (default 500; dulu keras 200). Adaptive:
  // 5mnt=100, 15mnt=300, 25mnt+=500. Berlaku utk manual (jalur target) & otomatis (kandidat)
  // karena keduanya melewati sampler ini. Sampling tidak melakukan klasifikasi visual.
  const sampleCeil = Math.max(20, Number(process.env.SAMPLE_MAX_FRAMES) || 500);
  const requestedMax = Number(maxSampleFrames) > 0 ? Number(maxSampleFrames) : (isMobile ? 38 : 45);
  const safeMax = Math.max(15, Math.min(sampleCeil, requestedMax));

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

    const maxPoints = safeMax;

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
  let framesProcessed = 0;
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

    p.then(() => {
      framesProcessed++;
      if (framesProcessed % 10 === 0 || framesProcessed === samplePoints.length) {
        console.log(`[VideoFilterService] ⏳ Dense sampling progress: ${framesProcessed}/${samplePoints.length} frames...`);
      }
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
    const extractionErr = new Error(`Ekstraksi frame preview tidak mencukupi setelah input-seek + fallback output-seek (${frameFiles.length}/5).`);
    extractionErr.isInfraError = true;
    throw extractionErr;
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
 * Deteksi jumlah core CPU yang AKTIF terlihat runtime (bukan spesifikasi hardware).
 * Di Android/proot, efficiency core sering di-offline scheduler sehingga nproc/affinity
 * bisa = 2 walau SoC octa-core (mis. UNISOC T7250). Prioritas: /sys online ->
 * os.availableParallelism() -> os.cpus().length. Hasil di-cache per proses.
 */
let _deviceCoresCache = null;
export function detectDeviceCores() {
  if (_deviceCoresCache != null) return _deviceCoresCache;
  let n = 0;
  try {
    const s = fs.readFileSync('/sys/devices/system/cpu/online', 'utf8').trim();
    if (s) {
      for (const part of s.split(',')) {
        const m = part.split('-');
        if (m.length === 2) n += (Number(m[1]) - Number(m[0]) + 1);
        else if (m[0] !== '') n += 1;
      }
    }
  } catch {}
  if (!(n > 0)) {
    try {
      if (typeof os.availableParallelism === 'function') n = os.availableParallelism();
    } catch {}
  }
  if (!(n > 0)) n = os.cpus().length;
  _deviceCoresCache = Math.max(1, Number(n) || 1);
  return _deviceCoresCache;
}

/**
 * Runtime hemat-daya / perangkat mobile. T7250 (2xA75+6xA55) walau 8 core online tetap CPU
 * entry-level yang lambat per-core; di Termux/proot (Android) kita pakai profil konservatif untuk
 * chunk/timeout jaringan dan frame extraction agar pekerjaan tetap terkendali. Bukan soal jumlah core.
 */
export function isLowPowerRuntime() {
  return process.platform === 'android' ||
    Boolean(process.env.TERMUX_VERSION) ||
    (process.platform === 'linux' && !process.env.DISPLAY);
}

export function resolveNicheFacePolicy(niche) {
  const preset = getNichePreset(niche);
  const slots = Array.isArray(preset?.slotsConfig) ? preset.slotsConfig : [];
  const nonStrict = slots.find(s => s.facePolicy && s.facePolicy !== 'strict');
  return nonStrict ? nonStrict.facePolicy : 'strict';
}

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
 * Melakukan sampling rapat di sekitar frame anchor sebelum Oracle Kaggle memberi vonis.
 *
 * @param {string} streamUrl
 * @param {string} outputDir
 * @param {Array<{ timestamp: number }>} cleanFrames
 * @param {{ duration?: number, onProgress?: Function }} options
 * @returns {Promise<Array<object>>}
 */

export async function extractFastSnippetsForPreflight(urls, outputDir) {
  if (!urls || !Array.isArray(urls) || urls.length === 0) return [];
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const { exec } = await import('child_process');
  const util = await import('util');
  const execAsync = util.promisify(exec);

  const ffmpegPath = getFFmpegPath();
  const ytDlpPath = await getYtDlpPath();

  const snippetPromises = urls.map(async (url, index) => {
    if (!url) return null;
    try {
      const snippetPath = path.join(outputDir, `preflight_snippet_${index}_${Date.now()}.mp4`);

      // Selektor format + titik potong kini hidup di SATU tempat (resolvePreflightStream)
      // karena dipakai dua jalur pre-flight: MP4 untuk Gemini dan frame untuk Kaggle.
      const { streamUrl, startSec } = await resolvePreflightStream(url, { ytDlpPath, execAsync });

      // FFmpeg menerima pemisah header sebagai dua karakter `\r\n` literally (bukan byte CR/LF);
      // sama seperti browserHeaders di sampleFramesFromStream. Byte CR/LF asli di dalam command
      // string cmd.exe akan MEMOTONG perintah di tengah baris.
      const headersForShell = PREFLIGHT_BROWSER_HEADERS.replace(/\r\n/g, '\\r\\n');
      const ffmpegCmd = `"${ffmpegPath}" -y -user_agent "${PREFLIGHT_USER_AGENT}" -headers "${headersForShell}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 -ss ${formatClock(startSec)} -i "${streamUrl}" -t 10 -c:v libx264 -preset veryfast -crf 28 -an "${snippetPath}"`;
      await execAsync(ffmpegCmd);

      if (fs.existsSync(snippetPath) && fs.statSync(snippetPath).size > 0) {
        return { url, snippetPath, index };
      }
      return null;
    } catch (err) {
      console.warn(`[FastPreflight] Snippet extraction failed for index ${index} (${url}): ${scrubStreamUrl(err.message)}`);
      return null;
    }
  });

  const results = await Promise.allSettled(snippetPromises);
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

// ---------------------------------------------------------------------------
// PRE-FLIGHT: SATU logika pencarian stream, DUA bentuk hasil — MP4 untuk File
// API Gemini, JPEG untuk notebook Kaggle (Lapis 2).
// ---------------------------------------------------------------------------

// User agent meniru browser: tanpa ini googlevideo menolak sebagian link langsung.
// DULU dipotong sampai "Win64; x64)" saja — sama tapi tanpa versi AppleWebKit/Chrome/Safari,
// padahal googlevideo mengikat URL stream ke UA penuh yang dipakai yt-dlp saat resolve
// (jalur lain di file ini, mis. sampleFramesFromStream, selalu kirim UA Chrome 133 utuh).
// PARSIAL = 403 Forbidden "Error opening input files" di pre-flight (log 4 Okt 2026).
const PREFLIGHT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// Header sesi yang sama dengan jalur ekstraksi lain. googlevideo menolak request yang hanya
// membawa User-Agent (403 saat seek) bila Referer/Origin ke youtube.com tidak ikut terkirim.
// SENGAJA tanpa cookies: pre-flight harus tetap jalan di desain tanpa-cookies user.
const PREFLIGHT_BROWSER_HEADERS = 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com/\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n';

/** `150` -> `00:02:30` (format yang dipakai jalur lama). */
function formatClock(totalSec) {
  return new Date(Math.max(0, Number(totalSec) || 0) * 1000).toISOString().substr(11, 8);
}

/**
 * Buang URL stream dari teks log. URL googlevideo hasil yt-dlp membawa token bertanda
 * tangan yang bisa dipakai ulang siapa pun yang melihatnya sampai kedaluwarsa, jadi log
 * (dan pesan error `exec` yang mengulang command-line utuh) tidak boleh menuliskannya.
 */
function scrubStreamUrl(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '<url>');
}

/**
 * Baris stderr FFmpeg yang paling menjelaskan, sudah dibersihkan dari URL.
 * Dipakai karena `kode keluar N` saja hampir tidak pernah cukup untuk mendiagnosis:
 * kode yang sama muncul untuk 403, durasi nol, dan stream tanpa video.
 */
function ffmpegHint(stderr) {
  const lines = scrubStreamUrl(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const picked = lines.filter((l) => /error|denied|forbidden|40[134]|invalid|empty|none|timed out|server returned/i.test(l));
  return (picked.length ? picked.slice(-2) : lines.slice(-2)).join(' | ').slice(0, 260);
}

/**
 * Selektor format: DULU "best[ext=mp4]/best" dan itu GAGAL untuk banyak video.
 * yt-dlp `best` menuntut satu file yang memuat video DAN audio sekaligus, sedangkan
 * YouTube kini makin sering hanya menyediakan format terpisah (DASH: video-only +
 * audio-only). Terukur 2026-10-03 pada ucchyFUEvUo: `-F` hanya berisi 137/136/134
 * "video only" + 140/251 "audio only", sehingga perintah ini keluar dengan
 * "ERROR: Requested format is not available" dan cuplikan tidak pernah dibuat.
 * Cuplikan pre-flight dipakai hanya untuk menilai GAMBAR (ffmpeg dipanggil dengan
 * -an), jadi `bv*` (video-only terbaik) adalah pilihan yang benar. `[protocol=https]`
 * diutamakan agar URL-nya berkas langsung, bukan manifest m3u8 yang tidak bisa
 * di-seek ffmpeg dengan andal; tinggi 360p cukup untuk seleksi awal dan hemat kuota.
 */
const PREFLIGHT_FORMAT_SELECTOR = 'bv*[ext=mp4][protocol=https][height<=360]/bv*[ext=mp4][protocol=https]/bv*[protocol=https]/bv*/b';

/**
 * Cari URL stream langsung + titik potong cuplikan untuk satu kandidat.
 * @returns {Promise<{streamUrl: string, startSec: number, durationSec: number}>}
 */
async function resolvePreflightStream(url, { ytDlpPath, execAsync }) {
  const baseArgs = getYtDlpBaseArgs();
  const argsStr = baseArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const { stdout: streamInfoRaw } = await execAsync(`"${ytDlpPath}" ${argsStr} --print "%(url)s|%(duration)s" -f "${PREFLIGHT_FORMAT_SELECTOR}" "${url}"`);
  const lines = String(streamInfoRaw || '').trim().split('\n').filter(Boolean);
  // Ambil baris TERAKHIR: yt-dlp kadang menulis peringatan ke stdout sebelum baris data.
  const lastLine = lines[lines.length - 1];
  if (!lastLine || !lastLine.includes('|')) throw new Error(`Could not fetch stream URL for ${url}`);

  const [streamUrl, durationStr] = lastLine.split('|');
  const durationSec = parseFloat(durationStr) || 0;

  // Tengah video (40% untuk video panjang), fallback 5 dtk bila durasi tak diketahui/pendek.
  let startSec = 5;
  if (durationSec > 30) {
    startSec = Math.floor(durationSec * 0.4); // 40% mark is usually the core content
  } else if (durationSec > 15) {
    startSec = 5;
  }
  return { streamUrl, startSec, durationSec };
}

/**
 * Timeout ekstraksi frame pre-flight (ms). Dulu dipatok keras 90_000 yang di Termux/ARM +
 * googlevideo lambat sering jebol (seek dalam + decode) -> kandidat "untested", gerbang murah
 * Qwen mangkir. Default kini 120_000 dan dapat dinaikkan via env VLM_ORACLE_PREFLIGHT_TIMEOUT_MS.
 * Clamp 30k..240k agar tidak pernah melewati deadline total job (deadline dicek di pemanggil).
 */
export function resolvePreflightTimeoutMs(env = process.env) {
  const raw = Number(env && env.VLM_ORACLE_PREFLIGHT_TIMEOUT_MS);
  const val = Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  return Math.max(30_000, Math.min(240_000, val));
}

/**
 * Jalankan FFmpeg tanpa shell (argv array). Dipakai jalur frame karena URL stream
 * dari yt-dlp berisi `&` dan `?` yang di dalam command-string adalah karakter hidup
 * di cmd.exe/POSIX shell; `spawn` menutup kelas bug itu sekaligus membuat timeout bisa
 * benar-benar membunuh proses (exec tidak bisa).
 */
function runFrameExtraction({ ffmpegPath, streamUrl, startSec, seconds, fps, height, pattern, timeoutMs }) {
  return new Promise((resolve) => {
    // Opsi INPUT harus berada sebelum -i (ffmpeg menolak flag input pasca-input: "Invalid
    // argument"). reconnect hanya valid untuk input http(s); flag ini menutup kelas kegagalan
    // "timeout 90000ms dengan stderr hanya banner versi" — koneksi mobile terputus di
    // tengah stream tanpa pernah menghasilkan satu frame pun (throttle/putus sementara).
    const inputArgs = [
      '-user_agent', PREFLIGHT_USER_AGENT,
      '-headers', PREFLIGHT_BROWSER_HEADERS,
    ];
    if (/^https?:\/\//i.test(String(streamUrl || ''))) {
      inputArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4');
    }
    const args = [
      '-y', '-nostdin',
      ...inputArgs,
      '-ss', formatClock(startSec),
      '-i', streamUrl,
      '-t', String(seconds),
      // fps=<n> -> satu frame per <n> detik; scale=-2:<height> -> tinggi terkunci,
      // lebar rasio asli dibulatkan ke GENAP (sama seperti prepareOracleFrames).
      '-vf', `fps=${fps},scale=-2:${height}`,
      '-q:v', '4', '-an',
      pattern,
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err.message, stderr: '' });
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1200); });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: `timeout ${timeoutMs}ms`, stderr });
    }, Math.max(5000, Number(timeoutMs) || resolvePreflightTimeoutMs()));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stderr });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? '' : `kode keluar ${code}`, stderr });
    });
  });
}

/**
 * [Lapis 2] Ekstrak cuplikan tengah video kandidat menjadi FRAME JPEG (default 15 frame
 * @1 fps, tinggi 360 px) untuk dinilai notebook Kaggle lewat jalur batch frame yang SUDAH
 * ada. Kenapa frame dan bukan MP4: nol perubahan notebook, byte keluar perangkat turun
 * ~5x, dan satu batch 15 frame muat dalam satu panggilan GPU (VLM_ORACLE_BATCH_SIZE
 * dijepit 16). Korbannya jujur: gerakan yang muncul <1 detik bisa lolos dari sampling 1 fps.
 *
 * Kandidat yang gagal ekstraksi TIDAK muncul di hasil — sama seperti jalur MP4 — dan
 * pemanggil wajib memperlakukannya sebagai "belum dinilai", BUKAN "ditolak".
 *
 * @param {string[]} urls kandidat (urutan = posisi batch)
 * @param {string} outputDir direktori kerja; frame ditulis di subdirektori preflight_frames
 * @param {{seconds?:number,fps?:number,height?:number,tag?:string,timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{url:string,index:number,frameDir:string,startSec:number,frames:Array<{index:number,filePath:string,timestampMs:number}>}>>}
 */
export async function extractPreflightFramesForOracle(urls, outputDir, opts = {}) {
  const {
    // timeoutMs default diambil dari env VLM_ORACLE_PREFLIGHT_TIMEOUT_MS (clamp 30k..240k) agar
    // Termux/ARM punya ruang cukup untuk seek dalam; pemanggil boleh override lewat opts.
    seconds = 15, fps = 1, height = 360, tag = Date.now(), timeoutMs = resolvePreflightTimeoutMs(),
  } = opts;
  if (!urls || !Array.isArray(urls) || urls.length === 0) return [];
  if (!outputDir) throw new Error('extractPreflightFramesForOracle: outputDir wajib ada');

  const { exec } = await import('child_process');
  const util = await import('util');
  const execAsync = util.promisify(exec);
  const ffmpegPath = getFFmpegPath();
  const ytDlpPath = await getYtDlpPath();

  const capSeconds = Math.max(2, Math.min(30, Number(seconds) || 15));
  const capFps = Math.max(0.2, Math.min(4, Number(fps) || 1));
  const capHeight = Math.max(240, Math.min(720, Number(height) || 360));

  const jobs = urls.map(async (url, index) => {
    if (!url) return null;
    let frameDir = '';
    try {
      const { streamUrl, startSec } = await resolvePreflightStream(url, { ytDlpPath, execAsync });
      frameDir = path.join(outputDir, 'preflight_frames', `pf_${index}_${tag}`);
      fs.mkdirSync(frameDir, { recursive: true });
      const pattern = path.join(frameDir, 'pf_%03d.jpg');
      const run = await runFrameExtraction({ ffmpegPath, streamUrl, startSec, seconds: capSeconds, fps: capFps, height: capHeight, pattern, timeoutMs });

      const files = fs.readdirSync(frameDir)
        .filter((f) => /^pf_\d+\.jpg$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      if (files.length === 0) {
        // Konteks lengkap sengaja di sini: jalur lama (MP4) tidak pernah gagal dengan
        // bentuk ini, jadi tanpa host/seek/stderr kita hanya punya angka exit code.
        let streamHost = '?';
        try { streamHost = new URL(streamUrl).host; } catch {}
        console.warn(`[PreflightFrames] Tidak ada frame untuk indeks ${index} (${url}): ${run.error} — stream ${streamHost}, seek ${startSec}s, ${capSeconds}s @${capFps}fps, stderr: ${ffmpegHint(run.stderr) || '(kosong)'}`);
        try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch {}
        return null;
      }
      // timestampMs = posisi frame pada garis waktu video sumber. Filter `fps` mengambil
      // frame pertama di detik 0 cuplikan, jadi frame ke-i jatuh di startSec + i/fps.
      const frames = files.map((f, i) => ({
        index: i,
        filePath: path.join(frameDir, f),
        timestampMs: Math.round((startSec + i / capFps) * 1000),
      }));
      return { url, index, frameDir, startSec, frames };
    } catch (err) {
      console.warn(`[PreflightFrames] Ekstraksi gagal untuk indeks ${index} (${url}): ${scrubStreamUrl(err.message)}`);
      if (frameDir) { try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch {} }
      return null;
    }
  });

  const settledJobs = await Promise.allSettled(jobs);
  return settledJobs
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);
}

/**
 * Fast probe: ekstrak 5 frame dari file lokal pada posisi 10%, 25%, 50%, 75%, 90% durasi.
 */
export async function fastProbeLocal(videoFilePath, jobId, {
  onProgress = () => {},
  niche = 'kitchen_tools',
  facePolicy = null,
  durationSec = 10,
  sourceId = null
} = {}) {
  const ffmpegPath = getFFmpegPath();
  const path = await import('path');
  const fs = await import('fs');
  const { spawn } = await import('child_process');
  
  // P1-6: dulu memakai process.cwd()/server/temp (melanggar konvensi path terpusat dan
  // rawan salah lokasi saat CWD beda di PM2/Termux) serta folder probe_* tidak pernah
  // dihapus (bocor ke disk). Kini ditaruh di dalam direktori session job (tempDir/job_<id>/)
  // sehingga ikut terhapus oleh deleteJobTempDirectory saat job selesai/gagal.
  const jobSessionDir = path.join(tempDir, `job_${jobId}`);
  const tmpDir = path.join(jobSessionDir, `probe_${Date.now()}`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const timestamps = [0.1, 0.25, 0.5, 0.75, 0.9].map(p => durationSec * p);
  const frames = [];

  onProgress({ step: 'frame_probe', message: 'Mengekstrak 5 frame lokal dari preview...', progress: 25 });

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = path.join(tmpDir, `frame_${i}.jpg`);
    
    const args = [
      '-nostdin', // jangan pernah membaca stdin — risiko hang di Termux (pola runResize)
      '-ss', ts.toString(),
      '-i', videoFilePath,
      '-vframes', '1',
      '-q:v', '2',
      '-vf', 'scale=-1:720', // Samakan tinggi sumber; 9:16 letterbox diterapkan sebelum upload Kaggle
      '-y',
      outPath
    ];

    // FIX 2026-10-05: dulu exit-code DIBUANG (proc.on('close', resolve)) dan frame diterima
    // hanya dengan fs.existsSync. Dengan -y, FFmpeg membuat/memotong file output SEBELUM
    // encoder gagal ("code 234 / Could not open encoder before EOF") -> file 0-byte diterima
    // sebagai frame "valid" lalu base64 kosong dikirim ke Oracle Kaggle. Qwen menerima
    // gambar rusak — itulah mekanisme di balik "frame tidak pernah benar-benar ke Kaggle".
    let exitCode = -1;
    await new Promise((resolve) => {
      const proc = spawn(ffmpegPath, args);
      proc.on('close', (code) => { exitCode = code; resolve(); });
      proc.on('error', resolve);
    });

    if (exitCode === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      frames.push({
        candidateUrl: sourceId || 'local_probe',
        sourceId: sourceId || 'local_probe',
        filePath: outPath,
        timestamp: ts,
        timestampSec: ts
      });
    } else if (fs.existsSync(outPath)) {
      // Sampah 0-byte/kecil dari FFmpeg yang gagal — bersihkan agar tidak ikut terbaca.
      try { fs.unlinkSync(outPath); } catch {}
    }
  }

  if (frames.length < timestamps.length) {
    console.warn(`[fastProbeLocal] ⚠️ Hanya ${frames.length}/${timestamps.length} frame terekstrak dari preview (ekstraksi FFmpeg ada yang gagal).`);
  }

  if (!frames.length) {
    throw Object.assign(new Error('FFmpeg tidak menghasilkan frame probe untuk Oracle Kaggle.'), { isInfraError: true });
  }
  // Tidak ada inspeksi AI lokal. Seluruh frame probe diteruskan ke pipeline Oracle.
  onProgress({ step: 'frame_probe', message: `Meneruskan ${frames.length} frame ke Oracle Kaggle...`, progress: 28 });
  return {
    eligible: true,
    cleanFrames: frames,
    cameraResultEligibleFrames: [],
    discardedFrames: [],
    verifiedSegments: [],
    reason: undefined,
    localSuspicion: null,
    frames,
    tmpDir,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Legacy scene-window frame sampler; the production pipeline uses Kaggle Oracle.
//  Sampling is per candidate @1fps (360p), not a visual verdict.
//  video, kita HANYA mengambil klip pendek (2-5s) untuk window kandidat dari Gemini,
//  ekstrak 1 frame/detik, lalu filter ringan (blank/statis/blur) sebelum VLM.
//  Semua fungsi diekspor terpisah agar mudah di-unit-test (I/O vs murni).
// ══════════════════════════════════════════════════════════════════════════

function normalizeWindows(windows = []) {
  const out = [];
  for (const w of windows) {
    if (!w) continue;
    const s = Number(w.startSec ?? w.start ?? w.startSeconds);
    let e = Number(w.endSec ?? w.end ?? w.endSeconds);
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e <= s) e = s + 4; // default 4s bila hanya start
    out.push({ startSec: Math.max(0, s), endSec: e, raw: w });
  }
  return out;
}

/**
 * Filter ringan per frame (0 token, CPU murah): buang frame BLANK (kontras sangat
 * rendah) dan BLUR (varian Laplacian sangat rendah) memakai downscaled gray 160x90.
 * TOLERAN: bila analisis frame gagal, frame DIPERTAHANKAN (jangan buang karena bug).
 * @param {string[]} framePaths
 * @returns {string[]} framePaths yang lolos
 */
export function lightFilterFrames(framePaths = [], { minGrayStd = 6, minLapVar = 4 } = {}) {
  const ffmpegPath = getFFmpegPath();
  const kept = [];
  for (const fp of framePaths) {
    if (!fp || !fs.existsSync(fp)) continue;
    try {
      const { stdout } = spawnSync(ffmpegPath, [
        '-y', '-nostdin', '-i', fp,
        '-vf', 'scale=160:90', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
      ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      const buf = stdout;
      if (!buf || buf.length < 160 * 90) { kept.push(fp); continue; }
      const W = 160, H = 90;
      let sum = 0, sumSq = 0;
      for (let i = 0; i < W * H; i++) { const v = buf[i]; sum += v; sumSq += v * v; }
      const mean = sum / (W * H);
      const variance = sumSq / (W * H) - mean * mean;
      const std = Math.sqrt(Math.max(0, variance));
      if (std < minGrayStd) continue; // blank/near-solid -> buang
      // Laplacian variance kasar (deteksi blur): jumlah selisih tetangga.
      let lapSum = 0, lapSumSq = 0, n = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const c = buf[y * W + x];
          const lap = 4 * c - buf[y * W + x - 1] - buf[y * W + x + 1] - buf[(y - 1) * W + x] - buf[(y + 1) * W + x];
          lapSum += lap; lapSumSq += lap * lap; n++;
        }
      }
      const lapVar = n ? (lapSumSq / n - (lapSum / n) ** 2) : 999;
      if (lapVar < minLapVar) continue; // terlalu halus/blur -> buang
      kept.push(fp);
    } catch {
      kept.push(fp); // error analisis -> pertahankan (fail-open)
    }
  }
  return kept;
}

/**
 * Untuk setiap window kandidat Gemini: unduh klip pendek 360p dari stream, ekstrak
 * frame pada `fps` (default 1 = jumlah frame mengikuti durasi klip), lalu filter ringan.
 * @param {string} streamUrl - URL stream langsung (dari fetchVideoMetadataAndStream) ATAU path file lokal.
 * @param {Array<{startSec,endSec}>} windows
 * @param {{outDir:string, fps?:number, clipDurationSec?:number, onProgress?:Function}} opts
 * @returns {Promise<Array<{window:{startSec,endSec}, frames:Array<{filePath,timestamp}>}>>}
 */
export async function sampleFramesForWindows(streamUrl, windows, { outDir, fps = 1, clipDurationSec = 4, onProgress = () => {} } = {}) {
  if (!streamUrl) throw new Error('sampleFramesForWindows: streamUrl kosong');
  if (!outDir) throw new Error('sampleFramesForWindows: outDir wajib');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ffmpegPath = getFFmpegPath();
  const norm = normalizeWindows(windows);
  const scenes = [];
  let wi = 0;
  for (const w of norm) {
    wi++;
    const dur = Math.max(2, Math.min(clipDurationSec, w.endSec - w.startSec));
    onProgress({ step: 'scene_clip', message: `Mengunduh klip scene ${wi}/${norm.length} @${w.startSec.toFixed(1)}s (${dur}s, 360p)...` });
    const tag = `scene${String(wi).padStart(2, '0')}`;
    const clipPath = path.join(outDir, `${tag}.mp4`);
    // [1] unduh + re-encode 360p segmen pendek (seek cepat sebelum -i).
    const clipOk = await new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-y', '-nostdin',
        '-ss', w.startSec.toFixed(2), '-i', streamUrl, '-t', String(dur),
        '-an', '-sn', '-dn',
        '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        clipPath,
      ]);
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; try { proc.kill('SIGKILL'); } catch {} resolve(false); } }, 30000);
      proc.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0 && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024); } });
      proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
    });
    if (!clipOk) { try { fs.unlinkSync(clipPath); } catch {} continue; }

    // [2] ekstrak 1 frame per detik dari klip lokal (fps filter).
    const framesDir = path.join(outDir, `${tag}_frames`);
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-y', '-nostdin', '-i', clipPath,
        '-vf', `fps=${fps}`, '-q:v', '3', path.join(framesDir, 'f_%03d.jpg'),
      ]);
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; try { proc.kill('SIGKILL'); } catch {} resolve(); } }, 20000);
      proc.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
      proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
    });
    let rawFrames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort()
      .map((f, idx) => ({ filePath: path.join(framesDir, f), timestamp: w.startSec + idx / (fps || 1) }));

    // [3] filter ringan (blank/blur) sebelum VLM.
    const keptPaths = lightFilterFrames(rawFrames.map((r) => r.filePath));
    const keptSet = new Set(keptPaths);
    const frames = rawFrames.filter((r) => keptSet.has(r.filePath));
    try { fs.unlinkSync(clipPath); } catch {} // klip sementara dibuang, frame disimpan utk VLM
    if (frames.length > 0) scenes.push({ window: { startSec: w.startSec, endSec: w.endSec }, frames });
  }
  return scenes;
}
