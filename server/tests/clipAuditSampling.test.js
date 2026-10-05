import { describe, it, expect } from 'vitest';
import { buildAuditSampleTimestamps } from '../utils/clipAuditSampling.js';

// ============================================================================
// Clamp sampling audit klip ke durasi NYATA file (regresi fix 2026-10-05:
// file --download-sections terpotong ~2s untuk rencana 22s -> rentetan FFmpeg
// "code 234 / Could not open encoder before EOF" di semua timestamp sesudahnya).
// ============================================================================

describe('buildAuditSampleTimestamps', () => {
  it('file utuh (probe gagal / fileDur 0) -> identik perilaku lama: offset dari durasi rencana', () => {
    const ts = buildAuditSampleTimestamps({ plannedDur: 6, fileDur: 0, startSeconds: 10, sourceOffsetSec: 0 });
    // Perilaku lama: 0.2..5.8 step 0.4 + endOffset -> 15 titik.
    expect(ts).toEqual([0.2, 0.6, 1.0, 1.4, 1.8, 2.2, 2.6, 3.0, 3.4, 3.8, 4.2, 4.6, 5.0, 5.4, 5.8].map(v => Math.round((10 + v) * 100) / 100));
    expect(ts.every((v) => v >= 10.2)).toBe(true);
  });

  it('file terpotong (rencana 6s, nyata 2s) -> semua timestamp <= akhir file nyata - margin', () => {
    const ts = buildAuditSampleTimestamps({ plannedDur: 6, fileDur: 2.0, startSeconds: 0, sourceOffsetSec: 0 });
    expect(ts.length).toBeGreaterThan(0);
    // effDur = max(0.4, 2.0 - 0.1) = 1.9 -> titik akhir 1.7; TIDAK ADA yang >= 2.0 (di bawah EOF).
    expect(Math.max(...ts)).toBeLessThanOrEqual(1.9);
    expect(ts).toContain(0.2);
  });

  it('sourceOffsetSec section: timestamp relatif ke AWAL FILE, hasil tidak pernah negatif', () => {
    const ts = buildAuditSampleTimestamps({ plannedDur: 4, fileDur: 4, startSeconds: 165, sourceOffsetSec: 165 });
    expect(ts[0]).toBe(0.2);
    expect(Math.max(...ts)).toBeLessThanOrEqual(3.9);
    const clamped = buildAuditSampleTimestamps({ plannedDur: 4, fileDur: 4, startSeconds: 3, sourceOffsetSec: 10 });
    expect(Math.min(...clamped)).toBe(0); // clamp bawah, bukan seek negatif
  });

  it('durasi rencana dip-floor 1.5 dan default 3.3 saat undefined', () => {
    const short = buildAuditSampleTimestamps({ plannedDur: 0.2, fileDur: 0, startSeconds: 0, sourceOffsetSec: 0 });
    // dur = 1.5 -> offsets 0.2, 0.6, 1.0, endOffset 1.3.
    expect(short).toEqual([0.2, 0.6, 1.0, 1.3]);
    const undef = buildAuditSampleTimestamps({ startSeconds: 0 });
    expect(undef[undef.length - 1]).toBeCloseTo(3.1, 1); // default 3.3 -> end 3.1
  });

  it('file SEDIKIT lebih pendek dari rencana (>= 0.8x) tetap diaudit dengan clamp, tidak di-zero-kan', () => {
    const ts = buildAuditSampleTimestamps({ plannedDur: 5, fileDur: 4.2, startSeconds: 0, sourceOffsetSec: 0 });
    expect(Math.max(...ts)).toBeLessThanOrEqual(4.1); // effDur = 4.1
    expect(ts.length).toBeGreaterThanOrEqual(4);
  });
});
