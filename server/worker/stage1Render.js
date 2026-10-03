import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, spawnSync, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { planSectionDownloads } from '../services/renderSections.js';
import { buildConfigSnapshot, isGeminiEvidenceEnabled, describeConfigSnapshot, isNewFlowEnabled, isSmolvlmVerifyEnabled, isGeminiSceneDiscoveryEnabled, isVlmOracleEnabled } from '../config/runtimeFlags.js';
import { applyOracleVeto, auditClipsWithOracle } from '../services/vlmOracleService.js';
import { shouldAllowRescue, buildVisionProvenance, isFrameVerdictMode, summarizeVisionRuns, sourceKeyOf } from '../services/visionEvidenceService.js';
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
  getDirectGeminiApiKey,
  preSelectTop2CandidatesWithGemini,
  discoverSceneWindowsWithGemini
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
  sampleDenseClustersAroundCleanFrames,
  extractFastSnippetsForPreflight,
  fastProbeLocal,
  sampleFramesForWindows
} from '../services/videoFilterService.js';
import { verifyScene as verifySceneWithVlm, isVlmAvailable } from '../services/vlmGateService.js';
import { downloadQuickPreview } from '../services/quickPreviewService.js';
import { analyzeNarrationAndSelectBestWindow } from '../services/whisperGateService.js';
// BLUEPRINT ALUR BARU (ACQUISITION_FLOW=v2) — orkestrasi L2->L5 & penyusun zigzag.
import { runSourceAcquisitionV2, buildLegacyStructuresFromV2 } from './sourceAcquisitionV2.js';
import { interleaveBySource } from '../utils/clipOrdering.js';
// AUDIO-DRIVEN SCENE PLANNING (Fase 1 & 2) - percobaan, di-guard flag AUDIO_DRIVEN_SCENES.
import { analyzeSourceAudioForBeats, isAudioDrivenEnabled, resolveAudioWindow } from '../services/audioBeatService.js';
import { paraphraseBeats, beatsToScript } from '../services/antiPlagiarismService.js';
import { classifyPipelineError, checkYouTubeHealth } from '../services/networkDiagnosticService.js';
import { trackProgressEvent, recordStageEvent } from '../services/observabilityService.js';
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
import { fetchProductImageFromSearch } from '../services/imageSearchService.js';

let preFlightDoneMap = new Map();

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
import { activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, patchJob, deletePersistedJob, updateJobProgress, updateAutoRun } from '../store/jobStore.js';
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

  const sinkProgress = onProgress || ((data) => {
    const payload = typeof data === 'string'
      ? { step: 'processing', message: data, progress: 50, jobId }
      : { ...data, jobId };
    jobProgress.set(jobId, payload);
    console.log(`[Job ${jobId}] [${payload.progress || 0}%] ${payload.message}`);
  });

  // P1 OBSERVABILITY: jalur manual sudah ter-tap lewat jobProgress.set (lihat store/jobStore.js),
  // tapi mode auto mengirim onProgress sendiri dan tidak menyentuh jobProgress sama sekali, sehingga
  // timeline stage job auto hilang. Tap di sini menutup celah itu khusus untuk mode auto.
  const updateProgress = (data) => {
    if (onProgress) {
      const payload = typeof data === 'string'
        ? { step: 'processing', message: data, progress: 50, jobId }
        : { ...data, jobId };
      try {
        trackProgressEvent(jobId, payload, { runId: extraJobMeta?.autoRunId });
      } catch {}
    }
    return sinkProgress(data);
  };

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
    // INPUT MANUAL PENTING: persist agar retry/re-generate memakai data yang sama.
    // Tanpa ini, retry job kehilangan niche (jatuh ke preset kitchen) & OEM urls (berujung pencarian video lain).
    niche: options.niche || 'kitchen_tools',
    oemUrls: Array.isArray(options.oemUrls) ? options.oemUrls.filter(Boolean) : [],
    singleVideoOnly: options.singleVideoOnly === true,
    sourcePolicy: options.sourcePolicy || '',
    // P5: bekukan konfigurasi runtime saat create agar retry memakai setelan yang sama,
    // walau operator sudah mengubah .env. Dibaca ulang (bukan ditulis lagi) oleh jalur retry.
    configSnapshot: buildConfigSnapshot(process.env, { niche: options.niche, sourcePolicy: options.sourcePolicy }),
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

  // State vonis AI + daftar panggilan visual. Sengaja di SCOPE FUNGSI (bukan di dalam
  // `try`) supaya blok catch di bawah ikut menuliskannya ke record job yang GAGAL -
  // riwayat kegagalan justru paling membutuhkan bukti jalur mana yang dijalankan.
  const visionState = { runs: [], aiGaveFrameVerdict: false, accepted: 0, rejected: 0, lastFramesSent: null };

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
    let cachedVideoPath = existingVideoInTemp ||
      (existingJob?.downloadedVideoPath && fs.existsSync(existingJob.downloadedVideoPath) && isVideoFilePath(existingJob.downloadedVideoPath)
        ? existingJob.downloadedVideoPath
        : null);

    let previewVideoPath = null;

    if (cachedVideoPath) {
      const cachedDims = await getVideoDimensions(cachedVideoPath);
      if (cachedDims && cachedDims.is1080pOrHigher) {
        rawVideoPath = cachedVideoPath;

        // ── P1-4: PARITAS GERBANG UNTUK JALUR CACHE ──
        // Dulu file cache 1080p langsung diloloskan ke analisa frame TANPA Filter 1 (metadata)
        // dan tanpa gerbang narasi Whisper — padahal funnel online menilai keduanya. Akibatnya
        // vonis tidak konsisten: URL yang sama gugur via funnel online tapi lolos diam-diam
        // pada run berikutnya karena file cache masih ada (mis. tersisa dari unduhan parsial
        // yang gagal sebelum gerbang selesai). Lempeng yang sama kini diberlakukan:
        // - Metadata: hanya untuk URL sumber yang dikenal (cache anonim di sessionTempDir
        //   tidak punya keharusan judul -> metadata online tidak bisa divonis offline).
        // - Narasi: slice tengah 15s DIEKSTRAK LOKAL dari file cache (0 kuota, 1x whisper).
        if (!gatesPassedThisRun) {
          const cacheSourceUrl = currentYoutubeUrl;

          if (cacheSourceUrl && videoMeta && !options.isManualOem) {
            const cacheCompliance = checkVideoMetadataCompliance(videoMeta, productTitle, {
              ...options,
              isVisualSearch: Boolean(effectiveProductImage || options.isVisualSearch),
              productImage: effectiveProductImage,
              imageUrl: effectiveProductImage,
            });
            if (!cacheCompliance.eligible) {
              console.warn(`[Job ${jobId}] ⛔ [Cache] Filter 1 metadata gagal paritas: ${cacheCompliance.reason}. Cache dibuang, evaluasi ulang online.`);
              try { fs.unlinkSync(rawVideoPath); } catch {}
              rawVideoPath = null;
            }
          }

          if (rawVideoPath) {
            const gatePreviewSec = Number(process.env.QUICK_PREVIEW_DURATION_SEC) || 15;
            // Pada arsitektur smolvlm, gerbang narasi Whisper DILEWATI (timing dari window
            // Gemini + vonis SmolVLM2), jadi paritas cache tidak menuntut voice-over.
            const bypassWhisper = isSmolvlmVerifyEnabled(process.env);
            const cacheDurSec = Number(videoMeta?.duration) || (await getMediaDurationSec(rawVideoPath, getFFmpegPath())) || 0;
            if (bypassWhisper) {
              console.log(`[Job ${jobId}] ℹ️ [Cache] Mode smolvlm aktif -> gerbang narasi Whisper dilewati (paritas).`);
            } else if (cacheDurSec > 0) {
              const sliceStart = Math.max(0, Math.floor(cacheDurSec / 2 - gatePreviewSec / 2));
              const narrationSlicePath = path.join(tempDir, `cache_gate_${jobId}_${Date.now()}.mp4`);
              let sliceOk = false;
              try {
                await new Promise((res) => {
                  const p = spawn(getFFmpegPath(), ['-y', '-ss', String(sliceStart), '-t', String(gatePreviewSec), '-i', rawVideoPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', narrationSlicePath]);
                  p.on('close', (code) => { sliceOk = code === 0 && fs.existsSync(narrationSlicePath) && fs.statSync(narrationSlicePath).size > 1024; res(); });
                  p.on('error', () => res());
                });
                if (sliceOk) {
                  const cacheGate = await analyzeNarrationAndSelectBestWindow(narrationSlicePath, {
                    minCoverage: Number(process.env.WHISPER_NARRATION_MIN_COVERAGE) || 0.3,
                    targetDurationSec: gatePreviewSec,
                    totalVideoDurationSec: gatePreviewSec,
                    previewStartSec: sliceStart,
                  });
                  if (!cacheGate.hasNarration) {
                    console.warn(`[Job ${jobId}] ⛔ [Cache] Gerbang narasi gagal paritas (slice ${sliceStart}s-${sliceStart + gatePreviewSec}s: ${cacheGate.reason}). Cache dibuang, evaluasi ulang online.`);
                    try { fs.unlinkSync(rawVideoPath); } catch {}
                    rawVideoPath = null;
                  } else {
                    console.log(`[Job ${jobId}] ✅ [Cache] Paritas gerbang lolos: narasi ada pada slice tengah ${gatePreviewSec}s.`);
                  }
                } else {
                  console.warn(`[Job ${jobId}] ⚠️ [Cache] Gagal membuat slice narasi - gerbang narasi dilewati (film tetap diaudit frame).`);
                }
              } catch (gateErr) {
                if (gateErr?.isInfraError) {
                  // P1-5: whisper/gatekeeper tumbang BUKAN vonis konten - jangan hapus cache
                  // (menghapus = menghukum unduhan 1080p yang mahal), lanjutkan audit frame.
                  console.warn(`[Job ${jobId}] ⚠️ [Cache][Infra] Gerbang narasi tak selesai (${gateErr.message}) - lanjut ke audit frame.`);
                } else {
                  throw gateErr;
                }
              } finally {
                try { if (fs.existsSync(narrationSlicePath)) fs.unlinkSync(narrationSlicePath); } catch {}
              }
            }
          }
        }

        if (rawVideoPath) {
        updateProgress({
          step: 'download',
          message: `Video 1080p sudah ada (${(fs.statSync(rawVideoPath).size / 1024 / 1024).toFixed(1)} MB). Skip download, langsung proses.`,
          progress: 30,
          status: 'running'
        });
        }
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
    // SATU sumber kebenaran untuk "boleh pakai Gemini Stream (baca video penuh)":
    // engine Gemini + API key langsung aktif + EVIDENCE MODE OFF. Sebelumnya syarat ini
    // ditulis ulang di dua tempat (JALUR 1 kandidat & multi-harvest) dengan variabel lokal
    // berbeda-beda -> inilah yang membuat satu job bisa memakai dua pola berbeda.
    const canUseGeminiStream = () => {
      const eng = (options.aiProvider || aiProvider || process.env.ACTIVE_AI_ENGINE || '').toLowerCase();
      const isGeminiEngine = eng === 'gemini' || eng === 'gemini_direct' || (process.env.GEMINI_API_KEY && eng !== 'openrouter');
      return isGeminiEngine && Boolean(getDirectGeminiApiKey(apiKey)) && !isGeminiEvidenceEnabled();
    };
    // Hard production rule: change the visual scene at least every 3.5s.
    // User-provided values above 3.5s are capped so the renderer cannot hold one scene too long.
    const requestedSceneDuration = Number(options.sceneDuration);
    const sceneDuration = Math.max(
      3.0,
      Math.min(3.5, Number.isFinite(requestedSceneDuration) && requestedSceneDuration > 0 ? requestedSceneDuration : 3.5)
    );

    // P1 OBSERVABILITY: satu event konteks per job membuat provider/model/kebijakan yang dipakai
    // terbaca dari trace, tanpa perlu menempel event di setiap pemanggilan AI (8 titik).
    // `visionMode` + `configLine` menjawab pertanyaan operator paling sering: "job ini jalan
    // pakai Evidence Mode atau pola lama?" - sebelumnya hanya ada di console (hang di Termux).
    recordStageEvent({
      jobId,
      runId: extraJobMeta?.autoRunId,
      stage: 'context',
      provider: aiProvider,
      message: `Jalur visual: ${isGeminiEvidenceEnabled() ? 'EVIDENCE MODE (frame bersih lokal, hemat token)' : 'GEMINI STREAM (baca video penuh)'} | audio-driven: ${isAudioDrivenEnabled() ? 'ON' : 'OFF'}`,
      model: aiProvider === 'openrouter'
        ? (process.env.OPENROUTER_MODEL || '')
        : (process.env.GEMINI_MODEL || ''),
      meta: {
        niche: options.niche || jobMeta.niche || 'kitchen_tools',
        sceneDuration,
        singleVideoOnly: options.singleVideoOnly === true,
        multiVideoHarvesting: options.multiVideoHarvesting === true,
        sourceCount: Array.isArray(targetCandidates) ? targetCandidates.length : 0,
        visionMode: isGeminiEvidenceEnabled() ? 'evidence' : 'gemini_stream',
        audioDrivenScenes: isAudioDrivenEnabled(),
        configLine: describeConfigSnapshot(jobMeta.configSnapshot),
      },
    });

    currentYoutubeUrl = youtubeUrl || '';
    highlight = null;
    let approved = false;
    // P1-4: penanda bahwa URL utama SUDAH divonis gerbang funnel di run ini. Jalur cache
    // di bawah memakai penanda ini agar tidak mengulang gerbang yang baru saja lulus.
    let gatesPassedThisRun = false;
    let lastRejectionError = null;
    let pooledFrames = [];
    // Shared across candidate download + post-download audit/recovery.
    // Must live at runStage1Pipeline scope, not only inside the harvesting branch.
    // NOTE: downloadedCandidatesMap diinisialisasi di sini agar ClipAudit pasca-download
    // (jalur manual & multi-video) bisa mengaksesnya dari scope yang sama.
    let downloadedCandidatesMap = new Map();

    const usedVids = getAllUsedYouTubeVideoIds();
    const initialVid = extractVideoId(currentYoutubeUrl);
    if (initialVid) usedVids.add(initialVid);

    // ── PENANDA DURABEL JALUR ANALISA VISUAL + STATE VONIS AI ──
    // Bukti lapangan 30 Sep 2026 (Termux): operator melaporkan "pola generate masih pola
    // lama" dan tidak ada satu pun cara membuktikannya, karena stdout dev-runner masuk ke
    // /dev/pts/0 (tidak pernah disimpan). Setiap panggilan visual kini dicatat ke trace
    // (server/logs/job-trace.jsonl) DAN direkap ke field `visionProvenance` pada record job.
    // Rekap ini juga menjadi sumber state untuk gerbang Rescue Pipeline di bawah.
    const noteVisionProvenance = (result, ctx = {}) => {
      if (!result) return null;
      const prov = result.visionEvidence || buildVisionProvenance({
        mode: ctx.mode || 'unknown',
        usableFrames: ctx.usableFrames,
        framesSent: ctx.framesSent,
        acceptedCount: (result.acceptedFrames || []).length,
        rejectedCount: (result.rejectedFrames || []).length,
        sourceCount: ctx.sourceCount,
      });
      visionState.runs.push({ ...prov, origin: ctx.origin || 'unknown' });
      // Referensi (bukan salinan) array frame yang dikirim ke AI, dipakai Rescue Pipeline
      // di bawah untuk menerjemahkan `acceptedFrames` (indeks 1-based) kembali ke frame.
      if (Array.isArray(ctx.framesRef)) visionState.lastFramesSent = ctx.framesRef;
      // Hanya jalur frame (evidence/stride) yang memberi vonis per-frame. Stream video
      // penuh tidak mengembalikan daftar frame -> vonis frame dianggap belum terjadi.
      // Daftarnya hidup di satu tempat (isFrameVerdictMode) supaya mode pelaporan baru
      // seperti product_verify/vlm_local tidak ikut menyalakan gerbang ini secara tidak sengaja.
      if (isFrameVerdictMode(prov.mode)) {
        visionState.aiGaveFrameVerdict = true;
        visionState.accepted = Math.max(visionState.accepted, prov.acceptedCount);
        visionState.rejected = Math.max(visionState.rejected, prov.rejectedCount);
      }
      recordStageEvent({
        jobId,
        kind: 'metric',
        stage: 'ai_vision',
        provider: ctx.provider || aiProvider,
        message: `Jalur visual ${prov.mode}: ${prov.framesSent} frame dikirim, ${prov.acceptedCount} diterima, ${prov.rejectedCount} ditolak`,
        meta: { ...prov, origin: ctx.origin || 'unknown' },
      });
      return prov;
    };

    // Helper untuk mengevaluasi kandidat video menggunakan Funneling 3 Tahap (Hemat kuota & token AI):
    // Tahap 1: Metadata Pre-Filter (0 kuota video, 0 token AI)
    // Tahap 2: Sampling 30 frame langsung dari stream URL via FFmpeg & Analisa Lokal 9:16 (~2MB kuota, 0 token AI)
    // Tahap 3: Verifikasi AI Vision (Quality Assurance Final, detail: 'low')
    const evaluateCandidate = async (targetUrl, candidateLabel = '', candidateExtra = {}) => {
      const isManualOem = candidateExtra?.source === 'manual_oem';
      const complianceContext = isManualOem ? 'oem' : 'auto';

      // 1. Bersihkan frame lama agar tidak tertumpuk
      if (fs.existsSync(rawFramesDir)) {
        try {
          const oldFiles = fs.readdirSync(rawFramesDir);
          for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(rawFramesDir, f)); } catch {}
          }
        } catch {}
      }

      // ── TAHAP 1: FILTER METADATA ──
      const metaMsg = candidateLabel
        ? `[${candidateLabel}] [Filter 1] Membaca durasi, judul & metadata video...`
        : '[Filter 1] Membaca durasi, judul & metadata video...';
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
      
      if (!compliance.eligible && !isManualOem) {
        trackSavedBandwidth(35 * 1024 * 1024, `Hemat kuota (Filter 1 Metadata): ${compliance.reason}`);
        console.warn(`[Job ${jobId}] ⛔ [Filter 1 Ditolak] ${candidateLabel || targetUrl}: ${compliance.reason}`);
        const metaErr = new Error(`Metadata video ditolak: ${compliance.reason}`);
        metaErr.isAiRejection = true;
        metaErr.rejectionReason = compliance.reason;
        throw metaErr;
      }
      console.log(`[Job ${jobId}] ✅ [Filter 1 Lolos] Metadata valid (${meta.title}, ${meta.duration}s).`);

      // ── CABANG BARU (opt-in): GEMINI-FIRST + SmolVLM2, TANPA Whisper/gatekeeper lama ──
      // Hanya berjalan bila mode smolvlm AKTIF dan biner/model VLM TERSEDIA. Bila VLM
      // belum ada, kita TETAP lanjut ke jalur legacy (jangan mematahkan produksi).
      if (isSmolvlmVerifyEnabled(process.env) && isVlmAvailable(process.env)) {
        const nicheForVlm = options.niche || 'kitchen_tools';
        const clipSec = Number(process.env.SCENE_CLIP_DURATION_SEC) || 4;
        const fps = Number(process.env.SCENE_SAMPLE_FPS) || 1;

        // [1] Dapat window kandidat: Gemini discovery (opt-in) atau seragam hemat-intro.
        let windows = [];
        if (isGeminiSceneDiscoveryEnabled(process.env)) {
          try {
            const disc = await discoverSceneWindowsWithGemini({
              youtubeUrl: targetUrl, productTitle, productDescription,
              niche: nicheForVlm, clipSec, apiKey, onProgress: updateProgress,
            });
            windows = disc.windows || [];
          } catch (discErr) {
            console.warn(`[Job ${jobId}] ⚠️ Gemini discovery gagal (${discErr.message}) -> fallback window seragam.`);
          }
        }
        if (windows.length === 0) {
          // Fallback: jendela seragam ~1 per clipSec, lewati intro 6s & outro 8s, maks 10 window.
          const safeStart = Math.min(6, Math.max(0, meta.duration * 0.04));
          const safeEnd = Math.max(safeStart + clipSec, meta.duration - 8);
          for (let t = safeStart; t + clipSec <= safeEnd && windows.length < 10; t += clipSec) {
            windows.push({ startSec: t, endSec: t + clipSec, reason: 'uniform' });
          }
        }

        // [2] Sampling per-window @fps (360p) + filter ringan.
        const scenesOutDir = path.join(tempDir, `scenes_${Date.now()}`);
        updateProgress({ step: 'scene_sampling', message: `🎬 Sampling ${windows.length} window scene @${fps} fps (360p)...`, progress: 44 });
        const scenes = await sampleFramesForWindows(streamUrl, windows, { outDir: scenesOutDir, fps, clipDurationSec: clipSec, onProgress: updateProgress });

        // [3] Verifikasi tiap scene dengan SmolVLM2.
        const approvedClips = [];
        for (const sc of scenes) {
          const verdict = await verifySceneWithVlm(sc.frames.map((f) => f.filePath), { niche: nicheForVlm, facePolicy: 'strict' });
          if (verdict.ok && verdict.safe === false) {
            console.log(`[Job ${jobId}] ⛔ [VLM REJECT] scene ${sc.window.startSec.toFixed(1)}s (${['face','text','watermark','graphic'].filter((k) => verdict[k]).join(',') || 'dirty'})`);
            continue;
          }
          if (!verdict.ok && !verdict.available) { console.warn(`[Job ${jobId}] ⚠️ VLM tak tersedia saat verifikasi scene -> FAIL-OPEN (dipertahankan, bukan vonis).`); }
          if (verdict.infraError) console.warn(`[Job ${jobId}] ⚠️ [VLM infra] scene ${sc.window.startSec.toFixed(1)}s (${verdict.error}) -> FAIL-OPEN (dipertahankan).`);
          approvedClips.push({
            candidateUrl: targetUrl, sourceId: targetUrl,
            startSeconds: sc.window.startSec, endSeconds: sc.window.endSec,
            duration: Math.max(1, sc.window.endSec - sc.window.startSec), isClean: true,
          });
        }

        if (approvedClips.length === 0) {
          const err = new Error('SmolVLM2: tidak ada scene bersih yang lolos verifikasi.');
          err.isAiRejection = true; err.rejectionReason = 'Frame kotor (VLM)';
          throw err;
        }
        const bw = approvedClips[0];
        const hl = {
          clips: approvedClips,
          bestWindow: { sourceId: targetUrl, startSec: bw.startSeconds, endSec: bw.endSeconds, durationSec: bw.duration },
          whisperSegments: [],
          narration: { hasNarration: true, coverage: 1 },
          pipelineVersion: 'smolvlm_v1',
          productHook: null,
        };
        noteVisionProvenance(hl, {
          // Vonisnya per-scene dan datang dari VLM LOKAL, bukan Gemini. Mode baru ini sengaja
          // TIDAK masuk daftar penyalakan `aiGaveFrameVerdict` ( itu khusus bukti yang dikirim
          // ke Gemini), jadi keputusan Rescue Pipeline tetap seperti semula.
          mode: 'vlm_local',
          usableFrames: scenes.reduce((a, s) => a + s.frames.length, 0),
          framesSent: scenes.reduce((a, s) => a + s.frames.length, 0),
          framesRef: [],
          origin: 'smolvlm_scenes',
        });
        if (!targetUrl || targetUrl === currentYoutubeUrl) gatesPassedThisRun = true;
        console.log(`[Job ${jobId}] ✅ [SmolVLM2] ${approvedClips.length}/${scenes.length} scene lolos verifikasi (0 panggilan Whisper/gatekeeper).`);
        return { approved: true, highlight: hl, videoMeta: meta, previewVideoPath: null, probe: { eligible: true, vlm: true } };
      }

      // ── TAHAP 2: QUICK PREVIEW (gerbang awal, default 15s agar lebih jelas) ──
      // P1: dulu 10s -> jendela sampling terlalu sempit (kata "review" pendek mudah sekali
      // lolos/tidak lolos berdasar 1 titik tengah video). 15s = default baru; masih bisa
      // dioverride via QUICK_PREVIEW_DURATION_SEC.
      const gatePreviewSec = Number(process.env.QUICK_PREVIEW_DURATION_SEC) || 15;
      updateProgress({ step: 'quick_preview', message: `⚡ Download preview ${gatePreviewSec} detik dari ${candidateLabel || 'kandidat'}...`, progress: 15 });
      const preview10s = await downloadQuickPreview(targetUrl, tempDir, jobId, {
        onProgress: updateProgress,
        durationSec: gatePreviewSec,
        sourceDurationSec: meta.duration
      });
      if (!preview10s?.filePath) throw Object.assign(new Error(`Gagal download preview ${gatePreviewSec}s`), { isAiRejection: true });

      // ── TAHAP 3: WHISPER GATE (EARLY SPEECH CHECK) ──
      updateProgress({ step: 'whisper_gate', message: '🎧 Whisper mengecek keberadaan narasi...', progress: 20 });
      const gateCheck = await analyzeNarrationAndSelectBestWindow(preview10s.filePath, {
        minCoverage: Number(process.env.WHISPER_NARRATION_MIN_COVERAGE) || 0.3,
        targetDurationSec: gatePreviewSec, // Preview sepuas gerbang -> window = seluruh preview
        totalVideoDurationSec: preview10s.actualDurationSec,
        previewStartSec: preview10s.sourceStartSec,
      });
      if (!gateCheck.hasNarration) {
        const err = new Error(`Video tidak memiliki narasi yang cukup (gate ${gatePreviewSec}s: ${gateCheck.reason}).`);
        err.isAiRejection = true;
        err.rejectionReason = 'Tidak ada narasi voice-over';
        throw err;
      }
      console.log(`[Job ${jobId}] ✅ [Whisper Gate Lolos] Ada narasi pada preview ${gatePreviewSec}s.`);

      // ── TAHAP 4: FAST PROBE LOKAL (5 FRAME) ──
      updateProgress({ step: 'frame_probe', message: '🔎 Pemeriksaan visual cepat (5 frame)...', progress: 25 });
      const probe = await fastProbeLocal(preview10s.filePath, jobId, {
        onProgress: updateProgress,
        niche: options.niche || 'kitchen_tools',
        durationSec: preview10s.actualDurationSec,
        sourceId: targetUrl
      });
      if (!probe.eligible) {
        const err = new Error(`Frame kotor: ${probe.reason || `${probe.dirtyCount || '?'} dari 5 frame terdeteksi WM/wajah/logo`}`);
        err.isAiRejection = true;
        err.rejectionReason = probe.reason;
        throw err;
      }
      console.log(`[Job ${jobId}] ✅ [Fast Probe Lolos] 5 frame lokal bersih.`);

      // ── TAHAP 5: CONTEXT PREVIEW (25s) & WHISPER CONTEXT ──
      const contextDuration = Number(process.env.WHISPER_CONTEXT_DURATION_SEC) || 25;
      updateProgress({ step: 'context_preview', message: `⚡ Download konteks narasi ${contextDuration} detik...`, progress: 30 });
      
      const contextPreview = await downloadQuickPreview(targetUrl, tempDir, jobId + '_ctx', {
        onProgress: updateProgress,
        durationSec: contextDuration,
        sourceDurationSec: meta.duration
      });
      
      updateProgress({ step: 'window_select', message: '🎧 Whisper memilih window terbaik...', progress: 35 });
      const targetWindowSec = Number(process.env.BEST_WINDOW_DURATION_SEC) || 25;
      const contextCheck = await analyzeNarrationAndSelectBestWindow(contextPreview.filePath, {
        minCoverage: 0.1, // Minimal as it already passed gate
        targetDurationSec: targetWindowSec,
        totalVideoDurationSec: contextPreview.actualDurationSec,
        previewStartSec: contextPreview.sourceStartSec,
      });
      
      const bestWindow = contextCheck.bestWindow || {
        startSec: contextPreview.sourceStartSec,
        endSec: contextPreview.sourceStartSec + targetWindowSec,
        durationSec: targetWindowSec
      };
      
      console.log(`[Job ${jobId}] ✅ [Whisper Context] Terpilih window: ${bestWindow.startSec}s - ${bestWindow.endSec}s`);

      // ── TAHAP 6: GEMINI PRODUCT VERIFY ──
      // Gunakan frame bersih dari probe yang lulus
      let verifiedCleanFrames = probe.cleanFrames;
      
      updateProgress({ step: 'product_verify', message: '🤖 Gemini memverifikasi produk dan narasi...', progress: 40 });
      if (!isManualOem) {
        const verification = await verifyProductCandidateWithAI({
          frames: verifiedCleanFrames,
          productTitle,
          productDescription,
          productImage: effectiveProductImage,
          productFingerprint,
          niche: options.niche || 'kitchen_tools',
          apiKey,
          aiProvider,
        });
        if (!verification.verified) {
          const err = new Error(`Gemini menolak: ${verification.reason}`);
          err.isAiRejection = true;
          err.rejectionReason = verification.reason;
          throw err;
        }
      } else {
        console.log(`[Job ${jobId}] ⚠️ OEM Manual: Bypass AI product match.`);
      }

      // ── TAHAP 7: KEMBALIKAN EVALUATOR RESULT ──
      console.log(`[Job ${jobId}] 🎯 Kandidat Lolos Evaluasi!`);
      
      const hl = {
        clips: [{
          candidateUrl: targetUrl,
          sourceId: targetUrl,
          startSeconds: bestWindow.startSec,
          endSeconds: bestWindow.endSec,
          duration: bestWindow.durationSec,
          isClean: true
        }],
        bestWindow: {
          sourceId: targetUrl,
          startSec: bestWindow.startSec,
          endSec: bestWindow.endSec,
          durationSec: bestWindow.durationSec
        },
        whisperSegments: contextCheck.whisperSegments || [],
        narration: { hasNarration: true, coverage: contextCheck.coverage },
        pipelineVersion: 'whisper_first_v1',
        productHook: null 
      };

      // Frame-nya benar-benar terkirim ke Gemini di atas (verifyProductCandidateWithAI), jadi
      // tanpa label ini trace melaporkan "unknown: 0 frame dikirim" padahal 5-30 frame dipakai.
      // Ini panggilan kecocokan PRODUK, bukan vonis kebersihan per-frame -> mode 'product_verify'
      // (tidak menyalakan gerbang vonis frame, supaya Rescue Pipeline tidak berubah perilaku).
      noteVisionProvenance(hl, {
        mode: 'product_verify',
        usableFrames: verifiedCleanFrames.length,
        framesSent: verifiedCleanFrames.length,
        framesRef: verifiedCleanFrames,
        origin: 'candidate_frames',
      });
      if (!targetUrl || targetUrl === currentYoutubeUrl) gatesPassedThisRun = true;
      return { 
        approved: true,
        highlight: hl, 
        videoMeta: meta, 
        previewVideoPath: contextPreview.filePath,
        probe: probe
      };
    };


    // Evaluasi video dari cache jika tersedia (DILEWATI di alur V2 — tidak ada full-download).
    if (rawVideoPath && !isNewFlowEnabled()) {
      try {
        const rawDur = Number(videoMeta?.duration) || 300;
        // Hemat (20 titik per menit): interval 3.0 detik -> 10 menit = 200 frame, 5 menit = 100, dst.
        const rawInterval = 3.0;
        // Cap 200 frame agar hemat CPU/memori Termux untuk video panjang (>= 10 menit).
        const maxFrames = Math.min(200, Math.floor(rawDur / rawInterval));
        updateProgress({ step: 'frames_raw', message: `Mengekstrak ${maxFrames} frame rapat video 1080p (9:16) untuk analisa AI (interval ${rawInterval.toFixed(1)}s)...`, progress: 38, status: 'running' });
        const { frames: rawFrames } = await extractFrames(rawVideoPath, rawFramesDir, updateProgress, {
          sampleIntervalSec: rawInterval,
          maxSampleFrames: maxFrames,
          duration: rawDur,
        });

        // Verifikasi filter lokal pada frame video cache (bebas teks mengambang & bebas wajah)
        const localCacheCheckStartedAt = Date.now();
        const localCacheCheck = await inspectFramesLocally(rawFrames, {
          aspectRatio: options.aspectRatio || '9:16',
          onProgress: updateProgress,
        });
        recordStageEvent({
          jobId,
          stage: 'gatekeeper',
          durationMs: Date.now() - localCacheCheckStartedAt,
          candidateCount: Array.isArray(rawFrames) ? rawFrames.length : 0,
          acceptedCount: Array.isArray(localCacheCheck.cleanFrames) ? localCacheCheck.cleanFrames.length : 0,
          rejectedCount: Array.isArray(rawFrames)
            ? Math.max(0, rawFrames.length - (Array.isArray(localCacheCheck.cleanFrames) ? localCacheCheck.cleanFrames.length : 0))
            : 0,
          failureReason: localCacheCheck.eligible ? '' : localCacheCheck.reason,
          meta: { origin: 'cached_raw_frames' },
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
        // selectHighlightWithAI dengan `frames:` = jalur bukti (evidence). Fallback ini hanya
        // terpakai bila aiService tidak ikut menempelkan visionEvidence pada hasilnya.
        noteVisionProvenance(highlight, {
          mode: 'evidence',
          usableFrames: localCacheCheck.cleanFrames.length,
          framesSent: localCacheCheck.cleanFrames.length,
          framesRef: localCacheCheck.cleanFrames,
          origin: 'cached_raw_frames',
        });
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
    
    // MODE MANUAL KETAT (explicit_only): HANYA sumber eksplisit user (youtubeUrl + oemUrls) yang boleh
    // diproses. DILARANG auto-search / multi-video harvesting / panen kandidat pengganti. Bila sumber
    // tidak mencukupi -> gagal cepat minta URL tambahan, bukan diam-diam mencari sendiri.
    // Opt-in murni: default OFF, perilaku semua pemanggil lama tidak berubah.
    const explicitOnly = options.sourcePolicy === 'explicit_only';
    
    if (!approved && currentYoutubeUrl && !preferMultiVideo && !isNewFlowEnabled()) {
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
        if (initErr.isInfraError) {
          // P1-5: timeout yt-dlp / whisper.cpp crash / Gatekeeper mati adalah transien
          // INFRASTRUKTUR. Vonis "video buruk" (-> blacklist) harus tetap milik isAiRejection;
          // sebelumnya error infra di sini meleleh ke outer catch dan membatal-kan seluruh job.
          console.warn(`[Job ${jobId}] ⚠️ [Infra] Gangguan sementara saat menilai video awal (${initErr.message}). Tidak mem-blacklist; lanjut ke jalur kandidat.`);
          lastRejectionError = initErr;
        } else if (initErr.isAiRejection || String(initErr?.message || '').toLowerCase().includes('ditolak')) {
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
    let masterRetryCount = 0;
    let finalCompletedJob = null;
    let forceManualFallback = false;
    let autoFinalError = null;
    const failedCandidateUrls = new Set();
    // P1-5: URL kandidat yang pernah kena error infrastruktur (timeout yt-dlp, whisper crash,
    // Gatekeeper mati). Masing-masing dapat 1 percobaan ULANG sebelum dianggap gugur, supaya
    // jaringan sesaat tidak lagi membuang kandidat baik secara permanen di run ini.
    const infraRetriedUrls = new Set();
    let maxStreamVideos = explicitOnly ? 10 : (preferMultiVideo ? 5 : 3);
    let streamedCount = 0;
    let candidateResults = [];
    let hl = null;
    const isAutoModeFallback = Boolean(extraJobMeta?.isAutoGenerated);

    // [RENDER-ON-APPROVAL] Saklar perilaku (keputusan user 2 Okt 2026, PERMANEN untuk SEMUA job
    // AUTO & manual): setelah Gemini menyatakan kandidat "layak + produk cocok", backend HANYA
    // mengunduh window bagus lalu render - TANPA Master Loop 3x, TANPA Rescue storyboard, dan
    // TANPA Final QC pasca-render yang bisa menolak/menghapus hasil. Penyaringan frame level
    // gatekeeper (wajah / subtitle terbakar) SEBELUM approval TETAP berjalan (tidak diubah).
    const RENDER_ON_APPROVAL = true;
    
    let isBrandDetected = false;
    let scriptData = null;
    let rawVoiceScript = null;
    let autoVoiceoverPath = null;
    let silentDurationSec = 0;
    let ttsSucceeded = false;
    let visionSummary = null;

    while (!finalCompletedJob && masterRetryCount < (RENDER_ON_APPROVAL ? 1 : 3) && !forceManualFallback) {
      try {
      masterRetryCount++;
      if (masterRetryCount > 1) {
        approved = false; // Paksa re-harvesting
        console.log(`[Job ${jobId}] 🔄 [Master Loop] Memulai ulang pencarian kandidat video (Percobaan ${masterRetryCount}/3)...`);
        maxStreamVideos += 1;
      }

      if (!approved) {
      const allowAutoSearch = !explicitOnly && options.autoSearchFallback !== false && Boolean(productTitle);
      if (!allowAutoSearch && !preferMultiVideo && !explicitOnly) {
        throw lastRejectionError || new Error('Video ditolak oleh AI.');
      }

      const engineName = aiProvider === 'gemini' ? 'Google Gemini Direct' : 'AI';
      updateProgress({
        step: 'auto_search_fallback',
        message: explicitOnly
          ? `🔒 Mode manual: hanya memakai link yang Anda siapkan (tanpa pencarian di mesin telusur).`
          : preferMultiVideo
          ? `Menyiapkan streaming 3-4 video untuk target "${coreProductNoun}"...`
          : `⛔ Video awal ditolak AI (${lastRejectionError?.rejectionReason || 'tidak cocok'}). ${engineName} mencari video YouTube baru untuk target "${coreProductNoun}"...`,
        progress: 15,
        status: 'running',
        coreProductNoun,
      });

      console.log(explicitOnly
        ? `[Job ${jobId}] 🔒 Mode manual (explicit_only): TIDAK ada pencarian web. Hanya link user (youtubeUrl + OEM) yang diproses.`
        : `[Job ${jobId}] Memulai pencarian/streaming kandidat YouTube (3-5 video) untuk "${productTitle}"...`);

      let searchIteration = 0;
      let candidatePool = Array.isArray(targetCandidates) ? [...targetCandidates] : [];
      candidatePool = candidatePool.filter(c => !failedCandidateUrls.has(c.url || c));

      // Dedup berbasis VIDEO-ID (bukan string URL persis) agar dua URL yang menunjuk video yang sama
      // (mis. youtu.be/ID vs youtube.com/watch?v=ID) tidak di-stream dobel & tidak boros kuota.
      const poolVidOf = (c) => {
        const raw = String(c?.url || c || '');
        return extractVideoId(raw) || c?.id || null;
      };
      const seenVids = new Set(candidatePool.map(poolVidOf).filter(Boolean));

      // URL utama dimasukkan LEBIH DULU sebagai kandidat NORMAL (mempertahankan gerbang produk penuh),
      // sehingga OEM duplikat yang menyamai video utama akan di-dedup terhadapnya.
      const primaryVid = currentYoutubeUrl ? (extractVideoId(currentYoutubeUrl) || null) : null;
      if (currentYoutubeUrl && !(primaryVid && seenVids.has(primaryVid))) {
        if (primaryVid) seenVids.add(primaryVid);
        candidatePool.unshift({
          url: currentYoutubeUrl,
          title: productTitle,
        });
      }

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
        const oemVid = extractVideoId(oemUrl);
        if (seenVids.has(oemVid)) {
          console.log(`[Job ${jobId}] ↩️ OEM URL manual dilewati karena video ID ${oemVid} sudah ada di pool (hemat kuota stream).`);
          continue;
        }
        seenVids.add(oemVid);
        candidatePool.push({
          url: oemUrl,
          title: productTitle || 'OEM Manual',
          source: 'manual_oem',
          manualOem: true,
          skipGeminiProductMatch: true,
        });
      }

      // Identity-first discovery: do NOT automatically search by product image.
      // Visual/image search is intentionally reserved for future explicit modes.
      // Automatic candidates now come only from Brand + Model/Type identity queries.
      // 2. Multi-Engine Keyword Search jika belum mencapai target minimal 10 kandidat
      while (searchIteration < 3 && candidatePool.length < 10 && !explicitOnly) {
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

      if (!explicitOnly && (!candidatePool || candidatePool.length === 0)) {
        // Coba variasi kata kunci alternatif (brand + model/tipe) sebelum menyerah
        const info = extractCoreProductInfo(productTitle, productDescription);
        const b = (info.brand || options.brand || '').trim();
        const m = (info.model || options.model || '').trim();
        const p = (info.coreProductNoun || options.productType || '').trim();
        const fallbackQueries = [
          b && m ? `${b} ${m} review jujur` : '',
          b && m ? `${b} ${m} review indonesia` : '',
          b && m ? `${b} ${m} review` : '',
          b && m ? `unboxing ${b} ${m}` : '',
          b && p ? `${b} ${p} review jujur` : '',
          b && p ? `${b} ${p} review` : '',
          b && p ? `review ${b} ${p}` : '',
          b ? `${b} review jujur` : '',
          b ? `${b} review indonesia` : '',
          p ? `${p} review jujur` : '',
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
        if (explicitOnly) {
          throw new Error(`Mode Manual Ketat (explicit_only): sumber yang Anda berikan tidak mencukupi untuk mengisi storyboard. Tambahkan URL YouTube / OEM lain yang layak, atau matikan explicit_only untuk mengizinkan pencarian otomatis.`);
        }
        throw new Error(`Tidak ditemukan video YouTube yang cocok untuk "${productTitle}": ${lastRejectionError?.rejectionReason || 'kandidat kosong'}.`);
      }

      let maxStreamVideos = 8; // Adaptif hingga 8 video agar footage cukup bervariasi dan tidak gagal
      let streamedCount = 0;
      let candidatePoolIndex = 0;
      let candidateResults = [];
      let hl = null;
      // pooledFrames menggunakan outer variable (scope fungsi) agar ClipAudit pasca-download
      // dan Rescue Pipeline dapat membaca hasil harvesting. Jangan redeklare dengan `let`.
      pooledFrames = [];
      const blacklistedFramePaths = new Set();
      const retainedCleanFrames = [];

      // BERAPA VIDEO SUMBER BERBEDA YANG WAJIB TERKUMPUL sebelum storyboard dianggap sah.
      // Preset niche menentukan: kitchen_tools = 2 (variasi sudut & latar), smartphone/gadget
      // = 1 (sumber terverifikasi langka, jangan kejar sumber ke-2 sampai job gagal).
      // harvestStreamBudget = berapa percobaan stream yang boleh dihabiskan untuk mencapai
      // target itu. Dulu dipatok keras Math.min(3, maxStreamVideos): begitu 3 stream habis
      // dan baru 1 sumber yang lolos, loop berhenti -> Reels 1 sumber, variasi minim.
      const nichePresetForSource = getNichePreset(options.niche || 'kitchen_tools');
      const targetMultiSources = options.singleVideoOnly === true
        ? 1
        : Math.max(1, Number(nichePresetForSource?.minVerifiedSources) || 2);
      const harvestStreamBudget = Math.min(maxStreamVideos, Math.max(4, targetMultiSources * 3));

      // Helper: Pemanenan adaptif video pengganti di YouTube jika AI menolak frame atau slot kurang
      const harvestAdaptiveReplacementCandidates = async ({
        querySuggestions = [],
        missingSlots = [],
        reason = '',
      } = {}) => {
        if (explicitOnly) {
          console.log(`[Job ${jobId}] 🔒 explicit_only: panen kandidat pengganti otomatis DILARANG.`);
          return;
        }
        const prodInfo = extractCoreProductInfo(productTitle, productDescription);
        const b = (prodInfo.brand || options.brand || '').trim();
        const p = (prodInfo.coreProductNoun || prodInfo.cleanTitle || productTitle || '').trim();
        const combinedBP = (b && p && normalizeText(b) !== normalizeText(p)) ? `${b} ${p}` : (p || b);

        const customQueries = [];
        if (querySuggestions && Array.isArray(querySuggestions)) {
          customQueries.push(...querySuggestions);
        }

        // Jika slot peragaan/aksi kurang, cari video demo aktif.
        // CATATAN: kata "cara"/"tutorial"/"diy" adalah kata terlarang (server/config/forbiddenTerms.js)
        // dan hasil yang judulnya memuat kata itu dibuang filter judul -> dulu query ini dibuat
        // sendiri lalu dibuang sendiri (hasil pencarian 0% terpakai). Pakai padanan yang diizinkan.
        const needsAction = missingSlots.some(s => String(s).includes('action') || String(s).includes('demo') || String(s).includes('result'));
        if (needsAction) {
          customQueries.push(
            `${combinedBP} demo produk`,
            `${combinedBP} hands on`,
            `${combinedBP} unboxing review`
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

      // ── ALUR BARU V2 (ACQUISITION_FLOW=v2): ganti funnel + loop panen lama ──
      // Men-set `hl` + `candidateResults` lalu menaikkan streamedCount sehingga loop `while`
      // legacy di bawah TIDAK berjalan; aliran jatuh ke blok unduh-per-segmen (L4) & render
      // (L6) yang SUDAH ADA dan membaca hl.clips[].candidateIndex. Default legacy = tak tersentuh.
      if (isNewFlowEnabled() && !hl) {
        const poolForV2 = [
          ...(currentYoutubeUrl ? [{ url: currentYoutubeUrl, title: productTitle }] : []),
          ...candidatePool.filter((c) => c && (c.url || typeof c === 'string')).map((c) => (typeof c === 'string' ? { url: c } : c)),
        ];
        updateProgress({ step: 'acquisition_v2_start', message: `🧩 [V2] Akuisisi alur baru atas ${poolForV2.length} kandidat (vonis batch + transkrip penuh + zigzag)...`, progress: 14 });
        const v2 = await runSourceAcquisitionV2({
          candidatePool: poolForV2,
          productTitle, productDescription,
          productImage: effectiveProductImage, productFingerprint,
          niche: options.niche || 'kitchen_tools',
          apiKey, aiProvider, options, tempDir, jobId,
          updateProgress, interleave: interleaveBySource,
          requireSources: (options.niche || 'kitchen_tools') === 'gadget_smartphone' ? 1 : 2,
          targetClipDurationSec: 30,
        });
        recordStageEvent({
          jobId, stage: 'acquisition_v2', candidateCount: poolForV2.length,
          acceptedCount: v2.sources.length,
          failureReason: v2.sources.length ? '' : 'Tidak ada kandidat lolos V2',
          meta: v2.diagnostics,
        });
        if (!v2.sources.length || !v2.orderedWindows.length) {
          const v2Err = new Error('[V2] Tidak ada kandidat memenuhi vonis batch + narasi cukup.');
          v2Err.isAiRejection = true;
          v2Err.rejectionReason = 'V2: tidak ada sumber layak';
          throw v2Err; // Master Loop akan mencari kandidat lain (retry).
        }
        const mapped = buildLegacyStructuresFromV2(v2.sources, v2.orderedWindows);
        hl = mapped.hl;
        candidateResults = mapped.candidateResults;
        rawVoiceScript = v2.scriptDraft || null;
        streamedCount = maxStreamVideos; // Lewati loop panen legacy.
        console.log(`[Job ${jobId}] ✅ [V2] ${hl.clips.length} window zigzag dari ${v2.sources.length} sumber siap -> lanjut unduh segmen 1080p.`);
      }

      while (streamedCount < maxStreamVideos) {
        // 1. Jika antrean candidatePool habis sebelum kuota stream tercapai, cari kandidat pengganti tambahan
        if (candidatePoolIndex >= candidatePool.length) {
          if (explicitOnly) {
            console.log(`[Job ${jobId}] 🔒 explicit_only: seluruh sumber eksplisit sudah diproses. Menghentikan stream tanpa pencarian otomatis.`);
            break;
          }
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
        // --- FAST PRE-FLIGHT CHECK ---
        const currentPoolCandidate = candidatePool[candidatePoolIndex];
        const isCurrentOem = currentPoolCandidate && (options.oemUrls?.includes(currentPoolCandidate.url) || options.oemUrl1 === currentPoolCandidate.url || options.oemUrl2 === currentPoolCandidate.url);
        
        if (currentPoolCandidate && !currentPoolCandidate.preFlightChecked && !isCurrentOem && !explicitOnly) {
          console.log(`[Job ${jobId}] 🚀 Memulai Fast Pre-Flight Check untuk kandidat...`);
          try {
            updateProgress({ step: 'pre_flight', message: 'Mencari gambar produk & memotong cuplikan kandidat...', progress: 10 });
            
            const altImages = await fetchProductImageFromSearch(productTitle, outputDir);
            const imageForGemini = (effectiveProductImage && fs.existsSync(effectiveProductImage)) 
              ? effectiveProductImage 
              : altImages;

            const snippetUrls = candidatePool.slice(candidatePoolIndex, candidatePoolIndex + 3).map(c => c.url);
            const snippets = await extractFastSnippetsForPreflight(snippetUrls, outputDir);

            // `snippets` sudah DIFILTER (kandidat yang cuplikannya gagal ekstraksi dibuang), jadi
            // posisi di array ini BUKAN posisi kandidat di `snippetUrls`. Yang boleh dipakai sebagai
            // acuan hanyalah `snippet.index` (posisi asli di batch) — dan itu pula yang dikirim ke
            // Gemini sebagai label "Kandidat Video dengan index".
            // Sebelum 2026-10-03 kode di bawah memakai indeks array, sehingga saat satu ekstraksi
            // gagal (mis. "Requested format is not available"): (a) flag preFlightChecked menempel
            // ke kandidat yang salah, (b) kandidat yang TIDAK PERNAH dilihat Gemini ikut dibuang
            // dengan pesan "ditolak oleh Pre-Flight Gemini", dan (c) lompatan cursor salah jumlah.
            const judgedPositions = new Set(
              snippets.map((s) => Number(s && s.index)).filter((n) => Number.isInteger(n) && n >= 0)
            );

            // Tandai kandidat yang telah diekstrak agar tidak diuji ulang
            for (const s of snippets) {
              const cand = candidatePool[candidatePoolIndex + Number(s.index)];
              if (cand) cand.preFlightChecked = true;
            }

            updateProgress({ step: 'pre_flight', message: 'Memilih video terbaik dengan AI...', progress: 15 });
            const topIndices = await preSelectTop2CandidatesWithGemini(imageForGemini, snippets, apiKey);
            const acceptedPositions = new Set(
              (Array.isArray(topIndices) ? topIndices : [])
                .map((n) => Number(n))
                .filter((n) => Number.isInteger(n) && n >= 0)
            );

            if (acceptedPositions.size > 0) {
              const bestCandidates = [];
              const untested = [];
              for (let i = candidatePoolIndex; i < candidatePool.length; i++) {
                const relativeIdx = i - candidatePoolIndex;
                // Di luar batch yang di-probe, atau cuplikannya gagal => TIDAK boleh divonis.
                if (relativeIdx >= snippetUrls.length || !judgedPositions.has(relativeIdx)) {
                  untested.push(candidatePool[i]);
                } else if (acceptedPositions.has(relativeIdx)) {
                  bestCandidates.push(candidatePool[i]);
                } else {
                  console.log(`[Job ${jobId}] ⚠️ Membuang kandidat "${candidatePool[i].title || candidatePool[i].url}" karena ditolak oleh Pre-Flight Gemini.`);
                }
              }
              candidatePool.splice(candidatePoolIndex, candidatePool.length - candidatePoolIndex, ...bestCandidates, ...untested);
              console.log(`[Job ${jobId}] 🚀 Pre-Flight selesai! Urutan kandidat terbaik:`, bestCandidates.map(c => c.title || c.url));
            } else if (snippets.length > 0) {
              console.log(`[Job ${jobId}] ⚠️ Pre-Flight: Gemini menolak semua ${snippets.length} cuplikan kandidat awal (tidak cocok/kotor). Melewati kandidat yang benar-benar dinilai saja...`);
              // Buang HANYA kandidat yang sungguh dinilai (punya cuplikan). Yang gagal ekstraksi
              // dibiarkan di antrian agar tetap dicoba lewat jalur normal. Iterasi menurun karena
              // splice menggeser posisi sisanya.
              for (let rel = snippetUrls.length - 1; rel >= 0; rel--) {
                if (judgedPositions.has(rel)) candidatePool.splice(candidatePoolIndex + rel, 1);
              }
              continue; // Langsung cari kandidat baru tanpa perlu streaming
            }
          } catch (err) {
            console.warn(`[Job ${jobId}] ⚠️ Pre-Flight Check gagal, melanjutkan secara normal: ${err.message}`);
            if (candidatePool[candidatePoolIndex]) candidatePool[candidatePoolIndex].preFlightChecked = true;
          }
        }
        // -----------------------------

        const candidate = candidatePool[candidatePoolIndex++];
        const currentCandIdx = candidatePoolIndex - 1;
        if (!candidate || !candidate.url) continue;

        const candVid = extractVideoId(candidate.url) || candidate.id;
        if (candVid) usedVids.add(candVid);

        const candLabel = `Kandidat #${candidatePoolIndex} (Stream ${streamedCount + 1}/${maxStreamVideos})`;
        try {
          const evalRes = await evaluateCandidate(candidate.url, candLabel, candidate);
          
          candidateResults.push({
            candidateIndex: currentCandIdx,
            candidate: { ...candidate, duration: evalRes.videoMeta.duration, title: evalRes.videoMeta.title },
            videoMeta: evalRes.videoMeta,
            cleanFrames: evalRes.probe.cleanFrames,
            cameraResultEligibleFrames: evalRes.probe.cameraResultEligibleFrames || [],
            discardedFaceTimestamps: evalRes.probe.discardedFaceTimestamps || [],
            discardedViolationTimestamps: evalRes.probe.discardedViolationTimestamps || [],
            cleanTimeWindows: (evalRes.probe.verifiedSegments || []).map(s => ({ start: s.startSec, end: s.endSec })),
            productVerification: { verified: true, confidence: 1, reason: 'Lolos evaluateCandidate' },
            highlight: evalRes.highlight,
            previewVideoPath: evalRes.previewVideoPath
          });
          streamedCount++;
        } catch (err) {
          lastRejectionError = err;
          // P1-5: error infrastruktur BUKAN vonis konten -> beri 1 retry untuk kandidat yang
          // sama (indeks mundur, tanpa menambah streamedCount). Vonis AI tetap lanjut ke
          // kandidat berikutnya seperti sebelumnya.
          if (err.isInfraError && !infraRetriedUrls.has(candidate.url)) {
            infraRetriedUrls.add(candidate.url);
            console.warn(`[Job ${jobId}] ⚠️ [Infra] ${candLabel}: ${err.message} — retry 1x tanpa ganti kandidat.`);
            candidatePoolIndex--;
            continue;
          }
          streamedCount++; // Tetap hitung stream count
          continue;
        }

        // Cek kecukupan frame yang terkumpul
        const preferredSoFar = choosePreferredCandidateSet(candidateResults);
        const bestVerified = preferredSoFar[0];
        const totalCleanFrames = preferredSoFar.reduce((acc, c) => acc + (c.cleanFrames?.length || 0), 0);
        const verifiedCandidatesCount = preferredSoFar.filter(c => c?.productVerification?.verified).length;
        const hasRemainingPool = candidatePoolIndex < candidatePool.length;

        // DYNAMIC MULTI-VIDEO HARVESTING FOR REELS:
        // targetMultiSources & harvestStreamBudget dihitung sekali di atas loop (lihat
        // komentar di sana). Smartphone/gadget preset memakai minVerifiedSources:1 ->
        // begitu 1 video terverifikasi LANGSUNG diproses, jangan terus-terusan men-skip
        // kandidat demi mengejar sumber ke-2 yang langka.
        const shouldKeepHarvesting = verifiedCandidatesCount < targetMultiSources &&
          hasRemainingPool &&
          streamedCount < harvestStreamBudget;

        if (shouldKeepHarvesting) {
          console.log(`[Job ${jobId}] 🎬 Multi-video harvesting: Sudah dapat ${verifiedCandidatesCount} video terverifikasi. Terus stream kandidat berikutnya untuk mendapatkan variasi sudut kamera & latar belakang...`);
          continue;
        }

        if (bestVerified?.highlight?.pipelineVersion === 'whisper_first_v1') {
          console.log(`[Job ${jobId}] ⚡ Whisper-First Pipeline: Menggabungkan ${preferredSoFar.length} kandidat lolos! Melewati AI Storyboard fallback...`);
          hl = {
            clips: preferredSoFar.map(c => c.highlight.clips[0]),
            bestWindow: bestVerified.highlight.bestWindow,
            whisperSegments: bestVerified.highlight.whisperSegments,
            narration: bestVerified.highlight.narration,
            pipelineVersion: 'whisper_first_v1',
            productHook: bestVerified.highlight.productHook
          };
          break;
        }

        // Coba jalankan AI Storyboard jika sudah ada cukup frame
        if ((bestVerified && (bestVerified.cleanFrames?.length || 0) >= 8) || totalCleanFrames >= 8) {
          let testPool = poolMultiCandidateFrames(preferredSoFar, { maxTotalFrames: 500, includeEligible: true })
            .filter(f => !blacklistedFramePaths.has(f.filePath));

          // ORACLE KAGGLE (opt-in, VISION_VERIFY_MODE=oracle): lapisan veto SEBELUM storyboard.
          // Model besar memvonis frame yang akan dipakai; yang KOTOR masuk blacklistedFramePaths
          // yang SUDAH ada -> Gemini, retainedFrames, dan rescue pool otomatis mengecalikannya.
          // Oracle diam/timeout/error = tidak memveto apa pun, keputusan gatekeeper legacy +
          // Gemini tetap berlaku. INI BUKAN fail-open: jalur legacy di sekitar titik ini tidak
          // pernah dilewati (bandingkan branch 'smolvlm' yang me-return lebih awal).
          if (isVlmOracleEnabled(process.env)) {
            const veto = await applyOracleVeto(testPool, {
              jobId, niche: options.niche || 'kitchen_tools', blacklisted: blacklistedFramePaths, onProgress: updateProgress,
            });
            testPool = veto.frames;
            if (veto.rejected > 0) {
              console.log(`[Job ${jobId}] ⛔ [Oracle] ${veto.rejected}/${veto.checked} frame diveto model besar dan dikeluarkan dari bank footage.`);
            }
          }

          if (testPool.length >= 2) {
            // Label cabang untuk provenance. Variabelnya HARUS di luar `try` karena blok `catch`
            // di bawah ikut membacanya: `let` di dalam `try` tidak terlihat dari `catch`, dan
            // kalau salah tulis ini melempar ReferenceError yang menenggelamkan job.
            let multiVisionMode = 'unknown';
            updateProgress({
              step: 'gemini_vision',
              message: `AI Vision menganalisa ${testPool.length} frame peragaan dari ${preferredSoFar.length} video kandidat...`,
              progress: 38,
              status: 'running',
            });

            try {
              let testHl;
              // Cabang mana yang benar-benar dijalankan harus terbaca dari trace: stream video
              // penuh mengirim 0 frame, cabang bukti mengirim seluruh testPool.
              multiVisionMode = canUseGeminiStream() ? 'gemini_stream_multi' : 'evidence';

              // EVIDENCE MODE: multi-video stream (baca semua video penuh) DILEWATI —
              // pool frame bersih per kandidat dikirim sebagai bukti (branch else).
              if (canUseGeminiStream()) {
                const validUrls = Array.from(new Set(preferredSoFar.map(c => c.candidate.url).filter(Boolean)));
                const urlToIdx = new Map(validUrls.map((u, i) => [u, i]));
                const allDiscardedFace = [];
                const allDiscardedViolation = [];
                const allCleanWindows = [];
                
                for (const c of preferredSoFar) {
                  if (Array.isArray(c.discardedFaceTimestamps)) allDiscardedFace.push(...c.discardedFaceTimestamps);
                  if (Array.isArray(c.discardedViolationTimestamps)) allDiscardedViolation.push(...c.discardedViolationTimestamps);
                  // P0 FIX (audit GPT): window WAJIB membawa identitas video sumber
                  // agar Gemini tak menerapkan batas Video A ke Video B.
                  const srcIdx = urlToIdx.has(c.candidate.url) ? urlToIdx.get(c.candidate.url) : 0;
                  if (Array.isArray(c.cleanTimeWindows)) allCleanWindows.push(...c.cleanTimeWindows.map(w => ({ start: w.start, end: w.end, sourceVideoIndex: srcIdx })));
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

              noteVisionProvenance(testHl, {
                mode: multiVisionMode,
                sourceCount: preferredSoFar.length,
                usableFrames: testPool.length,
                framesSent: multiVisionMode === 'evidence' ? testPool.length : 0,
                origin: 'multi_harvest',
              });

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

              const forceSecond = preFlightDoneMap.get(jobId) && streamedCount < 2 && candidatePoolIndex < candidatePool.length;

              if (isSatisfactory && !forceSecond) {
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
              // Vonis penolakan juga membawa provenance (lihat aiService: rejectError.visionEvidence).
              noteVisionProvenance(aiErr.visionEvidence ? {
                visionEvidence: aiErr.visionEvidence,
                acceptedFrames: aiErr.acceptedFrames || [],
                rejectedFrames: aiErr.rejectedFrames || [],
              } : null, {
                mode: multiVisionMode,
                sourceCount: preferredSoFar.length,
                usableFrames: Array.isArray(testPool) ? testPool.length : 0,
                framesSent: multiVisionMode === 'evidence' && Array.isArray(testPool) ? testPool.length : 0,
                origin: 'multi_harvest_reject',
              });
              
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

          // Titik storyboard KE-DUA (setelah loop stream selesai tapi hl belum terbentuk).
          // Veto oracle diterapkan di sini juga, kalau tidak, jalur cadangan ini lolos dari
          // filter model besar sepenuhnya.
          if (isVlmOracleEnabled(process.env)) {
            const veto = await applyOracleVeto(pooledFrames, {
              jobId, niche: options.niche || 'kitchen_tools', blacklisted: blacklistedFramePaths, onProgress: updateProgress,
            });
            pooledFrames = veto.frames;
            if (veto.rejected > 0) {
              console.log(`[Job ${jobId}] ⛔ [Oracle] ${veto.rejected}/${veto.checked} frame diveto (jalur storyboard cadangan).`);
            }
          }

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
              noteVisionProvenance(hl, {
                mode: 'evidence',
                usableFrames: pooledFrames.length,
                framesSent: pooledFrames.length,
                framesRef: pooledFrames,
                origin: 'final_pooled',
              });
            } catch (finalAiErr) {
              console.warn(`[Job ${jobId}] ⛔ AI Storyboard percobaan akhir gagal: ${finalAiErr.message}`);
              noteVisionProvenance(finalAiErr.visionEvidence ? {
                visionEvidence: finalAiErr.visionEvidence,
                acceptedFrames: finalAiErr.acceptedFrames || [],
                rejectedFrames: finalAiErr.rejectedFrames || [],
              } : null, {
                mode: 'evidence',
                usableFrames: pooledFrames.length,
                framesSent: pooledFrames.length,
                origin: 'final_pooled_reject',
              });
              lastRejectionError = finalAiErr;
            }
          }
        }
      }

      // ── GUARANTEED COMPLETION RESCUE PIPELINE ──
      // Jika AI Vision belum menghasilkan hl.clips >= 2, tetapi kita memiliki kumpulan frame bersih
      // dari video yang telah lolos verifikasi produk fisik: JANGAN PERNAH GAGALKAN JOB!
      // Rakit Storyboard Penyelamat (Rescue Storyboard) berkualitas tinggi secara otomatis!
      //
      // KECUALI bila AI sudah MEMBERI VONIS dan isinya "semua bukti ditolak". Kasus nyata
      // 30 Sep 2026 (job auto_3dd085b354): Gemini menolak 30/30 keyframe bukti (0 diterima,
      // 0 klip), rescue tetap merakit 7 klip dari frame yang tidak pernah disetujui AI,
      // wajah manusia masuk video final, QC final menolak -> final dihapus, ~52 MB kuota +
      // 20 menit render + 1 panggilan TTS terbuang, dan job ditandai BERHASIL tanpa output.
      // Sekarang vonis negatif dihormati: gagal cepat SEBELUM download 1080p.
      const rescueAllowed = shouldAllowRescue({
        aiGaveVerdict: visionState.aiGaveFrameVerdict,
        acceptedCount: visionState.accepted || retainedCleanFrames.length,
        rejectedCount: visionState.rejected,
      });
      if (!rescueAllowed && (!hl || !Array.isArray(hl.clips) || hl.clips.length < 2)) {
        const blockedMsg = `AI Vision menolak seluruh bukti visual (${visionState.rejected} frame ditolak, 0 diterima) untuk "${productTitle}". Footage kandidat tidak layak dipakai.`;
        console.warn(`[Job ${jobId}] ⛔ [Rescue DIBLOKIR] ${blockedMsg} Storyboard TIDAK dipaksa dari frame yang divonis kotor — job digagalkan sebelum download 1080p (hemat kuota & waktu).`);
        lastRejectionError = new Error(blockedMsg);
        lastRejectionError.isAiRejection = true;
        lastRejectionError.rejectionReason = blockedMsg;
      }
      if (!RENDER_ON_APPROVAL && rescueAllowed && (!hl || !Array.isArray(hl.clips) || hl.clips.length < 2)) {
        console.log(`[Job ${jobId}] 🛡️ Mengaktifkan Guaranteed Completion Rescue Pipeline untuk memastikan tidak ada job yang gagal...`);
        // Saat AI sudah memvonis, HANYA frame yang ia setujui yang boleh dirakit. Frame
        // bersih lokal yang tidak ikut terkirim (pooledFrames) tidak dipakai diam-diam.
        const approvedIdxList = Array.isArray(hl?.acceptedFrames) ? hl.acceptedFrames : [];
        const approvedSpace = visionState.lastFramesSent || pooledFrames;
        const aiApprovedFrames = (visionState.aiGaveFrameVerdict && approvedIdxList.length && approvedSpace.length)
          ? approvedIdxList.map((i) => approvedSpace[Number(i) - 1]).filter((f) => f && f.filePath)
          : [];
        const rescuePool = aiApprovedFrames.length >= 2
          ? aiApprovedFrames
          : ((visionState.aiGaveFrameVerdict || retainedCleanFrames.length > 0) ? retainedCleanFrames : pooledFrames);
        const allCleanFramesRaw = rescuePool
          .filter(f => f && f.filePath && !blacklistedFramePaths.has(f.filePath));
        // Selang-seling per video sumber SEBELUM dirakit. Rescue pool bisa berasal dari
        // retainedCleanFrames yang di-append per kandidat (blok panjang satu sumber),
        // sehingga tanpa interleave 7 klip rescue menumpuk di sumber pertama -> Reels
        // 1 sumber tanpa variasi (keluhan lapangan 30 Sep 2026).
        const rescueGroups = new Map();
        for (const f of allCleanFramesRaw) {
          const k = sourceKeyOf(f);
          if (!rescueGroups.has(k)) rescueGroups.set(k, []);
          rescueGroups.get(k).push(f);
        }
        const allCleanFrames = [];
        const rescueRounds = Math.max(0, ...[...rescueGroups.values()].map((g) => g.length));
        for (let r = 0; r < rescueRounds; r++) {
          for (const g of rescueGroups.values()) {
            if (r < g.length) allCleanFrames.push(g[r]);
          }
        }

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
        const fallbackMsg = `Semua kandidat video (telah di-stream ${streamedCount} video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "${productTitle}": ${lastRejectionError?.rejectionReason || lastRejectionError?.message || 'frame tidak mencukupi / ditolak filter atau AI'}.`;
        if (isAutoModeFallback && candidatePoolIndex < candidatePool.length) {
            console.warn(`[Job ${jobId}] ⚠️ ${fallbackMsg}. Meneruskan ke iterasi Master Loop untuk mencari video lain...`);
            continue; // Ulangi master loop
        }
        throw new Error(fallbackMsg);
      }

      // Visibilitas variasi sumber. Storyboard 1 sumber pernah terjadi DIAM-DIAM
      // (job auto_3dd085b354: 7 klip, kandidat=[0,0,0,0,0,0,0]) sehingga operator tidak
      // bisa membedakan "panen berhenti terlalu cepat" dari "kandidat lain ditolak AI".
      // Sekarang jumlah sumber terpakai dihitung, ditempel di storyboard, dan dicatat
      // di trace durabel + log peringatan bila di bawah target niche.
      const sourceCountUsed = new Set((hl.clips || []).map((c) => c.candidateIndex ?? 0)).size;
      hl.sourceCount = sourceCountUsed;
      hl.targetSourceCount = targetMultiSources;
      if (sourceCountUsed < targetMultiSources) {
        console.warn(`[Job ${jobId}] ⚠️ Storyboard hanya memakai ${sourceCountUsed} video sumber (target ${targetMultiSources}). Kandidat terverifikasi yang tersedia: ${candidateResults.length} setelah ${streamedCount} stream. Penyebabnya penolakan AI/filter atas kandidat lain, bukan loop panen yang berhenti dini.`);
      }
      recordStageEvent({
        jobId,
        stage: 'storyboard_sources',
        candidateCount: candidateResults.length,
        acceptedCount: (hl.clips || []).length,
        rejectedCount: 0,
        failureReason: sourceCountUsed < targetMultiSources ? `Sumber terpakai ${sourceCountUsed} < target ${targetMultiSources}` : '',
        meta: {
          sourceCountUsed,
          targetMultiSources,
          verifiedSources: candidateResults.length,
          streamedCount,
          isRescue: Boolean(hl.isRescueStoryboard),
        },
      });

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
      // Menggunakan outer variable (bukan deklarasi ulang) agar ClipAudit pasca-download
      // mengakses peta yang terisi, bukan Map kosong dari scope luar.
      downloadedCandidatesMap = new Map();

      // #1 Download per-segmen (hemat kuota). DEFAULT OFF → jalur render identik dengan sebelumnya.
      const useSections = process.env.RENDER_DOWNLOAD_SECTIONS === '1';
      // Mode TEGAS: JANGAN PERNAH unduh video penuh. Hanya berlaku bersama useSections.
      const noFullDl = process.env.RENDER_NO_FULL_DOWNLOAD === '1';
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
            const okClusters = candClips.filter(c => c._cluster).length;
            if (allClustersOk) continue; // kandidat selesai via per-segmen (semua cluster sukses)

            // SEBAGIAN cluster gagal. strict (RENDER_NO_FULL_DOWNLOAD=1) -> pakai segmen
            // yang sukses saja & BUANG klip yang segmennya gagal; TANPA unduh penuh.
            if (noFullDl) {
              if (okClusters > 0) {
                hl.clips = hl.clips.filter(c => (c.candidateIndex ?? 0) !== candIdx || c._cluster);
                console.warn(`[Job ${jobId}] ✂️ STRICT sections: kandidat #${candIdx + 1} pertahankan ${okClusters} segmen sukses; ${candClips.length - okClusters} klip segmen-gagal dibuang (tanpa unduh penuh).`);
              } else {
                console.warn(`[Job ${jobId}] ⛔ STRICT sections: semua segmen kandidat #${candIdx + 1} gagal; kandidat dilewati (tanpa unduh penuh).`);
              }
              continue;
            }

            // Fallback lama (non-strict): bersihkan penanda cluster lalu unduh penuh.
            candClips.forEach(c => { delete c._cluster; });
            console.warn(`[Job ${jobId}] 🔄 Segmen kandidat #${candIdx + 1} tidak lengkap; fallback ke unduhan penuh.`);
          }

          // Hanya tersentuh bila BUKAN strict-sections (jalur strict sudah `continue` di atas).
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

      // Jika seluruh kandidat terpilih gagal, coba kandidat cadangan (HANYA bila bukan strict-sections;
      // mode strict menolak unduh penuh, jadi kandidat cadangan pun tidak diunduh penuh).
      if (downloadedCandidatesMap.size === 0 && !(useSections && noFullDl)) {
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
      //
      // [RENDER-ON-APPROVAL] Gerbang ">=3 klip" ini adalah PENYARING PASCA-APPROVAL terakhir yang
      // masih menggagalkan job meski Gemini sudah menyatakan kandidat layak dan segmen bagus sudah
      // terunduh. Whisper-First Pipeline sengaja merakit SATU window terbaik yang divalidasi Gemini
      // (clips.length === 1), sehingga gerbang lama selalu melempar "AI Vision hanya menghasilkan 1
      // adegan unik (<3)" -> "Gagal merender setelah 1 kali percobaan". Sesuai mandat user
      // (2 Okt 2026): setelah Gemini menyatakan layak, unduh window bagus lalu RENDER, tidak usah
      // ada filter lagi. Selama mode ini aktif, 1-2 klip yang sudah disetujui WAJIB di-render apa
      // adanya (pacing di bawah mempertahankan durasi window alaminya, bukan memotong ke 6s).
      if (!RENDER_ON_APPROVAL && hl.clips.length < 3) {
        const clipErr = new Error(
          `AI Vision hanya menghasilkan ${hl.clips.length} adegan unik (<3). Tidak akan menggandakan adegan untuk mengejar durasi.`
        );
        clipErr.isAiRejection = true;
        clipErr.rejectionReason = 'Adegan unik produk kurang dari 3 klip fisik bersih.';
        throw clipErr;
      }

      // Guard minimum universal: tetap butuh SATU klip sumber bersih agar ada yang bisa di-render.
      if (hl.clips.length < 1) {
        const noClipErr = new Error('Tidak ada klip sumber bersih yang tersedia untuk di-render.');
        noClipErr.isAiRejection = true;
        noClipErr.rejectionReason = 'Nol klip lolos approval.';
        throw noClipErr;
      }

      if (RENDER_ON_APPROVAL && hl.clips.length < 3) {
        console.log(`[Job ${jobId}] ✅ [Render-on-Approval] ${hl.clips.length} window disetujui Gemini (dulu dituntut >=3) - langsung render tanpa mengejar klip tambahan.`);
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
      // ── MODE HEMAT KUOTA UNTUK MANUAL/SINGLE-VIDEO ──
      // Samai jalur auto: bila RENDER_DOWNLOAD_SECTIONS=1, unduh HANYA segmen klip terpilih
      // (bukan video penuh). RENDER_NO_FULL_DOWNLOAD=1 melarang keras fallback unduh penuh.
      const mUseSections = process.env.RENDER_DOWNLOAD_SECTIONS === '1';
      const mNoFullDl = process.env.RENDER_NO_FULL_DOWNLOAD === '1';
      const mPad = Number(process.env.RENDER_SECTION_PAD || 2) || 2;
      const mTailPad = Number(process.env.RENDER_SECTION_TAIL_PAD || 5) || 5;
      const mGap = Number(process.env.RENDER_SECTION_GAP || 15) || 15;
      const mDurHint = Number(videoMeta?.duration) || 0;
      let sectionsDone = false;

      if (mUseSections && Array.isArray(highlight?.clips) && highlight.clips.length > 0 && currentYoutubeUrl) {
        updateProgress({ step: 'download_hd', message: '✂️ Mode manual: unduh HANYA segmen klip terpilih 1080p (hemat kuota)...', progress: 52, status: 'running' });
        try {
          const clusters = planSectionDownloads(highlight.clips, { padSec: mPad, tailPadSec: mTailPad, gapSec: mGap, videoDuration: mDurHint });
          let okCount = 0;
          let firstSeg = null;
          for (let k = 0; k < clusters.length; k++) {
            const cluster = clusters[k];
            try {
              const secDl = await downloadYouTubeVideo(currentYoutubeUrl, sessionTempDir, jobId, updateProgress, {
                quality: '1080p',
                prefix: `raw_sec${k}`,
                section: { startSec: cluster.startSec, endSec: cluster.endSec },
              });
              if (secDl?.filePath && fs.existsSync(secDl.filePath)) {
                okCount++;
                if (!firstSeg) firstSeg = secDl.filePath;
                cluster.refs.forEach(ref => { ref._cluster = { videoPath: secDl.filePath, sourceOffsetSec: cluster.sourceOffsetSec }; });
                console.log(`[Job ${jobId}] ✂️ Manual: segmen #${k} (${cluster.startSec.toFixed(1)}-${cluster.endSec.toFixed(1)}s) terunduh (hemat kuota).`);
              }
            } catch (secErr) {
              console.warn(`[Job ${jobId}] ⚠️ Manual: gagal unduh segmen #${k}: ${secErr.message}`);
            }
          }

          const segClips = highlight.clips.filter(c => c._cluster);
          // Pakai mode segmen bila SEMUA cluster sukses, ATAU (strict & ada >=1 segmen sukses).
          if (segClips.length > 0 && (okCount === clusters.length || mNoFullDl)) {
            highlight.clips = segClips.map(c => {
              const { _cluster, ...rest } = c;
              return { ...rest, videoPath: _cluster.videoPath, sourceOffsetSec: _cluster.sourceOffsetSec };
            });
            rawVideoPath = firstSeg;
            sectionsDone = true;
            if (okCount < clusters.length) {
              console.warn(`[Job ${jobId}] ✂️ Manual STRICT: ${highlight.clips.length} klip ber-segmen dipertahankan, klip segmen-gagal dibuang (tanpa unduh penuh).`);
            } else {
              console.log(`[Job ${jobId}] ✂️ Manual sections: ${highlight.clips.length} klip dilayani ${clusters.length} segmen (tanpa unduh penuh).`);
            }
          } else if (clusters.length === 0) {
            // Tidak ada cluster -> biarkan fallback normal di bawah.
          } else if (mNoFullDl) {
            highlight.clips.forEach(c => { delete c._cluster; });
            console.warn(`[Job ${jobId}] ⛔ Manual STRICT: semua segmen gagal; tanpa unduh penuh.`);
          } else {
            // Sebagian gagal & NON-strict -> unduh penuh utuh (perilaku lama).
            highlight.clips.forEach(c => { delete c._cluster; });
            console.warn(`[Job ${jobId}] 🔄 Manual: segmen tidak lengkap; fallback ke unduhan penuh.`);
          }
        } catch (secErr) {
          highlight.clips.forEach(c => { delete c._cluster; });
          console.warn(`[Job ${jobId}] ⚠️ Manual sections error: ${secErr.message}. ${mNoFullDl ? 'STRICT: tidak unduh penuh.' : 'Fallback unduh penuh.'}`);
        }

        // STRICT: bila tidak ada satu pun segmen sukses, JANGAN pernah unduh penuh -> gagal jelas.
        if (!sectionsDone && mNoFullDl) {
          throw new Error('Mode tegas (RENDER_NO_FULL_DOWNLOAD=1): seluruh segmen klip manual gagal diunduh; tidak melakukan unduhan penuh.');
        }
      }

      if (!sectionsDone) {
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
      // Kantong untuk pass oracle: klip yang lolos gerbang motion beserta frame 2,5 fps
      // yang SUDAH diekstrak di bawah. oracleClipSlots[i] = posisi klip ke-i di
      // cleanAuditedClips, supaya vonis model besar bisa memetakan balik ke indeksnya.
      const oracleClips = [];
      const oracleFrameGroups = [];
      const oracleClipSlots = [];

      for (let cIdx = 0; cIdx < highlight.clips.length; cIdx++) {
        const c = highlight.clips[cIdx];
        const clipVid = c.videoPath || rawVideoPath;
        // Klip dari file segmen (--download-sections): timeline file dimulai di sourceOffsetSec.
        const cOffset = Number(c.sourceOffsetSec) || 0;
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
        const sampleTimestamps = sampleOffsets.map(offset => Math.max(0, Math.round(((c.startSeconds + offset) - cOffset) * 100) / 100));

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

        // ─── CLIP AUDIT: GERBANG LOKAL HANYA MENOLAK FOTO STATIS / KEN BURNS ───
        // Deteksi teks overlay & wajah TIDAK dilakukan oleh kode lokal di sini: dulu
        // pemblokiran itu pernah dipasang dan hasilnya buruk (model lokal tidak layak,
        // kuota sudah terlanjur terpakai setelah download). Yang menolak klip karena
        // teks/wajah di tahap ini HANYA vonis oracle Kaggle (model besar di GPU) di
        // blok [[ORACLE CLIP AUDIT]] di bawah — itu lapisan yang diizinkan. Selain itu
        // satu-satunya pemblokiran lokal di sini tetap klip FOTO DIAM (motionAudit).
        cleanAuditedClips.push(c);
        oracleClips.push(c);
        oracleFrameGroups.push(testFrames);
        oracleClipSlots.push(cleanAuditedClips.length - 1);
      }

      // [[ORACLE CLIP AUDIT]] — veto klip final oleh model besar (VISION_VERIFY_MODE=oracle).
      // Frame-nya gratis: sudah diekstrak pada sampleStepSec 0.40 s di atas dari file
      // section 1080p yang baru diunduh. Yang dikirim ke notebook versi 360p
      // (VLM_ORACLE_FRAME_HEIGHT). Klip yang divonis kotor masuk discardedDirtyClips
      // dan mesin recovery di bawah yang menangani sisanya (Slot 1 + pooledFrames).
      // Oracle diam/timeout = TIDAK ada vonis = klip tetap dipakai (legacy berlaku).
      if (isVlmOracleEnabled(process.env) && oracleClips.length > 0) {
        updateProgress({
          step: 'vlm_oracle',
          message: '🛰️ Oracle Kaggle memvonis klip final (frame 2,5 fps dari file 1080p terunduh)...',
          progress: 61,
          status: 'running'
        });
        try {
          const audit = await auditClipsWithOracle(oracleClips, oracleFrameGroups, {
            jobId, niche: options.niche || 'kitchen_tools', onProgress: updateProgress,
          });
          const dirtySlots = [];
          for (const [i, v] of audit.verdicts) {
            if (v && v.dirty && Number.isInteger(oracleClipSlots[i])) dirtySlots.push(oracleClipSlots[i]);
          }
          // Potong dari indeks terbesar agar posisi sisanya tidak bergeser.
          dirtySlots.sort((a, b) => b - a).forEach((slot) => {
            const [removed] = cleanAuditedClips.splice(slot, 1);
            if (removed) discardedDirtyClips.push({ clip: removed, reason: 'ORACLE_DIRTY' });
          });
          console.log(`[Job ${jobId}] 🛰️ [Oracle audit klip] ${audit.checked} frame divisit, ${dirtySlots.length} klip ditolak model besar, ${audit.timedOut} frame tak dijawab (dalam ${Math.round(audit.elapsedMs / 1000)}s).`);
        } catch (oracleErr) {
          // Jaga-jaga murni: auditClipsWithOracle tidak pernah melempar. Kalau ini
          // terjadi, klip tetap dipakai — keputusan legacy + Gemini yang berlaku.
          console.warn(`[Job ${jobId}] ⚠️ [Oracle audit klip] dilewati (${oracleErr.message}) -> semua klip hasil audit lokal tetap dipakai.`);
        }
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

    isBrandDetected = highlight.hasProductBrand === true ||
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
      isAutoModeFallback,
    });

    const actualSilentDuration = (await getMediaDurationSec(silentOutputPath)) || highlight.duration || 33;
    highlight.duration = actualSilentDuration;

    updateProgress({ step: 'frames_trimmed', message: 'Sampling frames from trimmed video for AI scripting...', progress: 72, status: 'running' });
    const { frames: trimmedFrames } = await extractFrames(silentOutputPath, trimmedFramesDir, updateProgress, {
      sampleIntervalSec: 2.2,
      maxSampleFrames: 12,
    });

    updateProgress({ step: 'gpt_scripting', message: 'AI generating Kotak Scene, Context, Naskah...', progress: 80, status: 'running' });
    scriptData = null;
    try {
      scriptData = await generateAdAdvisorScriptWithAI({
        apiKey,
        aiProvider,
        trimmedFrames,
        videoMetadata: videoMeta,
        productTitle: (highlight.detectedProduct || productTitle || '').trim(),
        productDescription,
        shopeeLink,
        whisperSegments: highlight.whisperSegments || [],
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

    rawVoiceScript = scriptData.voiceoverScript || scriptData.aiStudioPrompt || '';

    // ─── AUDIO-DRIVEN NARRATION (Fase 1 & 2, guard flag; default OFF) ───
    // Bila aktif: ekstrak VO sumber pada jendela klip → whisper beat → parafrase
    // anti-plagiat (model teks) → pakai sebagai naskah Gemini TTS. Visual tetap
    // conformed ke durasi audio final (conformClipsToVoiceover), sehingga potongan
    // adegan mengikuti ritme narasi asli. Gagal-anggun: tetap pakai naskah vision.
    let finalVoiceScript = rawVoiceScript;
    // Laporan hasil audio-driven, dicatat ke trace + record job. Sebelumnya hasil
    // whisper hanya muncul di console (hang di /dev/pts/0 di Termux) sehingga tidak ada
    // cara memverifikasi fitur ini benar-benar bekerja atau diam-diam jatuh ke pola lama.
    const audioDrivenReport = {
      enabled: isAudioDrivenEnabled(),
      used: false,
      outcome: isAudioDrivenEnabled() ? 'not_attempted' : 'flag_off',
      beats: 0,
      reason: '',
      sourceFile: '',
      windowSec: null,
    };
    if (isAudioDrivenEnabled()) {
      updateProgress({ step: 'audio_analysis', message: '🎧 Menganalisis voice-over sumber (whisper beat)...', progress: 81, status: 'running' });
      try {
        // Sumber audio = file yang benar-benar memuat klip pertama. Pada mode hemat
        // (RENDER_DOWNLOAD_SECTIONS=1) `rawVideoPath` adalah SEGMEN hasil --download-sections
        // yang timeline-nya sudah dimulai di sourceOffsetSec -> jendela whisper di-rebase
        // dan di-clamp lewat resolveAudioWindow (pure, terkunci unit test).
        const adFirstClip = (Array.isArray(highlight.clips) && highlight.clips[0]) ? highlight.clips[0] : null;
        const adSourcePath = (adFirstClip?.videoPath && fs.existsSync(adFirstClip.videoPath)) ? adFirstClip.videoPath : rawVideoPath;
        const adFileDur = (await getMediaDurationSec(adSourcePath)) || 0;
        const { startSec: adStart, endSec: adEnd } = resolveAudioWindow({
          clip: adFirstClip,
          highlight,
          fileDurationSec: adFileDur,
        });
        audioDrivenReport.sourceFile = adSourcePath ? path.basename(adSourcePath) : '';
        audioDrivenReport.windowSec = [adStart, adEnd];
        const ad = await analyzeSourceAudioForBeats({
          videoPath: adSourcePath,
          // PAKAI ANGKA DETIK (startSeconds/endSeconds), BUKAN string "MM:SS" (startTime/
          // endTime). Number("01:24") = NaN -> 0, sehingga jendela analisis runtuh jadi
          // 0-0 dan whisper membaca video dari detik awal (offset beat tidak selaras klip).
          startSec: adStart,
          endSec: adEnd,
          // Coverage dihitung terhadap jendela yang benar-benar dianalisis, bukan durasi
          // hasil render silent (yang sudah menyusut/memanjang setelah conforming).
          totalDurationSec: adEnd > adStart ? (adEnd - adStart) : actualSilentDuration,
        });
        if (ad.ok && ad.voiceover?.hasVoiceover && Array.isArray(ad.beats) && ad.beats.length) {
          updateProgress({ step: 'audio_paraphrase', message: `🪶 Memparafrase ${ad.beats.length} beat narasi (anti-plagiat)...`, progress: 82, status: 'running' });
          const pp = await paraphraseBeats({ beats: ad.beats, apiKey, aiProvider });
          const narration = beatsToScript(pp.ok ? pp.beats : ad.beats);
          if (narration && narration.trim()) {
            finalVoiceScript = narration.trim();
            highlight.audioDrivenBeats = pp.ok ? pp.beats : ad.beats;
            audioDrivenReport.used = true;
            audioDrivenReport.outcome = 'narration_from_source';
            audioDrivenReport.beats = ad.beats.length;
            audioDrivenReport.reason = `cakupan ${(ad.voiceover.coverage * 100).toFixed(0)}%, parafrase ${pp.ok ? 'OK' : 'dilewati'}`;
            console.log(`[Job ${jobId}] ✅ AUDIO-DRIVEN: naskah diambil dari VO sumber terparafrase (${ad.beats.length} beat, cakupan ${(ad.voiceover.coverage * 100).toFixed(0)}%).`);
          } else {
            audioDrivenReport.outcome = 'empty_narration';
            audioDrivenReport.beats = ad.beats.length;
            audioDrivenReport.reason = 'beat ada tetapi naskah hasil parafrase kosong';
          }
        } else if (ad.ok && !ad.voiceover?.hasVoiceover) {
          audioDrivenReport.outcome = 'no_voiceover_in_source';
          audioDrivenReport.reason = ad.voiceover?.reason || 'video tanpa voice-over';
          console.warn(`[Job ${jobId}] ⚠️ AUDIO-DRIVEN: ${audioDrivenReport.reason} — fallback ke naskah vision.`);
        } else if (ad.skipped) {
          audioDrivenReport.outcome = 'skipped';
          audioDrivenReport.reason = ad.reason || 'analisis audio di-skip';
        } else {
          audioDrivenReport.outcome = 'analysis_failed';
          audioDrivenReport.reason = ad.missingBinary ? 'whisper.cpp belum terpasang' : (ad.error || 'analisis audio gagal');
          console.warn(`[Job ${jobId}] ⚠️ AUDIO-DRIVEN: analisis audio gagal (${audioDrivenReport.reason}) — fallback ke naskah vision.`);
        }
      } catch (adErr) {
        audioDrivenReport.outcome = 'error';
        audioDrivenReport.reason = adErr.message;
        console.warn(`[Job ${jobId}] ⚠️ AUDIO-DRIVEN error: ${adErr.message} — fallback ke naskah vision.`);
      }
      // Jejak durabel: satu baris trace per job tentang nasib audio-driven (+ file yang dibaca).
      // Laporan juga ditempel ke `highlight` agar ikut tersimpan di record job (history/DB),
      // bukan hanya console yang di Termux dibuang ke /dev/pts/0.
      highlight.audioDriven = { ...audioDrivenReport };
      recordStageEvent({
        jobId,
        kind: 'metric',
        stage: 'audio',
        provider: 'whisper.cpp',
        message: `Audio-driven ${audioDrivenReport.used ? 'AKTIF' : 'TIDAK terpakai'}: ${audioDrivenReport.outcome}`,
        failureReason: audioDrivenReport.used ? '' : audioDrivenReport.reason,
        meta: { ...audioDrivenReport },
      });
    } else {
      highlight.audioDriven = { ...audioDrivenReport };
    }

    const voiceoverFileName = `voiceover_${jobId}.mp3`;
    autoVoiceoverPath = path.join(uploadsDir, voiceoverFileName);
    silentDurationSec = (await getMediaDurationSec(silentOutputPath)) || highlight.duration || 20;

    const activeTtsProvider = 'gemini_tts'; // Edge-TTS removed; Gemini Flash TTS is the sole voiceover engine.
    const ttsModelToUse = options.ttsModel || process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL;
    const ttsFallbackModelToUse = options.ttsFallbackModel || process.env.GEMINI_TTS_FALLBACK_MODEL || DEFAULT_GEMINI_TTS_FALLBACK_MODEL;
    const ttsVoiceToUse = options.ttsVoice || process.env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE;
    const ttsLabel = `Gemini Flash (${ttsModelToUse} - ${ttsVoiceToUse})`;

    updateProgress({
      step: 'tts_generating',
      message: `🎙️ Menghasilkan voice over ${ttsLabel}...`,
      progress: 84,
      status: 'running',
    });

    ttsSucceeded = false;
    let ttsResult = null;
    for (let ttsAttempt = 0; ttsAttempt < 3; ttsAttempt++) {
      try {
        if (ttsAttempt > 0) {
          console.log(`[Job ${jobId}] Retrying TTS (${ttsLabel}) (attempt ${ttsAttempt + 1})...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        ttsResult = await generateVoiceoverTTS({
          script: finalVoiceScript,
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

    let autoFinalError = null;
    // Rekap jalur visual untuk record job (penanda durabel: evidence vs stream vs stride).
    visionSummary = summarizeVisionRuns(visionState.runs);
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
          script: finalVoiceScript,
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

        // [RENDER-ON-APPROVAL] Final QC pasca-render + auto-repair DIMATIKAN untuk semua job:
        // hasil render langsung diterima - tidak ada gerbang yang menghapus video / memicu restart.
        let finalQc;
        if (RENDER_ON_APPROVAL) {
          finalQc = {
            passed: true,
            skipped: true,
            disabled: true,
            reason: 'Final QC pasca-render dinonaktifkan (render-on-approval).',
            technical: { passed: true, skipped: true, issues: [] },
            visual: { passed: true, skipped: true, reason: 'Final AI QC disabled (render-on-approval).' },
          };
          console.log(`[Job ${jobId}] ✅ [Render-on-Approval] Final QC dilewati - video hasil render langsung diterima.`);
        } else {
          finalQc = await runProfessionalFinalQcWithRepair({
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
            detectedProduct: highlight.detectedProduct || '',
            // Duplikat penanda di dalam highlight: riwayat manual/panel membaca objek
            // highlight ini, bukan field top-level job.
            isRescueStoryboard: Boolean(highlight.isRescueStoryboard),
            audioDriven: highlight.audioDriven || null,
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
          visionProvenance: visionSummary,
          isRescueStoryboard: Boolean(highlight.isRescueStoryboard),
        };

        // Merge (bukan REPLACE): persistJob menimpa seluruh baris sehingga niche, oemUrls,
        // sourcePolicy dan configSnapshot hasil tahap create ikut terhapus. Dibuktikan di
        // Termux 30 Sep 2026: job auto final tidak punya configSnapshot -> retry jatuh ke
        // "⚠️ Job lama tanpa configSnapshot" dan memakai .env saat ini (bukan setelan beku).
        const completedJob = patchJob(jobId, completedResult, { force: true });

        updateProgress({
          step: 'completed',
          message: '🎉 Video Final 9:16 + Voiceover Gadis Indonesia & Subtitle Selesai!',
          progress: 100,
          status: 'completed',
          result: completedJob,
        });

        finalCompletedJob = completedJob;
        break;
      } catch (mergeErr) {
        if (isAutoModeFallback) {
          if (mergeErr.isFinalQcFailure || mergeErr.isAiRejection) {
            console.warn(`[Job ${jobId}] ⛔ QC Final (Tahap 2) menolak video 1080p: ${mergeErr.message}. Membatalkan sisa tahap ini dan mencari video lain...`);
            if (candidateResults) {
              candidateResults.forEach(c => {
                if (c.candidate && c.candidate.url) failedCandidateUrls.add(c.candidate.url);
              });
              candidateResults = []; // Kosongkan agar mencari baru
            }
            continue; // Kembali ke awal master loop
          }
          // MODE AUTO: video final adalah satu-satunya output. Kalau tahap final/QC gagal,
          // JANGAN pernah melabeli job 'completed' dengan pesan hijau - itu persis penyebab
          // "job berhasil tapi output kosong" (final dihapus saat QC menolak, error ditelan).
          // Error diteruskan ke blok catch di bawah: aset silent tetap dipertahankan, dan
          // Auto Mode mencatatnya sebagai GAGAL lalu mencari sumber lain (self-healing).
          mergeErr.jobId = jobId;
          // Rekam PENYEBAB kegagalan (termasuk vonis QC final yang menghapus file) sebelum
          // error dilempar. Tanpa ini riwayat hanya menampilkan "sukses" kosong dan operator
          // tidak punya jejak untuk membedakan "QC menolak wajah" vs "TTS gagal".
          try {
            patchJob(jobId, {
              lastError: mergeErr.message,
              finalFailureReason: mergeErr.isFinalQcFailure ? 'FINAL_MASTER_QC_FAILED' : 'FINAL_RENDER_FAILED',
              finalQc: mergeErr.finalQc || null,
              hasFinalVideo: false,
              visionProvenance: visionSummary,
              isRescueStoryboard: Boolean(highlight?.isRescueStoryboard),
            }, { force: true });
          } catch { /* jejak gagal tidak boleh menutupi error utama */ }
          recordStageEvent({
            jobId,
            kind: 'metric',
            stage: 'completed',
            provider: 'pipeline',
            message: `Auto mode GAGAL di tahap final (bukan sukses kosong): ${mergeErr.isFinalQcFailure ? 'QC final menolak video' : 'render final gagal'}`,
            failureReason: mergeErr.message,
            meta: { isFinalQcFailure: Boolean(mergeErr.isFinalQcFailure), visionProvenance: visionSummary, isRescueStoryboard: Boolean(highlight?.isRescueStoryboard) },
          });
          console.error(`[Job ${jobId}] ⛔ Tahap final AUTO gagal${mergeErr.isFinalQcFailure ? ' (FINAL_MASTER_QC_FAILED: video kotor ditolak QC)' : ''}: ${mergeErr.message}. Video final TIDAK ada - ini BUKAN sukses.`);
          throw mergeErr;
        }
        autoFinalError = mergeErr;
        forceManualFallback = true;
        console.warn(`[Job ${jobId}] Tahap final gagal, lanjut menunggu voiceover manual:`, mergeErr.message);
      }
    }
      } catch (masterLoopErr) {
        if (isAutoModeFallback && masterLoopErr.isAiRejection) {
          console.warn(`[Job ${jobId}] ⚠️ Pipeline tertunda (isAiRejection=true): ${masterLoopErr.message}. Meneruskan ke iterasi Master Loop untuk mencari video lain...`);
          if (candidateResults) {
            candidateResults.forEach(c => {
              if (c.candidate && c.candidate.url) failedCandidateUrls.add(c.candidate.url);
            });
            candidateResults = [];
          }
          continue;
        }
        throw masterLoopErr;
      }
    } // Akhir Master Loop

    if (finalCompletedJob) return finalCompletedJob;

    if (isAutoModeFallback) {
      throw new Error(`Gagal merender video setelah ${masterRetryCount} kali percobaan (kandidat habis atau selalu ditolak QC).`);
    }

    // Fallback (MODE MANUAL SAJA): TTS atau tahap final gagal -> berhenti di awaiting_voiceover
    // dengan video silent 9:16 siap pakai. Untuk job AUTO blok ini tidak lagi tercapai:
    // kegagalan final di-throw di atas agar Auto Mode menganggapnya GAGAL (bukan "berhasil"
    // tanpa output seperti sebelumnya).
    const stage1Result = {
      ...extraJobMeta,
      jobId,
      stage: 'awaiting_voiceover',
      status: 'awaiting_voiceover',
      lastError: autoFinalError ? autoFinalError.message : null,
      finalFailureReason: autoFinalError && autoFinalError.isFinalQcFailure ? 'FINAL_MASTER_QC_FAILED' : null,
      finalQc: autoFinalError?.finalQc || null,
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
        clips: highlight.clips,
        // detectedProduct dulu TIDAK ikut tersimpan -> retry kehilangan identitas produk hasil
        // vision dan jatuh kembali ke judul mentah Shopee (lihat record auto_3dd085b354).
        detectedProduct: highlight.detectedProduct || '',
        isRescueStoryboard: Boolean(highlight.isRescueStoryboard),
        audioDriven: highlight.audioDriven || null,
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
      visionProvenance: visionSummary,
      isRescueStoryboard: Boolean(highlight.isRescueStoryboard),
    };

    const stage1Job = patchJob(jobId, stage1Result, { force: true });

    updateProgress({
      step: 'awaiting_voiceover',
      message: autoFinalError
        ? `⚠️ Tahap 1 selesai TANPA video final (${autoFinalError.message}). Scene & video silent 9:16 tersimpan - silakan generate Voiceover/Subtitle ulang.`
        : 'Tahap 1 Selesai! Kotak Scene, Naskah, dan Muted 9:16 Video Ready.',
      progress: 100, 
      status: 'awaiting_voiceover', 
      result: stage1Job
    });

    return stage1Job;
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
        // Bukti jalur yang benar-benar dijalankan, ikut disimpan pada job GAGAL juga:
        // inilah field yang dipakai operator membedakan "evidence mode" vs "pola lama".
        visionProvenance: summarizeVisionRuns(visionState.runs),
        isRescueStoryboard: Boolean(highlight?.isRescueStoryboard),
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

      if (isAuto) {
        // MODE AUTO: tidak ada video final = BUKAN sukses. Record silent 9:16 tetap
        // ditinggalkan (bisa di-TTS manual dari panel), tapi error diteruskan ke Auto
        // Mode supaya job dicatat GAGAL dan worker mencari sumber lain. Sebelumnya jalur
        // ini `return preservedJob` sehingga stage1Discovery menaikkan `successfulJobs++`
        // -> laporan "Auto Mode selesai: 1 video berhasil" padahal output kosong.
        console.error(`[Job ${jobId}] ⛔ Auto mode dinyatakan GAGAL: ${error.message} (video final tidak ada; silent 9:16 dipertahankan di riwayat).`);
        error.jobId = jobId;
        error.isQuotaError = isQuotaErrorMessage(error.message);
        throw error;
      }

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
        visionProvenance: summarizeVisionRuns(visionState.runs),
        isRescueStoryboard: Boolean(highlight?.isRescueStoryboard),
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

