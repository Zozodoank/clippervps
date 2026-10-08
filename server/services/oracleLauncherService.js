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
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oracleLastSeenMs } from '../store/jobStore.js';
import { resolveOracleConfig } from './vlmOracleService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CMD = path.join(REPO_ROOT, 'kaggle', 'oracle-launch.sh');
const LAUNCH_STATUS_DIR = path.join(REPO_ROOT, 'logs');

// Timestamp launch terakhir (module-scope; cukup untuk satu proses server).
let lastLaunchAtMs = 0;

function launchStatusFile(launchId) {
  const safeId = String(launchId || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return safeId ? path.join(LAUNCH_STATUS_DIR, `oracle-launch-${safeId}.status`) : '';
}

/** Status ditulis oleh oracle-launch.sh agar kegagalan detached tidak berubah timeout samar. */
function readLaunchStatus(launchId) {
  const file = launchStatusFile(launchId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const [state = '', at = '', ...messageParts] = fs.readFileSync(file, 'utf8').trim().split('\t');
    return { state, at: Number(at) || 0, message: messageParts.join('\t').trim() };
  } catch {
    return null;
  }
}

function writeLaunchStatus(launchId, state, message) {
  const file = launchStatusFile(launchId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = `${state}\t${Math.floor(Date.now() / 1000)}\t${String(message || '').replace(/[\r\n\t]/g, ' ')}\n`;
    fs.writeFileSync(`${file}.${process.pid}.tmp`, text, 'utf8');
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch { /* status observability must not interrupt the job */ }
}

/**
 * Flag utama: fitur mati kecuali diaktifkan eksplisit lewat env.
 * FIX 2026-10-04: dulu HANYA menerima '1'. Padahal nilai di .env Termux adalah
 * 'true' (dan root .env menimpa server/.env saat boot), sehingga auto-launch diam-diam
 * jadi flag_off -> kernel Kaggle tak pernah disentuh -> batch pre-flight tak diklaim ->
 * job mati "oracle tidak terhubung". Kini ikut konvensi boolean proyek yang lain
 * (legacy flag) tidak mengaktifkan jalur visual lokal.
 */
export function isOracleAutoLaunchEnabled(env = process.env) {
  const v = String(env.ORACLE_AUTO_LAUNCH || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

// ─────────────────────────────────────────────────────────────────────────
// ZOMBIE-PROOF (regresi 2026-10-04): sejak Kaggle memangkas idle-exit menjadi
// ~5 menit — sama persis dengan ambang 'notebook hidup' VLM_ORACLE_STALE_SEC
// (300 dtk) — sebuah notebook yang BARU mati masih menyimpan heartbeat 'segar'.
// Gerbang heartbeat saja salah menyimpulkan 'hidup' -> auto-launch dilewati ->
// pre-flight enqueue batch -> tak pernah di-claim (kernel sebenarnya mati) ->
// job mati 'never_claimed'. Ground truth sejati = status kernel Kaggle, jadi
// kita probe `kaggle kernels status` untuk membongkar zombie tanpa membuat sesi
// ganda (hanya menendang ulang bila kernel PASTI mati, bukan saat tak yakin).
// ─────────────────────────────────────────────────────────────────────────
const KERNEL_RUNNING_TOKENS = ['RUNNING', 'QUEUED', 'PROVISIONING', 'PULLING', 'STARTING'];
const KERNEL_DEAD_TOKENS = ['COMPLETE', 'COMPLETED', 'STOPPED', 'SHUTDOWN', 'IDLE', 'FAILED', 'NONE', 'WITHDRAWN'];

/** Ambil token status dari keluaran CLI (mis. 'KernelWorkerStatus.COMPLETE' -> 'COMPLETE'). */
function parseKernelState(raw) {
  const s = String(raw || '');
  const m = s.match(/KernelWorkerStatus[._-]?([A-Za-z_]+)/);
  const tok = (m ? m[1] : '').toUpperCase();
  if (tok) return tok;
  const up = s.toUpperCase();
  // Cek keluarga MATI lebih dulu agar frasa 'not running' tidak keliru dibaca hidup.
  if (KERNEL_DEAD_TOKENS.some((t) => up.includes(t))) return 'DEAD';
  if (KERNEL_RUNNING_TOKENS.some((t) => up.includes(t))) return 'RUNNING';
  return '';
}

/** User Kaggle: env > ~/.kaggle/kaggle.json (dipakai untuk menyusun referensi kernel). */
function resolveKaggleUser(env = process.env) {
  const u = String(env.KAGGLE_USER || env.KAGGLE_USERNAME || '').trim();
  if (u) return u;
  try {
    const home = String(env.HOME || process.env.HOME || process.env.USERPROFILE || '').trim();
    const p = home ? path.join(home, '.kaggle', 'kaggle.json') : '';
    if (p && fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.username) return String(j.username).trim();
    }
  } catch { /* abaikan: hanya mempengaruhi probe, bukan jalur utama */ }
  return '';
}

/**
 * Probe read-only status kernel oracle Kaggle. TIDAK membuka/menutup sesi.
 * Return { alive: true|false|'unknown', state, raw }. 'unknown' saat CLI tak ada
 * / user tak dikenal / error / keluaran tak terurai -> pemanggil HARUS perlakukan
 * konservatif (jangan paksa launch) agar kuota tidak terbakar oleh sesi ganda.
 */
export function probeOracleKernelAlive({ env = process.env, logger = console, execFileFn = null } = {}) {
  return new Promise((resolve) => {
    const user = resolveKaggleUser(env);
    if (!user) {
      logger?.log?.('[OracleAutoLaunch] probe kernel dilewati: user Kaggle tak dikenal (KAGGLE_USER/kaggle.json kosong) -> unknown.');
      resolve({ alive: 'unknown', state: 'no_user', raw: '' });
      return;
    }
    const ref = String(env.ORACLE_KERNEL_REF || '').trim() || `${user}/clippervps-vlm-oracle`;
    const kbin = String(env.KAGGLE_BIN || '').trim() || 'kaggle';
    const ef = execFileFn || execFile;
    try {
      ef(kbin, ['kernels', 'status', ref], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        const raw = `${stdout || ''}${stderr || ''}`.trim();
        if (err && !raw) {
          resolve({ alive: 'unknown', state: 'cli_error', raw: err.message });
          return;
        }
        const tok = parseKernelState(raw);
        if (!tok) resolve({ alive: 'unknown', state: 'unparsed', raw });
        else if (KERNEL_DEAD_TOKENS.includes(tok) || tok === 'DEAD') resolve({ alive: false, state: tok, raw });
        else resolve({ alive: true, state: tok, raw });
      });
    } catch (e) {
      resolve({ alive: 'unknown', state: 'spawn_threw', raw: e.message });
    }
  });
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
export function maybeAutoLaunchOracle({ env = process.env, logger = console, now = Date.now(), spawnFn = null, force = false } = {}) {
  if (!isOracleAutoLaunchEnabled(env)) return { triggered: false, reason: 'flag_off' };

  const cfg = resolveOracleConfig(env);
  if (!cfg.enabled) return { triggered: false, reason: 'mode_not_oracle' };
  if (!String(env.API_ACCESS_TOKEN || '').trim()) return { triggered: false, reason: 'token_kosong' };

  // Notebook masih berdenyut -> sesi sudah hidup; jangan buang kuota. KECUALI
  // pemanggil sudah MEMBONGKAR zombie lewat probe status kernel (force=true):
  // dalam kasus itu heartbeat 'segar' hanyalah sisa notebook yang baru idle-exit,
  // jadi guard ini dilewati (cooldown di bawah tetap menahan thrashing).
  const last = oracleLastSeenMs();
  if (!force && last && now - last <= cfg.staleMs) return { triggered: false, reason: 'notebook_alive', lastSeenAt: last };

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
  if (!spawnFn && !fs.existsSync(cmd)) {
    return { triggered: false, reason: 'launcher_missing', error: `Skrip launcher tidak ditemukan: ${cmd}` };
  }
  const launchId = `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
  // force (zombie) -> beri '--force' supaya oracle-launch.sh MELONJAT skip-live-
  // nya sendiri (juga berbasis heartbeat) dan benar-benar men-push sesi baru.
  const argv = force ? [cmd, '--force'] : [cmd];
  try {
    // stdio 'ignore' + detached + unref: server TIDAK menggantung kalau CLI lambat;
    // launcher menulis log sendiri ke logs/oracle-launch.log.
    const child = sp('bash', argv, {
      detached: true,
      stdio: 'ignore',
      cwd: REPO_ROOT,
      env: { ...process.env, ORACLE_LAUNCH_REQUEST_ID: launchId },
    });
    child.on('error', (e) => {
      writeLaunchStatus(launchId, 'failed', `proses launcher tidak dapat dimulai: ${e.message}`);
      logger?.log?.(`[OracleAutoLaunch] spawn error: ${e.message}`);
    });
    child.unref();
    lastLaunchAtMs = now;
    logger?.log?.(`[OracleAutoLaunch] 🚀 Menyalakan sesi Kaggle via '${cmd}'${force ? ' (force/zombie)' : ''} (detached). Tunggu heartbeat...`);
    return { triggered: true, reason: 'launched', cmd, forced: !!force, launchId };
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
  waitMs = Math.max(15, Number(env.ORACLE_AUTO_LAUNCH_WAIT_SEC) || 900) * 1000,
  pollMs = 5000,
  deadline = Date.now(),
  afterMs = 0,
  launchId = '',
  lastSeenFn = oracleLastSeenMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = resolveOracleConfig(env);
  const hardStop = deadline + waitMs;
  let tick = 0;
  while (Date.now() <= hardStop) {
    const launchStatus = readLaunchStatus(launchId);
    if (launchStatus?.state === 'failed') {
      return {
        ok: false,
        detail: 'launcher_failed',
        lastSeenAt: oracleLastSeenMs() || null,
        message: `Auto-launch Kaggle gagal: ${launchStatus.message || 'lihat logs oracle-launch'}`,
      };
    }
    const last = lastSeenFn();
    // 'afterMs' = baseline heartbeat SAAT launch dikirim. Heartbeat harus MAJU
    // melampaui baseline (buktinya notebook BARU benar-benar memanggil API lagi),
    // bukan sekadar masih 'segar'. Tanpa ini, zombie (heartbeat basi tapi < staleMs)
    // membuat fungsi ini mengaku 'terhubung' seketika lalu pre-flight mati lagi.
    if (last && last > afterMs && Date.now() - last <= cfg.staleMs) {
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
  const launchStatus = readLaunchStatus(launchId);
  const launcherHint = launchStatus?.message ? ` Status launcher: ${launchStatus.message}` : '';
  return {
    ok: false,
    detail: 'notebook_offline',
    lastSeenAt: last || null,
    message: `Auto-launch sudah dikirim tapi notebook belum memanggil API dalam ${Math.round(waitMs / 1000)} dtk.${launcherHint} Cek logs/oracle-launch.log & 'kaggle kernels status'.`,
  };
}
