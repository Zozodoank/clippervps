import fs from 'fs';
import { extractSourceAudio, transcribeAudio, assessVoiceoverPresence } from './audioBeatService.js';

/**
 * Menganalisa narasi (gate awal) dan memilih window terbaik dalam domain audio.
 */
export async function analyzeNarrationAndSelectBestWindow(videoPath, {
  minCoverage = 0.3,
  minSpeechSec = 3,
  minWords = 6,
  targetDurationSec = 25,
  totalVideoDurationSec = 0,
  previewStartSec = 0,
  logger = console,
} = {}) {
  const extracted = await extractSourceAudio({ videoPath, outWav: null, logger });
  if (!extracted.ok) {
    if (extracted.noAudio) {
      return { hasNarration: false, reason: 'Video sumber tidak memiliki track audio.' };
    }
    // FFmpeg gagal menjalankan ekstraksi = masalah infrastruktur lokal, bukan vonis konten.
    throw Object.assign(new Error(`Gagal mengekstrak audio: ${extracted.error}`), { isInfraError: true });
  }

  let transcribed;
  try {
    transcribed = await transcribeAudio({ wavPath: extracted.wavPath, logger, env: process.env });
  } finally {
    if (fs.existsSync(extracted.wavPath)) {
      try { fs.unlinkSync(extracted.wavPath); } catch {}
    }
  }

  if (!transcribed.ok) {
    // P1-5: whisper.cpp biner hilang/crash/timeout = transien infrastruktur. Flag memisahkan
    // ini dari vonis AI supaya master loop tidak mem-blacklist kandidat baik karena server sibuk.
    throw Object.assign(new Error(`Gagal transkripsi audio: ${transcribed.error}`), { isInfraError: true });
  }

  // Hitung durasi berdasar rentang file
  const actualDurationSec = transcribed.segments.length > 0
    ? Math.max(0, transcribed.segments[transcribed.segments.length - 1].end)
    : 0;

  const presence = assessVoiceoverPresence(transcribed.segments, actualDurationSec, {
    minCoverage,
    minSpeechSec,
    minWords,
  });

  if (!presence.hasVoiceover) {
    return {
      hasNarration: false,
      reason: presence.reason,
      coverage: presence.coverage,
      speechSec: presence.speechSec,
    };
  }

  // Cari window terbaik (targetDurationSec) yang paling padat ucapan
  const bestWindow = selectBestNarrationWindow(transcribed.segments, targetDurationSec, actualDurationSec);
  
  // Rebase timestamp ke koordinat absolut (tambah offset startSec dari sumber)
  const rebasedStart = previewStartSec + bestWindow.localStartSec;
  const rebasedEnd = previewStartSec + bestWindow.localEndSec;
  
  // Filter segmen yang ada di dalam window
  const filteredSegments = [];
  for (const seg of transcribed.segments) {
    if (seg.end > bestWindow.localStartSec && seg.start < bestWindow.localEndSec) {
      filteredSegments.push({
        id: `seg-${Date.now()}-${Math.floor(Math.random()*1000)}`,
        sourceStartSec: previewStartSec + seg.start,
        sourceEndSec: previewStartSec + seg.end,
        text: seg.text,
      });
    }
  }

  return {
    hasNarration: true,
    coverage: presence.coverage,
    speechSec: presence.speechSec,
    bestWindow: {
      startSec: rebasedStart,
      endSec: rebasedEnd,
      durationSec: bestWindow.durationSec,
      localStartSec: bestWindow.localStartSec,
      localEndSec: bestWindow.localEndSec,
    },
    whisperSegments: filteredSegments,
  };
}

function selectBestNarrationWindow(segments, targetDurationSec, totalDuration) {
  if (totalDuration <= targetDurationSec) {
    return { localStartSec: 0, localEndSec: totalDuration, durationSec: totalDuration };
  }

  let bestStart = 0;
  let maxSpeech = -1;

  // Sliding window step 1s
  for (let start = 0; start <= totalDuration - targetDurationSec; start++) {
    const end = start + targetDurationSec;
    let currentSpeech = 0;

    for (const seg of segments) {
      if (seg.end <= start || seg.start >= end) continue;
      const segStart = Math.max(start, seg.start);
      const segEnd = Math.min(end, seg.end);
      currentSpeech += (segEnd - segStart);
    }

    if (currentSpeech > maxSpeech) {
      maxSpeech = currentSpeech;
      bestStart = start;
    }
  }

  return {
    localStartSec: bestStart,
    localEndSec: bestStart + targetDurationSec,
    durationSec: targetDurationSec
  };
}
