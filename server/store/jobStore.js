import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { trackProgressEvent } from '../services/observabilityService.js';

// Provider di-inject oleh server.js untuk mencegah circular dependency jobStore <-> server.js
let dailyStatsProvider = () => null;
export function setDailyStatsProvider(fn) {
  dailyStatsProvider = fn;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const jobsFilePath = process.env.JOBS_DB_PATH || path.join(__dirname, '..', 'jobs.db');

// Inisialisasi SQLite
const db = new Database(jobsFilePath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auto_runs (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auto_retry_runs (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  -- ORACLE KAGGLE (VISION_VERIFY_MODE=oracle): antrean batch frame yang menunggu vonis
  -- model besar di luar perangkat. Notebook adalah KLIEN (Kaggle tidak punya inbound),
  -- jadi dia yang mengklaim & melaporkan hasil. Status: pending -> claimed -> done,
  -- atau -> expired (worker menyerah / percobaan habis).
  -- CATATAN: komentar di dalam db.exec WAJIB '--' (bukan '//') karena ini SQL, bukan JS.
  CREATE TABLE IF NOT EXISTS vlm_oracle_batches (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scene_idx INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    completed_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vlm_oracle_status ON vlm_oracle_batches(status, created_at);

  -- HEARTBEAT NOTEBOOK KAGGLE: satu baris per workerId, di-update setiap kali dia memanggil
  -- POST /vlm-oracle/claim — TERMASUK polling kosong (200 claimed:false). Ini-sinyal jujur
  -- "Kaggle terhubung": arah koneksi dipaksa fisika jaringan (notebook = klien), jadi tidak
  -- ada cara lain mengetahui notebook hidup selain melihat dia terakhir bertanya.
  CREATE TABLE IF NOT EXISTS oracle_heartbeat (
    worker_id TEXT PRIMARY KEY,
    last_seen_at INTEGER NOT NULL
  );

  -- PEMAKAIAN AI (Lapis 1 rencana hemat token): SATU baris per panggilan provider AI,
  -- termasuk yang GAGAL (ok=0) karena justru kegagalan/kuota yang menjelaskan rantai
  -- fallback model. total_tokens diambil dari provider, BUKAN dari angka karangan yang
  -- dipakai trackBandwidth selama ini (2500/3500 byte tetap dibiarkan apa adanya di situs
  -- lamanya supaya pencatatan lama tidak berubah makna; itulah guna kolom bytes di sini).
  -- cost terisi hanya bila provider mengirimkannya (OpenRouter menyertakan usage.cost).
  CREATE TABLE IF NOT EXISTS ai_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT 'unknown',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    input_kind TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    request_bytes INTEGER NOT NULL DEFAULT 0,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    media_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    error_code TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_job ON ai_usage_events(job_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_site ON ai_usage_events(site, created_at);
`);

export function sanitizeJobForDisk(job) {
  if (!job || typeof job !== 'object') return job;
  const clone = { ...job };
  delete clone.geminiApiKey;
  delete clone.apiKey;
  delete clone.openRouterApiKey;
  return clone;
}

// Proxy untuk activeJobs agar kompatibel dengan API Map
export const activeJobs = {
  get: (id) => {
    const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  },
  set: (id, data) => {
    const cleanJob = sanitizeJobForDisk(data);
    db.prepare('INSERT OR REPLACE INTO jobs (id, data) VALUES (?, ?)').run(id, JSON.stringify(cleanJob));
    return activeJobs;
  },
  delete: (id) => {
    const res = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    return res.changes > 0;
  },
  has: (id) => {
    return !!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
  },
  entries: function* () {
    for (const row of db.prepare('SELECT id, data FROM jobs').iterate()) {
      yield [row.id, JSON.parse(row.data)];
    }
  },
  values: function* () {
    for (const row of db.prepare('SELECT data FROM jobs').iterate()) {
      yield JSON.parse(row.data);
    }
  },
  get size() {
    return db.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
  }
};

export const autoRuns = {
  get: (id) => {
    const row = db.prepare('SELECT data FROM auto_runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  },
  set: (id, data) => {
    db.prepare('INSERT OR REPLACE INTO auto_runs (id, data) VALUES (?, ?)').run(id, JSON.stringify(data));
    return autoRuns;
  },
  delete: (id) => {
    const res = db.prepare('DELETE FROM auto_runs WHERE id = ?').run(id);
    return res.changes > 0;
  },
  values: function* () {
    for (const row of db.prepare('SELECT data FROM auto_runs').iterate()) {
      yield JSON.parse(row.data);
    }
  },
  entries: function* () {
    for (const row of db.prepare('SELECT id, data FROM auto_runs').iterate()) {
      yield [row.id, JSON.parse(row.data)];
    }
  }
};

export const autoRetryRuns = {
  get: (id) => {
    const row = db.prepare('SELECT data FROM auto_retry_runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  },
  set: (id, data) => {
    db.prepare('INSERT OR REPLACE INTO auto_retry_runs (id, data) VALUES (?, ?)').run(id, JSON.stringify(data));
    return autoRetryRuns;
  },
  delete: (id) => {
    const res = db.prepare('DELETE FROM auto_retry_runs WHERE id = ?').run(id);
    return res.changes > 0;
  },
  values: function* () {
    for (const row of db.prepare('SELECT data FROM auto_retry_runs').iterate()) {
      yield JSON.parse(row.data);
    }
  },
  entries: function* () {
    for (const row of db.prepare('SELECT id, data FROM auto_retry_runs').iterate()) {
      yield [row.id, JSON.parse(row.data)];
    }
  }
};

// P1 OBSERVABILITY: semua worker menulis progress lewat Map ini (stage1Render, finalizationService,
// autoRetryService, routes). Dengan memasang tap di sini, SATU titik menutupi seluruh jejak stage
// tanpa menyentuh 2600 baris pipeline. trackProgressEvent hanya menulis saat GANTI stage dan selalu
// dibungkus try/catch, jadi logging tidak pernah bisa menjatuhkan job.
class TraceAwareProgressMap extends Map {
  set(key, value) {
    try {
      trackProgressEvent(key, value);
    } catch (err) {
      console.warn(`[Trace] tap gagal untuk job ${key}: ${err.message}`);
    }
    return super.set(key, value);
  }
}

export const jobProgress = new TraceAwareProgressMap();

// Legacy functions from JSON era (now no-ops or adapted)
export function atomicWriteJsonSync(filePath, data) {} 
export function persistJob(jobId, jobData) {
  activeJobs.set(jobId, jobData);
}
export function deletePersistedJob(jobId) {
  activeJobs.delete(jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// P4: STATE JOB LEBIH AMAN (ringan) — patchJob atomik + guard transisi + throttle persist.
// Catatan penting: `activeJobs` BUKAN Map memori; ia proxy langsung ke SQLite. Jadi
// `activeJobs.get()` me-JSON.parse salinan BARU tiap calls -> pola lama
// `const job = activeJobs.get(id); job.x = ..; activeJobs.set(id, job)` berisiko LOST-UPDATE
// bila dua writer async membaca salinan yang sama lalu saling menimpa. `patchJob` melakukan
// baca→gabung→tulis DALAM SATU transaksi, dan hanya menulis SEKALI (memangkas pasangan
// boros `activeJobs.set(...) + persistJob(...)` yang menulis dua kali).
// ─────────────────────────────────────────────────────────────────────────────

// Status/terminal yang menandai job selesai (sinkron dengan kosakata stage1Render/routes).
export const TERMINAL_STAGES = new Set(['completed', 'error', 'stopped', 'rejected_bulky', 'awaiting_voiceover']);
// Transisi keluar dari terminal HANYA sah untuk jalur retry (kembali ke running/retrying).
const RETRY_STAGES = new Set(['running', 'retrying']);

/**
 * Guard transisi SEDERHANA (bukan mesin state 8-negara). Menolak regresi paling berbahaya:
 * job yang sudah terminal diam-diam turun ke stage non-retry (mis. 'completed' -> 'running'
 * tanpa retry, atau -> 'pending' karena bug). Transisi normal dan transisi retry lolos.
 */
export function isValidStageTransition(fromStage, toStage) {
  if (!fromStage || !toStage) return true;            // stage pertama kali di-set
  if (fromStage === toStage) return true;             // idempotent
  if (!TERMINAL_STAGES.has(fromStage)) return true;   // dari non-terminal: bebas
  return RETRY_STAGES.has(toStage);                    // dari terminal: hanya retry yang sah
}

/**
 * Baca-gabung-tulis atomik. `patch` boleh objek (shallow-merge) atau fungsi (job)=>jobBaru.
 * @param {string} jobId
 * @param {object|((job:object)=>object)} patch
 * @param {{force?:boolean}} [opts] force=true menembus guard transisi stage (untuk jalur retry sah).
 * @returns {object} job hasil akhir (sudah dibersihkan untuk disk + updatedAt).
 */
export function patchJob(jobId, patch, { force = false } = {}) {
  const applyFn = typeof patch === 'function' ? patch : (job) => ({ ...job, ...patch });
  let updated = null;
  let blockedFrom = null;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get(jobId);
    const current = row ? JSON.parse(row.data) : { id: jobId };
    const merged = applyFn(current) || current;
    // Guard transisi stage (kecuali force). Bila ditolak, PERTAHANKAN stage lama (jangan dihapus);
    // field lain dari patch tetap disimpan.
    if (!force && merged.stage && merged.stage !== current.stage
        && !isValidStageTransition(current.stage, merged.stage)) {
      blockedFrom = current.stage;
      merged.stage = current.stage;
    }
    updated = { ...merged, id: jobId, updatedAt: new Date().toISOString() };
    db.prepare('INSERT OR REPLACE INTO jobs (id, data) VALUES (?, ?)').run(jobId, JSON.stringify(sanitizeJobForDisk(updated)));
  });
  tx();
  if (blockedFrom) {
    console.warn(`[JobStore] patchJob(${jobId}) MENOLAK transisi stage '${blockedFrom}' -> '${patch?.stage || (typeof patch === 'function' ? '=?' : patch?.stage)}' (terminal tanpa retry). Field lain tetap disimpan; kirim {force:true} bila memang retry sah.`);
  }
  return updated;
}

// P4.2 Throttle persist status progres: cermin ringan {stage,progress,message,lastStep} ke baris
// job MAKSINAL 1×/detik saat 'running', TAPI selalu ditulis pada transisi terminal. Hanya menyentuh
// job yang SUDAH ada (tidak membuat stub untuk progress transien) dan memakai patchJob (atomik).
const PROGRESS_PERSIST_THROTTLE_MS = 1000;
const lastProgressPersistTs = new Map();

export function maybePersistJobStatus(jobId, payload, { now = Date.now() } = {}) {
  const status = payload && payload.status;
  if (!status) return false;
  const isTerminal = TERMINAL_STAGES.has(status);
  if (!isTerminal && !activeJobs.has(jobId)) return false; // jangan buat job hantu
  const last = lastProgressPersistTs.get(jobId) || 0;
  if (!isTerminal && (now - last) < PROGRESS_PERSIST_THROTTLE_MS) return false;
  lastProgressPersistTs.set(jobId, now);
  patchJob(jobId, (job) => {
    if (!job.id && !activeJobs.has(jobId)) return job; // double-guard anti-stub
    const next = { ...job };
    next.stage = status;
    if (typeof payload.progress === 'number') next.progress = payload.progress;
    if (payload.message) next.message = payload.message;
    if (payload.step) next.lastStep = payload.step;
    return next;
  }, { force: isTerminal || RETRY_STAGES.has(status) });
  return true;
}

export function loadJobsFromDisk() {
  console.log(`[Jobs] SQLite Database initialized. Active jobs: ${activeJobs.size}`);
  // Reset stuck jobs. PENTING: kumpulkan dulu dalam array, baru tulis DI LUAR iterasi.
  // activeJobs.entries() memakai better-sqlite3 .iterate(); memanggil activeJobs.set()
  // (INSERT/REPLACE) sementara cursor iterate() masih terbuka pada koneksi yang sama
  // melempar "This database connection is busy executing a query" dan menjatuhkan boot.
  // #7: sebelumnya HANYA 'running' yang di-reset, sehingga job yang tertinggal di stage
  // non-terminal lain ('retrying' dari autoRetry, 'starting'/'processing' dari jalur lama)
  // muncul sebagai "phantom running" di UI setelah restart. Kita pakai daftar eksplisit
  // (BUKAN negasi TERMINAL_STAGES) agar 'awaiting_voiceover' — resting state sah dengan
  // silent 9:16 — tidak ikut diubah.
  const NON_TERMINAL_JOB_STAGES = new Set(['running', 'retrying', 'starting', 'processing', 'pending']);
  const stuckJobs = [];
  for (const [jobId, jobData] of activeJobs.entries()) {
    if (NON_TERMINAL_JOB_STAGES.has(jobData.stage)) {
      stuckJobs.push([jobId, jobData]);
    }
  }
  for (const [jobId, jobData] of stuckJobs) {
    jobData.stage = 'stopped';
    jobData.status = 'stopped';
    jobData.lastError = jobData.lastError || 'Dihentikan karena server di-restart di tengah proses.';
    jobData.message = 'Proses dihentikan karena server di-restart.';
    activeJobs.set(jobId, jobData);
  }
  if (stuckJobs.length) {
    console.log(`[Jobs] Rekonsiliasi ${stuckJobs.length} job yatim non-terminal -> stopped.`);
  }

  // Reset autoRuns/autoRetryRuns non-terminal yang YATIM. Setelah proses restart, TIDAK ADA
  // worker yang berjalan (worker hanya dibuat oleh /auto/start di proses ini), sehingga baris
  // auto_runs dengan status 'starting'/'running'/'stopping' yang tersimpan di DB adalah sisa
  // proses lama. Tanpa rekonsiliasi ini, AutoModePanel (via /api/auto/status) menampilkan
  // hantu "Auto Mode berjalan" padahal log diam, dan /auto/start bisa terblokir.
  const NON_TERMINAL = new Set(['starting', 'running', 'stopping']);
  const staleRuns = [];
  for (const [runId, run] of autoRuns.entries()) {
    if (run && NON_TERMINAL.has(run.status)) staleRuns.push([runId, run]);
  }
  for (const [runId, run] of staleRuns) {
    const nowIso = new Date().toISOString();
    run.status = 'stopped';
    run.message = 'Auto Mode dihentikan karena server di-restart (tidak ada worker aktif).';
    run.updatedAt = nowIso;
    run.finishedAt = run.finishedAt || nowIso;
    autoRuns.set(runId, run);
  }
  const staleRetries = [];
  for (const [runId, run] of autoRetryRuns.entries()) {
    if (run && NON_TERMINAL.has(run.status)) staleRetries.push([runId, run]);
  }
  for (const [runId, run] of staleRetries) {
    run.status = 'stopped';
    run.message = 'Auto Retry dihentikan karena server di-restart (tidak ada worker aktif).';
    run.updatedAt = new Date().toISOString();
    autoRetryRuns.set(runId, run);
  }
  if (staleRuns.length || staleRetries.length) {
    console.log(`[Jobs] Rekonsiliasi ${staleRuns.length} autoRun & ${staleRetries.length} autoRetry yatim -> stopped.`);
  }
}

export function updateJobProgress(jobId, data) {
  const payload = typeof data === 'string'
    ? { step: 'processing', message: data, progress: 50, jobId, status: 'running' }
    : { status: 'running', ...data, jobId };
  jobProgress.set(jobId, payload);
  console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message || ''}`);
  // P4.2: cermin status ke baris job (throttled 1×/detik saat running, selalu saat terminal)
  // agar restart tidak menghapus progres terakhir & /job-trace bisa membaca stage dari DB.
  try {
    maybePersistJobStatus(jobId, payload);
  } catch (err) {
    console.warn(`[JobStore] persist status gagal untuk job ${jobId}: ${err.message}`);
  }
}

export function publicAutoRetryState(run) {
  if (!run) return { status: 'idle' };
  return {
    jobId: run.jobId,
    status: run.status,
    attemptCount: run.attemptCount || 0,
    currentVideoTitle: run.currentVideoTitle || '',
    message: run.message || '',
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

export function publicAutoRunState(run) {
  const dailyStats = dailyStatsProvider() || { limit: 0, count: 0, remaining: 0, isLimitReached: false, videos: [] };
  if (!run) return { status: 'idle', dailyStats };
  return {
    runId: run.runId,
    status: run.status,
    maxJobs: run.maxJobs,
    successfulJobs: run.successfulJobs,
    failedJobs: run.failedJobs,
    skippedProducts: run.skippedProducts,
    currentJobId: run.currentJobId,
    currentProductTitle: run.currentProductTitle,
    message: run.message,
    progress: run.progress,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt || null,
    failures: run.failures.slice(-10),
    dailyStats,
  };
}

export function updateAutoRun(run, patch) {
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  autoRuns.set(run.runId, run);
  console.log(`[Auto ${run.runId}] [${run.progress || 0}%] ${run.message || run.status}`);
}

export function getLatestAutoRun() {
  const all = Array.from(autoRuns.values()).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return all[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE QUEUE (VISION_VERIFY_MODE=oracle) — antrean vonis frame oleh model besar
// di notebook Kaggle. Sisi lokal = PRODUSEN (enqueue + menunggu), sisi Kaggle =
// KLIEN (claim + submit). Semua operasi berbasis statement SET (bukan iterate()+
// write) karena koneksi yang sama tidak boleh dipakai menulis sambil cursor terbuka
// (pernah menjatuhkan boot — lihat komentar loadJobsFromDisk).
// ─────────────────────────────────────────────────────────────────────────────

const oracleSelect = db.prepare('SELECT * FROM vlm_oracle_batches WHERE id = ?');
const oracleInsert = db.prepare(`INSERT OR REPLACE INTO vlm_oracle_batches
  (id, job_id, scene_idx, status, attempts, created_at, claimed_at, completed_at, data)
  VALUES (@id, @jobId, @sceneIdx, @status, @attempts, @createdAt, @claimedAt, @completedAt, @data)`);

function toOracleBatch(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.data) || {}; } catch { payload = {}; }
  return {
    id: row.id,
    jobId: row.job_id,
    sceneIdx: row.scene_idx,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    frames: payload.frames || [],
    niche: payload.niche || '',
    facePolicy: payload.facePolicy || '',
    prompt: payload.prompt || '',
    worker: payload.worker || '',
    verdict: payload.verdict || null,
    lastError: payload.lastError || '',
  };
}

function saveOracleBatch(b, { now = Date.now() } = {}) {
  oracleInsert.run({
    id: b.id,
    jobId: b.jobId || '',
    sceneIdx: Number(b.sceneIdx) || 0,
    status: b.status || 'pending',
    attempts: Number(b.attempts) || 0,
    createdAt: Number(b.createdAt) || now,
    claimedAt: b.claimedAt ?? null,
    completedAt: b.completedAt ?? null,
    data: JSON.stringify({
      frames: b.frames || [], niche: b.niche || '', facePolicy: b.facePolicy || '',
      prompt: b.prompt || '', worker: b.worker || '', verdict: b.verdict ?? null,
      lastError: b.lastError || '',
    }),
  });
  return toOracleBatch(oracleSelect.get(b.id));
}

/** Daftar frame baru ke antrean oracle. Idempoten terhadap id (retry job memakai id sama). */
export function enqueueOracleBatch({ id, jobId, sceneIdx = 0, frames = [], niche = '', facePolicy = 'strict', prompt = '', now = Date.now() }) {
  if (!id) throw new Error('enqueueOracleBatch: id wajib ada');
  return saveOracleBatch({
    id, jobId, sceneIdx, status: 'pending', attempts: 0, createdAt: now,
    claimedAt: null, completedAt: null, frames, niche, facePolicy, prompt,
  }, { now });
}

export function getOracleBatch(id) {
  return toOracleBatch(oracleSelect.get(id));
}

/**
 * Klaim satu batch paling tua. Notebook yang mati di tengah jalan tidak membuat
 * batch hilang: 'claimed' yang melewati `staleMs` dikembalikan ke 'pending' sampai
 * `maxAttempts`, lalu ditandai 'expired' agar GPU tidak dibuang untuk batch yatim.
 */
export function claimOracleBatch({ workerId = '', staleMs = 300_000, maxAttempts = 2, now = Date.now() } = {}) {
  const cutoff = now - staleMs;
  db.prepare(`UPDATE vlm_oracle_batches SET status='expired'
    WHERE status='claimed' AND claimed_at < ? AND attempts >= ?`).run(cutoff, maxAttempts);
  db.prepare(`UPDATE vlm_oracle_batches SET status='pending', claimed_at=NULL
    WHERE status='claimed' AND claimed_at < ? AND attempts < ?`).run(cutoff, maxAttempts);

  const takeOne = db.transaction(() => {
    const row = db.prepare(`SELECT id FROM vlm_oracle_batches WHERE status='pending'
      ORDER BY created_at ASC LIMIT 1`).get();
    if (!row) return null;
    const changed = db.prepare(`UPDATE vlm_oracle_batches SET status='claimed', claimed_at=?, attempts=attempts+1
      WHERE id=? AND status='pending'`).run(now, row.id).changes;
    if (!changed) return null;
    if (workerId) {
      const b = toOracleBatch(oracleSelect.get(row.id));
      if (b) saveOracleBatch({ ...b, worker: String(workerId).slice(0, 120) }, { now });
    }
    return toOracleBatch(oracleSelect.get(row.id));
  });
  return takeOne();
}

/**
 * Notebook melaporkan vonis. Hanya menerima untuk batch 'claimed'/'pending' — hasil
 * yang datang setelah worker menyerah ('expired') sengaja DITOLAK agar worker yang
 * sudah lanjut tidak tiba-tiba punya vonis menggantung.
 */
export function submitOracleResult({ batchId, verdict, lastError = '', attempt, workerId, now = Date.now() } = {}) {
  const b = getOracleBatch(batchId);
  if (!b) return { ok: false, status: 'unknown' };
  
  if (workerId && b.workerId && b.workerId !== workerId) {
    return { ok: false, status: 'worker_mismatch', error: 'Result dari worker yang berbeda.' };
  }
  if (attempt !== undefined && b.attempts !== undefined && attempt !== b.attempts) {
    return { ok: false, status: 'attempt_mismatch', error: 'Result dari attempt yang sudah kadaluarsa.' };
  }
  if (b.status === 'done') return { ok: true, status: 'done', batch: b, duplicate: true };
  if (b.status === 'expired') return { ok: false, status: 'expired' };
  const updated = saveOracleBatch({
    ...b, status: 'done', completedAt: now, verdict: verdict ?? null,
    lastError: String(lastError || '').slice(0, 400),
  }, { now });
  return { ok: true, status: 'done', batch: updated };
}

/** Worker menyerah (timeout) -> batch tidak boleh diklaim lagi. 'done' tidak pernah ditimpa. */
export function expireOracleBatch(id, reason = '', { now = Date.now() } = {}) {
  const b = getOracleBatch(id);
  if (!b || b.status === 'done') return b;
  return saveOracleBatch({ ...b, status: 'expired', lastError: String(reason || '').slice(0, 400) }, { now });
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tunggu vonis satu batch. SELALU mengembalikan status akhir, tidak pernah melempar:
 * 'done' (verdict ada), 'expired' (worker/notebook menyerah), 'timeout' (deadline
 * lewat — pemanggil STRICT memperlakukannya sebagai JOB BERHENTI, bukan vonis bersih).
 * `lastStatus` = status batch PALING MAJU yang pernah terlihat saat polling
 * ('pending' = tidak pernah diklaim -> notebook offline; 'claimed' = diklaim tapi
 * vonis tidak pernah tiba). Pemanggil butuh ini untuk membedakan reason 'never_claimed'
 * vs 'no_verdict' pada OracleUnavailableError.
 */
export async function waitForOracleVerdict(id, { timeoutMs = 180_000, pollMs = 2_000, sleep = sleepDefault, now = () => Date.now() } = {}) {
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  const RANK = { pending: 0, claimed: 1, done: 2, expired: 1, unknown: -1 };
  let lastStatus = 'unknown';
  const observe = (status) => {
    if ((RANK[status] ?? -1) > (RANK[lastStatus] ?? -1)) lastStatus = status;
    return lastStatus;
  };
  for (;;) {
    const b = getOracleBatch(id);
    if (!b) return { status: 'unknown', lastStatus, batch: null };
    observe(b.status);
    if (b.status === 'done') return { status: 'done', lastStatus, batch: b, verdict: b.verdict, error: b.lastError };
    if (b.status === 'expired') return { status: 'expired', lastStatus, batch: b };
    if (now() >= deadline) return { status: 'timeout', lastStatus, batch: b };
    await sleep(Math.min(pollMs, Math.max(50, deadline - now())));
  }
}

/**
 * Untuk idle-exit NOTEBOOK Kaggle: apakah masih ada job lokal yang mungkin segera
 * mengantri batch vonis? Antrean KOSONG bukan berarti tidak ada kerja - di antara
 * pre-flight -> pool -> render -> audit klip ada jeda menit-jam (unduh+render di
 * Termux) ketika antrean memang kosong. 'Sibuk' = stage tidak terminal DAN sempat
 * disentuh dalam window (patchJob selalu menulis updatedAt; baris tanpa timestamp
 * dianggap sibuk secara konservatif - lebih baik sesi notebook bertahan 1 jam lagi
 * daripada kernelnya membunuh audit klip yang akan datang). Memo 10 detik: dipakai
 * di respons poll kosong yang bisa tiap 5 detik; parsing seluruh tabel job per-poll
 * tidak perlu.
 */
let busyJobsCache = { at: 0, n: -1 };
export function countBusyOracleJobs({ now = Date.now(), windowMs = 3_600_000 } = {}) {
  if (now - busyJobsCache.at < 10_000 && busyJobsCache.n >= 0) return busyJobsCache.n;
  let n = 0;
  for (const row of db.prepare('SELECT data FROM jobs').iterate()) {
    let job = null;
    try { job = JSON.parse(row.data); } catch { continue; }
    if (!job || TERMINAL_STAGES.has(job.stage)) continue;
    const touched = Date.parse(job.updatedAt || job.lastUpdated || '');
    if (Number.isFinite(touched) && now - touched > windowMs) continue;
    n += 1;
  }
  busyJobsCache = { at: now, n };
  return n;
}

export function oracleQueueStats({ now = Date.now() } = {}) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM vlm_oracle_batches GROUP BY status').all();
  const counts = { pending: 0, claimed: 0, done: 0, expired: 0 };
  const oldest = {};
  for (const r of rows) { counts[r.status] = r.n; oldest[r.status] = r.oldest; }
  return {
    counts,
    oldestPendingAgeMs: oldest.pending ? Math.max(0, now - oldest.pending) : null,
    lastSeenAt: oracleLastSeenMs(),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEARTBEAT NOTEBOOK — dipanggil dari endpoint claim setiap kali notebook bertanya.
// ─────────────────────────────────────────────────────────────────────────────
const heartbeatUpsert = db.prepare(`INSERT INTO oracle_heartbeat (worker_id, last_seen_at)
  VALUES (?, ?) ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`);
// DI-PREPARE SEKALI di module scope: endpoint claim memanggil jalur ini SETIAP polling
// (~2 detik) — db.prepare per panggilan = parsing SQL sia-sia di Termux.
const heartbeatSeenSelect = db.prepare('SELECT MAX(last_seen_at) AS seen FROM oracle_heartbeat');
const claimedSeenSelect = db.prepare('SELECT MAX(claimed_at) AS seen FROM vlm_oracle_batches');

/** Catat "notebook ini masih hidup". Idempoten; tidak pernah melempar untuk kesalahan sepele. */

// In-memory cache for protocol and hash
let inMemoryOracleInfo = { workerId: '', protocolVersion: '', sourceHash: '' };
export function oracleHeartbeatInfo() {
  return inMemoryOracleInfo;
}
export function touchOracleHeartbeat(workerId = 'kaggle', protocolVersion = '', sourceHash = '', now = Date.now()) {
  const id = String(workerId || 'kaggle').slice(0, 120) || 'kaggle';
  heartbeatUpsert.run(id, now);
  inMemoryOracleInfo = { workerId: id, protocolVersion: String(protocolVersion || ''), sourceHash: String(sourceHash || '') };
  return { workerId: id, lastSeenAt: now };
}

/** Kapan terakhir KALI ada notebook memanggil API (null = belum pernah). */
export function oracleLastSeenMs() {
  const row = heartbeatSeenSelect.get();
  if (row && row.seen) return row.seen;
  // Fallback untuk instalasi sebelum tabel heartbeat ada: klaim batch tertua yang tercatat.
  const claimed = claimedSeenSelect.get();
  return claimed && claimed.seen ? claimed.seen : null;
}

/** Bersihkan jejak batch lama (dipanggil dari endpoint status/CRON lokal; anti DB membengkak). */
export function pruneOracleBatches({ keepMs = 24 * 3600_000, now = Date.now() } = {}) {
  const res = db.prepare('DELETE FROM vlm_oracle_batches WHERE status IN (\'done\',\'expired\') AND COALESCE(completed_at, created_at) < ?')
    .run(now - keepMs);
  return res.changes;
}

// ---------------------------------------------------------------------------
// PEMAKAIAN AI (ai_usage_events). Semua pembacaan di bawah bersifat ADAPTIF:
// tidak ada satu kolom pun yang boleh membuat pemanggil melempar kalau barisnya
// kosong, karena pencatatan ini selalu berada di jalur samping (di dalam catch,
// di dalam pembungkus fetch) dan tidak pernah boleh menjatuhkan job.
// ---------------------------------------------------------------------------

const aiUsageInsert = db.prepare(`
  INSERT INTO ai_usage_events (
    job_id, site, provider, model, input_kind,
    prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost,
    request_bytes, response_bytes, media_count, duration_ms,
    ok, error_code, note, created_at
  ) VALUES (
    @jobId, @site, @provider, @model, @inputKind,
    @promptTokens, @completionTokens, @totalTokens, @cachedTokens, @cost,
    @requestBytes, @responseBytes, @mediaCount, @durationMs,
    @ok, @errorCode, @note, @createdAt
  )
`);

const clampInt = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n));
};

/** Simpan satu kejadian pemakaian AI. Mengembalikan rowid, atau null bila input rusak. */
export function recordAiUsage(row = {}, { now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  try {
    const res = aiUsageInsert.run({
      jobId: String(row.jobId || '').slice(0, 120),
      site: String(row.site || 'unknown').slice(0, 80),
      provider: String(row.provider || '').slice(0, 40),
      model: String(row.model || '').slice(0, 80),
      inputKind: String(row.inputKind || '').slice(0, 60),
      promptTokens: clampInt(row.promptTokens, 1e12),
      completionTokens: clampInt(row.completionTokens, 1e12),
      totalTokens: clampInt(row.totalTokens, 1e12),
      cachedTokens: clampInt(row.cachedTokens, 1e12),
      cost: Number(row.cost) > 0 ? Number(row.cost) : 0,
      requestBytes: clampInt(row.requestBytes, 1e12),
      responseBytes: clampInt(row.responseBytes, 1e12),
      mediaCount: clampInt(row.mediaCount, 1e6),
      durationMs: clampInt(row.durationMs, 1e9),
      // `ok` tidak boleh ditulis `row.ok === false ? 0 : 1`: aiUsageService sudah
      // menormalkan nilainya jadi angka, dan 0 !== false sehingga SEMUA panggilan
      // gagal akan tersimpan sebagai berhasil. Hanya false/0/'0'/'' yang berarti gagal;
      // undefined/null berarti "panggilan biasa" = berhasil.
      ok: row.ok === undefined || row.ok === null ? 1 : (row.ok === false || row.ok === 0 || row.ok === '0' || row.ok === '' ? 0 : 1),
      errorCode: String(row.errorCode || '').slice(0, 120),
      note: String(row.note || '').slice(0, 200),
      createdAt: now,
    });
    return Number(res.lastInsertRowid) || null;
  } catch {
    // Tabel belum ada (DB lama yang belum pernah dibuka sejak perubahan ini) atau
    // disk penuh. Pemanggil TIDAK boleh ikut gagal karena statistik.
    return null;
  }
}

const aiUsageListStmt = db.prepare(`
  SELECT id, job_id, site, provider, model, input_kind,
         prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost,
         request_bytes, response_bytes, media_count, duration_ms,
         ok, error_code, note, created_at
  FROM ai_usage_events
  WHERE (@jobId = '' OR job_id = @jobId)
  ORDER BY created_at DESC, id DESC
  LIMIT @limit
`);

/** Riwayat mentah per job (jobId kosong = seluruh waktu), terbaru lebih dulu. */
export function listAiUsage({ jobId = '', limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(2000, Number(limit) || 200));
  return aiUsageListStmt.all({ jobId: String(jobId || ''), limit: cap }).map((r) => ({
    id: r.id, jobId: r.job_id, site: r.site, provider: r.provider, model: r.model,
    inputKind: r.input_kind, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens, cachedTokens: r.cached_tokens, cost: r.cost,
    requestBytes: r.request_bytes, responseBytes: r.response_bytes, mediaCount: r.media_count,
    durationMs: r.duration_ms, ok: r.ok === 1, errorCode: r.error_code, note: r.note,
    createdAt: r.created_at,
  }));
}

/**
 * Ikhtisar yang menjawab pertanyaan sebenarnya: PANGGILAN MANA yang membakar token.
 * Grup per (site, model). `distinctJobs` dihitung dari job_id non-kosong supaya
 * angka "token per klip" bisa diturunkan di pemanggil tanpa menebak jumlah job.
 */
export function summarizeAiUsage({ jobId = '', sinceMs = 0, now = Date.now() } = {}) {
  const since = Number(sinceMs) > 0 ? now - Number(sinceMs) : 0;
  const rows = db.prepare(`
    SELECT site, provider, model,
           COUNT(*) AS calls,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS okCalls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failedCalls,
           SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
           SUM(total_tokens) AS totalTokens, SUM(cached_tokens) AS cachedTokens,
           SUM(cost) AS cost, SUM(request_bytes) AS requestBytes, SUM(response_bytes) AS responseBytes,
           SUM(media_count) AS mediaCount, MAX(duration_ms) AS maxDurationMs,
           COUNT(DISTINCT CASE WHEN job_id <> '' THEN job_id END) AS distinctJobs
    FROM ai_usage_events
    WHERE (@jobId = '' OR job_id = @jobId) AND (@since = 0 OR created_at >= @since)
    GROUP BY site, provider, model
    ORDER BY totalTokens DESC, calls DESC
  `).all({ jobId: String(jobId || ''), since });
  const totals = rows.reduce((acc, r) => {
    acc.calls += r.calls; acc.okCalls += r.okCalls; acc.failedCalls += r.failedCalls;
    acc.promptTokens += r.promptTokens || 0; acc.completionTokens += r.completionTokens || 0;
    acc.totalTokens += r.totalTokens || 0; acc.cost += r.cost || 0;
    acc.requestBytes += r.requestBytes || 0; acc.responseBytes += r.responseBytes || 0;
    return acc;
  }, { calls: 0, okCalls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestBytes: 0, responseBytes: 0 });
  // distinctJobs TIDAK bisa dijumlahkan dari per-group (satu job muncul di banyak
  // situs), jadi dihitung sekali pada seluruh jendela. Angka inilah yang dipakai
  // pemanggil untuk menurunkan "token per job".
  const distinctJobs = db.prepare(`
    SELECT COUNT(DISTINCT job_id) AS n FROM ai_usage_events
    WHERE job_id <> '' AND (@jobId = '' OR job_id = @jobId) AND (@since = 0 OR created_at >= @since)
  `).get({ jobId: String(jobId || ''), since }).n || 0;
  return {
    windowSince: since || null,
    totals: { ...totals, distinctJobs, avgTokensPerCall: totals.calls ? Math.round(totals.totalTokens / totals.calls) : 0 },
    bySite: rows.map((r) => ({
      site: r.site, provider: r.provider, model: r.model,
      calls: r.calls, okCalls: r.okCalls, failedCalls: r.failedCalls,
      promptTokens: r.promptTokens || 0, completionTokens: r.completionTokens || 0,
      totalTokens: r.totalTokens || 0, cachedTokens: r.cachedTokens || 0, cost: r.cost || 0,
      requestBytes: r.requestBytes || 0, responseBytes: r.responseBytes || 0,
      mediaCount: r.mediaCount || 0, maxDurationMs: r.maxDurationMs || 0, distinctJobs: r.distinctJobs || 0,
      avgTokensPerCall: r.calls ? Math.round((r.totalTokens || 0) / r.calls) : 0,
    })),
  };
}

/** Panggilan termahal untuk satu job — dipakai UI/log untuk menunjukkan biang token. */
export function topAiUsageSitesForJob(jobId, limit = 5) {
  return summarizeAiUsage({ jobId }).bySite.slice(0, Math.max(1, Number(limit) || 5));
}

/**
 * PENYEBUT untuk angka "token per klip jadi" (Lapis 1). Dipisah dari summarizeAiUsage
 * karena datanya ada di tabel `jobs` (JSON), bukan di tabel pemakaian.
 *
 * Definisi klip jadi yang dipakai di sini SENGAJA ketat: stage='completed' DAN ada
 * bukti nama file keluaran (`finalFileName` atau `silentFileName`). Alasan: `completed`
 * saja bisa ditinggalkan oleh jalur yang menandai selesai tanpa video (mis. perbaikan
 * meta), dan angka itulah yang akan membagi token Anda — penyebut yang terlalu besar
 * membuat biaya per klip tampak murah.
 *
 * Waktu job diambil dari `updatedAt` (diisi patchJob) lalu `createdAt`. Keduanya string
 * ISO, jadi harus di-Date.parse; job tanpa keduanya TIDAK dihitung dalam jendela apa pun
 * (lebih jujur memasukkan 0 daripada menebak).
 *
 * @returns {{clips: number, totalJobs: number, unfinished: number, since: number|null}}
 */
export function countCompletedClips({ sinceMs = 0, now = Date.now() } = {}) {
  const since = Number(sinceMs) > 0 ? now - Number(sinceMs) : 0;
  let clips = 0;
  let totalJobs = 0;
  let unfinished = 0;
  try {
    for (const row of db.prepare('SELECT data FROM jobs').iterate()) {
      let job = null;
      try { job = JSON.parse(row.data); } catch { job = null; }
      if (!job || typeof job !== 'object') continue;
      totalJobs += 1;
      // "Belum selesai" = stage apa pun di luar TERMINAL_STAGES, termasuk job tanpa
      // stage. Ia dihitung terpisah karena KOMPASNYA sama dengan catatan jujur di
      // pemanggil: token job yang belum selesai masuk pembilang tapi klipnya tidak
      // pernah masuk penyebut.
      if (!TERMINAL_STAGES.has(job.stage)) unfinished += 1;
      if (job.stage !== 'completed') continue;
      if (!job.finalFileName && !job.silentFileName) continue;
      const stamp = Date.parse(job.updatedAt || job.createdAt || '') || 0;
      if (since && stamp && stamp < since) continue;
      clips += 1;
    }
  } catch {
    // Tabel `jobs` belum terbaca (DB rusak / sedang dipakai) -> kembalikan nol supaya
    // rute statistik menampilkan "tidak cukup data", bukan 500.
    return { clips: 0, totalJobs, unfinished, since: since || null };
  }
  return { clips, totalJobs, unfinished, since: since || null };
}

/** Batasi pertumbuhan tabel: panggilan AI bisa ribuan per hari di auto-run. */
export function pruneAiUsageEvents({ keepMs = 30 * 24 * 3600_000, now = Date.now() } = {}) {
  try {
    return db.prepare('DELETE FROM ai_usage_events WHERE created_at < ?').run(now - keepMs).changes;
  } catch {
    return 0;
  }
}
