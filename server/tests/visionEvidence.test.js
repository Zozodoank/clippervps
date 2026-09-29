// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  countUsableFrames,
  shouldPreferEvidence,
  pickEvidenceFrames,
  formatCleanWindowsBySource,
  mapFramesToBudgeted,
} from '../services/visionEvidenceService.js';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  isGeminiEvidenceEnabled,
} from '../config/runtimeFlags.js';

// EVIDENCE MODE: kunci perilaku murni (pure) dispatch Gemini hemat token.
// stage1Render/aiService hanya boleh memakai hasil fungsi-fungsi ini.

const mk = (ts) => ({ timestamp: ts, filePath: `/frames/f_${ts}.jpg` });

describe('countUsableFrames', () => {
  it('menghitung hanya frame dengan base64 atau filePath', () => {
    expect(countUsableFrames([mk(1), { timestamp: 2 }, null, { base64: 'AAA' }])).toBe(2);
  });
  it('ramah input kosong/undefined', () => {
    expect(countUsableFrames()).toBe(0);
    expect(countUsableFrames([])).toBe(0);
  });
});

describe('shouldPreferEvidence — gerbang fallback stream', () => {
  it('evidence hanya bila flag aktif DAN jumlah bukti memenuhi floor', () => {
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 6 })).toBe(true);
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 5 })).toBe(false);
    expect(shouldPreferEvidence({ evidenceEnabled: false, usableFrames: 100 })).toBe(false);
  });
  it('minFrames eksplisit mengalahkan env; floor global 2', () => {
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 3, minFrames: 3 })).toBe(true);
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 1, minFrames: 0 })).toBe(false);
  });
  it('memakai EVIDENCE_MIN_FRAMES dari env saat tidak diberikan', () => {
    const prev = process.env.EVIDENCE_MIN_FRAMES;
    process.env.EVIDENCE_MIN_FRAMES = '10';
    try {
      expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 9 })).toBe(false);
      expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 10 })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EVIDENCE_MIN_FRAMES;
      else process.env.EVIDENCE_MIN_FRAMES = prev;
    }
  });
});

describe('pickEvidenceFrames — budget cluster-aware', () => {
  it('tidak mengubah daftar kecil (<= max)', () => {
    const frames = [mk(0), mk(2), mk(4)];
    expect(pickEvidenceFrames(frames, { max: 30 })).toEqual(frames);
  });
  it('memotong ke budget max dan tetap kronologis + unik', () => {
    const frames = Array.from({ length: 100 }, (_, i) => mk(i * 2));
    const picked = pickEvidenceFrames(frames, { max: 30 });
    expect(picked.length).toBeLessThanOrEqual(30);
    const ts = picked.map((f) => f.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(picked.map((f) => f.filePath)).size).toBe(picked.length);
  });
  it('menjamin boundary pertama & terakhir tiap kluster adegan ikut terkirim', () => {
    // 3 kluster terpisah jauh (gap > clusterGapSec=8): window adegan berbeda.
    const cluster = (base) => Array.from({ length: 20 }, (_, i) => mk(base + i));
    const frames = [...cluster(0), ...cluster(100), ...cluster(200)];
    const picked = pickEvidenceFrames(frames, { max: 12 });
    const tsSet = new Set(picked.map((f) => f.timestamp));
    for (const base of [0, 100, 200]) {
      expect(tsSet.has(base)).toBe(true);      // awal kluster
      expect(tsSet.has(base + 19)).toBe(true); // akhir kluster
    }
  });
  it('mengabaikan frame tanpa bukti visual (tanpa base64/filePath)', () => {
    const frames = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? { timestamp: i } : mk(i * 10)));
    const picked = pickEvidenceFrames(frames, { max: 20 });
    expect(picked.every((f) => f.filePath)).toBe(true);
  });
  it('mende-duplikat frame identik (filePath sama)', () => {
    const dup = Array.from({ length: 60 }, () => mk(5));
    const picked = pickEvidenceFrames(dup, { max: 10 });
    expect(picked.length).toBe(1);
  });
  it('elemen hasil adalah OBJEK IDENTIK dengan input (prasyarat pemetaan indeks)', () => {
    const frames = Array.from({ length: 80 }, (_, i) => mk(i * 3));
    const picked = pickEvidenceFrames(frames, { max: 10 });
    expect(picked.every((f) => frames.includes(f))).toBe(true);
  });
});

describe('mapFramesToBudgeted — terjemah indeks subset -> pool asli', () => {
  it('subset == asli (tanpa potong) tetap memetakan via identitas objek', () => {
    const a = mk(0); const b = mk(5);
    expect(mapFramesToBudgeted([1, 2], [a, b], [a, b])).toEqual([1, 2]);
  });
  it('indeks ruang subset dipetakan ke posisi array asli yang benar', () => {
    const original = Array.from({ length: 10 }, (_, i) => mk(i * 10));
    // subset acak-orde: asli[7] lalu asli[2] -> subset #1 => indeks asli 8, #2 => 3
    const subset = [original[7], original[2]];
    expect(mapFramesToBudgeted([1, 2], subset, original)).toEqual([8, 3]);
  });
  it('buang indeks di luar rentang subset dan hasil unik', () => {
    const original = [mk(0), mk(10), mk(20)];
    const subset = [original[2]];
    expect(mapFramesToBudgeted([1, 1, 5], subset, original)).toEqual([3]);
  });
  it('frame asing (tidak ada di pool) fallback ke indeks itu sendiri', () => {
    const original = [mk(0), mk(10)];
    const alien = mk(99);
    expect(mapFramesToBudgeted([1], [alien], original)).toEqual([1]);
  });
  it('end-to-end dengan pickEvidenceFrames: nomor yang dilihat AI menunjuk frame yang sama', () => {
    const pool = Array.from({ length: 90 }, (_, i) => ({ timestamp: i * 2, filePath: `/f/pool_${i}.jpg` }));
    const subset = pickEvidenceFrames(pool, { max: 12 });
    const aiPicks = [1, 4, 7, 12]; // indeks 1-based ruang subset (respons AI)
    const mapped = mapFramesToBudgeted(aiPicks, subset, pool);
    expect(mapped.map((i) => pool[i - 1].filePath)).toEqual(aiPicks.map((i) => subset[i - 1].filePath));
  });
});

describe('formatCleanWindowsBySource — fix P0 sumber window', () => {
  it('kosong -> string kosong', () => {
    expect(formatCleanWindowsBySource([])).toBe('');
    expect(formatCleanWindowsBySource(undefined)).toBe('');
  });
  it('tanpa sourceVideoIndex -> directive flatlegacy', () => {
    const out = formatCleanWindowsBySource([{ start: 10, end: 25 }, { start: 40, end: 60 }]);
    expect(out).toContain('10s-25s, 40s-60s');
    expect(out).toContain('CRITICAL MANDATE');
    expect(out).not.toContain('VIDEO #2');
  });
  it('dengan sourceVideoIndex -> kelompok per VIDEO dengan label', () => {
    const out = formatCleanWindowsBySource(
      [
        { start: 5, end: 20, sourceVideoIndex: 0 },
        { start: 10, end: 30, sourceVideoIndex: 1 },
        { start: 100, end: 120, sourceVideoIndex: 1 },
      ],
      ['youtube.com/watch?v=AAA', 'youtube.com/watch?v=BBB'],
    );
    expect(out).toContain('VIDEO #1');
    expect(out).toContain('VIDEO #2');
    expect(out).toContain('5s-20s');
    expect(out).toMatch(/VIDEO #2.*10s-30s.*100s-120s/s);
    expect(out).toContain('SOURCE-SCOPED');
  });
  it('window dengan koordinat tidak valid dibuang', () => {
    const out = formatCleanWindowsBySource([{ start: 'x', end: 5 }, { start: 1, end: 2 }]);
    expect(out).toContain('1s-2s');
    expect(out).not.toContain('xs-5s');
  });
});

describe('runtimeFlags — GEMINI_INPUT_MODE & budget beku per-job (retry)', () => {
  it('default evidence; hanya "stream" (kasar-abai-spasi) yang kembali ke mode lama', () => {
    expect(buildConfigSnapshot({}).GEMINI_INPUT_MODE).toBe('evidence');
    expect(buildConfigSnapshot({ GEMINI_INPUT_MODE: ' STREAM ' }).GEMINI_INPUT_MODE).toBe('stream');
    expect(buildConfigSnapshot({ GEMINI_INPUT_MODE: 'nonsense' }).GEMINI_INPUT_MODE).toBe('evidence');
  });
  it('budget evidence memakai floor yang sama dengan konsumen', () => {
    expect(buildConfigSnapshot({}).EVIDENCE_MIN_FRAMES).toBe(6);
    expect(buildConfigSnapshot({ EVIDENCE_MIN_FRAMES: '1' }).EVIDENCE_MIN_FRAMES).toBe(2);
    expect(buildConfigSnapshot({ EVIDENCE_MAX_FRAMES: '40' }).EVIDENCE_MAX_FRAMES).toBe(40);
    expect(buildConfigSnapshot({ EVIDENCE_MAX_FRAMES: 'abc' }).EVIDENCE_MAX_FRAMES).toBe(30);
  });
  it('isGeminiEvidenceEnabled membaca env secara toleran', () => {
    expect(isGeminiEvidenceEnabled({})).toBe(true);
    expect(isGeminiEvidenceEnabled({ GEMINI_INPUT_MODE: 'Evidence' })).toBe(true);
    expect(isGeminiEvidenceEnabled({ GEMINI_INPUT_MODE: 'Stream' })).toBe(false);
  });
  it('round-trip retry: env drift tidak mengubah mode/budget job yang beku', () => {
    const snap = buildConfigSnapshot({ GEMINI_INPUT_MODE: 'stream', EVIDENCE_MAX_FRAMES: '20' });
    const drifted = { GEMINI_INPUT_MODE: 'evidence', EVIDENCE_MAX_FRAMES: '50' };
    const applied = { ...drifted, ...configSnapshotToEnvPatch(snap) };
    const resnap = buildConfigSnapshot(applied);
    expect(resnap.GEMINI_INPUT_MODE).toBe('stream');
    expect(resnap.EVIDENCE_MAX_FRAMES).toBe(20);
    // snapshot default pun tetap menulis patch explisit (kunci anti-drift)
    expect(configSnapshotToEnvPatch(buildConfigSnapshot({})).GEMINI_INPUT_MODE).toBe('evidence');
  });
});
