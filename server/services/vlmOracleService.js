// ============================================================================
// VLM Oracle Service — vonis frame oleh MODEL BESAR di luar perangkat.
//
// Kenapa ada file ini: perangkat user (Unisoc T7250 / CPU PC) tidak sanggup
// menjalankan VLM sebagai gerbang per-scene. Terukur di Termux (llama-mtmd-cli
// b11362 + SmolVLM2-500M Q4_K_M): 36-52 DETIK PER FRAME, dan biayanya per-gambar
// (4 frame sekali panggil = 162 dtk), bukan per-proses. Solusi: bobot
// Vision-Language (default Qwen2.5-VL-3B-Instruct fp16; override lewat ORACLE_MODEL_ID di
// sisi notebook, dan TIDAK ada fallback antar-bobot lagi di sana) jalan di GPU Kaggle;
// perangkat lokal hanya mengantre batch frame dan menunggu vonis.
//
// ARAH PANGGILAN DIPAKSA OLEH FISIKA JARINGAN: notebook Kaggle tidak punya
// inbound, jadi notebook-lah yang menjadi KLIEN (claim -> unduh frame -> vonis ->
// submit). Pipeline lokal tidak pernah "menelepon" Kaggle; ia hanya menulis ke
// antrean SQLite dan membaca hasilnya. Konsekuensi bagus: notebook boleh mati
// kapan saja tanpa merusak job.
//
// KEBIJAKAN FALLBACK (yang ini penting, jangan diubah tanpa alasan). "Fallback" di sini =
// perilaku saat oracle TIDAK menjawab, BUKAN fallback antar-bobot model:
//   oracle menjawab  -> frame divonis KOTOR masuk daftar blacklist (veto).
//   oracle diam/timeout/validasi gagal -> TIDAK ADA VONIS = tidak memveto apa pun,
//   dan keputusan gatekeeper legacy + Gemini tetap berlaku. Ini BUKAN fail-open
//   terhadap konten, karena legacy path sudah berjalan penuh di sekitar tahap ini;
//   oracle hanya menambah lapisan. (Bandingkan jalur 'smolvlm' yang MELEWATI
//   legacy lalu fail-open saat VLM timeout — jalur itu berbahaya, lihat README.)
// ============================================================================
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { buildVlmPrompt } from './vlmGateService.js';
import { getFFmpegPath } from './binaryChecker.js';
import { tempDir } from '../utils/paths.js';
import { isVlmOracleEnabled } from '../config/runtimeFlags.js';
import {
  enqueueOracleBatch,
  waitForOracleVerdict,
  expireOracleBatch,
} from '../store/jobStore.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Konfigurasi antrean oracle. Semuanya dibekukan per-job via configSnapshot. */
export function resolveOracleConfig(env = process.env) {
  const sec = (name, fallback) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    enabled: isVlmOracleEnabled(env),
    maxFrames: Math.max(0, Number(env.VLM_ORACLE_MAX_FRAMES ?? 120)),
    batchSize: Math.min(16, Math.max(1, Number(env.VLM_ORACLE_BATCH_SIZE) || 8)),
    perBatchTimeoutMs: Math.max(5, sec('VLM_ORACLE_TIMEOUT_SEC', 180)) * 1000,
    totalTimeoutMs: Math.max(10, sec('VLM_ORACLE_TOTAL_TIMEOUT_SEC', 600)) * 1000,
    pollMs: Math.max(250, Number(env.VLM_ORACLE_POLL_MS) || 2000),
    staleMs: Math.max(30, sec('VLM_ORACLE_STALE_SEC', 300)) * 1000,
    maxAttempts: Math.max(1, sec('VLM_ORACLE_MAX_ATTEMPTS', 2)),
    baseUrl: String(env.VLM_ORACLE_BASE_URL || '').trim(),
    // 0 = kirim mentah; selain 0 dikurung 240..720 (sama seperti normalizer snapshot).
    frameHeight: (() => {
      const h = Math.round(Number(env.VLM_ORACLE_FRAME_HEIGHT));
      if (h === 0) return 0;
      if (!Number.isFinite(h)) return 360;
      return Math.min(720, Math.max(240, h));
    })(),
    // Plafon frame pass AUDIT KLIP FINAL. 0 = pass audit nonaktif.
    auditMaxFrames: (() => {
      const n = Number(env.VLM_ORACLE_AUDIT_MAX_FRAMES);
      if (n === 0) return 0;
      if (!Number.isFinite(n)) return 90;
      return Math.min(240, Math.max(8, Math.round(n)));
    })(),
  };
}

/**
 * Subset merata sepanjang garis waktu. Pool bisa 500 frame; GPU Kaggle dibatasi
 * kuota menit, jadi kita pilih N titik yang TERSEBAR (bukan N pertama) agar
 * cakupan temporal tetap ada. Frame diurutkan lewat timestampMs bila ada.
 */
export function pickEvenlySpaced(items = [], n = 0) {
  const arr = Array.isArray(items) ? items.slice() : [];
  if (!(n > 0) || arr.length <= n) return arr;
  const sorted = arr.every((f) => f && Number.isFinite(f.timestampMs))
    ? arr.slice().sort((a, b) => a.timestampMs - b.timestampMs)
    : arr;
  const out = [];
  const step = sorted.length / n;
  for (let i = 0; i < n; i++) out.push(sorted[Math.min(sorted.length - 1, Math.floor(i * step))]);
  // Dedup (step < 1 bisa menghasilkan index yang sama) sambil mempertahankan urutan waktu.
  return out.filter((f, i) => f && out.indexOf(f) === i);
}

/**
 * Shape vonis yang WAJIB dikirim notebook (divalidasi LONGGAR tapi tidak naif):
 * { safe: bool, face/text/watermark/graphic: bool, reason?, perFrame?: [{index, safe, ...}] }
 * Key top-level sengaja SAMA dengan kontrak vlmGateService agar hilir cuma satu kosakata.
 */
export function normalizeOracleVerdict(verdict, { expectedFrames = 0 } = {}) {
  if (!verdict || typeof verdict !== 'object') {
    return { ok: false, available: true, infraError: true, error: 'Vonis oracle bukan objek JSON.' };
  }
  const bool = (v) => v === true || v === 'true' || v === 1;
  const hasSafe = 'safe' in verdict;
  const perFrame = Array.isArray(verdict.perFrame) ? verdict.perFrame : [];
  if (!hasSafe && perFrame.length === 0) {
    return { ok: false, available: true, infraError: true, error: 'Vonis oracle tanpa field safe dan tanpa perFrame.' };
  }
  // Posisi array TIDAK bisa dipercaya sebagai identitas frame: notebook yang gagal
  // parse satu frame akan mengirim daftar lebih pendek dan pergeseran posisi berarti
  // memveto gambar yang salah. Pakai field `index` bila sah, baru jatuh ke posisi.
  const dirtyFrames = perFrame
    .map((f, i) => {
      const idx = Number(f && f.index);
      return Number.isInteger(idx) && idx >= 0 ? idx : i;
    })
    .filter((mapped, i) => {
      const f = perFrame[i];
      return f && (f.safe === false || f.safe === 'false' || f.safe === 0);
    });
  const anyFlag = ['face', 'text', 'watermark', 'graphic'].some((k) => bool(verdict[k]));
  const safe = hasSafe ? bool(verdict.safe) : (perFrame.length > 0 && dirtyFrames.length === 0);
  return {
    ok: true,
    available: true,
    safe,
    face: bool(verdict.face),
    text: bool(verdict.text),
    watermark: bool(verdict.watermark),
    graphic: bool(verdict.graphic),
    reason: String(verdict.reason || '').slice(0, 300),
    model: String(verdict.model || '').slice(0, 80),
    dirtyFrameIndexes: dirtyFrames,
    // Aggregate flag boleh salah nol; `safe:false` saja sudah cukup untuk memveto.
    vetoTriggered: safe === false || anyFlag || dirtyFrames.length > 0,
    framesExpected: expectedFrames,
    elapsedMs: Number(verdict.elapsedMs) || undefined,
  };
}

function makeBatchId(jobId, sceneIdx, framePaths = []) {
  const hash = crypto.createHash('sha1').update(framePaths.join('|')).digest('hex').slice(0, 10);
  return `orc_${String(jobId || 'job').slice(-10)}_${sceneIdx}_${hash}`;
}

// ---------------------------------------------------------------------------
// KONVERSI FRAME SEBELUM DIKIRIM (1080p di perangkat -> 360p ke Kaggle)
//
// Download section dan frame bank TETAP apa adanya (kualitas render tidak
// tersentuh). Yang dikecilkan hanya SALINAN yang diserahkan ke notebook:
//   - byte yang naik lewat tunnel turun ~7x (1080p q:v2 ≈ 250 KB -> 360p ≈ 30 KB),
//     dan di Termux tunnel upload adalah leher paling sempit;
//   - vision-token GPU turun, jadi kuota Kaggle ~30 jam/minggu lebih awet.
// Hasil tulis selalu di bawah `tempDir` supaya `isAllowedFramePath` di routes
// tetap lolos tanpa menambah root baru. File ASLI tidak pernah diubah/dihapus.
// ---------------------------------------------------------------------------
const RESIZE_TIMEOUT_MS = 20000;
const SMALL_ENOUGH_BYTES = 200 * 1024; // sudah kecil -> tidak perlu diperkecil lagi
const SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // sapu salinan berusia > 6 jam

// Cache per proses: frame yang sama dipakai ulang oleh pass pool DAN pass audit.
// Key memuat mtime+size supaya file yang ditulis ulang (retry job) tidak salah pakai.
const resizeCache = new Map();

function safeJobSegment(jobId) {
  return String(jobId || 'job').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
}

function sweepOldCopies(rootDir, logger, keepDir = '') {
  try {
    if (!fs.existsSync(rootDir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(rootDir)) {
      const p = path.join(rootDir, name);
      if (keepDir && path.resolve(p) === path.resolve(keepDir)) continue; // direktori job yang sedang jalan
      try {
        const st = fs.statSync(p);
        // Direktori pun hanya dibuang kalau sudah tua: job lain mungkin masih memakai
        // salinannya sambil menunggu vonis notebook.
        if (now - st.mtimeMs > SWEEP_MAX_AGE_MS) {
          if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
          else fs.rmSync(p, { force: true });
        }
      } catch { /* biarkan, sapuan bersifat best-effort */ }
    }
  } catch (err) {
    if (logger && logger.warn) logger.warn(`[Oracle] Sapuan salinan frame gagal: ${err.message}`);
  }
}

function runResize(srcPath, dstPath, height, timeoutMs = RESIZE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let ffmpeg = '';
    try { ffmpeg = getFFmpegPath(); } catch { ffmpeg = ''; }
    if (!ffmpeg) return resolve(false);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); resolve(ok && fs.existsSync(dstPath)); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(false); }, timeoutMs);
    let proc;
    try {
      proc = spawn(ffmpeg, [
        '-y', '-nostdin', '-i', srcPath,
        // -2: tinggi tetap, lebar mengikuti rasio dan dibulatkan ke GENAP (wajib JPEG/FFmpeg).
        '-vf', `scale=-2:${height}`, '-q:v', '4', dstPath,
      ], { stdio: 'ignore' });
    } catch { clearTimeout(timer); resolve(false); return; }
    proc.on('error', () => finish(false));
    proc.on('close', (code) => finish(code === 0));
  });
}

/**
 * Siapkan daftar frame yang akan DIKIRIM ke oracle.
 * Return `{ sent, originalBySent, converted, failed }` di mana `sent` adalah salinan
 * frame dengan `filePath` = path yang boleh di-download notebook, dan `originalBySent`
 * memetakan path kirim kembali ke path asli (veto harus mengenai frame asli).
 *
 * Tidak pernah melempar: kegagalan konversi = pakai file asli.
 */
export async function prepareOracleFrames(frames = [], { height = 360, jobId = '', outDir = null, logger = console, env = process.env } = {}) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && f.filePath);
  const h = Number.isFinite(Number(height)) ? Math.round(Number(height)) : 360;
  const out = { sent: list.slice(), originalBySent: new Map(), converted: 0, failed: 0, outDir: '' };
  for (const f of list) out.originalBySent.set(f.filePath, f.filePath);
  if (!list.length || h <= 0) return out;

  const baseDir = outDir || path.join(tempDir, 'oracle_frames');
  const dir = path.join(baseDir, `${safeJobSegment(jobId)}_h${h}`);
  out.outDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    sweepOldCopies(baseDir, logger, dir);
  } catch (err) {
    if (logger && logger.warn) logger.warn(`[Oracle] Gagal menyiapkan ${dir} (${err.message}) -> kirim frame mentah.`);
    return out;
  }

  const work = [];
  for (const f of list) {
    let st = null;
    try { st = fs.statSync(f.filePath); } catch { st = null; }
    if (!st || st.size <= SMALL_ENOUGH_BYTES) continue; // tidak ada / sudah kecil: kirim apa adanya
    const key = `${f.filePath}|${h}|${st.mtimeMs}|${st.size}`;
    const cached = resizeCache.get(key);
    if (cached && fs.existsSync(cached)) {
      out.converted += 1;
      out.sent = out.sent.map((x) => (x === f ? { ...x, filePath: cached, originalPath: f.filePath } : x));
      out.originalBySent.set(cached, f.filePath);
      continue;
    }
    work.push({ frame: f, key, dst: path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.jpg`) });
  }

  // Konversi beruntun dengan batas konkurensi kecil: PC cepat, T7250 jangan dibebani.
  const LIMIT = 3;
  for (let i = 0; i < work.length; i += LIMIT) {
    const chunk = work.slice(i, i + LIMIT);
    const oks = await Promise.all(chunk.map(({ frame, dst }) => {
      if (fs.existsSync(dst)) return Promise.resolve(true); // sudah ada dari proses/sebelah chunk
      return runResize(frame.filePath, dst, h);
    }));
    chunk.forEach((item, idx) => {
      const ok = oks[idx] === true && fs.existsSync(item.dst);
      if (ok) {
        resizeCache.set(item.key, item.dst);
        out.converted += 1;
        out.sent = out.sent.map((x) => (x === item.frame ? { ...x, filePath: item.dst, originalPath: item.frame.filePath } : x));
        out.originalBySent.set(item.dst, item.frame.filePath);
      } else {
        out.failed += 1;
      }
    });
  }

  if (out.failed > 0 && logger && logger.warn) {
    logger.warn(`[Oracle] ${out.failed} frame gagal dikecilkan ke ${h}p -> dikirim mentah (lebih besar, tapi job tidak dibatalkan).`);
  }
  return out;
}

/**
 * SANITASI POOL: tahap yang dipanggil stage1Render sebelum storyboard Gemini.
 * Mengembalikan daftar filePath yang divonis KOTOR oleh oracle — pemanggil
 * memasukkannya ke `blacklistedFramePaths` yang SUDAH ada, sehingga Gemini,
 * retainedFrames, dan rescue pool otomatis menghormatinya.
 *
 * TIDAK PERNAH melempar: kegagalan infrastruktur = anggap oracle tidak ada.
 */
export async function sanitizePoolWithOracle(frames = [], opts = {}) {
  const {
    jobId = '', niche = 'kitchen_tools', facePolicy = 'strict',
    logger = console, env = process.env, onProgress = null, outDir = null,
  } = opts;
  const cfg = resolveOracleConfig(env);
  const result = { enabled: cfg.enabled, checked: 0, rejected: 0, timedOut: 0, blacklisted: [], elapsedMs: 0, converted: 0, resizeFailed: 0, note: '' };
  if (!cfg.enabled || cfg.maxFrames === 0) return result;

  const valid = (Array.isArray(frames) ? frames : []).filter((f) => f && f.filePath && fs.existsSync(f.filePath));
  const subset = pickEvenlySpaced(valid, cfg.maxFrames);
  if (subset.length === 0) return result;

  // Perkecil dulu (360p), baru antre. Yang tercatat di batch adalah SALINAN kirim;
  // vonis nanti dipetakan balik ke path asli supaya blacklist hilir tetap cocok.
  const prepared = await prepareOracleFrames(subset, { height: cfg.frameHeight, jobId, outDir, logger, env });
  const sendable = prepared.sent;
  const backToOriginal = prepared.originalBySent;
  result.converted = prepared.converted;
  result.resizeFailed = prepared.failed;

  const t0 = Date.now();
  const prompt = buildVlmPrompt(niche, facePolicy);
  const deadline = t0 + cfg.totalTimeoutMs;

  for (let start = 0; start < sendable.length; start += cfg.batchSize) {
    const batchFrames = sendable.slice(start, start + cfg.batchSize);
    if (Date.now() > deadline) {
      result.note = `Anggaran waktu oracle habis (${cfg.totalTimeoutMs / 1000}s) — sisa ${sendable.length - start} frame TIDAK divisit, keputusan legacy berlaku.`;
      logger.warn(`[Oracle] ${result.note}`);
      break;
    }

    const paths = batchFrames.map((f) => f.filePath);
    const originalOf = (p) => backToOriginal.get(p) || p;
    const id = makeBatchId(jobId, Math.floor(start / cfg.batchSize), paths);
    let status = 'timeout';
    try {
      enqueueOracleBatch({
        id, jobId,
        sceneIdx: Math.floor(start / cfg.batchSize),
        frames: batchFrames.map((f, i) => ({ index: i, filePath: f.filePath, timestampMs: f.timestampMs ?? null })),
        niche, facePolicy, prompt,
      });
      const waited = await waitForOracleVerdict(id, {
        timeoutMs: Math.min(cfg.perBatchTimeoutMs, Math.max(0, deadline - Date.now())),
        pollMs: cfg.pollMs, sleep,
      });
      status = waited.status;
      if (waited.status === 'done') {
        const v = normalizeOracleVerdict(waited.verdict, { expectedFrames: paths.length });
        result.checked += paths.length;
        if (v.ok && v.vetoTriggered) {
          // Veto per-frame bila notebook mengirim perFrame; kalau hanya agregat,
          // seluruh frame batch dianggap tidak bersih (konservatif: jangan publish
          // potongan yang model besar curigai).
          const dirty = (v.dirtyFrameIndexes || []).map((i) => paths[i]).filter(Boolean);
          const toBlacklist = (dirty.length > 0 ? dirty : paths).map(originalOf);
          for (const p of toBlacklist) if (!result.blacklisted.includes(p)) result.blacklisted.push(p);
          result.rejected += toBlacklist.length;
          logger.log(`[Oracle] ⛔ batch ${id} divonis KOTOR (${toBlacklist.length}/${paths.length} frame) ${v.reason ? `— ${v.reason}` : ''} [${v.model || 'model=?'}]`);
        } else if (v.ok) {
          logger.log(`[Oracle] ✅ batch ${id} bersih (${paths.length} frame).`);
        } else {
          result.timedOut += paths.length;
          logger.warn(`[Oracle] Vonis batch ${id} tidak sah (${v.error}) -> TIDAK memveto.`);
        }
      } else {
        result.timedOut += paths.length;
        // Berhenti menunggu = lepaskan batch supaya notebook tidak membuang GPU
        // untuk kerjaan yang sudah tidak dibaca siapa pun.
        if (status === 'timeout') expireOracleBatch(id, 'Worker menyerah sebelum vonis tiba.');
        logger.warn(`[Oracle] Batch ${id} ${status === 'expired' ? 'kadaluarsa' : 'tidak dijawab'} (${status}) -> lanjut dengan keputusan legacy.`);
      }
    } catch (err) {
      result.timedOut += paths.length;
      logger.warn(`[Oracle] Error antrean batch ${id}: ${err.message} -> lanjut dengan keputusan legacy.`);
    }

    if (onProgress) {
      try {
        onProgress({
          step: 'vlm_oracle',
          message: `🛰️ Oracle Kaggle: ${result.checked} frame divisit, ${result.rejected} diveto, ${result.timedOut} tak dijawab.`,
          progress: 36,
          status: 'running',
        });
      } catch { /* progres tidak boleh menjatuhkan job */ }
    }
  }

  result.elapsedMs = Date.now() - t0;
  if (result.checked === 0 && !result.note) result.note = 'Oracle aktif tapi tidak ada frame valid di pool.';
  if (result.converted > 0) {
    logger.log(`[Oracle] ${result.converted} frame dikirim sebagai ${cfg.frameHeight}p (hemat byte tunnel + vision-token GPU).`);
  }
  return result;
}

/**
 * Pembungkus satu baris untuk pipeline: kembalikan pool yang LOLOS veto sambil
 * mengisi `blacklisted` (Set filePath) yang sudah ada di stage1Render. Dengan begitu
 * Gemini storyboard, retainedCleanFrames, dan rescue pool ikut mengecualikan frame
 * kotor TANPA perlu state machine baru di hilir.
 *
 * Mode oracle OFF -> `frames` dikembalikan utuh, tanpa efek samping apa pun.
 */
export async function applyOracleVeto(frames = [], { jobId = '', niche = 'kitchen_tools', facePolicy = 'strict', blacklisted = null, onProgress = null, logger = console, env = process.env, outDir = null } = {}) {
  const res = await sanitizePoolWithOracle(frames, { jobId, niche, facePolicy, onProgress, logger, env, outDir });
  if (!res.enabled) return { frames, ...res };
  if (res.blacklisted.length && blacklisted && typeof blacklisted.add === 'function') {
    for (const p of res.blacklisted) blacklisted.add(p);
  }
  const dirty = new Set(res.blacklisted);
  const kept = dirty.size > 0 ? frames.filter((f) => f && f.filePath && !dirty.has(f.filePath)) : frames;
  return { frames: kept, ...res };
}

/**
 * AUDIT KLIP FINAL (pass kedua, titik kait paling hulu sebelum FFmpeg).
 *
 * Dipanggil dari tahap `clip_audit` stage1Render, yang SUDAH mengekstrak frame
 * tiap 0,40 s (2,5 fps) dari file section 1080p yang baru diunduh. Jadi fungsi ini
 * TIDAK menambah ekstraksi FFmpeg sama sekali — hanya mengirim frame yang sudah
 * ada ke oracle dan menerjemahkan vonisnya menjadi keputusan per KLIP.
 *
 * Kenapa per klip, bukan per frame: pada tahap ini satuan kerja adalah klip utuh
 * 3-6 detik. Satu frame kotor berarti klip itu tidak bisa dipakai; tidak ada
 * gunanya membuang satu frame dari tengah sebuah klip. Pemanggil cukup memasukkan
 * klip yang kotor ke `discardedDirtyClips` yang sudah ada (Slot 1 restore +
 * pemulihan dari pooledFrames menangani sisanya).
 *
 * KEBIJAKAN SAMA seperti pass pool: tidak menjawab / timeout / vonis tidak sah =
 * TIDAK ada entri di `verdicts` = klip lolos seperti sekarang. Tidak pernah melempar.
 */
export async function auditClipsWithOracle(clips = [], frameGroups = [], opts = {}) {
  const {
    jobId = '', niche = 'kitchen_tools', facePolicy = 'strict',
    logger = console, env = process.env, onProgress = null, outDir = null,
  } = opts;
  const cfg = resolveOracleConfig(env);
  const verdicts = new Map();
  const summary = { enabled: cfg.enabled, checked: 0, rejectedClips: 0, timedOut: 0, converted: 0, elapsedMs: 0, note: '' };
  if (!cfg.enabled) return { verdicts, ...summary };
  if (cfg.auditMaxFrames === 0) {
    return { verdicts, ...summary, note: 'Pass audit klip dinonaktifkan (VLM_ORACLE_AUDIT_MAX_FRAMES=0).' };
  }

  const list = Array.isArray(clips) ? clips : [];
  if (!list.length) return { verdicts, ...summary, note: 'Tidak ada klip untuk diaudit.' };

  // Plafon total dibagi merata per klip; klip pendek tetap dapat minimal 2 titik.
  const perClipCap = Math.max(2, Math.floor(cfg.auditMaxFrames / list.length));
  const prompt = buildVlmPrompt(niche, facePolicy);
  const t0 = Date.now();
  const deadline = t0 + cfg.totalTimeoutMs;

  for (let i = 0; i < list.length; i++) {
    const group = Array.isArray(frameGroups[i]) ? frameGroups[i] : [];
    const frames = group.filter((f) => f && f.filePath && fs.existsSync(f.filePath));
    if (!frames.length) continue;
    if (Date.now() > deadline) {
      summary.note = `Anggaran waktu audit klip habis (${cfg.totalTimeoutMs / 1000}s) — klip #${i + 1} dst TIDAK divisit oracle.`;
      logger.warn(`[Oracle] ${summary.note}`);
      break;
    }

    const picked = pickEvenlySpaced(frames, perClipCap);
    const prepared = await prepareOracleFrames(picked, { height: cfg.frameHeight, jobId, outDir, logger, env });
    summary.converted += prepared.converted;
    const sendable = prepared.sent;
    const backToOriginal = prepared.originalBySent;
    const clipLabel = `klip #${i + 1}`;

    for (let start = 0; start < sendable.length; start += cfg.batchSize) {
      const batchFrames = sendable.slice(start, start + cfg.batchSize);
      const paths = batchFrames.map((f) => f.filePath);
      const id = makeBatchId(jobId, i, paths);
      try {
        enqueueOracleBatch({
          id, jobId,
          sceneIdx: 10000 + i * 100 + Math.floor(start / cfg.batchSize),
          frames: batchFrames.map((f, idx) => ({ index: idx, filePath: f.filePath, timestampMs: f.timestampMs ?? null })),
          niche, facePolicy, prompt,
        });
        const waited = await waitForOracleVerdict(id, {
          timeoutMs: Math.min(cfg.perBatchTimeoutMs, Math.max(0, deadline - Date.now())),
          pollMs: cfg.pollMs, sleep,
        });
        if (waited.status === 'done') {
          const v = normalizeOracleVerdict(waited.verdict, { expectedFrames: paths.length });
          summary.checked += paths.length;
          if (v.ok && v.vetoTriggered) {
            const dirtySent = (v.dirtyFrameIndexes || []).map((k) => paths[k]).filter(Boolean);
            const dirtyOrig = (dirtySent.length > 0 ? dirtySent : paths).map((p) => backToOriginal.get(p) || p);
            verdicts.set(i, {
              dirty: true,
              dirtyFrames: dirtyOrig,
              reason: String(v.reason || (dirtySent.length ? 'frame kotor' : 'klip dicurigai model')).slice(0, 300),
              model: v.model,
            });
            summary.rejectedClips += 1;
            logger.log(`[Oracle] ⛔ ${clipLabel} ditolak model besar (${dirtyOrig.length} frame kotor) — ${v.reason || 'tanpa alasan'} [${v.model || 'model=?'}]`);
            break; // klipnya sudah tertolak; meneruskan batch untuk klip ini hanya membakar GPU
          } else if (v.ok) {
            logger.log(`[Oracle] ✅ ${clipLabel} bersih (${paths.length} frame).`);
          } else {
            summary.timedOut += paths.length;
            logger.warn(`[Oracle] Vonis ${clipLabel} tidak sah (${v.error}) -> klip TETAP dipakai.`);
          }
        } else {
          summary.timedOut += paths.length;
          if (waited.status === 'timeout') expireOracleBatch(id, 'Worker menyerah sebelum vonis audit klip tiba.');
          logger.warn(`[Oracle] ${clipLabel} tidak dijawab (${waited.status}) -> klip TETAP dipakai.`);
        }
      } catch (err) {
        summary.timedOut += paths.length;
        logger.warn(`[Oracle] Error antrean audit ${clipLabel}: ${err.message} -> klip TETAP dipakai.`);
      }

      if (onProgress) {
        try {
          onProgress({
            step: 'vlm_oracle',
            message: `🛰️ Oracle Kaggle audit klip: ${summary.checked} frame divisit, ${summary.rejectedClips} klip ditolak.`,
            progress: 61,
            status: 'running',
          });
        } catch { /* progres tidak boleh menjatuhkan job */ }
      }
    }
  }

  summary.elapsedMs = Date.now() - t0;
  if (!summary.checked && !summary.note) summary.note = 'Audit klip aktif tapi tidak ada frame valid.';
  return { verdicts, ...summary };
}
