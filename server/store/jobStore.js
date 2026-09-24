import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDailyOutputVideoStats } from '../server.js'; // Needed by publicAutoRunState

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const jobsFilePath = path.join(__dirname, '..', 'jobs.json');

export const activeJobs = new Map();

export const jobProgress = new Map();

export const autoRuns = new Map();

export const autoRetryRuns = new Map();

export function sanitizeJobForDisk(job) {
  if (!job || typeof job !== 'object') return job;
  const clone = { ...job };
  delete clone.geminiApiKey;
  delete clone.apiKey;
  delete clone.openRouterApiKey;
  return clone;
}

export function atomicWriteJsonSync(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function loadJobsFromDisk() {
  try {
    if (fs.existsSync(jobsFilePath)) {
      const raw = fs.readFileSync(jobsFilePath, 'utf-8');
      const obj = JSON.parse(raw);
      let modified = false;
      for (const [jobId, jobData] of Object.entries(obj)) {
        if (jobData.geminiApiKey || jobData.apiKey || jobData.openRouterApiKey) {
          delete jobData.geminiApiKey;
          delete jobData.apiKey;
          delete jobData.openRouterApiKey;
          modified = true;
        }
        // Jangan hapus job apapun agar riwayat history pengguna tidak hilang!
        // Jika status masih 'running' saat server start, ubah menjadi 'stopped'
        if (jobData.stage === 'running') {
          jobData.stage = 'stopped';
          jobData.message = 'Proses dihentikan karena server di-restart.';
          modified = true;
        }
        activeJobs.set(jobId, jobData);
      }
      if (modified) {
        atomicWriteJsonSync(jobsFilePath, obj);
      }
      console.log(`[Jobs] Loaded ${activeJobs.size} persisted job(s) from disk.`);
    }
  } catch (err) {
    console.warn('[Jobs] Could not load jobs.json:', err.message);
  }
}

export function persistJob(jobId, jobData) {
  try {
    let existing = {};
    if (fs.existsSync(jobsFilePath)) {
      existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
    }
    const cleanJob = sanitizeJobForDisk(jobData);
    existing[jobId] = {
      ...cleanJob,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJsonSync(jobsFilePath, existing);
  } catch (err) {
    console.warn(`[Jobs] Could not persist job ${jobId}:`, err.message);
  }
}

export function deletePersistedJob(jobId) {
  try {
    if (fs.existsSync(jobsFilePath)) {
      const existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
      delete existing[jobId];
      atomicWriteJsonSync(jobsFilePath, existing);
    }
  } catch (err) {
    console.warn(`[Jobs] Could not delete job ${jobId} from disk:`, err.message);
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
  const dailyStats = getDailyOutputVideoStats();
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

