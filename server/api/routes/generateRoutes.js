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

// 5. Manual STAGE 1 Endpoint
router.post('/generate', async (req, res) => {
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

export default router;
