import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ============================================================================
// VLM ORACLE (Kaggle) - test kontrak antrean, normalisasi vonis, dan yang paling
// penting: JAMINAN FALLBACK. Kalau oracle tidak menjawab, TIDAK ADA frame yang
// diveto dan pool kembali utuh. Regresi di sini = risiko fail-open/lolos filter.
// DB terisolasi via JOBS_DB_PATH sebelum import jobStore (pola jobStorePatch.test.js).
// ============================================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(os.tmpdir(), `jobs-oracle-test-${process.pid}-${Date.now()}.db`);
process.env.JOBS_DB_PATH = testDbPath;

const {
  enqueueOracleBatch,
  getOracleBatch,
  claimOracleBatch,
  submitOracleResult,
  expireOracleBatch,
  waitForOracleVerdict,
  oracleQueueStats,
  pruneOracleBatches,
} = await import('../store/jobStore.js');

const { buildConfigSnapshot, configSnapshotToEnvPatch, isVlmOracleEnabled } = await import('../config/runtimeFlags.js');
const {
  resolveOracleConfig,
  pickEvenlySpaced,
  normalizeOracleVerdict,
  sanitizePoolWithOracle,
  applyOracleVeto,
} = await import('../services/vlmOracleService.js');
const { isAllowedFramePath } = await import('../api/routes/vlmOracleRoutes.js');
const { tempDir } = await import('../utils/paths.js');

const ENV_OFF = { VISION_VERIFY_MODE: 'legacy' };
const ENV_ON = { VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_TIMEOUT_SEC: '6', VLM_ORACLE_POLL_MS: '120', VLM_ORACLE_BATCH_SIZE: '8', VLM_ORACLE_MAX_FRAMES: '120', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '20' };

const silent = { log: () => {}, warn: () => {}, error: () => {} };

/** Frame sungguhan di disk: sanitizePoolWithOracle membuang yang tidak ada. */
let frameFiles = [];
function makeFrames(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-frames-'));
  return Array.from({ length: n }, (_, i) => {
    const filePath = path.join(dir, `f${i}.jpg`);
    fs.writeFileSync(filePath, 'x');
    return { filePath, timestampMs: i * 1000 };
  });
}

describe('runtimeFlags - mode oracle', () => {
  it('hanya menerima legacy/smolvlm/oracle, nilai aneh jatuh ke legacy', () => {
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'oracle' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'ORACLE ' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'ya-yang-tau' }).VISION_VERIFY_MODE).toBe('legacy');
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'oracle' })).toBe(true);
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'smolvlm' })).toBe(false);
    expect(isVlmOracleEnabled({})).toBe(false);
  });

  it('semua flag oracle ikut dibekukan DAN di-patch balik (kontrak configSnapshot)', () => {
    const snap = buildConfigSnapshot({
      ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '40', VLM_ORACLE_BATCH_SIZE: '99',
      VLM_ORACLE_TIMEOUT_SEC: '77', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '321',
      VLM_ORACLE_POLL_MS: '900', VLM_ORACLE_STALE_SEC: '66', VLM_ORACLE_MAX_ATTEMPTS: '3',
      VLM_ORACLE_BASE_URL: 'https://contoh.trycloudflare.com',
    });
    expect(snap.VLM_ORACLE_BATCH_SIZE).toBe(16); // dijepit, tidak boleh kirim 99 gambar sekali panggil
    expect(snap.VLM_ORACLE_MAX_FRAMES).toBe(40);
    const patched = configSnapshotToEnvPatch(snap);
    expect(patched.VLM_ORACLE_BASE_URL).toBe('https://contoh.trycloudflare.com');
    for (const key of Object.keys(snap)) {
      if (key.startsWith('VLM_ORACLE_')) expect(String(patched[key]), `env patch kehilangan ${key}`).toBe(String(snap[key]));
    }
  });
});

describe('resolveOracleConfig', () => {
  it('menjepit nilai ke rentang aman dan menghitung detik->ms', () => {
    const cfg = resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_TIMEOUT_SEC: '1', VLM_ORACLE_BATCH_SIZE: '0' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.perBatchTimeoutMs).toBe(5000); // floor 5 detik
    expect(cfg.batchSize).toBe(8);            // 0 -> default
    const off = resolveOracleConfig(ENV_OFF);
    expect(off.enabled).toBe(false);
  });
});

describe('pickEvenlySpaced', () => {
  it('mengembalikan semua bila n >= panjang, dan merata + terurut waktu bila lebih besar', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ filePath: `${i}`, timestampMs: i * 100 }));
    expect(pickEvenlySpaced(items, 20)).toHaveLength(10);
    const picked = pickEvenlySpaced(items, 3).map((f) => f.filePath);
    expect(picked).toEqual(['0', '3', '6']);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('tidak melempar untuk input rusak', () => {
    expect(pickEvenlySpaced(undefined, 5)).toEqual([]);
    expect(pickEvenlySpaced([{ filePath: 'a' }, null], 1).length).toBeGreaterThanOrEqual(1);
  });
});

describe('normalizeOracleVerdict', () => {
  it('vonis kosong/bukan objek = infraError (BUKAN vonis bersih)', () => {
    for (const bad of [null, undefined, 'SAFE', 42, {}, { reason: 'model ngawur' }]) {
      const v = normalizeOracleVerdict(bad, { expectedFrames: 4 });
      expect(v.ok, `input ${JSON.stringify(bad)} harus ditolak`).toBe(false);
      expect(v.infraError).toBe(true);
    }
  });

  it('mengerti bentuk agregat dan bentuk per-frame', () => {
    const agg = normalizeOracleVerdict({ safe: false, face: true, text: false, watermark: false, graphic: false, reason: 'ada wajah' });
    expect(agg.ok).toBe(true);
    expect(agg.vetoTriggered).toBe(true);
    expect(agg.face).toBe(true);
    const clean = normalizeOracleVerdict({ safe: true });
    expect(clean.vetoTriggered).toBe(false);
    const per = normalizeOracleVerdict({ perFrame: [{ index: 0, safe: true }, { index: 1, safe: false }] });
    expect(per.ok).toBe(true);
    expect(per.safe).toBe(false);
    expect(per.dirtyFrameIndexes).toEqual([1]);
  });

  it('memakai field index, BUKAN posisi array (notebook boleh mengirim daftar lebih pendek)', () => {
    // Frame 0 dan 2 kotor; entry untuk frame 1 hilang karena gagal parse di notebook.
    const v = normalizeOracleVerdict({ perFrame: [{ index: 0, safe: false }, { index: 2, safe: false }] });
    expect(v.dirtyFrameIndexes).toEqual([0, 2]);
    // Tanpa field index sama sekali -> jatuh ke posisi, tetap tidak melempar.
    expect(normalizeOracleVerdict({ perFrame: [{ safe: false }] }).dirtyFrameIndexes).toEqual([0]);
  });

  it('flag agregat salah nol tidak bisa menutupi safe:false', () => {
    const v = normalizeOracleVerdict({ safe: false, face: false, text: false, watermark: false, graphic: false });
    expect(v.vetoTriggered).toBe(true);
  });
});

describe('jobStore oracle queue', () => {
  const frames = [{ index: 0, filePath: '/tmp/a.jpg', timestampMs: 0 }, { index: 1, filePath: '/tmp/b.jpg', timestampMs: 1000 }];

  it('klaim atomik: pekerja kedua tidak mendapat batch yang sama', () => {
    enqueueOracleBatch({ id: 'q_atomic', jobId: 'job1', frames, niche: 'kitchen_tools', prompt: 'p' });
    const first = claimOracleBatch({ workerId: 'nb1' });
    expect(first.id).toBe('q_atomic');
    expect(first.status).toBe('claimed');
    expect(first.attempts).toBe(1);
    expect(first.frames).toHaveLength(2);
    expect(first.prompt).toBe('p');
    expect(claimOracleBatch({ workerId: 'nb2' })).toBe(null);
  });

  it('submit lalu tunggu -> done dengan verdict utuh; submit ulang = duplicate', async () => {
    const out = submitOracleResult({ batchId: 'q_atomic', verdict: { safe: false, face: true } });
    expect(out.ok).toBe(true);
    const waited = await waitForOracleVerdict('q_atomic', { timeoutMs: 50, pollMs: 10 });
    expect(waited.status).toBe('done');
    expect(waited.verdict.safe).toBe(false);
    expect(submitOracleResult({ batchId: 'q_atomic', verdict: { safe: true } }).duplicate).toBe(true);
    expect(getOracleBatch('q_atomic').verdict.safe).toBe(false); // tidak boleh tertimpa
  });

  it('klaim kadaluarsa dikembalikan ke pending sampai maxAttempts, lalu expired', () => {
    enqueueOracleBatch({ id: 'q_stale', jobId: 'job1', frames, prompt: 'p' });
    expect(claimOracleBatch({ workerId: 'nb1', staleMs: 1000, maxAttempts: 2, now: 5000 }).attempts).toBe(1);
    const reclaimed = claimOracleBatch({ workerId: 'nb2', staleMs: 1000, maxAttempts: 2, now: 9000 });
    expect(reclaimed.id).toBe('q_stale');
    expect(reclaimed.status).toBe('claimed');
    expect(reclaimed.attempts).toBe(2);
    // Attempts sudah mentok -> tidak diklaim lagi, ditandai expired.
    expect(claimOracleBatch({ workerId: 'nb3', staleMs: 1000, maxAttempts: 2, now: 30000 })).toBe(null);
    expect(getOracleBatch('q_stale').status).toBe('expired');
    expect(submitOracleResult({ batchId: 'q_stale', verdict: { safe: false } }).ok).toBe(false);
  });

  it('worker menyerah -> expire, dan vonis setelah itu ditolak', async () => {
    enqueueOracleBatch({ id: 'q_give', jobId: 'job1', frames, prompt: 'p' });
    claimOracleBatch({ workerId: 'nb1' });
    expireOracleBatch('q_give', 'timeout');
    const waited = await waitForOracleVerdict('q_give', { timeoutMs: 50, pollMs: 10 });
    expect(waited.status).toBe('expired');
    expect(submitOracleResult({ batchId: 'q_give', verdict: { safe: true } }).status).toBe('expired');
  });

  it('timeout menunggu menghasilkan status timeout (bukan vonis bersih)', async () => {
    enqueueOracleBatch({ id: 'q_none', jobId: 'job1', frames, prompt: 'p' });
    const slept = [];
    const waited = await waitForOracleVerdict('q_none', {
      timeoutMs: 100, pollMs: 20, sleep: (ms) => { slept.push(ms); }, now: () => Date.now(),
    });
    expect(waited.status).toBe('timeout');
    expect(waited.verdict).toBeUndefined();
    expect(slept.length).toBeGreaterThan(0);
    expireOracleBatch('q_none', 'dibersihkan supaya tes hilir tidak mengklaimnya');
  });

  it('batch tidak dikenal: wait -> unknown, submit -> unknown', async () => {
    expect((await waitForOracleVerdict('q_hantu', { timeoutMs: 1, pollMs: 1 })).status).toBe('unknown');
    expect(submitOracleResult({ batchId: 'q_hantu', verdict: {} }).status).toBe('unknown');
  });

  it('stats dan prune bekerja sesuai status', () => {
    const stats = oracleQueueStats();
    expect(stats.counts.done).toBeGreaterThanOrEqual(1);
    expect(stats.counts.expired).toBeGreaterThanOrEqual(2);
    expect(pruneOracleBatches({ keepMs: -1000, now: Date.now() })).toBeGreaterThanOrEqual(1);
    expect(getOracleBatch('q_atomic')).toBe(null);
  });
});

describe('sanitizePoolWithOracle / applyOracleVeto', () => {
  const MISSING = path.join(os.tmpdir(), 'oracle-frame-tidak-ada.jpg');

  /** Simulasi notebook Kaggle: klaim batch milik `jobId` lalu kirim verdict. */
  async function serveBatch(jobId, verdictFor) {
    for (let i = 0; i < 120; i++) {
      const batch = claimOracleBatch({ workerId: 'nb-' + jobId });
      if (batch) {
        // Batch yatim dari tes lain (created_at lebih tua) dibersihkan, bukan dipakai.
        if (batch.jobId !== jobId) { expireOracleBatch(batch.id, 'bukan batch tes'); continue; }
        submitOracleResult({ batchId: batch.id, verdict: verdictFor(batch) });
        return batch;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  beforeAll(() => { frameFiles = makeFrames(4); });

  it('mode OFF -> pool utuh, tidak ada baris baru di antrean', async () => {
    const before = oracleQueueStats().counts.pending;
    const out = await applyOracleVeto(frameFiles, { jobId: 'off', env: ENV_OFF, logger: silent });
    expect(out.enabled).toBe(false);
    expect(out.frames).toHaveLength(4);
    expect(oracleQueueStats().counts.pending).toBe(before);
  });

  it('maxFrames=0 -> tidak divisit sama sekali', async () => {
    const out = await sanitizePoolWithOracle(frameFiles, { jobId: 'zero', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '0' }, logger: silent });
    expect(out.enabled).toBe(true);
    expect(out.checked).toBe(0);
    expect(out.blacklisted).toEqual([]);
  });

  it('oracle TIDAK MENJAWAB -> tidak ada veto, pool utuh, timedOut terisi', async () => {
    const out = await applyOracleVeto(frameFiles, {
      jobId: 'diam',
      env: { ...ENV_ON, VLM_ORACLE_TIMEOUT_SEC: '5', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '10', VLM_ORACLE_MAX_FRAMES: '1', VLM_ORACLE_POLL_MS: '150' },
      logger: silent,
    });
    expect(out.enabled).toBe(true);
    expect(out.rejected).toBe(0);
    expect(out.timedOut).toBe(1);
    expect(out.frames).toHaveLength(4);
  }, 25000);

  it('frame hilang dari disk tidak dikirim; vonis KOTOR per-frame hanya membuang frame kotor', async () => {
    const blacklisted = new Set();
    // MISSING ikut di pool: harus disaring sebelum antrean dibuat.
    const run = applyOracleVeto([{ filePath: MISSING, timestampMs: -1 }, ...frameFiles], {
      jobId: 'kotor', blacklisted, env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '2' }, logger: silent,
    });
    const batch = await serveBatch('kotor', (b) => {
      for (const f of b.frames) expect(fs.existsSync(f.filePath)).toBe(true);
      // Dalam batch, index selalu 0..n-1 (dinomisasi ulang oleh service). Frame ke-2
      // divonis kotor; frame pertama bersih.
      return { model: 'Qwen2.5-VL-7B', reason: 'subtitle terbakar di satu frame', perFrame: b.frames.map((f) => ({ index: f.index, safe: f.index !== 1 })) };
    });
    const res = await run;
    expect(batch, 'notebook harus sempat mengklaim batch').not.toBe(null);
    expect(batch.frames).toHaveLength(2);
    expect(res.checked).toBe(2);
    expect(res.rejected).toBe(1);
    // pickEvenlySpaced(4,2) -> frame 0 dan 2; index in-batch 1 = frameFiles[2].
    expect(res.blacklisted).toEqual([frameFiles[2].filePath]);
    expect([...blacklisted]).toEqual([frameFiles[2].filePath]);
    // Pool keluaran = pool masukan dikurangi frame yang diveto. Frame yang sudah hilang
    // dari disk TIDAK ikut dibuang oleh oracle (ia tidak mengubah pool, hanya memveto),
    // jadi ia tetap ada di sini namun tidak pernah dikirim ke notebook.
    expect(res.frames).toHaveLength(4);
    expect(res.frames.map((f) => f.filePath)).not.toContain(frameFiles[2].filePath);
    expect(res.blacklisted).not.toContain(MISSING);
  }, 25000);

  it('vonis agregat tanpa per-frame -> seluruh batch diveto (konservatif); onProgress yang melempar aman', async () => {
    const run = sanitizePoolWithOracle(frameFiles, {
      jobId: 'agregat', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '2' }, logger: silent,
      onProgress: () => { throw new Error('progress rusak'); },
    });
    await serveBatch('agregat', () => ({ safe: false, face: true, reason: 'ada wajah kreator' }));
    const res = await run;
    expect(res.rejected).toBe(2);
    expect(res.blacklisted).toHaveLength(2);
    expect(res.checked).toBe(2);
  }, 25000);

  it('vonis tidak sah (kawat rusak) -> tidak memveto apa pun', async () => {
    const run = sanitizePoolWithOracle(frameFiles, { jobId: 'sampah', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '1' }, logger: silent });
    await serveBatch('sampah', () => ({ text: 'model mengirim prosa, bukan JSON' }));
    const res = await run;
    expect(res.checked).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.blacklisted).toEqual([]);
  }, 25000);
});

describe('path frame oracle (anti traversal)', () => {
  it('hanya mengizinkan path di bawah root yang dikenal', () => {
    const inside = path.join(tempDir, 'session', 'frame.jpg');
    expect(isAllowedFramePath(inside)).toBe(true);
    expect(isAllowedFramePath(path.join(tempDir, '..', '..', 'Windows', 'system32', 'config.dll'))).toBe(false);
    expect(isAllowedFramePath('C:\\Users\\lain\\rahasia.jpg')).toBe(false);
    expect(isAllowedFramePath('')).toBe(false);
    expect(isAllowedFramePath(null)).toBe(false);
    expect(isAllowedFramePath(123)).toBe(false);
  });
});
