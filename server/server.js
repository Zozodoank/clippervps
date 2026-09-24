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
import { jobsFilePath, activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, publicAutoRetryState, publicAutoRunState, updateAutoRun, getLatestAutoRun } from './store/jobStore.js';
import { loadedEnvFiles, cleanEnvValue, isPlaceholderEnvValue, reloadEnvironment } from './utils/envLoader.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from './services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from './services/antiDupService.js';
import { isValidHttpUrl, resolveOutputVideoPath, isVideoFilePath, isQuotaErrorMessage, sanitizeCaptionText } from './utils/jobHelpers.js';
import { runStage1Pipeline, runAutoStage1Worker, runAutoRetryWorker, conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage, processJobVoiceover } from './worker/pipelineWorker.js';

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





reloadEnvironment();

const app = express();
const PORT = process.env.PORT || 5000;

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

// 1. Health check & dependency verification
app.get('/api/health', async (req, res) => {
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
app.get('/api/network-diagnostic', async (req, res) => {
  try {
    const health = await checkYouTubeHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const stripShopeeLinkFromCaption = sanitizeCaptionText;

// 2. Get all jobs history
// Product Core Noun Extractor (Policy 1 & Policy 4)
app.all('/api/extract-product', (req, res) => {
  const title = req.query.title || req.body?.title || '';
  const description = req.query.description || req.body?.description || '';
  const info = extractCoreProductInfo(title, description);
  res.json({ success: true, ...info });
});

app.get('/api/jobs', (req, res) => {
  const jobs = [];
  for (const [jobId, job] of activeJobs.entries()) {
    const silentPath = job.silentLocalPath || path.join(outputDir, `silent_clip_${jobId}.mp4`);
    const finalPath = job.finalLocalPath || path.join(outputDir, `final_clip_${jobId}.mp4`);

    jobs.push({
      jobId,
      stage: job.stage || 'unknown',
      productTitle: job.productTitle || '',
      cleanProductTitle: job.cleanProductTitle || job.productTitle || '',
      coreProductNoun: job.coreProductNoun || (job.productTitle ? extractCoreProductInfo(job.productTitle, job.productDescription).coreProductNoun : ''),
      productDescription: job.productDescription || '',
      youtubeUrl: job.youtubeUrl || '',
      shopeeLink: job.shopeeLink || '',
      createdAt: job.createdAt || '',
      updatedAt: job.updatedAt || '',
      errorAt: job.errorAt || '',
      lastError: job.lastError || '',
      hasSilentVideo: fs.existsSync(silentPath),
      hasFinalVideo: fs.existsSync(finalPath),
      silentVideoUrl: job.silentVideoUrl || (fs.existsSync(silentPath) ? `/api/video/silent_clip_${jobId}.mp4` : null),
      finalVideoUrl: job.videoUrl || (fs.existsSync(finalPath) ? `/api/video/final_clip_${jobId}.mp4` : null),
      scenes: job.scenes || [],
      voiceoverScript: job.voiceoverScript || '',
      aiStudioPrompt: job.aiStudioPrompt || '',
      cleanScript: job.cleanScript || '',
      ttsVoice: job.ttsVoice || (job.ttsProvider === 'edge_tts' ? 'Gadis Indonesia (Neural)' : 'Despina'),
      ttsProvider: job.ttsProvider || 'gemini_tts',
      ttsModel: job.ttsModel || 'gemini-3.1-flash-tts-preview',
      ttsFallbackModel: job.ttsFallbackModel || 'gemini-2.5-flash-preview-tts',
      voiceoverAudioUrl: job.voiceoverAudioUrl || null,
      sampleContext: job.sampleContext || null,
      caption: stripShopeeLinkFromCaption(job.caption || '', job),
      highlight: job.highlight || null,
      productHook: job.productHook || '',
      videoTitle: job.videoTitle || job.productTitle || '',
      isAutoRetrying: autoRetryRuns.get(jobId)?.status === 'running',
    });
  }

  jobs.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({ jobs });
});

// 3. Delete a specific job
app.delete('/api/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  deleteJobFiles(jobId, outputDir, tempDir);
  activeJobs.delete(jobId);
  deletePersistedJob(jobId);
  res.json({ success: true, jobId });
});


// 3b. Retry / Regenerate an existing completed or failed job with fresh 1080p video & voiceover
app.post('/api/jobs/:jobId/retry', async (req, res) => {
  reloadEnvironment();
  const { jobId } = req.params;
  const { forceNewCandidate = true } = req.body || {};

  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: `Job ${jobId} tidak ditemukan.` });
  }

  console.log(`[Retry] Starting full regeneration for job ${jobId} ("${job.productTitle}")...`);

  // Delete old outputs and temp files to ensure bad old video/audio is completely replaced
  deleteJobFiles(jobId, outputDir, tempDir);
  job.downloadedVideoPath = null;
  job.hasDownloadedVideo = false;
  job.hasFinalVideo = false;
  job.hasSilentVideo = false;
  job.stage = 'running';
  job.updatedAt = new Date().toISOString();
  activeJobs.set(jobId, job);
  persistJob(jobId, job);

  // Initialize progress state so SSE client immediately sees running status
  updateJobProgress(jobId, {
    step: 'retry_start',
    message: `Menyiapkan generate ulang untuk "${job.productTitle}"...`,
    progress: 5,
    status: 'running',
  });

  // Trigger regeneration asynchronously so SSE progress streams live to the frontend
  (async () => {
    try {
      let targetCandidates = [];
      const usedVids = getAllUsedYouTubeVideoIds();
      const oldVid = extractVideoId(job.youtubeUrl);
      if (oldVid) usedVids.add(oldVid);

      if (forceNewCandidate && job.productTitle) {
        const targetNoun = job.coreProductNoun || extractCoreProductInfo(job.productTitle, job.productDescription).coreProductNoun;
        updateJobProgress(jobId, { step: 'auto_youtube_search', message: `Mencari video 1080p baru untuk target "${targetNoun}"...`, progress: 8, status: 'running', coreProductNoun: targetNoun });
        const fresh = await discoverYouTubeCandidatesForProduct({
          productTitle: job.productTitle,
          productDescription: job.productDescription,
          limit: 8,
          excludeVideoIds: usedVids,
          onProgress: (p) => updateJobProgress(jobId, { ...p, status: 'running' }),
        });
        if (fresh && fresh.length > 0) {
          targetCandidates = fresh;
        }
      }

      // If no search candidates found or manual retry, fallback to the current job URL
      if (!targetCandidates.length) {
        targetCandidates = [{ url: job.youtubeUrl, title: job.productTitle || 'YouTube Video' }];
      }

      let retrySuccess = false;
      let lastRetryErr = null;

      for (let i = 0; i < targetCandidates.length; i++) {
        const candidate = targetCandidates[i];
        const candVid = extractVideoId(candidate.url) || candidate.id;
        if (candVid) usedVids.add(candVid);

        updateJobProgress(jobId, {
          step: 'download',
          message: targetCandidates.length > 1
            ? `[Kandidat ${i + 1}/${targetCandidates.length}] Memproses video 1080p: "${(candidate.title || job.productTitle).slice(0, 30)}..."`
            : `Memproses video 1080p baru: "${(candidate.title || job.productTitle).slice(0, 30)}..."`,
          progress: 10 + Math.round((i / targetCandidates.length) * 15),
          status: 'running',
        });

        try {
          job.youtubeUrl = candidate.url;
          activeJobs.set(jobId, job);
          persistJob(jobId, job);

          const effectiveAiProvider = job.aiProvider || req.body?.aiProvider || (process.env.ACTIVE_AI_ENGINE === 'gemini' ? 'gemini' : 'openrouter');
          await runStage1Pipeline({
            jobId,
            youtubeUrl: candidate.url,
            shopeeLink: job.shopeeLink,
            productTitle: job.productTitle,
            productDescription: job.productDescription,
            apiKey: undefined,
            options: { aiProvider: effectiveAiProvider, autoSearchFallback: false },
            requireCleanGeminiPlan: true,
          });

          retrySuccess = true;
          console.log(`[Retry ${jobId}] Kandidat ${i + 1} (${candidate.url}) sukses di-generate 1080p!`);
          break;
        } catch (candErr) {
          console.warn(`[Retry ${jobId}] Kandidat ${i + 1} (${candidate.url}) gagal: ${candErr.message}. Mencoba kandidat berikutnya...`);
          lastRetryErr = candErr;
          deleteJobFiles(jobId, outputDir, tempDir);
        }
      }

      if (!retrySuccess) {
        throw lastRetryErr || new Error('Tidak ada kandidat video YouTube yang dapat diunduh dalam kualitas 1080p Full HD.');
      }

      console.log(`[Retry ${jobId}] Full regeneration completed successfully.`);
    } catch (retryErr) {
      console.error(`[Retry ${jobId}] Regeneration failed:`, retryErr.message);
      job.stage = 'error';
      job.lastError = retryErr.message;
      job.errorAt = new Date().toISOString();
      activeJobs.set(jobId, job);
      persistJob(jobId, job);
      updateJobProgress(jobId, { step: 'error', status: 'error', error: retryErr.message, message: `Gagal generate ulang: ${retryErr.message}` });
    }
  })();

  res.json({ success: true, jobId, message: 'Job sedang di-generate ulang dengan source video 1080p baru & voiceover baru.' });
});

// ─── 3c. Auto Retry Engine for Exact Product Match ───────────────────────────



app.post('/api/jobs/:jobId/auto-retry/start', async (req, res) => {
  reloadEnvironment();
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: `Job ${jobId} tidak ditemukan.` });
  }

  const existingRun = autoRetryRuns.get(jobId);
  if (existingRun && existingRun.status === 'running') {
    return res.json({ success: true, autoRetry: publicAutoRetryState(existingRun) });
  }

  const { ttsProvider, ttsModel, ttsFallbackModel, ttsVoice, geminiApiKey, apiKey } = req.body || {};

  if (ttsProvider) job.ttsProvider = ttsProvider;
  if (ttsModel) job.ttsModel = ttsModel;
  if (ttsFallbackModel) job.ttsFallbackModel = ttsFallbackModel;
  if (ttsVoice) job.ttsVoice = ttsVoice;
  if (geminiApiKey || apiKey) job.geminiApiKey = geminiApiKey || apiKey;

  const run = {
    jobId,
    status: 'running',
    attemptCount: 0,
    searchIteration: 0,
    currentVideoTitle: '',
    message: `Memulai Auto Retry untuk "${job.productTitle}"...`,
    ttsProvider: ttsProvider || job.ttsProvider,
    ttsModel: ttsModel || job.ttsModel,
    ttsFallbackModel: ttsFallbackModel || job.ttsFallbackModel,
    ttsVoice: ttsVoice || job.ttsVoice,
    geminiApiKey: geminiApiKey || apiKey || job.geminiApiKey,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  autoRetryRuns.set(jobId, run);

  // Trigger continuous auto-retry worker in background
  runAutoRetryWorker(jobId, run);

  res.json({ success: true, jobId, autoRetry: publicAutoRetryState(run) });
});

app.post('/api/jobs/:jobId/auto-retry/stop', (req, res) => {
  const { jobId } = req.params;
  const run = autoRetryRuns.get(jobId);
  if (run && run.status === 'running') {
    run.status = 'stopping';
    run.message = 'Menghentikan Auto Retry...';
    run.updatedAt = new Date().toISOString();
    autoRetryRuns.set(jobId, run);
    return res.json({ success: true, autoRetry: publicAutoRetryState(run) });
  }
  res.json({ success: true, autoRetry: publicAutoRetryState(run) });
});

app.get('/api/jobs/:jobId/auto-retry/status', (req, res) => {
  const { jobId } = req.params;
  const run = autoRetryRuns.get(jobId);
  res.json({ autoRetry: publicAutoRetryState(run) });
});

// 4. SSE endpoint for live job progress streaming
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const current = jobProgress.get(jobId) || { step: 'init', message: 'Initializing...', progress: 0 };
  sendProgress(current);

  // SSE Heartbeat ping every 15s to keep Cloudflare Tunnel connections alive (Poin 11)
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 15000);

  const cleanupSSE = () => {
    clearInterval(interval);
    clearInterval(pingInterval);
  };

  const interval = setInterval(() => {
    const latest = jobProgress.get(jobId);
    if (latest) {
      sendProgress(latest);
      if (latest.status === 'completed' || latest.status === 'error' || latest.status === 'awaiting_voiceover') {
        cleanupSSE();
        res.end();
      }
    }
  }, 500);

  req.on('close', cleanupSSE);
});

// ─── Stage 1 Pipeline Engine ─────────────────────────────────────────────────


// 5. Manual STAGE 1 Endpoint
app.post('/api/generate', async (req, res) => {
  reloadEnvironment();
  const {
    youtubeUrl,
    shopeeLink,
    productTitle,
    productDescription,
    apiKey,
    options = {},
    aiProvider,
    jobId: clientJobId,
    oemUrl1,
    oemUrl2,
    oemUrls,
  } = req.body;

  if (aiProvider) {
    options.aiProvider = aiProvider;
  }

  // OEM manual URLs are optional. They can be used when automatic discovery
  // does not provide enough visual variety. At least one source is required.
  const manualOemUrls = Array.from(new Set([
    ...(Array.isArray(oemUrls) ? oemUrls : []),
    oemUrl1,
    oemUrl2,
    ...(Array.isArray(options.oemUrls) ? options.oemUrls : []),
    options.oemUrl1,
    options.oemUrl2,
  ].map(v => String(v || '').trim()).filter(Boolean)));

  options.oemUrls = manualOemUrls;

  if (!youtubeUrl && manualOemUrls.length === 0) {
    return res.status(400).json({ error: 'YouTube Video URL atau minimal satu URL OEM manual diperlukan.' });
  }
  if (youtubeUrl && (!isValidHttpUrl(youtubeUrl) || !extractVideoId(youtubeUrl))) {
    return res.status(400).json({ error: 'URL YouTube tidak valid. Gunakan URL youtube.com atau youtu.be yang berisi video ID.' });
  }
  for (const oemUrl of manualOemUrls) {
    if (!isValidHttpUrl(oemUrl) || !extractVideoId(oemUrl)) {
      return res.status(400).json({ error: `OEM URL tidak valid: ${oemUrl}. Gunakan URL YouTube/youtu.be yang berisi video ID.` });
    }
  }
  if (shopeeLink && !isValidHttpUrl(shopeeLink)) {
    return res.status(400).json({ error: 'Link produk harus berupa URL http/https yang valid.' });
  }
  if (productTitle && isBulkyOrUnsuitableProduct(productTitle)) {
    return res.status(400).json({ error: 'Produk ditolak karena tergolong perabot besar / rak besar yang memenuhi frame. Niche disetel hanya untuk alat dapur praktis.' });
  }

  const dailyStats = getDailyOutputVideoStats();
  if (dailyStats.isLimitReached && !req.body.forceOverrideDailyLimit) {
    return res.status(429).json({
      error: `Batas kuota harian ${dailyStats.limit} video telah tercapai hari ini (${dailyStats.count}/${dailyStats.limit} video). Dibatasi untuk mencegah pemblokiran IP YouTube/AI. Silakan coba lagi besok.`,
      dailyStats,
    });
  }

  const jobId = clientJobId || crypto.randomBytes(6).toString('hex');
  if (clientJobId && req.body.forceFreshVideo) {
    console.log(`[Job ${clientJobId}] Force-fresh generation requested: cleaning up old files...`);
    deleteJobFiles(clientJobId, outputDir, tempDir);
    const existingJob = activeJobs.get(clientJobId);
    if (existingJob) {
      existingJob.downloadedVideoPath = null;
      existingJob.hasDownloadedVideo = false;
      existingJob.hasFinalVideo = false;
      existingJob.hasSilentVideo = false;
      existingJob.stage = 'running';
    }
  }

  try {
    const stage1Result = await runStage1Pipeline({
      jobId,
      youtubeUrl,
      shopeeLink,
      productTitle,
      productDescription,
      apiKey,
      options,
    });
    res.json(stage1Result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      isQuotaError: error.isQuotaError || false,
      canRetry: true,
      jobId,
    });
  }
});

// ─── Auto Mode State & Endpoints ─────────────────────────────────────────────





app.get('/api/auto/status', (req, res) => {
  res.json({ run: publicAutoRunState(getLatestAutoRun()) });
});

app.get('/api/auto/keywords/stats', (req, res) => {
  try {
    const stats = getUsedKeywordsStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto/keywords/reset', (req, res) => {
  try {
    const result = clearUsedKeywords();
    res.json({ success: true, message: 'Riwayat kata kunci berhasil di-reset.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-limit', (req, res) => {
  try {
    const stats = getDailyOutputVideoStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/niches', (req, res) => {
  try {
    res.json({ niches: getAllNiches() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto/start', (req, res) => {
  reloadEnvironment();
  const latest = getLatestAutoRun();
  if (latest && (latest.status === 'running' || latest.status === 'starting')) {
    if (req.body?.niche && latest.niche && latest.niche !== req.body.niche) {
      return res.status(400).json({
        error: `Auto Mode sedang aktif berjalan dengan niche "${latest.niche}". Hentikan terlebih dahulu sebelum beralih ke niche "${req.body.niche}".`,
        run: publicAutoRunState(latest),
      });
    }
    return res.json({ run: publicAutoRunState(latest) });
  }

  const dailyStats = getDailyOutputVideoStats();
  if (dailyStats.isLimitReached && !req.body.forceOverrideDailyLimit) {
    return res.status(429).json({
      error: `Batas kuota harian ${dailyStats.limit} video telah tercapai hari ini (${dailyStats.count}/${dailyStats.limit} video). Auto Mode dicegah untuk melindungi IP dari pemblokiran YouTube/AI. Silakan coba lagi besok.`,
      dailyStats,
    });
  }

  const { maxJobs = 1, options = {}, niche = 'kitchen_tools' } = req.body || {};
  const isUnlimited = false;
  const runId = `autorun_${crypto.randomBytes(4).toString('hex')}`;
  const run = {
    runId,
    status: 'starting',
    maxJobs: 1,
    successfulJobs: 0,
    failedJobs: 0,
    skippedProducts: 0,
    niche,
    currentJobId: null,
    currentProductTitle: null,
    message: 'Memulai pipeline Auto Mode (1 Job Aman)...',
    progress: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options,
    failures: [],
  };

  autoRuns.set(runId, run);
  runAutoStage1Worker(run);
  res.json({ run: publicAutoRunState(run) });
});

app.post('/api/auto/stop', (req, res) => {
  const { runId } = req.body || {};
  const run = autoRuns.get(runId) || getLatestAutoRun();
  if (run && (run.status === 'running' || run.status === 'starting')) {
    updateAutoRun(run, { status: 'stopping', message: 'Menghentikan Auto Mode setelah job saat ini selesai...' });
  }
  res.json({ run: publicAutoRunState(run) });
});

app.get('/api/auto/progress/:runId', (req, res) => {
  const { runId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = () => {
    const run = autoRuns.get(runId);
    res.write(`data: ${JSON.stringify({ run: publicAutoRunState(run) })}\n\n`);
    if (run && ['completed', 'stopped', 'error'].includes(run.status)) {
      clearInterval(interval);
      res.end();
    }
  };

  const interval = setInterval(sendProgress, 800);
  sendProgress();

  req.on('close', () => clearInterval(interval));
});




// 6. STAGE 2: Upload Voiceover & Merge Subtitles
app.post('/api/upload-voiceover', upload.single('audio'), async (req, res) => {
  reloadEnvironment();
  const { jobId } = req.body;
  const audioFile = req.file;

  if (!jobId) return res.status(400).json({ error: 'Job ID is required.' });
  if (!audioFile) return res.status(400).json({ error: 'Voiceover audio file is required.' });

  const job = activeJobs.get(jobId);
  const silentPath = job?.silentLocalPath || path.join(outputDir, `silent_clip_${jobId}.mp4`);

  if (!job || !fs.existsSync(silentPath)) {
    return res.status(404).json({ error: 'Job session expired or silent video not found. Please regenerate Stage 1.' });
  }

  const finalFileName = `final_clip_${jobId}.mp4`;
  const finalOutputPath = path.join(outputDir, finalFileName);
  const srtPath = path.join(uploadsDir, `subtitles_${jobId}.ass`);

  const updateProgress = (data) => {
    const payload = typeof data === 'string'
      ? { step: 'processing', message: data, progress: 50, jobId }
      : { ...data, jobId };
    jobProgress.set(jobId, payload);
    console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message}`);
  };

  updateProgress({ step: 'merge_start', message: 'Merging voiceover & burning subtitles...', progress: 20, status: 'running' });

  try {
    const scriptToUse = (req.body?.customScript && req.body.customScript.trim())
      ? req.body.customScript.trim()
      : (job.aiStudioPrompt || job.voiceoverScript || '');

    const conformResult = await conformExistingJobEditToAudio({
      job,
      silentPath,
      audioPath: audioFile.path,
      script: scriptToUse,
      onProgress: updateProgress,
    });
    const silentDurationSec = conformResult.silentDurationSec;
    const audioDurationSec = conformResult.audioDurationSec;
    const subtitleTargetDuration = audioDurationSec || silentDurationSec;

    updateProgress({ step: 'subtitles', message: `Generating synchronized subtitle captions for ${silentDurationSec.toFixed(1)}s video...`, progress: 55, status: 'running' });
    generateSrtSubtitles(scriptToUse, subtitleTargetDuration, srtPath, {
      wordBoundaries: job?.wordBoundaries || [],
      videoDurationSec: silentDurationSec,
      lexicon: job?.lexicon || {},
    });

    updateProgress({ step: 'render_final', message: 'Rendering final 9:16 video with Voiceover & Subtitles...', progress: 75, status: 'running' });
    await mergeVoiceoverAndBurnSubtitles({
      silentVideoPath: silentPath,
      voiceoverAudioPath: audioFile.path,
      srtPath,
      outputVideoPath: finalOutputPath,
      targetDurationSec: silentDurationSec,
      backgroundMusicPath: process.env.BACKGROUND_MUSIC_PATH || '',
      musicVolume: Number(process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
      onProgress: updateProgress,
    });

    const manualRenderSource = (job.downloadedVideoPath && fs.existsSync(job.downloadedVideoPath))
      ? job.downloadedVideoPath
      : job.highlight?.clips?.find(c => c?.videoPath && fs.existsSync(c.videoPath))?.videoPath;

    const finalQc = await runProfessionalFinalQcWithRepair({
      jobId,
      finalOutputPath,
      silentVideoPath: silentPath,
      voiceoverAudioPath: audioFile.path,
      srtPath,
      expectedDurationSec: silentDurationSec,
      productTitle: job.productTitle || '',
      productFingerprint: job.productFingerprint || null,
      aiProvider: job.aiProvider,
      apiKey: undefined,
      niche: job.niche || 'kitchen_tools',
      renderSourcePath: manualRenderSource || '',
      clips: job.highlight?.clips || [],
      hflip: job.hasProductBrand ? false : Boolean(job.highlight?.allowHflip),
      reframe: job.highlight?.reframe || {},
      backgroundMusicPath: process.env.BACKGROUND_MUSIC_PATH || '',
      musicVolume: Number(process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
      onProgress: updateProgress,
    });
    if (!finalQc.passed) {
      try { fs.unlinkSync(finalOutputPath); } catch {}
      throw new Error(`FINAL_MASTER_QC_FAILED: ${[
        ...(finalQc.technical?.issues || []),
        ...(finalQc.visual?.reason ? [finalQc.visual.reason] : []),
      ].join(', ')}`);
    }

    cleanupTempFiles([audioFile.path, srtPath]);

    deleteJobTempDirectory(jobId, tempDir);
    console.log(`[Cleaner] Raw YouTube video and temp files for job ${jobId} permanently removed.`);

    const cacheBuster = Date.now();
    const finalResult = {
      ...job,
      stage: 'completed',
      finalFileName,
      videoUrl: `/api/video/${finalFileName}?t=${cacheBuster}`,
      downloadUrl: `/api/download/${finalFileName}?t=${cacheBuster}`,
      finalLocalPath: finalOutputPath,
      downloadedVideoPath: null,
      hasDownloadedVideo: false,
      finalQc,
    };

    activeJobs.set(jobId, finalResult);
    persistJob(jobId, finalResult);

    updateProgress({ step: 'completed', message: 'Final 9:16 Video Ready!', progress: 100, status: 'completed', result: finalResult });

    res.json({ success: true, ...finalResult });
  } catch (error) {
    console.error(`[Job ${jobId}] Stage 2 Error:`, error);
    cleanupTempFiles([audioFile?.path, srtPath]);
    updateProgress({ step: 'error', message: error.message, progress: 0, status: 'error', error: error.message });
    res.status(500).json({ success: false, error: error.message, jobId });
  }
});

/** Helper function to automatically sync final videos to Android MyProject on Termux */

/** Helper function to process voiceover & final video merge for a single job */

// 6b. Regenerate Voiceover automatically via TTS & Re-render Final Video (Single Job)
app.post('/api/regenerate-voiceover', async (req, res) => {
  reloadEnvironment();
  const { jobId, customScript, lexicon, ttsProvider, ttsModel, ttsFallbackModel, ttsVoice, apiKey } = req.body;

  if (!jobId) return res.status(400).json({ error: 'Job ID is required.' });

  try {
    const updatedJob = await processJobVoiceover(jobId, customScript, {
      lexicon,
      ttsProvider,
      ttsModel,
      ttsFallbackModel,
      ttsVoice,
      geminiApiKey: apiKey,
    });
    res.json({ success: true, ...updatedJob });
  } catch (error) {
    const isQuota = error.isQuotaError || isQuotaErrorMessage(error.message);
    const status = error.statusCode || (isQuota ? 402 : 500);
    res.status(status).json({ success: false, error: error.message, isQuotaError: isQuota, jobId });
  }
});

// 6b2. Dedicated Retry TTS Endpoint:
// Uses AI to detect English words in the job script & title,
// automatically appends new phonetic pronunciations into english_dictionary.json,
// regenerates TTS audio with the phonetic lexicon,
// ensures output subtitles remain 100% normal non-phonetic text, and re-renders video.
app.post('/api/retry-job-tts', async (req, res) => {
  reloadEnvironment();
  const { jobId, customScript, apiKey, aiProvider, ttsProvider, ttsModel, ttsFallbackModel, ttsVoice } = req.body;

  if (!jobId) return res.status(400).json({ error: 'Job ID is required.' });

  loadJobsFromDisk();
  let job = activeJobs.get(jobId);
  if (!job && fs.existsSync(jobsFilePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
      if (existing[jobId]) {
        job = existing[jobId];
        activeJobs.set(jobId, job);
      }
    } catch {}
  }

  if (!job) {
    return res.status(404).json({ error: `Job ${jobId} tidak ditemukan di riwayat.` });
  }

  const scriptToAnalyze = (customScript && customScript.trim())
    ? customScript.trim()
    : (job.voiceoverScript || job.aiStudioPrompt || '');

  try {
    let newlyDetected = {};
    try {
      newlyDetected = await detectPhoneticLexiconWithAI({
        script: scriptToAnalyze,
        productTitle: job.productTitle || '',
        apiKey,
        aiProvider,
        onProgress: (p) => {
          jobProgress.set(jobId, { step: 'tts_lexicon', message: p.message, progress: 15, jobId });
        },
      });
    } catch (aiErr) {
      console.warn(`[Job ${jobId}] AI phonetic detection warning (continuing with existing dictionary):`, aiErr.message);
    }

    const currentLexicon = loadEnglishDictionary();
    const mergedLexicon = { ...currentLexicon, ...(job.lexicon || {}), ...newlyDetected };

    const updatedJob = await processJobVoiceover(jobId, customScript, {
      lexicon: mergedLexicon,
      ttsProvider,
      ttsModel,
      ttsFallbackModel,
      ttsVoice,
      geminiApiKey: apiKey,
    });

    res.json({
      success: true,
      newlyDetectedLexicon: newlyDetected,
      newWordCount: Object.keys(newlyDetected).length,
      ...updatedJob,
    });
  } catch (error) {
    console.error(`[Job ${jobId}] Retry TTS Error:`, error);
    const isQuota = error.isQuotaError || isQuotaErrorMessage(error.message);
    const status = error.statusCode || (isQuota ? 402 : 500);
    res.status(status).json({ success: false, error: error.message, isQuotaError: isQuota, jobId });
  }
});


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

// 6c. Start Server-Side Batch TTS Queue
app.post('/api/batch-tts/start', async (req, res) => {
  reloadEnvironment();
  const { ttsProvider, ttsModel, ttsFallbackModel, ttsVoice, apiKey } = req.body || {};

  if (currentBatchTTS.isRunning) {
    return res.json({ success: true, batch: currentBatchTTS, message: 'Batch TTS sudah berjalan di server.' });
  }

  // Reload disk jobs to make sure we don't miss any jobs
  loadJobsFromDisk();

  // Find all candidate jobs that have a 9:16 silent video ready on disk but do not have a completed final video yet
  const candidateJobs = [];
  for (const [jobId, job] of activeJobs.entries()) {
    const silentPath = job.silentLocalPath || path.join(outputDir, `silent_clip_${jobId}.mp4`);
    const finalPath = job.finalLocalPath || path.join(outputDir, `final_clip_${jobId}.mp4`);

    const hasSilent = fs.existsSync(silentPath);
    const hasFinal = fs.existsSync(finalPath);

    if (hasSilent && !hasFinal) {
      candidateJobs.push({ jobId, job });
    }
  }

  if (candidateJobs.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Tidak ada job yang siap untuk TTS (semua video sudah selesai atau belum ada klip 9:16 tersimpan).',
    });
  }

  // Sort candidate jobs: oldest first so we complete earlier jobs in sequence
  candidateJobs.sort((a, b) => {
    const dateA = a.job.createdAt ? new Date(a.job.createdAt).getTime() : 0;
    const dateB = b.job.createdAt ? new Date(b.job.createdAt).getTime() : 0;
    return dateA - dateB;
  });

  currentBatchTTS = {
    isRunning: true,
    isStopping: false,
    totalJobs: candidateJobs.length,
    currentIndex: 0,
    currentJobId: candidateJobs[0]?.jobId || null,
    currentProductTitle: candidateJobs[0]?.job?.productTitle || '',
    successfulJobs: 0,
    failedJobs: 0,
    lastError: null,
    isQuotaExhausted: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  res.json({ success: true, batch: currentBatchTTS });

  // Run the batch asynchronously in the background on the server!
  (async () => {
    console.log(`[Batch TTS] 🚀 Starting server-side sequential queue for ${candidateJobs.length} jobs...`);

    for (let i = 0; i < candidateJobs.length; i++) {
      if (currentBatchTTS.isStopping) {
        console.log('[Batch TTS] ⏹️ Queue stopped by user request.');
        break;
      }

      const { jobId, job } = candidateJobs[i];
      currentBatchTTS.currentIndex = i;
      currentBatchTTS.currentJobId = jobId;
      currentBatchTTS.currentProductTitle = job.productTitle || `Job ${jobId}`;

      console.log(`[Batch TTS] (${i + 1}/${candidateJobs.length}) Processing: "${currentBatchTTS.currentProductTitle}" [${jobId}]`);

      try {
        await processJobVoiceover(jobId, null, {
          ttsProvider,
          ttsModel,
          ttsFallbackModel,
          ttsVoice,
          geminiApiKey: apiKey,
        });
        currentBatchTTS.successfulJobs++;
        console.log(`[Batch TTS] ✅ Success (${currentBatchTTS.successfulJobs}/${candidateJobs.length}) on Job [${jobId}]`);
      } catch (err) {
        console.error(`[Batch TTS] ❌ Failed Job [${jobId}]:`, err.message);
        currentBatchTTS.failedJobs++;
        currentBatchTTS.lastError = err.message;

        if (err.isQuotaError || isQuotaErrorMessage(err.message)) {
          currentBatchTTS.isQuotaExhausted = true;
          console.warn('[Batch TTS] ⚠️ TTS quota exhausted or rate limit hit. Pausing batch queue.');
          break;
        }
        // Non-quota error: DO NOT STOP! Keep processing the remaining jobs!
      }
    }

    currentBatchTTS.isRunning = false;
    currentBatchTTS.isStopping = false;
    currentBatchTTS.completedAt = new Date().toISOString();
    console.log(`[Batch TTS] 🏁 Finished queue: ${currentBatchTTS.successfulJobs} success, ${currentBatchTTS.failedJobs} failed.`);
  })().catch(fatalErr => {
    console.error('[Batch TTS] Fatal queue failure:', fatalErr);
    currentBatchTTS.isRunning = false;
  });
});

// 6d. Get Batch TTS Status
app.get('/api/batch-tts/status', (req, res) => {
  res.json({ batch: currentBatchTTS });
});

// 6e. Stop Batch TTS
app.post('/api/batch-tts/stop', (req, res) => {
  if (currentBatchTTS.isRunning) {
    currentBatchTTS.isStopping = true;
  }
  res.json({ success: true, batch: currentBatchTTS });
});

// 6c. Stream generated audio files
app.get('/api/audio/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename || '');
  if (!safeName.endsWith('.mp3') && !safeName.endsWith('.wav') && !safeName.endsWith('.m4a')) {
    return res.status(400).send('Invalid audio filename.');
  }

  const audioPath = path.resolve(uploadsDir, safeName);
  if (!audioPath.startsWith(path.resolve(uploadsDir)) || !fs.existsSync(audioPath)) {
    return res.status(404).send('Audio file not found.');
  }

  const stat = fs.statSync(audioPath);
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(audioPath).pipe(res);
});

// 7. Stream output video
app.get('/api/video/:filename', (req, res) => {
  const filePath = resolveOutputVideoPath(req.params.filename);
  if (!filePath) return res.status(400).send('Invalid video filename.');
  if (!fs.existsSync(filePath)) return res.status(404).send('Video not found.');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= fileSize) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    const chunksize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// 8. Download endpoint for videos
app.get('/api/download/:filename', (req, res) => {
  const filePath = resolveOutputVideoPath(req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename.' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
  res.download(filePath, req.params.filename);
});

// 8b. Download script & marketing text as .txt file via HTTP
app.get('/api/jobs/:jobId/script.txt', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  if (!job) return res.status(404).send('Job not found.');

  const filename = `naskah_${(job.productTitle || jobId).replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}_${jobId}.txt`;
  
  const content = [
    `======================================================`,
    `AFFILIATE VIDEO ASSETS & SCRIPT`,
    `Job ID        : ${jobId}`,
    `Judul Produk  : ${job.productTitle || '-'}`,
    `Link Shopee   : ${job.shopeeLink || '-'}`,
    `Hook Visual   : ${job.productHook || '-'}`,
    `Dibuat Pada   : ${job.createdAt || new Date().toISOString()}`,
    `======================================================\n`,
    `--- 1. NASKAH VOICEOVER (AD ADVISOR) ---`,
    job.voiceoverScript || '(Belum ada naskah)',
    `\n------------------------------------------------------\n`,
    `--- 2. PROMPT GOOGLE AI STUDIO (TTS Composer) ---`,
    job.aiStudioPrompt || '(Belum ada prompt AI Studio)',
    `\n------------------------------------------------------\n`,
    `--- 3. CAPTION & HASHTAGS REELS / TIKTOK ---`,
    sanitizeCaptionText(job.caption || '', job) || '(Belum ada caption)',
    `\n------------------------------------------------------\n`,
    `--- 4. KOTAK SCENE BREAKDOWN (5 DETIK) ---`,
    ...(Array.isArray(job.scenes) ? job.scenes.map(s => `[Scene ${s.sceneNumber}] (${s.timeRange || s.startTime + ' - ' + s.endTime})\nVisual: ${s.visualDescription}\nNarasi: "${s.voiceover}"\nNotes : ${s.adAdvisorNotes || '-'}\n`) : ['-']),
    `======================================================`
  ].join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

// 8c. Serve & list rejected face frames (YuNet / Face Gatekeeper)
app.use('/api/rejected-frames/yunet', express.static(rejectedYunetDir));

app.get('/api/rejected-frames', (req, res) => {
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
app.post('/api/open-folder', (req, res) => {
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

app.get('/api/open-folder', (req, res) => {
  let command = process.platform === 'win32'
    ? `explorer.exe "${outputDir.replace(/\//g, '\\')}"`
    : process.platform === 'darwin' ? `open "${outputDir}"` : `xdg-open "${outputDir}"`;
  exec(command, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, folder: outputDir });
  });
});

// 10. Restart Server & Execute ./update.sh (Designed for VPS, Termux, Codespace & Local Dev)
app.post('/api/restart', async (req, res) => {
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

// ── Cookie Management Routes (for Codespace / Linux servers with no browser) ──

// GET /api/cookies-status – check if cookies.txt is present on the server
app.get('/api/cookies-status', (req, res) => {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiesPath)) {
    const stat = fs.statSync(cookiesPath);
    res.json({ exists: true, sizeBytes: stat.size });
  } else {
    res.json({ exists: false });
  }
});

// POST /api/upload-cookies – receive cookies.txt content and save to server/cookies.txt
app.post('/api/upload-cookies', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
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

// ── English Phonetic Dictionary Routes ──

// GET /api/english-dictionary – list all active English phonetic mappings
app.get('/api/english-dictionary', (req, res) => {
  try {
    const dict = loadEnglishDictionary();
    res.json({ success: true, count: Object.keys(dict).length, dictionary: dict });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/english-dictionary – add or update phonetic dictionary entries
app.post('/api/english-dictionary', (req, res) => {
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
app.get('/api/bandwidth-stats', (req, res) => {
  try {
    const stats = getBandwidthStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bandwidth-stats/reset – reset bandwidth counter
app.post('/api/bandwidth-stats/reset', (req, res) => {
  try {
    const scope = req.body?.scope || 'session';
    const stats = resetBandwidthStats(scope);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
