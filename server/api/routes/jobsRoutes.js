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
import { createRateLimiter } from '../../utils/security.js';
import {
  getJobTraceSummary,
  readJobTrace,
  buildFailureRollup,
  JOB_TRACE_PATH,
} from '../../services/observabilityService.js';
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
  poolMultiCandidateFrames,
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
import { jobsFilePath, activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, patchJob, updateJobProgress, publicAutoRetryState, publicAutoRunState, updateAutoRun, getLatestAutoRun } from '../../store/jobStore.js';
import { loadedEnvFiles, cleanEnvValue, isPlaceholderEnvValue, reloadEnvironment } from '../../utils/envLoader.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../../services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../../services/antiDupService.js';
import { isValidHttpUrl, resolveOutputVideoPath, isVideoFilePath, isQuotaErrorMessage, sanitizeCaptionText } from '../../utils/jobHelpers.js';
import { applyConfigSnapshot, describeConfigSnapshot } from '../../config/runtimeFlags.js';
import { runStage1Pipeline, runAutoStage1Worker, runAutoRetryWorker, conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage, processJobVoiceover } from '../../worker/pipelineWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories
import { outputDir, tempDir, uploadsDir, rejectedYunetDir, cookiesPath } from '../../utils/paths.js';

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(rejectedYunetDir)) fs.mkdirSync(rejectedYunetDir, { recursive: true });

// Upload Multer untuk voiceover dikonfigurasi SEKALI di voiceoverRoutes.js (satu-satunya
// rute yang memakai upload.single). Tidak diduplikasi di sini agar batas ukuran & filter
// audio punya satu sumber kebenaran.

const router = express.Router();

router.get('/jobs', (req, res) => {
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
      ttsVoice: job.ttsVoice || 'Despina',
      ttsProvider: job.ttsProvider || 'gemini_tts',
      ttsModel: job.ttsModel || 'gemini-3.1-flash-tts-preview',
      ttsFallbackModel: job.ttsFallbackModel || 'gemini-2.5-flash-preview-tts',
      voiceoverAudioUrl: job.voiceoverAudioUrl || null,
      sampleContext: job.sampleContext || null,
      caption: sanitizeCaptionText(job.caption || '', job),
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
router.delete('/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  deleteJobFiles(jobId, outputDir, tempDir);
  activeJobs.delete(jobId);
  deletePersistedJob(jobId);
  res.json({ success: true, jobId });
});

// 3b. Retry / Regenerate an existing completed or failed job with fresh 1080p video & voiceover
router.post('/jobs/:jobId/retry', async (req, res) => {
  reloadEnvironment();
  const { jobId } = req.params;
  const { forceNewCandidate = true } = req.body || {};

  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: `Job ${jobId} tidak ditemukan.` });
  }

  // Job MANUAL (bukan hasil auto-run) WAJIB memakai URL sumber yang sudah disimpan user.
  // Retry job manual TIDAK BOLEH mencari video lain di mesin telusur: link sudah disiapkan.
  const isAutoJob = Boolean(job.isAutoGenerated);
  const jobNiche = job.niche || (job.productCategory === 'gadget_smartphone' ? 'gadget_smartphone' : 'kitchen_tools');
  const savedOemUrls = Array.isArray(job.oemUrls) ? job.oemUrls.filter(Boolean) : [];
  const originalYoutubeUrl = job.youtubeUrl || '';

  console.log(`[Retry] Starting full regeneration for job ${jobId} ("${job.productTitle}")... niche=${jobNiche} sumber=${isAutoJob ? 'AUTO (boleh cari kandidat baru)' : `MANUAL (url lama + ${savedOemUrls.length} OEM)`}`);

  // Delete old outputs and temp files to ensure bad old video/audio is completely replaced
  deleteJobFiles(jobId, outputDir, tempDir);
  // P4: satu patchJob atomik (baca-gabung-tulis) menggantikan pola lama
  // `job.x = ..; activeJobs.set(); persistJob()` yang menulis dua kali & rawan lost-update.
  // force=true karena transisi terminal -> 'running' adalah jalur retry yang sah.
  patchJob(jobId, (j) => ({
    ...j,
    downloadedVideoPath: null,
    hasDownloadedVideo: false,
    hasFinalVideo: false,
    hasSilentVideo: false,
    stage: 'running',
  }), { force: true });
  job.downloadedVideoPath = null;
  job.hasDownloadedVideo = false;
  job.hasFinalVideo = false;
  job.hasSilentVideo = false;
  job.stage = 'running';

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
      // P5.2: TERAPKAN snapshot konfigurasi yang dibekukan saat job dibuat (bukan .env saat ini),
      // sehingga retry mereproduksi perilaku awal walau operator sudah mengubah flag. Snapshot
      // job tidak pernah diubah di sini — hanya dibaca & ditulis ulang ke process.env.
      if (job.configSnapshot) {
        applyConfigSnapshot(job.configSnapshot);
        console.log(`[Retry ${jobId}] 🧊 Memakai configSnapshot beku (dibuat ${job.configSnapshot._frozenAt || '?'}): ${describeConfigSnapshot(job.configSnapshot)}`);
      } else {
        console.warn(`[Retry ${jobId}] ⚠️ Job lama tanpa configSnapshot — retry memakai process.env saat ini (hasil mungkin tidak identik dengan render awal).`);
      }

      let targetCandidates = [];
      const usedVids = getAllUsedYouTubeVideoIds();
      const oldVid = extractVideoId(job.youtubeUrl);
      if (oldVid) usedVids.add(oldVid);

      if (!isAutoJob) {
        // RETRY MANUAL: bangun ulang kandidat dari link tersimpan (youtubeUrl + OEM). TANPA pencarian web.
        const allUrls = [originalYoutubeUrl, ...savedOemUrls].filter(Boolean);
        if (allUrls.length === 0) {
          throw new Error('Job manual tidak memiliki URL sumber tersimpan untuk di-retry. Kirim ulang link video aslinya.');
        }
        // [FIX] Force explicitOnly for manual retries
        if (!job.options) job.options = {};
        job.options.explicitOnly = true;
        // Gunakan Set untuk menghindari URL duplikat
        targetCandidates = Array.from(new Set(allUrls)).map(url => ({ url, title: job.productTitle || 'YouTube Video' }));
        updateJobProgress(jobId, {
          step: 'retry_source',
          message: `🔒 Retry manual: memakai URL sumber lama (tanpa mencari video baru di mesin telusur).`,
          progress: 8,
          status: 'running',
        });
      } else if (forceNewCandidate && job.productTitle) {
        const targetNoun = job.coreProductNoun || extractCoreProductInfo(job.productTitle, job.productDescription).coreProductNoun;
        updateJobProgress(jobId, { step: 'auto_youtube_search', message: `Mencari video 1080p baru untuk target "${targetNoun}"...`, progress: 8, status: 'running', coreProductNoun: targetNoun });
        const fresh = await discoverYouTubeCandidatesForProduct({
          productTitle: job.productTitle,
          productDescription: job.productDescription,
          niche: jobNiche,
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
          patchJob(jobId, { youtubeUrl: candidate.url });

          const effectiveAiProvider = job.aiProvider || req.body?.aiProvider || (process.env.ACTIVE_AI_ENGINE === 'gemini' ? 'gemini' : 'openrouter');
          await runStage1Pipeline({
            jobId,
            youtubeUrl: candidate.url,
            shopeeLink: job.shopeeLink,
            productTitle: job.productTitle,
            productDescription: job.productDescription,
            apiKey: undefined,
            options: (() => {
              // ─── ALUR BARU (samakan dengan AutoJob / runAutoStage1Worker) ───
              // Mandet user 2026-10: retry (AUTO & MANUAL, niche smartphone & alat dapur)
              // harus memakai SET RENDER yang sama dengan autojob — isVideoFirst +
              // multiVideoHarvesting + sceneDuration 3.3 + minDuration 30.0.
              // PENGLONGGARAN: hanya opsi RENDER. Sumber tetap dikunci sesuai jenis retry
              // (manual & auto-no-force = sourcePolicy 'explicit_only'; pipeline sudah
              // membungkam auto-search/multi-video-harvesting saat explicit_only, lihat
              // stage1Render: maxStreamVideos/candidatePool di-guard explicitOnly). Untuk
              // niche, jobNiche sudah mengalir otomatis (gadget_smartphone vs kitchen_tools).
              const NEW_FLOW_RENDER = { multiVideoHarvesting: true, isVideoFirst: true, sceneDuration: 3.3, minDuration: 30.0 };
              if (isAutoJob) {
                // Retry AUTO punya dua semantic berbeda (user meminta keduanya bisa dipilih via forceNewCandidate):
                //  - forceNewCandidate:true  -> memang MAU kandidat baru; biarkan pipeline auto-search/harvest.
                //  - forceNewCandidate:false -> "retry tanpa mencari" (targetCandidates sudah = youtubeUrl terkunci,
                //    lihat L293). Pipeline WAJIB pakai ulang SATU sumber itu saja, DILARANG menelusuri/memanen
                //    video lain — sama ketatnya dengan retry manual (explicit_only). Dulu cabang ini lolos ke
                //    Multi-Video Harvesting karena tidak men-set sourcePolicy/singleVideoOnly -> retry auto diam-diam
                //    mencari video baru. Itulah bug yang diperbaiki di sini.
                return forceNewCandidate
                  ? { aiProvider: effectiveAiProvider, autoSearchFallback: false, niche: jobNiche, ...NEW_FLOW_RENDER }
                  : { aiProvider: effectiveAiProvider, autoSearchFallback: false, sourcePolicy: 'explicit_only', singleVideoOnly: true, niche: jobNiche, ...NEW_FLOW_RENDER };
              }
              // Kunci manual: hanya link user yang diproses, persis seperti POST /generate.
              return {
                aiProvider: effectiveAiProvider,
                autoSearchFallback: false,
                sourcePolicy: 'explicit_only',
                singleVideoOnly: job.singleVideoOnly ?? (savedOemUrls.length === 0),
                oemUrls: savedOemUrls,
                niche: jobNiche,
                ...NEW_FLOW_RENDER,
              };
            })(),
            requireCleanGeminiPlan: true,
          });

          retrySuccess = true;
          console.log(`[Retry ${jobId}] Kandidat ${i + 1} (${candidate.url}) sukses di-generate 1080p!`);
          break;
        } catch (candErr) {
          lastRetryErr = candErr;
          deleteJobFiles(jobId, outputDir, tempDir);
          if (candErr && candErr.code === 'ORACLE_UNAVAILABLE') {
            // KEBIJAKAN ORACLE-ONLY: oracle mati/vonis tidak tiba = TERMINAL. Ganti kandidat
            // tidak menolong — semua jalur butuh vonis Oracle yang sama. Berhenti sekarang,
            // jangan membakar 8x siklus gate/timeout.
            console.error(`[Retry ${jobId}] ⛔ Oracle lokal tidak tersedia (reason: ${candErr.reason || 'unknown'}) — retry dihentikan, bukan lanjut kandidat berikutnya.`);
            break;
          }
          console.warn(`[Retry ${jobId}] Kandidat ${i + 1} (${candidate.url}) gagal: ${candErr.message}. Mencoba kandidat berikutnya...`);
        }
      }

      if (!retrySuccess) {
        // Kembalikan URL sumber asli bila semua percobaan gagal (job.youtubeUrl sempat dioverwrite di loop).
        if (originalYoutubeUrl && job.youtubeUrl !== originalYoutubeUrl) {
          job.youtubeUrl = originalYoutubeUrl;
          patchJob(jobId, { youtubeUrl: originalYoutubeUrl });
        }
        throw lastRetryErr || new Error('Tidak ada kandidat video YouTube yang dapat diunduh dalam kualitas 1080p Full HD.');
      }

      console.log(`[Retry ${jobId}] Full regeneration completed successfully.`);
    } catch (retryErr) {
      console.error(`[Retry ${jobId}] Regeneration failed:`, retryErr.message);
      job.stage = 'error';
      job.lastError = retryErr.message;
      job.errorAt = new Date().toISOString();
      patchJob(jobId, {
        stage: 'error',
        lastError: retryErr.message,
        errorAt: job.errorAt,
      }, { force: true });
      updateJobProgress(jobId, { step: 'error', status: 'error', error: retryErr.message, message: `Gagal generate ulang: ${retryErr.message}` });
    }
  })();

  res.json({ success: true, jobId, message: 'Job sedang di-generate ulang dengan source video 1080p baru & voiceover baru.' });
});

router.post('/jobs/:jobId/auto-retry/start', async (req, res) => {
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

router.post('/jobs/:jobId/auto-retry/stop', (req, res) => {
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

router.get('/jobs/:jobId/auto-retry/status', (req, res) => {
  const { jobId } = req.params;
  const run = autoRetryRuns.get(jobId);
  res.json({ autoRetry: publicAutoRetryState(run) });
});

// 4. SSE endpoint for live job progress streaming
router.get('/progress/:jobId', (req, res) => {
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

// P1.3 OBSERVABILITY: timeline stage per job. Endpoint ini SENGAJA tidak dimasukkan ke allowlist
// publik tokenAuth, jadi otomatis 401 tanpa token begitu API_ACCESS_TOKEN diisi (mode 'open' saat
// token kosong tetap bisa dipakai, sama seperti seluruh endpoint lain).
const traceLimiter = createRateLimiter({ name: 'job-trace', windowMs: 15000, max: 40 });

// 5. Stage trace untuk satu job: jawab "gagal di stage apa, berapa lama, berapa byte".
router.get('/job-trace/:jobId', traceLimiter, (req, res) => {
  const { jobId } = req.params;
  try {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const events = readJobTrace(jobId, { limit });
    if (events.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Tidak ada jejak stage untuk job "${jobId}". Trace ditulis ke ${JOB_TRACE_PATH} dan hanya disimpan selama file log belum berotasi.`,
      });
    }
    res.json({
      success: true,
      jobId,
      eventCount: events.length,
      summary: getJobTraceSummary(jobId, { limit }),
      events,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Rekap lintas job: stage mana yang paling sering membunuh job + durasi rata-rata per stage.
router.get('/job-trace-failures', traceLimiter, (req, res) => {
  try {
    const maxJobs = Math.min(200, Math.max(1, parseInt(req.query.maxJobs, 10) || 50));
    res.json({ success: true, ...buildFailureRollup({ maxJobs }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
