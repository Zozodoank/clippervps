import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jobsFilePath = path.join(__dirname, 'jobs.json');
const tempDir = path.join(__dirname, 'temp');
const outputDir = path.join(__dirname, 'output');

console.log('🧹 Memulai pembersihan job gagal di Codespace...');

let deletedJobsCount = 0;
let validJobsCount = 0;

if (fs.existsSync(jobsFilePath)) {
  try {
    const jobs = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
    for (const [jobId, jobData] of Object.entries(jobs)) {
      const isFailed = jobData.stage === 'error' || Boolean(jobData.lastError) || (jobData.stage === 'running' && !jobData.silentLocalPath);
      if (isFailed) {
        delete jobs[jobId];
        deletedJobsCount++;
        
        // Hapus folder temp sesi jika ada
        const sessionDir = path.join(tempDir, `job_${jobId}`);
        if (fs.existsSync(sessionDir)) {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        }

        // Hapus file video gagal jika ada
        const silentPath = path.join(outputDir, `silent_clip_${jobId}.mp4`);
        if (fs.existsSync(silentPath) && isFailed) {
          try { fs.unlinkSync(silentPath); } catch (e) {}
        }
      } else {
        validJobsCount++;
      }
    }

    fs.writeFileSync(jobsFilePath, JSON.stringify(jobs, null, 2), 'utf-8');
    console.log(`✅ Berhasil menghapus ${deletedJobsCount} job gagal dari database jobs.json.`);
    console.log(`✨ Sisa job valid & sukses: ${validJobsCount}`);
  } catch (err) {
    console.warn('Gagal membaca jobs.json:', err.message);
  }
} else {
  console.log('File jobs.json belum ada atau sudah bersih.');
}

// Bersihkan seluruh folder sampah job_* di folder temp yang tidak termasuk job valid
let cleanedFolders = 0;
if (fs.existsSync(tempDir)) {
  let validJobIds = new Set();
  if (fs.existsSync(jobsFilePath)) {
    try {
      const jobs = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
      validJobIds = new Set(Object.keys(jobs));
    } catch {}
  }

  const entries = fs.readdirSync(tempDir);
  for (const entry of entries) {
    if (entry.startsWith('job_')) {
      const jobId = entry.replace('job_', '');
      if (!validJobIds.has(jobId)) {
        try {
          fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true });
          cleanedFolders++;
        } catch (e) {}
      }
    }
  }
  console.log(`🗑️ Berhasil menghapus ${cleanedFolders} folder sesi sampah di folder server/temp/.`);
}

console.log('🎉 Pembersihan tuntas! Disk Codespace kini bersih dan rapi.');
