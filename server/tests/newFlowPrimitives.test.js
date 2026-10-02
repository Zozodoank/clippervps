import { describe, it, expect } from 'vitest';
import { interleaveBySource, checkUtilization } from '../utils/clipOrdering.js';
import { parseBatchVerdict, parseWindowSelection } from '../services/aiService.js';

// ── L5: zigzag antar sumber (keputusan 2b: per window/kelompok klip) ──
describe('interleaveBySource (pola zigzag V1->V2->V1)', () => {
  it('mengembalikan [] untuk input kosong/bukan array', () => {
    expect(interleaveBySource([])).toEqual([]);
    expect(interleaveBySource(null)).toEqual([]);
  });

  it('satu sumber -> idempoten, tidak ada yang dibuang', () => {
    const items = [{ sourceId: 'A' }, { sourceId: 'A' }, { sourceId: 'A' }];
    expect(interleaveBySource(items)).toEqual(items);
  });

  it('dua sumber seimbang -> bergantian sempurna', () => {
    const items = [
      { sourceId: 'A', n: 1 }, { sourceId: 'A', n: 2 },
      { sourceId: 'B', n: 3 }, { sourceId: 'B', n: 4 },
    ];
    const out = interleaveBySource(items);
    expect(out.map((x) => x.sourceId)).toEqual(['A', 'B', 'A', 'B']);
    expect(out.length).toBe(4);
  });

  it('sumber mayoritas membuka zigzag & sisa di-tail tanpa hilang', () => {
    const items = [
      { sourceId: 'B' },
      { sourceId: 'A' }, { sourceId: 'A' }, { sourceId: 'A' },
    ];
    const out = interleaveBySource(items).map((x) => x.sourceId);
    // A punya 3 (mayoritas) -> mulai dari A, lalu selang-seling, sisa A menempel di ekor.
    expect(out[0]).toBe('A');
    expect(out.sort()).toEqual(['A', 'A', 'A', 'B'].sort());
    expect(out.length).toBe(4);
  });

  it('mendukung getKey kustom (mis. grouping window)', () => {
    const windows = [{ src: 'A' }, { src: 'A' }, { src: 'C' }];
    const out = interleaveBySource(windows, { getKey: (w) => w.src });
    expect(out.length).toBe(3);
    expect(out[0].src).toBe('A');
  });

  it('invarian L6: jumlah keluar == masuk selalu (checkUtilization)', () => {
    const items = [{ sourceId: 'A' }, { sourceId: 'B' }, { sourceId: 'A' }, { sourceId: 'A' }];
    const out = interleaveBySource(items);
    expect(checkUtilization(items.length, out.length).ok).toBe(true);
    expect(checkUtilization(5, 3)).toEqual({ ok: false, dropped: 2 });
  });
});

// ── L2: vonis batch Gemini (parser murni) ──
describe('parseBatchVerdict', () => {
  const candidates = [{ sourceId: 'v1' }, { sourceId: 'v2' }];

  it('lolos: produk cocok + bersih -> eligible', () => {
    const parsed = { verdicts: [{ index: 0, productMatch: true, faces: false, watermark: false, overlay: false, subtitle: false }] };
    const [v0] = parseBatchVerdict(parsed, candidates);
    expect(v0.eligible).toBe(true);
    expect(v0.sourceId).toBe('v1');
  });

  it('tolak: ada wajah -> eligible false (dihitung ulang, bukan percaya mentah)', () => {
    const parsed = { verdicts: [{ index: 0, productMatch: true, faces: true, eligible: true }] };
    expect(parseBatchVerdict(parsed, candidates)[0].eligible).toBe(false);
  });

  it('boolean string/angka dinormalisasi ("true"/1)', () => {
    const parsed = { verdicts: [{ index: 0, productMatch: 'true', faces: 0, watermark: 'false', overlay: 0, subtitle: '0' }] };
    const v0 = parseBatchVerdict(parsed, candidates)[0];
    expect(v0.productMatch).toBe(true);
    expect(v0.faces).toBe(false);
    expect(v0.eligible).toBe(true);
  });

  it('kandidat tanpa vonis -> gagal aman (tidak layak)', () => {
    const parsed = { verdicts: [{ index: 0, productMatch: true }] };
    const v1 = parseBatchVerdict(parsed, candidates)[1];
    expect(v1.eligible).toBe(false);
    expect(v1.reason).toMatch(/tidak dinilai/i);
  });
});

// ── L3: pemilihan window teks (parser murni) ──
describe('parseWindowSelection', () => {
  const segments = [
    { startSec: 0, endSec: 5 },
    { startSec: 5, endSec: 12 },
    { startSec: 12, endSec: 20 },
  ];

  it('meloloskan window valid di dalam rentang segmen', () => {
    const parsed = { windows: [{ startSec: 2, endSec: 9, scriptDraft: 'halo' }] };
    const [w] = parseWindowSelection(parsed, segments, 0);
    expect(w.startSec).toBe(2);
    expect(w.endSec).toBe(9);
    expect(w.durationSec).toBe(7);
  });

  it('membuang window mulai>=berakhir & non-angka', () => {
    const parsed = { windows: [{ startSec: 9, endSec: 3 }, { startSec: 'x', endSec: 'y' }, { startSec: 1, endSec: 4 }] };
    const out = parseWindowSelection(parsed, segments, 0);
    expect(out.length).toBe(1);
    expect(out[0].endSec).toBe(4);
  });

  it('meng-clamp endSec ke batas akhir segmen terakhir', () => {
    const parsed = { windows: [{ startSec: 15, endSec: 999 }] };
    const [w] = parseWindowSelection(parsed, segments, 0);
    expect(w.endSec).toBe(20);
  });

  it('memotong ke plafon durasi gabungan (maxTotalSec)', () => {
    const parsed = { windows: [{ startSec: 0, endSec: 6 }, { startSec: 6, endSec: 12 }, { startSec: 12, endSec: 20 }] };
    const out = parseWindowSelection(parsed, segments, 10);
    // window1 (6s) masuk, window2 (6s) -> total 12 > 10 -> dipotong.
    expect(out.length).toBe(1);
  });
});
