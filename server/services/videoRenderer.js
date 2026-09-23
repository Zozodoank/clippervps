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

      // Multi-source render safety: never substitute the first input video when a clip's
      // own source path is missing. That fallback can turn a correct A/B/A/B storyboard
      // into A/A/A/A at the final FFmpeg stage.
      const renderSourceIds = new Set(
        selectedClips
          .map(c => c?.candidateIndex)
          .filter(v => v !== null && v !== undefined)
      );
      if (renderSourceIds.size >= 2 && selectedClips.some(c => !c.videoPath)) {
        throw new Error('Render dibatalkan: ada klip multi-source tanpa videoPath sumber. Mencegah pengulangan video pertama.');
      }
      if (renderSourceIds.size >= 2 && selectedClips.length < 2) {
        throw new Error('Render dibatalkan: storyboard multi-source kehilangan klip unik.');
      }

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
        // Trim lebih rapi: hindari error keyframe dengan format time yang tepat
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
          clipDuration: clip.duration,
        });
      });

      if (selectedClips.length === 1) {
        filterChains.push('[v0]null[outv]');
      } else {
        filterChains.push(`${selectedClips.map((_, index) => `[v${index}]`).join('')}concat=n=${selectedClips.length}:v=1:a=0[outv]`);
      }

      const totalSilentDuration = selectedClips.reduce((sum, c) => sum + (Number(c.duration) || 4.8), 0);

      args.push(
        '-filter_complex', filterChains.join(';'),
        '-map', '[outv]',
        '-an', // Strictly NO AUDIO
        '-c:v', 'libx264',
        '-preset', 'veryfast', // Dipercepat karena re-encoding
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-max_muxing_queue_size', '1024',
        '-t', totalSilentDuration.toFixed(3),
        '-movflags', '+faststart',
        outputVideo
      );

      console.log(`[VideoRenderer Silent] Spawning FFmpeg:\n${ffmpegPath} ${args.join(' ')}`);
      const proc = spawn(ffmpegPath, args);
      let stderr = '';

      const timeoutMs = Math.max(360000, Math.ceil(totalSilentDuration * 20000)); // Minimum 6 minutes or 20s/second of video
      const timer = setTimeout(() => {
        try {
          console.error(`[VideoRenderer Silent] ⚠️ FFmpeg silent render timed out after ${Math.round(timeoutMs / 1000)}s! Terminating process...`);
          proc.kill('SIGKILL');
        } catch {}
      }, timeoutMs);

      proc.stderr.on('data', (d) => stderr += d.toString());

      proc.on('close', (code) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
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
  backgroundMusicPath = '',
  musicVolume = 0.10,
  sfxEvents = [],
  onProgress = () => {}
}) {
  const ffmpegPath = getFFmpegPath();
  const outDir = path.dirname(outputVideoPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const rawVideoDur = await getMediaDurationSec(silentVideoPath, ffmpegPath) || Number(targetDurationSec) || 24;
  const audioDuration = await getMediaDurationSec(voiceoverAudioPath, ffmpegPath);

  const MIN_VIDEO_DURATION = 18.0;
  const effectiveAudioDuration = audioDuration && audioDuration > 0 ? audioDuration : rawVideoDur;
  const effectiveFinalDuration = Math.max(MIN_VIDEO_DURATION, rawVideoDur, effectiveAudioDuration);

  let needVideoPad = false;
  let padDuration = 0;
  if (effectiveFinalDuration > rawVideoDur + 0.15) {
    padDuration = +(effectiveFinalDuration - rawVideoDur + 0.25).toFixed(2);
    needVideoPad = true;
    console.log(`[VideoRenderer Final] ⚡ Durasi visual (${rawVideoDur.toFixed(2)}s) di bawah target final (${effectiveFinalDuration.toFixed(2)}s). Melakukan hold-frame natural (+${padDuration}s) agar mencapai durasi minimal 18.0s & voiceover selesai sempurna...`);
  }

  const videoDuration = effectiveFinalDuration;

  onProgress({
    step: 'merge_final',
    message: srtPath
      ? 'Final mix: Voiceover loudness-normalized, subtitle safe-zone, music ducking & render...'
      : 'Final mix: Voiceover loudness-normalized & render...',
    progress: 92
  });

  return new Promise((resolve, reject) => {
    const inputArgs = ['-i', silentVideoPath, '-i', voiceoverAudioPath];
    let nextInputIndex = 2;

    const hasMusic = Boolean(backgroundMusicPath && fs.existsSync(backgroundMusicPath));
    let musicInputIndex = null;
    if (hasMusic) {
      musicInputIndex = nextInputIndex++;
      inputArgs.push('-stream_loop', '-1', '-i', backgroundMusicPath);
    }

    const validSfx = (Array.isArray(sfxEvents) ? sfxEvents : [])
      .filter(e => e?.path && fs.existsSync(e.path) && Number(e.atSec) >= 0)
      .slice(0, 8)
      .map((event) => ({ ...event, inputIndex: nextInputIndex++ }));
    for (const event of validSfx) {
      inputArgs.push('-i', event.path);
    }

    const filterChains = [];
    let videoMap = '0:v';

    if (needVideoPad && padDuration > 0) {
      filterChains.push(`[0:v]tpad=stop_mode=clone:stop_duration=${padDuration}[v_padded]`);
      videoMap = '[v_padded]';
    }

    if (srtPath && fs.existsSync(srtPath)) {
      const sanitizedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const isAss = sanitizedSrtPath.endsWith('.ass');
      const subFilter = isAss
        ? `ass='${sanitizedSrtPath}'`
        : `subtitles='${sanitizedSrtPath}':force_style='Fontname=Arial,Fontsize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=3,Shadow=1.5,MarginV=120,Alignment=2,Bold=1'`;
      filterChains.push(`${videoMap}${subFilter}[vsub]`);
      videoMap = '[vsub]';
    }

    // Normalize voice to a predictable social-video loudness target.
    // When music exists, split voice into a main mix path and a side-chain detector path.
    if (hasMusic) {
      filterChains.push('[1:a]highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=7,asplit=2[vo_main][vo_sc]');
    } else {
      filterChains.push('[1:a]highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=7[vo]');
    }

    let baseAudioLabel = hasMusic ? '[vo_main]' : '[vo]';
    if (hasMusic) {
      const safeMusicVolume = clampNumber(musicVolume, 0.02, 0.30, 0.10).toFixed(3);
      filterChains.push(`[${musicInputIndex}:a]volume=${safeMusicVolume}[bgm]`);
      // Duck music under narration, then mix it back with the untouched voiceover.
      filterChains.push('[bgm][vo_sc]sidechaincompress=threshold=0.020:ratio=8:attack=20:release=260[duckedbgm]');
      filterChains.push('[vo_main][duckedbgm]amix=inputs=2:duration=first:normalize=0[baseaudio]');
      baseAudioLabel = '[baseaudio]';
    }

    const sfxLabels = [];
    validSfx.forEach((event, i) => {
      const atMs = Math.max(0, Math.round(Number(event.atSec) * 1000));
      const volume = clampNumber(event.volume, 0.02, 0.35, 0.10).toFixed(3);
      const label = `sfx${i}`;
      filterChains.push(`[${event.inputIndex}:a]volume=${volume},adelay=${atMs}|${atMs}[${label}]`);
      sfxLabels.push(`[${label}]`);
    });

    if (sfxLabels.length > 0) {
      filterChains.push(
        `${baseAudioLabel}${sfxLabels.join('')}amix=inputs=${1 + sfxLabels.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`
      );
    } else {
      filterChains.push(`${baseAudioLabel}alimiter=limit=0.95[aout]`);
    }

    const args = [
      '-y',
      ...inputArgs,
      '-filter_complex', filterChains.join(';'),
      '-map', videoMap,
      '-map', '[aout]',
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

    const timeoutMs = Math.max(240000, Math.ceil(videoDuration * 15000));
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputVideoPath)) {
        onProgress({ step: 'merge_final', message: 'Final video rendered successfully!', progress: 97 });
        resolve({ finalPath: outputVideoPath, duration: videoDuration, hasMusic, sfxCount: validSfx.length });
      } else {
        reject(new Error(`Final merge failed: ${stderr.slice(-500)}`));
      }
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn FFmpeg for final merge: ${err.message}`));
    });
  });
}

function buildClipFilter({ inputIndex, outputLabel, reframe = {}, hflip, ptsFactor, isSourceVertical = false, clipDuration = 3.0 }) {
  const isFlipDisabled = reframe.allowHflip === false || reframe.hasProductBrand === true;
  const clipHflip = isFlipDisabled ? false : (reframe.hflip !== undefined ? reframe.hflip : hflip);
  const rawMode = reframe.renderMode;
  const validModes = ['stage_80', 'square_stage', 'fit_canvas', 'vertical_crop'];
  const renderMode = validModes.includes(rawMode) ? rawMode : 'stage_80';
  const preFlip = clipHflip ? 'hflip,' : '';
  const finish = `setsar=1,setpts=${ptsFactor}*(PTS-STARTPTS),eq=contrast=1.05:saturation=1.05:brightness=0.01,unsharp=5:5:0.8:5:5:0.0`;

  const baseFocusX = clampNumber(reframe.focusX, 0, 1, 0.5);
  const baseFocusY = clampNumber(reframe.focusY, 0, 1, isSourceVertical ? 0.75 : 0.55);
  const focusXStart = clampNumber(reframe.focusXStart, 0, 1, baseFocusX);
  const focusXEnd = clampNumber(reframe.focusXEnd, 0, 1, baseFocusX);
  const focusYStart = clampNumber(reframe.focusYStart, 0, 1, baseFocusY);
  const focusYEnd = clampNumber(reframe.focusYEnd, 0, 1, baseFocusY);
  const dur = Math.max(0.5, Number(clipDuration) || 3.0).toFixed(3);
  const progress = `min(max(t/${dur},0),1)`;
  const xFocusExpr = `(${focusXStart.toFixed(4)}+(${(focusXEnd - focusXStart).toFixed(4)})*${progress})`;
  const yFocusExpr = `(${focusYStart.toFixed(4)}+(${(focusYEnd - focusYStart).toFixed(4)})*${progress})`;

  // Full-screen vertical crop with time-varying focus trajectory.
  if (renderMode === 'vertical_crop') {
    return [
      `[${inputIndex}:v]${preFlip}scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920:x='(iw-1080)*${xFocusExpr}':y='(ih-1920)*${yFocusExpr}',${finish}[${outputLabel}]`
    ];
  }

  // Fit whole source over blurred canvas. No crop tracking needed.
  if (renderMode === 'fit_canvas') {
    return [
      `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
      `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
      `[fgsrc${inputIndex}]scale=1080:-2:flags=bicubic,setsar=1[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
    ];
  }

  if (renderMode === 'square_stage') {
    return [
      `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
      `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
      `[fgsrc${inputIndex}]scale=1080:1080:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1080:x='(iw-1080)*${xFocusExpr}':y='(ih-1080)*${yFocusExpr}',setsar=1[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
    ];
  }

  // Default Smart Stage 80% with subtle time-varying reframe.
  return [
    `[${inputIndex}:v]${preFlip}split=2[bgsrc${inputIndex}][fgsrc${inputIndex}]`,
    `[bgsrc${inputIndex}]scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,boxblur=24:12,eq=brightness=-0.15:saturation=0.85[bg${inputIndex}]`,
    `[fgsrc${inputIndex}]scale=1080:1536:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1536:x='(iw-1080)*${xFocusExpr}':y='(ih-1536)*${yFocusExpr}',setsar=1[fg${inputIndex}]`,
    `[bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,${finish}[${outputLabel}]`,
  ];
}

export function normalizeRenderClips(clips, fallbackStartTime, fallbackEndTime, fallbackReframe = {}) {
  const defaultClipLength = 3.0;
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
        duration: Math.max(1.2, Math.min(8.0, clipDuration)),
        videoPath: clip?.videoPath || clip?.sourceVideo || null,
        candidateIndex: clip?.candidateIndex !== undefined ? clip.candidateIndex : null,
        isConformedLoop: Boolean(clip?.isConformedLoop),
        reframe: {
          renderMode: effectiveRenderMode,
          ...(clip?.reframe || {}),
          ...(fallbackReframe?.renderMode ? { renderMode: fallbackReframe.renderMode } : {}),
          allowHflip: clip?.allowHflip !== undefined ? clip.allowHflip : clip?.reframe?.allowHflip,
          hasProductBrand: clip?.hasProductBrand !== undefined ? clip.hasProductBrand : clip?.reframe?.hasProductBrand,
        },
      });
      if (normalized.length === 16) break; // Support up to 16 cuts for long voiceover
    }
  }

  if (normalized.length) {
    // Deduplikasi ketat: Pastikan tidak ada klip yang identik dari video yang sama
    // Jangan buang klip yang sengaja diekspansi untuk memenuhi voiceover (isConformedLoop)!
    const deduplicated = [];
    for (const c of normalized) {
      const isDuplicate = !c.isConformedLoop && deduplicated.some(existing => {
        const sameVideo = (existing.videoPath && c.videoPath && existing.videoPath === c.videoPath) ||
          (existing.candidateIndex !== null && existing.candidateIndex !== undefined && existing.candidateIndex === c.candidateIndex) ||
          (!existing.videoPath && !c.videoPath && existing.candidateIndex === c.candidateIndex);
        const sameMode = existing.reframe?.renderMode === c.reframe?.renderMode;
        return sameVideo && sameMode && !existing.isConformedLoop && Math.abs(existing.startSeconds - c.startSeconds) < 6.0;
      });
      if (!isDuplicate) {
        deduplicated.push(c);
      } else {
        console.log(`[normalizeRenderClips] ⚠️ Membuang klip duplikat / berjarak terlalu dekat (< 6s) pada timestamp ${c.startSeconds}s.`);
      }
    }

    // Durasi adaptif dan natural (minimal 18.0 detik sesuai mandat pengguna):
    // Klip hasil kurasi AI diskalakan proporsional agar total video visual mencapai minimal 18.0 detik.
    const currentTotal = deduplicated.reduce((sum, c) => sum + (c.duration || defaultClipLength), 0);
    const MIN_VIDEO_DURATION_SEC = 18.0;
    if (currentTotal < MIN_VIDEO_DURATION_SEC && deduplicated.length > 0) {
      const scale = MIN_VIDEO_DURATION_SEC / currentTotal;
      for (const c of deduplicated) {
        c.duration = +(c.duration * scale).toFixed(3);
      }
      const newTotal = deduplicated.reduce((sum, c) => sum + (c.duration || defaultClipLength), 0);
      console.log(`[normalizeRenderClips] ⚡ Total durasi klip (${currentTotal.toFixed(1)}s) di bawah batas minimal 18.0s. Menyesuaikan durasi klip secara proporsional menjadi ${newTotal.toFixed(1)}s.`);
    } else {
      console.log(`[normalizeRenderClips] ✅ Total durasi klip terkurasi: ${currentTotal.toFixed(1)}s (${deduplicated.length} klip bersih). Memenuhi syarat minimal 18.0s.`);
    }

    return deduplicated;
  }

  const fallbackStart = parseTimeToSeconds(fallbackStartTime);
  const fallbackEnd = parseTimeToSeconds(fallbackEndTime);
  const clipLength = defaultClipLength;
  const fallbackDuration = fallbackEnd > fallbackStart ? fallbackEnd - fallbackStart : (clipLength * 5);
  const clipCount = Math.max(4, Math.min(8, Math.floor(fallbackDuration / clipLength)));

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

  const timeoutMs = Math.max(240000, Math.ceil(videoDuration * 15000));
  const timer = setTimeout(() => {
    try {
      console.error(`[VideoRenderer Fallback] ⚠️ FFmpeg fallback merge timed out after ${Math.round(timeoutMs / 1000)}s! Terminating process...`);
      proc.kill('SIGKILL');
    } catch {}
  }, timeoutMs);

  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', code => {
    clearTimeout(timer);
    if (code === 0 && fs.existsSync(outputVideoPath)) {
      onProgress({ step: 'merge_final', message: 'Final video merged successfully (fallback mode).', progress: 100 });
      resolve({ finalPath: outputVideoPath });
    } else {
      reject(new Error(`Final fallback merge failed: ${stderr.slice(-300)}`));
    }
  });
  proc.on('error', err => {
    clearTimeout(timer);
    reject(new Error(`Failed to spawn FFmpeg for fallback merge: ${err.message}`));
  });
}
