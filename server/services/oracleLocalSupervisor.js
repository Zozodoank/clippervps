// oracleLocalSupervisor.js
// ─────────────────────────────────────────────────────────────────────────
// Pengawas ORACLE LOKAL Qwen (VPS) — llama-server + worker.py yang berjalan
// di mesin yang sama dengan server. Pengganti oracleLauncherService.js
// (auto-launch sesi Kaggle) yang dihapus 2026-10 saat alur kerja pindah
// sepenuhnya ke VPS (mandate user: "VPS only", Kaggle tidak dipakai lagi).
//
// Cara kerja:
//   1) stage1Render memanggil assertOracleConnected(); bila GAGAL karena
//      heartbeat worker basi ('worker_offline'), kita panggil
//      maybeAutoStartLocalOracle();
//   2) fungsi ini mengeksekusi `pm2 restart llama-server oracle-worker`
//      (keduanya terdaftar via ecosystem.config.cjs); PM2 menyalakan ulang
//      llama-server dan worker.py yang kemudian kembali memanggil
//      /api/vlm-oracle/claim (heartbeat);
//   3) job lalu MENUNGGU heartbeat worker muncul (waitForOracleOnline)
//      sebelum kerja berat, bukan langsung gagal.
//
// Pengaman: fitur ini MATI kecuali ORACLE_AUTO_LAUNCH=1|true (default aman);
// cooldown antar-restart (default 10 mnt) menahan thrashing saat llama-server
// crash-loop; restart tidak pernah menembak apa pun bila heartbeat masih
// segar. Tidak pernah melempar: kegagalan pm2 dikembalikan sebagai objek.
//
// NAMA FLAG ORACLE_AUTO_LAUNCH DIPERTAHANKAN dari era Kaggle agar configSnapshot
// dan snapshot retry job lama tetap valid — hanya semantiknya yang berubah
// menjadi "auto-start oracle lokal via PM2" (tidak menyentuh Kaggle sama sekali).
// ─────────────────────────────────────────────────────────────────────────
import { execFile } from 'node:child_process';
import { oracleLastSeenMs } from '../store/jobStore.js';
import { resolveOracleConfig } from './vlmOracleService.js';

// Timestamp restart terakhir (module-scope; cukup untuk satu proses server).
let lastLaunchAtMs = 0;

/**
 * Flag utama: fitur mati kecuali diaktifkan eksplisit lewat env.
 * Konvensi boolean proyek: '1' ATAU 'true' (bukan hanya '1') supaya nilai .env
 * lama seperti 'true' tetap bekerja (pola yang sama dipakai oracleLauncher lama).
 */
export function isLocalOracleAutoStartEnabled(env = process.env) {
  const v = String(env.ORACLE_AUTO_LAUNCH || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Reset cooldown — HANYA untuk tes. */
export function __resetAutoLaunchCooldown() {
  lastLaunchAtMs = 0;
}

/**
 * Probe kesehatan llama-server (GET /health). Read-only, tidak mengubah apa pun.
 * Return { alive: true|false|'unknown', state, raw }. 'unknown' saat URL kosong,
 * fetch gagal, atau fetch tidak tersedia -> pemanggil HARUS perlakukan konservatif
 * (informasi diagnostik saja; ground truth koneksi oracle tetap heartbeat claim
 * worker di assertOracleConnected).
 */
export async function probeLlamaServerHealth({ env = process.env, logger = console, fetchFn = null } = {}) {
  const raw = String(env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080/v1').trim();
  if (!raw) {
    logger?.log?.('[OracleLocal] probe llama dilewati: LLAMA_SERVER_URL kosong -> unknown.');
    return { alive: 'unknown', state: 'no_url', raw: '' };
  }
  // LLAMA_SERVER_URL menunjuk base OpenAI-compatible (/v1); /health ada di root.
  let root = raw.replace(/\/v1\/?$/, '');
  root = root.replace(/\/+$/, '');
  const url = `${root}/health`;
  const f = fetchFn || globalThis.fetch;
  if (typeof f !== 'function') return { alive: 'unknown', state: 'no_fetch', raw: '' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await f(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = String(await resp.text()).slice(0, 200);
    if (resp.status === 200) return { alive: true, state: 'ok', raw: text };
    return { alive: false, state: `http_${resp.status}`, raw: text };
  } catch (e) {
    return { alive: 'unknown', state: 'fetch_error', raw: e?.message || '' };
  }
}

/**
 * Ambil keputusan: perlu restart oracle lokal atau tidak, dan (bila perlu)
 * eksekusi `pm2 restart llama-server oracle-worker`. Murni terhadap jam (arg
 * `now`) & subprocess (arg `execFileFn`) supaya bisa diuji tanpa pm2 sungguhan.
 * Return { triggered, reason, waitMs?, error? }.
 */
export async function maybeAutoStartLocalOracle({ env = process.env, logger = console, now = Date.now(), execFileFn = null } = {}) {
  if (!isLocalOracleAutoStartEnabled(env)) return { triggered: false, reason: 'flag_off' };

  const cfg = resolveOracleConfig(env);
  if (!cfg.enabled) return { triggered: false, reason: 'mode_not_oracle' };
  if (!String(env.API_ACCESS_TOKEN || '').trim()) return { triggered: false, reason: 'token_kosong' };

  // Worker masih berdenyut -> oracle sudah hidup; jangan restart sia-sia.
  const last = oracleLastSeenMs();
  if (last && now - last <= cfg.staleMs) return { triggered: false, reason: 'oracle_alive', lastSeenAt: last };

  // Cooldown: jangan restart pm2 tiap batch/frame saat llama-server crash-loop.
  const cooldownMs = Math.max(1, Number(env.ORACLE_AUTO_LAUNCH_COOLDOWN_MIN) || 10) * 60000;
  if (now - lastLaunchAtMs < cooldownMs) {
    return { triggered: false, reason: 'cooldown', waitMs: cooldownMs - (now - lastLaunchAtMs) };
  }

  const ef = execFileFn || execFile;
  const pm2Bin = String(env.PM2_BIN || '').trim() || 'pm2';
  try {
    await new Promise((resolve, reject) => {
      ef(pm2Bin, ['restart', 'llama-server', 'oracle-worker'], { timeout: 30000, windowsHide: true }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (e) {
    // ENOENT = biner pm2 tidak ada di PATH (mis. PC dev tanpa PM2) -> jangan
    // dianggap kegagalan fatal; gerbang job tetap melapor dengan pesan jelas.
    const reason = e && e.code === 'ENOENT' ? 'pm2_missing' : 'pm2_failed';
    return { triggered: false, reason, error: e?.message };
  }
  lastLaunchAtMs = now;
  logger?.log?.(`[OracleLocal] 🔄 PM2 restart llama-server + oracle-worker dikirim. Menunggu heartbeat worker...`);
  return { triggered: true, reason: 'launched' };
}

/**
 * Tunggu sampai heartbeat worker SEGAR (atau deadline lewat). Ini yang membuat
 * job "sabar" menunggu llama-server boot + worker.py kembali men-claim
 * (muat model GGUF bisa puluhan detik) alih-alih gagal seketika.
 * Tidak melempar; return { ok, detail, lastSeenAt, message }.
 */
export async function waitForOracleOnline({
  env = process.env,
  logger = console,
  waitMs = Math.max(15, Number(env.ORACLE_AUTO_LAUNCH_WAIT_SEC) || 900) * 1000,
  pollMs = 5000,
  deadline = Date.now(),
  afterMs = 0,
  lastSeenFn = oracleLastSeenMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = resolveOracleConfig(env);
  const hardStop = deadline + waitMs;
  let tick = 0;
  while (Date.now() <= hardStop) {
    const last = lastSeenFn();
    // 'afterMs' = baseline heartbeat SAAT restart dikirim. Heartbeat harus MAJU
    // melampaui baseline (buktinya worker BARU benar-benar memanggil API lagi),
    // bukan sekadar masih 'segar'. Tanpa ini, heartbeat basi (< staleMs) membuat
    // fungsi ini mengaku 'terhubung' seketika lalu pre-flight mati lagi.
    if (last && last > afterMs && Date.now() - last <= cfg.staleMs) {
      logger?.log?.(`[OracleLocal] ✅ Worker terlihat (${Math.round((Date.now() - last) / 1000)} dtk lalu). Lanjut kerja berat.`);
      return { ok: true, detail: 'connected', lastSeenAt: last, message: 'Oracle lokal Qwen (VPS) terhubung (auto-start).' };
    }
    if (tick % 3 === 0) {
      const sisa = Math.max(0, Math.round((hardStop - Date.now()) / 1000));
      logger?.log?.(`[OracleLocal] menunggu heartbeat worker... (sisa ${sisa} dtk)`);
    }
    tick += 1;
    await sleep(Math.min(pollMs, Math.max(250, hardStop - Date.now())));
  }
  const last = lastSeenFn();
  return {
    ok: false,
    detail: 'worker_offline',
    lastSeenAt: last || null,
    message: `Restart oracle lokal sudah dikirim tapi worker belum memanggil API dalam ${Math.round(waitMs / 1000)} dtk. Jalankan 'pm2 start ecosystem.config.cjs' lalu cek 'pm2 logs oracle-worker' dan 'pm2 logs llama-server'.`,
  };
}
