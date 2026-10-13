import { describe, it, expect } from 'vitest';
import { planSectionDownloads, pickSectionFor, applyClusterPaths } from '../services/renderSections.js';

describe('planSectionDownloads (hemat kuota: grouping klip -> rentang unduhan)', () => {
  it('klip berdekatan (gap <= gapSec) => satu cluster dengan union + padding', () => {
    const clips = [
      { startSeconds: 100, duration: 5 },
      { startSeconds: 108, duration: 4 }, // gap 3s -> gabung
    ];
    const r = planSectionDownloads(clips, { padSec: 2, tailPadSec: 5, gapSec: 15 });
    expect(r.length).toBe(1);
    // contentStart=100-2=98 ; contentEnd=112+5=117
    expect(r[0].startSec).toBeCloseTo(98, 3);
    expect(r[0].endSec).toBeCloseTo(117, 3);
    expect(r[0].sourceOffsetSec).toBeCloseTo(98, 3);
    expect(r[0].refs.length).toBe(2);
  });

  it('klip berjauhan (gap > gapSec) => cluster terpisah', () => {
    const clips = [
      { startSeconds: 10, duration: 4 },
      { startSeconds: 200, duration: 6 }, // gap jauh
    ];
    const r = planSectionDownloads(clips, { padSec: 2, tailPadSec: 5, gapSec: 15 });
    expect(r.length).toBe(2);
    expect(r[0].sourceOffsetSec).toBeCloseTo(8, 3);
    expect(r[1].sourceOffsetSec).toBeCloseTo(198, 3);
  });

  it('sourceOffsetSec == startSec cluster (dipakai renderer: -ss = startSeconds - sourceOffsetSec)', () => {
    const clips = [{ startSeconds: 50, duration: 3 }];
    const r = planSectionDownloads(clips, { padSec: 2, tailPadSec: 5 });
    const fileStartForClip = r[0].startSec; // timeline file dimulai di sourceOffsetSec
    // potong klip global 50s relatif file:
    const minusSs = 50 - r[0].sourceOffsetSec;
    expect(r[0].sourceOffsetSec).toBe(fileStartForClip);
    expect(minusSs).toBeCloseTo(2, 3); // 50 - 48 = 2 -> tepat di dalam file
  });

  it('clamp kepala ke 0 dan ekor ke videoDuration', () => {
    const clips = [{ startSeconds: 1, duration: 3 }];
    const r = planSectionDownloads(clips, { padSec: 5, tailPadSec: 5, videoDuration: 40 });
    expect(r[0].startSec).toBe(0); // 1-5 => clamp 0
    expect(r[0].endSec).toBeCloseTo(9, 3); // 4+5

    const tail = planSectionDownloads([{ startSeconds: 38, duration: 3 }], { padSec: 2, tailPadSec: 10, videoDuration: 40 });
    expect(tail[0].endSec).toBeCloseTo(40, 3); // clamp ke durasi video
  });

  it('tanpa videoDuration => tidak clamp atas', () => {
    const r = planSectionDownloads([{ startSeconds: 100, duration: 5 }], { padSec: 2, tailPadSec: 5 });
    expect(r[0].endSec).toBeCloseTo(110, 3); // tak dibatasi
    expect(Number.isFinite(r[0].endSec)).toBe(true);
  });

  it('sorti tidak bergantung urutan input & refs mempertahankan identitas objek', () => {
    const a = { startSeconds: 200, duration: 4 };
    const b = { startSeconds: 10, duration: 4 };
    const r = planSectionDownloads([a, b], { padSec: 2, tailPadSec: 5, gapSec: 15 });
    expect(r.length).toBe(2);
    expect(r[0].sourceOffsetSec).toBeCloseTo(8, 3); // klip b dulu
    expect(r[0].refs).toContain(b);
    expect(r[1].refs).toContain(a); // identitas objek utuh untuk mutasi _cluster
  });

  it('buang klip tanpa startSeconds/duration valid', () => {
    const r = planSectionDownloads(
      [{ startSeconds: 50, duration: 3 }, { startSeconds: NaN, duration: 3 }, { startSeconds: 10 }, { startSeconds: 5, duration: 0 }],
      { padSec: 2, tailPadSec: 5, gapSec: 15 },
    );
    expect(r.length).toBe(1);
    expect(r[0].refs.length).toBe(1);
  });

  it('cluster muat penuh [startSeconds, startSeconds+duration+tailPad] tiap ref (syarat rebase renderer)', () => {
    const clips = [
      { startSeconds: 20, duration: 6 },
      { startSeconds: 28, duration: 8 }, // gabung cluster pertama
      { startSeconds: 120, duration: 5 }, // cluster kedua
    ];
    const r = planSectionDownloads(clips, { padSec: 2, tailPadSec: 5, gapSec: 15 });
    expect(r.length).toBe(2);
    for (const cluster of r) {
      for (const ref of cluster.refs) {
        expect(cluster.startSec).toBeLessThanOrEqual(ref.startSeconds); // kepala tidak memotong klip
        expect(cluster.endSec).toBeGreaterThanOrEqual(ref.startSeconds + ref.duration); // ekor memuat durasi penuh
      }
    }
  });

  it('input kosong/tidak array => array kosong', () => {
    expect(planSectionDownloads([])).toEqual([]);
    expect(planSectionDownloads(undefined)).toEqual([]);
  });
});

// ============================================================================
// pickSectionFor - katalog segmen untuk klip pemulihan pasca-audit (Fix 2).
// Menjamin klip dibaca dari file segmen yang benar, bukan file pertama kandidat.
// ============================================================================
describe('pickSectionFor (katalog segmen -> file yang memuat waktu global)', () => {
  const sections = [
    { videoPath: 'seg0.mp4', sourceOffsetSec: 8, endSec: 31 },
    { videoPath: 'seg1.mp4', sourceOffsetSec: 118, endSec: 133 },
  ];

  it('dalam rentang -> file yang memuat + offset benar', () => {
    expect(pickSectionFor(sections, 20, 3.8)).toEqual({ videoPath: 'seg0.mp4', sourceOffsetSec: 8 });
    expect(pickSectionFor(sections, 120, 0)).toEqual({ videoPath: 'seg1.mp4', sourceOffsetSec: 118 });
  });

  it('span tidak muat sebelum EOF -> section tsb ditolak', () => {
    // t=28, span 3.8 -> 31.8 >= 31-0.1 -> seg0 TIDAK muat; tidak ada lain -> null.
    expect(pickSectionFor(sections, 28, 3.8)).toBeNull();
    // Tanpa span, t=28 tetap di dalam seg0.
    expect(pickSectionFor(sections, 28, 0)).toEqual({ videoPath: 'seg0.mp4', sourceOffsetSec: 8 });
  });

  it('waktu di luar semua section -> null (bukan fallback ke file pertama)', () => {
    expect(pickSectionFor(sections, 60)).toBeNull();
    expect(pickSectionFor(sections, 7)).toBeNull(); // sebelum sourceOffset section pertama
    expect(pickSectionFor([], 20)).toBeNull();
    expect(pickSectionFor(undefined, 20)).toBeNull();
    expect(pickSectionFor(sections, NaN)).toBeNull();
  });

  it('video penuh (sourceOffsetSec 0, endSec MAX_SAFE_INTEGER) selalu memuat', () => {
    const full = [{ videoPath: 'full.mp4', sourceOffsetSec: 0, endSec: Number.MAX_SAFE_INTEGER }];
    expect(pickSectionFor(full, 99999, 3.8)).toEqual({ videoPath: 'full.mp4', sourceOffsetSec: 0 });
  });

  it('entri tanpa videoPath dilewati', () => {
    expect(pickSectionFor([{ sourceOffsetSec: 0, endSec: 100 }, { videoPath: 'b.mp4', sourceOffsetSec: 0, endSec: 100 }], 10)).toEqual({ videoPath: 'b.mp4', sourceOffsetSec: 0 });
  });
});

// ============================================================================
// applyClusterPaths - pemetaan _cluster -> videoPath/sourceOffsetSec (pure, jalur produksi).
// ============================================================================
describe('applyClusterPaths (petakan file segmen/unduh penuh ke klip)', () => {
  it('klip ber-_cluster pakai file segmen + offset; _cluster dihapus dari hasil', () => {
    const clips = [{ startSeconds: 165, duration: 6, candidateIndex: 1, _cluster: { videoPath: 'segA.mp4', sourceOffsetSec: 163 } }];
    const out = applyClusterPaths(clips, new Map());
    expect(out.length).toBe(1);
    expect(out[0].videoPath).toBe('segA.mp4');
    expect(out[0].sourceOffsetSec).toBe(163);
    expect(out[0]._cluster).toBeUndefined();
    expect(out[0].startSeconds).toBe(165); // waktu tetap GLOBAL (renderer kurangkan offset)
  });

  it('klip tanpa _cluster pakai fallback map dengan sourceOffsetSec 0', () => {
    const map = new Map([[0, 'full0.mp4'], [2, 'full2.mp4']]);
    const out = applyClusterPaths([
      { startSeconds: 10, duration: 4 },
      { startSeconds: 20, duration: 4, candidateIndex: 2 },
    ], map);
    expect(out.map((c) => c.videoPath)).toEqual(['full0.mp4', 'full2.mp4']);
    expect(out.every((c) => c.sourceOffsetSec === 0)).toBe(true);
  });

  it('sumber hilang -> klip DIBUANG (bukan diremap ke video lain) + onMissing dipanggil', () => {
    const seen = [];
    const out = applyClusterPaths(
      [{ startSeconds: 10, duration: 4, candidateIndex: 7 }],
      new Map([[0, 'full0.mp4']]),
      { onMissing: (idx) => seen.push(idx) },
    );
    expect(out).toEqual([]);
    expect(seen).toEqual([7]);
  });

  it('fallback boleh berupa objek biasa (bukan Map)', () => {
    const out = applyClusterPaths([{ startSeconds: 5, duration: 3, candidateIndex: 1 }], { 1: 'x.mp4' });
    expect(out[0].videoPath).toBe('x.mp4');
  });
});
