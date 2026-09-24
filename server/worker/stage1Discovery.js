import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId, isLocalPortListening } from '../services/downloader.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAutoStage1Worker(run) {
  try {
    const isUnlimited = run.maxJobs === 'unlimited' || run.maxJobs === Infinity || !run.maxJobs;
    updateAutoRun(run, {
      status: 'running',
      message: isUnlimited ? 'Memulai pipeline Auto Mode (Unlimited)...' : 'Memulai pencarian produk viral Shopee...',
      progress: 5,
    });

    const seenShopeeUrls = new Set();
    const usedYouTubeVideoIds = getAllUsedYouTubeVideoIds();
    let emptyKeywordRetryCount = 0;
    let quotaExhausted = false;
    let quotaErrorMessage = '';

    while (run.status !== 'stopping' && run.status !== 'stopped') {
      const dailyStats = getDailyOutputVideoStats();
      if (dailyStats.isLimitReached) {
        console.log(`[Auto] 🛑 Batas harian ${dailyStats.limit} video telah tercapai (${dailyStats.count}/${dailyStats.limit} video hari ini). Auto Mode dihentikan untuk mencegah pemblokiran IP.`);
        updateAutoRun(run, {
          status: 'completed',
          message: `🛑 Batas harian ${dailyStats.limit} video telah tercapai (${dailyStats.count}/${dailyStats.limit} video hari ini). Auto Mode dihentikan untuk mencegah pemblokiran IP. Silakan lanjutkan besok.`,
          progress: 100,
          finishedAt: new Date().toISOString(),
          currentJobId: null,
          currentProductTitle: null,
          dailyStats,
        });
        break;
      }

      if (run.status === 'stopping' || run.status === 'stopped') {
        break;
      }

      if (!isUnlimited && run.successfulJobs >= run.maxJobs) {
        break;
      }

      // ── DIRECT BRANDED PRODUCT DISCOVERY ──
      // AutoRun does not consume DEFAULT_AUTO_KEYWORDS or OEM/generic generators.
      // It searches marketplace results for branded listings directly.
      const shopeeCandidate = await discoverBrandedShopeeProduct({
        niche: run.niche,
        seen: seenShopeeUrls,
      });

      if (!shopeeCandidate) {
        emptyKeywordRetryCount++;
        updateAutoRun(run, {
          message: `[Auto] Belum menemukan produk bermerek untuk niche "${run.niche}". Percobaan ${emptyKeywordRetryCount}/3...`,
        });
        if (emptyKeywordRetryCount >= 3) {
          console.log('[Auto] Tidak ada produk bermerek yang ditemukan setelah 3 percobaan.');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
        continue;
      }
      emptyKeywordRetryCount = 0;

      const keyword = shopeeCandidate.keyword || `${shopeeCandidate.brand} ${shopeeCandidate.productType}`;
      if (!shopeeCandidate || !shopeeCandidate.title || !shopeeCandidate.url) {
        run.skippedProducts++;
        updateAutoRun(run, { message: `[Auto] Skip "${keyword}": listing produk nyata tidak ditemukan.` });
        continue;
      }

      // discoverSingleShopeeProduct already enforced the branded-product gate
      // and returns the verified identity extracted from the listing metadata.
      const brand = String(shopeeCandidate.brand || '').trim();
      const productType = String(shopeeCandidate.productType || '').trim();
      const model = String(shopeeCandidate.model || '').trim();
      const searchQueries = Array.isArray(shopeeCandidate.searchQueries)
        ? shopeeCandidate.searchQueries
        : [];
      
      // Auto Mode requires a real brand + product type. OEM/unbranded products
      // never reach the video-search stage; OEM is supported only by manual URLs.
      if (
        !shopeeCandidate.brandedVerified ||
        !brand ||
        !productType ||
        productType === 'Produk Praktis' ||
        searchQueries.length === 0
      ) {
        run.skippedProducts++;
        updateAutoRun(run, {
          message: `[Auto] Skip "${shopeeCandidate.title.slice(0, 45)}": listing tidak memiliki brand + type yang terverifikasi.`,
        });
        continue;
      }

      const searchKeyword = searchQueries[0];
      if (
        !searchKeyword ||
        !normalizeText(searchKeyword).includes(normalizeText(brand)) ||
        !normalizeText(searchKeyword).includes(normalizeText(productType).split(' ')[0])
      ) {
        run.skippedProducts++;
        updateAutoRun(run, {
          message: `[Auto] Skip "${shopeeCandidate.title.slice(0, 45)}": query brand + type tidak valid.`,
        });
        continue;
      }

      // ── DEDUPLIKASI PRODUK HARIAN (BRAND + PRODUCT TYPE) ──
      // Menggunakan kombinasi brand + type agar merk berbeda untuk tipe produk yang sama
      // (misal: Gaabor Air Fryer, Simplus Air Fryer, Deerma Vacuum) tetap dapat diproses hari ini.
      const brandNounCombo = brand && productType
        ? `${brand.toLowerCase()} ${productType.toLowerCase()}`.trim()
        : productType.toLowerCase().trim();
      const usedBrandProducts = getAllUsedBrandProductPairsToday();
      if (brandNounCombo && usedBrandProducts.has(brandNounCombo)) {
        console.log(`[Auto] Skip "${shopeeCandidate.title}": Kombinasi brand + produk sejenis ("${brandNounCombo}") sudah pernah dibuat hari ini.`);
        continue;
      }

      const currentTargetIndex = run.successfulJobs + 1;
      const targetLabel = isUnlimited ? `Hari ini: ${dailyStats.count}/${dailyStats.limit} video` : `${currentTargetIndex}/${run.maxJobs} (Hari ini: ${dailyStats.count}/${dailyStats.limit})`;

      updateAutoRun(run, {
        message: `[${targetLabel}] Cari video: "${searchKeyword}" (brand/type)...`,
        progress: isUnlimited ? 10 : Math.min(95, Math.round((run.successfulJobs / run.maxJobs) * 100) + 2),
      });

      // ── STRATEGI VIDEO-FIRST: identity-only search ──
      let candidates = await searchMultiEngineVideos(searchKeyword, {
        limit: 16,
        excludeVideoIds: usedYouTubeVideoIds,
        strictIdentity: true,
        youtubeOnly: true,
        onProgress: (p) => updateAutoRun(run, { message: `[${targetLabel}] ${p.message}` }),
      });

      // AutoRun uses direct YouTube search only. No marketplace image/reverse-search fallback. 

      if (!candidates || candidates.length === 0) {
        run.skippedProducts++;
        updateAutoRun(run, { message: `[${targetLabel}] Skip "${keyword}": Tidak ada video kandidat baru yang cocok.` });
        continue;
      }

      let jobSuccess = false;
      if (run.status === 'stopping' || run.status === 'stopped') break;

      const autoJobId = `auto_${crypto.randomBytes(5).toString('hex')}`;
      run.currentJobId = autoJobId;
      const currentCandidateTitle = shopeeCandidate.title || candidates[0]?.title || searchKeyword;

      for (const cand of candidates) {
        const candidateVid = extractVideoId(cand.url) || cand.id;
        if (candidateVid) usedYouTubeVideoIds.add(candidateVid);
      }

      try {
        updateAutoRun(run, {
          currentProductTitle: currentCandidateTitle,
          message: `[${targetLabel}] Multi-Video Stream (3-5 video) untuk "${currentCandidateTitle.slice(0, 30)}..."...`,
          progress: isUnlimited ? 25 : Math.min(95, Math.round((run.successfulJobs / run.maxJobs) * 100) + 5),
        });

        const candidateShopeeLink = shopeeCandidate.url || buildShopeeSearchUrl(currentCandidateTitle, brand);
        const completedResult = await runStage1Pipeline({
          jobId: autoJobId,
          youtubeUrl: null, // Mode Multi-Video Harvesting!
          targetCandidates: candidates,
          shopeeLink: candidateShopeeLink || '',
          productTitle: currentCandidateTitle,
          productDescription: shopeeCandidate.description || candidates[0]?.description || '',
          apiKey: undefined,
          options: {
            ...run.options,
            niche: run.niche || 'kitchen_tools',
            aiProvider: run.options?.aiProvider || (process.env.ACTIVE_AI_ENGINE === 'gemini' ? 'gemini' : 'openrouter'),
            autoSearchFallback: true,
            multiVideoHarvesting: true,
            isVideoFirst: true,
            sceneDuration: 3.3,
            minDuration: 30.0,
          },
          extraJobMeta: { autoRunId: run.runId, isAutoGenerated: true, isVideoFirst: true, searchKeyword, sourceKeyword: keyword, brand, model, productType },
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

        const finalItemTitle = (completedResult?.detectedProduct || '').trim() || completedResult?.productTitle || currentCandidateTitle;
        run.successfulJobs++;
        jobSuccess = true;
        markKeywordAsUsed(keyword, { productTitle: finalItemTitle, jobId: autoJobId, source: 'auto_worker' });
        
        const dailyStatsAfter = getDailyOutputVideoStats();
        console.log(`[Auto] ✅ Job ${autoJobId} benar-benar berhasil ("${finalItemTitle}"). Menghentikan Auto Mode (hanya 1 job per generate autorun agar aman).`);
        updateAutoRun(run, {
          status: 'completed',
          message: `✅ Auto Mode selesai: 1 video berhasil di-generate secara aman ("${finalItemTitle.slice(0, 35)}...").`,
          progress: 100,
          finishedAt: new Date().toISOString(),
          currentJobId: null,
          currentProductTitle: null,
          dailyStats: dailyStatsAfter,
        });
        break;
      } catch (err) {
        console.warn(`[Auto] Multi-video harvesting failed for ${keyword}:`, err.message);
        
        const msg = (err.message || '').toLowerCase();
        const isMasterQcFailed = msg.includes('final_master_qc_failed');

        // 1. YouTube IP Block / Bot Detection / HTTP 429
        const isYouTubeBotBlock = (
          msg.includes('youtube membatasi') ||
          msg.includes('memblokir ip') ||
          msg.includes('bot detection') ||
          (msg.includes('youtube') && (msg.includes('429') || msg.includes('too many requests') || msg.includes('sign in to confirm')))
        );

        // 2. YouTube Cookies / Authentication Error
        const isYouTubeAuthError = msg.includes('from-browser') || msg.includes('--cookies') ||
          msg.includes('cookies for the authentication') || msg.includes('login required') || msg.includes('private video') ||
          (msg.includes('yt-dlp') && msg.includes('authentication'));

        // 3. Limit Kuota Model Gemini AI (Visual atau TTS)
        const isYouTubeError = isYouTubeBotBlock || isYouTubeAuthError || msg.includes('youtube') || msg.includes('yt-dlp');
        const isQuota = !isYouTubeError && Boolean(
          err.isAllModelsQuotaExhausted ||
          err.isQuotaError ||
          isQuotaErrorMessage(err.message) ||
          msg.includes('resource_exhausted') ||
          (msg.includes('quota') && !msg.includes('disk')) ||
          (msg.includes('kuota') && !msg.includes('lokal')) ||
          msg.includes('rate_limit') ||
          (msg.includes('rate limit') && msg.includes('gemini')) ||
          ((err.status === 429 || err.statusCode === 429) && !isYouTubeError) ||
          (msg.includes('gemini') && (msg.includes('limit') || msg.includes('exhausted') || msg.includes('too many requests')))
        );

        // Hapus file temporary dan hapus job dari riwayat JIKA:
        // - Tidak ada media yang berhasil di-download
        // - ATAU Gagal Final QC (berarti video kotor/watermark, tidak layak disimpan!)
        const existingJob = activeJobs.get(autoJobId);
        const hasSavedMedia = existingJob && (existingJob.finalLocalPath || existingJob.silentLocalPath || existingJob.downloadedVideoPath);
        
        if (!hasSavedMedia || isMasterQcFailed) {
          deleteJobFiles(autoJobId, outputDir, tempDir);
          activeJobs.delete(autoJobId);
          deletePersistedJob(autoJobId);
        } else {
          console.log(`[Auto] ⚠️ Video mentah/bisu tersimpan untuk Job ${autoJobId} (Terkendala TTS/AI). Job dipertahankan di riwayat.`);
        }

        run.failures.push({ productTitle: currentCandidateTitle, error: err.message, time: new Date().toISOString() });

        // Evaluasi apakah harus berhenti total atau lanjut mencari video lain (Self-Healing)
        if (isYouTubeBotBlock) {
          console.error(`[Auto] 🛑 YouTube memblokir/membatasi IP server (HTTP 429 / Bot Detection). Menghentikan Auto Mode.`);
          updateAutoRun(run, {
            status: 'stopped',
            message: `⚠️ Auto Mode berhenti otomatis: YouTube memblokir IP server (HTTP 429 / Bot Detection). Solusi: Ganti IP proxy / aktifkan Mode Pesawat HP atau perbarui cookies.txt. (Berhasil: ${run.successfulJobs}, Gagal: ${run.failedJobs}).`,
            progress: 100,
            finishedAt: new Date().toISOString(),
            currentJobId: null,
            currentProductTitle: null,
          });
          return;
        }

        if (isYouTubeAuthError) {
          const isProxyActive = isLocalPortListening(10808) || Boolean(process.env.PROXY_URL || process.env.RESIDENTIAL_PROXY);
          const isCookiesDisabled = process.env.DISABLE_COOKIES === 'true' || process.env.NO_COOKIES === 'true';

          if (isProxyActive || isCookiesDisabled) {
            console.warn(`[Auto] ⚠️ Video ini membutuhkan login / autentikasi. Melewati produk ini dan lanjut ke antrean berikutnya (Mode Proxy 10808 / Tanpa Cookies aktif).`);
          } else {
            console.error('[Auto] ❌ YouTube membutuhkan autentikasi (cookies). Auto Mode dihentikan.');
            updateAutoRun(run, {
              status: 'stopped',
              message: '⚠️ Auto Mode berhenti: YouTube membutuhkan cookies autentikasi. Solusi: Hubungkan SSH Reverse Proxy Termux (port 10808) atau upload cookies.txt.',
              progress: 100,
              finishedAt: new Date().toISOString(),
              currentJobId: null,
              currentProductTitle: null,
            });
            return;
          }
        }

        if (isQuota) {
          console.error(`[Auto] 🛑 Limit kuota/rate limit Gemini (Visual atau TTS) telah habis: ${err.message}. Menghentikan Auto Mode.`);
          quotaExhausted = true;
          quotaErrorMessage = err.message;
          break;
        }

        const isFatalAuth = (err.status === 401 || err.statusCode === 401) && (msg.includes('api key') || msg.includes('unauthorized'));
        if (isFatalAuth) {
          console.error('[Auto] API Key tidak valid. Menghentikan Auto Mode.');
          throw err;
        }
      }

      if (quotaExhausted) {
        break;
      }

      if (!jobSuccess) {
        run.failedJobs++;
        console.warn(`[Auto] 🛑 Job untuk "${searchKeyword}" gagal diproses (misal: karena tertolak Final QC akibat watermark). Auto Mode melakukan "Self-Healing": melompati video ini dan lanjut mencari video bersih berikutnya.`);
        
        if (run.currentJobId) {
          deleteJobTempDirectory(run.currentJobId, tempDir);
        }

        updateAutoRun(run, {
          message: `⚠️ Job sebelumnya gagal (terkena AI Filter/Kotor). Melanjutkan ke pencarian video bersih berikutnya...`,
        });
        continue;
      }

      // If user stopped auto mode, break immediately after current job finishes!
      if (run.status === 'stopping' || run.status === 'stopped') {
        break;
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
        message: `⚠️ Auto Mode berhenti otomatis: Limit kuota/rate limit model Gemini (Visual atau TTS) telah habis (${quotaErrorMessage || 'Batas kuota harian tercapai'}). Total video berhasil dibuat: ${run.successfulJobs}, Gagal: ${run.failedJobs}, Dilewati: ${run.skippedProducts}.`,
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

