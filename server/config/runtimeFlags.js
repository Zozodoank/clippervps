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
  // finalizationService: process.env.FINAL_AI_QC !== 'false'
  FINAL_AI_QC: (env) => env.FINAL_AI_QC !== 'false',
  // finalizationService: process.env.FINAL_AI_QC_STRICT === 'true'
  FINAL_AI_QC_STRICT: (env) => env.FINAL_AI_QC_STRICT === 'true',
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
  if (typeof snapshot.FINAL_AI_QC === 'boolean') patch.FINAL_AI_QC = snapshot.FINAL_AI_QC ? 'true' : 'false';
  if (typeof snapshot.FINAL_AI_QC_STRICT === 'boolean') patch.FINAL_AI_QC_STRICT = snapshot.FINAL_AI_QC_STRICT ? 'true' : 'false';
  return patch;
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
