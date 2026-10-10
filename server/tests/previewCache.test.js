// Regression guard untuk CACHE PREVIEW (hemat kuota Termux).
// Akar masalah lama: nama file preview memakai Date.now() dan videoId default = jobId,
// sehingga evaluasi ulang kandidat yang SAMA (retry infra / pemilihan Pre-Flight) selalu
// MEN-SPAWN yt-dlp lagi dan mengunduh window identik dua kali. Fix: memoize per
// (outputDir,url,durasi,crop). Test ini memalsukan child_process + fs agar tidak ada
// yt-dlp/ffprobe sungguhan, lalu memastikan:
//   1) panggilan kedua dengan key identik -> TIDAK spawn lagi, filePath sama (reuse), dan
//   2) panggilan dengan durasi berbeda -> spawn lagi (cache tidak menabrak window lain).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnCalls = vi.hoisted(() => ({ n: 0, urls: [] }));

vi.mock('child_process', () => {
  const EventEmitter = require('events').EventEmitter;
  return {
    spawn: (bin, args) => {
      spawnCalls.n += 1;
      spawnCalls.urls.push((args || []).join(' '));
      const proc = new EventEmitter();
      // Anggap yt-dlp sukses; berkasnya "ada" (fs.existsSync/statSync sudah di-spy).
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    },
    spawnSync: () => ({ status: 0, stdout: '12.0' }),
    execFile: () => {},
  };
});

vi.mock('../services/binaryChecker.js', () => ({
  getYtDlpPath: () => Promise.resolve('/usr/bin/yt-dlp'),
  getFFmpegPath: () => '/usr/bin/ffmpeg',
}));
vi.mock('../services/downloader.js', () => ({
  findCookiesFile: () => null,
  getSmartProxyArgs: () => [],
}));

import fs from 'fs';

describe('quickPreviewService - cache preview (hemat kuota)', () => {
  let downloadQuickPreview;
  let realExistsSync, realStatSync, realMkdirSync, realUnlinkSync;

  beforeEach(async () => {
    vi.resetModules();
    spawnCalls.n = 0;
    spawnCalls.urls = [];
    // fs diset agar "file hasil unduh" selalu dianggap ada & cukup besar.
    realExistsSync = fs.existsSync;
    realStatSync = fs.statSync;
    realMkdirSync = fs.mkdirSync;
    realUnlinkSync = fs.unlinkSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(() => true);
    vi.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 5000 }));
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    ({ downloadQuickPreview } = await import('../services/quickPreviewService.js'));
  });

  it('reuse file pada panggilan identik, spawn lagi untuk durasi berbeda', async () => {
    const url = 'https://www.youtube.com/watch?v=ABC123';
    const dir = '/tmp/clippervps-test-preview';
    const opts = { sourceDurationSec: 600 };

    const first = await downloadQuickPreview(url, dir, 'jobX', { ...opts, durationSec: 15 });
    const second = await downloadQuickPreview(url, dir, 'jobX', { ...opts, durationSec: 15 });

    // Panggilan identik: cukup SATU spawn yt-dlp, dan path-nya sama (diambil dari cache).
    expect(spawnCalls.n).toBe(1);
    expect(second.filePath).toBe(first.filePath);

    // Durasi berbeda = window berbeda -> WAJIB unduh ulang (cache tidak boleh salah pakai).
    // spawnCalls.n naik ke 2 membuktikan panggilan ke-3 benar-benar mengunduh lagi
    // (bukan dilayani dari cache 15s). Tidak membandingkan filePath karena nama file
    // memakai Date.now() yang bisa bentrok dalam milidetik yang sama.
    const ctx = await downloadQuickPreview(url, dir, 'jobX', { ...opts, durationSec: 25 });
    expect(spawnCalls.n).toBe(2);
    expect(ctx.actualDurationSec).toBeGreaterThan(0);

    // Restore fs.
    fs.existsSync.mockRestore();
    fs.statSync.mockRestore();
    fs.mkdirSync.mockRestore();
    fs.unlinkSync.mockRestore();
    void realExistsSync; void realStatSync; void realMkdirSync; void realUnlinkSync;
  });
});
