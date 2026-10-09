// ─────────────────────────────────────────────────────────────────────────────
// P5 — BEKUKAN KONFIGURASI RUNTIME PER JOB (configSnapshot)
//
// Masalah nyata: jalur pipeline membaca flag dari `process.env` SAAT EKSEKUSI
// (lihat stage1Render: RENDER_DOWNLOAD_SECTIONS, videoFilterService: SAMPLE_MAX_FRAMES,
// finalizationService: FINAL_AI_QC(_STRICT)). Bila operator mengganti .env lalu me-retry job lama, retry
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
  // Legacy switch is ignored; Kaggle Oracle is mandatory for visual decisions.
  ORACLE_OFFLINE_CALIBRATION: () => false,
  VLM_ORACLE_GRID: (env) => {
    const raw = env.VLM_ORACLE_GRID;
    if (raw === undefined || String(raw).trim() === '') return 2;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(2, Math.max(0, Math.round(n))) : 2;
  },
  // stage1Render: process.env.RENDER_DOWNLOAD_SECTIONS === '1'
  RENDER_DOWNLOAD_SECTIONS: (env) => env.RENDER_DOWNLOAD_SECTIONS === '1',
  // stage1Render: process.env.RENDER_NO_FULL_DOWNLOAD === '1'
  RENDER_NO_FULL_DOWNLOAD: (env) => env.RENDER_NO_FULL_DOWNLOAD === '1',
  // videoFilterService: Math.max(20, Number(process.env.SAMPLE_MAX_FRAMES) || 500)
  SAMPLE_MAX_FRAMES: (env) => Math.max(20, Number(env.SAMPLE_MAX_FRAMES) || 500),
  // downloader.js render path: parseInt(env.RENDER_MAX_HEIGHT,10) valid>0 ? itu : 1080
  RENDER_MAX_HEIGHT: (env) => {
    const v = parseInt(env.RENDER_MAX_HEIGHT, 10);
    return Number.isFinite(v) && v > 0 ? v : 1080;
  },
  // downloader.js render path: env RENDER_VIDEO_ONLY !== '0' (default ON buang audio).
  // Bekukan supaya retry di Termux (mis. 1080p + audio-on) tidak tiba-tiba berubah format.
  RENDER_VIDEO_ONLY: (env) => env.RENDER_VIDEO_ONLY !== '0',
  // finalizationService: process.env.FINAL_AI_QC !== 'false'
  FINAL_AI_QC: (env) => env.FINAL_AI_QC !== 'false',
  // finalizationService: process.env.FINAL_AI_QC_STRICT === 'true'
  FINAL_AI_QC_STRICT: (env) => env.FINAL_AI_QC_STRICT === 'true',
  // GEMINI_INPUT_MODE defaults to direct Gemini video stream; evidence mode is opt-in.
  GEMINI_INPUT_MODE: (env) => (String(env.GEMINI_INPUT_MODE || '').trim().toLowerCase() === 'evidence' ? 'evidence' : 'stream'),
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
  // window teks + zigzag + segment-only).
  ACQUISITION_FLOW: (env) => (String(env.ACQUISITION_FLOW || '').trim().toLowerCase() === 'v2' ? 'v2' : 'legacy'),
  // Visual decisions require Kaggle Oracle. Legacy modes remain parseable only so the
  // worker can reject old snapshots with a clear error before any content processing.
  // KEBIJAKAN 2026-10 (user mandate): HANYA mode 'oracle' yang boleh menjalankan job.
  // Default tidak-set/nilai tidak dikenal = 'oracle' (bukan 'legacy' lagi). Nilai eksplisit
  // 'legacy'/'smolvlm' tetap dikenali agar gerbang mode di stage1Render bisa MENOLAK job
  // dengan pesan jelas (dan snapshot lama bisa dibaca forensiknya), tetapi job-nya stop.
  VISION_VERIFY_MODE: (env) => {
    const v = String(env.VISION_VERIFY_MODE || '').trim().toLowerCase();
    return (v === 'legacy' || v === 'smolvlm') ? v : 'oracle';
  },
  // Plafon TOTAL frame per job yang dikirim ke oracle (biaya GPU Kaggle ±30 jam/minggu).
  // Pool bisa berisi ratusan frame; subset dipilih merata sepanjang garis waktu (lihat
  // pickEvenlySpaced) agar cakupan temporal tetap ada walau jumlahnya dibatasi.
  // 0 EKSPISIT dihormati (tidak dikonversi ke 120): di kebijakan strict, 0 = "tidak ada
  // yang divisit" = job DITOLAK di gerbang oracle (OracleUnavailableError reason 'infra').
  VLM_ORACLE_MAX_FRAMES: (env) => {
    const raw = env.VLM_ORACLE_MAX_FRAMES;
    if (raw === undefined || raw === null || String(raw).trim() === '') return 120;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 120;
  },
  // Tinggi target kanvas JPEG potret 9:16 yang DIKIRIM ke notebook. Sumber di-letterbox
  // tanpa crop agar produk tetap utuh; nilai 0 tidak boleh melewati transformasi.
  // Terlalu kecil => watermark/subtitle tipis
  // bisa tak terbaca model, makanya nilainya terkurung 240..720.
  VLM_ORACLE_FRAME_HEIGHT: (env) => {
    const h = Math.round(Number(env.VLM_ORACLE_FRAME_HEIGHT));
    if (!Number.isFinite(h) || Number.isNaN(h)) return 360;
    return Math.min(720, Math.max(240, h));
  },
  // Jumlah frame per batch (satu panggilan klaim notebook). 8 = satu kali muat bobot untuk
  // beberapa frame tanpa prompt yang kepanjangan.
  VLM_ORACLE_BATCH_SIZE: (env) => Math.min(16, Math.max(1, Number(env.VLM_ORACLE_BATCH_SIZE) || 8)),
  // Waktu tunggu MAKSIMAL per batch (detik). Lewat = JOB DIHENTIKAN (OracleUnavailableError),
  // bukan "lanjut dengan keputusan legacy" lagi — vonis Kaggle adalah satu-satunya gerbang.
  VLM_ORACLE_TIMEOUT_SEC: (env) => Math.max(5, Number(env.VLM_ORACLE_TIMEOUT_SEC) || 180),
  // Anggaran waktu seluruh tahap sanitasi oracle dalam satu job (detik). Mencegah satu job
  // menahan antrean berjam-jam saat notebook mati/manusia belum menekan Run. Lewat = stop job.
  VLM_ORACLE_TOTAL_TIMEOUT_SEC: (env) => Math.max(10, Number(env.VLM_ORACLE_TOTAL_TIMEOUT_SEC) || 600),
  // Batas menunggu batch PERTAMA diklaim notebook (= sinyal "Kaggle terhubung", detik).
  // Batch yang sampai batas ini masih 'pending' (tak pernah diklaim) = notebook offline ->
  // job dihentikan dengan reason 'never_claimed'.
  VLM_ORACLE_CONNECT_TIMEOUT_SEC: (env) => Math.max(10, Number(env.VLM_ORACLE_CONNECT_TIMEOUT_SEC) || 120),
  // Plafon frame tahap AUDIT KLIP FINAL (clip_audit pasca-download, cadence 2,5 fps yang
  // sudah ada). Terpisah dari VLM_ORACLE_MAX_FRAMES (pass pool) supaya keduanya bisa
  // diatur sendiri: audit klip jauh lebih mahal per job karena memakan seluruh klip.
  // 0 = nonaktifkan pass audit klip (hanya pass pool yang jalan).
  VLM_ORACLE_AUDIT_MAX_FRAMES: (env) => {
    const n = Number(env.VLM_ORACLE_AUDIT_MAX_FRAMES);
    if (n === 0) return 0;
    if (!Number.isFinite(n)) return 90;
    return Math.min(240, Math.max(8, Math.round(n)));
  },
  // Filter kualitas sumber pre-flight: kandidat yang divonis Kaggle dengan
  // apparentQuality 0-100 DI BAWAH ambang ini dibuang sebelum peringkat. 0 (default) =
  // mati - skor tetap dicatat di hasil vonis sebagai forensik, tak ada yang gugur.
  // CATATAN: ini persepsi visual model (blur/blok kompresi), BUKAN pengukur resolusi
  // native - frame sengaja dikirim 360p, jadi skor tinggi pun tidak menjamin sumber 1080p.
  VLM_ORACLE_MIN_QUALITY: (env) => {
    const n = Math.round(Number(env.VLM_ORACLE_MIN_QUALITY));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(100, n);
  },
  // Interval polling worker saat menunggu vonis (milidetik).
  VLM_ORACLE_POLL_MS: (env) => Math.max(250, Number(env.VLM_ORACLE_POLL_MS) || 2000),
  // Candidate pre-flight is always performed by Kaggle when Oracle mode is active.
  PREFLIGHT_ORACLE: (env) => isVlmOracleEnabled(env),
  // Batch 'claimed' lebih tua dari ini (detik) dianggap worker mati -> dikembalikan ke
  // 'pending' (atau 'expired' bila percobaan habis). Notebook Kaggle boleh mati kapan saja.
  VLM_ORACLE_STALE_SEC: (env) => Math.max(30, Number(env.VLM_ORACLE_STALE_SEC) || 300),
  VLM_ORACLE_MAX_ATTEMPTS: (env) => Math.max(1, Number(env.VLM_ORACLE_MAX_ATTEMPTS) || 2),
  // AUTO-LAUNCH sesi Kaggle dari perangkat server (butuh kaggle CLI + kredensial,
  // mis. Termux proot). Default MATI: PC tanpa CLI tidak pernah mencoba spawn.
  ORACLE_AUTO_LAUNCH: (env) => String(env.ORACLE_AUTO_LAUNCH || '').trim() === '1',
  ORACLE_AUTO_LAUNCH_WAIT_SEC: (env) => Math.max(15, Number(env.ORACLE_AUTO_LAUNCH_WAIT_SEC) || 300),
  ORACLE_AUTO_LAUNCH_COOLDOWN_MIN: (env) => Math.max(1, Number(env.ORACLE_AUTO_LAUNCH_COOLDOWN_MIN) || 10),
  // URL publik lokal (tunnel) tempat notebook memanggil API. Server hanya menyimpan/melaporkan
  // untuk kenyamanan log; yang memakai nilai ini adalah notebook di sisi Kaggle.
  VLM_ORACLE_BASE_URL: (env) => String(env.VLM_ORACLE_BASE_URL || '').trim(),
  // Panjang klip per kandidat scene (detik). Sekaligus menentukan jumlah frame saat 1 fps.
  // Clamp ke rentang aman 2-5s sesuai percakapan (2 dtk=2 frame, 5 dtk=5 frame).
  SCENE_CLIP_DURATION_SEC: (env) => {
    const v = Number(env.SCENE_CLIP_DURATION_SEC);
    if (!Number.isFinite(v) || v <= 0) return 4;
    return Math.min(5, Math.max(2, v));
  },
  // Rasio sampling frame per detik klip. Default 1 (= jumlah frame mengikuti durasi klip).
  SCENE_SAMPLE_FPS: (env) => Math.max(0.5, Number(env.SCENE_SAMPLE_FPS) || 1),
  // Jatah waktu VLM per frame (detik) untuk timeout subprocess llama-mtmd-cli. Default 10.
  GK_VLM_TIMEOUT_SEC_PER_FRAME: (env) => Math.max(1, Number(env.GK_VLM_TIMEOUT_SEC_PER_FRAME) || 10),
  // downloader.js: YTDLP_PROXY_REQUIRED === '1'
  YTDLP_PROXY_REQUIRED: (env) => env.YTDLP_PROXY_REQUIRED === '1',
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
  // Selalu ditulis agar mode verifikasi visual terkunci persis saat retry.
  if (typeof snapshot.VISION_VERIFY_MODE === 'string') patch.VISION_VERIFY_MODE = snapshot.VISION_VERIFY_MODE;
  // Oracle Kaggle: selalu ditulis (string/number) agar retry memakai anggaran waktu & plafon
  // frame yang sama persis dengan saat job pertama kali jalan.
  if (typeof snapshot.VLM_ORACLE_MAX_FRAMES === 'number') patch.VLM_ORACLE_MAX_FRAMES = String(snapshot.VLM_ORACLE_MAX_FRAMES);
  if (typeof snapshot.VLM_ORACLE_BATCH_SIZE === 'number') patch.VLM_ORACLE_BATCH_SIZE = String(snapshot.VLM_ORACLE_BATCH_SIZE);
  if (typeof snapshot.VLM_ORACLE_FRAME_HEIGHT === 'number') patch.VLM_ORACLE_FRAME_HEIGHT = String(snapshot.VLM_ORACLE_FRAME_HEIGHT);
  if (typeof snapshot.VLM_ORACLE_AUDIT_MAX_FRAMES === 'number') patch.VLM_ORACLE_AUDIT_MAX_FRAMES = String(snapshot.VLM_ORACLE_AUDIT_MAX_FRAMES);
  if (typeof snapshot.VLM_ORACLE_MIN_QUALITY === 'number') patch.VLM_ORACLE_MIN_QUALITY = String(snapshot.VLM_ORACLE_MIN_QUALITY);
  if (typeof snapshot.VLM_ORACLE_TIMEOUT_SEC === 'number') patch.VLM_ORACLE_TIMEOUT_SEC = String(snapshot.VLM_ORACLE_TIMEOUT_SEC);
  if (typeof snapshot.VLM_ORACLE_TOTAL_TIMEOUT_SEC === 'number') patch.VLM_ORACLE_TOTAL_TIMEOUT_SEC = String(snapshot.VLM_ORACLE_TOTAL_TIMEOUT_SEC);
  if (typeof snapshot.VLM_ORACLE_CONNECT_TIMEOUT_SEC === 'number') patch.VLM_ORACLE_CONNECT_TIMEOUT_SEC = String(snapshot.VLM_ORACLE_CONNECT_TIMEOUT_SEC);
  if (typeof snapshot.VLM_ORACLE_POLL_MS === 'number') patch.VLM_ORACLE_POLL_MS = String(snapshot.VLM_ORACLE_POLL_MS);
  if (typeof snapshot.VLM_ORACLE_STALE_SEC === 'number') patch.VLM_ORACLE_STALE_SEC = String(snapshot.VLM_ORACLE_STALE_SEC);
  if (typeof snapshot.VLM_ORACLE_MAX_ATTEMPTS === 'number') patch.VLM_ORACLE_MAX_ATTEMPTS = String(snapshot.VLM_ORACLE_MAX_ATTEMPTS);
  if (typeof snapshot.PREFLIGHT_ORACLE === 'boolean') patch.PREFLIGHT_ORACLE = snapshot.PREFLIGHT_ORACLE ? '1' : '0';
  if (typeof snapshot.VLM_ORACLE_BASE_URL === 'string') patch.VLM_ORACLE_BASE_URL = snapshot.VLM_ORACLE_BASE_URL;
  if (typeof snapshot.SCENE_CLIP_DURATION_SEC === 'number') patch.SCENE_CLIP_DURATION_SEC = String(snapshot.SCENE_CLIP_DURATION_SEC);
  if (typeof snapshot.SCENE_SAMPLE_FPS === 'number') patch.SCENE_SAMPLE_FPS = String(snapshot.SCENE_SAMPLE_FPS);
  if (typeof snapshot.GK_VLM_TIMEOUT_SEC_PER_FRAME === 'number') patch.GK_VLM_TIMEOUT_SEC_PER_FRAME = String(snapshot.GK_VLM_TIMEOUT_SEC_PER_FRAME);
  // Selalu ditulis: default 'advisory' bergantung mode oracle, retry wajib memakai peran
  // vonis lokal yang sama persis dengan saat job pertama jalan.
  // SAFETY NET (regresi review 2026-10-05): daftar eksplisit di atas dulu TIDAK memuat
  // EVIDENCE_MIN_FRAMES_PER_SOURCE / RENDER_SAMPLE_INTERVAL_SEC / ORACLE_AUTO_LAUNCH*
  // sehingga 5 flag hilang diam-diam saat retry (mis. auto-launch yang dibekukan OFF
  // ikut ulang env operator -> GPU Kaggle menyala lagi). Setiap flag beku tanpa aturan
  // eksplisit kini tetap dipulihkan lewat serialisasi default per tipe: boolean -> '1'/'0'
  // kanonik (konsumen proyek membaca === '1' / '1'|'true'), number -> String, string -> apa adanya.
  // CATATAN: flag baru yang konsumennya membaca 'true' literal wajib diberi aturan eksplisit
  // di atas agar tidak terserialisasi '1' — kelengkapan dijaga test configSnapshot.test.js.
  for (const key of SNAPSHOT_FLAG_KEYS) {
    if (key in patch) continue;
    const v = snapshot[key];
    if (typeof v === 'boolean') patch[key] = v ? '1' : '0';
    else if (typeof v === 'number' && Number.isFinite(v)) patch[key] = String(v);
    else if (typeof v === 'string' && v !== '') patch[key] = v;
  }
  return patch;
}

/**
 * Helper konsumen: apakah evidence mode aktif (frame bersih lokal menggantikan
 * stream/File API). Baca dari process.env (di-bekukan via configSnapshot saat retry).
 */
export function isGeminiEvidenceEnabled(env = process.env) {
  return String(env.GEMINI_INPUT_MODE || '').trim().toLowerCase() === 'evidence';
}

/**
 * Helper konsumen: apakah ALUR BARU 6-langkah aktif. Default OFF ('legacy') supaya
 * perilaku semua pemanggil lama tidak berubah sampai jalur baru terbukti hijau.
 */
export function isNewFlowEnabled(env = process.env) {
  return String(env.ACQUISITION_FLOW || '').trim().toLowerCase() === 'v2';
}

export function isVlmOracleEnabled(env = process.env) {
  const v = String(env.VISION_VERIFY_MODE || '').trim().toLowerCase();
  return v !== 'legacy' && v !== 'smolvlm';
}

/**
 * Helper konsumen: apakah kebijakan STRICT oracle-only berlaku. Sejak user mandate
 * 2026-10 mode oracle SELALU strict: oracle diam/timeout/vonis tidak sah = job BERHENTI,
 * bukan "lanjut dengan keputusan legacy". Helper dipisah agar tooling kalibrasi di
 * scratch/ bisa mengirim strict=false lewat opsi pemanggil (perilaku lama dipertahankan
 * di sana) tanpa menyentuh jalur produksi.
 */
export function isOracleStrictMode(env = process.env) {
  return isVlmOracleEnabled(env);
}

/**
 * Helper konsumen: apakah tahap PRE-FLIGHT KANDIDAT boleh dipindah ke Kaggle.
 * Dua syarat, dan keduanya nyata: oracle harus aktif (kalau tidak, tidak ada yang
 * memvonis frame), dan flag-nya tidak boleh dimatikan eksplisit. Default ON karena
 * pemakai oracle biasanya sedang mengejar penghematan token Gemini — tahap pre-flight
 * inilah yang mengirim utuh beberapa video lewat File API.
 */
export function isOraclePreflightEnabled(env = process.env) {
  return isVlmOracleEnabled(env);
}

export function describeConfigSnapshot(snapshot) {
  if (!snapshot) return '(tanpa snapshot)';
  return SNAPSHOT_FLAG_KEYS
    .map((k) => `${k}=${snapshot[k]}`)
    .concat([`niche=${snapshot.niche}`, `sourcePolicy=${snapshot.sourcePolicy || '-'}`])
    .join(' ');
}

/**
 * Terapkan kembali setelan beku ke process.env saat ini (untuk sesi retry).
 * DELEGASI ke configSnapshotToEnvPatch — SATU sumber kebenaran normalisasi. Dulu fungsi
 * ini menulis String(v) langsung, padahal konsumen membaca `=== '1'` / `!== '0'`:
 * boolean true -> 'true' justru MEMATIKAN RENDER_DOWNLOAD_SECTIONS (auto-retry mengunduh
 * video penuh = boros kuota Termux), dan false -> 'false' justru MENGAKTIFKAN
 * RENDER_VIDEO_ONLY/PREFLIGHT_ORACLE. Key non-flag (niche/sourcePolicy/_frozenAt)
 * ikut tersaring oleh patch — tidak lagi bocor ke namespace process.env.
 */
export function applyConfigSnapshot(snapshot) {
  for (const [k, v] of Object.entries(configSnapshotToEnvPatch(snapshot))) {
    process.env[k] = v;
  }
}
