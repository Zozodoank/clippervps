import { describe, it, expect } from 'vitest';
import {
  assessVoiceoverPresence,
  buildBeatsFromSegments,
  parseWhisperJson,
  isAudioDrivenEnabled,
  resolveAudioWindow,
} from '../services/audioBeatService.js';
import {
  countWords,
  wordCountDrift,
  beatsToScript,
} from '../services/antiPlagiarismService.js';

describe('Gerbang wajib voice-over (assessVoiceoverPresence)', () => {
  it('lolos: narasi manusia padat mengisi timeline', () => {
    const segs = [
      { start: 0, end: 3, text: 'alat ini sangat berguna sekali' },
      { start: 3, end: 6, text: 'bikin pekerjaan jadi lebih cepat' },
    ];
    const r = assessVoiceoverPresence(segs, 8, { minCoverage: 0.15, minSpeechSec: 3, minWords: 6 });
    expect(r.hasVoiceover).toBe(true);
    expect(r.coverage).toBeGreaterThan(0.5);
  });

  it('tolak: tanpa segmen (murni musik/backsound)', () => {
    const r = assessVoiceoverPresence([], 30);
    expect(r.hasVoiceover).toBe(false);
    expect(r.coverage).toBe(0);
  });

  it('tolak: cakupan ucapan terlalu kecil dari durasi', () => {
    const segs = [{ start: 0, end: 1, text: 'oke' }];
    const r = assessVoiceoverPresence(segs, 120, { minCoverage: 0.15, minSpeechSec: 3 });
    expect(r.hasVoiceover).toBe(false);
  });
});

describe('Segmenter beat 1-7 detik (buildBeatsFromSegments)', () => {
  it('setiap beat berada dalam rentang min..max detik', () => {
    const segs = [];
    for (let i = 0; i < 20; i++) segs.push({ start: i * 2, end: i * 2 + 2, text: `kata ${i} dua tiga empat lima enam tujuh` });
    const beats = buildBeatsFromSegments(segs, { minSec: 1, idealMax: 5, maxSec: 7 });
    expect(beats.length).toBeGreaterThan(0);
    for (const b of beats) {
      expect(b.duration).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(b.duration).toBeLessThanOrEqual(7 + 1e-6);
    }
  });

  it('memaksa split segmen tunggal yang lebih panjang dari maxSec', () => {
    const segs = [{ start: 0, end: 20, text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') }];
    const beats = buildBeatsFromSegments(segs, { maxSec: 7 });
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (const b of beats) expect(b.duration).toBeLessThanOrEqual(7 + 1e-6);
  });

  it('menggabungkan segmen pendek berurutan', () => {
    const segs = [
      { start: 0, end: 0.6, text: 'ini' },
      { start: 0.7, end: 1.2, text: 'sangat' },
      { start: 1.3, end: 1.9, text: 'murah' },
    ];
    const beats = buildBeatsFromSegments(segs, { minSec: 1, idealMax: 5, maxSec: 7 });
    expect(beats.length).toBe(1);
    expect(beats[0].text).toContain('murah');
  });
});

describe('Parser output whisper.cpp (parseWhisperJson)', () => {
  it('membaca offsets ms dari struktur transcription resmi', () => {
    const raw = JSON.stringify({
      result: { language: 'id' },
      transcription: [
        { offsets: { from: 0, to: 3000 }, text: ' halo teman' },
        { offsets: { from: 3000, to: 6000 }, text: ' lihat ini' },
      ],
    });
    const r = parseWhisperJson(raw);
    expect(r.language).toBe('id');
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].start).toBe(0);
    expect(r.segments[1].end).toBe(6);
  });

  it('tahan terhadap sampah log sebelum JSON', () => {
    const raw = 'whisper_print_system_info...\n' + JSON.stringify({ transcription: [{ offsets: { from: 100, to: 2000 }, text: 'a b' }] });
    const r = parseWhisperJson(raw);
    expect(r.segments[0].text).toBe('a b');
  });

  it('mengembalikan null untuk output tidak valid', () => {
    expect(parseWhisperJson('bukan json sama sekali')).toBeNull();
  });
});

describe('Penjaga jumlah kata anti-plagiat', () => {
  it('countWords menghitung kata dengan benar', () => {
    expect(countWords('saya mudah memotong bawang')).toBe(4);
  });

  it('drift kecil lolos toleransi, drift besar ditandai', () => {
    expect(wordCountDrift('a b c d', 'a b c e', 0.3).withinTolerance).toBe(true);
    expect(wordCountDrift('a b c d', 'a', 0.3).withinTolerance).toBe(false);
  });
});

describe('beatsToScript', () => {
  it('memakai reworded bila ada, fallback ke text', () => {
    const beats = [{ text: 'asli satu', reworded: 'parafrase satu' }, { text: 'asli dua' }];
    expect(beatsToScript(beats)).toBe('parafrase satu asli dua');
  });
});

describe('Flag AUDIO_DRIVEN_SCENES', () => {
  it('default OFF', () => {
    expect(isAudioDrivenEnabled({})).toBe(false);
    expect(isAudioDrivenEnabled({ AUDIO_DRIVEN_SCENES: 'true' })).toBe(true);
  });
});

describe('resolveAudioWindow — jendela whisper selaras file yang dibuka', () => {
  it('video penuh: pakai timeline sumber apa adanya', () => {
    const w = resolveAudioWindow({
      clip: { startSeconds: 42.5 },
      highlight: { startSeconds: 42.5, endSeconds: 68 },
      fileDurationSec: 300,
    });
    expect(w).toEqual({ startSec: 42.5, endSec: 68 });
  });

  it('mode segmen (--download-sections): jendela di-rebase ke offset file', () => {
    const w = resolveAudioWindow({
      clip: { startSeconds: 42.5, sourceOffsetSec: 40 },
      highlight: { startSeconds: 42.5, endSeconds: 68 },
      fileDurationSec: 35,
    });
    expect(w).toEqual({ startSec: 2.5, endSec: 28 });
  });

  it('string "MM:SS" tidak lagi membuat window runtuh ke 0-0', () => {
    // Akar bug lama: caller mengirim startTime/endTime ("01:24") -> Number() = NaN -> 0.
    const w = resolveAudioWindow({
      clip: { startSeconds: '01:24', startTime: '01:24' },
      highlight: { startSeconds: '01:24', endSeconds: '01:50' },
      fileDurationSec: 200,
    });
    expect(w).toEqual({ startSec: 0, endSec: 0 });
    // ..tetapi versi angka yang benar memberi window utuh:
    const ok = resolveAudioWindow({
      clip: { startSeconds: 84 },
      highlight: { startSeconds: 84, endSeconds: 110 },
      fileDurationSec: 200,
    });
    expect(ok).toEqual({ startSec: 84, endSec: 110 });
  });

  it('clamp ke durasi file agar ffmpeg tidak membaca melewati akhir', () => {
    const w = resolveAudioWindow({
      clip: { startSeconds: 30, sourceOffsetSec: 0 },
      highlight: { startSeconds: 30, endSeconds: 500 },
      fileDurationSec: 40,
    });
    expect(w.startSec).toBeLessThanOrEqual(39);
    expect(w.endSec).toBe(40);
  });

  it('tanpa clip & tanpa durasi file -> window nol (analisis penuh, tidak crash)', () => {
    expect(resolveAudioWindow({})).toEqual({ startSec: 0, endSec: 0 });
  });
});
