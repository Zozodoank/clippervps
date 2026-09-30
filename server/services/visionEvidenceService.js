// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE MODE — Gemini TIDAK membaca ulang video penuh (fileUri stream /
// File API upload). Yang dikirim ke Gemini hanyalah BUKTI VISUAL yang sudah
// diekstrak & diverifikasi Gatekeeper lokal di disk:
//   * 0 MB kuota internet tambahan (frame sudah tersdownload saat sampling).
//   * Token Gemini turun drastis (puluhan gambar low-detail vs video utuh).
// Flag GEMINI_INPUT_MODE ('evidence' default | 'stream' = perilaku lama),
// dibekukan per-job via configSnapshot sehingga retry mereproduksi mode-nya.
//
// Semua fungsi di modul ini PURE (tanpa I/O) agar dapat dikunci unit test.
// ─────────────────────────────────────────────────────────────────────────────

/** Frame "usable" = punya path file di disk ATAU base64 yang sudah di-encode. */
export function countUsableFrames(frames = []) {
  return (frames || []).filter((f) => f && (f.base64 || f.filePath)).length;
}

/**
 * Gerbang keputusan dispatch: apakah jalur evidence (frame bersih lokal) boleh
 * dipakai menggantikan stream/File API. Murni & deterministik.
 * @param {{ evidenceEnabled: boolean, usableFrames: number, minFrames?: number }} params
 */
export function shouldPreferEvidence({ evidenceEnabled, usableFrames, minFrames = null }) {
  // minFrames=null/''/NaN berarti "tidak di-set" -> pakai env (default 6). Selalu
  // difloor 2 agar job tanpa bukti sama sekali tidak pernah lolos ke evidence.
  const provided = minFrames !== null && minFrames !== undefined && minFrames !== '' && Number.isFinite(Number(minFrames));
  const raw = provided ? Number(minFrames) : (Number(process.env.EVIDENCE_MIN_FRAMES) || 6);
  const floor = Math.max(2, raw);
  return Boolean(evidenceEnabled) && Number(usableFrames) >= floor;
}

/**
 * Pilih budget frame bukti secara CLUSTER-AWARE (bukan stride merata biasa):
 * frame bersih diurutkan kronologis, dipotong per kluster (jarak waktu >
 * clusterGapSec = beda adegan/window), lalu budget dialokasikan proporsional
 * per kluster dengan floor 1 dan dijamin mencakup frame awal+akhir kluster
 * (boundary jendela clean ikut terkirim sebagai bukti).
 *
 * @param {Array<{ timestamp?: number }>} frames frame bersih (sudah lolos Gatekeeper)
 * @param {{ max?: number, clusterGapSec?: number }} [opts]
 * @returns {Array} subset frame kronologis (OBJEK IDENTIK dengan input — dipakai
 *   `indexOf` untuk menerjemahkan indeks), panjang <= max
 */
export function pickEvidenceFrames(frames = [], opts = {}) {
  const max = Math.max(4, Number(opts.max ?? process.env.EVIDENCE_MAX_FRAMES) || 30);
  const clusterGapSec = Number(opts.clusterGapSec) || 8;
  const list = (frames || [])
    .filter((f) => f && (f.base64 || f.filePath))
    .slice()
    .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  if (list.length <= max) return list;

  // 1. Pecah jadi kluster berdasarkan celah waktu antar frame.
  const clusters = [];
  let current = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const prevTs = Number(current[current.length - 1].timestamp) || 0;
    const ts = Number(list[i].timestamp) || 0;
    if (ts - prevTs > clusterGapSec) {
      clusters.push(current);
      current = [list[i]];
    } else {
      current.push(list[i]);
    }
  }
  if (current.length) clusters.push(current);

  // 2. Alokasi budget proporsional dengan kluster (floor 1, cap isi kluster).
  const weights = clusters.map((c) => c.length);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const budgets = clusters.map((c) => Math.max(1, Math.min(c.length, Math.floor((c.length / totalWeight) * max))));
  let leftover = max - budgets.reduce((a, b) => a + b, 0);
  for (let i = 0; i < budgets.length && leftover > 0; i++) {
    if (budgets[i] < clusters[i].length) { budgets[i]++; leftover--; }
  }

  // 3. Dalam kluster: ambil indeks merata DAN selalu sertakan batas awal/akhir.
  const picked = [];
  clusters.forEach((cluster, ci) => {
    const budget = Math.min(budgets[ci], cluster.length);
    if (budget >= cluster.length) {
      picked.push(...cluster);
      return;
    }
    const idxs = new Set([0, cluster.length - 1]);
    const step = (cluster.length - 1) / Math.max(1, budget - 1);
    for (let k = 0; k < budget; k++) idxs.add(Math.round(k * step));
    [...idxs].sort((a, b) => a - b).slice(0, Math.max(budget, idxs.size > budget ? budget : idxs.size))
      .forEach((idx) => picked.push(cluster[idx]));
  });

  // 4. Kronologis & unik (jaga urutan video-sumber untuk penomoran prompt).
  //    PENTING: elemen hasil adalah REFERENSI OBJEK yang sama dengan input —
  //    jangan pernah menyalin objek frame agar pemanggil bisa memetakan balik
  //    indeks subset -> indeks array asli via indexOf (dipakai mapFramesToBudgeted).
  const seen = new Set();
  return picked
    .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
    .filter((f) => {
      const key = f.filePath || f.base64?.slice(0, 48) || JSON.stringify(f).slice(0, 48);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Terjemahkan indeks 1-based ruang SUBSET bukti (nomor frame yang dilihat AI)
 * kembali ke indeks 1-based ruang array `frames` ASLI yang dipegang konsumen
 * (mis. testPool multi-harvest). Tanpa ini, `acceptedFrames` dari AI dipakai
 * langsung sebagai indeks pool mentah dan menunjuk frame SALAH begitu subset
 * diurut/dedup ulang.
 *
 * Catatan: pemetaan lewat `indexOf` membutuhkan objek identik (lihat
 * pickEvidenceFrames). Frame asing / duplikat objek -> fallback indeks itu
 * sendiri sehingga perilaku lama (subset == array asli) tidak berubah.
 *
 * @param {number[]} idxs indeks 1-based dalam urutan subset yang dikirim ke AI
 * @param {Array} subset hasil pickEvidenceFrames
 * @param {Array} original array frames penuh sebelum dipotong
 * @returns {number[]} indeks 1-based dalam `original` (sudah dibuang yang tak valid)
 */
export function mapFramesToBudgeted(idxs = [], subset = [], original = []) {
  if (!Array.isArray(idxs) || !idxs.length) return [];
  if (!Array.isArray(subset) || !Array.isArray(original) || !subset.length || !original.length) {
    return idxs.filter((i) => Number.isFinite(Number(i)) && Number(i) >= 1);
  }
  const out = [];
  for (const raw of idxs) {
    const i = Number(raw);
    if (!Number.isFinite(i) || i < 1 || i > subset.length) continue;
    const origIdx = original.indexOf(subset[i - 1]);
    const mapped = origIdx >= 0 ? origIdx + 1 : i;
    if (mapped >= 1 && mapped <= original.length && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Format directive "verified clean windows" untuk prompt Gemini stream.
 * Jika window membawa identitas sumber (`sourceVideoIndex`), hasilkan daftar
 * PER VIDEO sehingga Gemini tidak boleh menerapkan batas Video A ke Video B
 * (bug P0 audit: cleanTimeWindows kehilangan source video).
 * @param {Array<{ start:number, end:number, sourceVideoIndex?:number }>} windows
 * @param {string[]} [sourceLabels] label per indeks sumber (mis. URL/judul)
 * @returns {string} directive lengkap (atau '' bila windows kosong)
 */
export function formatCleanWindowsBySource(windows = [], sourceLabels = []) {
  const list = (windows || []).filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)));
  if (!list.length) return '';

  const hasSourceTag = list.some((w) => Number.isFinite(Number(w.sourceVideoIndex)));
  if (!hasSourceTag) {
    // Perilaku lama (satu sumber): daftar flat.
    return `\nCRITICAL MANDATE (VERIFIED CLEAN TEMPORAL SEGMENTS): AI Local Gatekeeper telah memverifikasi segmen-segmen waktu bersih berikut: [${list.map((w) => `${w.start}s-${w.end}s`).join(', ')}]. Anda HANYA BOLEH memilih timestamps di dalam rentang waktu yang terverifikasi bersih ini! DILARANG KERAS memilih timestamps di luar segmen bersih ini.\n`;
  }

  const bySource = new Map();
  for (const w of list) {
    const idx = Math.max(0, Math.round(Number(w.sourceVideoIndex) || 0));
    if (!bySource.has(idx)) bySource.set(idx, []);
    bySource.get(idx).push(w);
  }
  const blocks = [...bySource.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, ws]) => {
      const label = sourceLabels[idx] ? ` [${String(sourceLabels[idx]).slice(0, 60)}]` : '';
      return `  VIDEO #${idx + 1}${label}: ${ws.map((w) => `${w.start}s-${w.end}s`).join(', ')}`;
    });
  return `\nCRITICAL MANDATE (SOURCE-SCOPED VERIFIED CLEAN SEGMENTS): AI Local Gatekeeper memverifikasi segmen bersih BERDASARKAN VIDEO SUMBERNYA MASING-MASING:\n${blocks.join('\n')}\nAturan keras: (1) timestamps HANYA BOLEH dipilih di dalam segmen bersih video SUMBER yang sama; (2) batas waktu 10s-25s pada VIDEO #1 TIDAK BERLAKU untuk VIDEO #2, dst; (3) DILARANG KERAS memilih timestamp di luar daftar segmen sumber yang dipilih, dan wajib mengisi "sourceVideoIndex" sesuai video asalnya.\n`;
}

/**
 * GERBANG RESCUE PIPELINE. Bukti lapangan 30 Sep 2026 (Termux, job auto_3dd085b354):
 * Gemini menolak SELURUH keyframe bukti (30 ditolak, 0 diterima, 0 klip), tetapi
 * Guaranteed Completion Rescue Pipeline tetap merakit 7 klip dari frame yang tidak
 * pernah divonis AI -> wajah manusia masuk video final -> QC final menolak -> fail
 * final dihapus, ~52 MB kuota + 20 menit render + 1 panggilan TTS terbuang, dan job
 * dicatat "berhasil" tanpa output.
 *
 * Aturan: vonis NEGATIF AI itu keputusan, bukan gangguan teknis. Rescue hanya boleh
 * (a) bila AI tidak memberi vonis (crash/parse error), atau (b) bila AI masih
 * menyetujui minimal satu frame -> rakit dari frame yang benar-benar bersih menurut
 * AI. Vonis "0 diterima, >0 ditolak" = JANGAN memaksa.
 *
 * @param {{ aiGaveVerdict?: boolean, acceptedCount?: number, rejectedCount?: number }} state
 * @returns {boolean} true = rescue diizinkan
 */
export function shouldAllowRescue({ aiGaveVerdict = false, acceptedCount = 0, rejectedCount = 0 } = {}) {
  if (!aiGaveVerdict) return true;                       // kegagalan teknis: penyelamatan tetap sah
  if (Number(acceptedCount) > 0) return true;            // ada frame yang benar-benar disetujui AI
  return !(Number(rejectedCount) > 0);                   // vonis "semua bukti ditolak" -> jangan memaksa
}

/**
 * Ringkasan asal-usul analisa visual, dipakai sebagai penanda DURABEL di record job
 * dan trace. Tanpa ini operator hanya bisa menduga jalur mana yang dijalankan,
 * karena stdout dev-runner di Termux masuk ke /dev/pts/0 (tidak pernah tersimpan).
 * @param {{ mode?: string, usableFrames?: number, framesSent?: number, acceptedCount?: number, rejectedCount?: number, sourceCount?: number }} info
 */
export function buildVisionProvenance(info = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const allowedModes = ['evidence', 'frames_stride', 'gemini_stream', 'gemini_stream_multi'];
  const mode = allowedModes.includes(String(info.mode)) ? String(info.mode) : 'unknown';
  return {
    mode,
    usableFrames: num(info.usableFrames),
    framesSent: num(info.framesSent),
    acceptedCount: num(info.acceptedCount),
    rejectedCount: num(info.rejectedCount),
    sourceCount: num(info.sourceCount),
  };
}

/**
 * Rangkai seluruh panggilan visual satu job jadi ringkasan kecil (aman untuk DB/JSON).
 * Dipakai di record job (sukses, awaiting_voiceover, maupun error) supaya riwayat selalu
 * menyebutkan jalur yang benar-benar dieksekusi.
 * @param {Array<object>} runs daftar hasil buildVisionProvenance (+ origin)
 * @returns {{runs:number, modes:string[], acceptedTotal:number, rejectedTotal:number, last:object|null}|null}
 */
export function summarizeVisionRuns(runs = []) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
  if (!list.length) return null;
  const sum = (key) => list.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
  return {
    runs: list.length,
    modes: [...new Set(list.map((r) => r.mode || 'unknown'))],
    acceptedTotal: sum('acceptedCount'),
    rejectedTotal: sum('rejectedCount'),
    last: list[list.length - 1],
  };
}
