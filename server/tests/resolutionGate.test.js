import { describe, it, expect } from 'vitest';
import { checkVideoMetadataCompliance } from '../services/videoFilterService.js';

// Helper: metadata dasar yang LOLOS semua gerbang lain (judul netral, durasi aman,
// productTitle kosong -> blok kesesuaian kategori dilewati). Hanya resolusi divariasikan.
const meta = (over = {}) => ({
  id: 'vid_x',
  title: 'Review Alat Dapur Praktis',
  duration: 120,
  description: '',
  tags: [],
  maxWidth: 1280,
  maxHeight: 720,
  ...over,
});

// Probe dapat dipercaya (ada cookies) -> gerbang keras 720p ditegakkan.
const TRUSTED = { enforceResolution: true };
// Probe anonim (tanpa cookies, dibatasi 360p) -> gerbang keras dilewati agar tidak semua tertolak.
const UNTRUSTED = { enforceResolution: false };

describe('Gerbang Resolusi Awal (checkVideoMetadataCompliance) - wajib 720p (probe terpercaya)', () => {
  it('lolos: landscape 720p tepat (1280x720)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1280, maxHeight: 720 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('lolos: short vertikal 720x1280 (sisi terpendek 720)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 720, maxHeight: 1280 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('lolos: Full HD 1920x1080', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 1920, maxHeight: 1080 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('tolak: 480p landscape 854x480 (sisi terpendek 480 < 720)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 854, maxHeight: 480 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/720p/);
  });

  it('tolak: short vertikal buram 540x960 (sisi terpendek 540 < 720)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 540, maxHeight: 960 }), '', TRUSTED);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/720p/);
  });

  it('fail-open: resolusi tidak diketahui (0x0) tidak ditolak oleh gerbang ini', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 0, maxHeight: 0 }), '', TRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('urutan: resolusi rendah diperiksa SEBELUM filter format judul (vlog)', () => {
    // 480p + judul vlog -> harus ditolak karena RESOLUSI (gerbang 1A lebih dulu), bukan vlog.
    const lowResVlog = checkVideoMetadataCompliance(
      meta({ maxWidth: 854, maxHeight: 480, title: 'Daily Vlog Hariku' }),
      '',
      TRUSTED
    );
    expect(lowResVlog.eligible).toBe(false);
    expect(lowResVlog.reason).toMatch(/720p/);

    // 720p + judul vlog yang sama -> lolos gerbang resolusi, lalu kena filter vlog.
    const hdVlog = checkVideoMetadataCompliance(
      meta({ maxWidth: 1280, maxHeight: 720, title: 'Daily Vlog Hariku' }),
      '',
      TRUSTED
    );
    expect(hdVlog.eligible).toBe(false);
    expect(hdVlog.reason).not.toMatch(/720p/);
  });
});

describe('Gerbang Resolusi - probe anonim (tanpa cookies) tidak menolak semua kandidat', () => {
  it('480p TIDAK ditolak saat probe tidak terpercaya (hanya peringatan)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 640, maxHeight: 360 }), '', UNTRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('360p TIDAK ditolak saat probe tidak terpercaya (kasus Termux tanpa cookies)', () => {
    const r = checkVideoMetadataCompliance(meta({ maxWidth: 854, maxHeight: 480 }), '', UNTRUSTED);
    expect(r.eligible).toBe(true);
  });

  it('filter lain tetap aktif saat gerbang resolusi dilewati (judul vlog tetap ditolak)', () => {
    const r = checkVideoMetadataCompliance(
      meta({ maxWidth: 640, maxHeight: 360, title: 'Daily Vlog Hariku' }),
      '',
      UNTRUSTED
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).not.toMatch(/720p/);
  });
});
