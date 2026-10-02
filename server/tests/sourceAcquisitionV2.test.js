import { describe, it, expect } from 'vitest';
import {
  rankByMidDuration,
  pickEligibleSources,
  buildAcquisitionPlan,
  buildLegacyStructuresFromV2,
} from '../worker/sourceAcquisitionV2.js';
import { interleaveBySource } from '../utils/clipOrdering.js';

describe('rankByMidDuration (prioritas durasi menengah)', () => {
  it('memakai median target; tanpa durasi diletakkan di belakang secara stabil', () => {
    const pool = [
      { url: 'short', duration: 60 },
      { url: 'nodur' },
      { url: 'mid', duration: 470 },
      { url: 'long', duration: 890 },
    ];
    const out = rankByMidDuration(pool, 480);
    expect(out[0].url).toBe('mid');
    expect(out[out.length - 1].url).toBe('nodur');
    expect(out.length).toBe(4);
  });
  it('array kosong / null aman', () => {
    expect(rankByMidDuration([])).toEqual([]);
    expect(rankByMidDuration(null)).toEqual([]);
  });
});

describe('pickEligibleSources (keputusan 4b: kejar 2 sumber)', () => {
  const gated = [{ sourceId: 'A' }, { sourceId: 'B' }, { sourceId: 'C' }];
  it('mengambil maksimal requireN yang eligible berdasar indeks', () => {
    const verdicts = [
      { index: 0, eligible: true },
      { index: 1, eligible: false },
      { index: 2, eligible: true },
    ];
    const chosen = pickEligibleSources(verdicts, gated, 2);
    expect(chosen.map((c) => c.sourceId)).toEqual(['A', 'C']);
  });
  it('berhenti saat requireN tercapai meski ada eligible lain', () => {
    const verdicts = [
      { index: 0, eligible: true },
      { index: 1, eligible: true },
      { index: 2, eligible: true },
    ];
    expect(pickEligibleSources(verdicts, gated, 2).length).toBe(2);
  });
  it('indeks tak valid diabaikan', () => {
    expect(pickEligibleSources([{ index: 99, eligible: true }], gated, 2)).toEqual([]);
  });
});

describe('buildAcquisitionPlan (L5 zigzag + rangkai naskah)', () => {
  it('menyusun zigzag window antar sumber & menggabungkan draf naskah', () => {
    const sourcesData = [
      { sourceId: 'A', windows: [
        { startSec: 0, endSec: 5, scriptDraft: 'a1' },
        { startSec: 10, endSec: 15, scriptDraft: 'a2' },
      ] },
      { sourceId: 'B', windows: [
        { startSec: 3, endSec: 8, scriptDraft: 'b1' },
      ] },
    ];
    const plan = buildAcquisitionPlan(sourcesData, interleaveBySource);
    expect(plan.totalWindows).toBe(3);
    // A punya 2 window (mayoritas) -> membuka zigzag, lalu selang-seling, sisa tail.
    expect(plan.orderedWindows[0].sourceId).toBe('A');
    const seq = plan.orderedWindows.map((w) => w.sourceId);
    expect(seq.sort()).toEqual(['A', 'A', 'B'].sort());
    expect(plan.scriptDraft.split(' ').sort()).toEqual(['a1', 'a2', 'b1'].sort());
  });
  it('satu sumber: plan tetap berisi semua window (tidak dibuang)', () => {
    const plan = buildAcquisitionPlan([{ sourceId: 'A', windows: [{ startSec: 0, endSec: 5, scriptDraft: 'x' }] }], interleaveBySource);
    expect(plan.orderedWindows.length).toBe(1);
    expect(plan.scriptDraft).toBe('x');
  });
});

describe('buildLegacyStructuresFromV2 (kontrak unduh/render hilir)', () => {
  it('memetakan window -> clips dgn candidateIndex + url sumber yang benar', () => {
    const sources = [
      { sourceId: 'A', url: 'http://a', meta: { duration: 500, title: 'VidA' } },
      { sourceId: 'B', url: 'http://b', meta: { duration: 400, title: 'VidB' } },
    ];
    const windows = [
      { sourceId: 'A', startSec: 10, endSec: 18, scriptDraft: 'satu' },
      { sourceId: 'B', startSec: 4, endSec: 12, scriptDraft: 'dua' },
    ];
    const { hl, candidateResults } = buildLegacyStructuresFromV2(sources, windows);
    expect(candidateResults.length).toBe(2);
    expect(candidateResults[0].candidate.url).toBe('http://a');
    expect(hl.clips.length).toBe(2);
    // candidateIndex harus merujuk baris candidateResults sumber masing-masing.
    expect(hl.clips[0].candidateIndex).toBe(0);
    expect(hl.clips[1].candidateIndex).toBe(1);
    expect(hl.clips[0].candidateUrl).toBe('http://a');
    expect(hl.clips[1].duration).toBe(8);
    expect(hl.pipelineVersion).toBe('v2_batch');
    // Kontrak yang dibaca blok download: setiap clip punya startSeconds/endSeconds & indeks valid.
    for (const c of hl.clips) {
      expect(typeof c.startSeconds).toBe('number');
      expect(Number.isInteger(c.candidateIndex)).toBe(true);
      expect(candidateResults[c.candidateIndex]).toBeTruthy();
    }
  });
  it('sumber tak dikenal -> candidateIndex fallback 0 (tidak crash)', () => {
    const { hl } = buildLegacyStructuresFromV2([{ sourceId: 'A', url: 'http://a', meta: {} }], [{ sourceId: 'Z', startSec: 0, endSec: 5 }]);
    expect(hl.clips[0].candidateIndex).toBe(0);
  });
  it('input kosong aman', () => {
    const { hl, candidateResults } = buildLegacyStructuresFromV2([], []);
    expect(candidateResults).toEqual([]);
    expect(hl.clips).toEqual([]);
    expect(hl.duration).toBe(0);
  });
});
