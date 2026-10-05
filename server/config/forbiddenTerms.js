// ============================================================================
// SATU SUMBER KEBENARAN UNTUK KATA KUNCI TERLARANG (TUTORIAL / DIY / SERVIS)
// ============================================================================
// Alasan modul ini ada (bug lapangan 30 Sep 2026, job auto_3dd085b354):
// daftar kata terlarang selama ini ditulis ULANG di 7 tempat berbeda
// (discoveryService, downloader, videoFilterService, prompt aiService) dengan
// isi yang tidak identik, sementara generator query justru MENYUNTIKKAN kata
// terlarang itu sendiri ("... demo cara pakai"). Akibatnya:
//   1. Query pencarian ikut membawa kata terlarang -> YouTube/Bing menyajikan
//      video tutorial/servis -> filter judul menolak kandidat -> 0 hasil, kuota
//      dan token terbuang, lalu Rescue Pipeline memaksa klip asal-asalan.
//   2. Operator negatif pencarian hanya memuat `-repair` (Inggris) tanpa
//      `-servis -perbaikan -matot`, dan query bermotif "review/unboxing/demo"
//      keluar TANPA operator negatif sama sekali - jadi mesin telusur tetap
//      menampilkan listing jasa servis di niche non-gadget.
// Semua variasi itu disatukan di sini supaya tidak bisa saling bertentangan.
// Dua kelas pelanggaran dipisah karena konsekuensinya berbeda:
//   - REPAIR : selalu fatal (listing JASA / barang rusak, bukan produk fisik).
//   - TUTORIAL: fatal untuk query; filter judul longgar masih boleh mentolelir
//     kata "cara" pada judul peragaan alat fisik (dipertahankan di pemanggil).
// ============================================================================

// Penanda jasa servis, barang rusak, atau bongkar-pasang. Berlaku SEMUA niche.
export const REPAIR_TERMS = [
  // 'fix'/'fixes' (Inggris) dulu TIDAK ada di daftar ini, sehingga judul produk
  // berbahasa Inggris seperti "How to Fix Magicom Rice Not Cooked" lolos sebagai
  // PRODUK (hanya kena kelas tutorial via 'how to', bukan repair). Bug lapangan
  // auto_41fb4b59: job memilih listing reparasi lalu mati no_verdict. Kini kata
  // 'fix' ikut dibuang dari query (stripForbiddenTerms), jadi operator negatif, dan
  // menolak judul produk/kandidat reparasi di semua konsumen satu-sumber ini.
  'servis', 'service', 'reparasi', 'repair', 'fix', 'fixes',
  'perbaikan', 'memperbaiki', 'perbaiki', 'rusak', 'kerusakan',
  'mati total', 'matot', 'mati', 'korslet', 'konslet', 'gelek',
  'bongkar', 'membongkar', 'disassembly', 'teardown', 'turun mesin',
  'ganti', 'mengganti', 'pergantian', 'penggantian',
  'benerin', 'error', 'spare part', 'sparepart', 'jas servis',
];

// Jargon reparasi tingkat lanjut. HANYA dipakai pada niche gadget karena di
// niche lain kata-kata ini bisa menjadi nama produk sah (mis. "solder listrik").
export const REPAIR_JARGON_TERMS = [
  'ganti lcd', 'lcd pecah', 'layar pecah', 'ganti baterai', 'ganti sparepart',
  'bypass', 'bootloop', 'skematik', 'jalur pcb', 'solder', 'soldering',
  'flashing', 'unlock', 'ic power', 'fpc', 'kabel flexible', 'tromol', 'bengkel',
];

// Penanda konten tutorial / DIY / bikin dari nol (bukan peragaan produk jadi).
export const TUTORIAL_TERMS = [
  'cara', 'tutorial', 'diy', 'do it yourself', 'how to', 'howto',
  'cara membuat', 'cara bikin', 'cara memakai', 'cara pakai', 'cara mengoperasikan',
  'langkah langkah', 'step by step', 'kerajinan', 'prakarya', 'daur ulang',
  'vlog', 'daily', 'daily vlog',
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Frasa multi-kata ditaruh paling depan pada alternation agar dicocokkan utuh
// ("mati total" tidak terpotong jadi hanya "mati").
const toAlternation = (terms) => [...terms]
  .filter((t) => String(t || '').trim())
  .sort((a, b) => String(b).trim().split(/\s+/).length - String(a).trim().split(/\s+/).length)
  .map(escapeRe)
  .join('|');

const makeRe = (terms, flags = 'i') => new RegExp(`\\b(?:${toAlternation(terms)})\\b`, flags);

const REPAIR_RE = makeRe(REPAIR_TERMS);
const REPAIR_ALL_RE = makeRe([...REPAIR_TERMS, ...REPAIR_JARGON_TERMS]);
const TUTORIAL_RE = makeRe(TUTORIAL_TERMS);
// Versi global untuk strip: satu panggilan .replace() membersihkan SEMUA
// kemunculan, bukan hanya yang pertama. Lookbehind `(?<![-\w])` melindungi
// operator negatif yang sudah benar di query (mis. "-servis"): yang dibuang
// hanyalah kata telanjang, bukan bagian dari operator mesin telusur.
const makeStripRe = (terms) => new RegExp(`(?<![-\\w])(?:${toAlternation(terms)})\\b`, 'gi');
const REPAIR_STRIP_RE = makeStripRe([...REPAIR_TERMS, ...REPAIR_JARGON_TERMS]);
const TUTORIAL_STRIP_RE = makeStripRe(TUTORIAL_TERMS);

// "after-sales service" / "purna jual service" = garansi produk, BUKAN jasa
// servis. Tanpa pengecualian ini listing resmi ikut tertolak.
const SAFE_SERVICE_RE = /\b(?:after\s*-?\s*sales|purna\s*jual|customer\s*care|layanan\s*pelanggan)\s+service\b/gi;

/**
 * @param {string} text
 * @param {{ includeGadgetJargon?: boolean }} [options] jargon hanya untuk niche gadget
 * @returns {boolean} true bila teks memuat penanda servis / barang rusak
 */
export function hasRepairIntent(text = '', options = {}) {
  const value = String(text || '').replace(SAFE_SERVICE_RE, '');
  const re = options.includeGadgetJargon ? REPAIR_ALL_RE : REPAIR_RE;
  return re.test(value);
}

/** @returns {boolean} true bila teks memuat penanda tutorial / DIY */
export function hasTutorialIntent(text = '') {
  return TUTORIAL_RE.test(String(text || ''));
}

// Daftar KUAT untuk teks panjang (deskripsi video). Sengaja lebih sempit dari
// REPAIR_TERMS: di judul, kata "service"/"ganti"/"bongkar" sudah cukup jadi
// bukti; di deskripsi panjang kata-kata itu sering muncul sebagai keterangan
// awam ("mudah ganti baterai", "after sales service") sehingga memicu
// false-positive yang membuang footage bagus.
const REPAIR_DESC_RE = makeRe([
  'servis', 'jasa servis', 'tempat servis', 'reparasi', 'perbaikan', 'memperbaiki',
  'rusak', 'kerusakan', 'mati total', 'matot', 'korslet', 'konslet',
  'bongkar mesin', 'membongkar', 'disassembly', 'teardown', 'turun mesin',
  'ganti lcd', 'layar pecah', 'bengkel',
]);

/** @returns {boolean} true bila teks panjang (deskripsi) memuat indikasi servis yang kuat */
export function hasStrongRepairIntent(text = '') {
  return REPAIR_DESC_RE.test(String(text || '').replace(SAFE_SERVICE_RE, ''));
}

/** Pola judul gabungan (repair + tutorial) untuk penyaring yang ingin satu gerbang. */
export function forbiddenTitlePattern(options = {}) {
  const terms = options.includeGadgetJargon
    ? [...REPAIR_TERMS, ...REPAIR_JARGON_TERMS, ...TUTORIAL_TERMS]
    : [...REPAIR_TERMS, ...TUTORIAL_TERMS];
  return makeRe(terms);
}

/** Query pencarian TIDAK BOLEH memuat kata terlarang dari kelas mana pun. */
export function isForbiddenSearchQuery(text = '') {
  return hasRepairIntent(text) || hasTutorialIntent(text);
}

/** Buang semua kata terlarang dari query, rapikan sisa spasi dan tanda baca. */
export function stripForbiddenTerms(text = '') {
  return String(text || '')
    .replace(SAFE_SERVICE_RE, ' ')
    .replace(REPAIR_STRIP_RE, ' ')
    .replace(TUTORIAL_STRIP_RE, ' ')
    .replace(/[,–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const asNegativeOperator = (term) => {
  const clean = String(term).trim().toLowerCase();
  return clean.includes(' ') ? `-"${clean}"` : `-${clean}`;
};

/** Semua operator negatif dari daftar kanonik (untuk kebutuhan audit/pencarian). */
export function forbiddenNegativeOperators(options = {}) {
  const terms = options.includeGadgetJargon
    ? [...REPAIR_TERMS, ...REPAIR_JARGON_TERMS, ...TUTORIAL_TERMS]
    : [...REPAIR_TERMS, ...TUTORIAL_TERMS];
  return [...new Set(terms.map(asNegativeOperator))];
}

/**
 * Operator negatif prioritas yang dikirim ke mesin telusur. Cukup istilah induk:
 * `-servis` sudah membuang seluruh hasil reparasi, termasuk turunannya.
 */
export function coreNegativeOperators() {
  // Urutan = prioritas. Tiga teratas wajib ikut bahkan untuk query bermotif
  // review/unboxing (paling sering dipakai) karena itulah kata yang menghasilkan
  // listing servis/tutorial di hasil pencarian.
  return [
    '-servis', '-cara', '-tutorial', '-diy', '-reparasi', '-repair', '-fix', '-perbaikan',
    '-rusak', '-matot', '-bongkar', '-"mati total"', '-service',
    '-vlog', '-"mini vlog"', '-wajah', '-host'
  ];
}
