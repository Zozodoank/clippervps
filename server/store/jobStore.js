import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

// Provider di-inject oleh server.js untuk mencegah circular dependency jobStore <-> server.js
let dailyStatsProvider = () => null;
export function setDailyStatsProvider(fn) {
  dailyStatsProvider = fn;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const jobsFilePath = path.join(__dirname, '..', 'jobs.db');

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

export const jobProgress = new Map();

// Legacy functions from JSON era (now no-ops or adapted)
export function atomicWriteJsonSync(filePath, data) {} 
export function persistJob(jobId, jobData) {
  activeJobs.set(jobId, jobData);
}
export function deletePersistedJob(jobId) {
  activeJobs.delete(jobId);
}

export function loadJobsFromDisk() {
  console.log(`[Jobs] SQLite Database initialized. Active jobs: ${activeJobs.size}`);
  // Reset stuck jobs
  for (const [jobId, jobData] of activeJobs.entries()) {
    if (jobData.stage === 'running') {
      jobData.stage = 'stopped';
      jobData.message = 'Proses dihentikan karena server di-restart.';
      activeJobs.set(jobId, jobData);
    }
  }
}

export function updateJobProgress(jobId, data) {
  const payload = typeof data === 'string'
    ? { step: 'processing', message: data, progress: 50, jobId, status: 'running' }
    : { status: 'running', ...data, jobId };
  jobProgress.set(jobId, payload);
  console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message || ''}`);
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
