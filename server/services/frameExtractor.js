import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getFFmpegPath } from './binaryChecker.js';

/**
 * Extracts timeline frames from a video and converts selected keyframes to base64.
 * @param {string} videoPath - Path to the local raw mp4 file
 * @param {string} videoPath - Path to the local raw mp4 file
 * @param {string} framesDir - Directory to store extracted JPEG frames
 * @param {Function} onProgress - Progress status callback
 * @returns {Promise<{ frames: Array<{ index: number, timestamp: number, timeFormatted: string, base64: string }>, totalFrames: number, framesDir: string }>}
 */
export async function extractFrames(videoPath, framesDir, onProgress = () => {}, {
  sampleIntervalSec = 1,
  maxSampleFrames = 30,
  duration = null,
} = {}) {
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const ffmpegPath = getFFmpegPath();
  const outputPattern = path.join(framesDir, 'frame_%04d.jpg');

  // Guard against audio-only input path
  let targetVideoPath = videoPath;
  const isAudioFile = ['.m4a', '.mp3', '.aac', '.wav', '.opus'].some(ext => videoPath.toLowerCase().endsWith(ext));
  if (isAudioFile || !fs.existsSync(videoPath)) {
    const parentDir = path.dirname(videoPath);
    if (fs.existsSync(parentDir)) {
      const candidates = fs.readdirSync(parentDir).filter(f =>
        (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv') || f.endsWith('.mov')) &&
        !f.startsWith('silent_') && !f.startsWith('final_')
      );
      if (candidates.length > 0) {
        targetVideoPath = path.join(parentDir, candidates[0]);
        console.log(`[FrameExtractor] Auto-resolved video input to: ${targetVideoPath}`);
      }
    }
  }

  const safeMaxFrames = Math.max(1, Math.floor(Number(maxSampleFrames) || 30));
  let safeInterval = Number(sampleIntervalSec);
  if (!safeInterval || isNaN(safeInterval)) {
    if (duration && Number(duration) > 0) {
      safeInterval = Math.max(1, Math.floor(Number(duration) / safeMaxFrames));
    } else {
      safeInterval = 1;
    }
  } else {
    safeInterval = Math.max(0.5, safeInterval);
  }
  onProgress({ step: 'frames', message: `Extracting source timeline frames (1 frame every ${safeInterval}s)...`, progress: 40 });

  return new Promise((resolve, reject) => {
    // Crop exactly to 9:16 center slice, then scale to 202x360 (which is exactly 9:16 at 360p height)
    const args = [
      '-y',
      '-i', targetVideoPath,
      '-vf', `fps=1/${safeInterval},crop='min(iw,ih*45/64)':'min(ih,iw*64/45)',scale=-2:360`,
      '-q:v', '3',
      outputPattern
    ];

    console.log(`[FrameExtractor] Spawning FFmpeg: ${ffmpegPath} ${args.join(' ')}`);
    const proc = spawn(ffmpegPath, args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg frame extraction failed with code ${code}: ${stderr}`));
      }

      onProgress({ step: 'frames', message: 'Encoding extracted frames to Base64...', progress: 48 });

      // Read extracted frame files
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
        .sort();

      if (frameFiles.length === 0) {
        return reject(new Error('No frames were extracted from the video.'));
      }

      // Preserve a dense timeline for 5-second clip planning, while keeping the vision request bounded.
      let sampledFiles = [];

      if (frameFiles.length <= safeMaxFrames) {
        sampledFiles = frameFiles;
      } else {
        const step = safeMaxFrames === 1 ? 0 : (frameFiles.length - 1) / (safeMaxFrames - 1);
        for (let i = 0; i < safeMaxFrames; i++) {
          const index = Math.round(i * step);
          if (index < frameFiles.length && !sampledFiles.includes(frameFiles[index])) {
            sampledFiles.push(frameFiles[index]);
          }
        }
      }

      const frames = [];

      for (let i = 0; i < sampledFiles.length; i++) {
        const filename = sampledFiles[i];
        const filePath = path.join(framesDir, filename);

        // Frame index in 1-based order. The filename maps back to the source timeline.
        const frameNumber = parseInt(filename.replace('frame_', '').replace('.png', '').replace('.jpg', ''), 10);
        const timestampInSeconds = Math.max(0, (frameNumber - 1) * safeInterval);

        const mins = Math.floor(timestampInSeconds / 60).toString().padStart(2, '0');
        const secs = Math.floor(timestampInSeconds % 60).toString().padStart(2, '0');
        const timeFormatted = `${mins}:${secs}`;

        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');
        const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        frames.push({
          index: i + 1,
          frameNumber,
          timestamp: timestampInSeconds,
          timeFormatted,
          base64: dataUrl,
          filePath,
        });
      }

      onProgress({ step: 'frames', message: `Successfully prepared ${frames.length} key visual frames for AI vision analysis.`, progress: 50 });

      resolve({
        frames,
        totalExtracted: frameFiles.length,
        sampledCount: frames.length,
        framesDir,
      });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg for frame extraction: ${err.message}`));
    });
  });
}
