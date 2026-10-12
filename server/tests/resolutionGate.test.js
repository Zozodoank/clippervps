import { describe, it, expect } from 'vitest';
import {
  checkVideoMetadataCompliance,
  evaluateSourceQualityGate,
  minShortEdge,
} from '../services/videoFilterService.js';

// Helper: metadata yang LOLOS semua gerbang lain (judul netral, durasi aman,
// productTitle kosong -> blok kesesuaian kategori dilewati). Hanya MUTU (resolusi
// sisi-terpendek + bitrate) yang divariasikan. Default = 1080p tier + bitrate sehat.
const meta = (over = {}) => ({
  id: 'vid_x',
  title: 'Review Alat Dapur Praktis',
  duration: 300,
  description: '',
  tags: [],
  maxWidth: 1920,
  maxHeight: 1080,
  bestVideoBitrateKbps: 3000,
  ...over,
});

// Probe tepercaya (ada cookies) -> gerbang keras >=1080p + floor bitrate ditegakkan.
const TRUSTED = { enforceResolution: true };
// Probe anonim (tanpa cookies, daftar format terpotong) -> gerbang dilewati agar tak massal tertolak.
const UNTRUSTED = { enforceResolution: false };

describe('Gerbang Mutu Sumber Pra-Gemini (via checkVideoMetadataCompliance) - wajib >=1080p + floor bitrate (probe tepercaya)', () => {
  it('lolos: landscape Full HD 1920x1080 + bitrate 3000', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 3000 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('lolos: vertikal 1080x1920 + bitrate 3000 (sisi terpendek 1080)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1080, maxHeight: 1920, bestVideoBitrateKbps: 3000 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('tolak: 720p landscape 1280x720 (sisi terpendek 720 < 1080)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1280, maxHeight: 720 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.sourceQualityRejected).toBe(true);
    expect(r.reason).toMatch(/1080p/);
  });

  it('tolak: 720p vertikal 720x1280 (sisi terpendek 720 < 1080)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 720, maxHeight: 1280 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/1080p/);
  });

  it('tolak: 480p 854x480 (sisi terpendek 480 < 1080)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 854, maxHeight: 480 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/1080p/);
  });

  it('tolak: 1080p tapi bitrate rendah 1200kbps (< floor 2500)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 1200 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.sourceQualityRejected).toBe(true);
    expect(r.reason).toMatch(/bitrate/i);
  });

  it('fail-open: resolusi tidak diketahui (0x0) tidak ditolak gerbang ini', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 0, maxHeight: 0 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('fail-open: 1080p tapi bitrate tak terukur (0) - jangan tolak', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 0 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('urutan: gerbang mutu diperiksa SEBELUM filter judul (vlog)', () => {
    // 720p + judul vlog -> harus ditolak karena MUTU (gerbang lebih dulu), bukan vlog.
    const lowResVlog = checkVideoMetadataCompliance(
      meta({ maxWidth: 1280, maxHeight: 720, title: 'Daily Vlog Hariku' }),
      '',
      TRUSTED
    );
    expect(lowResVlog.eligible).toBe(false);
    expect(lowResVlog.reason).toMatch(/1080p/);

    // 1080p sehat + judul vlog sama -> lolos gerbang mutu, lalu kena filter vlog (bukan mutu).
    const hdVlog = checkVideoMetadataCompliance(
      meta({ maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 3000, title: 'Daily Vlog Hariku' }),
      '',
      TRUSTED
    );
    expect(hdVlog.eligible).toBe(false);
    expect(hdVlog.sourceQualityRejected).toBeUndefined();
    expect(hdVlog.reason).not.toMatch(/1080p/);
  });
});

describe('Gerbang Mutu Sumber - probe anonim (tanpa cookies) tidak menolak massal', () => {
  it('480p TIDAK ditolak saat probe tidak terpercaya (hanya peringatan)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 854, maxHeight: 480 }), '', UNTRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('1080p bitrate rendah TIDAK ditolak saat probe tidak terpercaya', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 500 }), '', UNTRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('filter lain tetap aktif saat gerbang mutu dilewati (judul vlog tetap ditolak)', () => {
    const r = checkVideoMetadataCompliance(
      meta({ maxWidth: 640, maxHeight: 360, title: 'Daily Vlog Hariku' }),
      '',
      UNTRUSTED
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).not.toMatch(/1080p/);
  });
});

describe('Gerbang Durasi (checkVideoMetadataCompliance) - minimal 5 menit (default)', () => {
  it('tolak: video pendek 120s (< 300s) ditolak karena durasi', () => {
    const r = checkVideoMetadataCompliance(meta({ duration: 120 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/pendek/i);
    expect(r.reason).not.toMatch(/1080p/);
  });
  it('lolos: tepat 300s (5 menit)', () => {
    const r = checkVideoMetadataCompliance(meta({ duration: 300 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });
  it('tolak: video terlalu panjang 1000s (> 900s)', () => {
    const r = checkVideoMetadataCompliance(meta({ duration: 1000 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/panjang/i);
  });
});

describe('evaluateSourceQualityGate + minShortEdge (murni)', () => {
  it('minShortEdge mengukur sisi terpendek lintas orientasi', () => {
    expect(minShortEdge(1920, 1080)).toBe(1080);
    expect(minShortEdge(1080, 1920)).toBe(1080);
    expect(minShortEdge(1280, 720)).toBe(720);
    expect(minShortEdge(720, 1280)).toBe(720);
    // satu sisi tak diketahui -> pakai sisi yang diketahui (maks)
    expect(minShortEdge(0, 1080)).toBe(1080);
  });

  it('untrusted probe -> pass (note untrusted_probe), meski 480p', () => {
    const g = evaluateSourceQualityGate({ maxWidth: 854, maxHeight: 480 }, { enforceResolution: false });
    expect(g.pass).toBe(true);
    expect(g.note).toBe('untrusted_probe');
  });

  it('resolusi tak diketahui -> pass (note unknown), meski enforce', () => {
    const g = evaluateSourceQualityGate({ maxWidth: 0, maxHeight: 0 }, { enforceResolution: true });
    expect(g.pass).toBe(true);
    expect(g.note).toBe('unknown');
  });

  it('tolak short-edge di bawah ambang (override minShortEdge)', () => {
    const g = evaluateSourceQualityGate(
      { maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 3000 },
      { enforceResolution: true, minShortEdge: 1440 }
    );
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/1440/);
  });

  it('tolak bitrate di bawah floor (override minBitrateKbps)', () => {
    const g = evaluateSourceQualityGate(
      { maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 2000 },
      { enforceResolution: true, minBitrateKbps: 2500 }
    );
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/bitrate/i);
  });

  it('bitrate 0 (tak terukur) -> jangan tolak meski enforce', () => {
    const g = evaluateSourceQualityGate(
      { maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 0 },
      { enforceResolution: true, minBitrateKbps: 2500 }
    );
    expect(g.pass).toBe(true);
  });

  it('lolos penuh: >=1080p + bitrate sehat', () => {
    const g = evaluateSourceQualityGate(
      { maxWidth: 1920, maxHeight: 1080, bestVideoBitrateKbps: 3000 },
      { enforceResolution: true }
    );
    expect(g.pass).toBe(true);
  });

  it('enforce dapat di-set via opts.enforce === true (bukan hanya enforceResolution)', () => {
    const g = evaluateSourceQualityGate({ maxWidth: 1280, maxHeight: 720 }, { enforce: true });
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/1080p/);
  });
});
