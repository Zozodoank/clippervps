// ─────────────────────────────────────────────────────────────────────────────
// P5 — BEKUKAN KONFIGURASI RUNTIME PER JOB (configSnapshot)
//
// Masalah nyata: jalur pipeline membaca flag dari `process.env` SAAT EKSEKUSI
// (lihat stage1Render: RENDER_DOWNLOAD_SECTIONS, videoFilterService: SAMPLE_MAX_FRAMES /
// GK_MAX_BATCH_FRAMES, finalizationService: FINAL_AI_QC(_STRICT), audioBeatService:
// AUDIO_DRIVEN_SCENES). Bila operator mengganti .env lalu me-retry job lama, retry
// memakai konfigurasi BARU sehingga hasil tidak dapat direproduksi & log menipu.
//
// Solusi ringan: saat job DIBUAT, bekukan nilai EFETIF flag-flag itu ke `job.configSnapshot`.
// Retry membaca snapshot dan menerapkannya kembali sebelum menjalankan worker, sehingga
// perilaku retry = perilaku saat pembuatan, walau .env sudah berubah.
//
// Aturan perawatan: tambah flag runtime baru yang dibaca dari process.env di jalur render
// -> daftarkan di FLAG_NORMALIZERS DI BAWAH ini (satu sumber kebenaran), lalu snapshot &
// retry otomatis ikut mencakupnya. Nilai default di sini WAJIB sama dengan yang dipakai
// konsumen aslinya (jangan sampai snapshot "memperbaiki" nilai — hanya membekukan).
// ─────────────────────────────────────────────────────────────────────────────

// Setiap entri: (env) => nilai efektif, meniru PERSIS cara konsumen membaca flag.
const FLAG_NORMALIZERS = {
  // stage1Render: process.env.RENDER_DOWNLOAD_SECTIONS === '1'
  RENDER_DOWNLOAD_SECTIONS: (env) => env.RENDER_DOWNLOAD_SECTIONS === '1',
  // stage1Render: process.env.RENDER_NO_FULL_DOWNLOAD === '1'
  RENDER_NO_FULL_DOWNLOAD: (env) => env.RENDER_NO_FULL_DOWNLOAD === '1',
  // videoFilterService: Math.max(20, Number(process.env.SAMPLE_MAX_FRAMES) || 500)
  SAMPLE_MAX_FRAMES: (env) => Math.max(20, Number(env.SAMPLE_MAX_FRAMES) || 500),
  // videoFilterService: Math.max(20, Number(process.env.GK_MAX_BATCH_FRAMES) || 240)
  GK_MAX_BATCH_FRAMES: (env) => Math.max(20, Number(env.GK_MAX_BATCH_FRAMES) || 240),
  // audioBeatService.isAudioDrivenEnabled: trim().toLowerCase() === 'true'
  AUDIO_DRIVEN_SCENES: (env) => String(env.AUDIO_DRIVEN_SCENES || '').trim().toLowerCase() === 'true',
  // downloader.js render path: parseInt(env.RENDER_MAX_HEIGHT,10) valid>0 ? itu : 1080
  RENDER_MAX_HEIGHT: (env) => {
    const v = parseInt(env.RENDER_MAX_HEIGHT, 10);
    return Number.isFinite(v) && v > 0 ? v : 1080;
  },
  // downloader.js render path: env RENDER_VIDEO_ONLY !== '0' (default ON buang audio).
  // Bekukan supaya retry di Termux (720p + audio-on) tidak tiba-tiba berubah format.
  RENDER_VIDEO_ONLY: (env) => env.RENDER_VIDEO_ONLY !== '0',
  // finalizationService: process.env.FINAL_AI_QC !== 'false'
  FINAL_AI_QC: (env) => env.FINAL_AI_QC !== 'false',
  // finalizationService: process.env.FINAL_AI_QC_STRICT === 'true'
  FINAL_AI_QC_STRICT: (env) => env.FINAL_AI_QC_STRICT === 'true',
  // EVIDENCE MODE: aiService.selectHighlightWithAI + stage1Render membaca
  // GEMINI_INPUT_MODE. Default 'evidence' (frame bersih lokal — hemat token Gemini,
  // 0 MB kuota tambahan). 'stream' = perilaku lama (Gemini baca video penuh).
  GEMINI_INPUT_MODE: (env) => (String(env.GEMINI_INPUT_MODE || '').trim().toLowerCase() === 'stream' ? 'stream' : 'evidence'),
  // visionEvidenceService.shouldPreferEvidence: Math.max(2, Number(process.env.EVIDENCE_MIN_FRAMES) || 6)
  EVIDENCE_MIN_FRAMES: (env) => Math.max(2, Number(env.EVIDENCE_MIN_FRAMES) || 6),
  // visionEvidenceService.pickEvidenceFrames: Math.max(4, Number(process.env.EVIDENCE_MAX_FRAMES) || 30)
  EVIDENCE_MAX_FRAMES: (env) => Math.max(4, Number(env.EVIDENCE_MAX_FRAMES) || 30),
  // visionEvidenceService.pickEvidenceFrames: jatah MINIMAL keyframe per video sumber.
  // Tanpa ini satu video dominan bisa menghabiskan seluruh bukti -> Reels 1 sumber.
  EVIDENCE_MIN_FRAMES_PER_SOURCE: (env) => Math.max(1, Number(env.EVIDENCE_MIN_FRAMES_PER_SOURCE) || 2),
  // stage1Render: jarak antar titik sampling dari stream (detik). 1.5 = ~40 titik/menit
  // (5 menit = 200 frame). Dulu pernah dipotong ke 3.0 demi hemat -> jendela bersih
  // jarang dan klip menumpuk di satu sumber.
  RENDER_SAMPLE_INTERVAL_SEC: (env) => Math.max(0.5, Number(env.RENDER_SAMPLE_INTERVAL_SEC) || 1.5),
  // BLUEPRINT ALUR BARU (6 langkah). Opt-in: default 'legacy' = jalur Fase 1-4 lama (aman).
  // 'v2' mengaktifkan runSourceAcquisitionV2 (vonis batch Gemini + transkrip penuh +
  // window teks + zigzag + segment-only). Nama kunci BEDA dari PIPELINE_MODE (label
  // whisper-first yang sudah ada & tidak dibaca kode) agar tidak tabrakan semantik.
  ACQUISITION_FLOW: (env) => (String(env.ACQUISITION_FLOW || '').trim().toLowerCase() === 'v2' ? 'v2' : 'legacy'),
};

export const SNAPSHOT_FLAG_KEYS = Object.keys(FLAG_NORMALIZERS);

/**
 * Bekukan nilai efektif seluruh flag runtime + input per-job (niche/sourcePolicy) ke satu objek.
 * @param {object} [env] sumber flag (default process.env)
 * @param {{niche?:string, sourcePolicy?:string}} [jobOptions] input per-job yang ikut dibekukan
 * @returns {object} snapshot polos (hanya string/number/boolean) — siap di-JSON.stringify ke DB.
 */
export function buildConfigSnapshot(env = process.env, jobOptions = {}) {
  const snapshot = {};
  for (const [key, normalize] of Object.entries(FLAG_NORMALIZERS)) {
    snapshot[key] = normalize(env);
  }
  // Input per-job: niche & sourcePolicy sudah diketahui saat create; bekukan agar retry
  // tidak jatuh ke preset default saat flag/opsi global berubah.
  snapshot.niche = jobOptions.niche || 'kitchen_tools';
  snapshot.sourcePolicy = jobOptions.sourcePolicy || '';
  snapshot._frozenAt = new Date().toISOString();
  return snapshot;
}

/**
 * Kembalikan pasangan key=string untuk ditulis ke process.env agar konsumen yang membaca
 * env langsung (belum di-refactor) memakai nilai beku saat retry. Hanya menyentuh flag yang
 * memang bernilai "aktif" supaya tidak menulis string kosong yang menimpa default berbeda.
 * @param {object} snapshot hasil buildConfigSnapshot
 * @returns {Record<string,string>} patch env
 */
export function configSnapshotToEnvPatch(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const patch = {};
  if (typeof snapshot.RENDER_DOWNLOAD_SECTIONS === 'boolean') {
    patch.RENDER_DOWNLOAD_SECTIONS = snapshot.RENDER_DOWNLOAD_SECTIONS ? '1' : '0';
  }
  if (typeof snapshot.RENDER_NO_FULL_DOWNLOAD === 'boolean') {
    patch.RENDER_NO_FULL_DOWNLOAD = snapshot.RENDER_NO_FULL_DOWNLOAD ? '1' : '0';
  }
  if (typeof snapshot.SAMPLE_MAX_FRAMES === 'number') patch.SAMPLE_MAX_FRAMES = String(snapshot.SAMPLE_MAX_FRAMES);
  if (typeof snapshot.GK_MAX_BATCH_FRAMES === 'number') patch.GK_MAX_BATCH_FRAMES = String(snapshot.GK_MAX_BATCH_FRAMES);
  if (typeof snapshot.AUDIO_DRIVEN_SCENES === 'boolean') patch.AUDIO_DRIVEN_SCENES = snapshot.AUDIO_DRIVEN_SCENES ? 'true' : 'false';
  // RENDER_VIDEO_ONLY dibaca dengan `!== '0'`, jadi 'false' pun berarti ON. Tulis nilai
  // kanonik '1'/'0' agar pembacaan konsumen identik dengan nilai yang dibekukan.
  if (typeof snapshot.RENDER_MAX_HEIGHT === 'number') patch.RENDER_MAX_HEIGHT = String(snapshot.RENDER_MAX_HEIGHT);
  if (typeof snapshot.RENDER_VIDEO_ONLY === 'boolean') patch.RENDER_VIDEO_ONLY = snapshot.RENDER_VIDEO_ONLY ? '1' : '0';
  if (typeof snapshot.FINAL_AI_QC === 'boolean') patch.FINAL_AI_QC = snapshot.FINAL_AI_QC ? 'true' : 'false';
  if (typeof snapshot.FINAL_AI_QC_STRICT === 'boolean') patch.FINAL_AI_QC_STRICT = snapshot.FINAL_AI_QC_STRICT ? 'true' : 'false';
  // Selalu ditulis (bukan hanya saat 'aktif') karena default env berbeda default snapshot
  // tidak boleh terjadi: mode lama job harus terkunci persis saat retry.
  if (typeof snapshot.GEMINI_INPUT_MODE === 'string') patch.GEMINI_INPUT_MODE = snapshot.GEMINI_INPUT_MODE;
  if (typeof snapshot.ACQUISITION_FLOW === 'string') patch.ACQUISITION_FLOW = snapshot.ACQUISITION_FLOW;
  if (typeof snapshot.EVIDENCE_MIN_FRAMES === 'number') patch.EVIDENCE_MIN_FRAMES = String(snapshot.EVIDENCE_MIN_FRAMES);
  if (typeof snapshot.EVIDENCE_MAX_FRAMES === 'number') patch.EVIDENCE_MAX_FRAMES = String(snapshot.EVIDENCE_MAX_FRAMES);
  return patch;
}

/**
 * Helper konsumen: apakah evidence mode aktif (frame bersih lokal menggantikan
 * stream/File API). Baca dari process.env (di-bekukan via configSnapshot saat retry).
 */
export function isGeminiEvidenceEnabled(env = process.env) {
  return String(env.GEMINI_INPUT_MODE || '').trim().toLowerCase() !== 'stream';
}

/**
 * Helper konsumen: apakah ALUR BARU 6-langkah aktif. Default OFF ('legacy') supaya
 * perilaku semua pemanggil lama tidak berubah sampai jalur baru terbukti hijau.
 */
export function isNewFlowEnabled(env = process.env) {
  return String(env.ACQUISITION_FLOW || '').trim().toLowerCase() === 'v2';
}

/**
 * Ringkas untuk log: satu baris berisi nilai beku yang relevan.
 */
export function describeConfigSnapshot(snapshot) {
  if (!snapshot) return '(tanpa snapshot)';
  return SNAPSHOT_FLAG_KEYS
    .map((k) => `${k}=${snapshot[k]}`)
    .concat([`niche=${snapshot.niche}`, `sourcePolicy=${snapshot.sourcePolicy || '-'}`])
    .join(' ');
}
