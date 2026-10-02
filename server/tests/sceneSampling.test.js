import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lightFilterFrames, sampleFramesForWindows } from '../services/videoFilterService.js';

// Tahap 8 - KARAKTERISASI "flag OFF = regresi nol" untuk helper sampling baru.
// Bukti kunci: tanpa window (kondisi default/legacy karena cabang smolvlm tidak
// pernah memanggil ini), helper bersifat NO-OP dan TIDAK menyentuh jalur lama.
// Tidak ada spawn ffmpeg pada kasus ini -> tes deterministik tanpa dependensi biner.

describe('sampleFramesForWindows — guard input & no-op', () => {
  it('melempar saat streamUrl kosong (caller wajib sadar, bukan diam-diam)', async () => {
    await expect(sampleFramesForWindows('', [{ startSec: 0, endSec: 4 }], { outDir: os.tmpdir() }))
      .rejects.toThrow(/streamUrl kosong/);
  });

  it('melempar saat outDir tidak diberikan', async () => {
    await expect(sampleFramesForWindows('https://x/y', [{ startSec: 0, endSec: 4 }], {}))
      .rejects.toThrow(/outDir wajib/);
  });

  it('windows kosong -> [] (no-op, tanpa menyentuh ffmpeg/jejak disk)', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-empty-'));
    const res = await sampleFramesForWindows('https://example.com/stream', [], { outDir });
    expect(res).toEqual([]);
    // hanya direktori kerja yang dibuat, tak ada klip/frame tertulis
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('window tak berstruktur (null/ tanpa start valid) disaring -> [] tanpa spawn', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-badwin-'));
    const res = await sampleFramesForWindows('https://example.com/stream', [null, {}, { start: 'abc' }], { outDir });
    expect(res).toEqual([]);
  });
});

describe('lightFilterFrames — fail-open & hemat', () => {
  it('array kosong -> [] (0 pemanggilan biner)', () => {
    expect(lightFilterFrames([])).toEqual([]);
  });

  it('path tak ada di disk dilewati (bukan memicu crash)', () => {
    expect(lightFilterFrames(['/nope/a.jpg', '', null])).toEqual([]);
  });
});
