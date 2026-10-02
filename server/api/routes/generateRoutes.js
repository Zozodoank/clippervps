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
    niche,
    jobId: clientJobId,
    oemUrl1,
    oemUrl2,
    oemUrls,
  } = req.body;

  if (aiProvider) {
    options.aiProvider = aiProvider;
  }

  // MODE MANUAL: pengguna kini dapat memilih niche (Alat Dapur ATAU Smartphone/Gadget),
  // sama seperti mode auto. Validasi terhadap preset yang tersedia + dukung alias
  // (mis. 'smartphone'/'hp' -> gadget_smartphone). Default: kitchen_tools.
  const availableNicheIds = getAllNiches().map((n) => n.id);
  const requestedNiche = String(niche || options.niche || '').trim().toLowerCase();
  const resolvedNiche = availableNicheIds.includes(requestedNiche)
    ? requestedNiche
    : getNichePreset(requestedNiche).id;
  options.niche = resolvedNiche;
  console.log(`[Job ${clientJobId || 'generate'}] 🏷️ Manual niche = ${options.niche}`);

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
  if (productTitle && isBulkyOrUnsuitableProduct(productTitle, { niche: resolvedNiche })) {
    return res.status(400).json({
      error: resolvedNiche === 'gadget_smartphone'
        ? `Niche Smartphone/Gadget: produk "${productTitle}" tidak sesuai kriteria kategori ini.`
        : 'Produk ditolak karena tergolong perabot besar / rak besar yang memenuhi frame. Niche disetel hanya untuk alat dapur praktis.',
    });
  }

  // MODE MANUAL default = HEMAT & PREDICTABLE. Karena user sudah memberi URL YouTube/OEM
  // eksplisit (divalidasi di atas), JANGAN lakukan pencarian web / harvesting kandidat otomatis
  // yang memunculkan pesan "mencari di mesin telusur" meski link sudah jelas. Hanya sumber yang
  // user-pass yang diproses. Override: kirim options.sourcePolicy === 'auto_harvest' untuk
  // mengizinkan pencarian tambahan ala mode auto.
  if (!options.sourcePolicy) {
    options.sourcePolicy = 'explicit_only';
    console.log(`[Job ${clientJobId || 'generate'}] 🔒 Manual mode: sourcePolicy default = explicit_only (tanpa pencarian web).`);
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
      // BUG FIX: activeJobs.get() mengembalikan salinan JSON (proxy SQLite), bukan referensi.
      // Mutasi langsung pada `existingJob` tidak tersimpan ke DB. Wajib panggil activeJobs.set().
      activeJobs.set(clientJobId, {
        ...existingJob,
        downloadedVideoPath: null,
        hasDownloadedVideo: false,
        hasFinalVideo: false,
        hasSilentVideo: false,
        stage: 'running',
      });
    }
  }

  try {
    if (!options.isAutoGenerated) {
      options.explicitOnly = true;
    }

    // MODEL ASINKRON: pipeline ini berat (menit) dan jalan di heavyTaskQueue pLimit(1).
    // Menahan koneksi HTTP sampai selesai membuat request browser/HP timeout dan, saat
    // Auto Mode berjalan, permintaan manual menggantung di antrean tanpa umpan balik.
    // Kini balas 202 seketika; progres & hasil akhir mengalir lewat SSE
    // /api/progress/:jobId (jobProgress). Pipeline sendiri sudah men-set updateProgress
    // 'completed'/'awaiting_voiceover'/'error' dan mencatat jejak gagal ke riwayat job.
    runStage1Pipeline({
      jobId,
      youtubeUrl,
      shopeeLink,
      productTitle,
      productDescription,
      apiKey,
      options,
    }).catch((error) => {
      // Aman-net: pipeline men-lempar error ke SSE via updateProgress; ini hanya menjaga
      // agar tidak ada unhandled rejection yang lolos.
      console.error(`[Job ${jobId}] /generate background error:`, error?.message || error);
    });

    res.status(202).json({
      success: true,
      accepted: true,
      jobId,
      status: 'started',
      message: 'Tahap 1 diterima & berjalan di latar belakang. Pantau progres via SSE.',
    });
  } catch (error) {
    // Hanya error sinkron (setup/validasi) mendarat di sini — error pipeline ditangani
    // di latar belakang. Detail internal dicetak ke log server, bukan ke klien.
    console.error(`[Job ${jobId}] /generate synchronous error:`, error);
    res.status(500).json({
      success: false,
      error: 'Gagal memulai proses Tahap 1. Periksa log server.',
      canRetry: true,
      jobId,
    });
  }
});

export default router;
