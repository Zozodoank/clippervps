import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

// P4: tes store untuk patchJob atomik + guard transisi stage + throttle persist.
// Kita SET JOBS_DB_PATH SEBELUM import jobStore (dynamic import) agar tes ini memakai
// DB SQLite TERISOLASI di tmpdir, bukan server/jobs.db produksi.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(os.tmpdir(), `jobs-patch-test-${process.pid}-${Date.now()}.db`);
process.env.JOBS_DB_PATH = testDbPath;

const {
  activeJobs,
  patchJob,
  maybePersistJobStatus,
  isValidStageTransition,
  TERMINAL_STAGES,
} = await import('../store/jobStore.js');

function readRow(jobId) {
  // Baca langsung apa yang tersimpan di disk (lewat proxy DB).
  return activeJobs.get(jobId);
}

beforeAll(() => {
  // pastikan file benar-benar dibuat
  expect(fs.existsSync(testDbPath)).toBe(true);
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix); } catch { /* ignore */ }
  }
});

describe('isValidStageTransition (guard sederhana)', () => {
  it('mengizinkan stage pertama kali (from kosong)', () => {
    expect(isValidStageTransition(undefined, 'running')).toBe(true);
    expect(isValidStageTransition('running', undefined)).toBe(true);
  });
  it('idempotent: stage sama selalu sah', () => {
    expect(isValidStageTransition('running', 'running')).toBe(true);
    expect(isValidStageTransition('completed', 'completed')).toBe(true);
  });
  it('dari non-terminal bebas ke mana saja', () => {
    expect(isValidStageTransition('running', 'awaiting_voiceover')).toBe(true);
    expect(isValidStageTransition('pending', 'running')).toBe(true);
  });
  it('dari terminal HANYA sah ke jalur retry (running/retrying)', () => {
    expect(isValidStageTransition('completed', 'running')).toBe(true);
    expect(isValidStageTransition('completed', 'retrying')).toBe(true);
    expect(isValidStageTransition('completed', 'pending')).toBe(false);
    expect(isValidStageTransition('error', 'awaiting_voiceover')).toBe(false);
  });
  it('set TERMINAL_STAGES memuat kosakata stage akhir yang diharapkan', () => {
    for (const s of ['completed', 'error', 'stopped', 'rejected_bulky', 'awaiting_voiceover']) {
      expect(TERMINAL_STAGES.has(s)).toBe(true);
    }
  });
});

describe('patchJob atomik (baca-gabung-tulis)', () => {
  it('membuat job baru bila belum ada (create-if-missing) & meng-inject id', () => {
    const res = patchJob('p4-new-1', { title: 'hai', stage: 'running' });
    expect(res.id).toBe('p4-new-1');
    expect(res.title).toBe('hai');
    expect(res.updatedAt).toBeTruthy();
    expect(readRow('p4-new-1').title).toBe('hai');
  });

  it('patch objek melakukan shallow-merge tanpa menghapus field lain', () => {
    patchJob('p4-merge', { a: 1, b: 2, stage: 'running' });
    patchJob('p4-merge', { b: 20, c: 3 });
    const row = readRow('p4-merge');
    expect(row.a).toBe(1);   // tetap
    expect(row.b).toBe(20);  // ditimpa
    expect(row.c).toBe(3);   // baru
  });

  it('patch fungsi menerima job terkini dan mengembalikan job baru', () => {
    patchJob('p4-fn', { count: 1, stage: 'running' });
    patchJob('p4-fn', (job) => ({ ...job, count: job.count + 41 }));
    expect(readRow('p4-fn').count).toBe(42);
  });

  it('mencegah LOST-UPDATE: dua patchJob atas field berbeda keduanya bertahan', () => {
    patchJob('p4-lost', { stage: 'running' });
    // Pola lama (read->mutate->set salinan) akan menimpa; patchJob membaca ulang tiap kali.
    patchJob('p4-lost', { fieldX: 'dari-writer-1' });
    patchJob('p4-lost', { fieldY: 'dari-writer-2' });
    const row = readRow('p4-lost');
    expect(row.fieldX).toBe('dari-writer-1');
    expect(row.fieldY).toBe('dari-writer-2');
  });

  it('sanitasi key rahasia (apiKey/geminiApiKey/openRouterApiKey) tidak tersimpan di disk', () => {
    patchJob('p4-secret', { stage: 'running', apiKey: 'SECRET', productTitle: 'aman' });
    const row = readRow('p4-secret');
    expect(row.apiKey).toBeUndefined();
    expect(row.productTitle).toBe('aman');
  });

  it('MENOLAK transisi stage terminal -> non-retry, tapi tetap menyimpan field lain', () => {
    patchJob('p4-guard', { stage: 'completed', note: 'selesai' });
    const before = readRow('p4-guard');
    expect(before.stage).toBe('completed');
    // upaya illegal downgrade + update field — stage harus Ditolak, field note diterima.
    patchJob('p4-guard', { stage: 'pending', note: 'diperbarui' });
    const after = readRow('p4-guard');
    expect(after.stage).toBe('completed');   // guard mempertahankan terminal
    expect(after.note).toBe('diperbarui');    // patch non-stage tetap apply
    void before;
  });

  it('MEMBOLEHKAN transisi terminal -> running saat retry (bukan dari terminal lain)', () => {
    patchJob('p4-retry-ok', { stage: 'completed' });
    patchJob('p4-retry-ok', { stage: 'running' }); // completed->running sah (jalur retry)
    expect(readRow('p4-retry-ok').stage).toBe('running');
  });

  it('force=true menembus guard untuk transisi terminal -> non-retry', () => {
    patchJob('p4-force', { stage: 'error' });
    patchJob('p4-force', { stage: 'pending' });            // tanpa force -> ditolak
    expect(readRow('p4-force').stage).toBe('error');
    patchJob('p4-force', { stage: 'pending' }, { force: true }); // dengan force -> tembus
    expect(readRow('p4-force').stage).toBe('pending');
  });

  it('tidak memakai .iterate() (bebas dari jebakan koneksi busy saat tulis)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'store', 'jobStore.js'), 'utf8');
    const patchJobBody = src.slice(src.indexOf('export function patchJob'), src.indexOf('// P4.2 Throttle'));
    expect(patchJobBody).toMatch(/SELECT data FROM jobs WHERE id = \?'\)\.get\(/);
    expect(patchJobBody).not.toMatch(/\.iterate\(/);
  });
});

describe('maybePersistJobStatus (throttle + anti-stub)', () => {
  it('tanpa status -> tidak menulis (false)', () => {
    patchJob('p4-p-1', { stage: 'running' });
    expect(maybePersistJobStatus('p4-p-1', { progress: 10 })).toBe(false);
  });

  it('job TAK dikenal + status running -> tidak membuat stub (false)', () => {
    expect(maybePersistJobStatus('p4-ghost', { status: 'running', progress: 5 }, { now: 1000 })).toBe(false);
    expect(activeJobs.has('p4-ghost')).toBe(false);
  });

  it('running di-throttle: tulis pertama (true), kedua <1s digabung (false)', () => {
    patchJob('p4-p-2', { stage: 'running' });
    const first = maybePersistJobStatus('p4-p-2', { status: 'running', progress: 20 }, { now: 5000 });
    const second = maybePersistJobStatus('p4-p-2', { status: 'running', progress: 25 }, { now: 5400 });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('running lolos throttle setelah >=1 detik sejak persist terakhir', () => {
    patchJob('p4-p-3', { stage: 'running' });
    maybePersistJobStatus('p4-p-3', { status: 'running', progress: 30 }, { now: 10000 });
    const later = maybePersistJobStatus('p4-p-3', { status: 'running', progress: 35 }, { now: 11200 });
    expect(later).toBe(true);
  });

  it('transisi terminal SELALU dipersist tanpa throttle & tembus guard', () => {
    patchJob('p4-p-4', { stage: 'running' });
    // blok window throttle dengan persist running dulu
    maybePersistJobStatus('p4-p-4', { status: 'running', progress: 50 }, { now: 20000 });
    const term = maybePersistJobStatus('p4-p-4', { status: 'completed', progress: 100, message: 'selesai' }, { now: 20100 });
    expect(term).toBe(true);
    const row = readRow('p4-p-4');
    expect(row.stage).toBe('completed');
    expect(row.progress).toBe(100);
    expect(row.message).toBe('selesai');
  });

  it('menulis cermin field progres (progress/message/lastStep) ke baris job', () => {
    patchJob('p4-p-5', { stage: 'running' });
    maybePersistJobStatus('p4-p-5', { status: 'running', progress: 61, message: 'download', step: 'download' }, { now: 30000 });
    const row = readRow('p4-p-5');
    expect(row.progress).toBe(61);
    expect(row.message).toBe('download');
    expect(row.lastStep).toBe('download');
  });
});
