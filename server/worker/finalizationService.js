import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { extractFrames } from '../services/frameExtractor.js';
export async function conformExistingJobEditToAudio({
  job,
  silentPath,
  audioPath,
  script,
  onProgress = () => {},
}

export async function runProfessionalFinalQcWithRepair({
  jobId,
  finalOutputPath,
  silentVideoPath,
  voiceoverAudioPath,
  srtPath,
  expectedDurationSec,
  productTitle,
  productFingerprint,
  aiProvider,
  apiKey,
  niche = 'kitchen_tools',
  renderSourcePath = '',
  clips = [],
  hflip = false,
  reframe = {},
  backgroundMusicPath = '',
  musicVolume = 0.10,
  sfxEvents = [],
  onProgress = () => {},
}

export function syncVideoToAndroidStorage(finalOutputPath, finalFileName, projectName = 'clipper') {
  if (process.platform !== 'android' && process.platform !== 'linux') return;
  if (!finalOutputPath || !fs.existsSync(finalOutputPath)) return;

  const candidateDirs = [
    path.join('/storage/emulated/0/MyProject', projectName),
    path.join(process.env.HOME || '', 'storage', 'shared', 'MyProject', projectName),
    path.join('/sdcard/MyProject', projectName),
    path.join('/storage/emulated/0/MyProject'),
    path.join(process.env.HOME || '', 'storage', 'shared', 'MyProject'),
    path.join('/sdcard/MyProject'),
  ];

  for (const dir of candidateDirs) {
    try {
      const parent = path.dirname(dir);
      if (fs.existsSync(parent) || fs.existsSync(dir)) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const targetPath = path.join(dir, finalFileName);
        fs.copyFileSync(finalOutputPath, targetPath);
        console.log(`[Android Sync] ✅ Video final otomatis disalin ke MyProject HP: ${targetPath}`);
        return targetPath;
      }
    } catch (err) {
      // Continue to next candidate
    }
  }
}

async function _processJobVoiceover(jobId, customScript = null, options = {}

export function processJobVoiceover(jobId, customScript, options) {
  return heavyTaskQueue(() => _processJobVoiceover(jobId, customScript, options));
}

