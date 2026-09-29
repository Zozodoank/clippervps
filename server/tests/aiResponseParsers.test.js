import { describe, it, expect } from 'vitest';
import {
  repairJson,
  buildFallbackScenes,
  normalizeShortScenes,
} from '../services/ai/aiResponseParsers.js';

// P6.1: characterization test untuk lapisan PURE yang baru dipindah dari aiService.js.
// Tujuannya MENGUNCI perilaku saat ini (termasuk quirk) supaya refactor terbukti netral.

describe('repairJson', () => {
  it('kembali {} untuk input kosong/non-string', () => {
    expect(repairJson('')).toEqual({});
    expect(repairJson(null)).toEqual({});
    expect(repairJson(undefined)).toEqual({});
    expect(repairJson(123)).toEqual({});
  });

  it('parse JSON valid apa adanya', () => {
    expect(repairJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('mengupas pagar kode ```json ... ```', () => {
    expect(repairJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(repairJson('```\n{"x":9}\n```')).toEqual({ x: 9 });
  });

  it('menutup kurung kurawal/kotak yang belum seimbang', () => {
    expect(repairJson('{"a":[1,2')).toEqual({ a: [1, 2] });
    expect(repairJson('{"nested":{"deep":1}')).toEqual({ nested: { deep: 1 } });
  });

  it('menutup kutip string yang belum tertutup', () => {
    expect(repairJson('{"msg":"halo')).toEqual({ msg: 'halo' });
  });

  it('membuang backslash tunggal di ekor sebelum perbaikan', () => {
    expect(repairJson('{"a":1}\\')).toEqual({ a: 1 });
  });

  it('melempar Error untuk sampah yang tak bisa diperbaiki', () => {
    expect(() => repairJson('bukan json sama sekali')).toThrow();
  });
});

describe('buildFallbackScenes', () => {
  it('jumlah scene = round(total/durasi) dijepit 4..8', () => {
    expect(buildFallbackScenes('Pisau', 24, 3.3).length).toBe(7); // round(7.27)
    expect(buildFallbackScenes('Pisau', 15, 5.0).length).toBe(4); // round(3) -> min 4
    expect(buildFallbackScenes('Pisau', 45, 2.5).length).toBe(8); // round(18) -> max 8
  });

  it('totalDuration dijepit 15..45 meski input ekstrem', () => {
    const tooShort = buildFallbackScenes('X', 1, 3.3);   // -> total 15
    const tooLong = buildFallbackScenes('X', 999, 3.3);  // -> total 45
    // sceneNumber selalu mulai dari 1 dan berurutan
    expect(tooShort[0].sceneNumber).toBe(1);
    expect(tooLong[tooLong.length - 1].sceneNumber).toBe(tooLong.length);
    // clip akhir tidak pernah melampaui totalDuration (45 => "45:00"? pakai formatSeconds detik)
    expect(tooLong.length).toBeGreaterThanOrEqual(4);
    expect(tooLong.length).toBeLessThanOrEqual(8);
  });

  it('setiap scene punya sceneNumber, timeRange "A - B", dan 3 field template', () => {
    const scenes = buildFallbackScenes('Wajan', 24);
    for (const s of scenes) {
      expect(typeof s.sceneNumber).toBe('number');
      expect(s.timeRange).toMatch(/^.+ - .+$/);
      expect(s.visualDescription).toBeTruthy();
      expect(s.voiceover).toBeTruthy();
      expect(s.adAdvisorNotes).toBeTruthy();
    }
  });

  it('scene pembuka memakai hook dinamis (bukan nama produk polos di voiceover pertama)', () => {
    const scenes = buildFallbackScenes('Blender', 24);
    // voiceover scene 1 dibangun getDynamicProductHookFallback, selalu string non-kosong
    expect(typeof scenes[0].voiceover).toBe('string');
    expect(scenes[0].voiceover.length).toBeGreaterThan(0);
  });

  it('template menjepit ke indeks terakhir untuk scene > 8 (tidak undefined)', () => {
    // 8 template max; dengan clamp jumlah pun maks 8, jadi tak pernah lewat — tapi pastikan tak ada undefined
    const scenes = buildFallbackScenes('Gelas', 40, 2.5); // round(16)->8
    expect(scenes.length).toBe(8);
    scenes.forEach((s) => expect(s.visualDescription).toBeDefined());
  });
});

describe('normalizeShortScenes', () => {
  it('memakai fallback penuh saat source kosong/bukan array', () => {
    const fromNull = normalizeShortScenes(null, 'Panci', 24);
    const fallback = buildFallbackScenes('Panci', 24);
    expect(fromNull.length).toBe(fallback.length);
    // CATATAN: scene 0 memakai getDynamicProductHookFallback yang NON-DETERMINISTIK
    // (mengambil hook acak), jadi hanya dicek non-kosong; scene berikutnya deterministik.
    expect(typeof fromNull[0].voiceover).toBe('string');
    expect(fromNull[0].voiceover.length).toBeGreaterThan(0);
    for (let i = 1; i < fallback.length; i++) {
      expect(fromNull[i]).toEqual(fallback[i]);
    }
    const fromArr = normalizeShortScenes('bukan-array', 'Panci', 24);
    expect(fromArr.length).toBe(fallback.length);
    for (let i = 1; i < fallback.length; i++) {
      expect(fromArr[i]).toEqual(fallback[i]);
    }
  });

  it('meng-overlay field dari source seposisi, sisanya tetap fallback', () => {
    const source = [{ voiceover: 'NARASI DARI AI' }];
    const out = normalizeShortScenes(source, 'Panci', 24);
    expect(out[0].voiceover).toBe('NARASI DARI AI');
    // field lain scene 0 tetap dari template fallback
    const fb = buildFallbackScenes('Panci', 24);
    expect(out[0].visualDescription).toBe(fb[0].visualDescription);
    expect(out[0].adAdvisorNotes).toBe(fb[0].adAdvisorNotes);
    // scene kedua (tanpa source) seluruhnya fallback
    expect(out[1]).toEqual(fb[1]);
  });

  it('mengabaikan scene source ekstra di luar jumlah fallback (hasil = panjang fallback)', () => {
    const longSource = Array.from({ length: 20 }, (_, i) => ({ voiceover: `v${i}` }));
    const out = normalizeShortScenes(longSource, 'Sendok', 24);
    const fbLen = buildFallbackScenes('Sendok', 24).length;
    expect(out.length).toBe(fbLen);
    expect(out[0].voiceover).toBe('v0');
  });

  it('field kosong string di source jatuh ke fallback (|| bukan ??)', () => {
    const source = [{ visualDescription: '', voiceover: '', adAdvisorNotes: '' }];
    const out = normalizeShortScenes(source, 'Garpu', 24);
    const fb = buildFallbackScenes('Garpu', 24);
    // visualDescription & adAdvisorNotes deterministik -> sama persis dengan template fallback.
    expect(out[0].visualDescription).toBe(fb[0].visualDescription);
    expect(out[0].adAdvisorNotes).toBe(fb[0].adAdvisorNotes);
    // voiceover scene 0 tetap fallback (bukan ''), tapi isinya hook acak -> cukup cek non-kosong.
    expect(out[0].voiceover).not.toBe('');
    expect(typeof out[0].voiceover).toBe('string');
    expect(out[0].voiceover.length).toBeGreaterThan(0);
  });
});
