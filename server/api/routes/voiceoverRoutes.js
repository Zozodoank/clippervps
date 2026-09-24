import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import multer from 'multer';
import { exec, spawn, execSync } from 'child_process';

import { checkSystemDependencies, getFFmpegPath } from '../../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId, isLocalPortListening } from '../../services/downloader.js';
import { extractFrames } from '../../services/frameExtractor.js';
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
} from '../../services/aiService.js';
import { generateSrtSubtitles } from '../../services/subtitleService.js';
import { loadEnglishDictionary, saveToEnglishDictionary } from '../../services/dictionaryService.js';
import {
  renderSilentAntiDetectionVideo,
  mergeVoiceoverAndBurnSubtitles,
  getMediaDurationSec,
  getVideoDimensions
} from '../../services/videoRenderer.js';
import {
  generateVoiceoverTTS,
  cleanScriptForTTS,
  GEMINI_TTS_VOICES,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
  DEFAULT_GEMINI_TTS_VOICE
} from '../../services/ttsService.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  sampleFramesFromStream,
  inspectFramesLocally,
  filterCandidateFramesPerFrame,
  poolMultiCandidateFrames,
  callAIGatekeeperMicroservice,
  sampleDenseClustersAroundCleanFrames
} from '../../services/videoFilterService.js';
import {
  getPublicIpAddress,
  classifyPipelineError,
  checkYouTubeHealth
} from '../../services/networkDiagnosticService.js';
import {
  getBandwidthStats,
  resetBandwidthStats,
  trackSavedBandwidth
} from '../../services/bandwidthTracker.js';
import {
  cleanupTempFiles,
  deleteJobTempDirectory,
  deleteJobFiles
} from '../../services/cleaner.js';
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
} from '../../services/discoveryService.js';
import { getAllNiches, getNichePreset } from '../../config/nichePresets.js';
import {
  buildProductFingerprint,
  buildCreativeShotPlan,
  describeCreativePlan,
  conformClipsToVoiceover,
  choosePreferredCandidateSet
} from '../../services/professionalPipelineService.js';
import { runFinalMasterQc } from '../../services/finalMasterQcService.js';
import { jobsFilePath, activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, publicAutoRetryState, publicAutoRunState, updateAutoRun, getLatestAutoRun } from '../../store/jobStore.js';
import { loadedEnvFiles, cleanEnvValue, isPlaceholderEnvValue, reloadEnvironment } from '../../utils/envLoader.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../../services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../../services/antiDupService.js';
import { isValidHttpUrl, resolveOutputVideoPath, isVideoFilePath, isQuotaErrorMessage, sanitizeCaptionText } from '../../utils/jobHelpers.js';
import { runStage1Pipeline, runAutoStage1Worker, runAutoRetryWorker, conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage, processJobVoiceover } from '../../worker/pipelineWorker.js';

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

// 6. STAGE 2: Upload Voiceover & Merge Subtitles
router.post('/upload-voiceover', upload.single('audio'), async (req, res) => {
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

// 6b. Regenerate Voiceover automatically via TTS & Re-render Final Video (Single Job)
router.post('/regenerate-voiceover', async (req, res) => {
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
router.post('/retry-job-tts', async (req, res) => {
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

// 6c. Start Server-Side Batch TTS Queue
router.post('/batch-tts/start', async (req, res) => {
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
router.get('/batch-tts/status', (req, res) => {
  res.json({ batch: currentBatchTTS });
});

// 6e. Stop Batch TTS
router.post('/batch-tts/stop', (req, res) => {
  if (currentBatchTTS.isRunning) {
    currentBatchTTS.isStopping = true;
  }
  res.json({ success: true, batch: currentBatchTTS });
});

export default router;
