// ============================================================================
// VLM Oracle Routes — pintu masuk bagi NOTEBOOK KAGGLE yang memvonis frame.
//
// Arah koneksi: Kaggle tidak punya inbound, jadi notebook yang memanggil API ini
// lewat URL publik (CLOUDFLARE_TUNNEL_URL). Pipeline lokal tidak pernah memanggil
// Kaggle. Endpoint ini hanya melayani sisi READ/CLAIM/REPORT antrean Oracle.
//
// PINTU KEAMANAN (sengaja lebih ketat dari endpoint lain):
//  1) Endpoint TIDAK dimasukkan ke allowlist publik tokenAuth -> butuh token bila
//     API_ACCESS_TOKEN diisi. Tapi bukan itu saja:
//  2) Endpoint frame/claim MENOLAK layanan selama API_ACCESS_TOKEN KOSONG. Alasan:
//     yang mengambil data di sini adalah mesin di luar jaringan Anda (cloud Kaggle),
//     dan yang diserahkan adalah bingkai video milik Anda. Tanpa token, URL tunnel
//     publik = siapa pun bisa menarik frame dan menyuntik vonis palsu. Mode 'open'
//     untuk pemakaian lokal masih nyaman, tapi tidak untuk jalur keluar ini.
//  3) Path frame divalidasi terhadap root yang dikenal (temp/output/rejected_frames)
//     -> batch berisi path yang kita kirim sendiri, tetapi validasi ini menutup
//     celah traversal bila ada pihak lain bisa menulis antrean / mengubah DB.
// ============================================================================
import fs from 'fs';
import path from 'path';
import express from 'express';
import {
  claimOracleBatch,
  submitOracleResult,
  getOracleBatch,
  oracleQueueStats,
  countBusyOracleJobs,
  pruneOracleBatches,
  touchOracleHeartbeat,
} from '../../store/jobStore.js';
import { resolveOracleConfig } from '../../services/vlmOracleService.js';
import { isOracleStrictMode } from '../../config/runtimeFlags.js';
import { createRateLimiter, recordAuditEvent } from '../../utils/security.js';
import { getApiAccessToken } from '../middleware/tokenAuth.js';
import { serverRoot, outputDir, tempDir, rejectedYunetDir } from '../../utils/paths.js';

const router = express.Router();

const claimLimiter = createRateLimiter({ name: 'vlm-oracle-claim', windowMs: 60_000, max: 120 });
const resultLimiter = createRateLimiter({ name: 'vlm-oracle-result', windowMs: 60_000, max: 240 });
const frameLimiter = createRateLimiter({ name: 'vlm-oracle-frame', windowMs: 60_000, max: 600 });

const ALLOWED_FRAME_ROOTS = [tempDir, outputDir, rejectedYunetDir, serverRoot];

/** Jawab 503 bila token belum dikonfigurasi. Return true bila sudah aman. */
function requireOracleToken(req, res) {
  if (getApiAccessToken()) return true;
  res.status(503).json({
    success: false,
    error: 'Oracle menolak melayani tanpa API_ACCESS_TOKEN: endpoint ini menyerahkan bingkai video Anda ke mesin di luar jaringan lokal. Set API_ACCESS_TOKEN di server/.env lalu restart, dan kirim token yang sama dari notebook (header x-api-token).',
  });
  return false;
}

/** Path hanya boleh berada di bawah salah satu root yang dikenal. */
export function isAllowedFramePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  // BUG LINTAS PLATFORM (terbukti di Tes vitest Termux 2026-10-04): di Linux backslash
  // BUKAN pemisah, jadi 'C:\Users\lain\rahasia.jpg' dianggap satu nama file relatif dan
  // resolve() menempelkannya ke CWD — yang kebetulan root yang diizinkan — dan LOLOS.
  // Di Windows justru path dengan '/' yang lolos dari separator lokal. Normalisasi dulu:
  // ganti '\' -> '/', lalu tolak mutlak path Windows-style (huruf drive 'X:' di segmen
  // pertama) sebelum dibandingkan terhadap root POSIX/Windows asli.
  const slashed = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(slashed) && path.sep === '/') return false;
  const resolved = path.resolve(process.platform === 'win32' ? filePath : slashed);
  return ALLOWED_FRAME_ROOTS.some((root) => {
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(withSep);
  });
}

/**
 * [1] CLAIM — notebook mengambil satu batch menunggu.
 * Response: { batchId, jobId, sceneIdx, prompt, frames: [{index, url}] } atau 204 bila kosong.
 * `url` relatif terhadap base API; notebook menempelkannya ke VLM_ORACLE_BASE_URL.
 */
router.post('/vlm-oracle/claim', claimLimiter, (req, res) => {
  if (!requireOracleToken(req, res)) return undefined;
  const cfg = resolveOracleConfig(process.env);
  const workerId = String((req.body && req.body.workerId) || req.headers['x-oracle-worker'] || 'kaggle').slice(0, 120);
  // HEARTBEAT: setiap claim yang lewat — termasuk polling kosong (claimed:false) — adalah
  // bukti notebook HIDUP. Satu-satunya sinyal koneksi yang jujur, karena arah panggilan
  // dipaksa fisika jaringan (Kaggle tidak punya inbound). Dibaca gerbang stage1Render via
  // oracleLastSeenMs(): tanpa heartbeat segar, job baru langsung dihentikan.
  touchOracleHeartbeat(workerId);
  const batch = claimOracleBatch({ workerId, staleMs: cfg.staleMs, maxAttempts: cfg.maxAttempts });
  if (!batch) {
    // 200 (bukan 204) karena tetap mengirim ikhtisar antrean; 204 tidak boleh berbadan.
    // `activeJobs` = sinyal HEMAT untuk idle-exit notebook: antrean kosong saat ada job
    // berjalan (fase unduh/render panjang di antara tahap oracle) BUKAN waktunya membunuh
    // kernel - audit klip final akan mengantri batch beberapa menit/jam lagi.
    res.json({ success: true, claimed: false, pending: oracleQueueStats().counts.pending, activeJobs: countBusyOracleJobs() });
    return undefined;
  }
  recordAuditEvent({ req, action: 'vlm-oracle-claim', detail: `batch=${batch.id} frames=${batch.frames.length} worker=${workerId}` });
  res.json({
    success: true,
    claimed: true,
    batchId: batch.id,
    jobId: batch.jobId,
    sceneIdx: batch.sceneIdx,
    niche: batch.niche,
    facePolicy: batch.facePolicy,
    prompt: batch.prompt,
    frames: batch.frames.map((f) => ({
      index: f.index,
      url: `/api/vlm-oracle/frames/${encodeURIComponent(batch.id)}/${Number(f.index) || 0}`,
      timestampMs: f.timestampMs ?? null,
    })),
  });
  return undefined;
});

/**
 * [2] REPORT — notebook mengirim vonis (atau error). Body:
 *   { batchId, verdict: { safe, face, text, watermark, graphic, reason?, model?, perFrame? }, error? }
 * Vonis tidak divalidasi ketat di sini; sisi worker (normalizeOracleVerdict) yang
 * memutuskan sah/tidak, supaya notebook lama/baru tidak membuat endpoint 500.
 */
router.post('/vlm-oracle/result', resultLimiter, (req, res) => {
  if (!requireOracleToken(req, res)) return undefined;
  const { batchId, verdict, error } = req.body || {};
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ success: false, error: 'batchId wajib ada.' });
  }
  const out = submitOracleResult({ batchId: batchId.slice(0, 120), verdict, lastError: error || '' });
  if (!out.ok && out.status === 'unknown') {
    return res.status(404).json({ success: false, error: `Batch ${batchId} tidak dikenal (mungkin sudah di-prune).` });
  }
  if (!out.ok && out.status === 'expired') {
    // BUKAN error fatal: worker sudah menyerah. Notebook cukup tahu kerjaannya tidak dipakai.
    return res.status(409).json({ success: false, status: 'expired', error: 'Worker sudah berhenti menunggu batch ini; vonis diterima tapi tidak dipakai.' });
  }
  return res.json({ success: true, status: out.status, duplicate: !!out.duplicate });
});

/**
 * [3] FRAME — sajikan satu JPEG hasil sampling. Token sudah diverifikasi middleware;
 * di sini kita jaga path dan keberadaan batch.
 */
router.get('/vlm-oracle/frames/:batchId/:index', frameLimiter, (req, res) => {
  if (!requireOracleToken(req, res)) return undefined;
  const batch = getOracleBatch(String(req.params.batchId || '').slice(0, 120));
  if (!batch) return res.status(404).json({ success: false, error: 'Batch tidak ada.' });
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ success: false, error: 'Index frame tidak sah.' });
  }
  // Cari berdasarkan field `index` (bukan posisi array): urutan kirim boleh saja
  // berbeda dari urutan penyimpanan, dan salah ambil frame = vonis pada gambar yang salah.
  const entry = batch.frames.find((f) => Number(f && f.index) === idx);
  if (!entry) {
    return res.status(400).json({ success: false, error: `Index ${idx} tidak ada di batch (${batch.frames.length} frame).` });
  }
  const filePath = entry.filePath;
  if (!isAllowedFramePath(filePath)) {
    recordAuditEvent({ req, action: 'vlm-oracle-frame-rejected', detail: `batch=${batch.id} idx=${idx} path=${String(filePath).slice(0, 200)}` });
    return res.status(403).json({ success: false, error: 'Path frame di luar direktori yang diizinkan.' });
  }
  if (!fs.existsSync(filePath)) return res.status(410).json({ success: false, error: 'Frame sudah dibersihkan dari disk.' });
  return res.sendFile(path.resolve(filePath), (err) => {
    if (err && !res.headersSent) res.status(500).json({ success: false, error: 'Gagal membaca frame.' });
  });
});

/** [4] STATUS — ikhter antrean untuk operator/UI (tetap butuh token karena memuat id job). */
router.get('/vlm-oracle/status', (req, res) => {
  const cfg = resolveOracleConfig(process.env);
  const stats = oracleQueueStats();
  const lastSeenAt = stats.lastSeenAt;
  // Window "terhubung" = VLM_ORACLE_STALE_SEC (sama dengan gerbang stage1Render);
  // CONNECT_TIMEOUT dipakai untuk batas tunggu klaim PERTAMA, bukan window heartbeat.
  const freshMs = cfg.staleMs;
  const connected = Boolean(lastSeenAt) && (Date.now() - lastSeenAt) <= freshMs;
  res.json({
    success: true,
    oracle: {
      enabled: cfg.enabled,
      mode: process.env.VISION_VERIFY_MODE || 'oracle',
      strict: isOracleStrictMode(process.env), // vonis legacy hanya ada bila mode non-oracle di-set eksplisit (tooling) — produksi selalu true
      connected,
      lastSeenAt,
      lastSeenAgeMs: lastSeenAt ? Date.now() - lastSeenAt : null,
      maxFrames: cfg.maxFrames,
      batchSize: cfg.batchSize,
      perBatchTimeoutSec: Math.round(cfg.perBatchTimeoutMs / 1000),
      totalTimeoutSec: Math.round(cfg.totalTimeoutMs / 1000),
      connectTimeoutSec: Math.round(cfg.connectTimeoutMs / 1000),
      heartbeatWindowSec: Math.round(freshMs / 1000),
      baseUrl: cfg.baseUrl || null,
      tokenConfigured: Boolean(getApiAccessToken()),
      queue: stats.counts,
      oldestPendingAgeMs: stats.oldestPendingAgeMs,
    },
  });
});

/** [5] PRUNE — rapikan batch selesai/kadaluarsa yang lebih tua dari 24 jam. */
router.post('/vlm-oracle/prune', (req, res) => {
  if (!requireOracleToken(req, res)) return undefined;
  const removed = pruneOracleBatches();
  return res.json({ success: true, removed });
});

export default router;
