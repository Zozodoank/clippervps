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
