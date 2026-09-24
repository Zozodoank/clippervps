import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { extractFrames } from '../services/frameExtractor.js';
export async function conformExistingJobEditToAudio({
  job,
  silentPath,
  audioPath,
  script,
  onProgress = () => {},
} = {}) {
  const silentDurationSec = (await getMediaDurationSec(silentPath)) || job?.highlight?.duration || 20;
  const audioDurationSec = (await getMediaDurationSec(audioPath)) || silentDurationSec;

  const clips = Array.isArray(job?.highlight?.clips) ? job.highlight.clips : [];
  const firstSourcePath = clips.find(c => c?.videoPath && fs.existsSync(c.videoPath))?.videoPath;
  const rawSourcePath = (job?.downloadedVideoPath && fs.existsSync(job.downloadedVideoPath))
    ? job.downloadedVideoPath
    : firstSourcePath;

  // Old jobs may no longer have source footage. They can still finalize when audio fits;
  // but looping is forbidden, so an oversized voiceover must be regenerated shorter.
  if (!rawSourcePath || clips.length === 0) {
    if (audioDurationSec > silentDurationSec + 0.40) {
      throw new Error(
        `Voiceover ${audioDurationSec.toFixed(1)}s lebih panjang dari video ${silentDurationSec.toFixed(1)}s dan source footage tidak tersedia untuk conform ulang. Regenerate voiceover lebih pendek atau generate ulang Stage 1.`
      );
    }
    return { silentDurationSec, audioDurationSec, conformed: false };
  }

  const fingerprint = job.productFingerprint || buildProductFingerprint({
    title: job.productTitle || '',
    description: job.productDescription || '',
    productInfo: extractCoreProductInfo(job.productTitle || '', job.productDescription || ''),
  });
  const creativePlan = job.creativePlan || buildCreativeShotPlan({
    fingerprint,
    niche: job.niche || (job.productCategory === 'gadget_smartphone' ? 'gadget_smartphone' : 'kitchen_tools'),
  });

  const conformedClips = conformClipsToVoiceover({
    clips,
    script,
    audioDurationSec,
    creativePlan,
  });
  if (!conformedClips.length) {
    return { silentDurationSec, audioDurationSec, conformed: false };
  }

  onProgress({
    step: 'edit_conform',
    message: `Conform ulang visual ke voiceover nyata (${audioDurationSec.toFixed(1)}s), tanpa loop footage...`,
    progress: 45,
    status: 'running',
  });

  const hasBrand = job.hasProductBrand === true || job.highlight?.hasProductBrand === true;
  await renderSilentAntiDetectionVideo({
    inputVideo: rawSourcePath,
    startTime: job.highlight?.startTime,
    endTime: job.highlight?.endTime,
    outputVideo: silentPath,
    clips: conformedClips,
    hflip: hasBrand ? false : Boolean(job.highlight?.allowHflip),
    speedMultiplier: 1,
    reframe: job.highlight?.reframe || { renderMode: 'stage_80' },
    onProgress,
  });

  const finalSilentDurationSec = (await getMediaDurationSec(silentPath)) ||
    conformedClips.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);

  job.highlight = {
    ...(job.highlight || {}),
    clips: conformedClips,
    duration: finalSilentDurationSec,
  };
  job.productFingerprint = fingerprint;
  job.creativePlan = creativePlan;

  return {
    silentDurationSec: finalSilentDurationSec,
    audioDurationSec,
    conformed: true,
  };
}

export async function runProfessionalFinalQcWithRepair({
  jobId,
  finalOutputPath,
  silentVideoPath,
  voiceoverAudioPath,
  srtPath,
  expectedDurationSec,
  productTitle,
  productFingerprint,
  aiProvider,
  apiKey,
  niche = 'kitchen_tools',
  renderSourcePath = '',
  clips = [],
  hflip = false,
  reframe = {},
  backgroundMusicPath = '',
  musicVolume = 0.10,
  sfxEvents = [],
  onProgress = () => {},
} = {}) {
  const finalQcFramesDir = path.join(tempDir, `job_${jobId}`, 'final_qc_frames');
  if (!fs.existsSync(finalQcFramesDir)) fs.mkdirSync(finalQcFramesDir, { recursive: true });

  const evaluate = async () => {
    const technical = await runFinalMasterQc({
      videoPath: finalOutputPath,
      expectedDurationSec,
      subtitlePath: srtPath,
    });

    let visual = {
      passed: true,
      skipped: true,
      reason: 'FINAL_AI_QC disabled',
    };

    if (process.env.FINAL_AI_QC !== 'false' && technical.passed) {
      try {
        const duration = (await getMediaDurationSec(finalOutputPath)) || expectedDurationSec || 20;
        const { frames } = await extractFrames(finalOutputPath, finalQcFramesDir, () => {}, {
          sampleIntervalSec: Math.max(1.2, duration / 8),
          maxSampleFrames: 9,
          duration,
        });

        visual = await verifyFinalRenderedFramesWithAI({
          apiKey,
          aiProvider,
          frames,
          productTitle,
          productFingerprint,
          niche,
          onProgress,
        });
      } catch (err) {
        const strictAiQc = process.env.FINAL_AI_QC_STRICT === 'true';
        console.warn(`[FinalQC] AI visual QC unavailable: ${err.message}. strict=${strictAiQc}`);
        visual = strictAiQc
          ? {
              passed: false,
              reason: `AI Final Visual QC error: ${err.message}`,
              serviceError: true,
            }
          : {
              passed: true,
              skipped: true,
              reason: 'AI Final Visual QC unavailable; technical master QC used as safe fallback.',
              serviceError: true,
            };
      }
    }

    return {
      passed: technical.passed && visual.passed,
      technical,
      visual,
    };
  };

  onProgress({
    step: 'final_master_qc',
    message: 'Final Master QC: teknis + visual composition check...',
    progress: 98,
    status: 'running',
  });

  let report = await evaluate();
  if (report.passed) return report;

  const canRepairCrop =
    report.technical?.passed === true &&
    report.visual?.severeCropIssue === true &&
    renderSourcePath &&
    fs.existsSync(renderSourcePath) &&
    Array.isArray(clips) &&
    clips.length > 0;

  if (canRepairCrop) {
    onProgress({
      step: 'final_auto_repair',
      message: 'Final QC menemukan crop terlalu agresif. Auto-repair ke fit-canvas lalu render ulang...',
      progress: 98,
      status: 'running',
    });

    const repairedClips = clips.map((clip) => ({
      ...clip,
      reframe: {
        ...(clip.reframe || {}),
        renderMode: 'fit_canvas',
        dynamicTracking: false,
      },
    }));

    await renderSilentAntiDetectionVideo({
      inputVideo: renderSourcePath,
      startTime: repairedClips[0]?.startTime,
      endTime: repairedClips[repairedClips.length - 1]?.endTime,
      outputVideo: silentVideoPath,
      clips: repairedClips,
      hflip,
      speedMultiplier: 1,
      reframe: { ...(reframe || {}), renderMode: 'fit_canvas' },
      onProgress,
    });

    const repairedDuration = (await getMediaDurationSec(silentVideoPath)) || expectedDurationSec;
    await mergeVoiceoverAndBurnSubtitles({
      silentVideoPath,
      voiceoverAudioPath,
      srtPath,
      outputVideoPath: finalOutputPath,
      targetDurationSec: repairedDuration,
      backgroundMusicPath,
      musicVolume,
      sfxEvents,
      onProgress,
    });

    report = await evaluate();
    report.autoRepairAttempted = true;
    report.autoRepairMode = 'fit_canvas';
    return report;
  }

  return report;
}

export function syncVideoToAndroidStorage(finalOutputPath, finalFileName, projectName = 'clipper') {
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

async function _processJobVoiceover(jobId, customScript = null, options = {}) {
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

    const conformResult = await conformExistingJobEditToAudio({
      job,
      silentPath,
      audioPath: voiceoverAudioPath,
      script: scriptToUse,
      onProgress: updateProgress,
    });
    const finalSilentDurationSec = conformResult.silentDurationSec;
    const audioDurationSec = conformResult.audioDurationSec;
    const subtitleTargetDuration = audioDurationSec || finalSilentDurationSec;

    updateProgress({ step: 'subtitles', message: `Menyinkronkan subtitle narasi (${finalSilentDurationSec.toFixed(1)}s)...`, progress: 55, status: 'running' });
    generateSrtSubtitles(scriptToUse, subtitleTargetDuration, srtPath, {
      wordBoundaries: ttsResult.wordBoundaries,
      videoDurationSec: finalSilentDurationSec,
      lexicon: effectiveLexicon,
    });

    updateProgress({ step: 'render_final', message: 'Rendering video final 9:16 dengan Voiceover & Subtitles...', progress: 75, status: 'running' });
    await mergeVoiceoverAndBurnSubtitles({
      silentVideoPath: silentPath,
      voiceoverAudioPath,
      srtPath,
      outputVideoPath: finalOutputPath,
      targetDurationSec: finalSilentDurationSec,
      backgroundMusicPath: options.backgroundMusicPath || process.env.BACKGROUND_MUSIC_PATH || '',
      musicVolume: Number(options.musicVolume || process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
      onProgress: updateProgress,
    });

    const retryRenderSource = (job.downloadedVideoPath && fs.existsSync(job.downloadedVideoPath))
      ? job.downloadedVideoPath
      : job.highlight?.clips?.find(c => c?.videoPath && fs.existsSync(c.videoPath))?.videoPath;

    const finalQc = await runProfessionalFinalQcWithRepair({
      jobId,
      finalOutputPath,
      silentVideoPath: silentPath,
      voiceoverAudioPath,
      srtPath,
      expectedDurationSec: finalSilentDurationSec,
      productTitle: job.productTitle || '',
      productFingerprint: job.productFingerprint || null,
      aiProvider: job.aiProvider,
      apiKey: options.geminiApiKey,
      niche: job.niche || 'kitchen_tools',
      renderSourcePath: retryRenderSource || '',
      clips: job.highlight?.clips || [],
      hflip: job.hasProductBrand ? false : Boolean(job.highlight?.allowHflip),
      reframe: job.highlight?.reframe || {},
      backgroundMusicPath: options.backgroundMusicPath || process.env.BACKGROUND_MUSIC_PATH || '',
      musicVolume: Number(options.musicVolume || process.env.BACKGROUND_MUSIC_VOLUME || 0.10),
      onProgress: updateProgress,
    });
    if (!finalQc.passed) {
      try { fs.unlinkSync(finalOutputPath); } catch {}
      throw new Error(`FINAL_MASTER_QC_FAILED: ${[
        ...(finalQc.technical?.issues || []),
        ...(finalQc.visual?.reason ? [finalQc.visual.reason] : []),
      ].join(', ')}`);
    }

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
      finalQc,
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

export function processJobVoiceover(jobId, customScript, options) {
  return heavyTaskQueue(() => _processJobVoiceover(jobId, customScript, options));
}

