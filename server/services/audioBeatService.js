// ============================================================================
// AUDIO-DRIVEN SCENE PLANNING (Fase 1) — fitur BARU, di-BACKING flag.
//
// Ide profesional: potong adegan mengikuti JEDA NARASI aslinya, bukan grid
// seragam. Video sumber DIWAJIBKAN punya voice-over (suara manusia); video
// yang cuma backsound/musik DITOLAK. Transkrip whisper dipakai untuk:
//   1. Gate "wajib voice-over" (assessVoiceoverPresence).
//   2. Menentukan beat (potongan 1-7 detik) tempat adegan dipotong, lalu
//      (Fase 2) teks tiap beat diparafrase anti-plagiat → Gemini TTS.
//
// PENTING: modul ini MANDIRI dan BELUM disambungkan ke alur worker live.
// Semua fungsi pure (segmenter/gate) di sini deterministik & diuji unit;
// fungsi I/O (ekstrak audio, panggil whisper) memakai binary eksternal yang
// dikonfigurasi via env dan gagal-anggun (return ok:false) bila tak tersedia.
// ============================================================================
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getFFmpegPath } from './binaryChecker.js';

const execFileAsync = promisify(execFile);

// Basis lokasi FILE ini (server/services/) agar tahan terhadap perubahan cwd
// (dev-runner jalan dari root, test jalan dari server/, dsb).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const AUDIO_TMP_DIR = path.join(SERVER_DIR, 'temp', 'audio_analysis');

// Flag utama fitur audio-driven. Default OFF (perilakuan produksi tak berubah).
export function isAudioDrivenEnabled(env = process.env) {
  return String(env.AUDIO_DRIVEN_SCENES || '').trim().toLowerCase() === 'true';
}

// ==========================================================================
// JENDELA ANALISIS AUDIO (PURE)
// Timeline `startSeconds`/`endSeconds` klip mengacu ke video YouTube ASLI. Pada
// mode hemat kuota (RENDER_DOWNLOAD_SECTIONS=1) file yang dibuka adalah SEGMEN
// hasil --download-sections yang timeline-nya sudah dimulai di sourceOffsetSec,
// jadi jendela wajib di-rebase (kurangi offset) lalu di-clamp ke durasi file.
// Tanpa rebase: ffmpeg membaca melewati akhir file -> whisper menghasilkan 0 beat
// dan fitur audio-driven mati tanpa suara. Nomor "MM:SS" juga dibuang di sini
// (Number("01:24") = NaN) karena penyebab bug asli adalah string, bukan angka.
// ==========================================================================
export function resolveAudioWindow({ clip = null, highlight = null, fileDurationSec = 0 } = {}) {
  const base = Number(clip?.sourceOffsetSec) || 0;
  const startRaw = Number(clip?.startSeconds ?? highlight?.startSeconds);
  const endRaw = Number(highlight?.endSeconds ?? clip?.endSeconds);
  let start = Number.isFinite(startRaw) && startRaw > base ? startRaw - base : 0;
  let end = Number.isFinite(endRaw) && endRaw > base ? endRaw - base : 0;
  const dur = Number(fileDurationSec) || 0;
  if (dur > 0) {
    start = Math.min(start, Math.max(0, dur - 1));
    end = end > start ? Math.min(end, dur) : 0;
  }
  return { startSec: Number(start.toFixed(2)), endSec: Number(end.toFixed(2)) };
}

// Konfigurasi binary whisper.cpp + model. Semua bisa dioverride lewat .env.
export function resolveWhisperConfig(env = process.env) {
  const bin = (env.WHISPER_CPP_BIN || 'whisper-cli').trim();
  const rawModel = (env.WHISPER_MODEL || 'models/ggml-base.bin').trim();
  const modelPath = path.isAbsolute(rawModel) ? rawModel : path.join(SERVER_DIR, rawModel);
  const lang = (env.WHISPER_LANG || 'id').trim().toLowerCase();
  return {
    bin,
    modelPath,
    lang,
    // ready hanya bila file model benar-benar ada di disk.
    modelExists: fs.existsSync(modelPath),
  };
}

// ==========================================================================
// GERBANG "WAJIB VOICE-OVER" — pure, bisa diuji tanpa binary.
// ==========================================================================
// segments: [{ start, end, text }] (detik). totalDurationSec: durasi video.
// Menghitung seberapa besar timeline diisi UCAPAN. Video tanpa suara manusia
// (murni musik/backsound) akan menghasilkan coverage ~0 → ditolak.
export function assessVoiceoverPresence(segments = [], totalDurationSec = 0, opts = {}) {
  const minSpeechSec = Number(opts.minSpeechSec ?? process.env.AUDIO_MIN_SPEECH_SEC) || 3;
  const minCoverage = Number(opts.minCoverage ?? process.env.AUDIO_MIN_SPEECH_COVERAGE) || 0.15;
  const minWords = Number(opts.minWords ?? process.env.AUDIO_MIN_SPEECH_WORDS) || 6;

  let speechSec = 0;
  let wordCount = 0;
  for (const s of segments) {
    const dur = Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));
    speechSec += dur;
    const text = (s.text || '').trim();
    if (text) wordCount += text.split(/\s+/).filter(Boolean).length;
  }
  const coverage = totalDurationSec > 0 ? Math.min(1, speechSec / totalDurationSec) : 0;
  const hasVoiceover = speechSec >= minSpeechSec && wordCount >= minWords && coverage >= minCoverage;

  return {
    speechSec: +speechSec.toFixed(2),
    coverage: +coverage.toFixed(3),
    wordCount,
    hasVoiceover,
    reason: hasVoiceover
      ? null
      : `Tidak ada voice-over manusia yang cukup (ucapan ${speechSec.toFixed(1)}s, ${wordCount} kata, cakupan ${(coverage * 100).toFixed(0)}% < min).`,
  };
}

// ==========================================================================
// SEGMENTER BEAT — pure. Ratakan segmen ASR menjadi beat 1..MAX detik.
// ==========================================================================
// Aturan profesional: beat ideal 1-5 detik; boleh molor sedikit tapi tidak
// pernah melewati maxSec (default 7). Segmen panjang di-split paksa ke
// beberapa beat; segmen pendek menyatu dengan tetangga bila jeda kecil.
export function buildBeatsFromSegments(segments = [], opts = {}) {
  const minSec = Number(opts.minSec ?? process.env.AUDIO_BEAT_MIN_SEC) || 1;
  const idealMax = Number(opts.idealMax ?? process.env.AUDIO_BEAT_IDEAL_MAX_SEC) || 5;
  const maxSec = Number(opts.maxSec ?? process.env.AUDIO_BEAT_MAX_SEC) || 7;
  const mergeGap = Number(opts.mergeGapSec ?? 0.35);

  // Normalisasi + buang segmen hampa, urutkan waktu.
  const clean = segments
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: (s.text || '').trim() }))
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // 1) Pecah segmen yang sendiri sudah melebihi maxSec menjadi potongan ≤ maxSec.
  const atoms = [];
  for (const s of clean) {
    const span = s.end - s.start;
    if (span <= maxSec) { atoms.push(s); continue; }
    const pieces = Math.ceil(span / maxSec);
    const words = s.text.split(/\s+/).filter(Boolean);
    const per = Math.ceil(words.length / pieces);
    for (let i = 0; i < pieces; i++) {
      const start = s.start + (span / pieces) * i;
      const end = s.start + (span / pieces) * (i + 1);
      const text = words.slice(i * per, (i + 1) * per).join(' ');
      if (text) atoms.push({ start, end, text });
    }
  }

  // 2) Gabung atom selama durasi gabungan tetap ≤ idealMax (atau ≤ maxSec untuk
  //    atom terakhir), dan jeda antar-atom kecil.
  const beats = [];
  let cur = null;
  const flush = () => { if (cur) { beats.push(cur); cur = null; } };
  for (const a of atoms) {
    if (!cur) { cur = { ...a }; continue; }
    const gap = a.start - cur.end;
    const mergedDur = a.end - cur.start;
    const canMerge = gap <= mergeGap && mergedDur <= (mergedDur <= idealMax ? idealMax : maxSec);
    if (canMerge && mergedDur <= maxSec) {
      cur.end = a.end;
      cur.text = `${cur.text} ${a.text}`.trim();
    } else {
      flush();
      cur = { ...a };
    }
  }
  flush();

  // 3) Clamp + buang beat di bawah minSec dengan menyerapnya ke beat sebelum.
  const out = [];
  for (const b of beats) {
    let dur = b.end - b.start;
    if (dur < minSec && out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.duration + dur <= maxSec) {
        prev.end = Math.max(prev.end, b.end);
        prev.text = `${prev.text} ${b.text}`.trim();
        prev.duration = +(prev.end - prev.start).toFixed(3);
        continue;
      }
    }
    out.push({
      start: +b.start.toFixed(3),
      end: +Math.max(b.end, b.start + minSec).toFixed(3),
      text: b.text,
      duration: +dur.toFixed(3),
    });
  }
  return out;
}

// ==========================================================================
// EKSTRAK AUDIO (I/O) — ffmpeg → mono 16 kHz WAV (format yang disukai
// whisper.cpp). Gagal-anggun: return { ok:false } alih-alih melempar.
// ==========================================================================
export async function extractSourceAudio({ videoPath, outWav, startSec = 0, endSec = 0, logger = console } = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, error: `Video sumber tidak ada untuk ekstrak audio: ${videoPath}` };
  }
  try {
    if (!fs.existsSync(AUDIO_TMP_DIR)) fs.mkdirSync(AUDIO_TMP_DIR, { recursive: true });
    const target = outWav || path.join(AUDIO_TMP_DIR, `audio_${Date.now()}.wav`);
    const ffmpeg = getFFmpegPath();
    // Slice opsional ke jendela klip terpilih (fast-seek sebelum -i + durasi -t sesudah -i),
    // sehingga offset whisper 0-based dan selaras dengan timeline klip, bukan video utuh.
    const s = Number(startSec) || 0;
    const e = Number(endSec) || 0;
    const inputArgs = [];
    if (s > 0) inputArgs.push('-ss', String(s));
    inputArgs.push('-i', videoPath);
    const durArgs = (e > s) ? ['-t', String(e - s)] : [];
    await execFileAsync(ffmpeg, [
      '-y', '-nostdin', ...inputArgs,
      ...durArgs,
      '-vn', '-ac', '1', '-ar', '16000',
      '-af', 'highpass=f=120,lowpass=f=6500', // fokus pita suara manusia, hemat bandwidth Whisper
      '-c:a', 'pcm_s16le', target,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    logger.log(`[AudioBeat] Audio sumber diekstrak → ${target}${s > 0 || e > 0 ? ` (jendela ${s}s-${e}s)` : ''}`);
    return { ok: true, wavPath: target };
  } catch (err) {
    const blob = `${err.message || ''} ${err.stderr || ''}`.toLowerCase();
    // Video sumber tanpa track audio (mis. unduhan video-only utk frame) -> bukan
    // kesalahan tools, tapi kondisi sah: kembalikan noAudio agar pemanggil memperlakukan
    // sebagai "tanpa voice-over", bukan error keras.
    if (blob.includes('does not contain any stream') || blob.includes('invalid argument')) {
      logger.warn(`[AudioBeat] Video sumber tidak punya track audio untuk diekstrak.`);
      return { ok: false, noAudio: true, error: 'Video sumber tidak memiliki track audio.' };
    }
    logger.warn(`[AudioBeat] Gagal ekstrak audio: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ==========================================================================
// TRANSCRIBE (I/O) — panggil whisper.cpp. Butuh binary + model di disk.
// Return segments [{start,end,text}] dalam detik (offset whisper.cpp = ms).
// ==========================================================================
export async function transcribeAudio({ wavPath, logger = console, env = process.env } = {}) {
  const cfg = resolveWhisperConfig(env);
  if (!wavPath || !fs.existsSync(wavPath)) {
    return { ok: false, error: `WAV tidak ada untuk transkripsi: ${wavPath}` };
  }
  if (!cfg.modelExists) {
    return { ok: false, error: `Model whisper tidak ditemukan di: ${cfg.modelPath} (set WHISPER_MODEL / WHISPER_CPP_BIN di server/.env)` };
  }
  // whisper.cpp modern (b49xx+) TIDAK punya '-j' ke stdout; JSON ditulis ke FILE
  // lewat '-oj' + '-of PREFIX' -> PREFIX.json. Pakai jalur file agar andal.
  const outPrefix = wavPath.replace(/\.wav$/i, '') + '_asr';
  const jsonPath = `${outPrefix}.json`;
  try {
    await execFileAsync(cfg.bin, [
      '-m', cfg.modelPath,
      '-f', wavPath,
      '-l', cfg.lang,
      '-nt', '-oj', '-of', outPrefix,
    ], { timeout: Number(env.WHISPER_TIMEOUT_MS) || 600000, maxBuffer: 20 * 1024 * 1024 });

    if (!fs.existsSync(jsonPath)) {
      return { ok: false, error: `whisper selesai tapi ${path.basename(jsonPath)} tidak dibuat (cek versi/flag whisper.cpp).` };
    }
    const parsed = parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'));
    try { fs.unlinkSync(jsonPath); } catch { /* cleanup best-effort */ }
    if (!parsed) return { ok: false, error: 'Output JSON whisper.cpp tidak bisa dibaca.' };
    logger.log(`[AudioBeat] Whisper selesai: ${parsed.segments.length} segmen (bahasa ${parsed.language || '?'})`);
    return { ok: true, language: parsed.language, segments: parsed.segments };
  } catch (err) {
    try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { /* noop */ }
    logger.warn(`[AudioBeat] Gagal memanggil whisper (${cfg.bin}): ${err.message}`);
    return { ok: false, error: err.message, missingBinary: /ENOENT/.test(err.message) };
  }
}

// Parser defensif output whisper.cpp -j. Struktur resmi: .transcription[].offsets {from,to} ms.
export function parseWhisperJson(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Kadang stdout punya baris log sebelum JSON — ambil dari '{' pertama.
    const i = raw.indexOf('{');
    if (i < 0) return null;
    try { obj = JSON.parse(raw.slice(i)); } catch { return null; }
  }
  const list = obj.transcription || obj.segments || [];
  const language = obj?.result?.language || obj?.result?.transcription?.language || null;
  const segments = list
    .map((t) => {
      const from = t?.offsets?.from ?? parseClock(t?.timestamps?.from);
      const to = t?.offsets?.to ?? parseClock(t?.timestamps?.to);
      return { start: +(from / 1000).toFixed(3), end: +(to / 1000).toFixed(3), text: (t?.text || '').trim() };
    })
    .filter((s) => s.text && s.end > s.start);
  return { language, segments };
}

function parseClock(str) {
  if (!str) return 0;
  // "00:00:05,000" → ms
  const m = String(str).match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000) + +m[4];
}

// ==========================================================================
// ORKESTRASI FASE 1 — ekstrak → transkrip → gate VO → beat. Satu panggilan.
// Bila audio/whisper tak tersedia, return ok:false (panggilan boleh fallback).
// ==========================================================================
export async function analyzeSourceAudioForBeats({ videoPath, startSec = 0, endSec = 0, totalDurationSec = 0, logger = console } = {}) {
  if (!isAudioDrivenEnabled()) {
    return { ok: false, skipped: true, reason: 'AUDIO_DRIVEN_SCENES OFF' };
  }
  const ext = await extractSourceAudio({ videoPath, startSec, endSec, logger });
  if (!ext.ok) {
    if (ext.noAudio) {
      // Tanpa track audio = tanpa voice-over. Kembalikan hasil terstruktur agar
      // pemanggil (worker) memperlakukannya sebagai penolakan VO, bukan crash.
      return {
        ok: true,
        language: null,
        voiceover: { speechSec: 0, coverage: 0, wordCount: 0, hasVoiceover: false, reason: 'Video sumber tidak memiliki track audio (tidak ada voice-over).' },
        beats: [],
      };
    }
    return { ok: false, error: ext.error };
  }

  const tr = await transcribeAudio({ wavPath: ext.wavPath, logger });
  try { fs.unlinkSync(ext.wavPath); } catch { /* cleanup best-effort */ }
  if (!tr.ok) return { ok: false, error: tr.error, missingBinary: tr.missingBinary };

  const windowDur = (Number(endSec) > Number(startSec)) ? (Number(endSec) - Number(startSec)) : Number(totalDurationSec);
  const vo = assessVoiceoverPresence(tr.segments, windowDur);
  const beats = vo.hasVoiceover ? buildBeatsFromSegments(tr.segments) : [];
  return { ok: true, language: tr.language, voiceover: vo, beats };
}
