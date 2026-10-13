/**
 * Perencanaan unduhan per-segmen (hemat kuota) untuk tahap render.
 *
 * Alih-alih mengunduh video sumber penuh (5-10 menit) padahal yang dipakai hanya
 * beberapa klip pendek, kita mengelompokkan klip menjadi beberapa "cluster" rentang
 * lalu mengunduh hanya rentang tersebut via yt-dlp --download-sections.
 *
 * PENTING: fungsi ini MURNI (tanpa efek samping) supaya mudah diuji. startSeconds yang
 * dikembalikan tetap GLOBAL; setiap cluster membawa `sourceOffsetSec` = waktu mulai file
 * segmen, sehingga renderer cukup menghitung (-ss = startSeconds - sourceOffsetSec).
 */

/**
 * @param {Array<{ startSeconds?: number|string, duration?: number }>} clips
 * @param {object} [opts]
 * @param {number} [opts.padSec=2]      Kepala: tambahan detik sebelum klip pertama cluster (akurasi seek/keyframe).
 * @param {number} [opts.tailPadSec=5]  Ekor: tambahan setelah klip terakhir (menyerap perpanjangan durasi saat pacing/conform).
 * @param {number} [opts.gapSec=15]     Celah maksimum antar-klip agar digabung ke cluster yang sama.
 * @param {number} [opts.videoDuration=0] Durasi total sumber (untuk clamp). 0 = tidak diketahui (tanpa clamp atas).
 * @param {number} [opts.minSpan=1]     Rentang minimum sebuah cluster (detik).
 * @returns {Array<{ startSec: number, endSec: number, sourceOffsetSec: number, refs: object[] }>}
 */
export function planSectionDownloads(clips, opts = {}) {
  const {
    padSec = 2,
    tailPadSec = 5,
    gapSec = 15,
    videoDuration = 0,
    minSpan = 1,
  } = opts;

  const items = (Array.isArray(clips) ? clips : [])
    .map((c) => ({
      ref: c,
      start: Number(c?.startSeconds),
      dur: Number(c?.duration) || 0,
    }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.dur > 0)
    .sort((a, b) => a.start - b.start);

  const clusters = [];
  for (const it of items) {
    const start = it.start;
    const end = it.start + it.dur;
    const last = clusters[clusters.length - 1];
    if (last && start - last.contentEnd <= gapSec) {
      last.contentEnd = Math.max(last.contentEnd, end);
      last.refs.push(it);
    } else {
      clusters.push({ contentStart: start, contentEnd: end, refs: [it] });
    }
  }

  const cap = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Infinity;

  return clusters.map((cl) => {
    let startSec = Math.max(0, cl.contentStart - padSec);
    let endSec = Math.min(cap, cl.contentEnd + tailPadSec);
    if (endSec - startSec < minSpan) {
      endSec = Math.min(cap, startSec + minSpan);
    }
    // sourceOffsetSec = titik-nol timeline file segmen ini (relatif ke waktu global sumber).
    return {
      startSec: +startSec.toFixed(3),
      endSec: +endSec.toFixed(3),
      sourceOffsetSec: +startSec.toFixed(3),
      refs: cl.refs.map((r) => r.ref),
    };
  });
}

/**
 * Pilih file segmen yang MEMUAT sebuah waktu global (untuk klip pemulihan pasca-audit).
 * Murni & terkunci unit test. `sections` = katalog hasil unduhan per kandidat:
 * [{ videoPath, sourceOffsetSec, endSec }] (endSec = batas akhir rentang global yang
 * terunduh; pakai Number.MAX_SAFE_INTEGER untuk video penuh).
 *
 * spanSec WAJIB muat utuh di dalam section: klip pemulihan berdurasi ~3.8s yang mulai
 * dekat EOF akan menghasilkan render/audit yang membaca melewati akhir file.
 *
 * @param {Array<{videoPath?: string, sourceOffsetSec?: number, endSec?: number}>} sections
 * @param {number} globalSec - waktu sumber global yang harus tercakup
 * @param {number} [spanSec=0] - panjang rentang setelah globalSec yang harus ikut muat
 * @returns {{videoPath: string, sourceOffsetSec: number}|null}
 */
export function pickSectionFor(sections, globalSec, spanSec = 0) {
  const t = Number(globalSec);
  if (!Number.isFinite(t)) return null;
  const span = Math.max(0, Number(spanSec) || 0);
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!s?.videoPath) continue;
    const from = Number(s.sourceOffsetSec) || 0;
    const to = Number(s.endSec);
    if (t >= from && Number.isFinite(to) && (t + span) < to - 0.1) {
      return { videoPath: s.videoPath, sourceOffsetSec: from };
    }
  }
  return null;
}

/**
 * Petakan hasil unduhan per-cluster ke masing-masing klip (pure; dipakai jalur auto &
 * manual stage1Render supaya tes integrasi menguji kode produksi, bukan salinan).
 * - Klip ber-`_cluster` (file --download-sections sendiri): videoPath + sourceOffsetSec dari cluster.
 * - Klip tanpa cluster: videoPath dari fallbackPathByCandidate (Map candIdx->path hasil unduh penuh);
 *   TIDAK pernah diremap ke video lain (menghindari storyboard multi-sumber diam-diam berulang).
 * @param {object[]} clips
 * @param {Map<number,string>|object} fallbackPathByCandidate
 * @param {{onMissing?: (candIdx: number, clip: object) => void}} [opts]
 * @returns {object[]} klip tanpa `_cluster` dan tanpa klip yang sumbernya hilang
 */
export function applyClusterPaths(clips, fallbackPathByCandidate, opts = {}) {
  const getFallback = (idx) => {
    if (fallbackPathByCandidate && typeof fallbackPathByCandidate.get === 'function') return fallbackPathByCandidate.get(idx);
    return fallbackPathByCandidate ? fallbackPathByCandidate[idx] : undefined;
  };
  return (Array.isArray(clips) ? clips : []).map((c) => {
    if (c?._cluster) {
      const { _cluster, ...rest } = c;
      return { ...rest, videoPath: _cluster.videoPath, sourceOffsetSec: _cluster.sourceOffsetSec };
    }
    const candIdx = c?.candidateIndex !== null && c?.candidateIndex !== undefined ? c.candidateIndex : 0;
    const vPath = getFallback(candIdx);
    if (!vPath) {
      if (typeof opts.onMissing === 'function') opts.onMissing(candIdx, c);
      return null;
    }
    return { ...c, videoPath: vPath, sourceOffsetSec: 0 };
  }).filter(Boolean);
}
