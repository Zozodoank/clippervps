import { describe, it, expect } from 'vitest';
import { classifyDownloadFailure, BOT_BLOCK_MESSAGE } from '../utils/downloadFailureClass.js';

// Regresi Termux 2026-10-05 (job kk5h0ug1): attempt-1 section terpotong 1.4s, retry
// profil 2-4 menabrak dinding format/PoToken, dan penyebab terakhir menimpa yang pertama
// -> job melaporkan "video tidak punya HD" padahal HD terbukti ada (preview terunduh).
// Klasifikasi wajib memakai causes SELURUH attempt dengan truncation menang atas noHd.

const TRUNC = 'Section download terpotong (file 1.4s dari 22.0s yang diminta)';
const FORMAT = "ERROR: [youtube] m-unxJ6icHc: Requested format is not available. Use --list-formats for a list";

describe('classifyDownloadFailure — prioritas penyebab (review 2026-10-05)', () => {
  it('truncation dulu + format kemudian => truncated, BUKAN noHd, dan isInfraError', () => {
    const v = classifyDownloadFailure([TRUNC, FORMAT, FORMAT]);
    expect(v.kind).toBe('truncated');
    expect(v.isInfraError).toBe(true);
    expect(v.message).toContain('terpotong');
    expect(v.message).not.toContain('tidak memiliki format HD');
  });

  it('hanya penyebab format => noHd (perilaku lama dipertahankan)', () => {
    expect(classifyDownloadFailure([FORMAT]).kind).toBe('noHd');
    expect(classifyDownloadFailure(['WARNING: Only images are available for download.']).kind).toBe('noHd');
  });

  it('bot/IP block menang atas semuanya (termasuk truncation)', () => {
    const v = classifyDownloadFailure([TRUNC, "Sign in to confirm you're not a bot"]);
    expect(v.kind).toBe('botBlock');
    expect(v.message).toBe(BOT_BLOCK_MESSAGE);
  });

  it('file terlalu kecil termasuk keluarga truncated (W5)', () => {
    const v = classifyDownloadFailure(['File section terpotong: hasil terlalu kecil (42 KB)']);
    expect(v.kind).toBe('truncated');
    expect(v.isInfraError).toBe(true);
  });

  // Watchdog FASE 4.1: child yang dibunuh karena stream macet wajib berkelas INFRA,
  // supaya ledger tidak menjatuhkan cooldown konten 14 hari pada produk yang sehat.
  it('watchdog => kelas "hung" dengan isInfraError (bukan generic tanpa atribusi)', () => {
    const HUNG = 'yt-dlp dihentikan watchdog: tidak ada kemajuan selama 90 dtk (koneksi stream diduga menggantung)';
    const v = classifyDownloadFailure([HUNG]);
    expect(v.kind).toBe('hung');
    expect(v.isInfraError).toBe(true);
    expect(v.message).toContain('watchdog');
  });

  it('hung menang atas gejala turunan truncated/noHd di attempt berikutnya', () => {
    const HUNG = 'FFmpeg merge dihentikan watchdog: melebihi 120 dtk (diduga menggantung).';
    expect(classifyDownloadFailure([HUNG, FORMAT]).kind).toBe('hung');
    expect(classifyDownloadFailure([HUNG, TRUNC]).kind).toBe('hung');
  });

  it('bot/IP block tetap menang atas watchdog (429 lebih spesifik)', () => {
    const v = classifyDownloadFailure(['yt-dlp dihentikan watchdog (koneksi stream diduga menggantung)', "Sign in to confirm you're not a bot"]);
    expect(v.kind).toBe('botBlock');
  });

  it('pesan download biasa TIDAK ikut kelas hung (anti-terlalu-lapas)', () => {
    expect(classifyDownloadFailure(['ERROR: got unexpected response: Not Found']).kind).toBe('generic');
  });

  it('causes kosong => generic dengan label kualitas', () => {
    const v = classifyDownloadFailure([], { qualityLabel: '1080p Full HD' });
    expect(v.kind).toBe('generic');
    expect(v.message).toContain('1080p Full HD');
    expect(v.message).toContain('tidak diketahui');
  });

  it('generic memakai penyebab TERAKHIR sebagai detail', () => {
    const v = classifyDownloadFailure(['Exit code 1', 'ERROR: network timeout']);
    expect(v.kind).toBe('generic');
    expect(v.message).toContain('network timeout');
  });

  it('entri kosong/null diabaikan, urutan tetap kronologis', () => {
    expect(classifyDownloadFailure(['', null, undefined, FORMAT]).kind).toBe('noHd');
    expect(classifyDownloadFailure([null, TRUNC, '']).kind).toBe('truncated');
  });

  it('bukan-array => generic tanpa melempar', () => {
    expect(classifyDownloadFailure(null).kind).toBe('generic');
    expect(classifyDownloadFailure(undefined).kind).toBe('generic');
  });
});
