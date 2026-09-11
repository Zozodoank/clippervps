import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import multer from 'multer';
import { exec, spawn } from 'child_process';

import { checkSystemDependencies } from './services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from './services/downloader.js';
import { extractFrames } from './services/frameExtractor.js';
import {
  selectHighlightWithAI,
  analyzeYouTubeVideoWithGemini,
  getDirectGeminiApiKey,
  generateAdAdvisorScriptWithAI,
  detectPhoneticLexiconWithAI,
  formatEnrichedCaption
} from './services/aiService.js';
import { generateSrtSubtitles } from './services/subtitleService.js';
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
  inspectFramesLocally
} from './services/videoFilterService.js';
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
  discoverSingleShopeeProduct,
  discoverYouTubeCandidatesForProduct,
  searchMultiEngineVideos,
  searchBingVideos,
  searchVideosByProductImage,
  fetchShopeePageMeta,
  isShopeeProductUrl,
  findMatchingShopeeProductUrl,
  extractShopeeLinkFromText,
  DEFAULT_AUTO_KEYWORDS,
  getAutoKeywords,
  extractCoreProductInfo,
  isBulkyOrUnsuitableProduct,
  markKeywordAsUsed,
  loadUsedKeywords,
  isKeywordUsed,
  isProductTitleUsed,
  getUsedKeywordsStats,
  clearUsedKeywords
} from './services/discoveryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  'your_rapidapi_key_here',
  'your_cobalt_api_key_here',
]);

let loadedEnvFiles = [];

function cleanEnvValue(value) {
  let cleaned = String(value || '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function isPlaceholderEnvValue(value) {
  return PLACEHOLDER_ENV_VALUES.has(cleanEnvValue(value).toLowerCase());
}

export function reloadEnvironment() {
  const loaded = [];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = dotenv.parse(raw);
        for (const [key, value] of Object.entries(parsed)) {
          const cleaned = cleanEnvValue(value);
          if (isPlaceholderEnvValue(cleaned)) continue;
          process.env[key] = cleaned;
          process.env[key.toUpperCase()] = cleaned;
        }
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).replace(/^\uFEFF/, '').trim();
            const v = cleanEnvValue(trimmed.slice(eqIdx + 1));
            if (v && !isPlaceholderEnvValue(v)) {
              process.env[k] = v;
              process.env[k.toUpperCase()] = v;
            }
          }
        }
        loaded.push(envPath);
      } catch (err) {
        console.warn(`[Env] Could not load ${envPath}:`, err.message);
      }
    }
  }
  loadedEnvFiles = [...new Set(loaded)];
  return loadedEnvFiles;
}

reloadEnvironment();

const app = express();
const PORT = process.env.PORT || 5000;

// Directories
const tempDir = path.join(__dirname, 'temp');
const outputDir = path.join(__dirname, 'output');
const uploadsDir = path.join(tempDir, 'uploads');
const jobsFilePath = path.join(__dirname, 'jobs.json');

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveOutputVideoPath(filename) {
  const safeName = String(filename || '').trim();
  if (!/^(silent|final)_clip_[a-zA-Z0-9_-]+\.mp4$/.test(safeName)) {
    return null;
  }
  const resolved = path.resolve(outputDir, safeName);
  const outputRoot = path.resolve(outputDir) + path.sep;
  return resolved.startsWith(outputRoot) ? resolved : null;
}

// ─── Persistent Job Store ────────────────────────────────────────────────────

/** In-memory stores */
const activeJobs = new Map();
const jobProgress = new Map();
const autoRuns = new Map();
const autoRetryRuns = new Map();

/** Load jobs from disk into memory without losing history */
function loadJobsFromDisk() {
  try {
    if (fs.existsSync(jobsFilePath)) {
      const raw = fs.readFileSync(jobsFilePath, 'utf-8');
      const obj = JSON.parse(raw);
      let modified = false;
      for (const [jobId, jobData] of Object.entries(obj)) {
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
        fs.writeFileSync(jobsFilePath, JSON.stringify(obj, null, 2), 'utf-8');
      }
      console.log(`[Jobs] Loaded ${activeJobs.size} persisted job(s) from disk.`);
    }
  } catch (err) {
    console.warn('[Jobs] Could not load jobs.json:', err.message);
  }
}

/** Save a single job entry to disk */
function persistJob(jobId, jobData) {
  try {
    let existing = {};
    if (fs.existsSync(jobsFilePath)) {
      existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
    }
    existing[jobId] = {
      ...jobData,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(jobsFilePath, JSON.stringify(existing, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[Jobs] Could not persist job ${jobId}:`, err.message);
  }
}

/** Delete a job from disk */
function deletePersistedJob(jobId) {
  try {
    if (fs.existsSync(jobsFilePath)) {
      const existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
      delete existing[jobId];
      fs.writeFileSync(jobsFilePath, JSON.stringify(existing, null, 2), 'utf-8');
    }
  } catch (err) {
    console.warn(`[Jobs] Could not delete job ${jobId} from disk:`, err.message);
  }
}

loadJobsFromDisk();

/** Helper: get all YouTube video IDs from existing active & successfully completed jobs */
function getAllUsedYouTubeVideoIds() {
  const used = new Set();
  for (const job of activeJobs.values()) {
    // Only exclude video if the job actually SUCCEEDED or is currently processing
    if (job.youtubeUrl && (job.stage === 'completed' || job.stage === 'awaiting_voiceover' || job.stage === 'running')) {
      const vid = extractVideoId(job.youtubeUrl);
      if (vid) used.add(vid);
    }
  }
  return used;
}

function isVideoFilePath(p) {
  if (!p) return false;
  const lower = p.toLowerCase();
  return !['.m4a', '.mp3', '.aac', '.wav', '.opus'].some(ext => lower.endsWith(ext)) &&
    ['.mp4', '.webm', '.mkv', '.mov'].some(ext => lower.endsWith(ext));
}

function isQuotaErrorMessage(msg = '') {
  const lower = String(msg).toLowerCase();
  return lower.includes('saldo') || lower.includes('insufficient') ||
    lower.includes('balance') || lower.includes('quota') || lower.includes('kuota') ||
    lower.includes('credit') || lower.includes('resource_exhausted') || lower.includes('429');
}

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
    geminiModel: 'gemini-1.5-flash',
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
    ready: binaryCheck.ffmpeg.available && binaryCheck.ytdlp.available,
  });
});

function sanitizeCaptionText(caption = '', job = null) {
  return formatEnrichedCaption({
    caption,
    productTitle: job?.productTitle || job?.videoTitle || '',
    productDescription: job?.productDescription || '',
    sampleContext: job?.sampleContext || null,
    scenes: job?.scenes || [],
    platform: 'clipper',
  });
}
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

function updateJobProgress(jobId, data) {
  const payload = typeof data === 'string'
    ? { step: 'processing', message: data, progress: 50, jobId, status: 'running' }
    : { status: 'running', ...data, jobId };
  jobProgress.set(jobId, payload);
  console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message || ''}`);
}

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

function publicAutoRetryState(run) {
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

async function runAutoRetryWorker(jobId, run) {
  try {
    const job = activeJobs.get(jobId);
    if (!job || !job.productTitle) {
      run.status = 'error';
      run.message = 'Job tidak memiliki judul produk yang valid.';
      run.updatedAt = new Date().toISOString();
      updateJobProgress(jobId, { step: 'error', status: 'error', error: run.message, isAutoRetrying: false });
      return;
    }

    const targetTitle = job.productTitle;
    console.log(`[AutoRetry ${jobId}] Memulai Auto Retry pencarian video persis untuk "${targetTitle}"...`);
    updateJobProgress(jobId, {
      step: 'auto_retry_start',
      message: `[Auto Retry] Memulai pencarian video yang cocok persis & faceless untuk "${targetTitle.slice(0, 30)}..."`,
      progress: 5,
      status: 'running',
      isAutoRetrying: true,
      attemptCount: 0,
    });

    const usedVids = getAllUsedYouTubeVideoIds();
    const oldVid = extractVideoId(job.youtubeUrl);
    if (oldVid) usedVids.add(oldVid);

    let foundSuccess = false;

    while (run.status === 'running') {
      if (run.attemptCount >= 60) {
        run.status = 'error';
        run.message = 'Mencapai batas maksimal 60 percobaan pencarian video.';
        run.updatedAt = new Date().toISOString();
        break;
      }

      run.message = `[Percobaan ke-${run.attemptCount + 1}] Mencari video YouTube cocok persis untuk "${targetTitle.slice(0, 30)}..."`;
      run.updatedAt = new Date().toISOString();
      updateJobProgress(jobId, {
        step: 'auto_youtube_search',
        message: run.message,
        progress: 8,
        status: 'running',
        isAutoRetrying: true,
        attemptCount: run.attemptCount + 1,
      });

      const candidates = await discoverYouTubeCandidatesForProduct({
        productTitle: targetTitle,
        productDescription: job.productDescription,
        limit: 8,
        excludeVideoIds: usedVids,
        searchIteration: run.searchIteration,
        onProgress: (p) => updateJobProgress(jobId, { ...p, status: 'running', isAutoRetrying: true }),
      });
      run.searchIteration++;

      if (!candidates || candidates.length === 0) {
        run.message = `Tidak ada kandidat baru pada pencarian ini. Mencoba variasi kata kunci lain...`;
        updateJobProgress(jobId, { step: 'auto_retry_wait', message: run.message, progress: 10, status: 'running', isAutoRetrying: true });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      for (const candidate of candidates) {
        if (run.status === 'stopping' || run.status === 'stopped') break;

        const candVid = extractVideoId(candidate.url) || candidate.id;
        if (candVid) usedVids.add(candVid);

        run.attemptCount++;
        run.currentVideoTitle = candidate.title || '';
        run.message = `[Percobaan ke-${run.attemptCount}] Menguji video: "${(candidate.title || targetTitle).slice(0, 35)}..."`;
        run.updatedAt = new Date().toISOString();

        updateJobProgress(jobId, {
          step: 'download',
          message: run.message,
          progress: 12,
          status: 'running',
          isAutoRetrying: true,
          attemptCount: run.attemptCount,
        });

        // Clean any old outputs / temp files before testing this candidate
        deleteJobFiles(jobId, outputDir, tempDir);

        try {
          job.youtubeUrl = candidate.url;
          activeJobs.set(jobId, job);
          persistJob(jobId, job);

          const effectiveAiProvider = job.aiProvider || (process.env.ACTIVE_AI_ENGINE === 'gemini' ? 'gemini' : 'openrouter');
          await runStage1Pipeline({
            jobId,
            youtubeUrl: candidate.url,
            shopeeLink: job.shopeeLink,
            productTitle: targetTitle,
            productDescription: job.productDescription,
            apiKey: undefined,
            options: {
              aiProvider: effectiveAiProvider,
              autoSearchFallback: false,
              ttsProvider: run.ttsProvider || job.ttsProvider || process.env.TTS_PROVIDER || 'gemini_tts',
              ttsModel: run.ttsModel || job.ttsModel || process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL,
              ttsFallbackModel: run.ttsFallbackModel || job.ttsFallbackModel || process.env.GEMINI_TTS_FALLBACK_MODEL || DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
              ttsVoice: run.ttsVoice || job.ttsVoice || process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE,
              geminiApiKey: run.geminiApiKey || job.geminiApiKey || process.env.GEMINI_API_KEY,
            },
            requireCleanGeminiPlan: true,
            onProgress: (p) => updateJobProgress(jobId, {
              ...p,
              status: 'running',
              isAutoRetrying: true,
              attemptCount: run.attemptCount,
              message: `[Percobaan ke-${run.attemptCount}] ${p.message || ''}`
            }),
          });

          foundSuccess = true;
          run.status = 'completed';
          run.message = `✅ Auto Retry berhasil pada percobaan ke-${run.attemptCount}! Video cocok persis & 100% faceless selesai.`;
          run.updatedAt = new Date().toISOString();
          console.log(`[AutoRetry ${jobId}] BERHASIL pada percobaan ke-${run.attemptCount} dengan video: ${candidate.url}`);
          break;
        } catch (candErr) {
          console.warn(`[AutoRetry ${jobId}] Kandidat ke-${run.attemptCount} (${candidate.url}) ditolak/gagal: ${candErr.message}`);
          deleteJobFiles(jobId, outputDir, tempDir);
          updateJobProgress(jobId, {
            step: 'auto_retry_next',
            message: `[Percobaan ke-${run.attemptCount} Ditolak] ${candErr.message.slice(0, 80)}... Mencoba kandidat berikutnya...`,
            progress: 10,
            status: 'running',
            isAutoRetrying: true,
            attemptCount: run.attemptCount,
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      if (foundSuccess) break;
      if (run.status === 'stopping' || run.status === 'stopped') break;

      // Jitter delay between search query batches to prevent YouTube scraping blocks
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (run.status === 'stopping' || run.status === 'stopped') {
      run.status = 'stopped';
      run.message = `Auto Retry dihentikan oleh pengguna setelah ${run.attemptCount} percobaan.`;
      run.updatedAt = new Date().toISOString();
      console.log(`[AutoRetry ${jobId}] Dihentikan oleh user.`);
      updateJobProgress(jobId, {
        step: 'auto_retry_stopped',
        message: run.message,
        progress: 100,
        status: 'completed',
        isAutoRetrying: false,
      });
    } else if (foundSuccess) {
      updateJobProgress(jobId, {
        step: 'completed',
        message: `🎉 Video Final 9:16 + Voiceover Gadis Indonesia & Subtitle Selesai (Auto Retry Berhasil)!`,
        progress: 100,
        status: 'completed',
        isAutoRetrying: false,
        result: activeJobs.get(jobId),
      });
    } else if (run.status === 'error') {
      updateJobProgress(jobId, {
        step: 'error',
        message: run.message,
        progress: 100,
        status: 'error',
        error: run.message,
        isAutoRetrying: false,
      });
    }
  } catch (workerErr) {
    console.error(`[AutoRetry ${jobId}] Fatal worker error:`, workerErr);
    run.status = 'error';
    run.message = workerErr.message;
    run.updatedAt = new Date().toISOString();
    updateJobProgress(jobId, {
      step: 'error',
      message: `Auto Retry gagal: ${workerErr.message}`,
      status: 'error',
      error: workerErr.message,
      isAutoRetrying: false,
    });
  }
}

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

  const interval = setInterval(() => {
    const latest = jobProgress.get(jobId);
    if (latest) {
      sendProgress(latest);
      if (latest.status === 'completed' || latest.status === 'error' || latest.status === 'awaiting_voiceover') {
        clearInterval(interval);
        res.end();
      }
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ─── Stage 1 Pipeline Engine ─────────────────────────────────────────────────

export async function runStage1Pipeline({
  jobId,
  youtubeUrl,
  shopeeLink,
  productTitle,
  productDescription,
  apiKey,
  options = {},
  extraJobMeta = {},
  requireCleanGeminiPlan = true,
  onProgress = null,
}) {
  const sessionTempDir = path.join(tempDir, `job_${jobId}`);
  const rawFramesDir = path.join(sessionTempDir, 'raw_frames');
  const trimmedFramesDir = path.join(sessionTempDir, 'trimmed_frames');
  const silentFileName = `silent_clip_${jobId}.mp4`;
  const silentOutputPath = path.join(outputDir, silentFileName);

  if (!fs.existsSync(sessionTempDir)) fs.mkdirSync(sessionTempDir, { recursive: true });

  const updateProgress = onProgress || ((data) => {
    const payload = typeof data === 'string'
      ? { step: 'processing', message: data, progress: 50, jobId }
      : { ...data, jobId };
    jobProgress.set(jobId, payload);
    console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message}`);
  });

  const productInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreProductNoun = productInfo.coreProductNoun || productTitle || 'Produk Praktis';
  const cleanProductTitle = productInfo.cleanTitle || productTitle || '';

  if (isBulkyOrUnsuitableProduct(productTitle) || isBulkyOrUnsuitableProduct(coreProductNoun) || isBulkyOrUnsuitableProduct(cleanProductTitle)) {
    const rejectReason = `Niche dibatasi hanya untuk alat dapur praktis. Produk "${coreProductNoun || productTitle}" tergolong perabot besar / rak besar yang dilarang.`;
    console.warn(`[Pipeline] ⛔ ${rejectReason}`);
    updateProgress({
      step: 'rejected_bulky',
      message: rejectReason,
      progress: 0,
      status: 'error',
      error: rejectReason,
    });
    throw new Error(rejectReason);
  }

  let effectiveProductImage = options.productImage || extraJobMeta?.productImage || '';
  if (!effectiveProductImage && shopeeLink && isShopeeProductUrl(shopeeLink)) {
    try {
      const shopeeMeta = await fetchShopeePageMeta(shopeeLink);
      if (shopeeMeta && shopeeMeta.imageUrl) {
        effectiveProductImage = shopeeMeta.imageUrl;
      }
    } catch {}
  }

  const jobMeta = {
    jobId,
    stage: 'running',
    productTitle: productTitle || '',
    cleanProductTitle,
    coreProductNoun,
    productCategory: productInfo.category || 'general_gadget',
    productDescription: productDescription || '',
    productImage: effectiveProductImage || '',
    youtubeUrl: youtubeUrl || '',
    shopeeLink: shopeeLink || '',
    createdAt: new Date().toISOString(),
    isOrphan: false,
    ...extraJobMeta,
  };
  activeJobs.set(jobId, jobMeta);
  persistJob(jobId, jobMeta);
  if (productTitle) {
    markKeywordAsUsed(productTitle, { productTitle, jobId, source: 'stage1_pipeline' });
  }
  if (coreProductNoun && coreProductNoun !== productTitle) {
    markKeywordAsUsed(coreProductNoun, { productTitle, jobId, source: 'stage1_pipeline' });
  }

  updateProgress({
    step: 'start',
    message: `Menyiapkan pembuatan video affiliate untuk "${coreProductNoun}"...`,
    progress: 5,
    status: 'running',
    coreProductNoun,
  });

  let rawVideoPath = null;
  let videoMeta = { title: productTitle || 'Product Video', duration: 60 };

  try {

    const existingVideoInTemp = (() => {
      try {
        if (fs.existsSync(sessionTempDir)) {
          const files = fs.readdirSync(sessionTempDir).filter(f =>
            (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv')) &&
            !f.startsWith('voiceover')
          );
          if (files.length > 0) {
            const fullPath = path.join(sessionTempDir, files[0]);
            if (fs.statSync(fullPath).size > 5 * 1024 * 1024) return fullPath;
          }
        }
      } catch {}
      return null;
    })();

    const existingJob = activeJobs.get(jobId);
    const cachedVideoPath = existingVideoInTemp ||
      (existingJob?.downloadedVideoPath && fs.existsSync(existingJob.downloadedVideoPath) && isVideoFilePath(existingJob.downloadedVideoPath)
        ? existingJob.downloadedVideoPath
        : null);

    let previewVideoPath = null;

    if (cachedVideoPath) {
      const cachedDims = await getVideoDimensions(cachedVideoPath);
      if (cachedDims && cachedDims.is1080pOrHigher) {
        rawVideoPath = cachedVideoPath;
        updateProgress({
          step: 'download',
          message: `Video 1080p sudah ada (${(fs.statSync(rawVideoPath).size / 1024 / 1024).toFixed(1)} MB). Skip download, langsung proses.`,
          progress: 30,
          status: 'running'
        });
      } else {
        // Hapus cache video lama jika di bawah 1080p agar tidak tercampur
        try { fs.unlinkSync(cachedVideoPath); } catch {}
        cachedVideoPath = null;
      }
    }

    const envEngine = (process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
    const rawOpenRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
    const openRouterKeySet = Boolean(rawOpenRouterKey && !rawOpenRouterKey.startsWith('your_') && !rawOpenRouterKey.endsWith('_here'));
    const rawGeminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    const geminiKeySet = Boolean(rawGeminiKey && !rawGeminiKey.startsWith('your_') && !rawGeminiKey.endsWith('_here'));
    const defaultProvider = envEngine === 'openrouter'
      ? 'openrouter'
      : (geminiKeySet ? 'gemini' : (openRouterKeySet ? 'openrouter' : 'gemini'));
    const aiProvider = options.aiProvider || jobMeta.aiProvider || defaultProvider;
    const sceneDuration = Number(options.sceneDuration) || 3.3;

    let currentYoutubeUrl = youtubeUrl;
    let highlight = null;
    let approved = false;
    let lastRejectionError = null;

    const usedVids = getAllUsedYouTubeVideoIds();
    const initialVid = extractVideoId(currentYoutubeUrl);
    if (initialVid) usedVids.add(initialVid);

    // Helper untuk mengevaluasi kandidat video menggunakan Funneling 3 Tahap (Hemat kuota & token AI):
    // Tahap 1: Metadata Pre-Filter (0 kuota video, 0 token AI)
    // Tahap 2: Sampling 30 frame langsung dari stream URL via FFmpeg & Analisa Lokal 9:16 (~2MB kuota, 0 token AI)
    // Tahap 3: Verifikasi AI Vision (Quality Assurance Final, detail: 'low')
    const evaluateCandidate = async (targetUrl, candidateLabel = '', candidateExtra = {}) => {
      // 1. Bersihkan frame lama agar tidak tertumpuk
      if (fs.existsSync(rawFramesDir)) {
        try {
          const oldFiles = fs.readdirSync(rawFramesDir);
          for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(rawFramesDir, f)); } catch {}
          }
        } catch {}
      }

      // ── TAHAP 1: FILTER KASAR METADATA (0 KUOTA, 0 TOKEN AI) ──
      const metaMsg = candidateLabel
        ? `[${candidateLabel}] [Filter 1/3] Membaca durasi, CC & metadata video (0 download)...`
        : '[Filter 1/3] Membaca durasi, CC & metadata video tanpa download...';
      updateProgress({ step: 'metadata_qc', message: metaMsg, progress: 12, status: 'running' });

      const { metadata: meta, streamUrl } = await fetchVideoMetadataAndStream(targetUrl, {
        onProgress: updateProgress,
      });

      const isVisualMode = Boolean(
        options.isVisualSearch ||
        options.imageUrl ||
        options.productImage ||
        effectiveProductImage ||
        extraJobMeta?.isVisualSearch ||
        options.isVideoFirst ||
        candidateExtra?.isVisualSearch ||
        candidateExtra?.source === 'bing_visual_search' ||
        candidateExtra?.source === 'visual_ai_query'
      );

      const compliance = checkVideoMetadataCompliance(meta, productTitle, {
        ...options,
        isVisualSearch: isVisualMode,
        productImage: effectiveProductImage,
        imageUrl: effectiveProductImage,
      });
      if (!compliance.eligible) {
        trackSavedBandwidth(35 * 1024 * 1024, `Hemat kuota (Filter 1 Metadata): ${compliance.reason}`);
        console.warn(`[Job ${jobId}] ⛔ [Filter 1/3 Ditolak] ${candidateLabel || targetUrl}: ${compliance.reason}`);
        const metaErr = new Error(`Metadata video ditolak: ${compliance.reason}`);
        metaErr.isAiRejection = true;
        metaErr.rejectionReason = compliance.reason;
        throw metaErr;
      }

      console.log(`[Job ${jobId}] ✅ [Filter 1/3 Lolos] Metadata valid (${meta.title}, ${meta.duration}s).`);

      // ── TAHAP 2: SAMPLING CEPAT & INSPEKSI VISUAL LOKAL (0 TOKEN AI, HEMAT KUOTA GEMINI) ──
      // Verifikasi bumper statis, logo channel statis, grafis animasi overlay, teks mengambang, subtitle & wajah lokal
      let preSampledFrames = null;
      let candidateIntroCutoff = 0;
      let activeStreamUrl = streamUrl;
      let sampled = null;
      let sampleAttempts = 0;
      const maxSampleAttempts = 2; // Coba lagi jika ekstraksi frame pertama gagal

      while (sampleAttempts < maxSampleAttempts && (!sampled || sampled.length < 5)) {
        sampleAttempts++;
        try {
          const sampleMsg = sampleAttempts > 1
            ? `[${candidateLabel || 'Filter 2/3'}] Percobaan ulang (${sampleAttempts}/${maxSampleAttempts}) ekstraksi frame visual dari stream URL...`
            : (candidateLabel
                ? `[${candidateLabel}] [Filter 2/3] Verifikasi visual lokal (bumper, logo, grafis, teks & wajah)...`
                : '[Filter 2/3] Verifikasi visual lokal (bumper, logo, grafis, teks & wajah)...');
          updateProgress({ step: 'stream_sampling', message: sampleMsg, progress: 28, status: 'running' });

          // Pada percobaan ulang (attempt > 1), coba refresh streamUrl
          if (sampleAttempts > 1) {
            console.log(`[Job ${jobId}] Ekstraksi frame pertama gagal/kurang frame. Mencoba lagi (percobaan ${sampleAttempts}/${maxSampleAttempts})...`);
            await new Promise((r) => setTimeout(r, 1000));
            try {
              const refreshed = await fetchVideoMetadataAndStream(targetUrl, { onProgress: () => {} });
              if (refreshed?.streamUrl) activeStreamUrl = refreshed.streamUrl;
            } catch (refErr) {
              console.warn(`[Job ${jobId}] Refresh stream URL gagal: ${refErr.message}`);
            }
          }

          if (activeStreamUrl) {
            const res = await sampleFramesFromStream(activeStreamUrl, rawFramesDir, {
              duration: meta.duration,
              maxSampleFrames: 30,
              onProgress: updateProgress,
            });
            if (res?.frames && res.frames.length >= 5) {
              sampled = res.frames;
            }
          }
        } catch (sampleErr) {
          console.warn(`[Job ${jobId}] Ekstraksi frame (percobaan ${sampleAttempts}/${maxSampleAttempts}) gagal: ${sampleErr.message}`);
        }
      }

      // Sesuai instruksi: Jika frame gagal diekstrak setelah dicoba ulang,
      // JANGAN LANGSUNG DIALIHKAN KE AI ANALISNYA! Tolak kandidat ini agar sistem mencari video lainnya.
      if (!sampled || sampled.length < 5) {
        console.warn(`[Job ${jobId}] ⛔ Gagal mengekstrak frame visual (${sampled?.length || 0} frame) setelah ${sampleAttempts}x percobaan. Menolak video dan mencari video lainnya...`);
        const frameFailErr = new Error(`Ekstraksi frame visual gagal (${sampled?.length || 0} frame) setelah ${sampleAttempts}x percobaan. Mencari video lainnya...`);
        frameFailErr.isAiRejection = true;
        frameFailErr.rejectionReason = 'Ekstraksi frame visual gagal (stream video tidak dapat dibaca).';
        throw frameFailErr;
      }

      preSampledFrames = sampled;
      const localCheck = inspectFramesLocally(sampled, {
        aspectRatio: options.aspectRatio || '9:16',
        onProgress: updateProgress,
      });

      if (!localCheck.eligible) {
        trackSavedBandwidth(35 * 1024 * 1024, `Hemat kuota (Filter 2 Lokal): ${localCheck.reason}`);
        console.warn(`[Job ${jobId}] ⛔ [Filter 2/3 Ditolak Lokal] ${candidateLabel || targetUrl}: ${localCheck.reason}`);
        const localErr = new Error(`Analisa lokal ditolak: ${localCheck.reason}`);
        localErr.isAiRejection = true;
        localErr.rejectionReason = localCheck.reason;
        throw localErr;
      }
      if (localCheck.hasOpeningIntro) {
        candidateIntroCutoff = localCheck.introCutoffSec || 5.0;
        console.log(`[Job ${jobId}] ℹ️ Intro bumper pembuka terdeteksi (${candidateIntroCutoff}s). AI & backend akan membuang detik awal ini.`);
      }
      console.log(`[Job ${jobId}] ✅ [Filter 2/3 Lolos] Frame visual valid. Verifikasi grafis visual, logo, subtitle, faceless & kecocokan produk diserahkan ke AI Vision.`);

      // ── JALUR 1: GOOGLE GEMINI NATIVE YOUTUBE STREAM (0 MB KUOTA LOKAL, 1.500 REQ/HARI) ──
      const reqEngine = (options.aiProvider || aiProvider || process.env.ACTIVE_AI_ENGINE || '').toLowerCase();
      const isGeminiEngine = reqEngine === 'gemini' || reqEngine === 'gemini_direct' || (process.env.GEMINI_API_KEY && reqEngine !== 'openrouter');
      const hasGeminiKey = Boolean(getDirectGeminiApiKey(apiKey));

      if (isGeminiEngine && hasGeminiKey && (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be'))) {
        const streamMsg = candidateLabel
          ? `[${candidateLabel}] [Gemini Stream] Google Gemini 3.6 Flash menganalisa video langsung dari YouTube (0 MB kuota lokal)...`
          : '[Gemini Stream] Google Gemini 3.6 Flash menganalisa video langsung dari YouTube (0 MB kuota lokal)...';
        updateProgress({ step: 'gemini_vision', message: streamMsg, progress: 38, status: 'running' });

        const hl = await analyzeYouTubeVideoWithGemini({
          youtubeUrl: targetUrl,
          apiKey,
          productTitle,
          productDescription,
          productImage: effectiveProductImage,
          shopeeLink,
          sceneDuration,
          allowFallbackClips: !requireCleanGeminiPlan,
          totalDuration: meta.duration,
          introCutoffSec: candidateIntroCutoff,
          isVideoFirst: Boolean(options.isVideoFirst),
          onProgress: updateProgress,
        });

        if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
          const noClipErr = new Error('Gemini tidak menemukan cuplikan produk yang memenuhi syarat (wajib faceless, tanpa watermark 9:16, tanpa subtitle).');
          noClipErr.isAiRejection = true;
          noClipErr.rejectionReason = 'Tidak ditemukan cuplikan bersih yang memenuhi syarat.';
          throw noClipErr;
        }

        // Pastikan backend membuang intro pembuka jika terdeteksi
        if (candidateIntroCutoff > 0 && Array.isArray(hl.clips)) {
          hl.clips = hl.clips.map(c => {
            if (c.startSeconds < candidateIntroCutoff) {
              const newStart = Math.min(meta.duration - c.duration, candidateIntroCutoff);
              return { ...c, startSeconds: newStart, startTime: formatSeconds(newStart), endTime: formatSeconds(newStart + c.duration) };
            }
            return c;
          });
        }

        console.log(`[Job ${jobId}] 🎉 [Gemini Stream Lolos] AI menyetujui video langsung dari YouTube! Ditemukan ${hl.clips.length} cuplikan produk bersih.`);
        return { highlight: hl, videoMeta: meta, previewVideoPath: null };
      }

      // ── JALUR 2: OPENROUTER / STREAM SAMPLING LOKAL DENGAN 20 KEYFRAME ──
      let rawFrames = preSampledFrames;
      if (!rawFrames || rawFrames.length < 5) {
        const sampleMsg = candidateLabel
          ? `[${candidateLabel}] [Filter 2/3] Sampling 30 keyframe dari stream URL (~1MB kuota)...`
          : '[Filter 2/3] Sampling 30 keyframe langsung dari stream URL YouTube...';
        updateProgress({ step: 'stream_sampling', message: sampleMsg, progress: 28, status: 'running' });

        const sampleRes = await sampleFramesFromStream(streamUrl, rawFramesDir, {
          duration: meta.duration,
          maxSampleFrames: 30,
          onProgress: updateProgress,
        });
        rawFrames = sampleRes.frames;
      }

      if (!rawFrames || rawFrames.length < 5) {
        const frameErr = new Error(`Video tidak memiliki cukup frame visual (${rawFrames?.length || 0} frames).`);
        frameErr.isAiRejection = true;
        frameErr.rejectionReason = 'Frame video tidak mencukupi untuk dianalisa.';
        throw frameErr;
      }

      // ── TAHAP 3: VERIFIKASI AI VISION (QUALITY ASSURANCE FINAL) ──
      const visionMsg = candidateLabel
        ? `[${candidateLabel}] [Filter 3/3] AI (${aiProvider}) verifikasi produk & QC bebas wajah...`
        : `[Filter 3/3] AI (${aiProvider}) menganalisa frame produk dan menentukan cuplikan terbaik...`;
      updateProgress({ step: 'gemini_vision', message: visionMsg, progress: 48, status: 'running' });

      const hl = await selectHighlightWithAI({
        apiKey,
        aiProvider,
        frames: rawFrames,
        videoPath: null,
        youtubeUrl: targetUrl,
        videoMetadata: meta,
        productTitle,
        productDescription,
        productImage: effectiveProductImage,
        shopeeLink,
        sceneDuration,
        allowFallbackClips: !requireCleanGeminiPlan,
        introCutoffSec: candidateIntroCutoff,
        isVideoFirst: Boolean(options.isVideoFirst),
        onProgress: updateProgress,
      });

      if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
        const noClipErr = new Error('AI tidak menemukan cuplikan produk yang memenuhi syarat (wajib faceless, tanpa watermark, tanpa logo sosmed/channel, dan tanpa subtitle).');
        noClipErr.isAiRejection = true;
        noClipErr.rejectionReason = 'Tidak ditemukan cuplikan bersih yang memenuhi syarat.';
        throw noClipErr;
      }

      // Pastikan backend membuang intro pembuka jika terdeteksi
      if (candidateIntroCutoff > 0 && Array.isArray(hl.clips)) {
        hl.clips = hl.clips.map(c => {
          if (c.startSeconds < candidateIntroCutoff) {
            const newStart = Math.min(meta.duration - c.duration, candidateIntroCutoff);
            return { ...c, startSeconds: newStart, startTime: formatSeconds(newStart), endTime: formatSeconds(newStart + c.duration) };
          }
          return c;
        });
      }

      console.log(`[Job ${jobId}] 🎉 [Filter 3/3 Lolos] AI menyetujui video! Ditemukan ${hl.clips.length} cuplikan produk bersih.`);
      return { highlight: hl, videoMeta: meta, previewVideoPath: null };
    };

    // Evaluasi video dari cache jika tersedia
    if (rawVideoPath) {
      try {
        const rawDur = Number(videoMeta?.duration) || 300;
        const rawInterval = Math.max(1, Math.floor(rawDur / 30));
        updateProgress({ step: 'frames_raw', message: `Mengekstrak 30 frame video 1080p untuk analisa AI (interval ${rawInterval}s)...`, progress: 38, status: 'running' });
        const { frames: rawFrames } = await extractFrames(rawVideoPath, rawFramesDir, updateProgress, {
          sampleIntervalSec: rawInterval,
          maxSampleFrames: 30,
          duration: rawDur,
        });

        // Verifikasi filter lokal pada frame video cache (bebas teks mengambang & bebas wajah)
        const localCacheCheck = inspectFramesLocally(rawFrames, {
          aspectRatio: options.aspectRatio || '9:16',
          onProgress: updateProgress,
        });
        if (!localCacheCheck.eligible) {
          console.warn(`[Job ${jobId}] ⛔ [Cache Ditolak Lokal] ${rawVideoPath}: ${localCacheCheck.reason}`);
          const localCacheErr = new Error(`Analisa lokal ditolak pada cache: ${localCacheCheck.reason}`);
          localCacheErr.isAiRejection = true;
          localCacheErr.rejectionReason = localCacheCheck.reason;
          throw localCacheErr;
        }

        highlight = await selectHighlightWithAI({
          apiKey,
          aiProvider,
          frames: rawFrames,
          videoPath: rawVideoPath,
          videoMetadata: videoMeta,
          productTitle,
          productDescription,
          productImage: effectiveProductImage,
          shopeeLink,
          sceneDuration,
          allowFallbackClips: !requireCleanGeminiPlan,
          isVideoFirst: Boolean(options.isVideoFirst),
          onProgress: updateProgress,
        });
        if (!highlight || !Array.isArray(highlight.clips) || highlight.clips.length === 0) {
          const noClipErr = new Error('AI tidak menemukan cuplikan produk yang memenuhi syarat pada cache video.');
          noClipErr.isAiRejection = true;
          noClipErr.rejectionReason = 'Tidak ditemukan cuplikan bersih pada cache.';
          throw noClipErr;
        }
        approved = true;
      } catch (cacheEvalErr) {
        if (cacheEvalErr.isAiRejection || String(cacheEvalErr?.message || '').toLowerCase().includes('ditolak')) {
          console.warn(`[Job ${jobId}] Cached video 1080p ditolak AI: ${cacheEvalErr.message}. Menghapus cache dan mencoba online...`);
          try { fs.unlinkSync(rawVideoPath); } catch {}
          rawVideoPath = null;
        } else {
          throw cacheEvalErr;
        }
      }
    }

    // Evaluasi video YouTube awal jika belum disetujui dari cache
    if (!approved && currentYoutubeUrl) {
      try {
        const initialRes = await evaluateCandidate(currentYoutubeUrl, '', {
          isVisualSearch: Boolean(effectiveProductImage),
        });
        highlight = initialRes.highlight;
        videoMeta = initialRes.videoMeta;
        previewVideoPath = initialRes.previewVideoPath;
        approved = true;
      } catch (initErr) {
        if (initErr.isAiRejection || String(initErr?.message || '').toLowerCase().includes('ditolak')) {
          console.warn(`[Job ${jobId}] ⛔ Video awal (${currentYoutubeUrl}) ditolak AI: ${initErr.message}`);
          lastRejectionError = initErr;
          try { if (previewVideoPath && fs.existsSync(previewVideoPath)) fs.unlinkSync(previewVideoPath); } catch {}
          previewVideoPath = null;
        } else {
          throw initErr;
        }
      }
    }

    // Jika video awal ditolak oleh AI: Jalankan Auto Search Fallback untuk mencari kandidat video baru!
    if (!approved) {
      const allowAutoSearch = options.autoSearchFallback !== false && Boolean(productTitle);
      if (!allowAutoSearch) {
        throw lastRejectionError || new Error('Video ditolak oleh AI.');
      }

      const engineName = aiProvider === 'gemini' ? 'Google Gemini Direct' : 'AI';
      updateProgress({
        step: 'auto_search_fallback',
        message: `⛔ Video awal ditolak AI (${lastRejectionError?.rejectionReason || 'tidak cocok'}). ${engineName} mencari video YouTube baru untuk target "${coreProductNoun}"...`,
        progress: 15,
        status: 'running',
        coreProductNoun,
      });

      console.log(`[Job ${jobId}] Memulai pencarian kandidat YouTube baru untuk "${productTitle}" karena video awal ditolak...`);

      let searchIteration = 0;
      let targetCandidates = [];

      // 1. Prioritas Visual Search: Jika URL foto produk tersedia, cari video berbasis gambar!
      if (effectiveProductImage) {
        try {
          updateProgress({
            step: 'auto_search_fallback',
            message: `Mencari video pengganti via pencarian visual gambar produk...`,
            progress: 18,
            status: 'running',
            coreProductNoun,
          });
          console.log(`[Job ${jobId}] Mencari kandidat video via Visual Image Search: ${effectiveProductImage}`);
          const visualCandidates = await searchVideosByProductImage({
            imageUrl: effectiveProductImage,
            productTitle,
            productDescription,
            limit: 10,
            excludeVideoIds: usedVids,
            onProgress: (p) => updateProgress({ ...p, status: 'running' }),
          });
          if (visualCandidates && visualCandidates.length > 0) {
            targetCandidates = visualCandidates;
            console.log(`[Job ${jobId}] ✅ Ditemukan ${visualCandidates.length} kandidat video dari pencarian visual gambar!`);
          }
        } catch (vErr) {
          console.warn(`[Job ${jobId}] Pencarian visual gambar dilewati: ${vErr.message}`);
        }
      }

      // 2. Fallback Multi-Engine Keyword Search jika visual search belum menemukan kandidat
      while (searchIteration < 2 && targetCandidates.length === 0) {
        const fresh = await discoverYouTubeCandidatesForProduct({
          productTitle,
          productDescription,
          limit: 8,
          excludeVideoIds: usedVids,
          searchIteration,
          onProgress: (p) => updateProgress({ ...p, status: 'running' }),
        });
        if (fresh && fresh.length > 0) {
          targetCandidates = fresh;
        }
        searchIteration++;
      }

      if (!targetCandidates || targetCandidates.length === 0) {
        throw new Error(`Video awal ditolak AI (${lastRejectionError?.rejectionReason || 'tidak cocok'}), dan tidak ditemukan video YouTube pengganti baru untuk "${productTitle}".`);
      }

      console.log(`[Job ${jobId}] Menemukan ${targetCandidates.length} kandidat video YouTube baru. Menguji satu per satu...`);

      for (let i = 0; i < targetCandidates.length; i++) {
        const candidate = targetCandidates[i];
        const candVid = extractVideoId(candidate.url) || candidate.id;
        if (candVid) usedVids.add(candVid);

        const candLabel = `Kandidat ${i + 1}/${targetCandidates.length}`;
        updateProgress({
          step: 'download',
          message: `[${candLabel}] Menguji video pengganti: "${(candidate.title || productTitle).slice(0, 35)}..."`,
          progress: 16 + Math.round((i / targetCandidates.length) * 20),
          status: 'running',
        });

        try {
          const candRes = await evaluateCandidate(candidate.url, candLabel, candidate);
          highlight = candRes.highlight;
          videoMeta = candRes.videoMeta;
          previewVideoPath = candRes.previewVideoPath;
          currentYoutubeUrl = candidate.url;
          approved = true;

          console.log(`[Job ${jobId}] ✅ ${candLabel} (${candidate.url}) DISETUJUI OLEH AI! Melanjutkan ke download 1080p...`);

          // Update metadata job dengan link YouTube baru yang berhasil disetujui AI
          jobMeta.youtubeUrl = currentYoutubeUrl;
          jobMeta.videoTitle = candidate.title || videoMeta.title;
          activeJobs.set(jobId, jobMeta);
          persistJob(jobId, jobMeta);
          break;
        } catch (candErr) {
          console.warn(`[Job ${jobId}] ❌ ${candLabel} (${candidate.url}) ditolak AI: ${candErr.message}`);
          lastRejectionError = candErr;
          try { if (previewVideoPath && fs.existsSync(previewVideoPath)) fs.unlinkSync(previewVideoPath); } catch {}
          previewVideoPath = null;
          updateProgress({
            step: 'auto_search_next',
            message: `⛔ ${candLabel} ditolak AI (${(candErr.rejectionReason || candErr.message).slice(0, 60)}...). Mencoba kandidat berikutnya...`,
            progress: 18 + Math.round((i / targetCandidates.length) * 20),
            status: 'running',
          });
        }
      }

      if (!approved) {
        throw new Error(`Semua kandidat video YouTube (${targetCandidates.length} video) ditolak oleh AI untuk "${productTitle}": ${lastRejectionError?.rejectionReason || 'tidak memenuhi syarat faceless / produk tidak cocok'}.`);
      }
    }

    // TAHAP 2: AI telah menyetujui video! Backend langsung mengunduh video 1080p Full HD asli dari YouTube untuk rendering
    if (!rawVideoPath) {
      updateProgress({ step: 'download_hd', message: '✅ Video disetujui AI! Mengunduh kualitas 1080p Full HD langsung dari YouTube...', progress: 55, status: 'running' });
      try {
        const hdDl = await downloadYouTubeVideo(currentYoutubeUrl, sessionTempDir, jobId, updateProgress, { quality: '1080p', prefix: 'raw' });
        if (!hdDl || !hdDl.filePath || !fs.existsSync(hdDl.filePath)) {
          throw new Error('File video 1080p tidak ditemukan setelah download.');
        }

        const hdDims = await getVideoDimensions(hdDl.filePath);
        const isStrict1080p = hdDims && hdDims.is1080pOrHigher;
        if (!isStrict1080p) {
          try { fs.unlinkSync(hdDl.filePath); } catch {}
          throw new Error(`Resolusi video YouTube (${hdDims?.width}x${hdDims?.height}) tidak memenuhi standar minimal 1080p Full HD ke atas.`);
        }

        console.log(`[Job ${jobId}] ✅ Video 1080p+ Full HD asli berhasil diunduh (${hdDims.width}x${hdDims.height}). Menggantikan preview 360p.`);
        rawVideoPath = hdDl.filePath;

        // Hapus file preview 360p agar tidak memakan ruang penyimpanan HP dan tidak tertukar
        try {
          if (previewVideoPath && fs.existsSync(previewVideoPath) && previewVideoPath !== rawVideoPath) {
            fs.unlinkSync(previewVideoPath);
          }
        } catch {}
      } catch (hdErr) {
        console.error(`[Job ${jobId}] ❌ Gagal mengunduh video 1080p Full HD dari YouTube: ${hdErr.message}`);
        // Wajib lempar error dan BATALKAN render jika 1080p gagal, TIDAK BOLEH render video 360p!
        throw new Error(`Gagal mengunduh video kualitas 1080p Full HD langsung dari YouTube untuk rendering: ${hdErr.message}`);
      }

      const updatedMeta = { ...jobMeta, downloadedVideoPath: rawVideoPath, stage: 'downloaded' };
      activeJobs.set(jobId, updatedMeta);
      persistJob(jobId, updatedMeta);
    }

    const isBrandDetected = highlight.hasProductBrand === true ||
      (Array.isArray(highlight.clips) && highlight.clips.some(c => c.hasProductBrand === true));
    const requestedHflip = options.hflip !== undefined ? Boolean(options.hflip) : false;
    const effectiveHflip = (isBrandDetected || highlight.allowHflip === false) ? false : requestedHflip;

    if (isBrandDetected && requestedHflip) {
      console.log(`[Job ${jobId}] Merek/Logo produk terdeteksi ("${highlight.detectedBrand || 'Brand'}"). Video mirror (H-Flip) dinonaktifkan otomatis agar logo/merek produk tidak terbalik.`);
    }

    const renderMessage = isBrandDetected
      ? `Rendering ${highlight.clips.length} cuplikan produk (${highlight.duration.toFixed(1)}s) [Mirror H-Flip OFF: Merek "${highlight.detectedBrand || 'Terdeteksi'}"]...`
      : `Rendering ${highlight.clips.length} AI-selected fast product shots (${highlight.duration.toFixed(1)}s)...`;

    const effectiveRenderMode = options.renderMode || highlight.reframe?.renderMode || 'stage_80';
    const effectiveReframe = {
      ...(highlight.reframe || {}),
      renderMode: effectiveRenderMode,
    };

    updateProgress({ step: 'render_silent', message: renderMessage, progress: 62, status: 'running' });
    await renderSilentAntiDetectionVideo({
      inputVideo: rawVideoPath, startTime: highlight.startTime,
      endTime: highlight.endTime, outputVideo: silentOutputPath,
      clips: highlight.clips,
      hflip: effectiveHflip,
      speedMultiplier: options.speedMultiplier || 1,
      reframe: effectiveReframe,
      onProgress: updateProgress,
    });

    updateProgress({ step: 'frames_trimmed', message: 'Sampling frames from trimmed video for AI scripting...', progress: 72, status: 'running' });
    const { frames: trimmedFrames } = await extractFrames(silentOutputPath, trimmedFramesDir, updateProgress, {
      sampleIntervalSec: 3,
      maxSampleFrames: 6,
    });

    updateProgress({ step: 'gpt_scripting', message: 'AI generating Kotak Scene, Context, Naskah...', progress: 80, status: 'running' });
    let scriptData;
    try {
      scriptData = await generateAdAdvisorScriptWithAI({
        apiKey,
        aiProvider,
        trimmedFrames,
        videoMetadata: videoMeta,
        productTitle,
        productDescription,
        shopeeLink,
        productHook: highlight.productHook,
        segmentDuration: highlight.duration,
        sceneDuration,
        onProgress: updateProgress,
      });
    } catch (scriptErr) {
      console.warn(`[Job ${jobId}] AI Scripting failed (${scriptErr.message}). Menggunakan smart fallback naskah Shopee...`);
      const fallbackHook = highlight.productHook || `Masih repot pakai alat lama yang bikin capek? Untung ada ${productTitle || 'produk ini'}!`;
      const fallbackVoiceScript = `[00:00] ${fallbackHook}
[00:04] Praktis digunakan, kualitas premium, dan bikin kerjaan cepat beres.
[00:09] Bahannya tebal, awet, dan nyaman dipakai sehari-hari.
[00:14] Harganya murah meriah banget, gak bikin kantong jebol!
[00:18] Langsung checkout di keranjang pojok kiri bawah sekarang juga!`;

      scriptData = {
        sampleContext: {
          productName: productTitle || videoMeta?.title || 'Produk Pilihan',
          videoDuration: `${Math.round(highlight.duration || 24)} detik`,
          targetAudience: 'Pengguna harian dan pembeli Shopee',
          coreProblem: 'Cara konvensional yang merepotkan dan memakan waktu',
          keyFeatures: ['Praktis & Ringkas', 'Kualitas Teruji', 'Mudah Digunakan'],
          buyingTrigger: 'Harga murah meriah dan solusi instan',
        },
        scenes: [
          {
            sceneNumber: 1,
            timeRange: '00:00 - 00:04',
            visualDescription: 'Demonstrasi pembuka produk',
            voiceover: fallbackHook,
            adAdvisorNotes: 'Hook visual pembuka',
          },
          {
            sceneNumber: 2,
            timeRange: '00:04 - 00:09',
            visualDescription: 'Tampilan produk utama',
            voiceover: 'Praktis digunakan, kualitas premium, dan bikin kerjaan cepat beres.',
            adAdvisorNotes: 'Pengenalan manfaat',
          },
          {
            sceneNumber: 3,
            timeRange: '00:09 - 00:14',
            visualDescription: 'Fitur dan keunggulan',
            voiceover: 'Bahannya tebal, awet, dan nyaman dipakai sehari-hari.',
            adAdvisorNotes: 'Bukti kualitas',
          },
          {
            sceneNumber: 4,
            timeRange: '00:14 - 00:18',
            visualDescription: 'Penawaran harga terbaik',
            voiceover: 'Harganya murah meriah banget, gak bikin kantong jebol!',
            adAdvisorNotes: 'Price appeal',
          },
          {
            sceneNumber: 5,
            timeRange: '00:18 - 00:22',
            visualDescription: 'Ajakan checkout keranjang kuning',
            voiceover: 'Langsung checkout di keranjang pojok kiri bawah sekarang juga!',
            adAdvisorNotes: 'CTA konversi tinggi',
          },
        ],
        voiceoverScript: fallbackVoiceScript,
        aiStudioPrompt: fallbackVoiceScript,
        caption: formatEnrichedCaption({
          caption: '',
          productTitle,
          productDescription,
          platform: 'clipper'
        }),
        lexicon_to_replace: {},
      };
    }

    cleanupTempFiles([], [rawFramesDir, trimmedFramesDir]);

    // ─── TAHAP OTOMATIS: Auto-Match Shopee Link, Voiceover TTS & Subtitle Burning ───
    let effectiveShopeeLink = shopeeLink || '';
    const detectedItemName = highlight.detectedProduct || productTitle || videoMeta?.title || '';
    if (!effectiveShopeeLink || effectiveShopeeLink.includes('/search') || effectiveShopeeLink.includes('localhost')) {
      try {
        updateProgress({ step: 'shopee_match', message: `Mencari link Shopee yang cocok untuk "${detectedItemName.slice(0, 30)}..."...`, progress: 82, status: 'running' });
        const matchedShopeeUrl = await findMatchingShopeeProductUrl(detectedItemName, highlight.detectedBrand, videoMeta?.description || '');
        if (matchedShopeeUrl) {
          effectiveShopeeLink = matchedShopeeUrl;
          console.log(`[Job ${jobId}] ✅ Link Shopee otomatis dicocokkan dengan video: ${effectiveShopeeLink}`);
        }
      } catch (shopeeErr) {
        console.warn(`[Job ${jobId}] Gagal mencari link Shopee pencocokan otomatis:`, shopeeErr.message);
      }
    }

    const rawVoiceScript = scriptData.voiceoverScript || scriptData.aiStudioPrompt || '';
    const voiceoverFileName = `voiceover_${jobId}.mp3`;
    const autoVoiceoverPath = path.join(uploadsDir, voiceoverFileName);
    const silentDurationSec = (await getMediaDurationSec(silentOutputPath)) || highlight.duration || 20;

    const activeTtsProvider = (options.ttsProvider || process.env.TTS_PROVIDER || 'gemini_tts').toLowerCase().trim();
    const isGeminiTts = activeTtsProvider === 'gemini_tts';
    const ttsModelToUse = options.ttsModel || process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL;
    const ttsFallbackModelToUse = options.ttsFallbackModel || process.env.GEMINI_TTS_FALLBACK_MODEL || DEFAULT_GEMINI_TTS_FALLBACK_MODEL;
    const ttsVoiceToUse = options.ttsVoice || process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE;
    const ttsLabel = isGeminiTts
      ? `Gemini Flash (${ttsModelToUse} - ${ttsVoiceToUse})`
      : 'Edge-TTS Gadis';

    updateProgress({
      step: 'tts_generating',
      message: `🎙️ Menghasilkan voice over ${ttsLabel}...`,
      progress: 84,
      status: 'running',
    });

    let ttsSucceeded = false;
    let ttsResult = null;
    for (let ttsAttempt = 0; ttsAttempt < 3; ttsAttempt++) {
      try {
        if (ttsAttempt > 0) {
          console.log(`[Job ${jobId}] Retrying TTS (${ttsLabel}) (attempt ${ttsAttempt + 1})...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        ttsResult = await generateVoiceoverTTS({
          script: scriptData.voiceoverScript || rawVoiceScript,
          outputPath: autoVoiceoverPath,
          targetDurationSec: silentDurationSec,
          provider: activeTtsProvider,
          modelId: ttsModelToUse,
          fallbackModelId: ttsFallbackModelToUse,
          voice: ttsVoiceToUse,
          apiKey: options.geminiApiKey || apiKey || process.env.GEMINI_API_KEY,
          onProgress: (msg) => updateProgress({ step: 'tts_generating', message: `🎙️ ${msg}`, progress: 86, status: 'running' }),
          jobId,
          lexicon: scriptData.lexicon_to_replace || {},
        });
        ttsSucceeded = true;
        break;
      } catch (ttsErr) {
        console.error(`[Job ${jobId}] TTS (${ttsLabel}) Attempt ${ttsAttempt + 1} Error:`, ttsErr.message);
        if (ttsAttempt === 2) {
          console.warn(`[Job ${jobId}] TTS gagal setelah 3 percobaan. Video 1080p tetap disimpan di history sebagai awaiting_voiceover.`);
        }
      }
    }

    if (ttsSucceeded && fs.existsSync(autoVoiceoverPath)) {
      try {
        updateProgress({
          step: 'merge_start',
          message: 'Menggabungkan Voiceover AI & membakar subtitle ke video final 9:16...',
          progress: 90,
          status: 'running',
        });

        const finalFileName = `final_clip_${jobId}.mp4`;
        const finalOutputPath = path.join(outputDir, finalFileName);
        const srtPath = path.join(uploadsDir, `subtitles_${jobId}.ass`);

        const audioDurationSec = await getMediaDurationSec(autoVoiceoverPath);
        const subtitleTargetDuration = Math.max(silentDurationSec, audioDurationSec || 0);

        updateProgress({
          step: 'subtitles',
          message: `Menyinkronkan subtitle narasi (${silentDurationSec.toFixed(1)}s)...`,
          progress: 93,
          status: 'running',
        });
        // Pass structured script and exact word boundaries to guarantee 100% synchronized subtitles
        const scriptForSubtitles = scriptData.voiceoverScript || rawVoiceScript || ttsResult.cleanScript;
        generateSrtSubtitles(scriptForSubtitles, subtitleTargetDuration, srtPath, {
          wordBoundaries: ttsResult.wordBoundaries,
          videoDurationSec: silentDurationSec,
          lexicon: scriptData.lexicon_to_replace || {},
        });

        updateProgress({
          step: 'render_final',
          message: 'Rendering video final 9:16 dengan Voiceover & Subtitles...',
          progress: 95,
          status: 'running',
        });
        await mergeVoiceoverAndBurnSubtitles({
          silentVideoPath: silentOutputPath,
          voiceoverAudioPath: autoVoiceoverPath,
          srtPath,
          outputVideoPath: finalOutputPath,
          targetDurationSec: silentDurationSec,
          onProgress: updateProgress,
        });

        cleanupTempFiles([srtPath]);
        deleteJobTempDirectory(jobId, tempDir);

        const cacheBuster = Date.now();
        const completedResult = {
          ...extraJobMeta,
          jobId,
          stage: 'completed',
          createdAt: jobMeta.createdAt,
          silentFileName,
          silentVideoUrl: `/api/video/${silentFileName}`,
          silentLocalPath: silentOutputPath,
          finalFileName,
          videoUrl: `/api/video/${finalFileName}?t=${cacheBuster}`,
          downloadUrl: `/api/download/${finalFileName}?t=${cacheBuster}`,
          finalLocalPath: finalOutputPath,
          voiceoverAudioUrl: `/api/audio/${voiceoverFileName}?t=${cacheBuster}`,
          ttsVoice: ttsResult.voice || ttsVoiceToUse,
          ttsProvider: ttsResult.provider || activeTtsProvider,
          ttsModel: ttsResult.modelId || ttsModelToUse,
          ttsFallbackModel: ttsFallbackModelToUse,
          cleanScript: ttsResult.cleanScript,
          wordBoundaries: ttsResult.wordBoundaries || [],
          downloadedVideoPath: null,
          hasDownloadedVideo: false,
          hasFinalVideo: true,
          hasSilentVideo: true,
          productTitle: highlight.detectedProduct || productTitle || videoMeta.title,
          productDescription: productDescription || '',
          youtubeUrl,
          shopeeLink: effectiveShopeeLink || shopeeLink || '',
          highlight: {
            startTime: highlight.startTime,
            endTime: highlight.endTime,
            duration: highlight.duration,
            hasProductBrand: isBrandDetected,
            detectedBrand: highlight.detectedBrand || 'none',
            allowHflip: !isBrandDetected,
            reframe: highlight.reframe,
            clips: highlight.clips,
          },
          hasProductBrand: isBrandDetected,
          detectedBrand: highlight.detectedBrand || 'none',
          productHook: highlight.productHook,
          sampleContext: scriptData.sampleContext,
          scenes: scriptData.scenes,
          voiceoverScript: scriptData.voiceoverScript,
          aiStudioPrompt: scriptData.aiStudioPrompt,
          caption: scriptData.caption,
          lexicon: scriptData.lexicon_to_replace || {},
          videoTitle: videoMeta.title,
          isOrphan: false,
        };

        activeJobs.set(jobId, completedResult);
        persistJob(jobId, completedResult);

        updateProgress({
          step: 'completed',
          message: '🎉 Video Final 9:16 + Voiceover Gadis Indonesia & Subtitle Selesai!',
          progress: 100,
          status: 'completed',
          result: completedResult,
        });

        return completedResult;
      } catch (mergeErr) {
        console.warn(`[Job ${jobId}] Auto merge error, falling back to awaiting_voiceover:`, mergeErr.message);
      }
    }

    // Fallback: If TTS or auto merge fails, pause at awaiting_voiceover so user can still continue
    const stage1Result = {
      ...extraJobMeta,
      jobId,
      stage: 'awaiting_voiceover',
      createdAt: jobMeta.createdAt,
      silentFileName,
      silentVideoUrl: `/api/video/${silentFileName}`,
      silentLocalPath: silentOutputPath,
      downloadedVideoPath: rawVideoPath,
      hasSilentVideo: true,
      hasFinalVideo: false,
      productTitle: highlight.detectedProduct || productTitle || videoMeta.title,
      productDescription: productDescription || '',
      youtubeUrl,
      shopeeLink: effectiveShopeeLink || shopeeLink || '',
      highlight: {
        startTime: highlight.startTime,
        endTime: highlight.endTime,
        duration: highlight.duration,
        hasProductBrand: isBrandDetected,
        detectedBrand: highlight.detectedBrand || 'none',
        allowHflip: !isBrandDetected,
        reframe: highlight.reframe,
        clips: highlight.clips
      },
      hasProductBrand: isBrandDetected,
      detectedBrand: highlight.detectedBrand || 'none',
      productHook: highlight.productHook,
      sampleContext: scriptData.sampleContext,
      scenes: scriptData.scenes,
      voiceoverScript: scriptData.voiceoverScript,
      aiStudioPrompt: scriptData.aiStudioPrompt,
      cleanScript: cleanScriptForTTS(rawVoiceScript),
      caption: scriptData.caption,
      lexicon: scriptData.lexicon_to_replace || {},
      videoTitle: videoMeta.title,
      isOrphan: false,
    };

    activeJobs.set(jobId, stage1Result);
    persistJob(jobId, stage1Result);

    updateProgress({
      step: 'awaiting_voiceover',
      message: 'Tahap 1 Selesai! Kotak Scene, Naskah, dan Muted 9:16 Video Ready.',
      progress: 100, status: 'awaiting_voiceover', result: stage1Result
    });

    return stage1Result;
  } catch (error) {
    console.error(`[Job ${jobId}] Stage 1 Pipeline Error:`, error);

    // Immediately clean up temporary files so disk storage is freed
    deleteJobTempDirectory(jobId, tempDir);

    const hasSilentVideo = silentOutputPath && fs.existsSync(silentOutputPath);
    const hasRawVideo = rawVideoPath && fs.existsSync(rawVideoPath);

    // If 1080p video was already downloaded or rendered into silent 9:16, NEVER delete or purge it!
    if (hasSilentVideo || hasRawVideo) {
      console.log(`[Job ${jobId}] ✅ Video asset exists (${hasSilentVideo ? 'silent 9:16' : 'raw 1080p'}). Preserving job in history as awaiting_voiceover.`);
      const currentJob = activeJobs.get(jobId) || jobMeta;
      const preservedJob = {
        ...currentJob,
        ...extraJobMeta,
        stage: 'awaiting_voiceover',
        status: 'awaiting_voiceover',
        lastError: error.message,
        errorAt: new Date().toISOString(),
        silentLocalPath: hasSilentVideo ? silentOutputPath : null,
        silentVideoUrl: hasSilentVideo ? `/api/video/${silentFileName}` : null,
        downloadedVideoPath: hasRawVideo ? rawVideoPath : null,
        hasSilentVideo: Boolean(hasSilentVideo),
        hasFinalVideo: false,
        productTitle: productTitle || videoMeta?.title,
        productDescription: productDescription || '',
        youtubeUrl: currentYoutubeUrl,
        shopeeLink: effectiveShopeeLink || shopeeLink || '',
        videoTitle: videoMeta?.title,
        highlight,
      };
      activeJobs.set(jobId, preservedJob);
      persistJob(jobId, preservedJob);

      updateProgress({
        step: 'awaiting_voiceover',
        message: `Video 1080p tersimpan! (${error.message}). Siap untuk Retry Voiceover.`,
        progress: 100,
        status: 'awaiting_voiceover',
        result: preservedJob,
      });

      return preservedJob;
    }

    const isAuto = Boolean(extraJobMeta?.isAutoGenerated);
    if (isAuto) {
      // Failed auto jobs should not clutter the job list or disk
      deleteJobFiles(jobId, outputDir, tempDir);
      activeJobs.delete(jobId);
      deletePersistedJob(jobId);
    } else {
      const currentJob = activeJobs.get(jobId) || jobMeta;
      const errorJob = {
        ...currentJob,
        ...extraJobMeta,
        stage: 'error',
        lastError: error.message,
        errorAt: new Date().toISOString(),
      };
      activeJobs.set(jobId, errorJob);
      persistJob(jobId, errorJob);
    }

    const isQuotaError = isQuotaErrorMessage(error.message);
    updateProgress({
      step: 'error',
      message: error.message || 'An error occurred during video processing.',
      progress: 0, status: 'error', error: error.message, isQuotaError, canRetry: true
    });

    error.jobId = jobId;
    error.isQuotaError = isQuotaError;
    throw error;
  }
}

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
  } = req.body;

  if (aiProvider) {
    options.aiProvider = aiProvider;
  }

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'YouTube Video URL is required.' });
  }
  if (!isValidHttpUrl(youtubeUrl) || !extractVideoId(youtubeUrl)) {
    return res.status(400).json({ error: 'URL YouTube tidak valid. Gunakan URL youtube.com atau youtu.be yang berisi video ID.' });
  }
  if (shopeeLink && !isValidHttpUrl(shopeeLink)) {
    return res.status(400).json({ error: 'Link produk harus berupa URL http/https yang valid.' });
  }
  if (productTitle && isBulkyOrUnsuitableProduct(productTitle)) {
    return res.status(400).json({ error: 'Produk ditolak karena tergolong perabot besar / rak besar yang memenuhi frame. Niche disetel hanya untuk alat dapur praktis.' });
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

function publicAutoRunState(run) {
  if (!run) return { status: 'idle' };
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
  };
}

function updateAutoRun(run, patch) {
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  autoRuns.set(run.runId, run);
  console.log(`[Auto ${run.runId}] [${run.progress || 0}%] ${run.message || run.status}`);
}

function getLatestAutoRun() {
  const all = Array.from(autoRuns.values()).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return all[0] || null;
}

async function runAutoStage1Worker(run) {
  try {
    const isUnlimited = run.maxJobs === 'unlimited' || run.maxJobs === Infinity || !run.maxJobs;
    updateAutoRun(run, {
      status: 'running',
      message: isUnlimited ? 'Memulai pipeline Auto Mode (Unlimited)...' : 'Memulai pencarian produk viral Shopee...',
      progress: 5,
    });

    const seenShopeeUrls = new Set();
    const usedYouTubeVideoIds = getAllUsedYouTubeVideoIds();
    let keywordQueue = getAutoKeywords(200, { excludeUsed: true, shuffle: true });
    let emptyKeywordRetryCount = 0;
    let quotaExhausted = false;

    while (run.status !== 'stopping' && run.status !== 'stopped') {
      if (!isUnlimited && run.successfulJobs >= run.maxJobs) {
        break;
      }

      if (keywordQueue.length === 0) {
        const freshKeywords = getAutoKeywords(200, { excludeUsed: true, shuffle: true });
        if (freshKeywords && freshKeywords.length > 0) {
          keywordQueue = freshKeywords;
          emptyKeywordRetryCount = 0;
        } else {
          emptyKeywordRetryCount++;
          if (emptyKeywordRetryCount > 3) {
            console.log('[Auto] Tidak ada kata kunci baru yang tersedia setelah 3x percobaan.');
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
      }

      const keyword = keywordQueue.shift();
      if (!keyword) continue;

      const currentTargetIndex = run.successfulJobs + 1;
      const targetLabel = isUnlimited ? `${run.successfulJobs} video (∞)` : `${currentTargetIndex}/${run.maxJobs}`;

      updateAutoRun(run, {
        message: `[${targetLabel}] Mencari video di mesin telusur (YouTube & Bing) untuk: "${keyword}"...`,
        progress: isUnlimited ? 10 : Math.min(95, Math.round((run.successfulJobs / run.maxJobs) * 100) + 2),
      });

      // ── STRATEGI VIDEO-FIRST: Cari video demonstrasi produk langsung di multi-engine ──
      let candidates = await searchMultiEngineVideos(keyword, {
        limit: 16,
        excludeVideoIds: usedYouTubeVideoIds,
        onProgress: (p) => updateAutoRun(run, { message: `[${targetLabel}] ${p.message}` }),
      });

      // Jika pencarian teks multi-engine kosong, coba temukan produk Shopee dan cari video via gambar produknya!
      if (!candidates || candidates.length === 0) {
        try {
          const shopeeCandidate = await discoverSingleShopeeProduct(keyword, seenShopeeUrls);
          if (shopeeCandidate && shopeeCandidate.imageUrl) {
            updateAutoRun(run, { message: `[${targetLabel}] Mencoba pencarian video via gambar produk Shopee: "${shopeeCandidate.title.slice(0, 30)}..."` });
            const visualCandidates = await searchVideosByProductImage({
              imageUrl: shopeeCandidate.imageUrl,
              productTitle: shopeeCandidate.title,
              productDescription: shopeeCandidate.description,
              limit: 16,
              excludeVideoIds: usedYouTubeVideoIds,
              onProgress: (p) => updateAutoRun(run, { message: `[${targetLabel}] ${p.message}` }),
            });
            if (visualCandidates && visualCandidates.length > 0) {
              candidates = visualCandidates;
            }
          }
        } catch (visAutoErr) {
          console.warn(`[Auto] Fallback visual search error for ${keyword}:`, visAutoErr.message);
        }
      }

      if (!candidates || candidates.length === 0) {
        run.skippedProducts++;
        updateAutoRun(run, { message: `[${targetLabel}] Skip "${keyword}": Tidak ada video kandidat baru yang cocok.` });
        continue;
      }

      let jobSuccess = false;
      for (const candidate of candidates) {
        if (run.status === 'stopping' || run.status === 'stopped') break;
        const candidateVid = extractVideoId(candidate.url) || candidate.id;
        if (candidateVid) {
          usedYouTubeVideoIds.add(candidateVid);
        }

        const autoJobId = `auto_${crypto.randomBytes(5).toString('hex')}`;
        run.currentJobId = autoJobId;
        const currentCandidateTitle = candidate.title || keyword;

        try {
          updateAutoRun(run, {
            currentProductTitle: currentCandidateTitle,
            message: `[${targetLabel}] Menguji video: "${currentCandidateTitle.slice(0, 30)}..."...`,
            progress: isUnlimited ? 25 : Math.min(95, Math.round((run.successfulJobs / run.maxJobs) * 100) + 5),
          });

          const candidateShopeeLink = extractShopeeLinkFromText(candidate.description);
          const completedResult = await runStage1Pipeline({
            jobId: autoJobId,
            youtubeUrl: candidate.url,
            shopeeLink: candidateShopeeLink || '',
            productTitle: currentCandidateTitle,
            productDescription: candidate.description || '',
            apiKey: undefined,
            options: {
              ...run.options,
              aiProvider: run.options?.aiProvider || (process.env.ACTIVE_AI_ENGINE === 'gemini' ? 'gemini' : 'openrouter'),
              autoSearchFallback: false,
              isVideoFirst: true,
            },
            extraJobMeta: { autoRunId: run.runId, isAutoGenerated: true, isVideoFirst: true, searchKeyword: keyword },
            requireCleanGeminiPlan: true,
            onProgress: (p) => {
              if (isUnlimited) {
                updateAutoRun(run, {
                  message: `[${targetLabel}] ${p.message}`,
                  progress: Math.min(98, Math.max(10, p.progress || 10)),
                });
              } else {
                const baseProgress = Math.round((run.successfulJobs / run.maxJobs) * 100);
                const stepFraction = Math.round(((p.progress || 0) / 100) * (100 / run.maxJobs));
                updateAutoRun(run, {
                  message: `[${targetLabel}] ${p.message}`,
                  progress: Math.min(98, baseProgress + stepFraction),
                });
              }
            },
          });

          const finalItemTitle = completedResult?.productTitle || currentCandidateTitle;
          run.successfulJobs++;
          jobSuccess = true;
          markKeywordAsUsed(keyword, { productTitle: finalItemTitle, jobId: autoJobId, source: 'auto_worker' });
          const finishedDisplay = isUnlimited ? `${run.successfulJobs} video (∞)` : `${run.successfulJobs}/${run.maxJobs}`;
          updateAutoRun(run, {
            message: `✅ [${finishedDisplay}] Selesai: "${finalItemTitle.slice(0, 35)}..."`,
            progress: isUnlimited ? 100 : Math.round((run.successfulJobs / run.maxJobs) * 100),
          });
          break; // Video lolos dan selesai! Lanjut ke kata kunci berikutnya
        } catch (err) {
          console.warn(`[Auto] Candidate rejected for ${keyword}:`, err.message);
          // Delete temporary files ONLY IF the job did NOT already save a media asset
          const existingJob = activeJobs.get(autoJobId);
          const hasSavedMedia = existingJob && (existingJob.finalLocalPath || existingJob.silentLocalPath || existingJob.downloadedVideoPath);
          if (!hasSavedMedia) {
            deleteJobFiles(autoJobId, outputDir, tempDir);
            activeJobs.delete(autoJobId);
            deletePersistedJob(autoJobId);
          } else {
            const savedItemTitle = existingJob.productTitle || currentCandidateTitle;
            run.successfulJobs++;
            jobSuccess = true;
            markKeywordAsUsed(keyword, { productTitle: savedItemTitle, jobId: autoJobId, source: 'auto_worker' });
            const savedDisplay = isUnlimited ? `${run.successfulJobs} video (∞)` : `${run.successfulJobs}/${run.maxJobs}`;
            updateAutoRun(run, {
              message: `✅ [${savedDisplay}] Video 1080p tersimpan (Menunggu Voiceover): "${savedItemTitle.slice(0, 30)}..."`,
              progress: isUnlimited ? 100 : Math.round((run.successfulJobs / run.maxJobs) * 100),
            });
            break;
          }

          run.failures.push({ productTitle: currentCandidateTitle, error: err.message, time: new Date().toISOString() });

          // If all models in the fallback chain exhausted their quota, stop autorun!
          if (err.isAllModelsQuotaExhausted) {
            console.error('[Auto] Seluruh model AI dalam rantai fallback telah mencapai batas limit kuota token harian. Menghentikan Auto Mode.');
            quotaExhausted = true;
            break;
          }

          // Check for fatal authentication error (401 with invalid api key)
          const msg = (err.message || '').toLowerCase();
          const isFatalAuth = (err.status === 401 || err.statusCode === 401) && (msg.includes('api key') || msg.includes('unauthorized'));
          if (isFatalAuth) {
            console.error('[Auto] API Key tidak valid. Menghentikan Auto Mode.');
            throw err;
          }

          // Check for YouTube cookies/authentication error - stop auto-run instead of infinite loop
          const isYouTubeAuthError = msg.includes('from-browser') || msg.includes('--cookies') ||
            msg.includes('cookies for the authentication') || msg.includes('sign in to confirm') ||
            msg.includes('login required') || msg.includes('private video') ||
            (msg.includes('yt-dlp') && msg.includes('authentication'));
          if (isYouTubeAuthError) {
            console.error('[Auto] ❌ YouTube membutuhkan autentikasi (cookies). Auto Mode dihentikan.');
            console.error('[Auto] Upload file cookies.txt ke ~/clipper/server/cookies.txt dan restart PM2.');
            updateAutoRun(run, {
              status: 'error',
              message: '⚠️ Auto Mode berhenti: YouTube membutuhkan cookies autentikasi. Upload cookies.txt ke server/cookies.txt dan restart server.',
              progress: 100,
              finishedAt: new Date().toISOString(),
              currentJobId: null,
              currentProductTitle: null,
            });
            return; // Stop the auto-run worker entirely
          }

          // Any ordinary candidate rejection (watermark, face, no clip, download glitch) -> try next candidate
        }
      }

      if (quotaExhausted) {
        break;
      }

      if (!jobSuccess) {
        run.failedJobs++;
        updateAutoRun(run, {
          failedJobs: run.failedJobs,
          message: `❌ [${targetLabel}] Gagal menemukan video bersih untuk: "${keyword.slice(0, 30)}..."`,
        });
      }

      // Graceful jitter delay between product batches to prevent aggressive scraping blocks
      if ((isUnlimited || currentTargetIndex < run.maxJobs) && (run.status === 'running' || run.status === 'starting')) {
        const delayMs = 3000 + Math.floor(Math.random() * 2000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (quotaExhausted) {
      updateAutoRun(run, {
        status: 'completed',
        message: `⚠️ Auto Mode berhenti otomatis: Seluruh model AI utama dan fallback telah mencapai batas limit kuota harian. Total video berhasil dibuat: ${run.successfulJobs}, Gagal: ${run.failedJobs}, Dilewati: ${run.skippedProducts}.`,
        progress: 100,
        finishedAt: new Date().toISOString(),
        currentJobId: null,
        currentProductTitle: null,
      });
      return;
    }

    const finalStatus = run.status === 'stopping' ? 'stopped' : 'completed';
    const totalDisplay = isUnlimited ? `${run.successfulJobs} video (Mode Unlimited)` : `${run.successfulJobs}/${run.maxJobs}`;
    updateAutoRun(run, {
      status: finalStatus,
      message: `Auto Mode selesai. Berhasil: ${totalDisplay}, Gagal: ${run.failedJobs}, Dilewati: ${run.skippedProducts}.`,
      progress: 100,
      finishedAt: new Date().toISOString(),
      currentJobId: null,
      currentProductTitle: null,
    });
  } catch (err) {
    console.error('[Auto] Fatal worker error:', err);
    updateAutoRun(run, {
      status: 'error',
      message: err.message || 'Auto Mode terhenti karena error.',
      progress: 100,
      finishedAt: new Date().toISOString(),
    });
  }
}

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

app.post('/api/auto/start', (req, res) => {
  reloadEnvironment();
  const latest = getLatestAutoRun();
  if (latest && latest.status === 'running') {
    return res.json({ run: publicAutoRunState(latest) });
  }

  const { maxJobs = 'unlimited', options = {}, niche = 'kitchen_tools' } = req.body || {};
  const isUnlimited = maxJobs === 'unlimited' || maxJobs === Infinity || !maxJobs || Number(maxJobs) <= 0;
  const runId = `autorun_${crypto.randomBytes(4).toString('hex')}`;
  const run = {
    runId,
    status: 'starting',
    maxJobs: isUnlimited ? 'unlimited' : Math.max(1, Math.min(500, Number(maxJobs) || 10)),
    successfulJobs: 0,
    failedJobs: 0,
    skippedProducts: 0,
    niche,
    currentJobId: null,
    currentProductTitle: null,
    message: isUnlimited ? 'Memulai pipeline Auto Mode (Unlimited)...' : 'Memulai pipeline Auto Mode...',
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
  if (run && run.status === 'running') {
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
    const silentDurationSec = await getMediaDurationSec(silentPath) || job.highlight?.duration || 45;
    const audioDurationSec = await getMediaDurationSec(audioFile.path);

    const subtitleTargetDuration = Math.max(silentDurationSec, audioDurationSec || 0);

    const scriptToUse = (req.body?.customScript && req.body.customScript.trim())
      ? req.body.customScript.trim()
      : (job.aiStudioPrompt || job.voiceoverScript || '');

    updateProgress({ step: 'subtitles', message: `Generating synchronized subtitle captions for ${silentDurationSec.toFixed(1)}s video...`, progress: 40, status: 'running' });
    generateSrtSubtitles(scriptToUse, subtitleTargetDuration, srtPath, {
      wordBoundaries: job?.wordBoundaries || [],
      videoDurationSec: silentDurationSec,
      lexicon: job?.lexicon || {},
    });

    updateProgress({ step: 'render_final', message: 'Rendering final 9:16 video with Voiceover & Subtitles...', progress: 60, status: 'running' });
    await mergeVoiceoverAndBurnSubtitles({
      silentVideoPath: silentPath, voiceoverAudioPath: audioFile.path,
      srtPath,
      outputVideoPath: finalOutputPath,
      targetDurationSec: silentDurationSec,
      onProgress: updateProgress,
    });

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
function syncVideoToAndroidStorage(finalOutputPath, finalFileName, projectName = 'clipper') {
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

/** Helper function to process voiceover & final video merge for a single job */
async function processJobVoiceover(jobId, customScript = null, options = {}) {
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

  const silentPath = job?.silentLocalPath || path.join(outputDir, `silent_clip_${jobId}.mp4`);

  if (!job || !fs.existsSync(silentPath)) {
    const notFoundErr = new Error(`File video 9:16 untuk job ${jobId} tidak ditemukan di folder output.`);
    notFoundErr.statusCode = 404;
    throw notFoundErr;
  }

  let scriptToUse = (customScript && customScript.trim())
    ? customScript.trim()
    : (job.voiceoverScript || job.aiStudioPrompt || '');

  if (!scriptToUse && Array.isArray(job.scenes) && job.scenes.length > 0) {
    scriptToUse = job.scenes.map((s, idx) => `[00:${String(idx * 5).padStart(2, '0')}] ${s.voiceover || ''}`).join('\n');
  }

  if (!scriptToUse && job.productTitle) {
    scriptToUse = `Kenalin, ${job.productTitle}! Solusi paling praktis buat kamu. Cek produk di bawah sekarang sebelum kehabisan!`;
  }

  if (!scriptToUse) {
    const emptyErr = new Error('Naskah voiceover tidak boleh kosong.');
    emptyErr.statusCode = 400;
    throw emptyErr;
  }

  const voiceoverFileName = `voiceover_${jobId}_${Date.now()}.mp3`;
  const voiceoverAudioPath = path.join(uploadsDir, voiceoverFileName);
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

  try {
    const activeTtsProvider = (options.ttsProvider || job.ttsProvider || process.env.TTS_PROVIDER || 'gemini_tts').toLowerCase().trim();
    const isGeminiTts = activeTtsProvider === 'gemini_tts';
    const ttsModelToUse = options.ttsModel || job.ttsModel || process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL;
    const ttsFallbackModelToUse = options.ttsFallbackModel || job.ttsFallbackModel || process.env.GEMINI_TTS_FALLBACK_MODEL || DEFAULT_GEMINI_TTS_FALLBACK_MODEL;
    const ttsVoiceToUse = options.ttsVoice || job.ttsVoice || process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE;
    const ttsLabel = isGeminiTts
      ? `Gemini Flash (${ttsModelToUse} - ${ttsVoiceToUse})`
      : 'Edge-TTS Gadis';

    updateProgress({ step: 'tts_generating', message: `🎙️ Menghasilkan voice over ${ttsLabel}...`, progress: 20, status: 'running' });

    const silentDurationSec = (await getMediaDurationSec(silentPath)) || job.highlight?.duration || 20;

    const effectiveLexicon = options.lexicon || job.lexicon || {};
    if (options.lexicon && typeof options.lexicon === 'object') {
      saveToEnglishDictionary(options.lexicon);
    }

    const ttsResult = await generateVoiceoverTTS({
      script: scriptToUse,
      outputPath: voiceoverAudioPath,
      targetDurationSec: silentDurationSec,
      provider: activeTtsProvider,
      modelId: ttsModelToUse,
      fallbackModelId: ttsFallbackModelToUse,
      voice: ttsVoiceToUse,
      apiKey: options.geminiApiKey || job.geminiApiKey || process.env.GEMINI_API_KEY,
      onProgress: (msg) => updateProgress({ step: 'tts_generating', message: `🎙️ ${msg}`, progress: 35, status: 'running' }),
      jobId,
      lexicon: effectiveLexicon,
    });

    const audioDurationSec = await getMediaDurationSec(voiceoverAudioPath);
    const subtitleTargetDuration = Math.max(silentDurationSec, audioDurationSec || 0);

    updateProgress({ step: 'subtitles', message: `Menyinkronkan subtitle narasi (${silentDurationSec.toFixed(1)}s)...`, progress: 55, status: 'running' });
    generateSrtSubtitles(scriptToUse, subtitleTargetDuration, srtPath, {
      wordBoundaries: ttsResult.wordBoundaries,
      videoDurationSec: silentDurationSec,
      lexicon: effectiveLexicon,
    });

    updateProgress({ step: 'render_final', message: 'Rendering video final 9:16 dengan Voiceover & Subtitles...', progress: 75, status: 'running' });
    await mergeVoiceoverAndBurnSubtitles({
      silentVideoPath: silentPath,
      voiceoverAudioPath,
      srtPath,
      outputVideoPath: finalOutputPath,
      targetDurationSec: silentDurationSec,
      onProgress: updateProgress,
    });

    cleanupTempFiles([srtPath]);

    // Automatically sync final video to Android MyProject / shared storage if running on Termux/Android
    syncVideoToAndroidStorage(finalOutputPath, finalFileName, 'clipper');

    const cacheBuster = Date.now();
    const updatedJob = {
      ...job,
      stage: 'completed',
      finalFileName,
      videoUrl: `/api/video/${finalFileName}?t=${cacheBuster}`,
      downloadUrl: `/api/download/${finalFileName}?t=${cacheBuster}`,
      finalLocalPath: finalOutputPath,
      voiceoverAudioUrl: `/api/audio/${voiceoverFileName}?t=${cacheBuster}`,
      ttsVoice: ttsResult.voice || ttsVoiceToUse,
      ttsProvider: ttsResult.provider || activeTtsProvider,
      ttsModel: ttsResult.modelId || ttsModelToUse,
      ttsFallbackModel: ttsFallbackModelToUse,
      cleanScript: ttsResult.cleanScript,
      lexicon: effectiveLexicon,
      wordBoundaries: ttsResult.wordBoundaries || [],
      hasFinalVideo: true,
      hasSilentVideo: true,
      updatedAt: new Date().toISOString(),
    };

    activeJobs.set(jobId, updatedJob);
    persistJob(jobId, updatedJob);

    updateProgress({ step: 'completed', message: 'Final 9:16 Video Ready!', progress: 100, status: 'completed', result: updatedJob });
    return updatedJob;
  } catch (error) {
    console.error(`[Job ${jobId}] Voiceover Process Error:`, error.message);
    cleanupTempFiles([voiceoverAudioPath, srtPath]);
    const isQuota = error.isQuotaError || isQuotaErrorMessage(error.message);
    error.isQuotaError = isQuota;
    updateProgress({ step: 'error', message: error.message, progress: 0, status: 'error', error: error.message, isQuotaError: isQuota, canRetry: true });
    throw error;
  }
}

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
      // Simpan perubahan status ke jobs.json agar riwayat tersimpan permanen
      if (fs.existsSync(jobsFilePath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(jobsFilePath, 'utf-8'));
          for (const [jobId, job] of activeJobs.entries()) {
            existing[jobId] = job;
          }
          fs.writeFileSync(jobsFilePath, JSON.stringify(existing, null, 2), 'utf-8');
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
        const child = !isWin && fs.existsSync(updateScriptPath)
          ? spawn('bash', [updateScriptPath], { cwd: rootDir })
          : spawn(isWin ? 'git.cmd' : 'git', ['pull', 'origin', 'main'], { cwd: rootDir, shell: isWin });

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
});
