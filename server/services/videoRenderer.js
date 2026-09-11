import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getFFmpegPath } from './binaryChecker.js';
import { scaleAssSubtitles } from './subtitleService.js';

/**
 * Stage 1: Renders Gemini-selected 5-second product clips as one vertical 9:16 video
 * with NO AUDIO (-an) and NO SUBTITLES.
 * @param {object} params
 * @param {string} params.inputVideo - Source raw video path
 * @param {string} params.startTime - Trim start (e.g. "00:15")
 * @param {string} params.endTime - Trim end (e.g. "00:55")
 * @param {string} params.outputVideo - Target output .mp4 path
 * @param {Array<{ startTime?: string, endTime?: string, startSeconds?: number, endSeconds?: number, reframe?: object }>} [params.clips] - Gemini cut plan
 * @param {boolean} [params.hflip=false] - Horizontal flip toggle
 * @param {number} [params.speedMultiplier=1] - Speed factor
 * @param {{ focusX?: number, focusY?: number, faceSafety?: boolean, renderMode?: string }} [params.reframe] - Product-aware framing
 * @param {Function} [params.onProgress] - Progress callback
 * @returns {Promise<{ outputPath: string }>}
 */
export async function renderSilentAntiDetectionVideo({
  inputVideo,
  startTime,
  endTime,
  outputVideo,
  clips = [],
  hflip = false,
  speedMultiplier = 1,
  reframe = {},
  onProgress = () => {}
}) {
  const ffmpegPath = getFFmpegPath();
  const outDir = path.dirname(outputVideo);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let targetVideo = inputVideo;
  const isAudioFile = ['.m4a', '.mp3', '.aac', '.wav', '.opus'].some(ext => inputVideo.toLowerCase().endsWith(ext));
  if (isAudioFile || !fs.existsSync(inputVideo)) {
    const parentDir = path.dirname(inputVideo);
    if (fs.existsSync(parentDir)) {
      const candidates = fs.readdirSync(parentDir).filter(f =>
        (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv') || f.endsWith('.mov')) &&
        !f.startsWith('silent_') && !f.startsWith('final_')
      );
      if (candidates.length > 0) {
        targetVideo = path.join(parentDir, candidates[0]);
      }
    }
  }

  const dims = await getVideoDimensions(targetVideo, ffmpegPath);
  const isSourceVertical = Boolean(dims && dims.height > dims.width);

  onProgress({
    step: 'render_silent',
    message: isSourceVertical
      ? 'Rendering Smart Stage 80% product shots (Muted, No Subtitles, Top/Bottom Blur)...'
      : 'Rendering Smart Stage 80% product shots (Muted, No Subtitles, Top/Bottom Blur)...',
    progress: 60
  });

  return new Promise(async (resolve, reject) => {
    try {
      const selectedClips = normalizeRenderClips(clips, startTime, endTime, reframe);
      const safeSpeedMultiplier = clampNumber(speedMultiplier, 0.5, 2, 1);
      const ptsFactor = (1 / safeSpeedMultiplier).toFixed(4);
      const args = ['-y'];

      // Cache orientasi video untuk setiap file video sumber yang berbeda
      const videoDimsMap = new Map();
      for (const clip of selectedClips) {
        const clipVideo = clip.videoPath || targetVideo;
        if (!videoDimsMap.has(clipVideo)) {
          const d = await getVideoDimensions(clipVideo, ffmpegPath);
          videoDimsMap.set(clipVideo, Boolean(d && d.height > d.width));
        }
      }

      for (const clip of selectedClips) {
        const sourceDuration = (clip.duration * safeSpeedMultiplier).toFixed(3);
        const clipVideo = clip.videoPath || targetVideo;
        args.push('-ss', clip.startSeconds.toFixed(3), '-t', sourceDuration, '-i', clipVideo);
      }

      const filterChains = selectedClips.flatMap((clip, index) => {
        const clipVideo = clip.videoPath || targetVideo;
        const isClipVertical = videoDimsMap.get(clipVideo) || false;
        return buildClipFilter({
          inputIndex: index,
          outputLabel: `v${index}`,
          reframe: clip.reframe,
          hflip,
          ptsFactor,
          isSourceVertical: isClipVertical,
        });
      });

      if (selectedClips.length === 1) {
        filterChains.push('[v0]null[outv]');
      } else {
        filterChains.push(`${selectedClips.map((_, index) => `[v${index}]`).join('')}concat=n=${selectedClips.length}:v=1:a=0[outv]`);
      }

      args.push(
        '-filter_complex', filterChains.join(';'),
        '-map', '[outv]',
        '-an', // Strictly NO AUDIO
        '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-b:v', '8000k',
      '-maxrate', '12000k',
      '-bufsize', '16000k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputVideo
    );

    console.log(`[VideoRenderer Silent] Spawning FFmpeg:\n${ffmpegPath} ${args.join(' ')}`);
    const proc = spawn(ffmpegPath, args);
    let stderr = '';

    proc.stderr.on('data', (d) => stderr += d.toString());

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputVideo)) {
        onProgress({
          step: 'render_silent',
          message: 'Silent 9:16 video rendered successfully!',
          progress: 70
        });
        resolve({ outputPath: outputVideo });
      } else {
        console.error(`[VideoRenderer Silent] Error:\n${stderr}`);
        reject(new Error(`FFmpeg silent render failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg for silent render: ${err.message}`));
    });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Stage 2: Merges generated voiceover audio with the silent 9:16 video,
 * trims/loops video if needed to match audio, and burns ASS subtitles with animated highlight effect.
 * @param {object} params
 * @param {string} params.silentVideoPath - Input silent video from Stage 1
 * @param {string} params.voiceoverAudioPath - Generated TTS voiceover .mp3
 * @param {string} [params.srtPath] - Optional SRT subtitle file
 * @param {string} params.outputVideoPath - Target final .mp4 path
 * @param {number} [params.targetDurationSec] - Target duration in seconds
 * @param {Function} [params.onProgress] - Progress callback
 * @returns {Promise<{ finalPath: string }>}
 */
export async function mergeVoiceoverAndBurnSubtitles({
  silentVideoPath,
  voiceoverAudioPath,
  srtPath,
  outputVideoPath,
  targetDurationSec,
  onProgress = () => {}
}) {
  const ffmpegPath = getFFmpegPath();
  const outDir = path.dirname(outputVideoPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const videoDuration = await getMediaDurationSec(silentVideoPath, ffmpegPath) || Number(targetDurationSec) || 45;
  const audioDuration = await getMediaDurationSec(voiceoverAudioPath, ffmpegPath);

  // Speed-up voiceover if audio duration exceeds video duration
  let atempoFactor = 1.0;
  if (audioDuration && videoDuration && audioDuration > videoDuration + 0.3) {
    atempoFactor = Math.min(1.25, Math.max(1.0, audioDuration / videoDuration));
  }

  // If audio is sped up via atempo, rescale ASS subtitle timestamps to match 100%
  // and keep the final CTA subtitle pinned to the exact video duration!
  if (srtPath && fs.existsSync(srtPath) && atempoFactor > 1.005) {
    scaleAssSubtitles(srtPath, 1 / atempoFactor, videoDuration);
  }

  onProgress({
    step: 'merge_final',
    message: srtPath
      ? 'Burning dual-color animated subtitles & merging Voiceover AI...'
      : 'Merging Voiceover AI into final video...',
    progress: 92
  });

  return new Promise((resolve, reject) => {
    let filterChains = [];
    let mapArgs = [];

    // Subtitle burning filter
    if (srtPath && fs.existsSync(srtPath)) {
      const sanitizedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const isAss = sanitizedSrtPath.endsWith('.ass');
      // For native ASS files, use ass= to retain full 2-tone styling and MarginV=380 safe zone.
      const subFilter = isAss
        ? `ass='${sanitizedSrtPath}'`
        : `subtitles='${sanitizedSrtPath}':force_style='Fontname=Arial,Fontsize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=3,Shadow=1.5,MarginV=120,Alignment=2,Bold=1'`;
      filterChains.push(`[0:v]${subFilter}[vsub]`);
      mapArgs.push('-map', '[vsub]');
    } else {
      mapArgs.push('-map', '0:v');
    }

    // Audio filter: atempo if needed + normalize audio
    if (atempoFactor > 1.02) {
      const atempoFilters = buildAtempoFilters(atempoFactor);
      filterChains.push(`[1:a]${atempoFilters.join(',')},volume=1.05[aout]`);
      mapArgs.push('-map', '[aout]');
    } else {
      mapArgs.push('-map', '1:a');
    }

    const args = [
      '-y',
      '-i', silentVideoPath,
      '-i', voiceoverAudioPath,
      '-filter_complex', filterChains.join(';'),
      ...mapArgs,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-t', videoDuration.toFixed(3),
      '-movflags', '+faststart',
      outputVideoPath
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputVideoPath)) {
        onProgress({ step: 'merge_final', message: 'Final video rendered successfully!', progress: 100 });
        resolve({ finalPath: outputVideoPath });
      } else {
        reject(new Error(`Final merge failed: ${stderr.slice(-300)}`));
      }
    });
  });
}

function buildClipFilter({ inputIndex, outputLabel, reframe = {}, hflip, ptsFactor, isSourceVertical = false }) {
  const isFlipDisabled = reframe.allowHflip === false || reframe.hasProductBrand === true;
  const clipHflip = isFlipDisabled ? false : (reframe.hflip !== undefined ? reframe.hflip : hflip);
  const rawMode = reframe.renderMode;
  const validModes = ['stage_80', 'square_stage', 'fit_canvas', 'vertical_crop'];
  const renderMode = validModes.includes(rawMode) ? rawMode : 'stage_80';
  const preFlip = clipHflip ? 'hflip,' : '';
  const finish = `setsar=1,setpts=${ptsFactor}*PTS,eq=contrast=1.05:saturation=1.05:brightness=0.01,unsharp=5:5:0.8:5:5:0.0`;

  // 1. Explicit Full 9:16 Crop (Tanpa Blur) - only if user specifically requested 'vertical_crop'
  if (renderMode === 'vertical_crop') {
    const focusX = clampNumber(reframe.focusX, 0, 1, 0.5).toFixed(3);
    const focusY = clampNumber(reframe.focusY, 0, 1, 0.55).toFixed(3);
    return [
      `[${inputIndex}:v]${preFlip}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920:(iw-1080)*${focusX}:(ih-1920)*${focusY},${finish}[${outputLabel}]`
    ];
  }

  // 2. Fit 16:9 Utuh (0% Crop over 9:16 blurred background)
  if (renderMode === 'fit_canvas') {
    return [
      `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
      `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
      `[fgsrc${inputIndex}]scale=1080:-2:flags=lanczos,setsar=1[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
    ];
  }

  // 3. Smart Stage 1:1 Square (1080x1080 over 9:16 blurred background)
  if (renderMode === 'square_stage') {
    const focusX = clampNumber(reframe.focusX, 0, 1, 0.5).toFixed(3);
    const focusY = clampNumber(reframe.focusY, 0, 1, 0.55).toFixed(3);
    return [
      `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
      `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
      `[fgsrc${inputIndex}]scale=1080:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1080:(iw-1080)*${focusX}:(ih-1080)*${focusY},setsar=1[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
    ];
  }

  // 4. Default & Recommended: Smart Stage 80% (1080x1536) dengan Blur Atas-Bawah
  // - Tinggi video 1536px (tepat 80% dari kanvas 1920px).
  // - Bagian atas blur 192px & bagian bawah blur 192px.
  // - Untuk video vertikal (Shorts/Reels): fokus diarahkan ke bawah (default focusY=0.75)
  //   sehingga watermark/logo kreator di sudut atas (misal 'RONALD') terpotong bersih.
  // - Untuk video landscape: crop diperluas dan tidak terlalu zoom.
  const focusX = clampNumber(reframe.focusX, 0, 1, 0.5).toFixed(3);
  const defaultFocusY = isSourceVertical ? 0.75 : 0.55;
  const focusY = clampNumber(reframe.focusY, 0, 1, defaultFocusY).toFixed(3);

  return [
    `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
    `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
    `[fgsrc${inputIndex}]scale=1080:1536:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1536:(iw-1080)*${focusX}:(ih-1536)*${focusY},setsar=1[fg${inputIndex}]`,
    `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
  ];
}

export function normalizeRenderClips(clips, fallbackStartTime, fallbackEndTime, fallbackReframe = {}) {
  const defaultClipLength = 3.3;
  const sourceClips = Array.isArray(clips) ? clips : [];
  const normalized = [];

  if (sourceClips.length) {
    for (const clip of sourceClips) {
      const startSeconds = parseTimeToSeconds(clip?.startSeconds ?? clip?.startTime);
      const endSeconds = parseTimeToSeconds(clip?.endSeconds ?? clip?.endTime);
      if (!Number.isFinite(startSeconds) || startSeconds < 0) continue;

      const clipDuration = Number(clip?.duration) || (Number.isFinite(endSeconds) && endSeconds > startSeconds ? (endSeconds - startSeconds) : defaultClipLength);
      if (clipDuration < 1.5) continue;

      const effectiveRenderMode = fallbackReframe?.renderMode || clip?.reframe?.renderMode || 'stage_80';

      normalized.push({
        startSeconds,
        duration: clipDuration,
        videoPath: clip?.videoPath || clip?.sourceVideo || null,
        candidateIndex: clip?.candidateIndex !== undefined ? clip.candidateIndex : null,
        reframe: {
          renderMode: effectiveRenderMode,
          ...(clip?.reframe || {}),
          ...(fallbackReframe?.renderMode ? { renderMode: fallbackReframe.renderMode } : {}),
          allowHflip: clip?.allowHflip !== undefined ? clip.allowHflip : clip?.reframe?.allowHflip,
          hasProductBrand: clip?.hasProductBrand !== undefined ? clip.hasProductBrand : clip?.reframe?.hasProductBrand,
        },
      });
      if (normalized.length === 8) break; // Max 8 clips (support up to ~26s)
    }
  }

  if (normalized.length) {
    // Safety Duration Guard: Pastikan durasi total klip yang dirender minimal 18-22s (minimal 6 klip)
    // agar sinkron dengan durasi naskah Voiceover dan standar optimal video promosi Affiliate.
    if (normalized.length < 6) {
      console.log(`[normalizeRenderClips] Total klip saat ini ${normalized.length} (${normalized.reduce((acc, c) => acc + c.duration, 0).toFixed(1)}s). Menjalankan Safety Duration Guard menuju minimal 18-22s...`);
      const baseClips = [...normalized];
      let cycleIdx = 0;
      while (normalized.length < 6 && normalized.reduce((acc, c) => acc + c.duration, 0) < 20) {
        const src = baseClips[cycleIdx % baseClips.length];
        const canHflip = !src.reframe?.hasProductBrand && src.reframe?.allowHflip !== false;
        normalized.push({
          ...src,
          reframe: {
            ...src.reframe,
            allowHflip: canHflip ? (cycleIdx % 2 === 0 ? false : true) : false,
          },
        });
        cycleIdx++;
      }
    }
    return normalized;
  }

  const fallbackStart = parseTimeToSeconds(fallbackStartTime);
  const fallbackEnd = parseTimeToSeconds(fallbackEndTime);
  const clipLength = defaultClipLength;
  const fallbackDuration = fallbackEnd > fallbackStart ? fallbackEnd - fallbackStart : (clipLength * 7);
  const clipCount = Math.max(5, Math.min(8, Math.floor(fallbackDuration / clipLength)));

  for (let index = 0; index < clipCount; index++) {
    normalized.push({
      startSeconds: fallbackStart + (index * clipLength),
      duration: clipLength,
      reframe: fallbackReframe,
    });
  }

  return normalized;
}

function parseTimeToSeconds(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const parts = value.toString().split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function buildAudioFitFilter(atempoFactor, targetDurationSec) {
  return [
    ...buildAtempoFilters(atempoFactor),
    'apad',
    `atrim=0:${targetDurationSec.toFixed(3)}`,
    'asetpts=N/SR/TB',
  ].join(',');
}

function buildAtempoFilters(factor) {
  let remaining = Number.isFinite(factor) ? factor : 1;
  if (Math.abs(remaining - 1) < 0.01) return [];

  const filters = [];
  while (remaining > 2) {
    filters.push('atempo=2.0000');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5000');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) >= 0.01) {
    filters.push(`atempo=${remaining.toFixed(4)}`);
  }
  return filters;
}

export function getMediaDurationSec(filePath, ffmpegPath = getFFmpegPath()) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return resolve(null);
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      resolve((hours * 3600) + (minutes * 60) + seconds);
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Inspects a video file using FFmpeg to determine its exact resolution and whether it meets minimal 1080p Full HD.
 * @param {string} filePath - Path to video file
 * @param {string} [ffmpegPath]
 * @returns {Promise<{ width: number, height: number, is1080pOrHigher: boolean } | null>}
 */
export function getVideoDimensions(filePath, ffmpegPath = getFFmpegPath()) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve(null);
    }
    const proc = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', () => {
      const match = stderr.match(/Stream #\d+:\d+.*Video:.*?,\s*(\d{3,5})x(\d{3,5})/s);
      if (!match) return resolve(null);
      const width = Number(match[1]);
      const height = Number(match[2]);

      // True 1080p Full HD:
      // Landscape 16:9 (1920x1080) -> width=1920, height=1080
      // Vertical 9:16 Shorts (1080x1920) -> width=1080, height=1920
      // In both cases, the minimum dimension is >= 1080 and maximum is >= 1920
      const is1080pOrHigher = (width >= 1080 && height >= 1080) ||
                              width >= 1920 ||
                              height >= 1920 ||
                              Math.min(width, height) >= 1080;

      resolve({ width, height, is1080pOrHigher });
    });
    proc.on('error', () => resolve(null));
  });
}

function mergeAudioOnlyFallback({
  ffmpegPath,
  silentVideoPath,
  voiceoverAudioPath,
  outputVideoPath,
  videoDuration,
  atempoFactor,
  onProgress,
  resolve,
  reject
}) {
  const audioFilter = buildAudioFitFilter(atempoFactor, videoDuration);
  const args = [
    '-y',
    '-i', silentVideoPath,
    '-i', voiceoverAudioPath,
    '-filter_complex', `[1:a]${audioFilter}[a]`,
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', videoDuration.toFixed(3),
    '-movflags', '+faststart',
    outputVideoPath
  ];

  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', code => {
    if (code === 0 && fs.existsSync(outputVideoPath)) {
      onProgress({ step: 'merge_final', message: 'Final video merged successfully (fallback mode).', progress: 100 });
      resolve({ finalPath: outputVideoPath });
    } else {
      reject(new Error(`Final fallback merge failed: ${stderr.slice(-300)}`));
    }
  });
}
