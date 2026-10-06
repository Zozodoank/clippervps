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
import {
  getRejectLedgerStats,
  clearRejectLedger
} from '../../services/productRejectLedger.js';
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
import { isOracleOfflineCalibration } from '../../config/runtimeFlags.js';

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

router.get('/auto/status', (req, res) => {
  res.json({ run: publicAutoRunState(getLatestAutoRun()) });
});

router.get('/auto/keywords/stats', (req, res) => {
  try {
    const stats = getUsedKeywordsStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auto/keywords/reset', (req, res) => {
  try {
    const result = clearUsedKeywords();
    res.json({ success: true, message: 'Riwayat kata kunci berhasil di-reset.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LEDGER PRODUK DITOLAK (product_rejects.json) ──
// "Produk mana yang sudah mati di filter konten, dan kenapa?" Riwayat job tidak
// menjawab ini (job gagal tanpa media ikut dihapus), jadi ledger punya endpoint
// sendiri. GET hanya membaca; POST reset dipakai untuk "riset ulang" setelah seed
// keyword atau kebijakan filter diubah.
router.get('/auto/rejected-products', (req, res) => {
  try {
    res.json(getRejectLedgerStats({ limit: Number(req.query.limit) || 15 }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auto/rejected-products/reset', (req, res) => {
  try {
    const result = clearRejectLedger();
    res.json({ success: true, message: 'Ledger produk ditolak berhasil dibersihkan.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auto/start', (req, res) => {
  reloadEnvironment();
  if (isOracleOfflineCalibration(process.env)) {
    return res.status(409).json({ error: 'Auto Mode dinonaktifkan selama ORACLE_OFFLINE_CALIBRATION=1. Gunakan job manual untuk kalibrasi lokal atau matikan kalibrasi agar Kaggle menjadi pemutus.' });
  }
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

  // #2: HORMATI maxJobs dari klien (sebelumnya di-hardcode 1 sehingga target 'unlimited'
  // atau multi-job tak pernah dipakai worker). Worker sudah mendukung run.maxJobs berupa
  // angka ATAU string 'unlimited' (lihat stage1Discovery.js runAutoStage1Worker).
  const requestedMax = req.body?.maxJobs;
  const isUnlimited = requestedMax === 'unlimited' || requestedMax === Infinity || !requestedMax;
  const parsedMax = Number.parseInt(requestedMax, 10);
  const maxJobs = isUnlimited ? 'unlimited' : (Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 1);

  // #5: Validasi niche SAMA seperti mode manual — alias ('smartphone'/'hp') di-resolve ke
  // preset, nilai tak dikenal tetap jatuh ke preset default alih-alih lolos mentah ke worker.
  const availableNicheIds = getAllNiches().map((n) => n.id);
  const requestedNiche = String(req.body?.niche || 'kitchen_tools').trim().toLowerCase();
  const resolvedNiche = availableNicheIds.includes(requestedNiche)
    ? requestedNiche
    : getNichePreset(requestedNiche).id;

  const options = req.body?.options || {};
  const runId = `autorun_${crypto.randomBytes(4).toString('hex')}`;
  const run = {
    runId,
    status: 'starting',
    maxJobs,
    successfulJobs: 0,
    failedJobs: 0,
    skippedProducts: 0,
    niche: resolvedNiche,
    currentJobId: null,
    currentProductTitle: null,
    message: isUnlimited
      ? 'Memulai pipeline Auto Mode (Unlimited)...'
      : `Memulai pipeline Auto Mode (target ${maxJobs} job)...`,
    progress: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options,
    failures: [],
  };

  autoRuns.set(runId, run);
  // #4: Fire-and-forget TANPA await (worker loop panjang). Tambah .catch sebagai jaring
  // pengaman agar kegagalan tak tertangani tidak membuat run membeku di 'starting'
  // (phantom "memulai"). Worker punya try/catch internal, ini hanya last-resort.
  runAutoStage1Worker(run).catch((err) => {
    console.error(`[Auto ${runId}] Worker crash tak tertangani:`, err?.message || err);
    updateAutoRun(run, {
      status: 'error',
      message: `Auto Mode berhenti karena error: ${err?.message || err}`,
      finishedAt: new Date().toISOString(),
    });
  });
  res.json({ run: publicAutoRunState(run) });
});

router.post('/auto/stop', (req, res) => {
  const { runId } = req.body || {};
  const run = autoRuns.get(runId) || getLatestAutoRun();
  if (run && (run.status === 'running' || run.status === 'starting')) {
    updateAutoRun(run, { status: 'stopping', message: 'Menghentikan Auto Mode setelah job saat ini selesai...' });
  }
  res.json({ run: publicAutoRunState(run) });
});

router.get('/auto/progress/:runId', (req, res) => {
  const { runId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = () => {
    const run = autoRuns.get(runId);
    // #6: runId tak dikenal (salah ketik / run belum pernah dibuat) -> tutup stream,
    // jangan biarkan interval 800ms menggantung selamanya tanpa kondisi terminal.
    if (!run) {
      res.write(`data: ${JSON.stringify({ error: 'run-not-found', runId, status: 'error' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }
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

export default router;
