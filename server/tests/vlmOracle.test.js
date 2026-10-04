import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// ============================================================================
// VLM ORACLE (Kaggle) - test kontrak antrean, normalisasi vonis, dan yang paling
// penting: JAMINAN STRICT oracle-only (mandate 2026-10). Kalau oracle tidak
// menjawab, job DIHENTIKAN (OracleUnavailableError) - bukan diam-diam lanjut
// dengan keputusan legacy. Perilaku lama tetap teruji lewat opsi strict:false
// (jalur tooling kalibrasi). Regresi di sini = risiko lolos filter / restart
// tanpa henti. DB terisolasi via JOBS_DB_PATH sebelum import jobStore.
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
  touchOracleHeartbeat,
  oracleLastSeenMs,
  countBusyOracleJobs,
  activeJobs,
} = await import('../store/jobStore.js');

const { buildConfigSnapshot, configSnapshotToEnvPatch, isVlmOracleEnabled, isOraclePreflightEnabled, isOracleStrictMode } = await import('../config/runtimeFlags.js');
const {
  resolveOracleConfig,
  pickEvenlySpaced,
  normalizeOracleVerdict,
  sanitizePoolWithOracle,
  applyOracleVeto,
  prepareOracleFrames,
  auditClipsWithOracle,
  preflightCandidatesWithOracle,
  orderCandidatesAfterPreflight,
  assertOracleConnected,
  OracleUnavailableError,
  PREFLIGHT_SCENE_BASE,
} = await import('../services/vlmOracleService.js');
const { isAllowedFramePath } = await import('../api/routes/vlmOracleRoutes.js');
const { maybeAutoLaunchOracle, waitForOracleOnline, probeOracleKernelAlive, __resetAutoLaunchCooldown } = await import('../services/oracleLauncherService.js');
const { tempDir } = await import('../utils/paths.js');
const { getFFmpegPath } = await import('../services/binaryChecker.js');

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

/** Bukan JPEG, tapi cukup besar untuk memicu percobaan konversi (uji fallback). */
function cryptoRandom(bytes) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** Notebook sederhana untuk satu batch milik `jobId`; return jumlah batch dilayani. */
async function serveBatchAny(jobId, verdictFor) {
  let served = 0;
  for (let i = 0; i < 400; i++) {
    const batch = claimOracleBatch({ workerId: 'nb-' + jobId });
    if (batch) {
      if (batch.jobId !== jobId) { expireOracleBatch(batch.id, 'bukan batch tes'); continue; }
      submitOracleResult({ batchId: batch.id, verdict: verdictFor(batch) });
      served += 1;
      return served;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return served;
}

describe('runtimeFlags - mode oracle (Kaggle-only, mandate 2026-10)', () => {
  it('default tidak-set/nilai aneh = oracle; hanya legacy/smolvlm eksplisit yang dikenali', () => {
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'oracle' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'ORACLE ' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ ...ENV_OFF, VISION_VERIFY_MODE: 'ya-yang-tau' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({}).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'legacy' }).VISION_VERIFY_MODE).toBe('legacy'); // dikenali, ditolak gerbang pipeline
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'oracle' })).toBe(true);
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'smolvlm' })).toBe(false);
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'legacy' })).toBe(false);
    expect(isVlmOracleEnabled({})).toBe(true); // default mengikuti normalizer: oracle
    expect(isOracleStrictMode({ VISION_VERIFY_MODE: 'oracle' })).toBe(true);
    expect(isOracleStrictMode(ENV_OFF)).toBe(false);
  });

  it('VLM_ORACLE_CONNECT_TIMEOUT_SEC: default 120, floor 10, ikut ter-patch dan terbaca ms', () => {
    expect(buildConfigSnapshot({}).VLM_ORACLE_CONNECT_TIMEOUT_SEC).toBe(120);
    expect(buildConfigSnapshot({ VLM_ORACLE_CONNECT_TIMEOUT_SEC: '3' }).VLM_ORACLE_CONNECT_TIMEOUT_SEC).toBe(10);
    expect(configSnapshotToEnvPatch(buildConfigSnapshot({ VLM_ORACLE_CONNECT_TIMEOUT_SEC: '45' })).VLM_ORACLE_CONNECT_TIMEOUT_SEC).toBe('45');
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_CONNECT_TIMEOUT_SEC: '45' }).connectTimeoutMs).toBe(45000);
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
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle' }).connectTimeoutMs).toBe(120000); // default
    // 0 eksplisit dihormati (bukan diam-diam 120) - gerbang strict yang menolak job.
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_MAX_FRAMES: '0' }).maxFrames).toBe(0);
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_MAX_FRAMES: '' }).maxFrames).toBe(120);
    expect(buildConfigSnapshot({ VLM_ORACLE_MAX_FRAMES: '0' }).VLM_ORACLE_MAX_FRAMES).toBe(0);
    // Filter kualitas pre-flight: default 0 (mati - hanya mencatat), dijepit 0..100, ikut dibekukan.
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle' }).minQuality).toBe(0);
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_MIN_QUALITY: '55' }).minQuality).toBe(55);
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_MIN_QUALITY: '300' }).minQuality).toBe(100);
    expect(resolveOracleConfig({ VISION_VERIFY_MODE: 'oracle', VLM_ORACLE_MIN_QUALITY: 'ngawur' }).minQuality).toBe(0);
    expect(buildConfigSnapshot({ VLM_ORACLE_MIN_QUALITY: '35' }).VLM_ORACLE_MIN_QUALITY).toBe(35);
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

  // KUNCI REGRESI 2026-10-03. Fallback posisi HARUS posisi di `perFrame` aslinya, bukan
  // posisi di daftar yang sudah difilter. Versi `filter(...).map((f, i) => ...)` yang pernah
  // lewat menghasilkan [0] pada kasus pertama (yang diveto justru frame BERSIH, yang kotor
  // lolos) dan [2,1] pada kasus campuran. Tes satu-elemen di atas tidak menangkap ini karena
  // kebetulan benar di kedua versi.
  it('fallback tanpa field index memakai posisi asli di perFrame', () => {
    expect(normalizeOracleVerdict({ perFrame: [{ safe: true }, { safe: false }] }).dirtyFrameIndexes).toEqual([1]);
    expect(normalizeOracleVerdict({
      perFrame: [{ safe: true }, { index: 2, safe: false }, { safe: true }, { safe: false }],
    }).dirtyFrameIndexes).toEqual([2, 3]);
    // Campuran index + posisi, dan daftar yang lebih pendek karena satu entry hilang:
    // tidak boleh dipadatkan ke 0..n-1.
    expect(normalizeOracleVerdict({
      perFrame: [{ index: 4, safe: false }, { safe: true }, { safe: false }],
    }).dirtyFrameIndexes).toEqual([4, 2]);
  });

  it('flag agregat salah nol tidak bisa menutupi safe:false', () => {
    const v = normalizeOracleVerdict({ safe: false, face: false, text: false, watermark: false, graphic: false });
    expect(v.vetoTriggered).toBe(true);
  });

  // Perilaku TERUKUR di perangkat (kalibrasi 2026-10-03, Qwen2.5-VL-3B-Instruct fp16):
  // model sering membiarkan safe:true sambil menyalakan satu flag — misalnya frame berisi
  // tulisan WA toko + wajah penuh divonis {safe:true, text:true}. Kalau hilir hanya
  // membaca `safe`, kotoran itu lolos semua. Flag yang menyala = veto, apa pun kata `safe`.
  it('flag yang menyala memveto walau model menulis safe:true', () => {
    for (const k of ['face', 'text', 'watermark', 'graphic']) {
      const v = normalizeOracleVerdict({ safe: true, [k]: true });
      expect(v.ok).toBe(true);
      expect(v.vetoTriggered, `flag ${k} harus memveto`).toBe(true);
    }
    // Kontrol: semuanya benar-benar nol = bersih.
    expect(normalizeOracleVerdict({ safe: true, face: false, text: false, watermark: false, graphic: false }).vetoTriggered).toBe(false);
  });

  // Kalibrasi 2026-10-03 menunjukkan veto berbasis flag tanpa `perFrame` ikut menghitamkan
  // frame baik di batch yang sama (2 dari 5 frame yang divonis bersih gatekeeper lokal ikut
  // tertolak). Notebook kini mengirim perFrame begitu ada flag menyala; hilir harus memakai
  // daftar itu, bukan menjatuhkan vonis ke seluruh batch.
  it('veto berbasis flag + perFrame membatasi frame kotor ke frame yang terbukti saja', () => {
    const v = normalizeOracleVerdict({
      safe: false,
      text: true,
      perFrame: [
        { index: 0, safe: true, text: false },
        { index: 1, safe: false, text: true },
        { index: 2, safe: true, text: false },
      ],
    }, { expectedFrames: 3 });
    expect(v.ok).toBe(true);
    expect(v.vetoTriggered).toBe(true);
    expect(v.dirtyFrameIndexes).toEqual([1]);
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

  it('STRICT: VLM_ORACLE_MAX_FRAMES=0 -> LEMPAR (satu knob env tidak bisa lagi mematikan verifikasi diam-diam)', async () => {
    let err = null;
    try {
      await sanitizePoolWithOracle(frameFiles, { jobId: 'zero', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '0' }, logger: silent });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('infra');
    // strict:false (tooling kalibrasi) tetap boleh berjalan tanpa visitasi.
    const out = await sanitizePoolWithOracle(frameFiles, { jobId: 'zero', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '0' }, logger: silent, strict: false });
    expect(out.enabled).toBe(true);
    expect(out.checked).toBe(0);
    expect(out.blacklisted).toEqual([]);
  });

  it('STRICT:false (tooling kalibrasi): oracle TIDAK MENJAWAB -> tidak ada veto, pool utuh, timedOut terisi', async () => {
    const out = await applyOracleVeto(frameFiles, {
      jobId: 'diam',
      env: { ...ENV_ON, VLM_ORACLE_TIMEOUT_SEC: '5', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '10', VLM_ORACLE_MAX_FRAMES: '1', VLM_ORACLE_POLL_MS: '150' },
      logger: silent,
      strict: false,
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

  it('STRICT:false (tooling kalibrasi): vonis tidak sah (kawat rusak) -> tidak memveto apa pun', async () => {
    const run = sanitizePoolWithOracle(frameFiles, { jobId: 'sampah', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '1' }, logger: silent, strict: false });
    await serveBatch('sampah', () => ({ text: 'model mengirim prosa, bukan JSON' }));
    const res = await run;
    expect(res.checked).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.blacklisted).toEqual([]);
  }, 25000);

  // ---- KEBIJAKAN STRICT (default produksi mode oracle, mandate 2026-10) ----
  // Dua test di bawah adalah INTI larangan "lanjut dengan keputusan legacy":
  // kalau salah satunya berubah jadi lulus-diam, berarti job bisa lolos tanpa vonis Kaggle.
  it('STRICT: notebook tidak pernah klaim -> LEMPAR OracleUnavailableError(never_claimed)', async () => {
    const run = applyOracleVeto(frameFiles, {
      jobId: 'strictnc',
      env: { ...ENV_ON, VLM_ORACLE_TIMEOUT_SEC: '5', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '6', VLM_ORACLE_MAX_FRAMES: '1', VLM_ORACLE_POLL_MS: '150' },
      logger: silent,
    });
    let err = null;
    try { await run; } catch (e) { err = e; }
    expect(err, 'oracle diam TIDAK BOLEH lagi berarti lanjut legacy').toBeInstanceOf(OracleUnavailableError);
    expect(err.code).toBe('ORACLE_UNAVAILABLE');
    expect(err.reason).toBe('never_claimed');
    expect(err.jobId).toBe('strictnc');
  }, 25000);

  it('STRICT: vonis tidak sah -> LEMPAR OracleUnavailableError(invalid_verdict), bukan diam-diam lolos', async () => {
    const run = sanitizePoolWithOracle(frameFiles, { jobId: 'stricinv', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '1' }, logger: silent });
    await serveBatch('stricinv', () => ({ text: 'model mengirim prosa, bukan JSON' }));
    let err = null;
    try { await run; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('invalid_verdict');
    expect(err.batchId, 'jejak forensik batch harus ikut terbawa').toMatch(/^orc_/);
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

// ============================================================================
// KONVERSI 360p SEBELUM DIKIRIM + AUDIT KLIP FINAL
// Dua hal yang tidak boleh regresi: (1) file ASLI 1080p tidak pernah berubah dan
// vonis selalu mengenai path asli, (2) oracle diam = JOB DIHENTIKAN (strict adalah
// default mode oracle); perilaku lama "klip tetap dipakai" hanya lewat strict:false.
// ============================================================================

describe('flag VLM_ORACLE_FRAME_HEIGHT + VLM_ORACLE_AUDIT_MAX_FRAMES', () => {
  it('tinggi kirim: default 360, 0 = mentah, selain itu dijepit 240..720', () => {
    expect(buildConfigSnapshot(ENV_OFF).VLM_ORACLE_FRAME_HEIGHT).toBe(360);
    expect(buildConfigSnapshot({ VLM_ORACLE_FRAME_HEIGHT: '0' }).VLM_ORACLE_FRAME_HEIGHT).toBe(0);
    expect(buildConfigSnapshot({ VLM_ORACLE_FRAME_HEIGHT: '480' }).VLM_ORACLE_FRAME_HEIGHT).toBe(480);
    expect(buildConfigSnapshot({ VLM_ORACLE_FRAME_HEIGHT: '100' }).VLM_ORACLE_FRAME_HEIGHT).toBe(240);
    expect(buildConfigSnapshot({ VLM_ORACLE_FRAME_HEIGHT: '1080' }).VLM_ORACLE_FRAME_HEIGHT).toBe(720);
    expect(buildConfigSnapshot({ VLM_ORACLE_FRAME_HEIGHT: 'ngawur' }).VLM_ORACLE_FRAME_HEIGHT).toBe(360);
  });

  it('plafon audit klip: default 90, 0 = pass audit off, dijepit 8..240', () => {
    expect(buildConfigSnapshot(ENV_OFF).VLM_ORACLE_AUDIT_MAX_FRAMES).toBe(90);
    expect(buildConfigSnapshot({ VLM_ORACLE_AUDIT_MAX_FRAMES: '0' }).VLM_ORACLE_AUDIT_MAX_FRAMES).toBe(0);
    expect(buildConfigSnapshot({ VLM_ORACLE_AUDIT_MAX_FRAMES: '3' }).VLM_ORACLE_AUDIT_MAX_FRAMES).toBe(8);
    expect(buildConfigSnapshot({ VLM_ORACLE_AUDIT_MAX_FRAMES: '999' }).VLM_ORACLE_AUDIT_MAX_FRAMES).toBe(240);
    expect(buildConfigSnapshot({ VLM_ORACLE_AUDIT_MAX_FRAMES: 'abc' }).VLM_ORACLE_AUDIT_MAX_FRAMES).toBe(90);
  });

  it('kedua flag ikut dibekukan dan di-patch balik, dan resolveOracleConfig membacanya sama', () => {
    const snap = buildConfigSnapshot({ ...ENV_ON, VLM_ORACLE_FRAME_HEIGHT: '0', VLM_ORACLE_AUDIT_MAX_FRAMES: '12' });
    const patched = configSnapshotToEnvPatch(snap);
    expect(String(patched.VLM_ORACLE_FRAME_HEIGHT)).toBe('0');
    expect(String(patched.VLM_ORACLE_AUDIT_MAX_FRAMES)).toBe('12');
    const cfg = resolveOracleConfig(snap);
    expect(cfg.frameHeight).toBe(0);
    expect(cfg.auditMaxFrames).toBe(12);
    expect(resolveOracleConfig(ENV_OFF).frameHeight).toBe(360);
  });
});

describe('prepareOracleFrames (1080p di perangkat, 360p ke Kaggle)', () => {
  const FFMPEG = (() => { try { return getFFmpegPath(); } catch { return ''; } })();

  function jpegHeight(file) {
    const buf = fs.readFileSync(file);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    for (let i = 2; i < buf.length - 9; i++) {
      if (buf[i] !== 0xff) continue;
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }

  /** JPEG 1080p asli sebesar frame clip_audit (mandelbrot q:v 1 ≈ 298 KB > ambang 200 KB). */
  function makeBigJpeg(dir, name) {
    const out = path.join(dir, name);
    const r = spawnSync(FFMPEG, [
      '-y', '-nostdin', '-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:rate=1',
      '-frames:v', '1', '-q:v', '1', out,
    ], { stdio: 'ignore' });
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    return fs.statSync(out).size > 200 * 1024 ? out : null;
  }

  const probe = (() => {
    if (!FFMPEG) return false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-probe-'));
    const f = makeBigJpeg(dir, 'probe.jpg');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return Boolean(f);
  })();
  const withFfmpeg = probe ? it : it.skip;

  it('height 0 -> tidak ada salinan sama sekali, path persis seperti masuk', async () => {
    const frames = makeFrames(2);
    const out = await prepareOracleFrames(frames, { height: 0, jobId: 'raw', logger: silent });
    expect(out.sent.map((f) => f.filePath)).toEqual(frames.map((f) => f.filePath));
    expect(out.converted).toBe(0);
    expect(out.outDir).toBe('');
    expect(out.originalBySent.get(frames[0].filePath)).toBe(frames[0].filePath);
  });

  it('file kecil (<200KB) tidak dikecilkan lagi (hemat panggilan FFmpeg)', async () => {
    const frames = makeFrames(1); // isinya 'x' -> beberapa byte
    const out = await prepareOracleFrames(frames, { height: 360, jobId: 'small', logger: silent });
    expect(out.converted).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.sent[0].filePath).toBe(frames[0].filePath);
  });

  it('tidak melempar untuk input kosong/rusak', async () => {
    expect((await prepareOracleFrames([], { height: 360, logger: silent })).sent).toEqual([]);
    expect((await prepareOracleFrames([null, { filePath: '' }], { height: 360, logger: silent })).sent).toEqual([]);
    const hilang = path.join(os.tmpdir(), 'oracle-yang-tak-ada.jpg');
    const out = await prepareOracleFrames([{ filePath: hilang }], { height: 360, jobId: 'ghost', logger: silent });
    expect(out.sent[0].filePath).toBe(hilang); // tetap dikirim apa adanya; hilir yang menyaring
    expect(out.converted).toBe(0);
  });

  it('sapuan salinan tua TIDAK menghapus direktori job lain yang masih baru', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-sweep-'));
    const lain = path.join(base, 'job_lain_h360');
    fs.mkdirSync(lain, { recursive: true });
    fs.writeFileSync(path.join(lain, 'dipakai-notebook.jpg'), 'x');
    const frames = makeFrames(1);
    await prepareOracleFrames(frames, { height: 360, jobId: 'sweep', outDir: base, logger: silent });
    expect(fs.existsSync(path.join(lain, 'dipakai-notebook.jpg'))).toBe(true);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  withFfmpeg('JPEG 1080p asli -> salinan 360p, file asli utuh, pemetaan balik benar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-big-'));
    const big = makeBigJpeg(dir, 'f1080.jpg');
    expect(big, 'fixture FFmpeg harus menghasilkan JPEG 1080p >200KB').toBeTruthy();
    const sizeBefore = fs.statSync(big).size;
    const frames = [{ filePath: big, timestampMs: 0 }];

    const out = await prepareOracleFrames(frames, { height: 360, jobId: 'conv', logger: silent });
    expect(out.converted).toBe(1);
    expect(out.failed).toBe(0);
    const sent = out.sent[0].filePath;
    expect(sent).not.toBe(big);
    expect(fs.existsSync(sent)).toBe(true);
    // Default outDir harus di bawah tempDir supaya lolos isAllowedFramePath di routes.
    expect(isAllowedFramePath(sent)).toBe(true);
    expect(sent.startsWith(tempDir + path.sep)).toBe(true);
    expect(jpegHeight(sent)).toMatchObject({ height: 360 });
    expect(jpegHeight(sent).width % 2).toBe(0);
    // Path asli tidak disentuh, dan vonis nanti bisa dipetakan balik ke dia.
    expect(fs.statSync(big).size).toBe(sizeBefore);
    expect(out.originalBySent.get(sent)).toBe(big);

    // Cache: panggilan kedua memakai salinan yang sama ( tidak ada konversi ulang ).
    const mtimeBefore = fs.statSync(sent).mtimeMs;
    const again = await prepareOracleFrames(frames, { height: 360, jobId: 'conv', logger: silent });
    expect(again.sent[0].filePath).toBe(sent);
    expect(again.converted).toBe(1);
    expect(fs.statSync(sent).mtimeMs).toBe(mtimeBefore);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 60000);

  withFfmpeg('FFmpeg gagal (bukan JPEG) -> pakai file asli, job tidak dibatalkan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-junk-'));
    const junk = path.join(dir, 'pura-pura.jpg');
    fs.writeFileSync(junk, cryptoRandom(300 * 1024));
    const out = await prepareOracleFrames([{ filePath: junk, timestampMs: 0 }], { height: 360, jobId: 'junk', logger: silent });
    expect(out.converted).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.sent[0].filePath).toBe(junk);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 60000);

  it('vonis mengenai frame ASLI walau yang dikirim adalah salinan 360p', async () => {
    // Tanpa FFmpeg pun aman: frame tes berukuran byte-mini -> lolos sebagai "sudah kecil",
    // jadi yang diuji di sini adalah bahwa blacklisted selalu path yang dikenali hilir.
    const frames = makeFrames(2);
    const run = sanitizePoolWithOracle(frames, { jobId: 'peta', env: { ...ENV_ON, VLM_ORACLE_MAX_FRAMES: '2' }, logger: silent });
    const served = await serveBatchAny('peta', () => ({ safe: false, perFrame: [{ index: 0, safe: false }] }));
    const res = await run;
    expect(served).toBeGreaterThan(0);
    expect(res.rejected).toBe(1);
    expect(res.blacklisted).toEqual([frames[0].filePath]);
  }, 25000);
});

describe('auditClipsWithOracle (pass klip final, frame 2,5 fps yang sudah ada)', () => {
  /** Notebook imut: klaim terus sampai `stop()` true atau tidak ada batch lagi. */
  async function serveAll(jobId, verdictFor, stop) {
    let served = 0;
    for (let i = 0; i < 400; i++) {
      if (stop && stop()) break;
      const batch = claimOracleBatch({ workerId: 'nb-' + jobId });
      if (!batch) { await new Promise((r) => setTimeout(r, 20)); continue; }
      if (batch.jobId !== jobId) { expireOracleBatch(batch.id, 'bukan batch tes'); continue; }
      submitOracleResult({ batchId: batch.id, verdict: verdictFor(batch) });
      served += 1;
    }
    return served;
  }

  let clipFrames = [];
  beforeAll(() => { clipFrames = makeFrames(6); });
  const clips = [{ startSeconds: 0, duration: 4 }, { startSeconds: 4, duration: 4 }];
  // PENTING: grouping dihitung SAAT test jalan, bukan saat body describe dieksekusi,
  // karena clipFrames baru terisi di beforeAll.
  const groupsFor = () => [clipFrames.slice(0, 3), clipFrames.slice(3, 6)];

  it('mode OFF -> tidak ada vonis, tidak ada baris antrean baru', async () => {
    const before = oracleQueueStats().counts.pending;
    const res = await auditClipsWithOracle(clips, groupsFor(), { jobId: 'a_off', env: ENV_OFF, logger: silent });
    expect(res.enabled).toBe(false);
    expect(res.verdicts.size).toBe(0);
    expect(oracleQueueStats().counts.pending).toBe(before);
  });

  it('VLM_ORACLE_AUDIT_MAX_FRAMES=0 -> pass audit dilewati dengan catatan jelas', async () => {
    const res = await auditClipsWithOracle(clips, groupsFor(), {
      jobId: 'a_zero', env: { ...ENV_ON, VLM_ORACLE_AUDIT_MAX_FRAMES: '0' }, logger: silent,
    });
    expect(res.enabled).toBe(true);
    expect(res.note).toMatch(/VLM_ORACLE_AUDIT_MAX_FRAMES=0/);
    expect(res.verdicts.size).toBe(0);
  });

  it('STRICT:false (tooling kalibrasi): oracle diam -> TIDAK ada klip yang ditolak (klip tetap dipakai)', async () => {
    const res = await auditClipsWithOracle(clips, groupsFor(), {
      jobId: 'a_timeout', env: { ...ENV_ON, VLM_ORACLE_TIMEOUT_SEC: '5', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '5' }, logger: silent, strict: false,
    });
    expect(res.verdicts.size).toBe(0);
    expect(res.timedOut).toBeGreaterThan(0);
    expect(res.rejectedClips).toBe(0);
  }, 30000);

  it('klip kedua divonis kotor -> hanya indeks 1 yang masuk verdicts, dengan path frame asli', async () => {
    let selesai = false;
    const pending = serveAll('a_dirty', (batch) => {
      // Batch klip #2 berisi tiga frame terakhir -> kotori frame index 1 batch itu.
      const milikKlipDua = batch.frames.length === 3 && batch.frames[0].filePath === clipFrames[3].filePath;
      return milikKlipDua
        ? { safe: false, perFrame: [{ index: 1, safe: false }], reason: 'ada wajah pembuat konten' }
        : { safe: true };
    }, () => selesai);
    const res = await auditClipsWithOracle(clips, groupsFor(), { jobId: 'a_dirty', env: ENV_ON, logger: silent });
    selesai = true;
    await pending;

    expect(res.verdicts.size).toBe(1);
    expect(res.verdicts.has(1)).toBe(true);
    expect(res.verdicts.get(1).dirty).toBe(true);
    expect(res.verdicts.get(1).dirtyFrames).toEqual([clipFrames[4].filePath]);
    expect(res.rejectedClips).toBe(1);
    expect(res.checked).toBeGreaterThan(0);
  }, 30000);

  it('semua klip bersih -> verdicts kosong, tidak ada yang dibuang', async () => {
    let selesai = false;
    const pending = serveAll('a_clean', () => ({ safe: true }), () => selesai);
    const res = await auditClipsWithOracle(clips, groupsFor(), { jobId: 'a_clean', env: ENV_ON, logger: silent });
    selesai = true;
    await pending;
    expect(res.verdicts.size).toBe(0);
    expect(res.rejectedClips).toBe(0);
    expect(res.checked).toBeGreaterThan(0);
  }, 30000);

  it('STRICT:false (tooling kalibrasi): vonis tidak sah -> tidak memveto (bukan vonis bersih, juga bukan penolakan)', async () => {
    let selesai = false;
    const pending = serveAll('a_bogus', () => ({ reason: 'model mengirim prosa' }), () => selesai);
    const res = await auditClipsWithOracle(clips, groupsFor(), { jobId: 'a_bogus', env: ENV_ON, logger: silent, strict: false });
    selesai = true;
    await pending;
    expect(res.verdicts.size).toBe(0);
    expect(res.rejectedClips).toBe(0);
    expect(res.timedOut).toBeGreaterThan(0);
  }, 30000);

  it('STRICT: klip diklaim tapi tidak dijawab -> LEMPAR OracleUnavailableError(no_verdict)', async () => {
    const run = auditClipsWithOracle(clips, groupsFor(), {
      jobId: 'a_strict', env: { ...ENV_ON, VLM_ORACLE_TIMEOUT_SEC: '5', VLM_ORACLE_TOTAL_TIMEOUT_SEC: '5' }, logger: silent,
    });
    // Notebook hidup tapi sengaja diam: klaim lalu lepas tanpa vonis -> lastStatus
    // 'claimed'/'expired' (BUKAN 'pending') sehingga reason yang benar 'no_verdict'.
    for (let i = 0; i < 200; i++) {
      const b = claimOracleBatch({ workerId: 'nb-a_strict' });
      if (b) {
        if (b.jobId !== 'a_strict') { expireOracleBatch(b.id, 'bukan batch tes'); continue; }
        expireOracleBatch(b.id, 'notebook sengaja diam');
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    let err = null;
    try { await run; } catch (e) { err = e; }
    expect(err, 'klip tanpa vonis Kaggle tidak boleh dipakai lagi').toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('no_verdict');
  }, 30000);

  it('STRICT: klip tanpa frame valid -> LEMPAR infra; STRICT:false: dilewati tanpa melempar', async () => {
    const clips2 = [{ duration: 4 }, { duration: 4 }];
    const groups = [[{ filePath: path.join(os.tmpdir(), 'tak-ada-1.jpg') }], []];
    const env = { ...ENV_ON, VLM_ORACLE_TOTAL_TIMEOUT_SEC: '5' };
    let err = null;
    try { await auditClipsWithOracle(clips2, groups, { jobId: 'a_noframe', env, logger: silent }); } catch (e) { err = e; }
    expect(err, 'klip yang tidak bisa divisit Kaggle tidak boleh lolos diam-diam').toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('infra');
    const res = await auditClipsWithOracle(clips2, groups, { jobId: 'a_noframe', env, logger: silent, strict: false });
    expect(res.verdicts.size).toBe(0);
    expect(res.checked).toBe(0);
  }, 20000);
});

describe('normalizeOracleVerdict - skor peringkat (Lapis 3)', () => {
  it('vonis LAMA (tanpa field produk) tetap sah dan tidak ikut terpengaruh', () => {
    const v = normalizeOracleVerdict({ safe: true, face: false, text: false, watermark: false, graphic: false });
    expect(v.ok).toBe(true);
    expect(v.vetoTriggered).toBe(false);
    // null = "tidak ada informasi", bukan 0. Bila ini 0, pre-flight akan membuang
    // kandidat hanya karena notebook belum di-update.
    expect(v.productMatch).toBeNull();
    expect(v.matchScore).toBeNull();
  });

  it('matchScore dikejar ke 0..100 dan hal tak-berangka dianggap tanpa-skor', () => {
    const base = { safe: true, face: false, text: false, watermark: false, graphic: false };
    expect(normalizeOracleVerdict({ ...base, matchScore: 480 }).matchScore).toBe(100);
    expect(normalizeOracleVerdict({ ...base, matchScore: -20 }).matchScore).toBe(0);
    expect(normalizeOracleVerdict({ ...base, matchScore: '72' }).matchScore).toBe(72);
    expect(normalizeOracleVerdict({ ...base, matchScore: 72.6 }).matchScore).toBe(73);
    // Number('') dan Number(false) = 0. Kalau tidak disaring, kolom kosong berarti
    // "produk salah" dan kandidat bersih hilang tanpa sebab.
    expect(normalizeOracleVerdict({ ...base, matchScore: '' }).matchScore).toBeNull();
    expect(normalizeOracleVerdict({ ...base, matchScore: false }).matchScore).toBeNull();
    expect(normalizeOracleVerdict({ ...base, matchScore: 'ngawur' }).matchScore).toBeNull();
  });

  it('agregat notebook mengalahkan median; bila agregat hilang, median per-frame yang bicara', () => {
    const base = { safe: true, face: false, text: false, watermark: false, graphic: false };
    expect(normalizeOracleVerdict({ ...base, matchScore: 90, perFrame: [{ index: 0, safe: true, matchScore: 10 }] }).matchScore).toBe(90);
    // [10, 10, 100]: median 10, mean akan 40 - satu frame halusinasi tidak boleh menyeret.
    const v = normalizeOracleVerdict({
      ...base,
      perFrame: [
        { index: 0, safe: true, matchScore: 10 },
        { index: 1, safe: true, matchScore: 10 },
        { index: 2, safe: true, matchScore: 100 },
      ],
    });
    expect(v.matchScore).toBe(10);
    // Frame tanpa skor (None di sisi notebook) dibuang, bukan dihitung nol.
    const campur = normalizeOracleVerdict({
      ...base,
      perFrame: [{ index: 0, safe: true, matchScore: null }, { index: 1, safe: true, matchScore: 60 }, { index: 2, safe: true, matchScore: 80 }],
    });
    expect(campur.matchScore).toBe(70);
  });

  it('productMatch:false TIDAK memicu veto kotoran (pass pool/audit tidak pernah menanyakannya)', () => {
    const v = normalizeOracleVerdict({
      safe: true, face: false, text: false, watermark: false, graphic: false,
      productMatch: false, matchScore: 3,
    });
    expect(v.productMatch).toBe(false);
    expect(v.vetoTriggered).toBe(false);
    // Yang menolak karena produk hanya jalur peringkat - lihat preflightCandidatesWithOracle.
  });
});

describe('normalizeOracleVerdict - apparentQuality/lowQuality (kualitas tampak, BUKAN resolusi native)', () => {
  const base = { safe: true, face: false, text: false, watermark: false, graphic: false };

  it('vonis tanpa field kualitas = null (BUKAN 0): notebook lama tidak boleh membuat kandidat gugur', () => {
    const v = normalizeOracleVerdict({ ...base });
    expect(v.apparentQuality).toBeNull();
    expect(v.lowQuality).toBeNull();
    // Kolom kosong/false bukan 'kualitas 0' - persis jebakan matchScore yang sudah diuji.
    expect(normalizeOracleVerdict({ ...base, apparentQuality: '' }).apparentQuality).toBeNull();
    expect(normalizeOracleVerdict({ ...base, apparentQuality: false }).apparentQuality).toBeNull();
  });

  it('agregat dijepit 0..100 dan menang atas median; per-frame mengambil alih bila agregat hilang', () => {
    expect(normalizeOracleVerdict({ ...base, apparentQuality: 78 }).apparentQuality).toBe(78);
    expect(normalizeOracleVerdict({ ...base, apparentQuality: 480 }).apparentQuality).toBe(100);
    expect(normalizeOracleVerdict({ ...base, apparentQuality: -12 }).apparentQuality).toBe(0);
    const per = normalizeOracleVerdict({
      ...base,
      perFrame: [
        { index: 0, safe: true, apparentQuality: 20 },
        { index: 1, safe: true, apparentQuality: 30 },
        { index: 2, safe: true, apparentQuality: 95 },
      ],
    });
    // MEDIAN (30), bukan mean (48): satu frame halusinasi tajam tidak boleh menutup
    // fakta bahwa sumbernya buram - inilah angka yang dipakai operator sebagai filter.
    expect(per.apparentQuality).toBe(30);
  });

  it('lowQuality: boolean eksplisit menang; tanpa skor = null; hanya tanpa-skor-tanpa-flag yang netral', () => {
    expect(normalizeOracleVerdict({ ...base, apparentQuality: 85, lowQuality: true }).lowQuality).toBe(true);
    expect(normalizeOracleVerdict({ ...base, apparentQuality: 12 }).lowQuality).toBe(true);
    expect(normalizeOracleVerdict({ ...base, apparentQuality: 85 }).lowQuality).toBe(false);
    expect(normalizeOracleVerdict(base).lowQuality).toBeNull();
  });
});

describe('isOraclePreflightEnabled + beku-snapshot PREFLIGHT_ORACLE', () => {
  it('efektif hanya bila oracle aktif; default NYALA, mati hanya oleh 0 eksplisit', () => {
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'legacy' })).toBe(false);
    // Oracle mati = tidak ada yang memvonis frame, jadi flag menyala pun tidak boleh
    // memindahkan pre-flight ke Kaggle.
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'legacy', PREFLIGHT_ORACLE: '1' })).toBe(false);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle' })).toBe(true);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle', PREFLIGHT_ORACLE: '0' })).toBe(false);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle', PREFLIGHT_ORACLE: ' 0 ' })).toBe(false);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle', PREFLIGHT_ORACLE: '0 ' })).toBe(false);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle', PREFLIGHT_ORACLE: '' })).toBe(true);
    expect(isOraclePreflightEnabled({ VISION_VERIFY_MODE: 'oracle', PREFLIGHT_ORACLE: 'ya' })).toBe(true);
  });

  it('flag baru ikut dibekukan DAN di-patch balik (kontrak satu-sumber-kebenaran)', () => {
    for (const want of [true, false]) {
      const snap = buildConfigSnapshot({ ...ENV_ON, PREFLIGHT_ORACLE: want ? '1' : '0' });
      expect(snap.PREFLIGHT_ORACLE).toBe(want);
      const patched = configSnapshotToEnvPatch(snap);
      expect(patched.PREFLIGHT_ORACLE).toBe(want ? '1' : '0');
      // Snapshot harus membaca dirinya sendiri: hasil re-eval identik.
      expect(isOraclePreflightEnabled(patched)).toBe(want);
    }
  });
});

describe('preflightCandidatesWithOracle (Lapis 2 + peringkat Lapis 3)', () => {
  const clean = (score) => ({ safe: true, face: false, text: false, watermark: false, graphic: false, productMatch: true, matchScore: score, reason: '' });

  /** Frame sungguhan di disk; frameDir dipakai uji jalur pembersihan. */
  function makeFrameSet(n, tag) {
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-${tag}-`));
    const frames = Array.from({ length: n }, (_, i) => {
      const filePath = path.join(frameDir, `pf_${i}.jpg`);
      fs.writeFileSync(filePath, 'x');
      return { index: i, filePath, timestampMs: i * 1000 };
    });
    return { frameDir, frames };
  }

  /** Ekstraktor suntik: tidak menyentuh jaringan/ffmpeg, tapi bentuknya sama persis. */
  function fakeExtractor(sets) {
    return async (urls, outDir, opts) => urls.map((url, index) => ({
      index, url, outDir, opts,
      frameDir: sets[index] && sets[index].frameDir,
      frames: (sets[index] && sets[index].frames) || [],
    }));
  }

  /** Notebook imut yang berjalan CONCURRENT: klaim terus sampai `expectCount` terjawab. */
  async function serveWhile(jobId, verdictFor, expectCount) {
    const seen = [];
    const run = (async () => {
      for (let i = 0; i < 800; i++) {
        const b = claimOracleBatch({ workerId: 'nb-preflight' });
        if (!b) { await new Promise((r) => setTimeout(r, 20)); continue; }
        if (b.jobId !== jobId) { expireOracleBatch(b.id, 'bukan batch tes'); continue; }
        seen.push(b);
        if (verdictFor) submitOracleResult({ batchId: b.id, verdict: verdictFor(b) });
        else expireOracleBatch(b.id, 'notebook sengaja diam');
        if (seen.length >= expectCount) return seen;
      }
      return seen;
    })();
    return run;
  }

  it('peringkat: bersih dulu, lalu matchScore desc, hanya 2 terbaik diterima', async () => {
    const sets = [makeFrameSet(15, 'rank'), makeFrameSet(15, 'rank'), makeFrameSet(15, 'rank')];
    const scores = [55, 91, 73];
    const serving = serveWhile('pf_rank', (b) => clean(scores[b.sceneIdx - PREFLIGHT_SCENE_BASE]), 3);
    const res = await preflightCandidatesWithOracle(
      [{ url: 'https://a/1' }, { url: 'https://a/2' }, { url: 'https://a/3' }],
      { jobId: 'pf_rank', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    const batches = await serving;
    expect(res.enabled).toBe(true);
    expect(res.judged).toBe(3);
    // 91 (pos 1) dan 73 (pos 2) masuk; 55 (pos 0) kalah peringkat - BUKAN karena kotor.
    expect(res.accepted).toEqual([1, 2]);
    expect(res.rejected).toEqual([0]);
    expect(res.results.find((r) => r.index === 0).dropReason).toBe('kalah peringkat');
    expect(res.results.find((r) => r.index === 0).clean).toBe(true);
    expect(res.untested).toEqual([]);
    // sceneIdx khusus pre-flight: tidak boleh bertabrakan dengan pass pool (0..n) atau audit (10000+).
    expect(batches.map((b) => b.sceneIdx).sort((a, c) => a - c)).toEqual([20000, 20001, 20002]);
    // SATU batch per kandidat - frame kandidat tidak boleh dipecah ke dua batch.
    expect(batches).toHaveLength(3);
    expect(res.framesSent).toBe(45);
    // Prompt pre-flight membawa kontrak skor (satu-satunya pemicu mode peringkat di notebook).
    expect(batches[0].prompt).toContain('matchScore');
    expect(batches[0].prompt).toContain('PRODUCT UNDER TEST');
  }, 30000);

  it('kandidat divonis kotor dibuang meski skornya tertinggi', async () => {
    const sets = [makeFrameSet(4, 'dirty'), makeFrameSet(4, 'dirty')];
    const serving = serveWhile('pf_dirty', (b) => (b.sceneIdx === PREFLIGHT_SCENE_BASE
      ? { safe: false, face: true, text: false, watermark: false, graphic: false, productMatch: true, matchScore: 99, reason: 'ada wajah presenter' }
      : clean(20)), 2);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1', 'https://a/2'],
      { jobId: 'pf_dirty', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    await serving;
    expect(res.accepted).toEqual([1]);
    expect(res.rejected).toEqual([0]);
    expect(res.results.find((r) => r.index === 0).dropReason).toBe('ada wajah presenter');
  }, 30000);

  it('produk tidak cocok = ditolak, tapi TIDAK dicatat sebagai kotor', async () => {
    const sets = [makeFrameSet(4, 'match'), makeFrameSet(4, 'match')];
    const serving = serveWhile('pf_match', (b) => (b.sceneIdx === PREFLIGHT_SCENE_BASE
      ? { safe: true, face: false, text: false, watermark: false, graphic: false, productMatch: false, matchScore: 2, reason: 'barang beda' }
      : clean(60)), 2);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1', 'https://a/2'],
      { jobId: 'pf_match', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    await serving;
    const wrong = res.results.find((r) => r.index === 0);
    expect(wrong.clean).toBe(true);
    expect(wrong.productMatch).toBe(false);
    expect(wrong.dropReason).toBe('produk tidak cocok');
    expect(res.accepted).toEqual([1]);
  }, 30000);

  it('VLM_ORACLE_MIN_QUALITY: kandidat berkualitas rendah DIBUANG meski skornya tertinggi', async () => {
    const withQ = (score, q) => ({ ...clean(score), apparentQuality: q });
    const sets = [makeFrameSet(4, 'pfq'), makeFrameSet(4, 'pfq')];
    // Kandidat 0: skor produk 90 TAPI kualitas sumber 20. Kandidat 1: skor 60, kualitas 88.
    const serving = serveWhile('pf_qual', (b) => (b.sceneIdx === PREFLIGHT_SCENE_BASE ? withQ(90, 20) : withQ(60, 88)), 2);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1', 'https://a/2'],
      { jobId: 'pf_qual', outDir: path.join(os.tmpdir(), 'pf-out'), env: { ...ENV_ON, VLM_ORACLE_MIN_QUALITY: '50' }, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    await serving;
    // Urutan pemotongan: bersih -> produk -> KUALITAS -> peringkat. Skor 90 tidak menyelamatkan.
    expect(res.accepted).toEqual([1]);
    expect(res.rejected).toEqual([0]);
    const low = res.results.find((r) => r.index === 0);
    expect(low.clean).toBe(true);
    expect(low.qualityBlocked).toBe(true);
    expect(low.dropReason).toMatch(/kualitas sumber rendah \(apparentQuality 20 < 50\)/);
    expect(res.results.find((r) => r.index === 1).apparentQuality).toBe(88);
  }, 30000);

  it('Ambang mati (default 0): apparentQuality hanya DICATAT, tidak ada kandidat gugur karenanya', async () => {
    const withQ = (score, q) => ({ ...clean(score), apparentQuality: q });
    const sets = [makeFrameSet(4, 'pfq0')];
    const serving = serveWhile('pf_qual0', () => withQ(70, 5), 1);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1'],
      { jobId: 'pf_qual0', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    await serving;
    expect(res.accepted).toEqual([0]);
    expect(res.rejected).toEqual([]);
    expect(res.results[0].apparentQuality).toBe(5);
    // Flag informatif tetap ada (bekal forensik untuk menetapkan ambang), tapi tidak memvonis buang.
    expect(res.results[0].lowQuality).toBe(true);
    expect(res.results[0].qualityBlocked).toBe(false);
  }, 30000);

  it('Notebook lama tanpa apparentQuality tidak gugur meski ambang tinggi dipasang', async () => {
    const sets = [makeFrameSet(4, 'pfqn')];
    const serving = serveWhile('pf_qualn', () => clean(80), 1);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1'],
      { jobId: 'pf_qualn', outDir: path.join(os.tmpdir(), 'pf-out'), env: { ...ENV_ON, VLM_ORACLE_MIN_QUALITY: '60' }, logger: silent, extractFrames: fakeExtractor(sets) },
    );
    await serving;
    // null = tidak ada informasi, BUKAN 'kualitas 0'. Kalau ini dibuang, deploy server
    // mendahului deploy notebook akan memangkas semua kandidat secara misterius.
    expect(res.accepted).toEqual([0]);
    expect(res.results[0].apparentQuality).toBeNull();
    expect(res.results[0].qualityBlocked).toBe(false);
  }, 30000);

  it('STRICT:false (tooling kalibrasi): oracle tidak menjawab -> kandidat TIDAK dibuang dan tetap ditandai sudah divisit', async () => {
    const sets = [makeFrameSet(4, 'silent'), makeFrameSet(4, 'silent')];
    // Notebook klaim lalu melepas tanpa vonis -> status 'expired' seketika (tanpa tunggu timeout 5s).
    const serving = serveWhile('pf_silent', null, 2);
    const res = await preflightCandidatesWithOracle(
      ['https://a/1', 'https://a/2'],
      { jobId: 'pf_silent', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets), strict: false },
    );
    await serving;
    expect(res.enabled).toBe(true);
    expect(res.judged).toBe(0);
    expect(res.probed).toEqual([0, 1]);
    // Dua hal yang tidak boleh terjadi: masuk daftar rejected, dan tidak masuk probed
    // (pemanggil jadi mengulang pre-flight selamanya - kelas bug yang diperbaiki 4789c76).
    expect(res.rejected).toEqual([]);
    expect(res.untested).toEqual([0, 1]);
    expect(res.accepted).toEqual([]);
  }, 30000);

  it('STRICT: kandidat diklaim tanpa vonis -> LEMPAR OracleUnavailableError(no_verdict)', async () => {
    const sets = [makeFrameSet(4, 'pfstrict')];
    const serving = serveWhile('pf_strict', null, 1);
    let err = null;
    try {
      await preflightCandidatesWithOracle(['https://a/1'], {
        jobId: 'pf_strict', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets),
      });
    } catch (e) { err = e; }
    await serving;
    expect(err, 'kandidat tanpa vonis tidak boleh lagi lanjut ke Gemini lama').toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('no_verdict');
  }, 30000);

  it('STRICT: vonis pre-flight tidak sah -> LEMPAR OracleUnavailableError(invalid_verdict)', async () => {
    const sets = [makeFrameSet(4, 'pfbad')];
    const serving = serveWhile('pf_bad', () => ({ text: 'prosa, bukan vonis' }), 1);
    let err = null;
    try {
      await preflightCandidatesWithOracle(['https://a/1'], {
        jobId: 'pf_bad', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets),
      });
    } catch (e) { err = e; }
    await serving;
    expect(err).toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('invalid_verdict');
  }, 30000);

  it('oracle mati total -> enabled:false dan ekstraksi TIDAK pernah dipanggil', async () => {
    let called = 0;
    const res = await preflightCandidatesWithOracle(
      ['https://a/1'],
      { jobId: 'pf_off', env: ENV_OFF, logger: silent, extractFrames: async () => { called += 1; return []; } },
    );
    expect(res.enabled).toBe(false);
    expect(res.probed).toEqual([]);
    expect(called).toBe(0);
  });

  it('STRICT:false (tooling): ekstraksi gagal total -> tanpa_frame, Gemini yang menilai (bukan semua kandidat dibuang)', async () => {
    const res = await preflightCandidatesWithOracle(
      ['https://a/1', 'https://a/2'],
      { jobId: 'pf_noframe', env: { ...ENV_ON, VLM_ORACLE_PREFLIGHT_EXTRACT_RETRIES: '0' }, logger: silent, extractFrames: async () => [], strict: false },
    );
    expect(res.enabled).toBe(false);
    expect(res.note).toBe('tanpa_frame');
    expect(res.rejected).toEqual([]);
  });

  it('STRICT:false (tooling): ekstraktor melempar -> note ekstraksi_gagal, tidak menjatuhkan pemanggil', async () => {
    const res = await preflightCandidatesWithOracle(
      ['https://a/1'],
      { jobId: 'pf_throw', env: { ...ENV_ON, VLM_ORACLE_PREFLIGHT_EXTRACT_RETRIES: '0' }, logger: silent, extractFrames: async () => { throw new Error('youtube menolak'); }, strict: false },
    );
    expect(res.enabled).toBe(false);
    expect(res.note).toBe('ekstraksi_gagal');
  });

  // --- Retry ekstraksi pra-flight (regresi throttle 4 Okt 2026, auto_2fff755605) ---

  it('RETRY: 0 frame pada percobaan pertama (throttle sementara) -> kandidat tetap divisit, job tidak mati', async () => {
    const sets = [makeFrameSet(4, 'retryok')];
    let calls = 0;
    const flaky = async (urls) => {
      calls += 1;
      if (calls === 1) return [];
      return urls.map((url, index) => ({ index, url, frameDir: sets[index].frameDir, frames: sets[index].frames }));
    };
    const serving = serveWhile('pf_retry_ok', () => clean(80), 1);
    const res = await preflightCandidatesWithOracle(['https://a/1'], {
      jobId: 'pf_retry_ok', outDir: path.join(os.tmpdir(), 'pf-out'),
      env: { ...ENV_ON, VLM_ORACLE_PREFLIGHT_EXTRACT_RETRIES: '2', VLM_ORACLE_PREFLIGHT_RETRY_DELAY_MS: '5' },
      logger: silent, extractFrames: flaky,
    });
    await serving;
    expect(calls).toBe(2); // percobaan pertama nol, kedua berhasil -> berhenti tanpa mencoba ke-3
    expect(res.enabled).toBe(true);
    expect(res.accepted).toEqual([0]);
  }, 30000);

  it('RETRY: ekstraktor melempar lalu pulih -> vonis tetap jalan (error sesaat BUKAN lagi vonis mati)', async () => {
    const sets = [makeFrameSet(4, 'retryth')];
    let calls = 0;
    const flaky = async (urls) => {
      calls += 1;
      if (calls === 1) throw new Error('googlevideo timeout');
      return urls.map((url, index) => ({ index, url, frameDir: sets[index].frameDir, frames: sets[index].frames }));
    };
    const serving = serveWhile('pf_retry_th', () => clean(70), 1);
    const res = await preflightCandidatesWithOracle(['https://a/1'], {
      jobId: 'pf_retry_th', outDir: path.join(os.tmpdir(), 'pf-out'),
      env: { ...ENV_ON, VLM_ORACLE_PREFLIGHT_EXTRACT_RETRIES: '1', VLM_ORACLE_PREFLIGHT_RETRY_DELAY_MS: '5' },
      logger: silent, extractFrames: flaky,
    });
    await serving;
    expect(calls).toBe(2);
    expect(res.accepted).toEqual([0]);
  }, 30000);

  it('STRICT: nol frame di SEMUA percobaan -> tetap LEMPAR OracleUnavailableError(infra) setelah retry habis', async () => {
    let calls = 0;
    let err = null;
    try {
      await preflightCandidatesWithOracle(['https://a/1'], {
        jobId: 'pf_retry_strict', outDir: path.join(os.tmpdir(), 'pf-out'),
        env: { ...ENV_ON, VLM_ORACLE_PREFLIGHT_EXTRACT_RETRIES: '2', VLM_ORACLE_PREFLIGHT_RETRY_DELAY_MS: '5' },
        logger: silent, extractFrames: async () => { calls += 1; return []; },
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OracleUnavailableError);
    expect(err.reason).toBe('infra');
    expect(calls).toBe(3); // 1 + 2 retry - kebijakan STRICT tidak dilonggarkan, hanya diberi napas
  }, 30000);

  it('STABILITAS INDEKS: kandidat yang gagal ekstraksi tidak menggeser posisi yang dilaporkan', async () => {
    const sets = [makeFrameSet(4, 'idx'), makeFrameSet(4, 'idx')];
    // Posisi 0 HILANG dari hasil ekstraktor (kirus), hanya index 1 yang balik.
    const partial = async (urls, outDir, opts) => [{
      index: 1, url: urls[1], frameDir: sets[1].frameDir, frames: sets[1].frames, opts,
    }];
    const serving = serveWhile('pf_idx', () => clean(77), 1);
    const res = await preflightCandidatesWithOracle(
      ['https://a/0', 'https://a/1', 'https://a/2'],
      { jobId: 'pf_idx', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: partial },
    );
    const batches = await serving;
    // Indeks yang dilaporkan = posisi di array pemanggil, bukan posisi di daftar hasil.
    expect(res.probed).toEqual([1]);
    expect(res.results.map((r) => r.index)).toEqual([1]);
    expect(batches[0].sceneIdx).toBe(PREFLIGHT_SCENE_BASE + 1);
    expect(res.accepted).toEqual([1]);
  }, 30000);

  it('maxCandidates membatasi jumlah video yang diunduh; url kosong dilewati', async () => {
    const sets = [makeFrameSet(3, 'cap'), makeFrameSet(3, 'cap'), makeFrameSet(3, 'cap')];
    const serving = serveWhile('pf_cap', () => clean(50), 3);
    const res = await preflightCandidatesWithOracle(
      [null, { url: '' }, 'https://a/2', 'https://a/3', 'https://a/4', 'https://a/5'],
      { jobId: 'pf_cap', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets), maxCandidates: 3 },
    );
    const batches = await serving;
    expect(batches.map((b) => b.sceneIdx).sort((a, c) => a - c)).toEqual([20002, 20003, 20004]);
    expect(res.probed).toEqual([2, 3, 4]);
  }, 30000);

  it('parameter ekstraksi diteruskan apa adanya (15 detik, 1 fps, 360p)', async () => {
    const sets = [makeFrameSet(2, 'param')];
    let got = null;
    const spy = async (urls, outDir, opts) => { got = opts; return fakeExtractor(sets)(urls, outDir, opts); };
    const serving = serveWhile('pf_param', () => clean(80), 1);
    await preflightCandidatesWithOracle(['https://a/1'], {
      jobId: 'pf_param', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: spy,
    });
    await serving;
    expect(got).toMatchObject({ seconds: 15, fps: 1, height: 360 });
  }, 30000);

  it('frame kandidat dibersihkan setelah vonis dipakai (tidak tinggal berobat di disk)', async () => {
    const sets = [makeFrameSet(4, 'sweep')];
    const serving = serveWhile('pf_sweep', () => clean(80), 1);
    const res = await preflightCandidatesWithOracle(['https://a/1'], {
      jobId: 'pf_sweep', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent, extractFrames: fakeExtractor(sets),
    });
    await serving;
    expect(res.judged).toBe(1);
    expect(fs.existsSync(sets[0].frameDir)).toBe(false);
  }, 30000);

  it('STRICT:false (tooling): frame habis sebelum dikirim -> untested, bukan rejected', async () => {
    const sets = [{ frameDir: '', frames: [] }];
    const res = await preflightCandidatesWithOracle(['https://a/1'], {
      jobId: 'pf_ghost', outDir: path.join(os.tmpdir(), 'pf-out'), env: ENV_ON, logger: silent,
      extractFrames: async () => [{ index: 0, frameDir: '', frames: [] }], strict: false,
    });
    expect(sets).toHaveLength(1);
    expect(res.probed).toEqual([0]);
    expect(res.untested).toEqual([0]);
    expect(res.rejected).toEqual([]);
  });
});

describe('orderCandidatesAfterPreflight (kontrak fail-open pemanggil)', () => {
  // Inilah satu-satunya tempat kandidat dibuang setelah Kaggle ikut pre-flight.
  // Fungsi ini dulunya ditulis inline di stage1Render; satu baris yang salah di sini
  // membuat kandidat yang TIDAK divisit hilang diam-diam dan tidak ada tes pipeline
  // yang menangkapnya - makanya ia jadi fungsi murni di service.
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const ids = (list) => list.map((c) => c.id);

  it('hanya rejected yang keluar; accepted paling depan, sisanya pertahankan urutan', () => {
    const out = orderCandidatesAfterPreflight(pool, { accepted: [3, 0], untested: [2], probed: [0, 2, 3, 1], rejected: [1] });
    // accepted urut sesuai daftar (sudah matchScore desc dari service).
    expect(ids(out)).toEqual(['d', 'a', 'c', 'e']);
  });

  it('yang divisit tapi tanpa vonis TIDAK hilang walau tidak diterima (oracle diam bukan bukti salah)', () => {
    const out = orderCandidatesAfterPreflight(pool, { accepted: [], untested: [0, 1], probed: [0, 1], rejected: [] });
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('kepunyaan kandidat terjamin: keluaran = masuk dikurangi rejected saja', () => {
    const pf = { accepted: [1], untested: [3], probed: [0, 1, 2, 3], rejected: [0, 2] };
    const out = orderCandidatesAfterPreflight(pool, pf);
    expect(out).toHaveLength(pool.length - pf.rejected.length);
    expect(new Set(out).size).toBe(out.length); // tidak ada duplikat
    for (const rel of pf.rejected) expect(out).not.toContain(pool[rel]);
    for (const rel of [1, 3, 4]) expect(out).toContain(pool[rel]);
  });

  it('indeks di luar jangkauan / field hilang tidak melempar', () => {
    expect(ids(orderCandidatesAfterPreflight(pool, { accepted: [9], untested: [-1], probed: [99], rejected: [7] }))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(orderCandidatesAfterPreflight(pool, {})).toEqual(pool);
    expect(orderCandidatesAfterPreflight([], { accepted: [0] })).toEqual([]);
    expect(orderCandidatesAfterPreflight()).toEqual([]);
  });
});

describe('jobStore - heartbeat notebook & lastStatus (fondasi gerbang koneksi)', () => {
  it('touchOracleHeartbeat idempoten dan terbaca di oracleLastSeenMs + oracleQueueStats', () => {
    const t = Date.now();
    expect(touchOracleHeartbeat('nb-hb', t)).toMatchObject({ workerId: 'nb-hb', lastSeenAt: t });
    expect(oracleLastSeenMs()).toBeGreaterThanOrEqual(t);
    touchOracleHeartbeat('nb-hb', t + 5000); // worker yang sama HANYA menaikkan umur, bukan duplikat baris
    expect(oracleLastSeenMs()).toBe(t + 5000);
    expect(oracleQueueStats().lastSeenAt).toBe(t + 5000);
  });

  it('batch tak pernah diklaim: waitForOracleVerdict -> status timeout dengan lastStatus pending', async () => {
    enqueueOracleBatch({ id: 'q_hb_never', jobId: 'hb', sceneIdx: 0, frames: [{ index: 0, filePath: path.join(os.tmpdir(), 'hb-tak-ada.jpg') }], prompt: 'p' });
    const waited = await waitForOracleVerdict('q_hb_never', { timeoutMs: 150, pollMs: 50 });
    expect(waited.status).toBe('timeout');
    // 'pending' = tidak pernah diklaim -> pemanggil STRICT melaporkan never_claimed.
    expect(waited.lastStatus).toBe('pending');
    expireOracleBatch('q_hb_never', 'bersihkan tes heartbeat');
  });

  it('batch tak dikenal: lastStatus unknown (bukan pending diam-diam)', async () => {
    const waited = await waitForOracleVerdict('q_hb_hantu', { timeoutMs: 1, pollMs: 1 });
    expect(waited.status).toBe('unknown');
    expect(waited.lastStatus).toBe('unknown');
  });

  it('wiring gerbang: endpoint claim memanggil touchOracleHeartbeat untuk SETIAP polling (cek source, pola tokenAuth.test)', () => {
    // Polling KOSONG pun harus terhitung "notebook hidup" - klaim adalah satu-satunya
    // sinyal koneksi yang jujur (Kaggle tidak punya inbound). Sedikit goyah bila handler
    // di-refactor; perbarui regex ini bersama routes-nya.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'api/routes/vlmOracleRoutes.js'), 'utf8');
    expect(src).toMatch(/touchOracleHeartbeat/);
    expect(src.indexOf("router.post('/vlm-oracle/claim'")).toBeLessThan(src.indexOf('touchOracleHeartbeat(workerId)'));
  });

  it('wiring idle-exit: respons klaim KOSONG wajib membawa activeJobs (cek source, pola yang sama)', () => {
    // Notebook hanya boleh membunuh kernel bila server bilang tidak ada job sibuk.
    // Tanpa field ini, jeda render panjang (antrean kosong!) akan menghentikan job
    // audit klip final di 61% - kegagalan yang dibeli dengan fitur hemat kuota.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'api/routes/vlmOracleRoutes.js'), 'utf8');
    expect(src).toMatch(/countBusyOracleJobs/);
    expect(src).toMatch(/claimed: false[\s\S]{0,220}activeJobs: countBusyOracleJobs\(\)/);
  });
});

describe('countBusyOracleJobs - sinyal "jangan bunuh diri" untuk idle-exit notebook', () => {
  const T0 = Date.now() + 10_000_000; // jauh ke depan: memo 10 detik tidak pernah bentrok
  const iso = (ms) => new Date(ms).toISOString();

  it('hanya stage non-terminal yang sentuh-baru dihitung; terminal/lama tidak; tanpa-timestamp konservatif sibuk', () => {
    activeJobs.set('busy_rekan', { id: 'busy_rekan', stage: 'rendering', updatedAt: iso(T0 - 60_000) });
    activeJobs.set('selesai_rekan', { id: 'selesai_rekan', stage: 'completed', updatedAt: iso(T0 - 60_000) });
    activeJobs.set('mati_rekan', { id: 'mati_rekan', stage: 'running', updatedAt: iso(T0 - 3_700_000) }); // > window 1 jam
    expect(countBusyOracleJobs({ now: T0, windowMs: 3_600_000 })).toBe(1);
    // Baris TANPA updatedAt: konservatif = sibuk. Sengaja dibaca dengan `now` >10s
    // kemudian supaya memo cache tidak mengembalikan nilai test sebelumnya.
    activeJobs.set('hantu_rekan', { id: 'hantu_rekan', stage: 'clip_audit' });
    expect(countBusyOracleJobs({ now: T0 + 20_000, windowMs: 3_600_000 })).toBe(2);
  });
});

describe('assertOracleConnected - gerbang "Kaggle terhubung" sebelum kerja berat', () => {
  it('mode efektif bukan oracle -> ok:false detail mode_not_oracle', () => {
    const r = assertOracleConnected({ logger: silent, env: { ...ENV_OFF, API_ACCESS_TOKEN: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('mode_not_oracle');
    expect(r.message).toMatch(/VISION_VERIFY_MODE=oracle/);
  });

  it('API_ACCESS_TOKEN kosong -> ok:false detail token_kosong (endpoint akan 503)', () => {
    const r = assertOracleConnected({ logger: silent, env: { VISION_VERIFY_MODE: 'oracle', API_ACCESS_TOKEN: '   ' } });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('token_kosong');
  });

  it('mode oracle + token + heartbeat segar -> ok:true connected', () => {
    touchOracleHeartbeat('nb-gate', Date.now());
    const r = assertOracleConnected({ logger: silent, env: { ...ENV_ON, API_ACCESS_TOKEN: 'token-tes' } });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('connected');
    expect(r.lastSeenAt).toBeGreaterThan(0);
  });
  // CATATAN: cabang 'notebook_offline' sengaja TIDAK diuji eksplisit - oracleLastSeenMs
  // adalah MAX lintas worker, jadi begitu satu heartbeat segar tertanam di DB tes yang
  // sama ia tidak bisa dibuat basi lagi. Jalur itu ter-cover smoke manual (notebook mati).
});

describe('oracleLauncherService - auto-launch sesi Kaggle saat job berjalan (mandate 2026-10)', () => {
  const ENV_LAUNCH = { ...ENV_ON, API_ACCESS_TOKEN: 'tok-tes', ORACLE_AUTO_LAUNCH: '1', ORACLE_AUTO_LAUNCH_CMD: '/tmp/fake-launch.sh' };
  const mkSpawn = (calls) => (bin, args, opts) => { calls.push({ bin, args, opts }); return { on() {}, unref() {} }; };

  it('flag OFF (default) -> flag_off, spawn TIDAK pernah dipanggil', () => {
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: { ...ENV_ON, API_ACCESS_TOKEN: 'tok' }, logger: silent, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: false, reason: 'flag_off' });
    expect(calls).toHaveLength(0);
  });

  it("ORACLE_AUTO_LAUNCH='true' (bukan cuma '1') -> TETAP aktif (regresi footgun .env Termux)", () => {
    __resetAutoLaunchCooldown();
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: { ...ENV_LAUNCH, ORACLE_AUTO_LAUNCH: 'true' }, logger: silent, now: Date.now() + 10 * 60000, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: true, reason: 'launched', cmd: '/tmp/fake-launch.sh' });
    expect(calls).toHaveLength(1);
    __resetAutoLaunchCooldown();
  });

  it('token kosong -> token_kosong walau flag ON', () => {
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: { ...ENV_LAUNCH, API_ACCESS_TOKEN: '' }, logger: silent, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: false, reason: 'token_kosong' });
    expect(calls).toHaveLength(0);
  });

  it('heartbeat masih segar -> notebook_alive, tidak ada sesi ganda', () => {
    touchOracleHeartbeat('nb-launch', Date.now());
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: ENV_LAUNCH, logger: silent, now: Date.now(), spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: false, reason: 'notebook_alive' });
    expect(calls).toHaveLength(0);
  });

  it('heartbeat basi (now = +10 mnt) -> spawn detached bash <cmd>', () => {
    __resetAutoLaunchCooldown();
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: ENV_LAUNCH, logger: silent, now: Date.now() + 10 * 60000, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: true, reason: 'launched', cmd: '/tmp/fake-launch.sh' });
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('bash');
    expect(calls[0].args).toEqual(['/tmp/fake-launch.sh']);
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('pemanggilan kedua dalam cooldown -> cooldown, tanpa spawn baru', () => {
    const calls = [];
    // lastLaunchAtMs masih +10 mnt dari tes sebelumnya; now sama -> selisih 0 < cooldown.
    const r = maybeAutoLaunchOracle({ env: ENV_LAUNCH, logger: silent, now: Date.now() + 10 * 60000, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: false, reason: 'cooldown' });
    expect(calls).toHaveLength(0);
    __resetAutoLaunchCooldown();
  });

  // ─── ZOMBIE-PROOF (regresi idle-exit ~5 mnt = staleMs, 2026-10-04) ───
  it('force=true (zombie dikonfirmasi) -> TETAP launch walau heartbeat segar + args dapat --force', () => {
    __resetAutoLaunchCooldown();
    touchOracleHeartbeat('nb-zombie', Date.now()); // heartbeat sengaja SEGAR
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: ENV_LAUNCH, logger: silent, now: Date.now(), force: true, spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: true, reason: 'launched', cmd: '/tmp/fake-launch.sh', forced: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['/tmp/fake-launch.sh', '--force']);
    __resetAutoLaunchCooldown();
  });

  it('force=false + heartbeat segar -> notebook_alive (guard lama UTUH, tak berubah)', () => {
    __resetAutoLaunchCooldown();
    touchOracleHeartbeat('nb-segar', Date.now());
    const calls = [];
    const r = maybeAutoLaunchOracle({ env: ENV_LAUNCH, logger: silent, now: Date.now(), spawnFn: mkSpawn(calls) });
    expect(r).toMatchObject({ triggered: false, reason: 'notebook_alive' });
    expect(calls).toHaveLength(0);
  });

  it('waitForOracleOnline(afterMs=baseline): heartbeat zombie yang TIDAK maju -> timeout; heartbeat maju -> terhubung', async () => {
    const baseline = Date.now() - 30_000; // heartbeat zombie: 30 dtk lalu (masih < staleMs)
    // (1) notebook belum benar-benar restart -> lastSeen tetap = baseline -> TOLAK,
    //     meski usianya < staleMs. Inilah inti perbaikan zombie.
    const rNo = await waitForOracleOnline({
      env: ENV_ON, logger: silent, waitMs: 200, pollMs: 40, deadline: Date.now(), afterMs: baseline,
      lastSeenFn: () => baseline, sleep: async () => {},
    });
    expect(rNo).toMatchObject({ ok: false, detail: 'notebook_offline' });
    // (2) sesi BARU memanggil API -> lastSeen MAJU melampaui baseline -> TERHUBUNG.
    const rYes = await waitForOracleOnline({
      env: ENV_ON, logger: silent, waitMs: 1000, pollMs: 5, deadline: Date.now(), afterMs: baseline,
      lastSeenFn: () => Date.now() + 5000, sleep: async () => {},
    });
    expect(rYes).toMatchObject({ ok: true, detail: 'connected' });
  });

  it('probeOracleKernelAlive: COMPLETE->false, RUNNING->true, keluaran kosong/err->unknown', async () => {
    const execOk = (out) => (bin, args, opts, cb) => cb(null, out, '');
    const envK = { KAGGLE_USER: 'u', KAGGLE_BIN: 'kg' };
    const dead = await probeOracleKernelAlive({ env: envK, logger: silent, execFileFn: execOk('u/clippervps-vlm-oracle has status: KernelWorkerStatus.COMPLETE') });
    expect(dead.alive).toBe(false);
    const run = await probeOracleKernelAlive({ env: envK, logger: silent, execFileFn: execOk('u/clippervps-vlm-oracle has status: KernelWorkerStatus.RUNNING') });
    expect(run.alive).toBe(true);
    // Frasa menjebak 'not running' + COMPLETE -> harus MATI, bukan hidup.
    const trap = await probeOracleKernelAlive({ env: envK, logger: silent, execFileFn: execOk('kernel is currently not running (COMPLETE)') });
    expect(trap.alive).toBe(false);
    // CLI error tanpa keluaran -> unknown (konservatif: JANGAN paksa launch).
    const err = await probeOracleKernelAlive({ env: envK, logger: silent, execFileFn: (b, a, o, cb) => cb(new Error('boom'), '', '') });
    expect(err.alive).toBe('unknown');
    // User tak dikenal -> unknown (tak menyusun referensi kernel kosong).
    const noUser = await probeOracleKernelAlive({ env: { KAGGLE_BIN: 'kg', HOME: '/nonexistent-zz' }, logger: silent, execFileFn: execOk('x') });
    expect(noUser.alive).toBe('unknown');
  });

  it('waitForOracleOnline: heartbeat muncul di tengah tunggu -> ok:true', async () => {
    let i = 0;
    const seq = [0, 0, Date.now()]; // dua poll basi, lalu notebook terlihat
    const r = await waitForOracleOnline({
      env: ENV_ON, logger: silent, waitMs: 5000, pollMs: 5, deadline: Date.now(),
      lastSeenFn: () => seq[Math.min(i++, seq.length - 1)], sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: true, detail: 'connected' });
  });

  it('waitForOracleOnline: deadline lewat tanpa heartbeat -> ok:false notebook_offline', async () => {
    const r = await waitForOracleOnline({
      env: ENV_ON, logger: silent, waitMs: 250, pollMs: 50, deadline: Date.now(),
      lastSeenFn: () => 0, sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: false, detail: 'notebook_offline' });
    expect(r.message).toMatch(/Auto-launch sudah dikirim/);
  });
});

// Sanitasi: konversi 360p sengaja menulis di bawah server/temp/oracle_frames (itu
// perilaku default yang juga diuji di file ini), jadi direktori milik tes dibuang
// supaya tidak meninggalkan sampah di tree produksi perangkat.
afterAll(() => {
  const base = path.join(tempDir, 'oracle_frames');
  if (!fs.existsSync(base)) return;
  const milikTes = ['zero', 'diam', 'kotor', 'agregat', 'sampah', 'peta', 'raw', 'small', 'ghost', 'conv', 'junk', 'a_', 'off', 'strict'];
  for (const name of fs.readdirSync(base)) {
    if (!milikTes.some((p) => name.startsWith(p))) continue;
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { }
  }
  try { if (fs.readdirSync(base).length === 0) fs.rmdirSync(base); } catch { }
});

