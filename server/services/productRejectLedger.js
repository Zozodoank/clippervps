// ============================================================================
// LEDGER PRODUK DITOLAK (product_rejects.json)
//
// MASALAH NYATA (teramati 2026-10-04 di Termux): Auto Mode mengulang produk yang
// SUDAH ditolak filter konten 2 jam sebelumnya — "Cooking Use Han River Air Fryer"
// gugur di ai_vision pada 07:02 (auto_16a6680995), lalu dipilih lagi pada 09:10
// (auto_9612bd95a8) dan ditolak lagi pada 09:26. Riwayat job tampak "kosong" karena
// stage1Discovery menghapus job gagal tanpa media dari store (deleteJobFiles +
// activeJobs.delete + deletePersistedJob), jadi tidak ada memori kolektif: tiap run
// membakar 15-30 menit kuota Gemini/YouTube/GPU Kaggle untuk produk yang sama.
//
// SOLUSI: catatan persisten terpisah dari riwayat job. Hanya penolakan KONTEN yang
// masuk ledger. Kegagalan INFRASTRUKTUR (yt-dlp mati, IP block, kuota habis, Oracle
// tak terhubung, bug kode) TIDAK memblokir produk — salahnya bukan pada produknya.
//
// KEPUTUSAN DESAIN (dari code review 2026-10-04, direvisi putaran ke-2):
//  1. Klasifikasi INFRA SELALU MENANG: flag infra (isInfraError/isQuotaError/
//     ORACLE_UNAVAILABLE) dan pola teknis di pesan diuji SEBELUM flag konten
//     (isAiRejection), baru fallback marker pesan. Dua alasan: (a) pesan agregat
//     stage1Render memuat JUDUL PRODUK apa adanya, pencocokan kata bebas bisa salah
//     kelas; (b) flag isAiRejection pernah salah tempel di kegagalan download, dan
//     pesan agregat "belum memiliki cukup cuplikan ... Oracle unavailable"
//     berpunca infra tapi termarkir konten — satu outage :5050 bisa memblokir semua
//     produk 14 hari bila urutan ini terbalik.
//  2. Kunci identitas disimpan DUA: coarse (brand|type) dan fine (brand|type|model).
//     Model diekstraksi heuristik dari judul video dan bisa berbeda tiap run — kalau
//     kunci blokir memuat model, produk yang sama lolos terus. Kunci coarse TIDAK
//     dibentuk dari tipe saja: "air fryer" tanpa brand akan memblokir seluruh kategori.
//  3. Pencocokan judul LONGGAR wajib satu brand. Tanpa itu "Air Fryer Tanpa Minyak
//     Terbaik 2026 (Han River)" memblokir Philips yang tidak pernah divonis.
//  4. TIDAK ada seed otomatis di jalur BACA. Seed dikerjakan pemanggil (Auto Mode
//     saat run dimulai, lewat backfillFromJobs) dan ditandai di file (seededAt) agar
//     tahan restart. GET /api/auto/rejected-products murni membaca, tidak menulis.
//  5. Semua kegagalan internal modul ini TIDAK boleh menjatuhkan Auto Mode: store
//     korup dinormalisasi/diarsipkan, dan setiap fungsi mengembalikan "no-op" saat
//     bermasalah.
// ============================================================================
import fs from 'fs';
import path from 'path';
import { serverRoot } from '../utils/paths.js';

const LEDGER_FILE = path.join(serverRoot, 'product_rejects.json');
const DEFAULT_COOLDOWN_DAYS = 14;
const MAX_ENTRIES = 400;

/**
 * Vonis KONTEN = produk/videonya memang tidak layak jadi klip. Dicocokkan sebagai
 * substring pada alasan penolakan (err.rejectionReason bila ada, selain itu pesan).
 */
const CONTENT_REJECT_MARKERS = [
  'ai vision menolak',
  'tidak ada narasi voice-over',
  'belum memiliki cukup cuplikan',
  'cuplikan aksi demonstrasi bersih terlalu sedikit',
  'tidak memenuhi syarat',
  'sumber terpakai',
  'gagal merender video setelah',
  'watermark',
  'final_master_qc_failed',
  'durasi final video terlalu pendek',
  'subtitle terbakar',
  'teks overlay promosi',
  'bumper statis',
  'wajah manusia',
  'faceless',
  'slideshow statis',
  'tidak ditemukan cuplikan bersih',
  'frame kotor',
];

/**
 * Penanda kegagalan INFRASTRUKTUR — sengaja PERSIS (kata majemuk/pola teknis), bukan
 * kata tunggal bebas seperti "network"/"quota"/"oracle" yang bisa muncul di dalam
 * JUDUL PRODUK ("Camera Network 4G Lite") dan salah kelas jadi 'infra'.
 */
const INFRA_REJECT_PATTERNS = [
  /yt-dlp exited|gagal download|download (?:failed|terganggu)/i,
  /file is empty/i,
  /memblokir ip|membatasi ip|bot detection/i,
  /http\s*4\d\d|429|too many requests|sign in to confirm/i,
  /oracle (kaggle )?(tidak|offline|tak|unavailable|timeout)/i,
  /gatekeeper (?:unavailable|tidak tersedia|tidak bisa dihubungi|gagal merespons)/i, // classify historical service outages as infrastructure
  /kaggle.{0,30}(?:offline|timeout|unavailable|gagal|tidak terhubung)/i,
  /oracleunavailable/i,
  /rate.?limit|resource(?:\s+\w+){0,3}\s+exhausted|exhausted\s+quota|resource_exhausted|kuota (gemini|harian|habis)|limit kuota/i,
  /econnrefused|etimedout|enotfound|econnreset|socket hang up|network(?:box)? timeout/i,
  /no space left|disk (?:full| quota)/i,
  /\w+ is not defined/i,          // bug kode, bukan salah produk
  /cannot read propert|undefined is not/i,
];

function normKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Kunci identitas: coarse (brand+tipe) untuk pemblokiran, fine (+model) untuk audit.
 *
 * Aturan pengaman (review putaran ke-2): kunci coarse HANYA dibentuk bila brand DAN
 * tipe dua-duanya ada. Dua arah salah-block yang ditutup:
 *  - Tipe saja ("air fryer") akan memblokir SEMUA produk air fryer sedunia begitu satu
 *    merek divonis.
 *  - Brand saja ("han river") — yang justru sering terjadi di jalur backfill riwayat
 *    (job tersimpan sering tanpa productType) — akan memblokir SELURUH produk merek
 *    itu dari satu vonis konten untuk satu tipe.
 * Tanpa salah satunya, pemanggil tetap bisa terblokir lewat pencocokan judul
 * (keys.titles), bukan lewat kategori/merek menyeluruh.
 */
export function buildIdentityKeys({ brand = '', productType = '', model = '' } = {}) {
  const [brandKey, typeKey, modelKey] = [brand, productType, model].map(normKey);
  const coarse = brandKey && typeKey ? `${brandKey}|${typeKey}` : '';
  const fine = coarse && modelKey ? `${coarse}|${modelKey}` : '';
  return { coarse, fine };
}

/** Compat export lama (dipakai tes lama): kunci granular. */
export function buildIdentityKey(identity = {}) {
  const { coarse, fine } = buildIdentityKeys(identity);
  return fine || coarse;
}

export function isLedgerEnabled(env = process.env) {
  const raw = String(env.AUTO_PRODUCT_REJECT_LEDGER || '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export function getRejectCooldownDays(env = process.env) {
  const parsed = Number(env.AUTO_PRODUCT_REJECT_COOLDOWN_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COOLDOWN_DAYS;
}

/**
 * Klasifikasi kegagalan. Prioritas (review 2026-10-04): flag terstruktur > pola
 * teknis > marker konten. `err` boleh null (mis. saat backfill riwayat, yang hanya
 * punya string).
 * Return 'content' | 'infra' | 'unknown'.
 */
export function classifyFailure({ err = null, message = '', reason = '' } = {}) {
  const msg = String(message || err?.message || '');
  const reasonText = String(reason || err?.rejectionReason || '');

  // INFRA DIUJI DULU, selalu (review putaran ke-2): flag isAiRejection pernah salah
  // tempel di kegagalan download, dan pesan agregat berpunca infra memuat marker
  // konten. Salah kelas infra->content memblokir produk 14 hari tanpa salah produk.
  if (err?.isInfraError) return 'infra';
  if (err?.code === 'ORACLE_UNAVAILABLE' || err?.name === 'OracleUnavailableError') return 'infra';
  if (err?.isQuotaError || err?.isAllModelsQuotaExhausted) return 'infra';

  // Pola infrastruktur diuji pada PESAN penuh sebelum flag konten: polanya spesifik
  // (kata majemuk/pola teknis) sehingga judul produk tidak ikut kena.
  if (INFRA_REJECT_PATTERNS.some((re) => re.test(msg))) return 'infra';
  if (err?.isAiRejection === true) return 'content';

  const haystack = `${reasonText} ${msg}`.toLowerCase();
  if (CONTENT_REJECT_MARKERS.some((m) => haystack.includes(m))) return 'content';
  return 'unknown';
}

/** Compat dengan nama lama; hanya membaca pesan (dipakai untuk backfill). */
export function classifyFailureMessage(message = '') {
  return classifyFailure({ message });
}

function emptyStore() {
  return { version: 2, seededAt: null, lastUpdated: null, entries: {}, titles: {} };
}

// Lokasi file bisa dipindah lewat env supaya tes tidak menimpa ledger produksi.
function ledgerFile(env = process.env) {
  const custom = String(env.AUTO_PRODUCT_REJECT_FILE || '').trim();
  return custom ? path.resolve(custom) : LEDGER_FILE;
}

function normalizeStoreShape(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  store.version = Number(raw.version) || 2;
  store.seededAt = typeof raw.seededAt === 'string' ? raw.seededAt : null;
  store.lastUpdated = typeof raw.lastUpdated === 'string' ? raw.lastUpdated : null;
  store.entries = raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries) ? raw.entries : {};
  store.titles = raw.titles && typeof raw.titles === 'object' && !Array.isArray(raw.titles) ? raw.titles : {};
  return store;
}

function loadStore(env = process.env) {
  const file = ledgerFile(env);
  try {
    if (!fs.existsSync(file)) return emptyStore();
    return normalizeStoreShape(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    // File korup (proses dibunuh di tengah tulis) -> arsipkan, mulai dari kosong.
    // Tanpa langkah ini, satu byte rusak membuat ledger tidak pernah bisa ditulis lagi.
    try {
      const bad = `${file}.bad`;
      fs.renameSync(file, bad);
      console.warn(`[RejectLedger] product_rejects.json korup (${err.message}); dipindah ke ${path.basename(bad)} dan mulai dari kosong.`);
    } catch {
      console.warn('[RejectLedger] product_rejects.json korup dan tidak bisa diarsipkan; memakai store kosong.');
    }
    return emptyStore();
  }
}

function saveStore(store, env = process.env) {
  // atomic: tmp unik per proses+waktu lalu rename — writer paralel (API reset vs
  // worker) tidak saling menimpa. Bila tulis/rename gagal (mis. disk penuh di Termux)
  // tmp ikut dibuang supaya tidak menggantung selamanya di server/.
  const file = ledgerFile(env);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Buang entri yang sudah lewat cooldown supaya stats jujur dan file kecil. */
function pruneExpired(store, env = process.env, nowMs = Date.now()) {
  const windowMs = getRejectCooldownDays(env) * 24 * 60 * 60 * 1000;
  const liveIdentities = new Set();
  let removed = 0;
  for (const [key, entry] of Object.entries(store.entries || {})) {
    const age = nowMs - Date.parse(entry?.lastAt || 0);
    if (!Number.isFinite(age) || age > windowMs) {
      delete store.entries[key];
      removed++;
    } else {
      liveIdentities.add(key);
    }
  }
  for (const [tk, meta] of Object.entries(store.titles || {})) {
    if (!liveIdentities.has(meta?.identity)) delete store.titles[tk];
  }
  return removed;
}

function countExpired(store, env = process.env, nowMs = Date.now()) {
  const windowMs = getRejectCooldownDays(env) * 24 * 60 * 60 * 1000;
  return Object.values(store.entries || {}).filter((e) => {
    if (!e || e.aliasOf) return false; // satu produk = satu hitungan, bukan dua kunci
    const age = nowMs - Date.parse(e?.lastAt || 0);
    return !Number.isFinite(age) || age > windowMs;
  }).length;
}

/**
 * Label stage dari bentuk kegagalan, supaya laporan ke operator berisi 'ai_vision'
 * atau 'ai_vision' dan bukan string kosong (err.stage jarang tersedia).
 */
function inferStageLabel({ err = null, reason = '', message = '' } = {}) {
  const explicit = String(err?.stage || err?.step || '').trim();
  if (explicit) return explicit;
  const text = `${reason} ${message}`.toLowerCase();
  if (text.includes('narasi voice-over') || text.includes('whisper')) return 'whisper_gate';
  if (text.includes('watermark') || text.includes('wajah') || text.includes('faceless') || text.includes('subtitle')) return 'ai_vision';
  if (text.includes('ai vision') || text.includes('bukti visual') || text.includes('frame kotor')) return 'ai_vision';
  if (text.includes('master qc') || text.includes('final_master_qc') || text.includes('durasi final')) return 'final_qc';
  if (text.includes('cuplikan') || text.includes('klip')) return 'storyboard_sources';
  return '';
}

/**
 * Catat penolakan produk. Return { recorded, reason } supaya pemanggil bisa menulis
 * log yang jujur (mis. 'infra' = tidak di-blocklist). TIDAK pernah melempar.
 */
export function recordProductRejection({
  brand = '',
  productType = '',
  model = '',
  title = '',
  message = '',
  reason = '',
  stage = '',
  niche = '',
  err = null,
  autoRunId = '',
  jobId = '',
  env = process.env,
} = {}) {
  try {
    if (!isLedgerEnabled(env)) return { recorded: false, reason: 'flag_off' };

    const kind = classifyFailure({ err, message, reason });
    if (kind !== 'content') return { recorded: false, reason: kind };

    const { coarse, fine } = buildIdentityKeys({ brand, productType, model });
    const primary = coarse || fine || normKey(title);
    if (!primary) return { recorded: false, reason: 'no_identity' };

    const nowIso = new Date().toISOString();
    const store = loadStore(env);
    const cleanTitle = String(title || '').trim();
    const stageLabel = String(stage || inferStageLabel({ err, reason, message }) || '').trim();
    const titles = Array.from(new Set([
      ...(store.entries[primary]?.titles || []),
      ...(fine && fine !== primary ? (store.entries[fine]?.titles || []) : []),
      cleanTitle,
    ].filter(Boolean))).slice(-5);

    const payload = {
      identity: primary,
      brand: String(brand || '').trim(),
      productType: String(productType || '').trim(),
      model: String(model || '').trim(),
      niche: String(niche || '').trim(),
      titles,
      stages: Array.from(new Set([
        ...(store.entries[primary]?.stages || []),
        stageLabel,
      ].filter(Boolean))).slice(-5),
      lastReason: String(reason || message || '').slice(0, 220),
      lastAutoRunId: String(autoRunId || ''),
      lastJobId: String(jobId || ''),
      attempts: (store.entries[primary]?.attempts || 0) + 1,
      firstAt: store.entries[primary]?.firstAt || nowIso,
      lastAt: nowIso,
    };

    // Simpan di kunci coarse (dipakai untuk blokir) DAN kunci fine (audit granular),
    // sehingga run berikutnya lolos walau model terekstraksi berbeda. Entri fine
    // ditandai aliasOf supaya stats/recent tidak menghitung produk yang sama 2x.
    store.entries[primary] = payload;
    if (fine && fine !== primary) store.entries[fine] = { ...payload, identity: fine, aliasOf: primary };

    for (const t of titles) {
      const tk = normKey(t);
      // titles[tk] menyimpan brand TERNORMALISASI (normKey) supaya perbandingan saat
      // pencocokan longgar tidak patah hanya karena titik/seru di nama merek ("Mr. Clean!").
      if (tk) store.titles[tk] = { identity: primary, brand: normKey(payload.brand), lastAt: nowIso };
    }

    pruneExpired(store, env);
    const keys = Object.keys(store.entries);
    if (keys.length > MAX_ENTRIES) {
      const sorted = keys.sort((a, b) => String(store.entries[b]?.lastAt || '').localeCompare(String(store.entries[a]?.lastAt || '')));
      for (const drop of sorted.slice(MAX_ENTRIES)) delete store.entries[drop];
      for (const [tk, meta] of Object.entries(store.titles)) {
        if (!store.entries[meta?.identity]) delete store.titles[tk];
      }
    }

    store.lastUpdated = nowIso;
    saveStore(store, env);
    return { recorded: true, reason: 'content', entry: payload };
  } catch (err) {
    console.warn('[RejectLedger] Pencatatan dilewati (tidak menjatuhkan Auto Mode):', err.message);
    return { recorded: false, reason: 'store_error' };
  }
}

function lookupLive(store, identity, env, nowMs) {
  if (!identity) return null;
  const entry = store.entries?.[identity];
  if (!entry || !entry.lastAt) return null;
  const windowMs = getRejectCooldownDays(env) * 24 * 60 * 60 * 1000;
  const age = nowMs - Date.parse(entry.lastAt);
  if (!Number.isFinite(age) || age > windowMs) return null;
  return entry;
}

/**
 * Cari produk dalam cooldown. Cek: coarse -> fine -> judul persis -> judul longgar
 * (WAJIB brand sama). Return entri ledger bila masih diblokir, selain itu null.
 * Murni membaca — tidak menulis, tidak men-seed.
 */
export function findProductRejection({
  brand = '',
  productType = '',
  model = '',
  title = '',
  env = process.env,
  nowMs = Date.now(),
} = {}) {
  try {
    if (!isLedgerEnabled(env)) return null;
    const store = loadStore(env);
    const { coarse, fine } = buildIdentityKeys({ brand, productType, model });

    const hitCoarse = lookupLive(store, coarse, env, nowMs);
    if (hitCoarse) return hitCoarse;
    const hitFine = lookupLive(store, fine, env, nowMs);
    if (hitFine) return hitFine;

    const normTitle = normKey(title);
    if (!normTitle) return null;

    const exact = store.titles?.[normTitle];
    if (exact) {
      // Judul SAMA persis (setelah dinormalisasi) = konten video yang sama, jadi vonis
      // berlaku walau listingnya dibawa brand berbeda: yang ditolak filter adalah
      // footagenya, bukan label tokonya.
      const hit = lookupLive(store, exact.identity, env, nowMs);
      if (hit) return hit;
    }

    // Pencocokan longgar: 5 kata signifikan PERTAMA sebagai AWALAN (anchor), dan hanya di
    // dalam merek yang sama. Entri TANPA brand tidak pernah dipakai untuk cocok longgar:
    // tanpa kepastian merek, awalan judul ("air fryer tanpa minyak terbaik") gampang milik
    // dua produk berbeda dan akan memblokir produk yang tidak pernah divonis.
    const brandNorm = normKey(brand);
    const prefix = normTitle.split(' ').filter((w) => w.length > 2).slice(0, 5).join(' ');
    if (prefix.length < 10) return null;
    for (const [tk, meta] of Object.entries(store.titles || {})) {
      if (!tk.startsWith(prefix)) continue;
      if (brandNorm && (!meta.brand || meta.brand !== brandNorm)) continue;
      const hit = lookupLive(store, meta.identity, env, nowMs);
      if (hit) return hit;
    }
    return null;
  } catch (err) {
    console.warn('[RejectLedger] Pencarian dilewati:', err.message);
    return null;
  }
}

/**
 * Seed SEKALI dari riwayat job yang ada (dipanggil Auto Mode saat run dimulai,
 * BUKAN dari jalur baca). `jobs` berupa iterable/array objek job tersimpan.
 * Penanda `seededAt` ditulis di file supaya restart PM2 tidak mengulang seed.
 */
export function backfillFromJobs(jobs = [], { env = process.env, force = false } = {}) {
  try {
    if (!isLedgerEnabled(env)) return { seeded: 0, skipped: 'flag_off' };
    if (String(env.AUTO_PRODUCT_REJECT_BACKFILL || '').trim().toLowerCase() === '0') return { seeded: 0, skipped: 'flag_off' };
    const store = loadStore(env);
    if (store.seededAt && !force) return { seeded: 0, skipped: 'already_seeded' };

    const list = Array.isArray(jobs) ? jobs : Array.from(jobs || []);
    let seeded = 0;
    for (const job of list) {
      if (!job || job.stage !== 'error') continue;
      const message = String(job.lastError || job.error || '');
      if (!message) continue;
      const result = recordProductRejection({
        brand: job.brand,
        productType: job.productType || job.coreProductNoun,
        model: job.model,
        title: job.productTitle || job.cleanProductTitle || '',
        niche: job.niche || '',
        jobId: job.jobId || job.id || '',
        autoRunId: job.autoRunId || '',
        err: { isAiRejection: job.isAiRejection, rejectionReason: job.lastRejectionReason },
        message,
        env,
      });
      if (result.recorded) seeded++;
      if (seeded >= 30) break;
    }
    const after = loadStore(env);
    after.seededAt = new Date().toISOString();
    after.lastUpdated = after.seededAt;
    saveStore(after, env);
    if (seeded) {
      console.log(`[RejectLedger] Seed ${seeded} produk dari riwayat job gagal — tidak akan dipilih ulang dalam cooldown.`);
    }
    return { seeded, skipped: '' };
  } catch (err) {
    console.warn('[RejectLedger] Backfill dilewati:', err.message);
    return { seeded: 0, skipped: 'store_error' };
  }
}

export function getRejectLedgerStats({ env = process.env, limit = 15, nowMs = Date.now() } = {}) {
  try {
    const store = loadStore(env);
    // Entri alias (kunci fine) tidak dihitung sendiri — satu produk = satu baris
    // statistik, kalau tidak total/active over-report 2x dan recent tampil dobel.
    const entries = Object.values(store.entries || {})
      .filter((e) => e && !e.aliasOf)
      .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
    const windowMs = getRejectCooldownDays(env) * 24 * 60 * 60 * 1000;
    const active = entries.filter((e) => nowMs - Date.parse(e?.lastAt || 0) <= windowMs);
    return {
      enabled: isLedgerEnabled(env),
      cooldownDays: getRejectCooldownDays(env),
      total: entries.length,
      active: active.length,
      expired: countExpired(store, env, nowMs),
      seededAt: store.seededAt,
      lastUpdated: store.lastUpdated,
      // Hanya basename — endpoint publik tidak boleh membocorkan absolut path sistem.
      file: path.basename(ledgerFile(env)),
      recent: entries.slice(0, Math.min(Math.max(1, Number(limit) || 15), 100)).map((e) => ({
        identity: e.identity,
        brand: e.brand,
        productType: e.productType,
        model: e.model,
        titles: e.titles,
        stages: e.stages,
        attempts: e.attempts,
        lastReason: e.lastReason,
        lastJobId: e.lastJobId,
        lastAutoRunId: e.lastAutoRunId,
        firstAt: e.firstAt,
        lastAt: e.lastAt,
      })),
    };
  } catch (err) {
    console.warn('[RejectLedger] Stats dilewati:', err.message);
    return { enabled: false, cooldownDays: DEFAULT_COOLDOWN_DAYS, total: 0, active: 0, expired: 0, recent: [], error: err.message };
  }
}

export function clearRejectLedger({ env = process.env, force = false } = {}) {
  try {
    const store = emptyStore();
    // seededAt diisi SEKARANG supaya restart berikutnya tidak men-seed ulang riwayat
    // yang baru saja Anda buang. force=true memaksa seed boleh jalan lagi.
    store.seededAt = force ? null : new Date().toISOString();
    store.lastUpdated = new Date().toISOString();
    saveStore(store, env);
    return { cleared: true, reseedAllowed: Boolean(force), lastUpdated: store.lastUpdated };
  } catch (err) {
    console.warn('[RejectLedger] Reset gagal:', err.message);
    return { cleared: false, error: err.message };
  }
}

export const LEDGER_FILE_PATH = LEDGER_FILE;
