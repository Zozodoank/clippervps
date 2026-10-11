import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { activeJobs } from '../store/jobStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, '..', 'output'); // server/output
// VPS-only mandate: TANPA batas harian secara default (unlimited). Batas hanya berlaku bila
// DAILY_VIDEO_LIMIT di-set ke angka > 0. 'unlimited'/0/kosong/nilai invalid = tanpa batas.
const DEFAULT_DAILY_VIDEO_LIMIT = Infinity;
export function getDailyOutputVideoLimit() {
  const raw = String(process.env.DAILY_VIDEO_LIMIT || '').trim().toLowerCase();
  if (raw === '' || raw === 'unlimited') return DEFAULT_DAILY_VIDEO_LIMIT;
  const envVal = parseInt(raw, 10);
  return (Number.isFinite(envVal) && envVal > 0) ? envVal : DEFAULT_DAILY_VIDEO_LIMIT;
}

/**
 * Hitung jumlah video output unik yang berhasil diproduksi hari ini (kalender lokal).
 * Saat mandate VPS-only aktif, batas harian = unlimited (limit tak hingga): isLimitReached
 * selalu false dan limit/remaining dinormalisasi ke null agar aman di-serialize ke JSON.
 */
export function getDailyOutputVideoStats() {
  const limit = getDailyOutputVideoLimit();
  const isUnlimited = !Number.isFinite(limit);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();

  const uniqueJobIdsToday = new Set();
  const completedVideosToday = [];

  // 1. Cek dari memory activeJobs (termasuk hasil load jobs.json)
  for (const [jobId, job] of activeJobs.entries()) {
    const isCompleted = job.stage === 'completed' || job.hasFinalVideo || (job.stage === 'stage1_completed' && job.hasSilentVideo);
    if (!isCompleted) continue;

    const timestampStr = job.completedAt || job.updatedAt || job.createdAt;
    const jobTime = timestampStr ? new Date(timestampStr).getTime() : 0;

    const filePath = job.finalLocalPath || job.silentLocalPath;
    const fileExists = filePath && fs.existsSync(filePath);

    if (fileExists && jobTime >= startOfDayMs) {
      uniqueJobIdsToday.add(jobId);
      completedVideosToday.push({
        jobId,
        productTitle: job.productTitle || jobId,
        time: new Date(jobTime).toISOString(),
        type: job.hasFinalVideo ? 'final' : 'silent',
      });
    }
  }

  // 2. Cross-check langsung ke file fisik di direktori output
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        if (!file.endsWith('.mp4')) continue;
        const match = file.match(/^(?:final|silent)_clip_(.+)\.mp4$/);
        if (match && match[1]) {
          const jobId = match[1];
          if (!uniqueJobIdsToday.has(jobId)) {
            try {
              const stat = fs.statSync(path.join(outputDir, file));
              if (stat.mtimeMs >= startOfDayMs) {
                uniqueJobIdsToday.add(jobId);
                completedVideosToday.push({
                  jobId,
                  productTitle: jobId,
                  time: stat.mtime.toISOString(),
                  type: file.startsWith('final') ? 'final' : 'silent',
                });
              }
            } catch {}
          }
        }
      }
    }
  } catch {}

  const count = uniqueJobIdsToday.size;
  const remaining = isUnlimited ? null : Math.max(0, limit - count);
  const isLimitReached = isUnlimited ? false : count >= limit;

  return {
    limit: isUnlimited ? null : limit,
    unlimited: isUnlimited,
    count,
    remaining,
    isLimitReached,
    date: startOfDay.toLocaleDateString('sv'), // YYYY-MM-DD
    resetAt: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    videos: completedVideosToday,
  };
}

