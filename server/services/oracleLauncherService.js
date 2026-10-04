// oracleLauncherService.js
// ─────────────────────────────────────────────────────────────────────────
// Menyalakan SESI ORACLE Kaggle OTOMATIS dari perangkat yang menjalankan
// server (Termux proot), tanpa PC/PowerShell/browser. Ini jawaban untuk
// mandate user 2026-10: "saya ingin deploy.ps1 -FromTermux otomatis saat job
// berjalan, hanya Kaggle (bukan legacy)".
//
// Cara kerja (satu arah — Kaggle tidak bisa di-inbound):
//   1) stage1Render memanggil assertOracleConnected(); bila GAGAL karena
//      'notebook_offline', kita panggil maybeAutoLaunchOracle();
//   2) fungsi ini men-spawn `bash kaggle/oracle-launch.sh` DETACHED — script
//      itu melakukan `kaggle kernels push` yang langsung menjalankan versi
//      baru (tanpa tombol Run);
//   3) job lalu MENUNGGU heartbeat notebook muncul (waitForOracleOnline)
//      sebelum kerja berat, bukan langsung gagal.
//
// Pengaman kuota GPU (sesi ganda = kuota hangus):
//   - fitur ini MATI kecuali ORACLE_AUTO_LAUNCH=1 (default aman di PC);
//   - tidak menembak apa pun bila notebook masih heartbeat-segar;
//   - cooldown antar-launch (default 10 mnt) + guard
//     "skip live" di dalam script launcher itu sendiri.
// Tidak pernah melempar: kegagalan launcher dikembalikan sebagai objek.
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleLastSeenMs } from '../store/jobStore.js';
import { resolveOracleConfig } from './vlmOracleService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CMD = path.join(REPO_ROOT, 'kaggle', 'oracle-launch.sh');

// Timestamp launch terakhir (module-scope; cukup untuk satu proses server).
let lastLaunchAtMs = 0;

/**
 * Flag utama: fitur mati kecuali diaktifkan eksplisit lewat env.
 * FIX 2026-10-04: dulu HANYA menerima '1'. Padahal nilai di .env Termux adalah
 * 'true' (dan root .env menimpa server/.env saat boot), sehingga auto-launch diam-diam
 * jadi flag_off -> kernel Kaggle tak pernah disentuh -> batch pre-flight tak diklaim ->
 * job mati "oracle tidak terhubung". Kini ikut konvensi boolean proyek yang lain
 * (lihat runtimeFlags GEMINI_SCENE_DISCOVERY): '1' ATAU 'true' (case-insensitive) = aktif.
 */
export function isOracleAutoLaunchEnabled(env = process.env) {
  const v = String(env.ORACLE_AUTO_LAUNCH || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Reset cooldown — HANYA untuk tes. */
export function __resetAutoLaunchCooldown() {
  lastLaunchAtMs = 0;
}

/**
 * Ambil keputusan: perlu launch sesi baru atau tidak, dan (bila perlu) spawn
 * launcher DETACHED. Murni terhadap jam (arg `now`) & spawn (arg `spawnFn`)
 * supaya bisa diuji tanpa menyentuh Kaggle sungguhan.
 * Return { triggered, reason, cmd?, waitMs?, error? }.
 */
export function maybeAutoLaunchOracle({ env = process.env, logger = console, now = Date.now(), spawnFn = null } = {}) {
  if (!isOracleAutoLaunchEnabled(env)) return { triggered: false, reason: 'flag_off' };

  const cfg = resolveOracleConfig(env);
  if (!cfg.enabled) return { triggered: false, reason: 'mode_not_oracle' };
  if (!String(env.API_ACCESS_TOKEN || '').trim()) return { triggered: false, reason: 'token_kosong' };

  // Notebook masih berdenyut -> sesi sudah hidup; jangan buang kuota.
  const last = oracleLastSeenMs();
  if (last && now - last <= cfg.staleMs) return { triggered: false, reason: 'notebook_alive', lastSeenAt: last };

  // Cooldown: jangan push kernel tiap batch/frame. idle-exit notebook kini 5 mnt
  // (4 Okt 2026) — cooldown lama (25 mnt) akan memblokir restart job berikutnya
  // setelah sesi mati rapi. 10 mnt cukup menahan thrashing push-gagal/boot-lama,
  // guard 'notebook_alive' (heartbeat segar) tetap yang pertama menyaring.
  const cooldownMs = Math.max(1, Number(env.ORACLE_AUTO_LAUNCH_COOLDOWN_MIN) || 10) * 60000;
  if (now - lastLaunchAtMs < cooldownMs) {
    return { triggered: false, reason: 'cooldown', waitMs: cooldownMs - (now - lastLaunchAtMs) };
  }

  const cmd = String(env.ORACLE_AUTO_LAUNCH_CMD || '').trim() || DEFAULT_CMD;
  const sp = spawnFn || spawn;
  try {
    // stdio 'ignore' + detached + unref: server TIDAK menggantung kalau CLI lambat;
    // launcher menulis log sendiri ke logs/oracle-launch.log.
    const child = sp('bash', [cmd], { detached: true, stdio: 'ignore', cwd: REPO_ROOT });
    child.on('error', (e) => logger?.log?.(`[OracleAutoLaunch] spawn error: ${e.message}`));
    child.unref();
    lastLaunchAtMs = now;
    logger?.log?.(`[OracleAutoLaunch] 🚀 Menyalakan sesi Kaggle via '${cmd}' (detached). Tunggu heartbeat...`);
    return { triggered: true, reason: 'launched', cmd };
  } catch (e) {
    return { triggered: false, reason: 'spawn_failed', error: e.message };
  }
}

/**
 * Tunggu sampai heartbeat notebook SEGAR (atau deadline lewat). Ini yang membuat
 * job "sabar" menunggu Kaggle boot (pip + muat model ~90-180 dtk) alih-alih gagal
 * seketika. Tidak melempar; return { ok, detail, lastSeenAt, message }.
 */
export async function waitForOracleOnline({
  env = process.env,
  logger = console,
  waitMs = Math.max(15, Number(env.ORACLE_AUTO_LAUNCH_WAIT_SEC) || 300) * 1000,
  pollMs = 5000,
  deadline = Date.now(),
  lastSeenFn = oracleLastSeenMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = resolveOracleConfig(env);
  const hardStop = deadline + waitMs;
  let tick = 0;
  while (Date.now() <= hardStop) {
    const last = lastSeenFn();
    if (last && Date.now() - last <= cfg.staleMs) {
      logger?.log?.(`[OracleAutoLaunch] ✅ Notebook terlihat (${Math.round((Date.now() - last) / 1000)} dtk lalu). Lanjut kerja berat.`);
      return { ok: true, detail: 'connected', lastSeenAt: last, message: 'Oracle Kaggle terhubung (auto-launch).' };
    }
    if (tick % 3 === 0) {
      const sisa = Math.max(0, Math.round((hardStop - Date.now()) / 1000));
      logger?.log?.(`[OracleAutoLaunch] menunggu heartbeat notebook... (sisa ${sisa} dtk)`);
    }
    tick += 1;
    await sleep(Math.min(pollMs, Math.max(250, hardStop - Date.now())));
  }
  const last = lastSeenFn();
  return {
    ok: false,
    detail: 'notebook_offline',
    lastSeenAt: last || null,
    message: `Auto-launch sudah dikirim tapi notebook belum memanggil API dalam ${Math.round(waitMs / 1000)} dtk. Cek logs/oracle-launch.log & 'kaggle kernels status'.`,
  };
}
