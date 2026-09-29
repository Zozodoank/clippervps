// P2 JARING PENGAMAN — Tes karakterisasi subtitleService (generateAssSubtitles & helper waktu).
// Mengunci transform teks & struktur ASS yang menjadi fondasi render, agar refactor P6 aman.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateAssSubtitles,
  parseAssTimeToSeconds,
  scaleAssSubtitles,
  generateSrtSubtitles,
} from '../services/subtitleService.js';

let tmpDir;
const assPath = (name) => path.join(tmpDir, name);
const readDialogueLines = (content) => content.split(/\r?\n/).filter((l) => l.startsWith('Dialogue: 0,'));

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-sub-'));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('generateAssSubtitles — struktur header & sinkronisasi', () => {
  it('menulis file .ass dengan header kanvas 1080x1920 & style Arial 42 MarginV 360', () => {
    const p = assPath('header.ass');
    const ret = generateAssSubtitles('Halo dunia. Ini uji coba.', 10, p);
    expect(ret).toBe(p);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('PlayResX: 1080');
    expect(content).toContain('PlayResY: 1920');
    expect(content).toContain('ScriptType: v4.00+');
    expect(content).toContain('Style: Default,Arial,42,');
    expect(content).toContain(',2,60,60,360,1');
  });

  it('satu kalimat per baris (<=6 kata) => satu Dialogue; dua kalimat => dua Dialogue', () => {
    const p = assPath('count.ass');
    generateAssSubtitles('Halo dunia. Ini uji coba.', 10, p);
    const lines = readDialogueLines(fs.readFileSync(p, 'utf8'));
    expect(lines.length).toBe(2);
  });

  it('kalimat panjang (>6 kata, tanpa koma) dipecah menjadi 2 paruh', () => {
    const p = assPath('split.ass');
    // 9 kata tanpa koma => masuk cabang "2 clean halves" => 2 phrase.
    generateAssSubtitles('satu dua tiga empat lima enam tujuh delapan sembilan.', 12, p);
    const lines = readDialogueLines(fs.readFileSync(p, 'utf8'));
    expect(lines.length).toBe(2);
  });

  it('selalu memakai warna dasar putih {\\c&H00FFFFFF&}', () => {
    const p = assPath('white.ass');
    generateAssSubtitles('Produk biasa saja.', 6, p);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('{\\c&H00FFFFFF&}');
  });

  it('kata fokus (mis. praktis/checkout/solusi) memicu highlight kuning {\\c&H0000FFFF&}', () => {
    const p = assPath('yellow.ass');
    generateAssSubtitles('Alat ini sangat praktis.', 6, p);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('{\\c&H0000FFFF&}');
  });
});

describe('generateAssSubtitles — normalisasi kosakata on-screen (kunci affiliate)', () => {
  const dialogueText = (content) =>
    readDialogueLines(content).map((l) => l.split(',').slice(9).join(','));

  it('"kece" ditulis ulang menjadi "keren"', () => {
    const p = assPath('kece.ass');
    generateAssSubtitles('Barangnya kece banget.', 6, p);
    const joined = dialogueText(fs.readFileSync(p, 'utf8')).join(' ');
    expect(joined).toContain('keren');
    expect(joined).not.toMatch(/\bkece\b/i);
  });

  it('nama platform (shopee/tiktok/...) diganti "belanja"', () => {
    const p = assPath('platform.ass');
    generateAssSubtitles('Racun shopee lagi hits.', 6, p);
    const joined = dialogueText(fs.readFileSync(p, 'utf8')).join(' ');
    expect(joined.toLowerCase()).toContain('belanja');
    expect(joined.toLowerCase()).not.toContain('shopee');
  });

  it('aksara beraksen dilipat ke ASCII (kécé -> kece -> keren)', () => {
    const p = assPath('accent.ass');
    generateAssSubtitles('Tampilan kécé modern.', 6, p);
    const joined = dialogueText(fs.readFileSync(p, 'utf8')).join(' ');
    expect(joined).not.toMatch(/[éèê]/);
    expect(joined).toContain('keren');
  });

  it('emoji & tag markdown/emosi dibuang dari teks tampil', () => {
    const p = assPath('emoji.ass');
    generateAssSubtitles('[excited] 🔥 Produk oke.', 6, p);
    const joined = dialogueText(fs.readFileSync(p, 'utf8')).join(' ');
    expect(joined).not.toContain('🔥');
    expect(joined).not.toMatch(/\[excited\]/);
  });

  it('tanpa skrip (kosong) => fallback satu phrase default, file tetap terbentuk', () => {
    const p = assPath('empty.ass');
    generateAssSubtitles('', 5, p);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('Dialogue: 0,');
  });

  it('generateSrtSubtitles adalah alias generateAssSubtitles', () => {
    expect(generateSrtSubtitles).toBe(generateAssSubtitles);
  });
});

describe('parseAssTimeToSeconds', () => {
  it('H:MM:SS.CC => detik desimal', () => {
    expect(parseAssTimeToSeconds('0:01:30.50')).toBeCloseTo(90.5, 3);
    expect(parseAssTimeToSeconds('0:00:00.00')).toBe(0);
    expect(parseAssTimeToSeconds('1:00:00.00')).toBe(3600);
  });
  it('format salah / non-string => 0', () => {
    expect(parseAssTimeToSeconds('bukan-waktu')).toBe(0);
    expect(parseAssTimeToSeconds('')).toBe(0);
    expect(parseAssTimeToSeconds(null)).toBe(0);
    expect(parseAssTimeToSeconds(123)).toBe(0);
  });
});

describe('scaleAssSubtitles — rescale timestamp saat tempo audio berubah', () => {
  it('mengalikan seluruh timestamp dengan scaleFactor (baris pertama: end => end*factor)', () => {
    const p = assPath('scale.ass');
    generateAssSubtitles('Halo dunia. Ini uji coba.', 20, p);
    const firstLineEnd = (content) => parseAssTimeToSeconds(content.split(/\r?\n/).find((l) => l.startsWith('Dialogue: 0,')).split(',')[2]);

    const secBefore = firstLineEnd(fs.readFileSync(p, 'utf8'));
    scaleAssSubtitles(p, 0.5);
    const secAfter = firstLineEnd(fs.readFileSync(p, 'utf8'));
    // Karakterisasi: skala perkalian murni (dibatasi pembulatan sentidetik ke bawah).
    expect(secAfter).toBeLessThanOrEqual(secBefore * 0.5);
    expect(secAfter).toBeCloseTo(secBefore * 0.5, 2);
  });

  it('factor ~1.0 => no-op (file tidak berubah)', () => {
    const p = assPath('noop.ass');
    generateAssSubtitles('Halo dunia. Ini uji coba.', 15, p);
    const before = fs.readFileSync(p, 'utf8');
    scaleAssSubtitles(p, 1.0);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('file tidak ada => tidak melempar', () => {
    expect(() => scaleAssSubtitles(assPath('tiada.ass'), 0.5)).not.toThrow();
  });

  it('memakai scaleFactor < 1 memperpendek seluruh Dialogue, menjaga start < end', () => {
    const p = assPath('order.ass');
    generateAssSubtitles('satu dua. tiga empat. lima enam.', 30, p);
    scaleAssSubtitles(p, 0.6);
    const lines = readDialogueLines(fs.readFileSync(p, 'utf8'));
    for (const l of lines) {
      const parts = l.split(',');
      expect(parseAssTimeToSeconds(parts[1])).toBeLessThan(parseAssTimeToSeconds(parts[2]));
    }
  });
});
