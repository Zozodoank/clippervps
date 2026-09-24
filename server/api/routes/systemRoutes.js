import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import multer from 'multer';
import { exec, spawn, execSync } from 'child_process';

import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId, isLocalPortListening } from '../services/downloader.js';
import { extractFrames } from '../services/frameExtractor.js';
import {
  selectHighlightWithAI,
  analyzeYouTubeVideoWithGemini,
  analyzeMultipleYouTubeVideosWithGemini,
  getDirectGeminiApiKey,
  generateAdAdvisorScriptWithAI,
  detectPhoneticLexiconWithAI,
  formatEnrichedCaption,
  formatSeconds,
  getDynamicProductHookFallback,
  verifyProductCandidateWithAI,
  verifyFinalRenderedFramesWithAI
} from '../services/aiService.js';
import { generateSrtSubtitles } from '../services/subtitleService.js';
import { loadEnglishDictionary, saveToEnglishDictionary } from '../services/dictionaryService.js';
import {
  renderSilentAntiDetectionVideo,
  mergeVoiceoverAndBurnSubtitles,
  getMediaDurationSec,
  getVideoDimensions
} from '../services/videoRenderer.js';
import {
  generateVoiceoverTTS,
  cleanScriptForTTS,
  GEMINI_TTS_VOICES,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
  DEFAULT_GEMINI_TTS_VOICE
} from '../services/ttsService.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  sampleFramesFromStream,
  inspectFramesLocally,
  filterCandidateFramesPerFrame,
  poolMultiCandidateFrames,
  callAIGatekeeperMicroservice,
  sampleDenseClustersAroundCleanFrames
} from '../services/videoFilterService.js';
import {
  getPublicIpAddress,
  classifyPipelineError,
  checkYouTubeHealth
} from '../services/networkDiagnosticService.js';
import {
  getBandwidthStats,
  resetBandwidthStats,
  trackSavedBandwidth
} from '../services/bandwidthTracker.js';
import {
  cleanupTempFiles,
  deleteJobTempDirectory,
  deleteJobFiles
} from '../services/cleaner.js';
import {
  discoverShopeeProducts,
  discoverBrandedShopeeProduct,
  discoverSingleShopeeProduct,
  discoverYouTubeCandidatesForProduct,
  searchMultiEngineVideos,
  searchBingVideos,
  searchVideosByProductImage,
  fetchShopeePageMeta,
  isShopeeProductUrl,
  findMatchingShopeeProductUrl,
  buildShopeeSearchUrl,
  extractShopeeLinkFromText,
  DEFAULT_AUTO_KEYWORDS,
  getAutoKeywords,
  extractCoreProductInfo,
  cleanTitle,
  normalizeText,
  isBulkyOrUnsuitableProduct,
  markKeywordAsUsed,
  loadUsedKeywords,
  isKeywordUsed,
  isProductTitleUsed,
  getUsedKeywordsStats,
  clearUsedKeywords
} from '../services/discoveryService.js';
import { getAllNiches, getNichePreset } from '../config/nichePresets.js';
import {
  buildProductFingerprint,
  buildCreativeShotPlan,
  describeCreativePlan,
  conformClipsToVoiceover,
  choosePreferredCandidateSet
} from '../services/professionalPipelineService.js';
import { runFinalMasterQc } from '../services/finalMasterQcService.js';
import { jobsFilePath, activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, publicAutoRetryState, publicAutoRunState, updateAutoRun, getLatestAutoRun } from '../store/jobStore.js';
import { loadedEnvFiles, cleanEnvValue, isPlaceholderEnvValue, reloadEnvironment } from '../utils/envLoader.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { isValidHttpUrl, resolveOutputVideoPath, isVideoFilePath, isQuotaErrorMessage, sanitizeCaptionText } from '../utils/jobHelpers.js';
import { runStage1Pipeline, runAutoStage1Worker, runAutoRetryWorker, conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage, processJobVoiceover } from '../worker/pipelineWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global crash guards to keep the server resilient against transient background socket/stream interruptions
process.on('uncaughtException', (err) => {
  console.error('⚠️ [UncaughtException Guard]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [UnhandledRejection Guard]:', reason?.message || reason);
});

// Load .env from multiple candidate paths. Keep server/.env as the primary
// Termux/local source, but still accept root-level .env files for portability.
const envCandidates = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '.env.txt'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '.env.txt'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '.env.txt')
];

const PLACEHOLDER_ENV_VALUES = new Set([
  '',
  'your_gemini_api_key_here',
  'your_aivene_api_key_here',
  'your_cobalt_api_key_here',
]);







// Directories
const tempDir = path.join(__dirname, 'temp');
const outputDir = path.join(__dirname, 'output');
const uploadsDir = path.join(tempDir, 'uploads');
const rejectedYunetDir = path.join(__dirname, 'rejected_frames', 'yunet');

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(rejectedYunetDir)) fs.mkdirSync(rejectedYunetDir, { recursive: true });

// Multer storage for uploaded voiceover audio
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `voiceover_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus']);
    const mime = String(file.mimetype || '').toLowerCase();
    if (allowedExts.has(ext) || mime.startsWith('audio/')) return cb(null, true);
    cb(new Error('File voiceover harus berupa audio (.mp3, .wav, .m4a, .aac, .ogg, .opus).'));
  },
});

const router = express.Router();

// 1. Health check & dependency verification
router.get('/health', async (req, res) => {
  const envFiles = reloadEnvironment();
  const rawOpenRouterKey = (
    process.env.OPENROUTER_API_KEY || ''
  ).trim().replace(/^["']|["']$/g, '');
  const openRouterKeySet = Boolean(rawOpenRouterKey && !rawOpenRouterKey.startsWith('your_') && !rawOpenRouterKey.endsWith('_here'));

  const rawGeminiKey = (
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
  ).trim().replace(/^["']|["']$/g, '');
  const geminiKeySet = Boolean(rawGeminiKey && !rawGeminiKey.startsWith('your_') && !rawGeminiKey.endsWith('_here'));

  const envActive = (process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
  let activeAiEngine = 'gemini';
  if (envActive === 'openrouter' && openRouterKeySet) {
    activeAiEngine = 'openrouter';
  } else if (geminiKeySet) {
    activeAiEngine = 'gemini';
  } else if (openRouterKeySet) {
    activeAiEngine = 'openrouter';
  } else {
    activeAiEngine = 'gemini';
  }

  const binaryCheck = await checkSystemDependencies();

  res.json({
    status: 'ok',
    serverTime: new Date().toISOString(),
    ffmpeg: binaryCheck.ffmpeg,
    ytdlp: binaryCheck.ytdlp,
    dependencies: {
      ffmpeg: binaryCheck.ffmpeg,
      ytdlp: binaryCheck.ytdlp,
    },
    openRouterKeyConfigured: openRouterKeySet,
    geminiKeyConfigured: geminiKeySet,
    geminiFallbackConfigured: geminiKeySet,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    geminiFileApiConfigured: geminiKeySet,
    activeAiEngine,
    defaultAiProvider: activeAiEngine !== 'none' ? activeAiEngine : 'gemini',
    tts: {
      available: true,
      provider: process.env.TTS_PROVIDER || 'gemini_tts',
      model: process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL,
      fallbackModel: process.env.GEMINI_TTS_FALLBACK_MODEL || DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
      voice: process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE,
      voices: GEMINI_TTS_VOICES,
      defaultVoice: (process.env.TTS_PROVIDER || 'gemini_tts') === 'gemini_tts' ? 'Despina (Gemini Flash)' : 'Gadis (Edge-TTS Neural)',
      voiceName: process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE,
      geminiConfigured: geminiKeySet,
      edgeTtsConfigured: true,
    },
    envFilesLoaded: envFiles.map((envPath) => path.relative(path.resolve(__dirname, '..'), envPath).replace(/\\/g, '/')),
    bandwidthStats: getBandwidthStats(),
    publicIp: await getPublicIpAddress(),
    ready: binaryCheck.ffmpeg.available && binaryCheck.ytdlp.available,
  });
});

// Network diagnostic endpoint: Check public IP and verify YouTube connectivity
router.get('/network-diagnostic', async (req, res) => {
  try {
    const health = await checkYouTubeHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/daily-limit', (req, res) => {
  try {
    const stats = getDailyOutputVideoStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/niches', (req, res) => {
  try {
    res.json({ niches: getAllNiches() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rejected-frames', (req, res) => {
  try {
    if (!fs.existsSync(rejectedYunetDir)) {
      return res.json({ success: true, count: 0, files: [] });
    }
    const files = fs.readdirSync(rejectedYunetDir)
      .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
      .map(f => {
        const stat = fs.statSync(path.join(rejectedYunetDir, f));
        return {
          filename: f,
          url: `/api/rejected-frames/yunet/${f}`,
          size: stat.size,
          createdAt: stat.birthtime || stat.mtime,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, count: files.length, folderPath: rejectedYunetDir, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Open output folder in native OS file explorer
router.post('/open-folder', (req, res) => {
  const { filename } = req.body || {};
  let targetFile = null;

  if (filename) {
    const candidate = resolveOutputVideoPath(filename);
    if (candidate && fs.existsSync(candidate)) {
      targetFile = candidate;
    }
  }

  let command = '';
  if (process.platform === 'win32') {
    if (targetFile) {
      command = `explorer.exe /select,"${targetFile.replace(/\//g, '\\')}"`;
    } else {
      command = `explorer.exe "${outputDir.replace(/\//g, '\\')}"`;
    }
  } else if (process.platform === 'darwin') {
    if (targetFile) {
      command = `open -R "${targetFile}"`;
    } else {
      command = `open "${outputDir}"`;
    }
  } else {
    command = `xdg-open "${outputDir}"`;
  }

  console.log(`[System] Opening output folder in file manager: ${command}`);
  exec(command, (err) => {
    if (err) {
      console.warn('[System] Could not open folder:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, folder: outputDir, target: targetFile });
  });
});

router.get('/open-folder', (req, res) => {
  let command = process.platform === 'win32'
    ? `explorer.exe "${outputDir.replace(/\//g, '\\')}"`
    : process.platform === 'darwin' ? `open "${outputDir}"` : `xdg-open "${outputDir}"`;
  exec(command, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, folder: outputDir });
  });
});

// 10. Restart Server & Execute ./update.sh (Designed for VPS, Termux, Codespace & Local Dev)
router.post('/restart', async (req, res) => {
  const { runUpdate = true, cleanReset = true } = req.body || {};
  const rootDir = path.resolve(__dirname, '..');
  const updateScriptPath = path.join(rootDir, 'update.sh');

  console.log(`[System] Received restart request (runUpdate=${runUpdate}, cleanReset=${cleanReset})...`);
  let updateLog = '';
  let updateExitCode = 0;

  // 1. Bersihkan proses in-memory & background workers aktif, simpan status stopped ke jobs.json
  try {
    if (typeof autoRuns !== 'undefined') {
      for (const [runId, autoRun] of autoRuns.entries()) {
        autoRun.status = 'stopped';
        autoRun.message = 'Server di-restart.';
      }
    }
    if (typeof autoRetryRuns !== 'undefined') {
      for (const [runId, retryRun] of autoRetryRuns.entries()) {
        retryRun.status = 'stopped';
      }
    }
    if (typeof activeJobs !== 'undefined') {
      for (const [jobId, job] of activeJobs.entries()) {
        if (job.stage === 'running') {
          job.stage = 'stopped';
          job.message = 'Dihentikan karena server di-restart.';
        }
      }
      // Simpan perubahan status ke jobs.json secara atomik & bersih dari secret
      if (fs.existsSync(jobsFilePath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
          for (const [jobId, job] of activeJobs.entries()) {
            existing[jobId] = sanitizeJobForDisk(job);
          }
          atomicWriteJsonSync(jobsFilePath, existing);
        } catch {}
      }
    }
  } catch (cleanErr) {
    console.warn('[System] Warning stopping active processes:', cleanErr.message);
  }

  // 2. Pembersihan file cache transient (TIDAK menyentuh jobs.json atau video jadi)
  if (cleanReset) {
    try {
      console.log('[System] Membersihkan file cache sementara (riwayat jobs & video tetap aman)...');
      const tempUploads = path.join(__dirname, 'temp', 'uploads');
      if (fs.existsSync(tempUploads)) {
        const files = fs.readdirSync(tempUploads);
        for (const file of files) {
          try { fs.unlinkSync(path.join(tempUploads, file)); } catch {}
        }
      }
    } catch (cleanErr) {
      console.warn('[System] Warning cleaning temp files:', cleanErr.message);
    }
  }

  // 3. Jalankan update script / clean sync dari GitHub
  if (runUpdate) {
    console.log('[System] Mengambil isi repo terbaru dari GitHub (clean sync & update.sh)...');
    try {
      updateExitCode = await new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        // Di Linux: gunakan update.sh (git fetch + hard reset + npm install)
        // Di Windows: langsung spawn 'git' tanpa shell mode (git.exe sudah ada di PATH)
        const child = !isWin && fs.existsSync(updateScriptPath)
          ? spawn('bash', [updateScriptPath], { cwd: rootDir })
          : spawn('git', ['pull', 'origin', 'main'], { cwd: rootDir });

        child.stdout.on('data', (chunk) => { updateLog += chunk.toString(); });
        child.stderr.on('data', (chunk) => { updateLog += chunk.toString(); });
        child.on('error', (err) => {
          updateLog += `\nError: ${err.message}`;
          console.warn('[System] Warning saat menjalankan update:', err.message);
          resolve(1);
        });
        child.on('close', (code) => {
          if (code !== 0) {
            console.warn(`[System] Warning: update process exited with code ${code}`);
          }
          console.log('[System] Log update:\n' + updateLog);
          resolve(code || 0);
        });
      });
    } catch (e) {
      console.warn('[System] Gagal menjalankan update script:', e.message);
      updateLog += `\nError: ${e.message}`;
      updateExitCode = 1;
    }

    if (updateExitCode !== 0) {
      return res.status(500).json({
        success: false,
        message: 'Update repo GitHub gagal atau dibatalkan. Server tidak di-restart.',
        updateLog,
      });
    }
  }

  res.json({
    success: true,
    message: 'Server sedang di-restart bersih tanpa sisa konfigurasi lama...',
    updateLog,
  });

  // Gracefully restart via PM2 dengan flag --update-env agar env baru terbaca dan proses segar
  setTimeout(() => {
    console.log('[System] Restarting clipper services via PM2 with --update-env...');
    exec('pm2 restart all --update-env', (pm2Err) => {
      if (pm2Err) {
        exec('pm2 restart clipper --update-env', (singleErr) => {
          if (singleErr) {
            console.log('[System] PM2 restart fallback: exiting process for dev-runner watcher...');
            process.exit(0);
          }
        });
      }
    });
  }, 1000);
});

// GET /api/cookies-status – check if cookies.txt is present on the server
router.get('/cookies-status', (req, res) => {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiesPath)) {
    const stat = fs.statSync(cookiesPath);
    res.json({ exists: true, sizeBytes: stat.size });
  } else {
    res.json({ exists: false });
  }
});

// POST /api/upload-cookies – receive cookies.txt content and save to server/cookies.txt
router.post('/upload-cookies', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
  const content = req.body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Request body is empty. Please send cookies.txt content.' });
  }
  if (!content.includes('youtube.com') && !content.includes('# Netscape HTTP Cookie File')) {
    return res.status(400).json({ success: false, error: 'File tidak terdeteksi sebagai YouTube cookies.txt yang valid. Pastikan Anda mengekspor cookies dari youtube.com.' });
  }
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  fs.writeFileSync(cookiesPath, content, 'utf8');
  console.log(`[Cookies] cookies.txt saved to ${cookiesPath} (${content.length} bytes)`);
  res.json({ success: true, message: 'cookies.txt berhasil disimpan. Sekarang retry job Anda.' });
});

// GET /api/english-dictionary – list all active English phonetic mappings
router.get('/english-dictionary', (req, res) => {
  try {
    const dict = loadEnglishDictionary();
    res.json({ success: true, count: Object.keys(dict).length, dictionary: dict });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/english-dictionary – add or update phonetic dictionary entries
router.post('/english-dictionary', (req, res) => {
  try {
    const entries = req.body;
    if (!entries || typeof entries !== 'object') {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object mapping English words to Indonesian phonetics.' });
    }
    saveToEnglishDictionary(entries);
    const updated = loadEnglishDictionary();
    res.json({ success: true, count: Object.keys(updated).length, dictionary: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bandwidth-stats – get real-time internet data usage and savings
router.get('/bandwidth-stats', (req, res) => {
  try {
    const stats = getBandwidthStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bandwidth-stats/reset – reset bandwidth counter
router.post('/bandwidth-stats/reset', (req, res) => {
  try {
    const scope = req.body?.scope || 'session';
    const stats = resetBandwidthStats(scope);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
