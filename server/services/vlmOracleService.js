// ============================================================================
// VLM Oracle Service — vonis frame oleh MODEL BESAR di luar perangkat.
//
// Kenapa ada file ini: perangkat user (Unisoc T7250 / CPU PC) tidak sanggup
// menjalankan VLM sebagai gerbang per-scene. Terukur di Termux (llama-mtmd-cli
// b11362 + SmolVLM2-500M Q4_K_M): 36-52 DETIK PER FRAME, dan biayanya per-gambar
// (4 frame sekali panggil = 162 dtk), bukan per-proses. Solusi: bobot besar
// (Qwen2.5-VL-7B-Instruct-AWQ) jalan di GPU Kaggle; perangkat lokal hanya
// mengantre batch frame dan menunggu vonis.
//
// ARAH PANGGILAN DIPAKSA OLEH FISIKA JARINGAN: notebook Kaggle tidak punya
// inbound, jadi notebook-lah yang menjadi KLIEN (claim -> unduh frame -> vonis ->
// submit). Pipeline lokal tidak pernah "menelepon" Kaggle; ia hanya menulis ke
// antrean SQLite dan membaca hasilnya. Konsekuensi bagus: notebook boleh mati
// kapan saja tanpa merusak job.
//
// KEBIJAKAN FALLBACK (yang ini penting, jangan diubah tanpa alasan):
//   oracle menjawab  -> frame divonis KOTOR masuk daftar blacklist (veto).
//   oracle diam/timeout/validasi gagal -> TIDAK ADA VONIS = tidak memveto apa pun,
//   dan keputusan gatekeeper legacy + Gemini tetap berlaku. Ini BUKAN fail-open
//   terhadap konten, karena legacy path sudah berjalan penuh di sekitar tahap ini;
//   oracle hanya menambah lapisan. (Bandingkan jalur 'smolvlm' yang MELEWATI
//   legacy lalu fail-open saat VLM timeout — jalur itu berbahaya, lihat README.)
// ============================================================================
import crypto from 'crypto';
import fs from 'fs';
import { buildVlmPrompt } from './vlmGateService.js';
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
    logger = console, env = process.env, onProgress = null,
  } = opts;
  const cfg = resolveOracleConfig(env);
  const result = { enabled: cfg.enabled, checked: 0, rejected: 0, timedOut: 0, blacklisted: [], elapsedMs: 0, note: '' };
  if (!cfg.enabled || cfg.maxFrames === 0) return result;

  const valid = (Array.isArray(frames) ? frames : []).filter((f) => f && f.filePath && fs.existsSync(f.filePath));
  const subset = pickEvenlySpaced(valid, cfg.maxFrames);
  if (subset.length === 0) return result;

  const t0 = Date.now();
  const prompt = buildVlmPrompt(niche, facePolicy);
  const deadline = t0 + cfg.totalTimeoutMs;

  for (let start = 0; start < subset.length; start += cfg.batchSize) {
    const batchFrames = subset.slice(start, start + cfg.batchSize);
    if (Date.now() > deadline) {
      result.note = `Anggaran waktu oracle habis (${cfg.totalTimeoutMs / 1000}s) — sisa ${subset.length - start} frame TIDAK divisit, keputusan legacy berlaku.`;
      logger.warn(`[Oracle] ${result.note}`);
      break;
    }

    const paths = batchFrames.map((f) => f.filePath);
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
          const toBlacklist = dirty.length > 0 ? dirty : paths;
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
export async function applyOracleVeto(frames = [], { jobId = '', niche = 'kitchen_tools', facePolicy = 'strict', blacklisted = null, onProgress = null, logger = console, env = process.env } = {}) {
  const res = await sanitizePoolWithOracle(frames, { jobId, niche, facePolicy, onProgress, logger, env });
  if (!res.enabled) return { frames, ...res };
  if (res.blacklisted.length && blacklisted && typeof blacklisted.add === 'function') {
    for (const p of res.blacklisted) blacklisted.add(p);
  }
  const dirty = new Set(res.blacklisted);
  const kept = dirty.size > 0 ? frames.filter((f) => f && f.filePath && !dirty.has(f.filePath)) : frames;
  return { frames: kept, ...res };
}
