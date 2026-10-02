// ─────────────────────────────────────────────────────────────────────────────
// L5 (Blueprint alur baru) — POLA ADEGAN ZIGZAG ANTAR DUA SUMBER VIDEO
//
// Aturan langkah 5 alur baru: susunan adegan WAJIB bergantian sumber
// (V1 → V2 → V1 → ...) supaya hasil terasa dinamis & sulit terdeteksi sebagai
// daur ulang satu klip. Keputusannya (2b): zigzag berlaku di level WINDOW /
// kelompok klip, jadi pemanggil mengirim UNIT (window), bukan frame tunggal.
//
// Kontrak data (lihat plan Bagian B L5): setiap unit wajib membawa `sourceId`
// (atau key kustom via options.getKey) supaya bisa diselang-seling.
//
// Sifat fungsi: PURE (tanpa I/O), stabil, TIDAK PERNAH membuang item — sisa
// dari sumber yang lebih panjang di-tail-urutkan di akhir. Diuji di
// server/tests/clipOrdering.test.js.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bagi item ke dalam keranjang per-sumber dengan mempertahankan urutan kemunculan.
 * Urutan keranjang = berdasarkan sumber dengan item TERBANYAK lebih dulu (sumber
 * mayoritas jadi pembuka zigzag), lalu sumber berikutnya berdasar ukuran; seri
 * dipecah dengan urutan kemunculan pertama.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getKey
 * @returns {Array<{ key: string, bucket: T[] }>}
 */
function groupBuckets(items, getKey) {
  /** @type {Map<string, T[]>} */
  const map = new Map();
  for (const item of items) {
    const key = String(getKey(item) ?? '__nosource__');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries())
    .map(([key, bucket]) => ({ key, bucket }))
    // Mayoritas duluan; seri -> sumber yang muncul lebih awal menang.
    .sort((a, b) => (b.bucket.length - a.bucket.length));
}

/**
 * Susun ulang unit/window agar sumbernya bergantian (zigzag V1→V2→V1...).
 * Mengambil satu item dari tiap keranjang secara berputar (round-robin) sesuai
 * urutan besar-ke-kecil, melewati keranjang yang sudah kosong, sehingga sisa
 * sumber terpanjang otomatis menempel di ekor TANPA ada yang dibuang.
 * @template T
 * @param {T[]} items unit (mis. window klip) yang tiap elemennya punya sourceId
 * @param {{ getKey?: (item: T) => string }} [options]
 * @returns {T[]} susunan baru dengan panjang identik (tidak ada item hilang)
 */
export function interleaveBySource(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const getKey = options.getKey || ((item) => item?.sourceId);
  const buckets = groupBuckets(items, getKey);

  // Tanpa minimal dua sumber berbeda, zigzag tidak mungkin -> kembalikan apa adanya
  // (idempoten; memenuhi aturan "sisa tidak dibuang").
  if (buckets.length <= 1) return items.slice();

  const out = [];
  let remaining = items.length;
  while (remaining > 0) {
    for (const b of buckets) {
      if (b.bucket.length > 0) {
        out.push(b.bucket.shift());
        remaining--;
      }
    }
  }
  return out;
}

/**
 * Invarian L6 ("tidak ada klip dibuang"): total unit yang keluar dari penyusun
 * zigzag HARUS sama dengan yang masuk. Helper ini dipakai pipeline untuk
 * mencatat/menguji `segmentUtilization` alih-alih mengasumsikannya.
 * @param {number} inCount jumlah unit sebelum disusun
 * @param {number} outCount jumlah unit sesudah disusun
 * @returns {{ ok: boolean, dropped: number }}
 */
export function checkUtilization(inCount, outCount) {
  const dropped = Math.max(0, (Number(inCount) || 0) - (Number(outCount) || 0));
  return { ok: dropped === 0, dropped };
}
