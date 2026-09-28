/**
 * Batas durasi kandidat video YouTube (detik) — dipakai oleh gerbang pencarian
 * (discoveryService) dan gerbang kepatuhan metadata (videoFilterService).
 *
 * Kenapa dinaikkan ke 5 menit: di AUTO MODE, video pendek (< 5 mnt, umumnya
 * YouTube Shorts) terbukti sedikit frame, sumber beresolusi rendah (±270p), dan
 * memicu adegan berulang pada output — tidak disukai algoritma Reels. Video
 * panjang punya footage peragaan produk yang lebih kaya & variatif (kualitas
 * manual mode yang terbukti bagus). Override via env tanpa ubah kode.
 */

// Minimal durasi. Default 300 detik (5 menit). Set 0 untuk mematikan gerbang minimum.
export function getMinVideoDurationSec() {
  const v = parseInt(process.env.MIN_VIDEO_DURATION_SEC, 10);
  return Number.isFinite(v) && v >= 0 ? v : 300;
}

// Maksimal durasi. Default 900 detik (15 menit).
export function getMaxVideoDurationSec() {
  const v = parseInt(process.env.MAX_VIDEO_DURATION_SEC, 10);
  return Number.isFinite(v) && v > 0 ? v : 900;
}
