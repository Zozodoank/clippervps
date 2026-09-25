import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, spawnSync, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { planSectionDownloads } from '../services/renderSections.js';
import { extractFrames } from '../services/frameExtractor.js';
import {
  selectHighlightWithAI,
  analyzeYouTubeVideoWithGemini,
  analyzeMultipleYouTubeVideosWithGemini,
  generateAdAdvisorScriptWithAI,
  detectPhoneticLexiconWithAI,
  formatEnrichedCaption,
  formatSeconds,
  getDynamicProductHookFallback,
  verifyProductCandidateWithAI,
  verifyFinalRenderedFramesWithAI,
  getDirectGeminiApiKey
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
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GEMINI_TTS_VOICES
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
import { classifyPipelineError, checkYouTubeHealth } from '../services/networkDiagnosticService.js';
import { trackSavedBandwidth } from '../services/bandwidthTracker.js';
import { cleanupTempFiles, deleteJobTempDirectory, deleteJobFiles } from '../services/cleaner.js';
import {
  discoverShopeeProducts,
  discoverBrandedShopeeProduct,
  discoverSingleShopeeProduct,
  discoverYouTubeCandidatesForProduct,
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
  clearUsedKeywords,
  searchMultiEngineVideos
} from '../services/discoveryService.js';
import { getAllNiches, getNichePreset } from '../config/nichePresets.js';
import {
  buildProductFingerprint,
  buildCreativeShotPlan,
  describeCreativePlan,
  conformClipsToVoiceover,
  choosePreferredCandidateSet,
  validateScriptSlotAlignment,
  buildSceneVoSegments
} from '../services/professionalPipelineService.js';
import { runFinalMasterQc } from '../services/finalMasterQcService.js';
import { activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, updateAutoRun } from '../store/jobStore.js';
import { heavyTaskQueue } from './queueManager.js';
import { isValidHttpUrl, resolveOutputVideoPath, sanitizeCaptionText, isQuotaErrorMessage } from '../utils/jobHelpers.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';

import { tempDir, outputDir, uploadsDir, rejectedYunetDir, cookiesPath, serverRoot } from '../utils/paths.js';
import { processJobVoiceover, runProfessionalFinalQcWithRepair } from './finalizationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper functions (defined locally — not exported from any service module)
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
  const likelyStatic = verySimilarCount >= Math.max(3, Math.ceil(similarities.length * 0.70));
  return { checked: true, likelyStatic, similarities, median };
}

function extractSingleFrameAsync(videoPath, timestampSec, outputPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const ffmpegPath = getFFmpegPath();
    const proc = spawn(ffmpegPath, [
      '-y', '-ss', String(timestampSec), '-i', videoPath,
      '-vframes', '1', '-q:v', '2', outputPath,
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve(false);
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath));
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function _runStage1Pipeline({
  jobId,
  youtubeUrl,
  targetCandidates = null,
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

  const explicitBrand = (options.brand || extraJobMeta?.brand || '').trim();
  const explicitProductType = (options.productType || extraJobMeta?.productType || '').trim();
  const explicitModel = (options.model || extraJobMeta?.model || '').trim();

  const productInfo = extractCoreProductInfo(productTitle, productDescription, '', explicitBrand, explicitProductType, explicitModel);
  const coreProductNoun = explicitProductType || productInfo.coreProductNoun || productTitle || 'Produk Praktis';
  const cleanProductTitle = productInfo.cleanTitle || productTitle || '';
  const productFingerprint = buildProductFingerprint({
    title: productTitle,
    description: productDescription,
    productInfo,
  });
  const creativePlan = buildCreativeShotPlan({
    fingerprint: productFingerprint,
    niche: options.niche || 'kitchen_tools',
  });

  if (isBulkyOrUnsuitableProduct(productTitle, { niche: options.niche }) || isBulkyOrUnsuitableProduct(coreProductNoun, { niche: options.niche }) || isBulkyOrUnsuitableProduct(cleanProductTitle, { niche: options.niche })) {
    const rejectReason = options.niche === 'gadget_smartphone'
      ? `Niche dibatasi untuk smartphone & gadget. Produk "${coreProductNoun || productTitle}" tidak sesuai kriteria.`
      : `Niche dibatasi hanya untuk alat dapur praktis. Produk "${coreProductNoun || productTitle}" tergolong perabot besar / rak besar yang dilarang.`;
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
    brand: explicitBrand || productInfo.brand || '',
    productType: explicitProductType || productInfo.coreProductNoun || '',
    model: explicitModel || productInfo.model || '',
    productCategory: productInfo.category || 'general_gadget',
    productFingerprint,
    creativePlan,
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
  let currentYoutubeUrl = youtubeUrl || '';
  let highlight = null;
  let effectiveShopeeLink = shopeeLink || '';

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
    // Hard production rule: change the visual scene at least every 3.5s.
    // User-provided values above 3.5s are capped so the renderer cannot hold one scene too long.
    const requestedSceneDuration = Number(options.sceneDuration);
    const sceneDuration = Math.max(
      3.0,
      Math.min(3.5, Number.isFinite(requestedSceneDuration) && requestedSceneDuration > 0 ? requestedSceneDuration : 3.5)
    );

    currentYoutubeUrl = youtubeUrl || '';
    highlight = null;
    let approved = false;
    let lastRejectionError = null;
    let pooledFrames = [];
    // Shared across candidate download + post-download audit/recovery.
    // Must live at runStage1Pipeline scope, not only inside the harvesting branch.
    const downloadedCandidatesMap = new Map();

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
            // Sampling padat penuh sesuai konfigurasi (rasio 1.5s/frame): 5 menit = 200 frame,
            // 6 menit = 240 frame, dst. Cap absolut 500 agar video durasi panjang tidak OOM.
            // (Dulu hardcoded 42 -> hanya ~40 frame terpakai, inkonsisten dgn jalur kandidat & cache.)
            const targetDur = Number(meta.duration) || 300;
            const targetMaxFrames = Math.min(500, Math.max(15, Math.floor(targetDur / 1.5)));
            const res = await sampleFramesFromStream(activeStreamUrl, rawFramesDir, {
              duration: meta.duration,
              maxSampleFrames: targetMaxFrames,
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
      const localCheck = await inspectFramesLocally(sampled, {
        aspectRatio: options.aspectRatio || '9:16',
        onProgress: updateProgress,
        niche: options.niche || jobMeta.niche || 'kitchen_tools'
      });

      if (!localCheck.eligible || !Array.isArray(localCheck.cleanFrames) || localCheck.cleanFrames.length < 3) {
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

      // Coarse-to-Dense Sampling (Audit GPT 2026):
      // Jika scan coarse menemukan area peragaan bersih, lakukan sampling rapat (dense 1 frame / 1.2s)
      // di sekitar area tersebut untuk memverifikasi gerakan fisik nyata & memberi Gemini sekuens aksi yang kaya!
      if (localCheck.eligible && Array.isArray(localCheck.cleanFrames) && localCheck.cleanFrames.length >= 2 && activeStreamUrl) {
        try {
          const denseFrames = await sampleDenseClustersAroundCleanFrames(
            activeStreamUrl,
            rawFramesDir,
            localCheck.cleanFrames,
            { duration: meta.duration, onProgress: updateProgress }
          );
          if (denseFrames && denseFrames.length > 0) {
            sampled = [...sampled, ...denseFrames].sort((a, b) => a.timestamp - b.timestamp);
            preSampledFrames = sampled;
            console.log(`[Job ${jobId}] 🎯 Coarse-to-Dense sampling sukses: ditambahkan ${denseFrames.length} frame rapat di sekitar area aksi fisik (total ${sampled.length} frame).`);
          }
        } catch (denseErr) {
          console.warn(`[Job ${jobId}] Sampling rapat tambahan dilewati: ${denseErr.message}`);
        }
      }

      console.log(`[Job ${jobId}] ✅ [Filter 2/3 Lolos] Frame visual valid (${localCheck.cleanFrames.length} frame VERIFIED_CLEAN dalam ${localCheck.verifiedSegments?.length || 1} segmen temporal). Verifikasi grafis visual & storyboard diserahkan ke AI Vision.`);

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
          verifiedSegments: localCheck.verifiedSegments || [],
          cleanTimeWindows: (localCheck.verifiedSegments || []).map(s => ({ start: s.startSec, end: s.endSec })),
          discardedFaceTimestamps: localCheck.discardedFaceTimestamps || [],
          discardedViolationTimestamps: localCheck.discardedViolationTimestamps || [],
          isVideoFirst: Boolean(options.isVideoFirst),
          niche: options.niche || jobMeta?.niche || 'kitchen_tools',
          onProgress: updateProgress,
        });

        if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
          const noClipErr = new Error('Gemini tidak menemukan cuplikan produk yang memenuhi syarat (wajib faceless, tanpa watermark 9:16, tanpa subtitle).');
          noClipErr.isAiRejection = true;
          noClipErr.rejectionReason = 'Tidak ditemukan cuplikan bersih yang memenuhi syarat.';
          throw noClipErr;
        }

        // Pastikan backend membuang intro pembuka jika terdeteksi tanpa menduplikasi timestamp
        if (candidateIntroCutoff > 0 && Array.isArray(hl.clips)) {
          hl.clips = hl.clips.filter(c => (c.startSeconds + c.duration) > candidateIntroCutoff);
          let prevEnd = candidateIntroCutoff;
          hl.clips = hl.clips.map(c => {
            let start = Math.max(c.startSeconds, prevEnd);
            prevEnd = start + c.duration;
            return {
              ...c,
              startSeconds: start,
              endSeconds: start + c.duration,
              startTime: formatSeconds(start),
              endTime: formatSeconds(start + c.duration),
            };
          });
        }

        console.log(`[Job ${jobId}] 🎉 [Gemini Stream Lolos] AI menyetujui video langsung dari YouTube! Ditemukan ${hl.clips.length} cuplikan produk bersih.`);
        return { highlight: hl, videoMeta: meta, previewVideoPath: null };
      }

      // ── JALUR 2: OPENROUTER / STREAM SAMPLING LOKAL DENGAN VERIFIED CLEAN FRAMES ──
      // STRICT SAFETY GATE: Hanya kirim frame yang telah lolos verifikasi segmen bersih (VERIFIED_CLEAN)
      let verifiedCleanFrames = (localCheck.cleanFrames && localCheck.cleanFrames.length >= 2)
        ? localCheck.cleanFrames
        : [];

      if (!verifiedCleanFrames || verifiedCleanFrames.length < 2) {
        const frameErr = new Error(`Tidak cukup frame bersih terverifikasi (${verifiedCleanFrames?.length || 0} frames) untuk dikirim ke AI Vision.`);
        frameErr.isAiRejection = true;
        frameErr.rejectionReason = 'Frame bersih tidak mencukupi standar Clean Temporal Segment (minimal 2 frame berurutan).';
        throw frameErr;
      }

      // ── TAHAP 3: VERIFIKASI AI VISION (QUALITY ASSURANCE FINAL) ──
      const visionMsg = candidateLabel
        ? `[${candidateLabel}] [Filter 3/3] AI (${aiProvider}) verifikasi produk & QC bebas wajah (${verifiedCleanFrames.length} frame VERIFIED_CLEAN)...`
        : `[Filter 3/3] AI (${aiProvider}) menganalisa frame produk dan menentukan cuplikan terbaik (${verifiedCleanFrames.length} frame VERIFIED_CLEAN)...`;
      updateProgress({ step: 'gemini_vision', message: visionMsg, progress: 48, status: 'running' });

      const hl = await selectHighlightWithAI({
        apiKey,
        aiProvider,
        frames: verifiedCleanFrames,
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
        niche: options.niche || 'kitchen_tools',
        creativePlan,
        onProgress: updateProgress,
      });

      if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
        const noClipErr = new Error('AI tidak menemukan cuplikan produk yang memenuhi syarat (wajib faceless, tanpa watermark, tanpa logo sosmed/channel, dan tanpa subtitle).');
        noClipErr.isAiRejection = true;
        noClipErr.rejectionReason = 'Tidak ditemukan cuplikan bersih yang memenuhi syarat.';
        throw noClipErr;
      }

      // Pastikan backend membuang intro pembuka jika terdeteksi tanpa menduplikasi timestamp
      if (candidateIntroCutoff > 0 && Array.isArray(hl.clips)) {
        hl.clips = hl.clips.filter(c => (c.startSeconds + c.duration) > candidateIntroCutoff);
        let prevEnd = candidateIntroCutoff;
        hl.clips = hl.clips.map(c => {
          let start = Math.max(c.startSeconds, prevEnd);
          prevEnd = start + c.duration;
          return {
            ...c,
            startSeconds: start,
            endSeconds: start + c.duration,
            startTime: formatSeconds(start),
            endTime: formatSeconds(start + c.duration),
          };
        });
      }

      console.log(`[Job ${jobId}] 🎉 [Filter 3/3 Lolos] AI menyetujui video! Ditemukan ${hl.clips.length} cuplikan produk bersih.`);
      return { highlight: hl, videoMeta: meta, previewVideoPath: null };
    };

    // Evaluasi video dari cache jika tersedia
    if (rawVideoPath) {
      try {
        const rawDur = Number(videoMeta?.duration) || 300;
        // Porsi dinamis: 1.5 detik per frame. 5 menit = 200 frame, 6 menit = 240 frame, dst.
        const rawInterval = 1.5;
        // Batasi absolut maksimum 500 frame agar server tidak OOM/memori jebol untuk video durasi 1 jam.
        const maxFrames = Math.min(500, Math.floor(rawDur / rawInterval));
        updateProgress({ step: 'frames_raw', message: `Mengekstrak ${maxFrames} frame rapat video 1080p (9:16) untuk analisa AI (interval ${rawInterval.toFixed(1)}s)...`, progress: 38, status: 'running' });
        const { frames: rawFrames } = await extractFrames(rawVideoPath, rawFramesDir, updateProgress, {
          sampleIntervalSec: rawInterval,
          maxSampleFrames: maxFrames,
          duration: rawDur,
        });

        // Verifikasi filter lokal pada frame video cache (bebas teks mengambang & bebas wajah)
        const localCacheCheck = await inspectFramesLocally(rawFrames, {
          aspectRatio: options.aspectRatio || '9:16',
          onProgress: updateProgress,
        });
        if (!localCacheCheck.eligible || !Array.isArray(localCacheCheck.cleanFrames) || localCacheCheck.cleanFrames.length < 3) {
          console.warn(`[Job ${jobId}] ⛔ [Cache Ditolak Lokal] ${rawVideoPath}: ${localCacheCheck.reason}`);
          const localCacheErr = new Error(`Analisa lokal ditolak pada cache: ${localCacheCheck.reason}`);
          localCacheErr.isAiRejection = true;
          localCacheErr.rejectionReason = localCacheCheck.reason;
          throw localCacheErr;
        }

        highlight = await selectHighlightWithAI({
          apiKey,
          aiProvider,
          frames: localCacheCheck.cleanFrames,
          videoPath: rawVideoPath,
          videoMetadata: videoMeta,
          productTitle,
          productDescription,
          productImage: effectiveProductImage,
          shopeeLink,
          sceneDuration,
          allowFallbackClips: !requireCleanGeminiPlan,
          isVideoFirst: Boolean(options.isVideoFirst),
          niche: options.niche || 'kitchen_tools',
          creativePlan,
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

    // Candidate harvesting may inspect multiple sources, but final editing does NOT require multi-source.
    // The verified-source selector prefers one consistent source whenever it already has rich footage.
    const preferMultiVideo = options.singleVideoOnly === true ? false : true;

    if (!approved && currentYoutubeUrl && !preferMultiVideo) {
      try {
        const initialRes = await evaluateCandidate(currentYoutubeUrl, '', {
          isVisualSearch: Boolean(effectiveProductImage),
        });
        const initialClips = initialRes.highlight?.clips || [];
        const initialDuration = initialClips.reduce((acc, c) => acc + (c.duration || sceneDuration), 0);
        const minRequiredClips = options.singleVideoOnly ? 3 : 5;
        const minRequiredDur = options.singleVideoOnly ? 15.0 : 25.0;
        if (initialClips.length >= minRequiredClips && initialDuration >= minRequiredDur) {
          highlight = initialRes.highlight;
          videoMeta = initialRes.videoMeta;
          previewVideoPath = initialRes.previewVideoPath;
          approved = true;
        } else {
          console.log(`[Job ${jobId}] ⚠️ Video tunggal (${currentYoutubeUrl}) hanya menghasilkan ${initialClips.length} klip (${initialDuration.toFixed(1)}s, target minimal ${minRequiredDur}s). Membuka Multi-Video Harvesting (stream 3-5 video) untuk variasi adegan & durasi penuh...`);
          if (!targetCandidates) targetCandidates = [];
          targetCandidates.unshift({
            url: currentYoutubeUrl,
            title: initialRes.videoMeta?.title || productTitle,
            duration: initialRes.videoMeta?.duration || 60,
          });
        }
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

    // Jika belum disetujui atau masuk mode Multi-Video Harvesting: Jalankan Stream 3-5 Video & Frame Pooling!
    if (!approved) {
      const allowAutoSearch = options.autoSearchFallback !== false && Boolean(productTitle);
      if (!allowAutoSearch && !preferMultiVideo) {
        throw lastRejectionError || new Error('Video ditolak oleh AI.');
      }

      const engineName = aiProvider === 'gemini' ? 'Google Gemini Direct' : 'AI';
      updateProgress({
        step: 'auto_search_fallback',
        message: preferMultiVideo
          ? `Menyiapkan streaming 3-4 video untuk target "${coreProductNoun}"...`
          : `⛔ Video awal ditolak AI (${lastRejectionError?.rejectionReason || 'tidak cocok'}). ${engineName} mencari video YouTube baru untuk target "${coreProductNoun}"...`,
        progress: 15,
        status: 'running',
        coreProductNoun,
      });

      console.log(`[Job ${jobId}] Memulai pencarian/streaming kandidat YouTube (3-5 video) untuk "${productTitle}"...`);

      let searchIteration = 0;
      let candidatePool = Array.isArray(targetCandidates) ? [...targetCandidates] : [];

      // Manual OEM sources are an explicit user override. They MUST still pass
      // the local frame/scene gate, but NEVER enter Gemini product-match verification.
      const manualOemUrls = Array.from(new Set([
        ...(Array.isArray(options.oemUrls) ? options.oemUrls : []),
        options.oemUrl1,
        options.oemUrl2,
        extraJobMeta?.oemUrl1,
        extraJobMeta?.oemUrl2,
      ].map(v => String(v || '').trim()).filter(Boolean)));

      for (const oemUrl of manualOemUrls) {
        if (!isValidHttpUrl(oemUrl) || !extractVideoId(oemUrl)) {
          console.warn(`[Job ${jobId}] ⚠️ OEM URL manual diabaikan karena bukan URL YouTube yang valid: ${oemUrl}`);
          continue;
        }
        if (!candidatePool.some(c => c?.url === oemUrl)) {
          candidatePool.push({
            url: oemUrl,
            title: productTitle || 'OEM Manual',
            source: 'manual_oem',
            manualOem: true,
            skipGeminiProductMatch: true,
          });
        }
      }

      if (currentYoutubeUrl && !candidatePool.some(c => c.url === currentYoutubeUrl)) {
        candidatePool.unshift({
          url: currentYoutubeUrl,
          title: productTitle,
        });
      }

      // Identity-first discovery: do NOT automatically search by product image.
      // Visual/image search is intentionally reserved for future explicit modes.
      // Automatic candidates now come only from Brand + Model/Type identity queries.
      // 2. Multi-Engine Keyword Search jika belum mencapai target minimal 10 kandidat
      while (searchIteration < 3 && candidatePool.length < 10) {
        const fresh = await discoverYouTubeCandidatesForProduct({
          productTitle,
          productDescription,
          limit: 8,
          excludeVideoIds: usedVids,
          searchIteration,
          onProgress: (p) => updateProgress({ ...p, status: 'running' }),
        });
        if (fresh && fresh.length > 0) {
          for (const cand of fresh) {
            if (!candidatePool.some(t => (t.url && t.url === cand.url) || (t.id && t.id === cand.id))) {
              candidatePool.push(cand);
            }
          }
        }
        searchIteration++;
      }

      if (!candidatePool || candidatePool.length === 0) {
        // Coba variasi kata kunci alternatif (brand + model/tipe) sebelum menyerah
        const info = extractCoreProductInfo(productTitle, productDescription);
        const b = (info.brand || options.brand || '').trim();
        const m = (info.model || options.model || '').trim();
        const p = (info.coreProductNoun || options.productType || '').trim();
        const fallbackQueries = [
          b && m ? `${b} ${m} review indonesia` : '',
          b && m ? `${b} ${m} review` : '',
          b && m ? `unboxing ${b} ${m}` : '',
          b && p ? `${b} ${p} review` : '',
          b && p ? `review ${b} ${p}` : '',
          b ? `${b} review indonesia` : '',
          p ? `${p} review indonesia` : '',
          `${cleanTitle(productTitle)} review`,
          cleanTitle(productTitle),
        ].filter(Boolean);

        for (const altQuery of fallbackQueries) {
          console.log(`[Job ${jobId}] Mencari kandidat cadangan multi-engine: "${altQuery}"...`);
          const altResults = await searchMultiEngineVideos(altQuery, {
            limit: 8,
            excludeVideoIds: usedVids,
            strictIdentity: false,
            youtubeOnly: true,
            onProgress: (p) => updateProgress({ message: `Mencari video alternatif: "${altQuery}"...`, status: 'running' }),
          });
          if (altResults && altResults.length > 0) {
            for (const cand of altResults) {
              if (!candidatePool.some(t => (t.url && t.url === cand.url) || (t.id && t.id === cand.id))) {
                candidatePool.push(cand);
              }
            }
            if (candidatePool.length > 0) break;
          }
        }
      }

      if (!candidatePool || candidatePool.length === 0) {
        throw new Error(`Tidak ditemukan video YouTube yang cocok untuk "${productTitle}": ${lastRejectionError?.rejectionReason || 'kandidat kosong'}.`);
      }

      let maxStreamVideos = 8; // Adaptif hingga 8 video agar footage cukup bervariasi dan tidak gagal
      let streamedCount = 0;
      let candidatePoolIndex = 0;
      let candidateResults = [];
      let hl = null;
      let pooledFrames = [];
      const blacklistedFramePaths = new Set();
      const retainedCleanFrames = [];

      // Helper: Pemanenan adaptif video pengganti di YouTube jika AI menolak frame atau slot kurang
      const harvestAdaptiveReplacementCandidates = async ({
        querySuggestions = [],
        missingSlots = [],
        reason = '',
      } = {}) => {
        const prodInfo = extractCoreProductInfo(productTitle, productDescription);
        const b = (prodInfo.brand || options.brand || '').trim();
        const p = (prodInfo.coreProductNoun || prodInfo.cleanTitle || productTitle || '').trim();
        const combinedBP = (b && p && normalizeText(b) !== normalizeText(p)) ? `${b} ${p}` : (p || b);

        const customQueries = [];
        if (querySuggestions && Array.isArray(querySuggestions)) {
          customQueries.push(...querySuggestions);
        }

        // Jika slot peragaan/aksi kurang, cari video demo aktif
        const needsAction = missingSlots.some(s => String(s).includes('action') || String(s).includes('demo') || String(s).includes('result'));
        if (needsAction) {
          customQueries.push(
            `${combinedBP} cara pakai`,
            `${combinedBP} demo`,
            `${combinedBP} tutorial`,
            `${combinedBP} hands on`
          );
        } else {
          customQueries.push(
            `${combinedBP} review`,
            `${combinedBP} unboxing`,
            `${combinedBP} preview`
          );
        }
        customQueries.push(
          `${combinedBP} tanpa bicara`,
          `${cleanTitle(productTitle)} review`,
          `${cleanTitle(productTitle)} demo`
        );

        const validQueries = [...new Set(customQueries.filter(q => q && q.length > 3))];

        console.log(`[Job ${jobId}] 🔎 Merespons laporan AI (${reason || 'frame ditolak / slot kurang'}). Mencari video pengganti baru di YouTube...`);

        for (const query of validQueries) {
          try {
            updateProgress({
              message: `Mencari video pengganti di YouTube: "${query.slice(0, 32)}..."`,
              status: 'running',
            });
            const altResults = await searchMultiEngineVideos(query, {
              limit: 6,
              excludeVideoIds: usedVids,
              strictIdentity: false,
              youtubeOnly: true,
            });

            if (altResults && altResults.length > 0) {
              let addedCount = 0;
              for (const cand of altResults) {
                const candVid = extractVideoId(cand.url) || cand.id;
                if (candVid && !usedVids.has(candVid) && !candidatePool.some(t => (t.url && t.url === cand.url) || (t.id && t.id === cand.id))) {
                  candidatePool.push(cand);
                  addedCount++;
                }
              }
              if (addedCount > 0) {
                console.log(`[Job ${jobId}] 🎯 Menemukan ${addedCount} video baru dari kueri "${query}"! Total antrean kandidat: ${candidatePool.length}`);
                break;
              }
            }
          } catch (searchErr) {
            console.warn(`[Job ${jobId}] Pencarian pengganti "${query}" gagal: ${searchErr.message}`);
          }
        }
      };

      console.log(`[Job ${jobId}] Memulai Multi-Video Stream & Harvesting adaptif (maksimal stream ${maxStreamVideos} video, target klip 30-35s) untuk "${productTitle}"...`);

      while (streamedCount < maxStreamVideos) {
        // 1. Jika antrean candidatePool habis sebelum kuota stream tercapai, cari kandidat pengganti tambahan
        if (candidatePoolIndex >= candidatePool.length) {
          if (searchIteration >= 4) {
            console.warn(`[Job ${jobId}] Mencapai batas maksimal iterasi pencarian (${searchIteration}). Menghentikan pencarian video tambahan.`);
            break;
          }
          console.log(`[Job ${jobId}] Kuota stream masih tersedia (${streamedCount}/${maxStreamVideos}). Mencari kandidat YouTube tambahan untuk "${productTitle}"...`);
          searchIteration++;
          let fresh = await discoverYouTubeCandidatesForProduct({
            productTitle,
            productDescription,
            limit: 8,
            excludeVideoIds: usedVids,
            searchIteration,
            onProgress: (p) => updateProgress({ ...p, status: 'running' }),
          });

          if (!fresh || fresh.length === 0) {
            await harvestAdaptiveReplacementCandidates({
              missingSlots: ['action_demo', 'feature'],
              reason: 'Antrean kandidat kosong sebelum kuota stream terpenuhi',
            });
          }

          if (fresh && fresh.length > 0) {
            for (const cand of fresh) {
              if (!candidatePool.some(t => (t.url && t.url === cand.url) || (t.id && t.id === cand.id))) {
                candidatePool.push(cand);
              }
            }
          }

          // Jika setelah dicari tetap tidak ada kandidat baru sama sekali di internet
          if (candidatePoolIndex >= candidatePool.length) {
            console.warn(`[Job ${jobId}] Tidak ada lagi kandidat video tambahan yang ditemukan di mesin telusur.`);
            break;
          }
        }

        const candidate = candidatePool[candidatePoolIndex++];
        if (!candidate || !candidate.url) continue;

        const candVid = extractVideoId(candidate.url) || candidate.id;
        if (candVid) usedVids.add(candVid);

        const candLabel = `Kandidat #${candidatePoolIndex} (Stream ${streamedCount + 1}/${maxStreamVideos})`;
        updateProgress({
          step: 'stream_sampling',
          message: `[${candLabel}] Memeriksa metadata: "${(candidate.title || productTitle).slice(0, 32)}..."`,
          progress: 18 + Math.round((streamedCount / maxStreamVideos) * 18),
          status: 'running',
        });

        let candMeta, candStreamUrl;
        try {
          const streamRes = await fetchVideoMetadataAndStream(candidate.url, {
            onProgress: updateProgress,
          });
          candMeta = streamRes.metadata;
          candStreamUrl = streamRes.streamUrl;
        } catch (streamErr) {
          console.warn(`[Job ${jobId}] ⚠️ Gagal membaca stream ${candLabel}: ${streamErr.message}. Lanjut kandidat berikutnya...`);
          lastRejectionError = streamErr;
          continue;
        }

        // Cek kepatuhan metadata dasar
        const comp = checkVideoMetadataCompliance(candMeta, productTitle, {
          ...options,
          isVisualSearch: Boolean(options.isVisualSearch || candidate.source === 'bing_visual_search'),
        });
        if (!comp.eligible) {
          console.log(`[Job ${jobId}] ⚠️ ${candLabel} metadata tidak lolos: ${comp.reason}. Melewati kandidat ini...`);
          continue;
        }

        // Kandidat lolos metadata -> lakukan streaming & frame sampling (menambah kuota stream!)
        streamedCount++;
        const currentCandIdx = candidateResults.length;
        const candFramesDir = path.join(rawFramesDir, `cand_${streamedCount}`);
        if (!fs.existsSync(candFramesDir)) fs.mkdirSync(candFramesDir, { recursive: true });

        updateProgress({
          step: 'stream_sampling',
          message: `[${candLabel}] Streaming & sampling frame (${streamedCount}/${maxStreamVideos}): "${(candMeta.title || candidate.title || productTitle).slice(0, 32)}..."`,
          progress: 18 + Math.round((streamedCount / maxStreamVideos) * 18),
          status: 'running',
        });

        let sampleRes;
        try {
          const candDur = candMeta.duration || 300;
          // Sesuai instruksi: 5 menit (300s) = 200 frame, 6 menit (360s) = 240 frame. Rasio utuh (1.5s per frame).
          const candMaxFrames = Math.floor(candDur / 1.5);
          
          sampleRes = await sampleFramesFromStream(candStreamUrl, candFramesDir, {
            duration: candDur,
            maxSampleFrames: candMaxFrames,
            onProgress: updateProgress,
          });
        } catch (sampleErr) {
          console.warn(`[Job ${jobId}] Gagal sampling frame dari stream ${candLabel}: ${sampleErr.message}`);
          lastRejectionError = sampleErr;
          continue;
        }

        if (!sampleRes?.frames || sampleRes.frames.length < 4) {
          console.warn(`[Job ${jobId}] ⚠️ ${candLabel} gagal mengekstrak frame dari stream URL (< 4 frame). Mencari kandidat berikutnya...`);
          continue;
        }

        // Filter granular per-frame: buang frame wajah/intro/rusak/subtitle keras, simpan frame peragaan produk!
        // FACE POLICY (Fase 4): niche diteruskan agar preset gadget mengaktifkan facePolicy
        // presenter_only di gatekeeper → pool cameraResultEligible terbentuk (kitchen: tetap strict).
        const frameFilterRes = await filterCandidateFramesPerFrame(sampleRes.frames, {
          candidateIndex: currentCandIdx,
          candidate: { ...candidate, duration: candMeta.duration, title: candMeta.title },
          niche: options.niche || jobMeta.niche || 'kitchen_tools',
        });

        console.log(`[Job ${jobId}] [${candLabel}] Hasil filter frame: ${frameFilterRes.cleanFrames.length} frame peragaan tangan disimpan (${frameFilterRes.discardedCount} frame wajah/intro disingkirkan).`);

        if (!frameFilterRes.cleanFrames || frameFilterRes.cleanFrames.length < 2) {
          console.warn(`[Job ${jobId}] ⚠️ ${candLabel} frame peragaan bersih tidak mencukupi (${frameFilterRes.cleanFrames?.length || 0} frame). Ditolak filter lokal. Mencari kandidat berikutnya...`);
          lastRejectionError = new Error(`Frame bersih terlalu sedikit (${frameFilterRes.cleanFrames?.length || 0}) karena penolakan filter lokal.`);
          continue;
        }

        const isManualOem = Boolean(
          candidate?.manualOem ||
          candidate?.source === 'manual_oem' ||
          candidate?.skipGeminiProductMatch
        );

        let productVerification;
        if (isManualOem) {
          productVerification = {
            verified: true,
            confidence: 1,
            manualOverride: true,
            method: 'local_qc_only',
            reason: 'OEM manual URL; Gemini product-match verification intentionally bypassed.',
          };
          updateProgress({
            step: 'product_verification',
            message: `[${candLabel}] OEM manual: lolos filter lokal; Gemini product-match dilewati.`,
            progress: 34,
            status: 'running',
          });
          console.log(`[Job ${jobId}] ✅ [${candLabel}] OEM manual diterima setelah Filter Lokal. Gemini product-match DILEWATI.`);
        } else {
          updateProgress({
            step: 'product_verification',
            message: `[${candLabel}] Memastikan jenis, bentuk, dan mekanisme produk sama dengan target...`,
            progress: 34,
            status: 'running',
          });

          try {
            productVerification = await verifyProductCandidateWithAI({
              apiKey,
              aiProvider,
              frames: frameFilterRes.cleanFrames,
              productTitle,
              productDescription,
              productImage: effectiveProductImage,
              productFingerprint,
              niche: options.niche || 'kitchen_tools',
              onProgress: updateProgress,
            });
          } catch (verErr) {
            console.warn(`[Job ${jobId}] ⚠️ Error verifikasi produk AI pada ${candLabel}: ${verErr.message}`);
            productVerification = { verified: false, confidence: 0, reason: verErr.message };
          }

          if (!productVerification?.verified) {
            console.warn(
              `[Job ${jobId}] ⛔ [${candLabel}] Gemini menolak produk (confidence=${Number(productVerification?.confidence || 0).toFixed(2)}): ${productVerification?.reason || 'mismatch'}. Mencari kandidat berikutnya...`
            );
            lastRejectionError = new Error(`Gemini menolak produk: ${productVerification?.reason || 'mismatch'}`);
            continue;
          }

          console.log(`[Job ${jobId}] ✅ [${candLabel}] Produk terverifikasi cocok (confidence=${Number(productVerification.confidence || 0).toFixed(2)}).`);
        }

        candidateResults.push({
          candidateIndex: currentCandIdx,
          candidate: { ...candidate, duration: candMeta.duration, title: candMeta.title },
          videoMeta: candMeta,
          cleanFrames: frameFilterRes.cleanFrames,
          cameraResultEligibleFrames: frameFilterRes.cameraResultEligibleFrames || [],
          discardedFaceTimestamps: frameFilterRes.discardedFaceTimestamps || [],
          discardedViolationTimestamps: frameFilterRes.discardedViolationTimestamps || [],
          cleanTimeWindows: (frameFilterRes.verifiedSegments || []).map(s => ({ start: s.startSec, end: s.endSec })),
          productVerification,
        });

        // Cek kecukupan frame yang terkumpul
        const preferredSoFar = choosePreferredCandidateSet(candidateResults);
        const bestVerified = preferredSoFar[0];
        const totalCleanFrames = preferredSoFar.reduce((acc, c) => acc + (c.cleanFrames?.length || 0), 0);
        const verifiedCandidatesCount = preferredSoFar.filter(c => c?.productVerification?.verified).length;
        const hasRemainingPool = candidatePoolIndex < candidatePool.length;

        // DYNAMIC MULTI-VIDEO HARVESTING FOR REELS:
        // Jumlah SUMBER video terverifikasi minimum sebelum boleh langsung diproses.
        // Default 2 (Kitchen: variasi sudut & latar). Smartphone/gadget preset memakai
        // minVerifiedSources:1 -> begitu 1 video terverifikasi LANGSUNG diproses, jangan
        // terus-terusan men-skip kandidat demi mengejar sumber ke-2 yang langka.
        const nichePresetForSource = getNichePreset(options.niche || 'kitchen_tools');
        const targetMultiSources = Math.max(1, Number(nichePresetForSource?.minVerifiedSources) || 2);
        const shouldKeepHarvesting = verifiedCandidatesCount < targetMultiSources &&
          hasRemainingPool &&
          streamedCount < Math.min(3, maxStreamVideos);

        if (shouldKeepHarvesting) {
          console.log(`[Job ${jobId}] 🎬 Multi-video harvesting: Sudah dapat ${verifiedCandidatesCount} video terverifikasi. Terus stream kandidat berikutnya untuk mendapatkan variasi sudut kamera & latar belakang...`);
          continue;
        }

        // Coba jalankan AI Storyboard jika sudah ada cukup frame
        if ((bestVerified && (bestVerified.cleanFrames?.length || 0) >= 8) || totalCleanFrames >= 8) {
          const testPool = poolMultiCandidateFrames(preferredSoFar, { maxTotalFrames: 500, includeEligible: true })
            .filter(f => !blacklistedFramePaths.has(f.filePath));

          if (testPool.length >= 2) {
            updateProgress({
              step: 'gemini_vision',
              message: `AI Vision menganalisa ${testPool.length} frame peragaan dari ${preferredSoFar.length} video kandidat...`,
              progress: 38,
              status: 'running',
            });

            try {
              const reqEng = (options.aiProvider || aiProvider || process.env.ACTIVE_AI_ENGINE || '').toLowerCase();
              const isGemini = reqEng === 'gemini' || reqEng === 'gemini_direct' || (process.env.GEMINI_API_KEY && reqEng !== 'openrouter');
              const hasGemini = Boolean(getDirectGeminiApiKey(apiKey));
              
              let testHl;
              
              if (isGemini && hasGemini) {
                const validUrls = Array.from(new Set(preferredSoFar.map(c => c.candidate.url).filter(Boolean)));
                const allDiscardedFace = [];
                const allDiscardedViolation = [];
                const allCleanWindows = [];
                
                for (const c of preferredSoFar) {
                  if (Array.isArray(c.discardedFaceTimestamps)) allDiscardedFace.push(...c.discardedFaceTimestamps);
                  if (Array.isArray(c.discardedViolationTimestamps)) allDiscardedViolation.push(...c.discardedViolationTimestamps);
                  if (Array.isArray(c.cleanTimeWindows)) allCleanWindows.push(...c.cleanTimeWindows);
                }
                
                updateProgress({
                  step: 'gemini_vision',
                  message: `Google Gemini 3.6 Flash Stream menganalisa ${validUrls.length} video sekaligus...`,
                  progress: 38,
                  status: 'running',
                });
                
                testHl = await analyzeMultipleYouTubeVideosWithGemini({
                  youtubeUrls: validUrls,
                  apiKey,
                  productTitle,
                  productDescription,
                  productImage: effectiveProductImage,
                  shopeeLink,
                  sceneDuration,
                  allowFallbackClips: true,
                  totalDuration: 600,
                  introCutoffSec: 0,
                  discardedFaceTimestamps: allDiscardedFace,
                  discardedViolationTimestamps: allDiscardedViolation,
                  cleanTimeWindows: allCleanWindows,
                  verifiedSegments: [],
                  isVideoFirst: Boolean(options.isVideoFirst),
                  niche: options.niche || 'kitchen_tools',
                  onProgress: updateProgress,
                });
              } else {
                testHl = await selectHighlightWithAI({
                  apiKey,
                  aiProvider,
                  frames: testPool,
                  videoPath: null,
                  youtubeUrl: null,
                  videoMetadata: { duration: 600, title: productTitle },
                  productTitle,
                  productDescription,
                  productImage: effectiveProductImage,
                  shopeeLink,
                  sceneDuration,
                  allowFallbackClips: true,
                  introCutoffSec: 0,
                  isVideoFirst: Boolean(options.isVideoFirst),
                  niche: options.niche || 'kitchen_tools',
                  creativePlan,
                  onProgress: updateProgress,
                });
              }

              // 1. TANGANI FRAME YANG DITOLAK OLEH AI VISION:
              if (testHl && Array.isArray(testHl.rejectedFrames) && testHl.rejectedFrames.length > 0) {
                console.log(`[Job ${jobId}] 🧹 Mengeliminasi ${testHl.rejectedFrames.length} frame yang ditolak AI dari bank footage aktif...`);
                for (const rf of testHl.rejectedFrames) {
                  if (rf.filePath) blacklistedFramePaths.add(rf.filePath);
                }
                for (const candRes of candidateResults) {
                  if (Array.isArray(candRes.cleanFrames)) {
                    candRes.cleanFrames = candRes.cleanFrames.filter(f => !blacklistedFramePaths.has(f.filePath));
                  }
                }
              }

              // 2. SIMPAN FRAME BERSIH YANG DITERIMA AI:
              if (testHl && Array.isArray(testHl.acceptedFrames) && testHl.acceptedFrames.length > 0) {
                for (const aIdx of testHl.acceptedFrames) {
                  const accF = testPool[aIdx - 1];
                  if (accF && accF.filePath && !blacklistedFramePaths.has(accF.filePath) && !retainedCleanFrames.some(rc => rc.filePath === accF.filePath)) {
                    retainedCleanFrames.push(accF);
                  }
                }
              }

              const currentClips = Array.isArray(testHl?.clips) ? testHl.clips : [];
              const hasMissingSlots = Array.isArray(testHl?.missingSlots) && testHl.missingSlots.length > 0;
              const multiCandidateCount = new Set(currentClips.map(c => c.candidateIndex ?? 0)).size;

              // Kondisi sukses:
              // - Memiliki minimal 5 klip ATAU
              // - Memiliki minimal 3 klip dengan variasi multi-kandidat dan tanpa slot hilang fatal.
              //   Ambang variasi sumber mengikuti targetMultiSources (smartphone boleh 1 sumber penuh).
              const minSourcesForSatisfactory = Math.min(2, targetMultiSources);
              const isSatisfactory = currentClips.length >= 5 || (currentClips.length >= 3 && multiCandidateCount >= minSourcesForSatisfactory && !hasMissingSlots);

              if (isSatisfactory) {
                console.log(`[Job ${jobId}] ✅ AI Vision berhasil memilih ${currentClips.length} cuplikan produk dari ${preferredSoFar.length} video (Multi-sumber: ${multiCandidateCount} video)!`);
                hl = testHl;
                pooledFrames = testPool.filter(f => !blacklistedFramePaths.has(f.filePath));
                candidateResults = preferredSoFar;
                break; // Berhasil dan frame terpenuhi! Hentikan streaming loop.
              } else {
                const missingNames = testHl?.missingSlots?.length > 0 ? testHl.missingSlots.join(', ') : 'kurang variasi adegan/sumber';
                console.warn(`[Job ${jobId}] ⚠️ Cuplikan AI belum lengkap (${currentClips.length} klip, slot kurang: [${missingNames}]). Merespons dengan mencari video baru pengganti di YouTube...`);
                
                // Respons adaptif: panen video baru di YouTube
                await harvestAdaptiveReplacementCandidates({
                  querySuggestions: testHl?.suggestedSearchQueries || [],
                  missingSlots: testHl?.missingSlots || [],
                  reason: `Slot kurang: ${missingNames}`,
                });

                lastRejectionError = new Error(`AI Vision membutuhkan video pengganti untuk slot: [${missingNames}].`);
              }
            } catch (aiErr) {
              console.warn(`[Job ${jobId}] ⚠️ Gemini Vision melaporkan kendala pada footage: ${aiErr.message}.`);
              
              if (Array.isArray(aiErr.rejectedFrames)) {
                for (const rf of aiErr.rejectedFrames) {
                  if (rf.filePath) blacklistedFramePaths.add(rf.filePath);
                }
              }

              // Respons adaptif: panen video baru di YouTube
              await harvestAdaptiveReplacementCandidates({
                querySuggestions: aiErr.suggestedSearchQueries || [],
                missingSlots: aiErr.missingSlots || [],
                reason: aiErr.message,
              });
              
              lastRejectionError = aiErr;
            }
          }
        }
      }

      // Jika loop selesai tapi hl belum terbentuk (misal karena frame kurang dari 8 tapi kandidat sudah di-stream):
      if (!hl && candidateResults.length > 0) {
        candidateResults = choosePreferredCandidateSet(candidateResults);
        if (candidateResults.length > 0) {
          pooledFrames = poolMultiCandidateFrames(candidateResults, { maxTotalFrames: 500, includeEligible: true })
            .filter(f => !blacklistedFramePaths.has(f.filePath));

          if (pooledFrames.length >= 2) {
            updateProgress({
              step: 'gemini_vision',
              message: `AI Vision menganalisa ${pooledFrames.length} frame peragaan dari ${candidateResults.length} video kandidat...`,
              progress: 38,
              status: 'running',
            });

            try {
              hl = await selectHighlightWithAI({
                apiKey,
                aiProvider,
                frames: pooledFrames,
                videoPath: null,
                youtubeUrl: null,
                videoMetadata: { duration: 600, title: productTitle },
                productTitle,
                productDescription,
                productImage: effectiveProductImage,
                shopeeLink,
                sceneDuration,
                allowFallbackClips: true,
                introCutoffSec: 0,
                isVideoFirst: Boolean(options.isVideoFirst),
                niche: options.niche || 'kitchen_tools',
                creativePlan,
                onProgress: updateProgress,
              });
            } catch (finalAiErr) {
              console.warn(`[Job ${jobId}] ⛔ AI Storyboard percobaan akhir gagal: ${finalAiErr.message}`);
              lastRejectionError = finalAiErr;
            }
          }
        }
      }

      // ── GUARANTEED COMPLETION RESCUE PIPELINE ──
      // Jika AI Vision belum menghasilkan hl.clips >= 2, tetapi kita memiliki kumpulan frame bersih
      // dari video yang telah lolos verifikasi produk fisik: JANGAN PERNAH GAGALKAN JOB!
      // Rakit Storyboard Penyelamat (Rescue Storyboard) berkualitas tinggi secara otomatis!
      if (!hl || !Array.isArray(hl.clips) || hl.clips.length < 2) {
        console.log(`[Job ${jobId}] 🛡️ Mengaktifkan Guaranteed Completion Rescue Pipeline untuk memastikan tidak ada job yang gagal...`);
        const allCleanFrames = (retainedCleanFrames.length > 0 ? retainedCleanFrames : pooledFrames)
          .filter(f => f && f.filePath && !blacklistedFramePaths.has(f.filePath));

        if (allCleanFrames.length >= 2) {
          const rescueClips = [];
          const usedSources = new Map();
          const targetClipDuration = Math.max(3.0, Math.min(sceneDuration || 3.5, 4.5));

          for (let i = 0; i < allCleanFrames.length && rescueClips.length < 7; i++) {
            const f = allCleanFrames[i];
            const cIdx = f.candidateIndex !== undefined ? f.candidateIndex : 0;
            const ts = Number(f.timestamp) || 0;
            const prevTimes = usedSources.get(cIdx) || [];

            // Hindari tabrakan timestamp < 5s pada sumber yang sama
            if (prevTimes.some(pt => Math.abs(pt - ts) < 5.0)) continue;

            const startSec = Math.max(0, Math.round(ts * 10) / 10);
            const endSec = Math.round((startSec + targetClipDuration) * 10) / 10;

            rescueClips.push({
              startSeconds: startSec,
              endSeconds: endSec,
              duration: targetClipDuration,
              startTime: formatSeconds(startSec),
              endTime: formatSeconds(endSec),
              candidateIndex: cIdx,
              candidateTitle: f.candidateTitle || f.candidate?.title || productTitle,
              candidateUrl: f.candidateUrl || f.candidate?.url || '',
              videoId: f.videoId || f.candidate?.id || '',
              candidate: f.candidate || null,
              reason: `Peragaan produk bersih dari frame #${i + 1} (${formatSeconds(startSec)})`,
              isCleanAffiliateShot: true,
              hasProductBrand: Boolean(hl?.hasProductBrand),
              reframe: {
                focusXStart: 0.50,
                focusYStart: 0.55,
                focusXEnd: 0.50,
                focusYEnd: 0.55,
                renderMode: rescueClips.length % 2 === 0 ? 'stage_80' : 'center_crop'
              }
            });

            prevTimes.push(startSec);
            usedSources.set(cIdx, prevTimes);
          }

          if (rescueClips.length >= 2) {
            const rescueTotalDuration = rescueClips.reduce((acc, c) => acc + c.duration, 0);
            hl = {
              detectedProduct: productInfo.coreProductNoun || productTitle,
              startTime: rescueClips[0].startTime,
              endTime: rescueClips[rescueClips.length - 1].endTime,
              startSeconds: rescueClips[0].startSeconds,
              endSeconds: rescueClips[rescueClips.length - 1].endSeconds,
              duration: rescueTotalDuration,
              productHook: hl?.productHook || getDynamicProductHookFallback(productTitle),
              hasProductBrand: Boolean(hl?.hasProductBrand),
              detectedBrand: hl?.detectedBrand || 'none',
              allowHflip: true,
              reframe: rescueClips[0].reframe,
              clips: rescueClips,
              isRescueStoryboard: true,
            };
            console.log(`[Job ${jobId}] ✅ Berhasil merakit ${rescueClips.length} klip bersih dari ${usedSources.size} video via Rescue Storyboard (${rescueTotalDuration.toFixed(1)}s). Job DIJAMIN BERHASIL.`);
          }
        }
      }

      if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
        throw new Error(
          `Semua kandidat video (telah di-stream ${streamedCount} video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "${productTitle}": ${lastRejectionError?.rejectionReason || lastRejectionError?.message || 'frame tidak mencukupi / ditolak filter atau AI'}.`
        );
      }

      // Targeted Download: Unduh 1080p HANYA untuk kandidat yang klipnya terpilih oleh AI!
      const neededIndices = [...new Set(hl.clips.map(c => c.candidateIndex !== null && c.candidateIndex !== undefined ? c.candidateIndex : 0))];
      if (neededIndices.length < 1) {
        throw new Error(`Klip terpilih tidak memiliki video sumber yang valid.`);
      }
      console.log(`[Job ${jobId}] AI memilih ${hl.clips.length} cuplikan dari ${neededIndices.length} video kandidat indeks: [${neededIndices.join(', ')}]. Mengunduh 1080p Full HD...`);

      let lastDlError = null;

      // Track every HD source actually downloaded so multi-video storyboards,
      // post-download audits, and recovery clips can resolve candidateIndex -> file path.
      // This map MUST exist before the progress calculation and download loop below.
      const downloadedCandidatesMap = new Map();

      // #1 Download per-segmen (hemat kuota). DEFAULT OFF → jalur render identik dengan sebelumnya.
      const useSections = process.env.RENDER_DOWNLOAD_SECTIONS === '1';
      const secPadSec = Number(process.env.RENDER_SECTION_PAD || 2) || 2;
      const secTailPadSec = Number(process.env.RENDER_SECTION_TAIL_PAD || 5) || 5;
      const secGapSec = Number(process.env.RENDER_SECTION_GAP || 15) || 15;
      if (useSections) console.log(`[Job ${jobId}] ✂️ RENDER_DOWNLOAD_SECTIONS aktif: unduh hanya rentang klip (pad ${secPadSec}s / ekor ${secTailPadSec}s / gap ${secGapSec}s).`);

      for (const candIdx of neededIndices) {
        const candObj = candidateResults.find(c => c.candidateIndex === candIdx)?.candidate || candidateResults[candIdx]?.candidate;
        if (!candObj?.url) continue;

        updateProgress({
          step: 'download_hd',
          message: `Mengunduh video sumber #${candIdx + 1} (${(candObj.title || '').slice(0, 30)}...) kualitas 1080p Full HD...`,
          progress: 46 + Math.round((downloadedCandidatesMap.size / neededIndices.length) * 12),
          status: 'running',
        });

        try {
          const candClips = hl.clips.filter(c => (c.candidateIndex ?? 0) === candIdx);
          if (useSections && candClips.length > 0) {
            const clusters = planSectionDownloads(candClips, {
              padSec: secPadSec,
              tailPadSec: secTailPadSec,
              gapSec: secGapSec,
              videoDuration: Number(candObj.duration) || 0,
            });
            let allClustersOk = clusters.length > 0;
            for (let k = 0; k < clusters.length; k++) {
              const cluster = clusters[k];
              try {
                const secDl = await downloadYouTubeVideo(candObj.url, sessionTempDir, jobId, updateProgress, {
                  quality: '1080p',
                  prefix: `raw_cand_${candIdx}_sec${k}`,
                  section: { startSec: cluster.startSec, endSec: cluster.endSec },
                });
                if (secDl?.filePath && fs.existsSync(secDl.filePath)) {
                  if (!downloadedCandidatesMap.has(candIdx)) downloadedCandidatesMap.set(candIdx, secDl.filePath);
                  cluster.refs.forEach(ref => { ref._cluster = { videoPath: secDl.filePath, sourceOffsetSec: cluster.sourceOffsetSec }; });
                  console.log(`[Job ${jobId}] ✂️ Segmen #${k} kandidat #${candIdx + 1} (${cluster.startSec.toFixed(1)}-${cluster.endSec.toFixed(1)}s) terunduh (hemat kuota).`);
                } else {
                  allClustersOk = false;
                }
              } catch (secErr) {
                allClustersOk = false;
                console.warn(`[Job ${jobId}] ⚠️ Gagal unduh segmen #${k} kandidat #${candIdx + 1}: ${secErr.message}`);
              }
            }
            if (allClustersOk) continue; // kandidat selesai via per-segmen
            // Sebagian/gagal total: bersihkan penanda cluster lalu fallback ke unduhan penuh.
            candClips.forEach(c => { delete c._cluster; });
            console.warn(`[Job ${jobId}] 🔄 Segmen kandidat #${candIdx + 1} tidak lengkap; fallback ke unduhan penuh.`);
          }

          const hdDl = await downloadYouTubeVideo(candObj.url, sessionTempDir, jobId, updateProgress, {
            quality: '1080p',
            prefix: `raw_cand_${candIdx}`,
          });

          if (hdDl?.filePath && fs.existsSync(hdDl.filePath)) {
            downloadedCandidatesMap.set(candIdx, hdDl.filePath);
            console.log(`[Job ${jobId}] ✅ Video 1080p Full HD untuk Kandidat #${candIdx + 1} berhasil diunduh (${hdDl.filePath}).`);
          } else {
            console.warn(`[Job ${jobId}] Gagal mengunduh 1080p untuk Kandidat #${candIdx + 1}.`);
          }
        } catch (dlErr) {
          lastDlError = dlErr;
          console.warn(`[Job ${jobId}] ⚠️ Gagal mengunduh 1080p untuk Kandidat #${candIdx + 1}: ${dlErr.message}`);
        }
      }

      // Jika seluruh kandidat yang dipilih AI gagal diunduh,
      // coba unduh kandidat cadangan dari candidateResults yang sudah lolos filter visual!
      if (downloadedCandidatesMap.size === 0) {
        console.warn(`[Job ${jobId}] ⚠️ Tidak ada kandidat terpilih yang berhasil diunduh HD. Mencoba kandidat cadangan dari pool yang lolos filter visual...`);
        const fallbackCandidates = candidateResults.filter(c => !neededIndices.includes(c.candidateIndex));
        for (const altCand of fallbackCandidates) {
          if (downloadedCandidatesMap.size >= 1) break;
          const altIdx = altCand.candidateIndex;
          const candObj = altCand.candidate;
          if (!candObj?.url) continue;

          try {
            console.log(`[Job ${jobId}] 🔄 Mencoba mengunduh HD kandidat cadangan #${altIdx + 1}: ${candObj.title}...`);
            const altDl = await downloadYouTubeVideo(candObj.url, sessionTempDir, jobId, updateProgress, {
              quality: '1080p',
              prefix: `raw_cand_${altIdx}`,
            });
            if (altDl?.filePath && fs.existsSync(altDl.filePath)) {
              downloadedCandidatesMap.set(altIdx, altDl.filePath);
              console.log(`[Job ${jobId}] ✅ Kandidat cadangan #${altIdx + 1} berhasil diunduh HD (${altDl.filePath}).`);

              // Remap klip yang video-nya gagal diunduh ke kandidat cadangan ini
              const failedIndices = neededIndices.filter(idx => !downloadedCandidatesMap.has(idx));
              if (failedIndices.length > 0) {
                const targetFailedIdx = failedIndices[0];
                hl.clips = hl.clips.map(c => {
                  if (c.candidateIndex === targetFailedIdx) {
                    return { ...c, candidateIndex: altIdx, videoPath: altDl.filePath };
                  }
                  return c;
                });
              }
            }
          } catch (altErr) {
            console.warn(`[Job ${jobId}] ⚠️ Kandidat cadangan #${altIdx + 1} gagal diunduh: ${altErr.message}`);
          }
        }
      }

      // Jika seluruh kandidat gagal diunduh (termasuk jika diblokir YouTube)
      if (downloadedCandidatesMap.size === 0) {
        throw lastDlError || new Error('Gagal mengunduh video 1080p Full HD dari seluruh kandidat terpilih.');
      }

      // Evaluasi apakah video 1080p yang sudah terunduh dapat memenuhi kebutuhan frame
      const validDownloadedClips = hl.clips.filter(c => {
        const candIdx = c.candidateIndex !== null && c.candidateIndex !== undefined ? c.candidateIndex : 0;
        return downloadedCandidatesMap.has(candIdx);
      });
      const validDownloadedCandidates = new Set(validDownloadedClips.map(c => c.candidateIndex !== null && c.candidateIndex !== undefined ? c.candidateIndex : 0));

      if (validDownloadedCandidates.size < 1) {
        console.warn(`[Job ${jobId}] ⛔ Tidak ada video 1080p yang berhasil diunduh.`);
        throw lastDlError || new Error(`Video 1080p yang berhasil diunduh tidak valid.`);
      }

      if (validDownloadedClips.length >= 1) {
        hl.clips = validDownloadedClips;
        console.log(`[Job ${jobId}] 🎯 Menggunakan video 1080p yang telah terunduh (${hl.clips.length} cuplikan dari ${validDownloadedCandidates.size} video sumber).`);
      }

      // Petakan videoPath 1080p ke masing-masing klip yang terpilih
      hl.clips = hl.clips.map(c => {
        // Klip yang sudah punya file segmen sendiri (mode --download-sections): pakai path + sourceOffsetSec-nya.
        if (c._cluster) {
          const { _cluster, ...rest } = c;
          return { ...rest, videoPath: _cluster.videoPath, sourceOffsetSec: _cluster.sourceOffsetSec };
        }
        const candIdx = c.candidateIndex !== null && c.candidateIndex !== undefined ? c.candidateIndex : 0;
        let vPath = downloadedCandidatesMap.get(candIdx);
        if (!vPath) {
          // NEVER remap a missing source to Video #1. That silently turns a multi-source
          // storyboard into repeated footage.
          console.warn(`[Job ${jobId}] ⛔ Video kandidat #${candIdx + 1} tidak tersedia di 1080p. Klip sumber ini dibuang, bukan dialihkan ke video lain.`);
          return null;
        }
        return {
          ...c,
          videoPath: vPath,
          sourceOffsetSec: 0,
        };
      }).filter(Boolean);

      // NEVER manufacture extra scenes by copying an existing clip.
      // Minimum 3 adegan unik fisik produk untuk menghasilkan reel/short affiliate berkualitas tinggi (13-25 detik).
      if (hl.clips.length < 3) {
        const clipErr = new Error(
          `AI Vision hanya menghasilkan ${hl.clips.length} adegan unik (<3). Tidak akan menggandakan adegan untuk mengejar durasi.`
        );
        clipErr.isAiRejection = true;
        clipErr.rejectionReason = 'Adegan unik produk kurang dari 3 klip fisik bersih.';
        throw clipErr;
      }

      // Pacing adaptif: minimal durasi video adalah 18.0 detik sesuai mandat pengguna
      const targetMinTotalSec = Math.max(18.0, hl.clips.length <= 3 ? 18.0 : (hl.clips.length <= 4 ? 18.5 : (hl.clips.length <= 5 ? 19.5 : 22.0)));
      const adaptiveClipSec = Math.max(3.2, Math.min(6.0, Math.round((targetMinTotalSec / hl.clips.length) * 10) / 10));

      hl.clips = hl.clips.map((c, clipIndex) => {
        const planShot = creativePlan?.shots?.[clipIndex];
        const duration = Math.max(adaptiveClipSec, Number(planShot?.targetSec) || Number(c.duration) || adaptiveClipSec);
        return {
          ...c,
          duration,
          endSeconds: Number(c.startSeconds) + duration,
          endTime: formatSeconds(Number(c.startSeconds) + duration),
          storyboardRole: c.storyboardRole || planShot?.role || `scene_${clipIndex + 1}`,
          creativePurpose: planShot?.purpose || '',
        };
      });
      hl.duration = hl.clips.reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
      console.log(`[Job ${jobId}] 🎬 Story-first pacing aktif (${hl.clips.length} klip, ${hl.duration.toFixed(1)}s total - target min 18s):\n${describeCreativePlan(creativePlan)}`);

      // Keperluan backward compatibility: inputVideo tetap diisi, tetapi setiap clip
      // wajib mempunyai videoPath sumbernya sendiri dan renderer tidak boleh memakai
      // rawVideoPath sebagai pengganti sumber klip multi-video.
      rawVideoPath = [...downloadedCandidatesMap.values()][0];
      highlight = hl;
      approved = true;

      // Update metadata job
      const primeCand = candidateResults[0]?.candidate || candidatePool[0];
      currentYoutubeUrl = primeCand?.url || currentYoutubeUrl;
      jobMeta.youtubeUrl = currentYoutubeUrl;
      jobMeta.videoTitle = primeCand?.title || productTitle;
      activeJobs.set(jobId, jobMeta);
      persistJob(jobId, jobMeta);
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

    // ── AUDIT WAJAH MULTI-TITIK PASCA-DOWNLOAD (ANTI-WAJAH 1 DETIK) ──
    // Mengekstrak 2 frame per klip (t+0.8s dan t+2.2s) dari video 1080p yang sudah diunduh
    // untuk memverifikasi kualitas klip (bebas teks overlay/animasi promosi, wajah manusia, dan bumper grafis).
    if (Array.isArray(highlight.clips) && highlight.clips.length > 0) {
      updateProgress({
        step: 'clip_audit',
        message: 'Melakukan audit kualitas multi-titik (anti-teks & anti-wajah) pada klip terpilih...',
        progress: 60,
        status: 'running'
      });

      const auditFramesDir = path.join(sessionTempDir, 'clip_audit_frames');
      if (!fs.existsSync(auditFramesDir)) fs.mkdirSync(auditFramesDir, { recursive: true });

      const cleanAuditedClips = [];
      const discardedDirtyClips = [];

      for (let cIdx = 0; cIdx < highlight.clips.length; cIdx++) {
        const c = highlight.clips[cIdx];
        const clipVid = c.videoPath || rawVideoPath;
        if (!clipVid || !fs.existsSync(clipVid)) {
          cleanAuditedClips.push(c);
          continue;
        }

        const dur = Math.max(1.5, Number(c.duration || 3.3));
        // High-density temporal audit (2.5 FPS across entire clip span)
        // Eliminates temporal blind spots where watermarks, creator logos, or faces flash in between snapshots
        const sampleStepSec = 0.40; // Every 400ms (2.5 fps)
        const sampleOffsets = [];
        for (let offset = 0.20; offset <= Math.max(0.20, dur - 0.20); offset += sampleStepSec) {
          sampleOffsets.push(Math.round(offset * 100) / 100);
        }
        // Always include near the end of the clip to catch closing subtitles or logos
        const endOffset = Math.round(Math.max(0.20, dur - 0.20) * 100) / 100;
        if (!sampleOffsets.includes(endOffset)) {
          sampleOffsets.push(endOffset);
        }
        const sampleTimestamps = sampleOffsets.map(offset => Math.round((c.startSeconds + offset) * 100) / 100);

        const frameExtractTasks = sampleTimestamps.map((ts, sIdx) => {
          const framePath = path.join(auditFramesDir, `clip_${cIdx}_s${sIdx}.jpg`);
          return extractSingleFrameAsync(clipVid, ts, framePath).then(ok => (ok ? { filePath: framePath, timestamp: ts } : null));
        });

        const testFrames = (await Promise.all(frameExtractTasks)).filter(Boolean);

        // HARD MOTION GATE: a valid affiliate clip must contain real physical motion.
        // Reject still photos with zoom/pan effects before any AI Gatekeeper result can
        // accidentally classify the moving pixels as a legitimate video.
        const motionAudit = auditRealMotionFromFrames(testFrames.map(f => f.filePath));
        if (motionAudit.likelyStatic) {
          console.warn(
            `[ClipAudit] ⛔ Segment klip #${cIdx + 1} ditolak: kemungkinan foto/slideshow/Ken Burns (SSIM median=${motionAudit.median?.toFixed(4)}).`
          );
          discardedDirtyClips.push({
            clip: c,
            reason: 'STATIC_PHOTO_OR_KEN_BURNS',
          });
          continue;
        }

        // ─── CLIP AUDIT: HANYA CEGAH FOTO STATIS / KEN BURNS ───
        // Pengecekan teks overlay & wajah sudah dilakukan oleh Gemini di tahap Source QC.
        // ClipAudit pasca-download TIDAK BOLEH menolak klip karena teks/wajah.
        // Hal ini menyebabkan kuota internet terbuang percuma setelah download selesai.
        // Satu-satunya pemblokiran yang diizinkan di sini adalah klip FOTO DIAM (sudah ditangani oleh motionAudit di atas).
        cleanAuditedClips.push(c);
      }

      if (discardedDirtyClips.length > 0) {
        console.log(`[ClipAudit] Berhasil membuang ${discardedDirtyClips.length} klip kotor (teks overlay/wajah/bumper). Tersisa ${cleanAuditedClips.length} klip bersih.`);

        // 1. Pastikan Slot 1 (Visual Produk Utuh) tetap ada!
        const hasSlot1 = cleanAuditedClips.some(c => c.storyboardSlot === 1);
        if (!hasSlot1 && cleanAuditedClips.length > 0) {
          console.warn(`[ClipAudit] ⚠️ Slot 1 (Hero Produk Utuh) terbuang pada audit. Memulihkan Slot 1 dari klip pertama bersih...`);
          cleanAuditedClips[0].storyboardSlot = 1;
          cleanAuditedClips[0].storyboardRole = 'full_product';
        }

        // Adaptive clip pacing: minimal durasi video adalah 18.0 detik
        if (cleanAuditedClips.length >= 3) {
          const targetMinSec = 18.0;
          const targetPerClip = Math.max(3.2, Math.min(6.0, targetMinSec / cleanAuditedClips.length));
          highlight.clips = cleanAuditedClips.map((c, clipIndex) => {
            const planShot = creativePlan?.shots?.[clipIndex];
            const duration = Math.max(targetPerClip, Number(planShot?.targetSec) || Number(c.duration) || targetPerClip);
            return {
              ...c,
              duration,
              endSeconds: Number(c.startSeconds) + duration,
              endTime: formatSeconds(Number(c.startSeconds) + duration),
              storyboardRole: c.storyboardRole || planShot?.role || `scene_${clipIndex + 1}`,
              creativePurpose: c.creativePurpose || planShot?.purpose || '',
            };
          });
          highlight.duration = highlight.clips.reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
          console.log(`[ClipAudit] ✅ Mempertahankan ${highlight.clips.length} klip bersih hasil audit (total ${highlight.duration.toFixed(1)}s - min 18s) dengan pacing adaptif.`);
        } else {
          // USER MANDATE: Jika klip terpilih terbuang sebagian/seluruhnya pada audit, JANGAN buang video!
          // Gabungkan klip bersih yang ada dengan frame peragaan bersih di pooledFrames dari video yang sama!
          console.warn(`[ClipAudit] ⚠️ Klip bersih tersisa (${cleanAuditedClips.length}) kurang dari 3. Memulihkan klip dari frame bersih alternatif pada video yang sama...`);
          const recoveryFrames = (pooledFrames || [])
            .filter(f => f && Number(f.timestamp) > 0)
            .filter(f => f.candidateIndex !== undefined && f.candidateIndex !== null);

          const recoveryClips = [...cleanAuditedClips];
          const usedRecoveryKeys = new Set(cleanAuditedClips.map(c => `${c.candidateIndex}:${Math.round(c.startSeconds * 10) / 10}`));
          for (let rIdx = 0; rIdx < recoveryFrames.length && recoveryClips.length < 6; rIdx++) {
            const frame = recoveryFrames[rIdx];
            const candIdx = Number(frame.candidateIndex);
            const ts = Number(frame.timestamp);
            const key = `${candIdx}:${Math.round(ts * 10) / 10}`;
            const sourcePath = downloadedCandidatesMap.get(candIdx);
            if (!sourcePath || usedRecoveryKeys.has(key)) continue;

            usedRecoveryKeys.add(key);
            recoveryClips.push({
              startSeconds: ts,
              endSeconds: ts + 3.8,
              duration: 3.8,
              startTime: formatSeconds(ts),
              endTime: formatSeconds(ts + 3.8),
              storyboardSlot: recoveryClips.length + 1,
              reason: `Recovered Clean Segment #${recoveryClips.length}`,
              candidateIndex: candIdx,
              videoPath: sourcePath,
            });
          }

          if (recoveryClips.length >= 3) {
            const targetMinSec = 18.0;
            const targetPerClip = Math.max(3.2, Math.min(6.0, targetMinSec / recoveryClips.length));
            highlight.clips = recoveryClips.slice(0, 8).map((c, clipIndex) => {
              const planShot = creativePlan?.shots?.[clipIndex];
              const duration = Math.max(targetPerClip, Number(planShot?.targetSec) || targetPerClip);
              return {
                ...c,
                duration,
                endSeconds: Number(c.startSeconds) + duration,
                endTime: formatSeconds(Number(c.startSeconds) + duration),
                storyboardRole: planShot?.role || c.storyboardRole || `scene_${clipIndex + 1}`,
                creativePurpose: planShot?.purpose || '',
              };
            });
            highlight.duration = highlight.clips.reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
            console.log(`[ClipAudit] 🛡️ Memulihkan ${highlight.clips.length} klip unik tanpa duplikasi (total ${highlight.duration.toFixed(1)}s - min 18s).`);
          } else {
            console.warn(`[ClipAudit] Tidak ditemukan klip bersih tersisa pada video.`);
            const auditErr = new Error('Video ditolak pada audit pasca-download: seluruh bagian video mengandung teks overlay promosi, bumper statis, atau wajah.');
            auditErr.isAiRejection = true;
            auditErr.rejectionReason = 'Mengandung teks overlay promosi, bumper statis, atau wajah manusia.';
            throw auditErr;
          }
        }
      } else {
        console.log(`[ClipAudit] ✅ Seluruh ${highlight.clips.length} klip terverifikasi 100% bersih bebas teks overlay, bumper statis, dan wajah.`);
      }
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

    const actualSilentDuration = (await getMediaDurationSec(silentOutputPath)) || highlight.duration || 33;
    highlight.duration = actualSilentDuration;

    updateProgress({ step: 'frames_trimmed', message: 'Sampling frames from trimmed video for AI scripting...', progress: 72, status: 'running' });
    const { frames: trimmedFrames } = await extractFrames(silentOutputPath, trimmedFramesDir, updateProgress, {
      sampleIntervalSec: 2.2,
      maxSampleFrames: 12,
    });

    updateProgress({ step: 'gpt_scripting', message: 'AI generating Kotak Scene, Context, Naskah...', progress: 80, status: 'running' });
    let scriptData;
    try {
      scriptData = await generateAdAdvisorScriptWithAI({
        apiKey,
        aiProvider,
        trimmedFrames,
        videoMetadata: videoMeta,
        productTitle: (highlight.detectedProduct || productTitle || '').trim(),
        productDescription,
        shopeeLink,
        productHook: highlight.productHook,
        segmentDuration: actualSilentDuration,
        sceneDuration,
        niche: options.niche || 'kitchen_tools',
        creativePlan,
        onProgress: updateProgress,
      });
    } catch (scriptErr) {
      const isGadget = (options.niche === 'gadget_smartphone');
      console.warn(`[Job ${jobId}] AI Scripting failed (${scriptErr.message}). Menggunakan smart fallback naskah ${isGadget ? 'Smartphone Shorts' : 'Shopee'}...`);
      const fallbackProductName = (highlight.detectedProduct || productTitle || videoMeta?.title || 'produk ini').trim();
      const mechanismLabels = {
        manual_pull_cord: 'mekanisme tali tarik manual',
        manual_rotary: 'mekanisme putar manual',
        manual_press: 'mekanisme tekan manual',
        vacuum_suction: 'mekanisme vakum',
        pump: 'mekanisme pompa',
        gravity_feed: 'mekanisme aliran gravitasi',
        electric_motor: 'mekanisme motor elektrik',
      };
      const mechanismPhrase = mechanismLabels[productFingerprint?.mechanism] || 'mekanisme utamanya';
      const fallbackHook = highlight.productHook || (
        isGadget
          ? `Lihat detail fisik dan penggunaan ${fallbackProductName} ini.`
          : `Lihat langsung cara kerja ${fallbackProductName} ini.`
      );
      const stepSec = Math.max(3.0, actualSilentDuration / 5);
      const ts0 = '00:00';
      const ts1 = formatSeconds(Math.round(stepSec));
      const ts2 = formatSeconds(Math.round(stepSec * 2));
      const ts3 = formatSeconds(Math.round(stepSec * 3));
      const ts4 = formatSeconds(Math.round(Math.max(stepSec * 4, actualSilentDuration - 3.5)));

      const fallbackVoiceScript = isGadget
        ? `[${ts0}] [excited] ${fallbackHook}
[${ts1}] [emphasis] Di sini bentuk bodi dan bagian utamanya terlihat jelas.
[${ts2}] [neutral] Berikut tampilan saat perangkat benar-benar digunakan.
[${ts3}] [neutral] Perhatikan detail fisik dan hasil yang memang terlihat di video.
[${ts4}] [soft] Cek spesifikasi resmi produknya sebelum menentukan pilihan.`
        : `[${ts0}] [excited] ${fallbackHook}
[${ts1}] [emphasis] Bentuk produk dan bagian utamanya terlihat jelas di sini.
[${ts2}] [neutral] Sekarang perhatikan ${mechanismPhrase} saat digunakan.
[${ts3}] [neutral] Ini hasil penggunaan yang benar-benar tampak di video.
[${ts4}] [excited] Cek detail produk di bawah dan sesuaikan dengan kebutuhanmu.`;

      scriptData = {
        sampleContext: {
          productName: fallbackProductName,
          videoDuration: `${Math.round(actualSilentDuration)} detik`,
          targetAudience: isGadget ? 'Penonton yang ingin melihat demonstrasi fisik perangkat' : 'Pengguna yang ingin melihat cara kerja produk secara langsung',
          coreProblem: 'Tidak disimpulkan otomatis saat fallback; fokus pada bukti visual demonstrasi.',
          keyFeatures: isGadget
            ? ['Bentuk fisik terlihat', 'Penggunaan nyata terlihat', 'Detail visual produk terlihat']
            : ['Bentuk fisik terlihat', `${mechanismPhrase} terlihat`, 'Hasil penggunaan terlihat'],
          buyingTrigger: 'Bukti visual demonstrasi tanpa klaim spesifikasi tambahan',
        },
        scenes: [
          {
            sceneNumber: 1,
            timeRange: `00:00 - ${ts1}`,
            visualDescription: 'Tampilan pembuka produk yang terlihat di video',
            voiceover: fallbackHook,
            adAdvisorNotes: 'Hook berbasis visual, tanpa klaim spesifikasi',
          },
          {
            sceneNumber: 2,
            timeRange: `${ts1} - ${ts2}`,
            visualDescription: 'Tampilan bentuk fisik dan bagian utama produk',
            voiceover: isGadget
              ? 'Di sini bentuk bodi dan bagian utamanya terlihat jelas.'
              : 'Bentuk produk dan bagian utamanya terlihat jelas di sini.',
            adAdvisorNotes: 'Deskripsi bukti visual',
          },
          {
            sceneNumber: 3,
            timeRange: `${ts2} - ${ts3}`,
            visualDescription: 'Peragaan penggunaan produk',
            voiceover: isGadget
              ? 'Berikut tampilan saat perangkat benar-benar digunakan.'
              : `Sekarang perhatikan ${mechanismPhrase} saat digunakan.`,
            adAdvisorNotes: 'Fokus mekanisme/aksi yang tampak',
          },
          {
            sceneNumber: 4,
            timeRange: `${ts3} - ${ts4}`,
            visualDescription: 'Detail atau hasil yang tampak di video',
            voiceover: isGadget
              ? 'Perhatikan detail fisik dan hasil yang memang terlihat di video.'
              : 'Ini hasil penggunaan yang benar-benar tampak di video.',
            adAdvisorNotes: 'Bukti visual, tanpa mengarang hasil',
          },
          {
            sceneNumber: 5,
            timeRange: `${ts4} - ${formatSeconds(Math.round(actualSilentDuration))}`,
            visualDescription: 'Tampilan penutup produk',
            voiceover: isGadget
              ? 'Cek spesifikasi resmi produknya sebelum menentukan pilihan.'
              : 'Cek detail produk di bawah dan sesuaikan dengan kebutuhanmu.',
            adAdvisorNotes: 'CTA aman tanpa klaim promo/stok/harga',
          },
        ],
        voiceoverScript: fallbackVoiceScript,
        aiStudioPrompt: fallbackVoiceScript,
        caption: formatEnrichedCaption({
          caption: '',
          productTitle: fallbackProductName,
          productDescription,
          platform: 'clipper'
        }),
        lexicon_to_replace: {},
      };
    }

    cleanupTempFiles([], [rawFramesDir, trimmedFramesDir]);

    // ─── TAHAP OTOMATIS: Auto-Match Shopee Link, Voiceover TTS & Subtitle Burning ───
    effectiveShopeeLink = effectiveShopeeLink || shopeeLink || '';
    const detectedItemName = (highlight.detectedProduct || '').trim() || productTitle || videoMeta?.title || '';
    if (options.isVideoFirst && highlight.detectedProduct) {
      effectiveShopeeLink = buildShopeeSearchUrl(highlight.detectedProduct, highlight.detectedBrand);
      console.log(`[Job ${jobId}] 🎯 [Video-First] Link Shopee diperbarui sesuai produk nyata di video: "${highlight.detectedProduct}" -> ${effectiveShopeeLink}`);
    } else if (!effectiveShopeeLink || effectiveShopeeLink.includes('localhost')) {
      effectiveShopeeLink = buildShopeeSearchUrl(detectedItemName, highlight.detectedBrand);
      console.log(`[Job ${jobId}] ✅ Link Shopee pencarian akurat (anti-captcha): ${effectiveShopeeLink}`);
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
          console.warn(`[Job ${jobId}] TTS gagal setelah 3 percobaan. Video tetap diproses tanpa suara (silent).`);
        }
      }
    }

    const isAutoModeFallback = Boolean(extraJobMeta?.isAutoGenerated);
    const shouldProceedToFinal = (ttsSucceeded && fs.existsSync(autoVoiceoverPath)) || isAutoModeFallback;

    if (shouldProceedToFinal) {
      try {
        updateProgress({
          step: 'merge_start',
          message: ttsSucceeded ? 'Menggabungkan Voiceover AI & membakar subtitle ke video final 9:16...' : 'Membakar subtitle ke video final (Tanpa Suara AI)...',
          progress: 90,
          status: 'running',
        });

        const finalFileName = `final_clip_${jobId}.mp4`;
        const finalOutputPath = path.join(outputDir, finalFileName);
        const srtPath = path.join(uploadsDir, `subtitles_${jobId}.ass`);

        const hasVoiceover = ttsSucceeded && fs.existsSync(autoVoiceoverPath);
        const audioDurationSec = hasVoiceover ? (await getMediaDurationSec(autoVoiceoverPath)) || silentDurationSec : silentDurationSec;

        // EDIT CONFORM: actual speech timing controls the visual cut lengths.
        // This prevents looping/repeating footage when TTS runs longer than the first silent edit.
        const conformedClips = conformClipsToVoiceover({
          clips: highlight.clips,
          script: scriptData.voiceoverScript || rawVoiceScript,
          audioDurationSec,
          creativePlan,
          niche: options.niche || jobMeta.niche || 'kitchen_tools',
        });
        const conformedDuration = conformedClips.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);

        if (conformedClips.length > 0) {
          updateProgress({
            step: 'edit_conform',
            message: `Menyesuaikan cut visual ke timing voiceover nyata (${audioDurationSec.toFixed(1)}s)...`,
            progress: 89,
            status: 'running',
          });

          highlight.clips = conformedClips;
          highlight.duration = conformedDuration;

          // ── SCENE <-> VO LOCKSTEP (Fase 5): validasi alignment + bangun segment plan ──
          // Segment plan [{slot, timeStart, voLine, visualClaim}] dipakai QC visualMatchesNarration.
          try {
            const alignmentNiche = options.niche || jobMeta.niche || 'kitchen_tools';
            const eligibleFramePaths = new Set(
              (pooledFrames || []).filter(f => f.isCameraResultEligible === true).map(f => f.filePath).filter(Boolean)
            );
            const alignment = validateScriptSlotAlignment({
              clips: conformedClips,
              creativePlan,
              scenes: scriptData.scenes || [],
              niche: alignmentNiche,
              eligibleFramePaths,
            });
            if (alignment.errors.length > 0) {
              console.warn(`[Job ${jobId}] ⛔ [SceneVoLockstep] ${alignment.errors.length} pelanggaran alignment:`);
              alignment.errors.forEach(e => console.warn(`[Job ${jobId}]   • ${e}`));
            }
            alignment.warnings.forEach(w => console.warn(`[Job ${jobId}] ⚠️ [SceneVoLockstep] ${w}`));
            jobMeta.sceneVoSegments = buildSceneVoSegments({
              clips: conformedClips,
              scenes: scriptData.scenes || [],
              creativePlan,
              niche: alignmentNiche,
            });
            jobMeta.sceneVoAlignment = { ok: alignment.ok, errors: alignment.errors, warnings: alignment.warnings, strict: alignment.strictMode };
            // Simpan anchor frame kamera (eligible) agar QC pasca-conform ulang bisa memvalidasi gerbang face policy
            jobMeta.cameraEligibleFramePaths = Array.from(eligibleFramePaths);
            activeJobs.set(jobId, jobMeta);
            console.log(`[Job ${jobId}] 🔗 [SceneVoLockstep] ${jobMeta.sceneVoSegments.length} segmen terkunci ke VO (strict=${alignment.strictMode}, ok=${alignment.ok}).`);
          } catch (lockErr) {
            // Lockstep bersifat aditif — kegagalan analisa tidak boleh menggagalkan render
            console.warn(`[Job ${jobId}] [SceneVoLockstep] Analisa alignment dilewati (${lockErr.message}).`);
          }

          await renderSilentAntiDetectionVideo({
            inputVideo: rawVideoPath,
            startTime: highlight.startTime,
            endTime: highlight.endTime,
            outputVideo: silentOutputPath,
            clips: highlight.clips,
            hflip: effectiveHflip,
            speedMultiplier: options.speedMultiplier || 1,
            reframe: effectiveReframe,
            onProgress: updateProgress,
          });
        }

        const finalSilentDurationSec = (await getMediaDurationSec(silentOutputPath)) || conformedDuration || silentDurationSec;
        highlight.duration = finalSilentDurationSec;

        updateProgress({
          step: 'subtitles',
          message: `Menyinkronkan subtitle narasi (${audioDurationSec.toFixed(1)}s / video ${finalSilentDurationSec.toFixed(1)}s)...`,
          progress: 93,
          status: 'running',
        });
        // Pass structured script and exact audio duration to guarantee subtitles sync 1:1 with spoken voice!
        const scriptForSubtitles = scriptData.voiceoverScript || rawVoiceScript || (ttsResult ? ttsResult.cleanScript : '');
        generateSrtSubtitles(scriptForSubtitles, audioDurationSec, srtPath, {
          wordBoundaries: ttsResult ? ttsResult.wordBoundaries : null,
          videoDurationSec: finalSilentDurationSec,
          lexicon: scriptData.lexicon_to_replace || {},
        });

        updateProgress({
          step: 'render_final',
          message: 'Rendering video final 9:16 dengan Voiceover & Subtitles...',
          progress: 95,
          status: 'running',
        });
        const backgroundMusicPath = options.backgroundMusicPath || process.env.BACKGROUND_MUSIC_PATH || '';
        const clickSfxPath = options.clickSfxPath || process.env.SFX_CLICK_PATH || '';
        const whooshSfxPath = options.whooshSfxPath || process.env.SFX_WHOOSH_PATH || '';
        const sfxEvents = [];
        let cutCursor = 0;
        for (let i = 0; i < Math.max(0, highlight.clips.length - 1); i++) {
          cutCursor += Number(highlight.clips[i]?.duration) || 0;
          const sfxPath = i % 2 === 0 ? whooshSfxPath : clickSfxPath;
          if (sfxPath && fs.existsSync(sfxPath)) {
            sfxEvents.push({
              path: sfxPath,
              atSec: Math.max(0, cutCursor - 0.05),
              volume: i === 0 ? 0.08 : 0.06,
            });
          }
        }

        await mergeVoiceoverAndBurnSubtitles({
          silentVideoPath: silentOutputPath,
          voiceoverAudioPath: autoVoiceoverPath,
          srtPath,
          outputVideoPath: finalOutputPath,
          targetDurationSec: finalSilentDurationSec,
          backgroundMusicPath,
          musicVolume: Number(options.musicVolume || process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
          sfxEvents,
          onProgress: updateProgress,
        });

        const finalQc = await runProfessionalFinalQcWithRepair({
          jobId,
          finalOutputPath,
          silentVideoPath: silentOutputPath,
          voiceoverAudioPath: autoVoiceoverPath,
          srtPath,
          expectedDurationSec: finalSilentDurationSec,
          productTitle: highlight.detectedProduct || productTitle || videoMeta.title,
          productFingerprint,
          aiProvider,
          apiKey,
          niche: options.niche || 'kitchen_tools',
          renderSourcePath: rawVideoPath,
          clips: highlight.clips,
          hflip: effectiveHflip,
          reframe: effectiveReframe,
          backgroundMusicPath,
          musicVolume: Number(options.musicVolume || process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
          sfxEvents,
          sceneVoSegments: jobMeta.sceneVoSegments || null,
          sceneVoAlignment: jobMeta.sceneVoAlignment || null,
          onProgress: updateProgress,
        });

        if (!finalQc.passed) {
          try { fs.unlinkSync(finalOutputPath); } catch {}
          const issues = [
            ...(finalQc.technical?.issues || []),
            ...(finalQc.visual?.reason ? [finalQc.visual.reason] : []),
          ];
          const qcError = new Error(`FINAL_MASTER_QC_FAILED: ${issues.join(', ')}`);
          qcError.isFinalQcFailure = true;
          qcError.finalQc = finalQc;
          throw qcError;
        }

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
          voiceoverAudioUrl: hasVoiceover ? `/api/audio/${voiceoverFileName}?t=${cacheBuster}` : null,
          ttsVoice: ttsResult ? ttsResult.voice || ttsVoiceToUse : ttsVoiceToUse,
          ttsProvider: ttsResult ? ttsResult.provider || activeTtsProvider : activeTtsProvider,
          ttsModel: ttsResult ? ttsResult.modelId || ttsModelToUse : ttsModelToUse,
          ttsFallbackModel: ttsFallbackModelToUse,
          cleanScript: ttsResult ? ttsResult.cleanScript : scriptForSubtitles,
          wordBoundaries: ttsResult ? ttsResult.wordBoundaries || [] : [],
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
          finalQc,
          productFingerprint,
          creativePlan,
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

    // Fallback: If TTS or auto merge fails, pause at awaiting_voiceover (for manual) or finish silent (for auto)
    const stage1Result = {
      ...extraJobMeta,
      jobId,
      stage: isAutoModeFallback ? 'completed' : 'awaiting_voiceover',
      status: isAutoModeFallback ? 'completed' : 'awaiting_voiceover',
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
      productFingerprint,
      creativePlan,
      videoTitle: videoMeta.title,
      isOrphan: false,
    };

    activeJobs.set(jobId, stage1Result);
    persistJob(jobId, stage1Result);

    updateProgress({
      step: isAutoModeFallback ? 'completed' : 'awaiting_voiceover',
      message: isAutoModeFallback ? '✅ Auto Mode Selesai Tanpa Suara (TTS Gagal)' : 'Tahap 1 Selesai! Kotak Scene, Naskah, dan Muted 9:16 Video Ready.',
      progress: 100, 
      status: isAutoModeFallback ? 'completed' : 'awaiting_voiceover', 
      result: stage1Result
    });

    return stage1Result;
  } catch (error) {
    if (error.isAiRejection) {
      console.warn(`[Job ${jobId}] ℹ️ Video ditolak Filter AI: ${error.rejectionReason || error.message}`);
    } else {
      console.error(`[Job ${jobId}] Stage 1 Pipeline Error:`, error);
    }

    // Immediately clean up temporary files so disk storage is freed
    deleteJobTempDirectory(jobId, tempDir);

    const hasSilentVideo = silentOutputPath && fs.existsSync(silentOutputPath);
    const hasRawVideo = rawVideoPath && fs.existsSync(rawVideoPath);

    const isAuto = Boolean(extraJobMeta?.isAutoGenerated);

    // If 1080p video was already downloaded or rendered into silent 9:16, NEVER delete or purge it!
    // Note: For auto jobs, only preserve if silent 9:16 was actually rendered (hasSilentVideo).
    if ((!isAuto && (hasSilentVideo || hasRawVideo)) || (isAuto && hasSilentVideo)) {
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

export function runStage1Pipeline(args) {
  return heavyTaskQueue(() => _runStage1Pipeline(args));
}

