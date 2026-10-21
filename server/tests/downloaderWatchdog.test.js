import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runYtDlp } from '../services/downloader.js';

// Audit FASE 4.1 (ketahanan workflow): sebelum perbaikan ini, runYtDlp() dan
// mergeStreamsWithFfmpeg() men-spawn child process TANPA timeout dan TANPA kill.
// Karena seluruh pipeline berjalan di heavyTaskQueue = pLimit(1)
// (queueManager.js:5, stage1Render.js:3335), SATU yt-dlp/ffmpeg yang menggantung
// membekukan SEMUA job berikutnya sampai proses di-restart. Penjaga watchdog sekarang
// membunuh anak yang diam terlalu lama, membuang file parsial, dan tetap RESOLVE
// (code !== 0) supaya rotasi client profile + classifyDownloadFailure yang bicara.
//
// Child asli tidak dipakai di sini: `process.execPath` (Node yang sama) menjalankan
// skrip kecil, jadi tes ini tidak menyentuh jaringan maupun biner yt-dlp.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Proses yang diam total (tidak menulis apa pun) - persis pola koneksi stream macet. */
const SILENT = ['--input-type=commonjs', '-e', 'setTimeout(() => {}, 60000)'];
/** Proses yang menulis berkala lalu selesai sendiri - pola unduhan lambat tapi hidup. */
const CHATTY = ['--input-type=commonjs', '-e', 'let n=0;const t=setInterval(()=>{console.log("progress "+(++n))},40);setTimeout(()=>{clearInterval(t);process.exit(0)},400)'];

describe('runYtDlp watchdog (audit FASE 4.1)', () => {
  it('membunuh child yang tidak ada kemajuan dan resolve dengan code !== 0 + timedOut', async () => {
    const t0 = Date.now();
    const res = await runYtDlp(process.execPath, SILENT, { idleTimeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/dihentikan watchdog/);
    // Klassenya harus terbaca sebagai infra oleh classifier (bukan sekadar pesan manusia).
    expect(res.stderr).toMatch(/menggantung/);
    // Tidak boleh menunggu 60 dtk (masa hidup child) - bukti SIGKILL benar-benar dikirim.
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);

  it('membuang file hasil parsial saat child dibunuh (yt-dlp berjalan dengan --no-part)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-watchdog-'));
    const target = path.join(dir, 'raw_job123.mp4');
    fs.writeFileSync(target, Buffer.alloc(4096, 7));
    const res = await runYtDlp(process.execPath, SILENT, { idleTimeoutMs: 300, attemptFiles: [target] });
    expect(res.timedOut).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 15000);

  it('child yang terus menulis kemajuan TIDAK dibunuh (unduhan lambat itu normal)', async () => {
    const res = await runYtDlp(process.execPath, CHATTY, { idleTimeoutMs: 30000 });
    expect(res.timedOut).toBeUndefined();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('progress');
  }, 20000);

  it('maxRuntimeMs memotong child yang berisik tapi tidak pernah selesai', async () => {
    const noisyForever = ['--input-type=commonjs', '-e', 'setInterval(()=>console.log("tick"),20)'];
    const t0 = Date.now();
    const res = await runYtDlp(process.execPath, noisyForever, { idleTimeoutMs: 0, maxRuntimeMs: 400 });
    expect(res.timedOut).toBe(true);
    expect(res.stdout).toContain('tick'); // ia memang tidak diam - yang memotong batas absolut
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 15000);

  it('error spawn (biner tidak ada) tetap melempar seperti sebelumnya', async () => {
    await expect(runYtDlp(path.join('Z:', 'tidak-ada', 'yt-dlp.exe'), ['--version'], { idleTimeoutMs: 5000 }))
      .rejects.toThrow(/Failed to start yt-dlp/);
  }, 15000);
});

describe('integrasi klasifikasi watchdog -> kelas infra', () => {
  it('stderr watchdog menjadi kelas "hung" dengan isInfraError', async () => {
    const { classifyDownloadFailure } = await import('../utils/downloadFailureClass.js');
    const res = await runYtDlp(process.execPath, SILENT, { idleTimeoutMs: 300 });
    const verdict = classifyDownloadFailure([(res.stderr || '').trim()]);
    expect(verdict.kind).toBe('hung');
    expect(verdict.isInfraError).toBe(true);
  }, 15000);
});

// Bukti bahwa SIGKILL benar-benar MEREGAKAN proses, bukan sekadar membuat promise
// resolve: anak yang masih hidup (zombie) tetap menahan heavyTaskQueue pLimit(1).
describe('sanitasi: child yang dibunuh watchdog benar-benar mati', () => {
  it('jantung child berhenti menulis setelah watchdog turun', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-watchdog-hb-'));
    const hb = path.join(dir, 'heartbeat.txt');
    const script = ['--input-type=commonjs', '-e',
      `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(hb)},'x'),50);`];
    const res = await runYtDlp(process.execPath, script, { idleTimeoutMs: 250 });
    expect(res.timedOut).toBe(true);
    const sebelum = fs.readFileSync(hb).length;
    expect(sebelum).toBeGreaterThan(0);
    await sleep(400); // 8 denyut (@50ms) bila child masih hidup
    expect(fs.readFileSync(hb).length).toBe(sebelum);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 15000);
});
