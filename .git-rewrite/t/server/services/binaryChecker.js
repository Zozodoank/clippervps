import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';
import YTDlpWrap from 'yt-dlp-wrap';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binDir = path.join(__dirname, '..', 'bin');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// 1. Resolve FFmpeg executable path
export function getFFmpegPath() {
  // Check if system ffmpeg exists
  try {
    const sysFfmpeg = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const output = execSync(sysFfmpeg, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (output) {
      const firstPath = output.split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstPath)) {
        return firstPath;
      }
    }
  } catch (err) {
    // Not in PATH, fallback to ffmpeg-static
  }

  // Fallback to ffmpeg-static npm package binary
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }

  // Check local bin directory
  const localBinFfmpeg = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localBinFfmpeg)) {
    return localBinFfmpeg;
  }

  return 'ffmpeg';
}

// 2. Resolve yt-dlp executable path & auto-download if missing
export async function getYtDlpPath(onProgress = null) {
  // Check if system yt-dlp exists
  try {
    const sysYtDlp = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    const output = execSync(sysYtDlp, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (output) {
      const firstPath = output.split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstPath)) {
        return firstPath;
      }
    }
  } catch (err) {
    // Not in PATH, check local bin
  }

  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBinaryPath = path.join(binDir, binaryName);

  if (fs.existsSync(localBinaryPath)) {
    try {
      const stats = fs.statSync(localBinaryPath);
      if (stats.size > 15000000) {
        return localBinaryPath;
      }
      console.warn(`[BinaryChecker] Existing yt-dlp binary is incomplete (${stats.size} bytes). Re-downloading...`);
      fs.unlinkSync(localBinaryPath);
    } catch {
      return localBinaryPath;
    }
  }

  // Auto-download yt-dlp binary if missing
  console.log(`[BinaryChecker] yt-dlp not found. Auto-downloading binary to ${localBinaryPath}...`);
  if (onProgress) onProgress('Downloading yt-dlp binary engine for first-time setup...');

  try {
    const YTDlpWrapClass = YTDlpWrap.default?.downloadFromGithub ? YTDlpWrap.default : (YTDlpWrap.downloadFromGithub ? YTDlpWrap : (YTDlpWrap.default?.default || YTDlpWrap));
    await YTDlpWrapClass.downloadFromGithub(localBinaryPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(localBinaryPath, '755');
    }
    console.log(`[BinaryChecker] yt-dlp successfully downloaded to ${localBinaryPath}`);
    return localBinaryPath;
  } catch (error) {
    console.error(`[BinaryChecker] Failed to auto-download yt-dlp: ${error.message}`);
    // Return localBinaryPath anyway or fallback name
    return localBinaryPath;
  }
}

export async function checkSystemDependencies() {
  const ffmpeg = getFFmpegPath();
  const ytdlp = await getYtDlpPath();

  return {
    ffmpeg: {
      path: ffmpeg,
      available: fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg',
    },
    ytdlp: {
      path: ytdlp,
      available: fs.existsSync(ytdlp) || ytdlp === 'yt-dlp',
    },
  };
}
