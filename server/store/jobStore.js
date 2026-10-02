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
