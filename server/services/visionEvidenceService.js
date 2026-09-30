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
 * Kunci identitas VIDEO SUMBER sebuah frame. Dipakai untuk menjamin bukti yang
 * dikirim ke Gemini mencakup SETIAP sumber, dan untuk memberi label sumber pada
 * manifest frame (tanpa label, AI tidak bisa menyebar klip lintas sumber).
 */
export function sourceKeyOf(frame) {
  if (!frame) return 'src:unknown';
  if (frame.candidateIndex !== undefined && frame.candidateIndex !== null) return `cand:${frame.candidateIndex}`;
  const id = frame.videoId || frame.candidate?.id || frame.candidateUrl || frame.candidate?.url;
  return id ? `src:${String(id)}` : 'src:unknown';
}

/**
 * Inti pemilihan bukti untuk SATU sumber kronologis: potong per kluster (celah
 * waktu > clusterGapSec = beda adegan), alokasikan budget proporsional per kluster
 * (floor 1), dan selalu sertakan frame awal + akhir tiap kluster agar boundary
 * jendela bersih ikut terkirim.
 *
 * @param {Array} chronological frame satu sumber, sudah diurutkan by timestamp
 * @param {number} budget jumlah maksimum frame yang boleh diambil dari sumber ini
 * @param {number} clusterGapSec ambang pemisah kluster (detik)
 * @returns {Array} subset (REFERENSI OBJEK identik dengan input), panjang <= budget
 */
function pickWithinSource(chronological, budget, clusterGapSec) {
  const list = chronological || [];
  if (!list.length || budget <= 0) return [];
  if (list.length <= budget) return list;

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
  const budgets = clusters.map((c) => Math.max(1, Math.min(c.length, Math.floor((c.length / totalWeight) * budget))));
  let leftover = budget - budgets.reduce((a, b) => a + b, 0);
  for (let i = 0; i < budgets.length && leftover > 0; i++) {
    if (budgets[i] < clusters[i].length) { budgets[i]++; leftover--; }
  }

  // 3. Dalam kluster: ambil indeks merata DAN selalu sertakan batas awal/akhir.
  const picked = [];
  clusters.forEach((cluster, ci) => {
    const cap = Math.min(budgets[ci], cluster.length);
    if (cap >= cluster.length) {
      picked.push(...cluster);
      return;
    }
    const idxs = new Set([0, cluster.length - 1]);
    const step = (cluster.length - 1) / Math.max(1, cap - 1);
    for (let k = 0; k < cap; k++) idxs.add(Math.round(k * step));
    [...idxs]
      .sort((a, b) => a - b)
      .slice(0, cap)
      .forEach((idx) => picked.push(cluster[idx]));
  });

  return picked;
}

/**
 * Pilih budget frame bukti secara CLUSTER-AWARE dan SOURCE-AWARE.
 *
 * BUG LAPANGAN (kitchen_tools, 30 Sep 2026): versi lama mengurutkan SELURUH pool
 * by timestamp lalu memotong ke `max` tanpa peduli sumber. Karena tiap video
 * di-sample mulai detik 0, kluster awal berisi frame dari semua sumber dan
 * budget habis dikuasai satu video -> Gemini hanya punya bukti 1 sumber ->
 * seluruh klip Reels berasal dari 1 video (variasi sudut/latar hilang), padahal
 * prompt memerintahkan minimal 2 sumber berbeda.
 *
 * Sekarang: pool dipartisi per video sumber, tiap sumber dapat jatah minimum
 * (default 2 frame, selama `max` cukup), sisa budget dibagi dengan water-filling
 * (sumber yang frame bersihnya sedikit diambil SELURUHNYA lebih dulu, bukan
 * dipangkas oleh sumber melimpah), lalu hasilnya di-interleave round-robin agar
 * manifest menyebut sumber secara bergantian. Elemen hasil tetap REFERENSI OBJEK
 * yang sama dengan input supaya mapFramesToBudgeted (indexOf) bekerja.
 *
 * @param {Array<{ timestamp?: number, candidateIndex?: number }>} frames frame bersih
 * @param {{ max?: number, clusterGapSec?: number, minPerSource?: number }} [opts]
 * @returns {Array} subset <= max, mewakili setiap sumber bila memungkinkan
 */
export function pickEvidenceFrames(frames = [], opts = {}) {
  const max = Math.max(4, Number(opts.max ?? process.env.EVIDENCE_MAX_FRAMES) || 30);
  const clusterGapSec = Number(opts.clusterGapSec) || 8;
  const list = (frames || []).filter((f) => f && (f.base64 || f.filePath));
  if (!list.length) return [];

  // 1. Partisi per sumber, urutan kemunculan pertama dipertahankan.
  const groups = new Map();
  for (const f of list) {
    const key = sourceKeyOf(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const sources = [...groups.values()].map((g) =>
    g.slice().sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
  );

  // 2. Satu sumber -> jalur lama (cluster-aware global), tidak ada perubahan perilaku.
  if (sources.length === 1) {
    const only = sources[0];
    return only.length <= max ? only : dedupeFrames(pickWithinSource(only, max, clusterGapSec));
  }

  // 3. Jatah minimum per sumber, dibatasi agar total tetap <= max.
  const wantMin = Math.max(1, Number(opts.minPerSource ?? process.env.EVIDENCE_MIN_FRAMES_PER_SOURCE) || 2);
  const minPerSource = Math.min(wantMin, Math.floor(max / sources.length)) || 1;

  // 4. WATER-FILLING: naikkan level jatah serentak sampai budget habis. Sifatnya
  //    penting: sumber yang frame bersihnya SEDIKIT (mis. 5 dari 100) akan diambil
  //    SELURUHNYA lebih dulu, bukan dipangkas proporsional oleh sumber yang melimpah.
  //    Pembagian proporsional murni pernah memangkas sumber 5 frame jadi 3 frame.
  const maxLen = Math.max(...sources.map((s) => s.length));
  let level = minPerSource;
  let budgets = sources.map((s) => Math.min(s.length, level));
  while (level < maxLen) {
    const next = sources.map((s) => Math.min(s.length, level + 1));
    const total = next.reduce((a, b) => a + b, 0);
    if (total > max) break;
    level += 1;
    budgets = next;
  }

  // 5. Sisa budget dibagi rata (round-robin) ke sumber yang masih punya frame tersisa.
  let spare = max - budgets.reduce((a, b) => a + b, 0);
  while (spare > 0) {
    const openIdx = budgets
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => b < sources[i].length)
      .map(({ i }) => i);
    if (!openIdx.length) break;
    for (const i of openIdx) {
      if (spare <= 0) break;
      if (budgets[i] < sources[i].length) { budgets[i]++; spare--; }
    }
  }

  // 6. Pilih dalam tiap sumber lalu INTERLEAVE round-robin (kronologis intra-sumber).
  const perSource = budgets.map((b, i) => (b >= sources[i].length ? sources[i] : pickWithinSource(sources[i], b, clusterGapSec)));
  const maxRounds = Math.max(0, ...perSource.map((p) => p.length));
  const interleaved = [];
  for (let round = 0; round < maxRounds; round++) {
    for (const p of perSource) {
      if (round < p.length) interleaved.push(p[round]);
    }
  }

  // 7. Unik per file (objek identik dipertahankan; jangan pernah menyalin objek).
  return dedupeFrames(interleaved);
}

/** Buang duplikat berdasarkan filePath/base64, tanpa menyalin objek frame. */
function dedupeFrames(list = []) {
  const seen = new Set();
  return list.filter((f) => {
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
