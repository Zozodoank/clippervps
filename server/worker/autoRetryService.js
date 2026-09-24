import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
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
import { classifyPipelineError, checkYouTubeHealth, getPublicIpAddress } from '../services/networkDiagnosticService.js';
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
import { activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, updateAutoRun } from '../store/jobStore.js';
import { heavyTaskQueue } from './queueManager.js';
import { isValidHttpUrl, resolveOutputVideoPath, sanitizeCaptionText, isQuotaErrorMessage } from '../utils/jobHelpers.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';

import { tempDir, outputDir, uploadsDir, rejectedYunetDir, cookiesPath, serverRoot } from '../utils/paths.js';
import { runStage1Pipeline } from './stage1Render.js';
import { conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage } from './finalizationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAutoRetryWorker(jobId, run) {
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
    const publicIp = await getPublicIpAddress();
    console.log(`[AutoRetry ${jobId}] Memulai Auto Retry pencarian video persis untuk "${targetTitle}" (IP Publik Server/Termux: ${publicIp || 'tidak diketahui'})...`);
    updateJobProgress(jobId, {
      step: 'auto_retry_start',
      message: `[Auto Retry] Memulai pencarian video yang cocok persis & faceless untuk "${targetTitle.slice(0, 30)}..." [IP: ${publicIp || 'aktif'}]`,
      progress: 5,
      status: 'running',
      isAutoRetrying: true,
      publicIp,
      attemptCount: 0,
    });

    const usedVids = getAllUsedYouTubeVideoIds();
    const oldVid = extractVideoId(job.youtubeUrl);
    if (oldVid) usedVids.add(oldVid);

    let foundSuccess = false;
    let consecutiveIpBlocks = 0;

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
              singleVideoOnly: true,
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
          const diag = classifyPipelineError(candErr);
          deleteJobFiles(jobId, outputDir, tempDir);

          console.warn(`[AutoRetry ${jobId}] [${diag.sourceStatus}] [${diag.failureCode}] Kandidat ke-${run.attemptCount} (${candidate.url}): ${diag.userFriendlyReason}`);

          if (diag.sourceStatus === 'UNAVAILABLE') {
            const isHardBlock =
              diag.failureCode === 'YOUTUBE_RATE_LIMITED' ||
              diag.failureCode === 'YOUTUBE_BOT_CHECK' ||
              diag.failureCode === 'YOUTUBE_IP_BLOCKED';

            if (isHardBlock) {
              // A candidate failure is NOT proof of an IP block. Require an independent
              // YouTube health probe to return the SAME hard-block classification.
              let health = { ok: false, status: 'UNKNOWN' };
              try {
                health = await checkYouTubeHealth();
              } catch (healthErr) {
                console.warn(`[AutoRetry ${jobId}] Health check YouTube error: ${healthErr.message}`);
              }

              const healthConfirmsBlock =
                health.ok === false &&
                health.status === diag.failureCode;

              if (health.ok) {
                consecutiveIpBlocks = 0;
                console.log(`[AutoRetry ${jobId}] ✅ Health check YouTube sehat (IP ${health.publicIp || 'unknown'}). Kegagalan kandidat dianggap spesifik-video.`);
              } else if (!healthConfirmsBlock) {
                consecutiveIpBlocks = 0;
                console.warn(`[AutoRetry ${jobId}] ℹ️ Kandidat gagal ${diag.failureCode}, tetapi health probe=${health.status || 'UNKNOWN'} tidak mengonfirmasi blokir IP. Lanjut kandidat.`);
              } else {
                consecutiveIpBlocks++;
                console.warn(`[AutoRetry ${jobId}] ⚠️ Blokir YouTube terkonfirmasi (${health.status}), beruntun: ${consecutiveIpBlocks}/3.`);

                if (consecutiveIpBlocks >= 3) {
                  const currentIp = health.publicIp || await getPublicIpAddress({ forceRefresh: true });
                  run.status = 'error';
                  run.sourceStatus = 'UNAVAILABLE';
                  run.failureCode = health.status;
                  run.publicIp = currentIp;
                  run.message = `🛑 Akses YouTube Dibatasi (${health.status}): IP publik ${currentIp || 'tidak diketahui'} terkonfirmasi dibatasi setelah 3 probe YouTube yang konsisten.\n` +
                    `⚠️ Timeout, CDN error, format video, atau kegagalan pada satu video tidak lagi dihitung sebagai blokir IP.\n` +
                    `💡 Ganti IP/jaringan hanya jika pesan ini benar-benar muncul.`;
                  run.updatedAt = new Date().toISOString();

                  console.error(`[AutoRetry ${jobId}] 🛑 Circuit Breaker: blokir YouTube terkonfirmasi pada IP ${currentIp} (${health.status}).`);
                  updateJobProgress(jobId, {
                    step: 'youtube_ip_rate_limited',
                    sourceStatus: 'UNAVAILABLE',
                    failureCode: health.status,
                    publicIp: currentIp,
                    message: run.message,
                    progress: 100,
                    status: 'error',
                    error: run.message,
                    isAutoRetrying: false,
                    attemptCount: run.attemptCount,
                    actionableAdvice: health.advice || diag.actionableAdvice,
                  });
                  break;
                }
              }
            } else {
              consecutiveIpBlocks = 0;
            }

            // Human-like pacing delay sebelum mencoba kandidat berikutnya (anti-bot behavior)
            const humanJitterMs = 3500 + Math.floor(Math.random() * 3000);
            updateJobProgress(jobId, {
              step: 'auto_retry_next',
              sourceStatus: 'UNAVAILABLE',
              failureCode: diag.failureCode,
              message: `[Kandidat ${diag.failureCode}] ${diag.userFriendlyReason}. Jeda manusia (${(humanJitterMs / 1000).toFixed(1)}s) lalu mencoba kandidat berikutnya...`,
              progress: 10,
              status: 'running',
              isAutoRetrying: true,
              attemptCount: run.attemptCount,
            });
            await new Promise((r) => setTimeout(r, humanJitterMs));
          } else {
            consecutiveIpBlocks = 0;
            // sourceStatus === 'REJECT' (Video berhasil dianalisis frame-nya, tapi ditolak filter AI/lokal)
            updateJobProgress(jobId, {
              step: 'auto_retry_next',
              sourceStatus: 'REJECT',
              failureCode: diag.failureCode,
              message: `[Percobaan ke-${run.attemptCount} Ditolak Filter: ${diag.failureCode}] ${diag.userFriendlyReason.slice(0, 65)}... Mencoba kandidat berikutnya...`,
              progress: 10,
              status: 'running',
              isAutoRetrying: true,
              attemptCount: run.attemptCount,
            });
            await new Promise((r) => setTimeout(r, 2000));
          }
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

