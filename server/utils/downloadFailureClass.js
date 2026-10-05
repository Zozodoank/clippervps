// Klasifikasi penyebab kegagalan download YouTube — MURNI (tanpa spawn/IO) agar bisa
// diunit-test. Dipakai downloader.js setelah rotasi profil habis.
//
// Regresi Termux 2026-10-05 (job kk5h0ug1): attempt-1 section terpotong 1.4s, retry
// profil 2-4 gagal karena dinding format/PoToken, dan `lastDownloadError` yang hanya
// menyimpan penyebab TERAKHIR membuat job melaporkan "Video sumber tidak memiliki
// format HD" — padahal HD-nya terbukti ada sedetik sebelumnya (preview 15s terunduh).
// Aturan main: penyebab PERTAMA yang berkelas keras (truncation/bot-block) menang atas
// gejala turunan; urutan pengecekan di bawah mengunci kebijakan itu.

const BOT_MARKERS = ['sign in to confirm', 'automated queries', 'http error 429', 'status: 429'];
const NOHD_MARKERS = ['requested format is not available', 'only images are available', 'standar hd 720p'];
const TRUNCATION_RE = /terpotong|terlalu kecil/i;

export const BOT_BLOCK_MESSAGE =
  `YouTube membatasi/memblokir IP Anda sementara (Bot Detection/HTTP 429).\n` +
  `Solusi cepat:\n` +
  `1. Aktifkan Mode Pesawat (Airplane Mode) di HP selama 5 detik lalu matikan lagi untuk mendapatkan IP operator seluler baru.\n` +
  `2. Atau letakkan file cookies.txt dari browser YouTube ke folder project.`;

/**
 * @param {string[]} causes daftar penyebab kegagalan per attempt (urut kronologis; entri kosong diabaikan)
 * @param {{qualityLabel?: string}} [opts]
 * @returns {{kind: 'botBlock'|'truncated'|'noHd'|'generic', message: string, isInfraError?: boolean}}
 *   'truncated' = file section terpotong/terlalu kecil — INFRA (bukan salah konten produk),
 *   wajib menang atas 'noHd' yang biasanya gejala turunan dari retry profil berikutnya.
 */
export function classifyDownloadFailure(causes, opts = {}) {
  const list = (Array.isArray(causes) ? causes : []).map((c) => String(c || '').trim()).filter(Boolean);
  const joined = list.join('\n').toLowerCase();
  const qualityLabel = opts.qualityLabel || '1080p Full HD';

  if (BOT_MARKERS.some((m) => joined.includes(m))) {
    return { kind: 'botBlock', message: BOT_BLOCK_MESSAGE, cause: list.find((c) => BOT_MARKERS.some((m) => c.toLowerCase().includes(m))) || '' };
  }

  const truncation = list.find((c) => TRUNCATION_RE.test(c));
  if (truncation) {
    return {
      kind: 'truncated',
      isInfraError: true,
      message: `Download per-section terpotong berulang: ${truncation}. Truncation bersifat stream/GOP (bukan client profile), sehingga rotasi profil tidak memperbaikinya.`,
      cause: truncation,
    };
  }

  if (NOHD_MARKERS.some((m) => joined.includes(m))) {
    return {
      kind: 'noHd',
      message: 'Video sumber tidak memiliki format HD 720p/1080p yang valid di YouTube (hanya tersedia resolusi rendah).',
      cause: list.find((c) => NOHD_MARKERS.some((m) => c.toLowerCase().includes(m))) || '',
    };
  }

  const last = list[list.length - 1] || 'tidak diketahui';
  return { kind: 'generic', message: `Download video gagal (${qualityLabel}): ${last.slice(-400)}`, cause: last };
}
