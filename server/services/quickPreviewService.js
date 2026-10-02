import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';
import { findCookiesFile } from './downloader.js';

// ♻️ Cache preview per-direktori-kerja. evaluateCandidate bisa memanggil kandidat yang SAMA
// lebih dari sekali (retry infra 1x via candidatePoolIndex--, atau pemilihan ulang Pre-Flight).
// Sebelumnya tiap pemanggilan MEN-SPAWN yt-dlp dan mengunduh ulang window identik karena nama
// file selalu memakai Date.now() (tidak pernah bentrok) dan videoId default = jobId (bukan id
// YouTube) sehingga tidak ada reuse. Key mencakup direktori output (per job), URL sumber,
// durasi, dan mode crop -> window yang sama dipakai ulang selama filenya masih ada di disk.
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 64;

// Ukur durasi sebenarnya (detik) sebuah file media via ffprobe. ffprobe diturunkan dari
// path ffmpeg (umumnya tersedia satu direktori). Kembalikan null bila gagal agar pemanggil
// memakai fallback. (P1-7: --force-keyframes-at-cuts membuat panjang potongan riil berbeda
// dari targetLength; sebelumnya angka itu ditebak, bukan diukur.)
function probeMediaDurationSec(filePath) {
  try {
    const ffmpegPath = getFFmpegPath();
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const res = spawnSync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8', timeout: 15000 });
    const val = parseFloat(String(res.stdout || '').trim());
    if (Number.isFinite(val) && val > 0) return val;
  } catch {}
  return null;
}

// L2 (Blueprint): crop tengah presisi 9:16 + skala 360p. `--download-sections` yt-dlp memakai
// stream-copy sehingga TIDAK bisa memasang filter crop di jalur unduhan; karena itu crop
// dilakukan sebagai re-encode ringan SETELAH unduh (crf 30, veryfast) - pertukaran yang
// diterima karena preview hanya 15 detik. Audio di-stream-copy (crop tak menyentuh suara).
// Mengembalikan path file hasil crop, atau null bila gagal (pemanggil fallback ke file utuh).
function cropCenterTo916(inPath) {
  const ffmpegPath = getFFmpegPath();
  const outPath = inPath.replace(/\.mp4$/i, '') + '.916.mp4';
  try {
    const res = spawnSync(ffmpegPath, [
      '-y', '-i', inPath,
      '-vf', "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=-2:360",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-c:a', 'copy',
      outPath,
    ], { encoding: 'utf8', timeout: 60000 });
    if (res.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      try { fs.unlinkSync(inPath); } catch {}
      return outPath;
    }
  } catch {}
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
  return null;
}

/**
 * Download preview video (center portion) at low resolution for quick validation.
 * @returns {{ filePath: string, sourceId: string, sourceStartSec: number, sourceEndSec: number, actualDurationSec: number, sourceDurationSec: number, hasAudio: boolean } | null}
 */
export async function downloadQuickPreview(url, outputDir, jobId, {
  onProgress = () => {},
  durationSec = 15,
  sourceDurationSec = null,
  cropTo9_16 = false
} = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ♻️ Lookup cache: reuse preview yang sudah pernah diunduh utk (direktori, url, durasi, crop).
  const cacheKey = `${outputDir}::${url}::${durationSec}::${cropTo9_16 ? '916' : 'raw'}`;
  const cachedPreview = previewCache.get(cacheKey);
  if (cachedPreview && fs.existsSync(cachedPreview.filePath)) {
    onProgress({ step: 'quick_preview', message: `♻️ Memakai ulang preview yang sudah terunduh (${cachedPreview.sourceStartSec}s - ${cachedPreview.sourceEndSec}s)...`, progress: 12 });
    return cachedPreview;
  }
  if (cachedPreview) previewCache.delete(cacheKey); // file sudah dibersihkan -> buang entri basi

  const ytDlpPath = await getYtDlpPath();
  const ffmpegPath = getFFmpegPath();

  // 1. Get or use duration
  let videoDuration = sourceDurationSec;
  let videoId = jobId;
  
  if (!videoDuration || videoDuration <= 0) {
    onProgress({ step: 'quick_preview', message: 'Membaca metadata durasi untuk preview...', progress: 10 });
    try {
      const { execFile } = await import('child_process');
      const util = await import('util');
      const execFileAsync = util.promisify(execFile);
      const { stdout } = await execFileAsync(ytDlpPath, ['--js-runtimes', 'node', '--print', '%(id)s|%(duration)s', '--no-playlist', url]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.includes('|')) {
        const parts = lastLine.split('|');
        videoId = parts[0] || videoId;
        videoDuration = parseFloat(parts[1]) || 0;
      }
    } catch (err) {
      console.warn(`[QuickPreview] Gagal membaca durasi: ${err.message}`);
    }
  }

  // 2. Calculate center section
  const safeDur = videoDuration > 0 ? videoDuration : 60;
  const targetLength = Math.min(durationSec, safeDur);
  const startSec = Math.max(0, Math.floor((safeDur / 2) - (targetLength / 2)));
  const endSec = startSec + targetLength;

  const outFilename = `preview_${videoId}_${Date.now()}.mp4`;
  const outPath = path.join(outputDir, outFilename);

  onProgress({ step: 'quick_preview', message: `Mendownload preview ${targetLength} detik (${startSec}s - ${endSec}s)...`, progress: 12 });

  // 3. Download section with yt-dlp using lowest resolution with audio
  // We prefer 360p or lower, but must have audio.
  // P1-8: preview ikut memakai cookies sesi yang sama dengan downloader utama. Tanpa cookie,
  // video age-restricted/member yang seharusnya lolos akan selalu gagal di TAHAP 2.
  const cookieFile = findCookiesFile();
  const dlArgs = [
    '--no-playlist',
    '--js-runtimes', 'node',
    '-f', 'best[height<=360][ext=mp4]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--download-sections', `*${startSec}-${endSec}`,
    '--force-keyframes-at-cuts',
    ...(cookieFile ? ['--cookies', cookieFile] : []),
    '-o', outPath,
    url
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, dlArgs);
    let finished = false;
    
    // P1-1: komentar menjanjikan 60 detik tapi kode memakai 300000ms (5 MENIT). Karena semua
    // job berat berbagi satu slot heavyTaskQueue (pLimit(1)), yt-dlp yang menggantung akan
    // MEMBLOKIR semua job lain selama 5 menit. Dipangkas ke 60s default (override:
    // PREVIEW_DOWNLOAD_TIMEOUT_MS) dan kini ikut menghapus file preview parsial saat timeout.
    const previewTimeoutMs = Number(process.env.PREVIEW_DOWNLOAD_TIMEOUT_MS) || 60000;
    const timeoutTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill('SIGKILL'); } catch {}
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        // P1-5: timeout jaringan = error INFRASTRUKTUR sementara, bukan vonis konten.
        // Pemanggil (master loop) memakai flag ini untuk retry 1x alih-alih blacklist.
        reject(Object.assign(new Error(`Download preview timeout (${Math.round(previewTimeoutMs / 1000)}s)`), { isInfraError: true }));
      }
    }, previewTimeoutMs);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        // L2: opsi crop 9:16 untuk klip yang akan dikirim ke vonis batch Gemini.
        let finalPath = outPath;
        if (cropTo9_16) {
          const cropped = cropCenterTo916(outPath);
          if (cropped) finalPath = cropped;
        }
        // P1-7: ukur durasi sebenarnya via ffprobe (keyframe snapping membuat potongan
        // lebih pendek/panjang dari targetLength). Fallback ke targetLength bila ffprobe tak ada.
        const measuredSec = probeMediaDurationSec(finalPath);
        const previewResult = {
          filePath: finalPath,
          sourceId: videoId,
          sourceStartSec: startSec,
          sourceEndSec: endSec,
          actualDurationSec: measuredSec || targetLength,
          sourceDurationSec: videoDuration,
          croppedTo9_16: finalPath !== outPath,
          hasAudio: true // We assume true for now, audioBeatService will confirm
        };
        // Simpan ke cache (batasi ukuran; evicted entri terlama) agar evaluasi ulang reuse.
        if (previewCache.size >= PREVIEW_CACHE_MAX) {
          const oldestKey = previewCache.keys().next().value;
          if (oldestKey) previewCache.delete(oldestKey);
        }
        previewCache.set(cacheKey, previewResult);
        resolve(previewResult);
      } else {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        // P1-5: kegagalan yt-dlp di fase preview umumnya jaringan/rate-limit sementara.
        reject(Object.assign(new Error(`yt-dlp exited with code ${code} or file is empty.`), { isInfraError: true }));
      }
    });
    
    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });
}
