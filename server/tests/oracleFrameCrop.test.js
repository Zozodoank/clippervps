import { describe, it, expect } from 'vitest';
import { buildOracleFrameFilter, oracleFrameMode } from '../services/vlmOracleService.js';

// ============================================================================
// Zoom-penuh Oracle (mandate user 2026-10-13): frame yang dikirim ke
// Qwen2.5-VL-3B 4bit = crop TENGAH area tajam di antara dua bar atas-bawah
// sampai rasio 9:16, lalu scale+pad penjaga pembulatan ke kanvas — TANPA bar
// letterbox. Murni string/geometri; tanpa ffmpeg.
// ============================================================================

const CROP_PREFIX = `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',`;

describe('buildOracleFrameFilter (crop-tengah 9:16 zoom-penuh)', () => {
  it('mode crop ON: filter diawali crop tengah 9:16 lalu scale+pad ke kanvas eksak', () => {
    const vf = buildOracleFrameFilter({ width: 198, height: 352 });
    expect(vf.startsWith(CROP_PREFIX)).toBe(true);
    expect(vf).toContain('scale=198:352:force_original_aspect_ratio=decrease');
    expect(vf).toContain('pad=198:352:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(vf.endsWith(',setsar=1')).toBe(true);
  });

  it('mode crop OFF (VLM_ORACLE_CENTER_CROP=0): identik letterbox lama — kill-switch terkunci', () => {
    const legacy = `scale=198:352:force_original_aspect_ratio=decrease,pad=198:352:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    expect(buildOracleFrameFilter({ width: 198, height: 352 }, { centerCrop: false })).toBe(legacy);
  });

  it('tile grid 270x480 memakai formula yang sama (konsisten dengan frame tunggal)', () => {
    const tile = buildOracleFrameFilter({ width: 270, height: 480 });
    expect(tile.startsWith(CROP_PREFIX)).toBe(true);
    expect(tile).toContain('scale=270:480:force_original_aspect_ratio=decrease');
    expect(tile).toContain('pad=270:480:(ow-iw)/2:(oh-ih)/2:color=black');
  });

  it('kontrak geometri min(iw,ih*9/16) / min(ih,iw*16/9): crop selalu tengah 9:16 muat di dalam frame', () => {
    // Ekspresi ffmpeg dievaluasi manual untuk tiga kelas sumber.
    const outOf = (iw, ih) => ({
      w: Math.min(iw, ih * 9 / 16),
      h: Math.min(ih, iw * 16 / 9),
    });
    // 16:9 (1920x1080): seluruh tinggi dipakai, lebar dipotong ke 607.5 -> area tengah.
    const wide = outOf(1920, 1080);
    expect(wide.h).toBe(1080);
    expect(wide.w).toBeCloseTo(607.5, 1);
    expect(wide.w / wide.h).toBeCloseTo(9 / 16, 6);
    // 9:16 (1080x1920, Shorts/Reels): no-op — crop = seluruh frame.
    const portrait = outOf(1080, 1920);
    expect(portrait).toEqual({ w: 1080, h: 1920 });
    // Sangat tinggi 1:3 (600x1800): seluruh lebar dipakai, tinggi dipotong ke 1066.7.
    const tall = outOf(600, 1800);
    expect(tall.w).toBe(600);
    expect(tall.h).toBeCloseTo(1066.67, 1);
    expect(tall.w / tall.h).toBeCloseTo(9 / 16, 4);
    // Persegi (1080x1080): seluruh tinggi dipakai, lebar dipotong ke 607.5.
    const square = outOf(1080, 1080);
    expect(square.h).toBe(1080);
    expect(square.w).toBeCloseTo(607.5, 1);
  });
});

describe('oracleFrameMode (kill-switch + pemisahan cache)', () => {
  it('default ON: unset / "1" / kosong-kecuali-0 -> crop aktif', () => {
    expect(oracleFrameMode({}).centerCrop).toBe(true);
    expect(oracleFrameMode({ VLM_ORACLE_CENTER_CROP: '1' }).centerCrop).toBe(true);
    expect(oracleFrameMode({ VLM_ORACLE_CENTER_CROP: 'true' }).centerCrop).toBe(true);
  });

  it('"0" saja yang mematikan (pola RENDER_DOWNLOAD_SECTIONS)', () => {
    expect(oracleFrameMode({ VLM_ORACLE_CENTER_CROP: '0' }).centerCrop).toBe(false);
    expect(oracleFrameMode({ VLM_ORACLE_CENTER_CROP: ' 0 ' }).centerCrop).toBe(false);
  });

  it('tag direktori + prefix cache BERBEDA antar mode -> salinan letterbox lama tak termakan crop baru', () => {
    const on = oracleFrameMode({});
    const off = oracleFrameMode({ VLM_ORACLE_CENTER_CROP: '0' });
    expect(on.dirTag).toBe('portrait9x16crop');
    expect(off.dirTag).toBe('portrait9x16');
    expect(on.dirTag).not.toBe(off.dirTag);
    expect(on.cachePrefix).not.toBe(off.cachePrefix);
  });
});
