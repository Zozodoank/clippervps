import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import multer from 'multer';
import { exec, spawn, execSync } from 'child_process';

import { checkSystemDependencies, getFFmpegPath } from './services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId, isLocalPortListening } from './services/downloader.js';
import { extractFrames } from './services/frameExtractor.js';
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
} from './services/aiService.js';
import { generateSrtSubtitles } from './services/subtitleService.js';
import { loadEnglishDictionary, saveToEnglishDictionary } from './services/dictionaryService.js';
import {
  renderSilentAntiDetectionVideo,
  mergeVoiceoverAndBurnSubtitles,
  getMediaDurationSec,
  getVideoDimensions
} from './services/videoRenderer.js';
import {
  generateVoiceoverTTS,
  cleanScriptForTTS,
  GEMINI_TTS_VOICES,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
  DEFAULT_GEMINI_TTS_VOICE
} from './services/ttsService.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  sampleFramesFromStream,
  inspectFramesLocally,
  filterCandidateFramesPerFrame,
  poolMultiCandidateFrames,
  callAIGatekeeperMicroservice,
  sampleDenseClustersAroundCleanFrames
} from './services/videoFilterService.js';
import {
  getPublicIpAddress,
  classifyPipelineError,
  checkYouTubeHealth
} from './services/networkDiagnosticService.js';
import {
  getBandwidthStats,
  resetBandwidthStats,
  trackSavedBandwidth
} from './services/bandwidthTracker.js';
import {
  cleanupTempFiles,
  deleteJobTempDirectory,
  deleteJobFiles
} from './services/cleaner.js';
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
} from './services/discoveryService.js';
import { getAllNiches, getNichePreset } from './config/nichePresets.js';
import {
  buildProductFingerprint,
  buildCreativeShotPlan,
  describeCreativePlan,
  conformClipsToVoiceover,
  choosePreferredCandidateSet
} from './services/professionalPipelineService.js';
import { runFinalMasterQc } from './services/finalMasterQcService.js';
import { jobsFilePath, activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, publicAutoRetryState, publicAutoRunState, updateAutoRun, getLatestAutoRun, setDailyStatsProvider } from './store/jobStore.js';
import { loadedEnvFiles, cleanEnvValue, isPlaceholderEnvValue, reloadEnvironment } from './utils/envLoader.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from './services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from './services/antiDupService.js';
import { isValidHttpUrl, resolveOutputVideoPath, isVideoFilePath, isQuotaErrorMessage, sanitizeCaptionText } from './utils/jobHelpers.js';
import { runStage1Pipeline, runAutoStage1Worker, runAutoRetryWorker, conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage, processJobVoiceover } from './worker/pipelineWorker.js';

setDailyStatsProvider(getDailyOutputVideoStats);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global crash guards to keep the server resilient against transient background socket/stream interruptions
process.on('uncaughtException', (err) => {
  console.error('⚠️ [UncaughtException Guard]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [UnhandledRejection Guard]:', reason?.message || reason);
});






reloadEnvironment();

const app = express();
const PORT = process.env.PORT || 5000;

// Directories
import { tempDir, outputDir, uploadsDir, rejectedYunetDir, cookiesPath } from './utils/paths.js';

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Optional Token Authentication for Cloudflare Tunnel / Public Exposure
const configuredApiToken = (process.env.API_ACCESS_TOKEN || '').trim();
if (!configuredApiToken) {
  console.log('[Auth] ℹ️ API_ACCESS_TOKEN is not set. All endpoints are open (backward-compatible).');
} else {
  console.log('[Auth] 🔒 API_ACCESS_TOKEN is configured. Sensitive endpoints are protected.');
}

import jobsRoutes from './api/routes/jobsRoutes.js';
import autoRoutes from './api/routes/autoRoutes.js';
import voiceoverRoutes from './api/routes/voiceoverRoutes.js';
import mediaRoutes from './api/routes/mediaRoutes.js';
import generateRoutes from './api/routes/generateRoutes.js';
import systemRoutes from './api/routes/systemRoutes.js';

app.use('/api', jobsRoutes);
app.use('/api', autoRoutes);
app.use('/api', voiceoverRoutes);
app.use('/api', mediaRoutes);
app.use('/api', generateRoutes);
app.use('/api', systemRoutes);

function tokenAuthMiddleware(req, res, next) {
  const token = (process.env.API_ACCESS_TOKEN || '').trim();
  if (!token) return next();

  const reqPath = req.path || '';

  // Allow open endpoints: health, daily-limit, niches, and media files
  if (
    reqPath === '/api/health' ||
    reqPath === '/api/daily-limit' ||
    reqPath === '/api/niches' ||
    reqPath.startsWith('/api/video/') ||
    reqPath.startsWith('/api/audio/') ||
    reqPath.startsWith('/api/download/') ||
    reqPath.startsWith('/api/video-player-file') ||
    reqPath.startsWith('/api/rejected-frames')
  ) {
    return next();
  }

  // Only check /api/ routes; allow static frontend files
  if (!reqPath.startsWith('/api/')) {
    return next();
  }

  // Extract token from header or query param
  let reqToken = req.headers['x-api-token'];
  if (!reqToken && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      reqToken = authHeader.slice(7).trim();
    }
  }
  if (!reqToken && req.query && req.query.api_token) {
    reqToken = String(req.query.api_token).trim();
  }

  if (!reqToken) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing API access token. Provide x-api-token header or ?api_token query param.',
    });
  }

  // Constant-time token comparison
  const expectedBuf = Buffer.from(token);
  const actualBuf = Buffer.from(String(reqToken));
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid API access token.',
    });
  }

  next();
}

app.use(tokenAuthMiddleware);



/**
 * Strict motion audit for selected footage.
 * Rejects frozen photos and Ken-Burns-like still images that only zoom/pan slowly.
 * Returns the SSIM similarity of consecutive sampled frames; real physical action should
 * create materially different frames, while a held photo remains highly similar.
 */
function auditRealMotionFromFrames(framePaths = []) {
  const paths = Array.isArray(framePaths) ? framePaths.filter(Boolean) : [];
  if (paths.length < 4) return { checked: false, likelyStatic: false, similarities: [] };

  const ffmpegPath = getFFmpegPath();
  const similarities = [];
  for (let i = 1; i < paths.length; i++) {
    try {
      const res = spawnSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', paths[i - 1],
        '-i', paths[i],
        '-lavfi', 'ssim=stats_file=-',
        '-f', 'null', '-'
      ], { encoding: 'utf8', timeout: 5000 });

      const text = String(res.stderr || '') + '\n' + String(res.stdout || '');
      const matches = [...text.matchAll(/All:([0-9.]+)/g)];
      const last = matches.length ? Number(matches[matches.length - 1][1]) : NaN;
      if (Number.isFinite(last)) similarities.push(last);
    } catch {}
  }

  if (similarities.length < 3) return { checked: false, likelyStatic: false, similarities };

  const sorted = [...similarities].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const verySimilarCount = similarities.filter(v => v >= 0.985).length;

  // A clip where almost every sampled pair is nearly identical is a photo/slideshow/slow
  // Ken-Burns effect, not a genuine hands-on product demonstration.
  const likelyStatic = verySimilarCount >= Math.max(3, Math.ceil(similarities.length * 0.70));

  return { checked: true, likelyStatic, similarities, median };
}

function extractSingleFrameAsync(videoPath, timestampSec, outputPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const ffmpegPath = getFFmpegPath();
    const proc = spawn(ffmpegPath, [
      '-y',
      '-ss', String(timestampSec),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath,
    ], { stdio: 'ignore' });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve(false);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath));
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── Persistent Job Store ────────────────────────────────────────────────────

/** In-memory stores */

/** Sanitizes a job object so sensitive user API keys are never written to disk */

/** Atomically writes JSON to disk to avoid 0-byte corruptions on crash/restart */

/** Load jobs from disk into memory without losing history */

/** Save a single job entry to disk */

/** Delete a job from disk */

loadJobsFromDisk();

// Periodic in-memory cleanup to prevent PM2 memory leaks (Poin 10)
setInterval(() => {
  const now = Date.now();
  // 1. Bersihkan jobProgress untuk job yang sudah selesai >30 menit
  for (const [jobId, p] of jobProgress.entries()) {
    if (p.status === 'completed' || p.status === 'error' || p.status === 'awaiting_voiceover') {
      const ts = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
      if (now - ts > 30 * 60 * 1000) {
        jobProgress.delete(jobId);
      }
    }
  }
  // 2. Batasi riwayat autoRuns & autoRetryRuns maksimal 20 data terakhir
  const pruneMap = (m) => {
    const terminalKeys = [];
    for (const [k, run] of m.entries()) {
      if (run.status === 'stopped' || run.status === 'completed' || run.status === 'error') {
        terminalKeys.push(k);
      }
    }
    if (terminalKeys.length > 20) {
      terminalKeys.slice(0, terminalKeys.length - 20).forEach((k) => m.delete(k));
    }
  };
  pruneMap(autoRuns);
  pruneMap(autoRetryRuns);
}, 10 * 60 * 1000);

const DEFAULT_DAILY_VIDEO_LIMIT = 20;



/** Helper: get all YouTube video IDs from existing active & successfully completed jobs across all multi-video harvesting clips */

/** Helper: get all brand + product noun pairs generated today to prevent duplicate exact models/brands in Auto Mode while maximizing brand/type variety */




// ─── API Routes ──────────────────────────────────────────────────────────────



const stripShopeeLinkFromCaption = sanitizeCaptionText;

// 2. Get all jobs history
// Product Core Noun Extractor (Policy 1 & Policy 4)
app.all('/api/extract-product', (req, res) => {
  const title = req.query.title || req.body?.title || '';
  const description = req.query.description || req.body?.description || '';
  const info = extractCoreProductInfo(title, description);
  res.json({ success: true, ...info });
});





// ─── 3c. Auto Retry Engine for Exact Product Match ───────────────────────────







// ─── Stage 1 Pipeline Engine ─────────────────────────────────────────────────



// ─── Auto Mode State & Endpoints ─────────────────────────────────────────────

















/** Helper function to automatically sync final videos to Android MyProject on Termux */

/** Helper function to process voiceover & final video merge for a single job */




// State tracker for server-side Batch TTS Queue
let currentBatchTTS = {
  isRunning: false,
  isStopping: false,
  totalJobs: 0,
  currentIndex: 0,
  currentJobId: null,
  currentProductTitle: '',
  successfulJobs: 0,
  failedJobs: 0,
  lastError: null,
  isQuotaExhausted: false,
  startedAt: null,
  completedAt: null,
};








// 8c. Serve & list rejected face frames (YuNet / Face Gatekeeper)
app.use('/api/rejected-frames/yunet', express.static(rejectedYunetDir));





// ── Cookie Management Routes (for Codespace / Linux servers with no browser) ──



// ── English Phonetic Dictionary Routes ──





app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File voiceover maksimal 50 MB.'
      : err.message;
    return res.status(400).json({ success: false, error: message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message || 'Request tidak valid.' });
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  reloadEnvironment();
  const envActive = (process.env.ACTIVE_AI_ENGINE || '').trim().toLowerCase();
  const openRouterKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : '';
  const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const openRouterOk = openRouterKey && openRouterKey !== 'your_openrouter_api_key_here';
  const geminiOk = geminiKey && geminiKey !== 'your_gemini_api_key_here';

  let activeProvider = '❌ None (Set OPENROUTER_API_KEY or GEMINI_API_KEY in server/.env)';
  if (envActive === 'gemini' && geminiOk) {
    activeProvider = '✨ Google Gemini Direct (Primary)';
  } else if (envActive === 'openrouter' && openRouterOk) {
    activeProvider = '✨ OpenRouter (Primary)';
  } else if (geminiOk && !openRouterOk) {
    activeProvider = '✨ Google Gemini Direct (Primary)';
  } else if (openRouterOk) {
    activeProvider = '✨ OpenRouter (Primary)';
  } else if (geminiOk) {
    activeProvider = '✨ Google Gemini Direct (Primary)';
  }

  console.log(`\n======================================================`);
  console.log(`🎬 Local AI Affiliate Clipper Backend Server`);
  console.log(`🌐 Running at: http://localhost:${PORT}`);
  console.log(`🖥️  Environment: ${process.platform} ${process.arch} (Node ${process.version})`);
  console.log(`🍪 Cookies Found: ${fs.existsSync(cookiesPath) ? 'Yes (yt-dlp auth OK)' : 'No (download might fail)'}`);
  if (process.arch === 'arm') {
    console.log(`\n🚨 [WARNING] Node.js 32-bit (arm) terdeteksi!`);
    console.log(`   Versi Node baru mungkin crash di proot-distro ARM32 (bug libuv armv7).`);
    console.log(`   Sangat disarankan memakai OS proot-distro arm64 (glibc) atau Node v16.x.\n`);
  }
  if (loadedEnvFiles.length) {
    console.log(`[Env] Loaded: ${loadedEnvFiles.map((envPath) => path.relative(path.resolve(__dirname, '..'), envPath).replace(/\\/g, '/')).join(', ')}`);
  }
  console.log(`⚡ Active AI Engine: ${activeProvider}`);
  if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here') {
    console.log(`🔑 OpenRouter Key: configured (${openRouterKey.length} chars)`);
  }
  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    console.log(`🔑 Google Gemini API: configured (Direct fallback ready)`);
  }
  console.log(`======================================================\n`);

  // ── HEALTH CHECK AI LOCAL GATEKEEPER (port 5050) ──
  (async () => {
    try {
      const res = await fetch('http://127.0.0.1:5050/health', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const health = await res.json();
        const m = health.models || {};
        console.log(`🤖 AI Local Gatekeeper: ONLINE (face: ${m.face || '?'}, text: ${m.text || '?'}, scene: ${m.scene || '?'})`);
        const weakBackends = [];
        if (!m.face || m.face === 'none') weakBackends.push('face');
        if (!m.text || m.text === 'gradient_fallback' || m.text === 'none') weakBackends.push('text');
        if (!m.scene || m.scene === 'entropy_variance') weakBackends.push('scene');
        if (weakBackends.length > 0) {
          console.warn(`⚠️  Gatekeeper berjalan TANPA model AI untuk: [${weakBackends.join(', ')}]. Jalankan: bash setup-gatekeeper.sh agar akurasi filter lokal maksimal.`);
        }
      } else {
        console.warn(`⚠️  AI Local Gatekeeper merespons HTTP ${res.status}.`);
      }
    } catch {
      console.warn('⚠️  AI Local Gatekeeper (port 5050) OFFLINE.');
    }
  })();
});
