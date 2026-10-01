import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getYtDlpPath, getFFmpegPath } from './binaryChecker.js';

/**
 * Download preview video (center portion) at low resolution for quick validation.
 * @returns {{ filePath: string, sourceId: string, sourceStartSec: number, sourceEndSec: number, actualDurationSec: number, sourceDurationSec: number, hasAudio: boolean } | null}
 */
export async function downloadQuickPreview(url, outputDir, jobId, {
  onProgress = () => {},
  durationSec = 10,
  sourceDurationSec = null
} = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ytDlpPath = await getYtDlpPath();
  const ffmpegPath = getFFmpegPath();

  // 1. Get or use duration
  let videoDuration = sourceDurationSec;
  let videoId = jobId;
  
  if (!videoDuration || videoDuration <= 0) {
    onProgress({ step: 'quick_preview', message: 'Membaca metadata durasi untuk preview...', progress: 10 });
    try {
      const { execFile } = await import('child_process');
      const util = await import('util');
      const execFileAsync = util.promisify(execFile);
      const { stdout } = await execFileAsync(ytDlpPath, ['--js-runtimes', 'node', '--print', '%(id)s|%(duration)s', '--no-playlist', url]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.includes('|')) {
        const parts = lastLine.split('|');
        videoId = parts[0] || videoId;
        videoDuration = parseFloat(parts[1]) || 0;
      }
    } catch (err) {
      console.warn(`[QuickPreview] Gagal membaca durasi: ${err.message}`);
    }
  }

  // 2. Calculate center section
  const safeDur = videoDuration > 0 ? videoDuration : 60;
  const targetLength = Math.min(durationSec, safeDur);
  const startSec = Math.max(0, Math.floor((safeDur / 2) - (targetLength / 2)));
  const endSec = startSec + targetLength;

  const outFilename = `preview_${videoId}_${Date.now()}.mp4`;
  const outPath = path.join(outputDir, outFilename);

  onProgress({ step: 'quick_preview', message: `Mendownload preview ${targetLength} detik (${startSec}s - ${endSec}s)...`, progress: 12 });

  // 3. Download section with yt-dlp using lowest resolution with audio
  // We prefer 360p or lower, but must have audio.
  const dlArgs = [
    '--no-playlist',
    '--js-runtimes', 'node',
    '-f', 'best[height<=360][ext=mp4]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--download-sections', `*${startSec}-${endSec}`,
    '--force-keyframes-at-cuts',
    '-o', outPath,
    url
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, dlArgs);
    let finished = false;
    
    // We set a strict timeout for the preview (e.g., 60 seconds)
    const timeoutTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error('Download preview timeout'));
      }
    }, 300000);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        resolve({
          filePath: outPath,
          sourceId: videoId,
          sourceStartSec: startSec,
          sourceEndSec: endSec,
          actualDurationSec: targetLength,
          sourceDurationSec: videoDuration,
          hasAudio: true // We assume true for now, audioBeatService will confirm
        });
      } else {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        reject(new Error(`yt-dlp exited with code ${code} or file is empty.`));
      }
    });
    
    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });
}
