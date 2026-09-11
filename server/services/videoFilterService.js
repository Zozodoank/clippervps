import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { trackBandwidth, trackSavedBandwidth } from './bandwidthTracker.js';
import { extractCoreProductInfo, isTitleMatchingProduct } from './discoveryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

/**
 * Scan common locations for cookies.txt
 */
export function findCookiesFile() {
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
  const residentialProxy = (process.env.RESIDENTIAL_PROXY || process.env.PROXY_URL || '').trim();
  const proxyArgs = residentialProxy ? ['--proxy', residentialProxy] : [];

  const foundCookies = findCookiesFile();
  const cookiesArgs = foundCookies ? ['--cookies', foundCookies] : [];

  const args = [
    '--no-check-certificates',
    '--geo-bypass',
    '--remote-components', 'ejs:github',
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
        reject(new Error(`yt-dlp metadata failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', reject);
  });

  const duration = Number(metaResult.duration) || 60;
  const metadata = {
    id: metaResult.id,
    title: metaResult.title || 'YouTube Video',
    duration,
    description: (metaResult.description || '').slice(0, 1000),
    channel: metaResult.uploader || metaResult.channel || '',
    tags: Array.isArray(metaResult.tags) ? metaResult.tags : [],
    subtitles: metaResult.subtitles || {},
    automatic_captions: metaResult.automatic_captions || {},
  };

  // Step 2: Extract direct stream URL for low-resolution 360p (Fast & Quota-efficient)
  onProgress({
    step: 'stream_url_fetch',
    message: 'Mengambil stream URL preview 360p langsung dari YouTube...',
    progress: 14,
  });

  const streamArgs = [
    ...getYtDlpBaseArgs(),
    '-g',
    '-f', '18/bestvideo[height<=360]+bestaudio/bestvideo[height<=360]/best[height<=360]/worstvideo/worst/best',
    '--no-playlist',
    url
  ];

  const streamUrl = await new Promise((resolve, reject) => {
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
        reject(new Error(`yt-dlp stream URL failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', reject);
  });

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

  // 1. Durasi Video (Wajib antara 5 menit s/d 15 menit)
  const duration = Number(metadata.duration) || 0;
  if (duration > 0 && duration < 300) {
    return { eligible: false, reason: `Durasi video terlalu pendek (${Math.round(duration)} detik / ${(duration / 60).toFixed(1)} menit). Minimal durasi video 5 menit agar memiliki peragaan produk yang memadai.` };
  }
  if (duration > 900) {
    return { eligible: false, reason: `Durasi video terlalu panjang (${(duration / 60).toFixed(1)} menit). Maksimal durasi video 15 menit.` };
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

  // 2B. Filter Kata Kunci Terlarang (cara / tutorial / unboxing)
  if (/\b(cara|tutorial|unboxing)\b/i.test(titleLower)) {
    return { eligible: false, reason: 'Terdeteksi kata kunci terlarang (cara / tutorial / unboxing) pada judul video.' };
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
  const faceAndVlogKeywords = [
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
  const isFaceTitle = faceAndVlogKeywords.some(kw => titleLower.includes(kw)) || personaRegex.test(titleLower);
  const isFaceDesc = faceAndVlogKeywords.some(kw => descPreview.includes(kw)) || personaRegex.test(descPreview);

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

  // 7. Kesesuaian Kategori Produk Target (Cross-Category Exclusion)
  // Per instruksi pengguna: Pencocokan fisik produk spesifik di-handle AI Vision agar lebih stabil.
  // Backend HANYA memblokir kategori non-dapur terlarang (otomotif, motor, mobil, las, skincare, gameplay, anime, vlog).
  if (productTitle && productTitle.trim()) {
    const prodInfo = extractCoreProductInfo(productTitle, metadata.description || '');
    const coreWords = prodInfo.multilingualWords || prodInfo.coreWords || [];

    // Cek pengecualian kategori silang non-dapur terlarang
    const crossCategoryPass = isTitleMatchingProduct(metadata.title, coreWords, {
      description: metadata.description,
      tags: metadata.tags,
      isVisualSearch: true, // Delegasikan verifikasi fisik produk detail ke AI Vision
    });

    if (!crossCategoryPass) {
      return {
        eligible: false,
        reason: `Judul / deskripsi video YouTube ("${metadata.title}") terindikasi kategori silang yang dilarang (otomotif/skincare/anime/vlog).`
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
  maxSampleFrames = 30,
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
  const safeMax = Math.max(5, Math.min(30, Number(maxSampleFrames) || 30));
  const safeDuration = Math.max(10, Number(duration) || 60);

  // Generate evenly distributed timestamps across the video timeline (avoiding extreme 0s and last seconds)
  const interval = safeDuration / (safeMax + 1);
  const samplePoints = [];
  for (let i = 1; i <= safeMax; i++) {
    const ts = Math.max(1, Math.min(Math.floor(safeDuration - 2), Math.round(i * interval)));
    samplePoints.push({ index: i, timestamp: ts });
  }

  onProgress({
    step: 'stream_sampling',
    message: `Sampling cepat ${safeMax} keyframe visual langsung dari stream URL (fast seek paralel)...`,
    progress: 25,
  });

  console.log(`[VideoFilterService] Fast seek sampling ${safeMax} frames across ${safeDuration}s from stream...`);

  // Fast seek each timestamp with concurrency limit (5 parallel workers)
  const concurrency = 5;
  const executing = [];
  for (const point of samplePoints) {
    const frameFile = `frame_${String(point.index).padStart(4, '0')}.jpg`;
    const outputPath = path.join(outputDir, frameFile);

    const p = new Promise((resolve) => {
      // Input seeking (-ss before -i) fetches only the keyframe near timestamp via HTTP Range headers
      const proc = spawn(ffmpegPath, [
        '-y',
        '-ss', String(point.timestamp),
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '4',
        '-i', streamUrl,
        '-frames:v', '1',
        '-vf', 'scale=-2:360',
        '-q:v', '3',
        outputPath
      ]);
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
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
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
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
 * subtitle ucapan, dan teks mengambang) serta pencocokan produk diserahkan ke AI Vision.
 * Backend memeriksa stream corrupt, mendeteksi intro pembuka untuk dibuang, dan mencatat diagnostik.
 */
export function inspectFramesLocally(frames, { aspectRatio = '9:16', onProgress = () => {} } = {}) {
  if (!Array.isArray(frames) || frames.length < 5) {
    return { eligible: false, reason: 'Jumlah frame visual tidak mencukupi untuk dianalisa.' };
  }

  const ffmpeg = getFFmpegPath();
  const W = 80;
  const H = 144;
  const frameBuffers = [];

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
    return { eligible: false, reason: 'Gagal mengekstrak frame visual untuk analisa lokal.' };
  }

  // ── 1. PEMERIKSAAN FOTO BUMPER & FRAME BEKU STATIS (TEMPORAL GLOBAL DIFFERENCE) ──
  // Membedakan kartu intro pembuka (detik 0-5) dengan bumper / slideshow di badan video
  let openingBumperCount = 0;
  let bodyBumperCount = 0;

  for (let i = 0; i < frameBuffers.length - 1; i++) {
    const b1 = frameBuffers[i];
    const b2 = frameBuffers[i + 1];
    let diff = 0;
    for (let j = 0; j < b1.length; j++) {
      diff += Math.abs(b1[j] - b2[j]);
    }
    const mad = diff / b1.length;
    // Jika MAD < 5.0 (selisih < 2.0% piksel), frame identik diam / bumper hold
    if (mad < 5.0) {
      const ts = frames[i]?.timestamp ?? (i * 3);
      if (ts <= 5.0 || i <= 1) {
        openingBumperCount++;
      } else {
        bodyBumperCount++;
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
  const faceEndY = Math.floor(H * 0.45); // y <= 65

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

        // D. Wajah Manusia di Area Atas 45%
        if (y < faceEndY) {
          const isSkin = (
            r > 75 && g > 45 && b > 25 &&
            (r > g) && (g > b) &&
            (r - g >= 12) && (r - g <= 75) &&
            (r - b >= 18) && (r - b <= 120) &&
            (sat >= 0.18 && sat <= 0.65) &&
            (val >= 60 && val <= 245)
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
      if ((upperGenuineSkinPixels / upperTotal) > 0.20) humanFaceSkinCount++;
    }
  }

  // ── DELEGASI KE AI VISION: PENCATATAN DIAGNOSTIK NON-BLOCKING ──
  // Per instruksi pengguna: Verifikasi grafis visual dan pencocokan produk di-handle AI Vision agar lebih stabil.
  // Backend mencatat temuan heuristik sebagai info diagnostik dan tidak menolak video secara sepihak.
  if (staticLogoReason) {
    console.log(`[VideoFilter] Info diagnostik: ${staticLogoReason} -> Verifikasi grafis/logo diserahkan ke AI Vision.`);
  }
  if (subtitleBandCount >= 2) {
    console.log(`[VideoFilter] Info diagnostik: Terdeteksi piksel terang di area bawah pada ${subtitleBandCount} frame -> Verifikasi subtitle diserahkan ke AI Vision.`);
  }
  if (floatingTextCount >= 2) {
    console.log(`[VideoFilter] Info diagnostik: Terdeteksi tekstur teks pada ${floatingTextCount} frame -> Verifikasi teks diserahkan ke AI Vision.`);
  }
  if (animatedGraphicCount >= 2) {
    console.log(`[VideoFilter] Info diagnostik: Terdeteksi saturasi grafis pada ${animatedGraphicCount} frame -> Verifikasi grafis diserahkan ke AI Vision.`);
  }
  if (humanFaceSkinCount > 0) {
    console.log(`[VideoFilter] Info diagnostik: Terdeteksi rona kulit pada ${humanFaceSkinCount} frame -> Verifikasi faceless diserahkan ke AI Vision.`);
  }
  const totalBumperFrames = openingBumperCount + bodyBumperCount;
  if (bodyBumperCount >= 3) {
    console.log(`[VideoFilter] Info diagnostik: Terdeteksi ${bodyBumperCount} frame diam -> Verifikasi keaslian video diserahkan ke AI Vision.`);
  }

  // Hanya tolak jika mayoritas frame blank / hitam pekat (> 75%) yang menandakan stream corrupt
  const blackRatio = blackFrameCount / frameBuffers.length;
  if (blackRatio > 0.75) {
    return {
      eligible: false,
      reason: `Analisa visual lokal mendeteksi video kosong / rusak (${Math.round(blackRatio * 100)}% frame hitam pekat).`
    };
  }

  return {
    eligible: true,
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
