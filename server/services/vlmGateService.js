// ============================================================================
// VLM Gate Service — verifikator visual lokal berbasis SmolVLM2-500M (GGUF).
//
// Peran dalam arsitektur Gemini-first (VISION_VERIFY_MODE=smolvlm):
//   Gemini mengusulkan window scene -> backend sampling 2-5 frame/scene (360p)
//   -> filter ringan -> VLM ini memverifikasi per scene -> PASS/REJECT -> FFmpeg.
// VLM menggantikan trio gatekeeper ONNX lama (SCRFD/DBNet/MobileNetV3).
//
// Dijalankan sebagai SUBPROCESS biner llama.cpp 'llama-mtmd-cli' (CPU, ARM/Termux)
// agar tidak memuat torch/transformers ke proses Node. Pola biner-native mengikuti
// whisper.cpp (lihat audioBeatService.js): konfigurasi via env + gagal-anggun.
//
// Kontrak error (penting untuk master loop):
//   - { ok:false, available:false }  -> fitur OFF / biner/model belum ada. Caller
//     HARUS fallback (mis. geri ke gatekeeper legacy), BUKAN anggap sebagai vonis.
//   - { ok:false, infraError:true }  -> crash/timeout/JSON gagal parse. Transien,
//     caller tidak boleh mem-blacklist kandidat baik karena VLM sedang sibuk.
//   - { ok:true, safe:bool, ... }     -> vonis konten sesungguhnya dari VLM.
// ============================================================================
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

// Basis lokasi file ini (server/services/) agar tahan perubahan cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

// Batasi jumlah frame yang dikirim ke VLM per scene (plafon pengaman biaya/CPU).
const DEFAULT_MAX_FRAMES_PER_SCENE = 5;

function resolveAbs(p, base = SERVER_DIR) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/**
 * Konfigurasi biner llama-mtmd-cli + bobot GGUF. Semua bisa dioverride lewat .env.
 */
export function resolveVlmConfig(env = process.env) {
  const bin = resolveAbs((env.GK_VLM_BIN || 'bin/llama/llama-mtmd-cli').trim());
  const model = resolveAbs((env.GK_VLM_MODEL || 'gatekeeper/models/smolvlm2-500m.Q4_K_M.gguf').trim());
  const mmproj = resolveAbs((env.GK_VLM_MMPROJ || 'gatekeeper/models/smolvlm2-500m-mmproj.gguf').trim());
  const perFrameSec = Math.max(1, Number(env.GK_VLM_TIMEOUT_SEC_PER_FRAME) || 10);
  const maxFrames = Math.max(1, Number(env.GK_VLM_MAX_FRAMES_PER_SCENE) || DEFAULT_MAX_FRAMES_PER_SCENE);
  return {
    bin,
    model,
    mmproj,
    perFrameSec,
    maxFrames,
    binExists: fs.existsSync(bin),
    modelExists: fs.existsSync(model),
    mmprojExists: fs.existsSync(mmproj),
  };
}

/**
 * Kelayakan VLM: biner + model + mmproj harus ada di disk. Dipakai pemanggil untuk
 * memutuskan pakai VLM atau fallback sebelum benar-benar spawning.
 */
export function isVlmAvailable(env = process.env) {
  const cfg = resolveVlmConfig(env);
  return cfg.binExists && cfg.modelExists && cfg.mmprojExists;
}

/**
 * Prompt verifikasi mengikuti skema percakapan. Satu-satunya sumber teks prompt agar
 * mudah di-tune. facePolicy 'presenter_only' (mis. niche smartphone) meloloskan wajah
 * yang jelas merupakan wajah pada layar demo/kegiatan, hanya memblokir wajah presenter
 * yang mengisi frame; 'strict' memblokir semua wajah manusia.
 */
export function buildVlmPrompt(niche = 'kitchen_tools', facePolicy = 'strict') {
  const faceRule = facePolicy === 'presenter_only'
    ? 'Faces that belong to on-screen demo/activity are acceptable; REJECT only a presenter face filling the frame.'
    : 'REJECT if any human face is visible.';
  return [
    'Inspect ALL frames below for this short scene.',
    'REJECT the scene if ANY frame contains:',
    '- a burned-in subtitle or on-screen text overlay',
    '- a watermark or channel logo / identity',
    '- a graphic overlay (arrows, circles, stickers, banners)',
    '- an unboxing / paperwork / manual document',
    `Face policy: ${faceRule}`,
    'Hands and product demonstration are allowed.',
    'Answer with ONLY a compact JSON object, no prose:',
    '{"safe":true|false,"face":true|false,"text":true|false,"watermark":true|false,"graphic":true|false}',
  ].join('\n');
}

/**
 * Susun argumen llama-mtmd-cli. DIPUSATKAN di sini karena nama/tata letak flag dapat
 * berubah antar versi llama.cpp - sesuaikan DI SINI saja bila build Anda memakai flag
 * berbeda (mis. '--model' alih-alih '-m', atau '--image' berulang alih-alih '-i').
 * @returns {string[]}
 */
export function buildArgs(cfg, framePaths, prompt) {
  const args = ['-m', cfg.model, '--mmproj', cfg.mmproj, '--temp', '0', '--no-stream', '-c', '2048'];
  // Beberapa build menerima daftar gambar dengan '-i a.jpg,b.jpg'; yang lain '-i' berulang.
  // Kita pakai '-i' berulang (lebih umum didukung mtmd-cli multi-image).
  for (const fp of framePaths) args.push('-i', fp);
  args.push('-p', prompt);
  return args;
}

/**
 * Ekstrak objek JSON pertama dari keluaran biner (toleran terhadap teks pengantar /
 * barcode log). Return null bila tidak ditemukan / tidak valid.
 */
export function parseVlmJson(stdout = '') {
  const str = String(stdout);
  const start = str.indexOf('{');
  if (start === -1) return null;
  // Cari '}' terakhir yang masuk akal lalu coba parse mundur untuk toleransi.
  for (let end = str.lastIndexOf('}'); end > start; end = str.lastIndexOf('}', end - 1)) {
    const slice = str.slice(start, end + 1);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === 'object' && 'safe' in obj) return obj;
    } catch {
      /* coba potong lebih pendek */
    }
  }
  return null;
}

/**
 * Verifikasi SATU scene (kumpulan frame 2-5) dengan SmolVLM2.
 * @param {string[]} framePaths - path frame JPEG (360p) milik scene ini.
 * @param {{niche?:string, facePolicy?:string, logger?:object, env?:object}} opts
 * @returns {Promise<{ok:boolean, available:boolean, infraError?:boolean, safe?:boolean,
 *   face?:boolean, text?:boolean, watermark?:boolean, graphic?:boolean,
 *   raw?:string, elapsedMs?:number, framesUsed?:number, error?:string}>}
 */
export async function verifyScene(framePaths = [], opts = {}) {
  const { niche = 'kitchen_tools', facePolicy = 'strict', logger = console, env = process.env } = opts;
  const cfg = resolveVlmConfig(env);

  if (!(cfg.binExists && cfg.modelExists && cfg.mmprojExists)) {
    return { ok: false, available: false, error: 'VLM biner/model/mmproj tidak lengkap (fallback).' };
  }

  const valid = framePaths.filter((p) => p && fs.existsSync(p));
  if (valid.length === 0) {
    return { ok: false, available: true, infraError: true, error: 'Tidak ada frame valid untuk VLM.' };
  }
  const used = valid.slice(0, cfg.maxFrames);
  const prompt = buildVlmPrompt(niche, facePolicy);
  const args = buildArgs(cfg, used, prompt);
  const timeoutMs = Math.max(10_000, used.length * cfg.perFrameSec * 1000);

  const t0 = Date.now();
  try {
    const { stdout } = await execFileAsync(cfg.bin, args, {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1' },
    });
    const elapsedMs = Date.now() - t0;
    const parsed = parseVlmJson(stdout);
    if (!parsed) {
      logger.warn(`[VLM] Output tidak terparse sebagai JSON (scene ditunda ke fallback). stdout=${String(stdout).slice(0, 160)}`);
      return { ok: false, available: true, infraError: true, elapsedMs, error: 'JSON VLM tidak valid.' };
    }
    const bool = (v) => v === true || v === 'true' || v === 1;
    return {
      ok: true,
      available: true,
      safe: bool(parsed.safe),
      face: bool(parsed.face),
      text: bool(parsed.text),
      watermark: bool(parsed.watermark),
      graphic: bool(parsed.graphic),
      raw: stdout,
      elapsedMs,
      framesUsed: used.length,
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const timedOut = err && (err.killed === true || String(err.code) === 'ETIMEDOUT' || /timed out/i.test(String(err.message)));
    logger.warn(`[VLM] ${timedOut ? 'Timeout' : 'Gagal'} (${elapsedMs}ms): ${err?.message}`);
    // Crash/timeout = transien infrastruktur, BUKAN vonis konten.
    return { ok: false, available: true, infraError: true, elapsedMs, error: String(err?.message || err) };
  }
}
