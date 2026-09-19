import http from 'http';
import https from 'https';
import { spawn } from 'child_process';
import { getYtDlpPath } from './binaryChecker.js';

let cachedPublicIp = null;
let lastIpCheckTime = 0;

/**
 * Mendeteksi IP publik yang digunakan oleh mesin Termux / VPS saat ini.
 * Membantu pengguna membedakan apakah IP mereka sedang dibatasi/diblokir oleh YouTube.
 *
 * @param {{ forceRefresh?: boolean }} options
 * @returns {Promise<string|null>}
 */
export async function getPublicIpAddress({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedPublicIp && (now - lastIpCheckTime < 60000)) {
    return cachedPublicIp;
  }

  const providers = [
    'https://api.ipify.org',
    'https://icanhazip.com',
    'https://ifconfig.me/ip',
  ];

  for (const url of providers) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'curl/8.0' }
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text && /^[0-9a-fA-F:.]+$/.test(text)) {
          cachedPublicIp = text;
          lastIpCheckTime = now;
          return cachedPublicIp;
        }
      }
    } catch {}
  }

  return cachedPublicIp || null;
}

/**
 * Mengklasifikasikan kegagalan pipeline ke dalam 3 status makro:
 * 1. PASS: Sukses, klip bersih dihasilkan.
 * 2. REJECT: Video berhasil dianalisis (frame diekstrak), namun ditolak oleh filter AI / Heuristik.
 * 3. UNAVAILABLE: Video gagal diakses dari YouTube (429, Bot Check, 403, Stream Error).
 *    -> BUKAN karena video jelek, melainkan ada pembatasan jaringan / IP!
 *
 * @param {Error|string} err
 * @param {{ analysisPerformed?: boolean }} context
 * @returns {{
 *   sourceStatus: 'PASS'|'REJECT'|'UNAVAILABLE',
 *   failureCode: string,
 *   isNetworkOrIpIssue: boolean,
 *   analysisPerformed: boolean,
 *   userFriendlyReason: string,
 *   actionableAdvice: string,
 *   rawMessage: string
 * }}
 */
export function classifyPipelineError(err, context = {}) {
  const rawMessage = String(err?.message || err || '').trim();
  const lower = rawMessage.toLowerCase();

  // ── KELOMPOK 1: YOUTUBE RATE LIMIT & IP BLOCKS (UNAVAILABLE) ──

  // 1.1 HTTP 429 Too Many Requests
  if (
    lower.includes('http error 429') ||
    lower.includes('status: 429') ||
    lower.includes('too many requests')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'YOUTUBE_RATE_LIMITED',
      isNetworkOrIpIssue: true,
      analysisPerformed: false,
      userFriendlyReason: 'YouTube membatasi request dari IP publik Anda (HTTP 429: Too Many Requests).',
      actionableAdvice: 'Aktifkan Mode Pesawat (Airplane Mode) di HP selama 5-10 detik lalu matikan lagi untuk mendapatkan IP baru dari operator seluler, atau restart router WiFi.',
      rawMessage,
    };
  }

  // 1.2 YouTube Bot Check ("Sign in to confirm you're not a bot")
  if (
    lower.includes('sign in to confirm') ||
    lower.includes('automated queries')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'YOUTUBE_BOT_CHECK',
      isNetworkOrIpIssue: true,
      analysisPerformed: false,
      userFriendlyReason: "YouTube mendeteksi aktivitas otomatis pada IP publik Anda (Sign in to confirm you're not a bot).",
      actionableAdvice: 'IP publik Anda ditandai oleh YouTube. Lakukan Mode Pesawat ON/OFF 5 detik di HP untuk mendapatkan IP baru tanpa captcha.',
      rawMessage,
    };
  }

  // 1.3 Explicit YouTube IP block / 403.
  // NOTE: a generic 403 can also be video/format-specific, so prefer explicit
  // block wording before treating it as an IP circuit-breaker signal.
  if (
    lower.includes('blocked by youtube') ||
    lower.includes('ip address blocked') ||
    lower.includes('your ip has been blocked') ||
    lower.includes('requests from your computer network are unusual')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'YOUTUBE_IP_BLOCKED',
      isNetworkOrIpIssue: true,
      analysisPerformed: false,
      userFriendlyReason: 'YouTube memblokir koneksi dari IP publik Anda (HTTP 403 Forbidden).',
      actionableAdvice: 'Ganti IP publik (Mode Pesawat HP ON/OFF atau ganti koneksi jaringan).',
      rawMessage,
    };
  }

  // 1.4 YouTube Stream URL Fetch Failed
  if (
    lower.includes('yt-dlp stream url failed') ||
    lower.includes('stream url tidak valid') ||
    lower.includes('requested format is not available') ||
    lower.includes('only images are available')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'YOUTUBE_STREAM_FAILED',
      isNetworkOrIpIssue: true,
      analysisPerformed: false,
      userFriendlyReason: 'Gagal mengambil stream URL video YouTube (format audio-visual tidak dapat diakses).',
      actionableAdvice: 'Mencoba kandidat video lain secara otomatis.',
      rawMessage,
    };
  }

  // 1.5 YouTube Metadata Fetch Failed (Private, Deleted, Geo-restricted)
  if (
    lower.includes('yt-dlp metadata failed') ||
    lower.includes('private video') ||
    lower.includes('video unavailable') ||
    lower.includes('members-only') ||
    lower.includes('this video has been removed')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'YOUTUBE_METADATA_FAILED',
      isNetworkOrIpIssue: false,
      analysisPerformed: false,
      userFriendlyReason: 'Metadata video YouTube tidak dapat diakses (video privat/dihapus/khusus member).',
      actionableAdvice: 'Sistem akan otomatis beralih ke video kandidat berikutnya.',
      rawMessage,
    };
  }

  // 1.6 Ekstraksi Frame FFmpeg Gagal (Koneksi stream putus / CDN hang)
  if (
    lower.includes('ekstraksi frame visual gagal') ||
    lower.includes('tidak ada frame yang berhasil diekstrak') ||
    lower.includes('tidak memiliki cukup frame visual')
  ) {
    return {
      sourceStatus: 'UNAVAILABLE',
      failureCode: 'FRAME_EXTRACTION_FAILED',
      isNetworkOrIpIssue: false,
      analysisPerformed: false,
      userFriendlyReason: 'Gagal mengekstrak frame dari stream URL YouTube (format stream kandidat ini tidak dapat diakses).',
      actionableAdvice: 'Mencoba format atau kandidat video berikutnya secara otomatis.',
      rawMessage,
    };
  }

  // ── KELOMPOK 2: PENOLAKAN FILTER KUALITAS & KONTEN (REJECT) ──

  // 2.1 Filter Lokal Gatekeeper (Wajah, Teks Promosi, Subtitle, Slideshow)
  if (
    err?.isAiRejection ||
    lower.includes('analisa lokal ditolak') ||
    lower.includes('ditolak ai gatekeeper') ||
    lower.includes('wajah') ||
    lower.includes('slideshow') ||
    lower.includes('subtitle')
  ) {
    return {
      sourceStatus: 'REJECT',
      failureCode: 'LOCAL_FILTER_REJECT',
      isNetworkOrIpIssue: false,
      analysisPerformed: true,
      userFriendlyReason: err?.rejectionReason || rawMessage,
      actionableAdvice: 'Video berhasil diperiksa, tetapi mengandung wajah/subtitle/foto statis.',
      rawMessage,
    };
  }

  // 2.2 Filter Metadata (Durasi terlalu pendek / kategori silang)
  if (
    lower.includes('metadata video ditolak') ||
    lower.includes('durasi video terlalu pendek')
  ) {
    return {
      sourceStatus: 'REJECT',
      failureCode: 'METADATA_FILTER_REJECT',
      isNetworkOrIpIssue: false,
      analysisPerformed: true,
      userFriendlyReason: err?.rejectionReason || rawMessage,
      actionableAdvice: 'Durasi atau kategori video tidak memenuhi syarat awal.',
      rawMessage,
    };
  }

  // 2.3 Penolakan AI Vision / Gemini Storyboard
  if (
    lower.includes('tidak menemukan cuplikan produk yang memenuhi syarat') ||
    lower.includes('gemini') ||
    lower.includes('ai vision') ||
    lower.includes('storyboard')
  ) {
    return {
      sourceStatus: 'REJECT',
      failureCode: 'GEMINI_REJECT',
      isNetworkOrIpIssue: false,
      analysisPerformed: true,
      userFriendlyReason: err?.rejectionReason || rawMessage,
      actionableAdvice: 'AI Vision memeriksa visual tetapi tidak menemukan segmen peragaan produk yang cocok.',
      rawMessage,
    };
  }

  // ── KELOMPOK 3: DEFAULT FALLBACK ──
  const isAnalysisDone = Boolean(context.analysisPerformed);
  return {
    sourceStatus: isAnalysisDone ? 'REJECT' : 'UNAVAILABLE',
    failureCode: isAnalysisDone ? 'NO_USABLE_SEGMENT' : 'SOURCE_ACCESS_FAILED',
    isNetworkOrIpIssue: !isAnalysisDone,
    analysisPerformed: isAnalysisDone,
    userFriendlyReason: rawMessage || 'Video tidak memenuhi kriteria footage produk.',
    actionableAdvice: 'Melanjutkan ke kandidat berikutnya.',
    rawMessage,
  };
}

/**
 * Menguji kesehatan konektivitas IP saat ini ke YouTube via yt-dlp.
 * Berguna bagi pengguna untuk mendiagnosis apakah IP mereka bersih atau sedang terkena bot check/429.
 *
 * @returns {Promise<{ ok: boolean, publicIp: string|null, status: string, details?: string }>}
 */
export async function checkYouTubeHealth() {
  const publicIp = await getPublicIpAddress({ forceRefresh: true });
  const ytDlpPath = await getYtDlpPath();

  const testVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const args = [
    '--dump-json',
    '--skip-download',
    '--no-playlist',
    '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    testVideoUrl,
  ];

  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({
        ok: false,
        publicIp,
        status: 'TIMEOUT',
        details: 'Koneksi ke server YouTube timeout (>10 detik).'
      });
    }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout) {
        resolve({
          ok: true,
          publicIp,
          status: 'HEALTHY',
          details: 'IP publik Anda bersih dan dapat mengakses YouTube tanpa limit.'
        });
      } else {
        const diag = classifyPipelineError(stderr);
        resolve({
          ok: false,
          publicIp,
          status: diag.failureCode,
          details: diag.userFriendlyReason,
          advice: diag.actionableAdvice
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        publicIp,
        status: 'EXEC_ERROR',
        details: err.message
      });
    });
  });
}
