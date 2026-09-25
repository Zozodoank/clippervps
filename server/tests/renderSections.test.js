import { describe, it, expect } from 'vitest';
import { planSectionDownloads } from '../services/renderSections.js';

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

  it('input kosong/tidak array => array kosong', () => {
    expect(planSectionDownloads([])).toEqual([]);
    expect(planSectionDownloads(undefined)).toEqual([]);
  });
});
