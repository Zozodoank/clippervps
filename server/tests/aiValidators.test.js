// P2 JARING PENGAMAN — Tes karakterisasi pure helper di services/ai/aiValidators.js.
// Tujuan: MENGUNCI perilaku yang ada hari ini (bukan yang "seharusnya") supaya refactor
// P6 bisa dilakukan tanpa mengubah semantik. Bila tes ini merah, artinya perilaku berubah.
import { describe, it, expect } from 'vitest';
import {
  formatSeconds,
  parseTimeToSeconds,
  clampNumber,
  normalizeReframe,
  hasSourceIdentityRisk,
  normalizeClipPlan,
  DEFAULT_REFRAME,
} from '../services/ai/aiValidators.js';

describe('formatSeconds (MM:SS, TANPA bucket jam terpisah)', () => {
  it('memformat menit:detik dengan pad 2 digit', () => {
    expect(formatSeconds(0)).toBe('00:00');
    expect(formatSeconds(5)).toBe('00:05');
    expect(formatSeconds(65)).toBe('01:05');
  });
  it('membulatkan ke bawah (floor) untuk pecahan detik', () => {
    expect(formatSeconds(59.9)).toBe('00:59');
    expect(formatSeconds(119.7)).toBe('01:59');
  });
  it('MENGGABUNG jam ke kolom menit (perilaku terkunci: 3600s => 60:00)', () => {
    // Bukan bug yang kita perbaiki di P2 — ini karakterisasi perilaku saat ini.
    expect(formatSeconds(3600)).toBe('60:00');
  });
});

describe('parseTimeToSeconds', () => {
  it('number diteruskan apa adanya', () => {
    expect(parseTimeToSeconds(42)).toBe(42);
    expect(parseTimeToSeconds(42.5)).toBe(42.5);
  });
  it('null/kosong => 0', () => {
    expect(parseTimeToSeconds(null)).toBe(0);
    expect(parseTimeToSeconds('')).toBe(0);
    expect(parseTimeToSeconds(undefined)).toBe(0);
  });
  it('MM:SS => menit*60 + detik', () => {
    expect(parseTimeToSeconds('01:30')).toBe(90);
    expect(parseTimeToSeconds('1:30')).toBe(90);
  });
  it('HH:MM:SS => jam*3600 + menit*60 + detik', () => {
    expect(parseTimeToSeconds('1:30:00')).toBe(5400);
    expect(parseTimeToSeconds('00:00:45')).toBe(45);
  });
  it('string numerik tunggal => parseFloat', () => {
    expect(parseTimeToSeconds('45')).toBe(45);
    expect(parseTimeToSeconds('45.5')).toBe(45.5);
  });
  it('string bukan angka => 0 (parseFloat NaN lalu || 0)', () => {
    expect(parseTimeToSeconds('abc')).toBe(0);
  });
});

describe('clampNumber', () => {
  it('clamp ke rentang [min,max]', () => {
    expect(clampNumber(5, 0, 1, 0.5)).toBe(1);
    expect(clampNumber(-3, 0, 1, 0.5)).toBe(0);
    expect(clampNumber(0.7, 0, 1, 0.5)).toBe(0.7);
  });
  it('non-finite (NaN/undefined/string) => fallback', () => {
    expect(clampNumber('x', 0, 1, 0.5)).toBe(0.5);
    expect(clampNumber(undefined, 0, 1, 0.42)).toBe(0.42);
    expect(clampNumber(NaN, 0, 1, 0.9)).toBe(0.9);
  });
  it('menerima string angka yang valid', () => {
    expect(clampNumber('0.25', 0, 1, 0.5)).toBe(0.25);
  });
});

describe('normalizeReframe', () => {
  it('objek kosong => seluruh DEFAULT_REFRAME terpakai', () => {
    const r = normalizeReframe({});
    expect(r.focusX).toBe(DEFAULT_REFRAME.focusX);
    expect(r.focusY).toBe(DEFAULT_REFRAME.focusY);
    expect(r.renderMode).toBe('stage_80');
    expect(r.cropStrategy).toBe(DEFAULT_REFRAME.cropStrategy);
    expect(r.avoidFaceZones).toEqual(['top', 'upper_middle']);
    expect(r.avoidTextZones).toEqual([]);
    expect(r.faceSafety).toBe(true);
    expect(r.allowHflip).toBe(true);
    expect(r.dynamicTracking).toBe(true);
    expect(r.hasProductBrand).toBe(false);
  });
  it('focus di-clamp ke [0,1]', () => {
    const r = normalizeReframe({ focusX: 5, focusY: -2 });
    expect(r.focusX).toBe(1);
    expect(r.focusY).toBe(0);
  });
  it('renderMode di luar daftar valid => fallback stage_80', () => {
    expect(normalizeReframe({ renderMode: 'bogus' }).renderMode).toBe('stage_80');
    expect(normalizeReframe({ renderMode: 'vertical_crop' }).renderMode).toBe('vertical_crop');
  });
  it('focusXStart/End default mengikuti focusX efektif', () => {
    const r = normalizeReframe({ focusX: 0.8 });
    expect(r.focusXStart).toBe(0.8);
    expect(r.focusXEnd).toBe(0.8);
  });
  it('flag boolean menghormati false eksplisit', () => {
    const r = normalizeReframe({ faceSafety: false, allowHflip: false, dynamicTracking: false });
    expect(r.faceSafety).toBe(false);
    expect(r.allowHflip).toBe(false);
    expect(r.dynamicTracking).toBe(false);
  });
});

describe('hasSourceIdentityRisk', () => {
  it('sourceOwnerIdentityVisible=true selalu berisiko', () => {
    expect(hasSourceIdentityRisk({ sourceOwnerIdentityVisible: true })).toBe(true);
  });
  it('risk kosong/none/low/false/no => TIDAK berisiko', () => {
    for (const v of ['', 'none', 'low', 'false', 'no', '  NONE  ']) {
      expect(hasSourceIdentityRisk({ sourceIdentityRisk: v })).toBe(false);
    }
  });
  it('risk lain (medium/high/teks) => berisiko', () => {
    expect(hasSourceIdentityRisk({ sourceIdentityRisk: 'high' })).toBe(true);
    expect(hasSourceIdentityRisk({ sourceIdentityRisk: 'wajah vlogger' })).toBe(true);
  });
  it('objek kosong => tidak berisiko', () => {
    expect(hasSourceIdentityRisk()).toBe(false);
  });
});

describe('normalizeClipPlan — saringan & kontrak hasil', () => {
  const clean = (startSeconds, candidateIndex = 0) => ({ startSeconds, duration: 3, candidateIndex });

  it('3 klip bersih => dikembalikan apa adanya (>=3 lolos ambang kualitas)', () => {
    const out = normalizeClipPlan([clean(10), clean(20), clean(30)], 100);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ startSeconds: 10, endSeconds: 13, duration: 3 });
  });

  it('2 klip bersih + allowFallback=true => 2 klip tetap dipertahankan (branch fallback non-dead)', () => {
    const out = normalizeClipPlan([clean(10), clean(20)], 100, { allowFallback: true });
    expect(out.length).toBe(2);
  });

  it('2 klip bersih + allowFallback=false => LEMPAR isAiRejection (<3 aksi)', () => {
    let err = null;
    try {
      normalizeClipPlan([clean(10), clean(20)], 100, { allowFallback: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.isAiRejection).toBe(true);
  });

  it('0 klip => LEMPAR isAiRejection (kode fallback setelah throw tidak terjangkau)', () => {
    let err = null;
    try {
      normalizeClipPlan([], 100, { allowFallback: true });
    } catch (e) {
      err = e;
    }
    // Karakterisasi: jalur builder-fallback (baris setelah `throw cleanErr`) adalah DEAD CODE.
    // Bahkan dengan allowFallback=true, 0 klip selalu berujung lempar, bukan fallback.
    expect(err && err.isAiRejection).toBe(true);
  });

  it('memangkas klip yang intervalnya menimpa frame kotor (hasFace di frameAudit)', () => {
    const frameAudit = [{ timestamp: '0:20', hasFace: true }];
    const out = normalizeClipPlan([clean(10), clean(20), clean(30)], 100, { frameAudit });
    expect(out.map((c) => c.startSeconds)).toEqual([10, 30]);
  });

  it('memangkas klip dengan sourceIdentityRisk', () => {
    const clips = [clean(10), { ...clean(20), sourceIdentityRisk: 'high' }, clean(30)];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => c.startSeconds)).toEqual([10, 30]);
  });

  it('memangkas klip kemasan kosong (isPackaging / alasan buka kardus)', () => {
    const clips = [clean(10), { ...clean(20), isPackaging: true }, { ...clean(30), reason: 'buka kardus kosong' }];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => c.startSeconds)).toEqual([10]);
  });

  it('memangkas klip yang melampaui totalDuration', () => {
    const clips = [clean(10), clean(20), clean(98)];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => c.startSeconds)).toEqual([10, 20]);
  });

  it('di mode non-storyboard, klip yang mundur ke bawah end klip kandidat sebelumnya dibuang', () => {
    // candidateIndex sama (0): 10->13, lalu 12 (< prevEnd 13) overlap => dibuang, 30 OK.
    const clips = [clean(10), clean(12), clean(30)];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => c.startSeconds)).toEqual([10, 30]);
  });

  it('maksimal 8 klip (break saat normalized.length === 8)', () => {
    const clips = Array.from({ length: 12 }, (_, i) => clean(i * 5)); // 0,5,...,55 durasi 3 => tanpa dup
    const out = normalizeClipPlan(clips, 200);
    expect(out.length).toBe(8);
  });

  it('urutkan berdasarkan candidateIndex lalu startSeconds (non-storyboard)', () => {
    const clips = [
      { ...clean(10), candidateIndex: 1 },
      { ...clean(5), candidateIndex: 0 },
      { ...clean(20), candidateIndex: 0 },
    ];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => [c.candidateIndex, c.startSeconds])).toEqual([[0, 5], [0, 20], [1, 10]]);
  });

  it('mode storyboard (ada storyboardSlot) => urut per slot & boleh potong mundur', () => {
    const clips = [
      { startSeconds: 5, duration: 3, candidateIndex: 9, storyboardSlot: 2 },
      { startSeconds: 40, duration: 3, candidateIndex: 8, storyboardSlot: 1 },
    ];
    const out = normalizeClipPlan(clips, 100);
    expect(out.map((c) => c.storyboardSlot)).toEqual([1, 2]);
    // Slot 1 start 40 tetap dipertahankan meski lebih akhir dari slot 2 (5s): tidak dibuang sebagai overlap.
    expect(out[0].startSeconds).toBe(40);
  });

  it('brand produk memaksa allowHflip=false meski allowHflip global true', () => {
    const out = normalizeClipPlan([{ startSeconds: 10, duration: 3, hasProductBrand: true }, clean(20), clean(30)], 100);
    expect(out[0].hasProductBrand).toBe(true);
    expect(out[0].allowHflip).toBe(false);
  });
});
