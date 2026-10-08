import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Ledger produk ditolak (productRejectLedger) — alasan keberadaannya: Auto Mode
// mengulang produk yang sudah divonis filter konten 2 jam sebelumnya, sementara
// riwayat job tampak kosong karena job gagal tanpa media ikut dihapus.
// Semua kasus menulis ke file TEMP (AUTO_PRODUCT_REJECT_FILE), tidak pernah ke
// server/product_rejects.json produksi.
const {
  classifyFailure,
  classifyFailureMessage,
  buildIdentityKeys,
  buildIdentityKey,
  recordProductRejection,
  findProductRejection,
  getRejectLedgerStats,
  clearRejectLedger,
  backfillFromJobs,
} = await import('../services/productRejectLedger.js');

const { detectForeignLanguageOrMarket } = await import('../services/discoveryService.js');

let tmpDir = '';
const ENV = () => ({ AUTO_PRODUCT_REJECT_FILE: path.join(tmpDir, 'rejects.json') });

// Pesan NYATA dari trace Termux 4 Okt 2026 (job auto_16a6680995 / auto_3a5eefffbe / auto_9f38b9f0a1).
const CONTENT_MSG = 'Semua kandidat video (telah di-stream 3 video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "Cooking Use Han River Air Fryer": AI Vision menolak seluruh bukti visual';
const INFRA_MSG = 'Semua kandidat video (telah di-stream 1 video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "HARGA SOKANY HAND BLENDER": yt-dlp exited with code 1 or file is empty.';
const GATEKEEPER_MSG = 'Ditolak AI Gatekeeper: Video dipenuhi teks/watermark burned-in';

const HAN_RIVER = {
  brand: 'Han River',
  productType: 'Air Fryer',
  model: 'HR-AF22',
  title: 'Cooking Use Han River Air Fryer | Chicken Crispy Without Deep Fried',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-ledger-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('classifyFailure — prioritas flag terstruktur', () => {
  it('vonis konten (AI Vision / cuplikan kurang) = content', () => {
    expect(classifyFailureMessage(CONTENT_MSG)).toBe('content');
    expect(classifyFailureMessage(GATEKEEPER_MSG)).toBe('content');
    expect(classifyFailureMessage('Tidak ada narasi voice-over.')).toBe('content');
    expect(classifyFailureMessage('Durasi final video terlalu pendek (19.3 detik, minimal 20 detik).')).toBe('content');
  });

  it('kegagalan infrastruktur (yt-dlp / oracle / kuota / IP block / bug kode) = infra', () => {
    // Marker infra menang walau kalimat pembungkusnya berbunyi "belum memiliki cukup cuplikan":
    // penyebab sebenarnya unduhan, bukan kontennya.
    expect(classifyFailureMessage(INFRA_MSG)).toBe('infra');
    expect(classifyFailureMessage('Oracle Kaggle tidak terhubung')).toBe('infra');
    expect(classifyFailureMessage('YouTube membatasi IP: HTTP 429 too many requests')).toBe('infra');
    expect(classifyFailureMessage('Resource has exhausted quota for gemini')).toBe('infra');
    expect(classifyFailureMessage('currentCandIdx is not defined')).toBe('infra');
  });

  it('kosong / tidak dikenal = unknown (tidak pernah memblokir)', () => {
    expect(classifyFailureMessage('')).toBe('unknown');
    expect(classifyFailureMessage('sesuatu yang aneh terjadi')).toBe('unknown');
  });

  it('flag err.isAiRejection mengalahkan pesan yang kebetulan memuat kata infra', () => {
    // Pesan agregat memuat JUDUL PRODUK. Judul "Camera Network 4G Lite" dulu pernah
    // membuat pola bebas 'network' mengklasifikasi vonis konten sebagai infra.
    const err = { isAiRejection: true, message: 'Frame kotor: Video "Camera Network Kit 4G" dipenuhi watermark' };
    expect(classifyFailure({ err, message: err.message })).toBe('content');
  });

  it('flag infra (OracleUnavailableError / kuota / isInfraError) mengalahkan marker konten di reason', () => {
    expect(classifyFailure({ err: { code: 'ORACLE_UNAVAILABLE', message: 'Oracle tidak mengklaim batch' } })).toBe('infra');
    expect(classifyFailure({ err: { isQuotaError: true, message: 'Frame kotor: tidak ada narasi voice-over' } })).toBe('infra');
    expect(classifyFailure({ err: { isInfraError: true, message: 'ffmpeg process crash' } })).toBe('infra');
  });

  it('outage Gatekeeper :5050 = infra walau kalimat pembungkusnya berbunyi "cukup cuplikan"', () => {
    // Review putaran ke-2: pesan agregat fallback memakai marker konten ("belum memiliki
    // cukup cuplikan") padahal penyebabnya gerbang lokal mati — TIDAK boleh memblokir
    // semua produk yang dicoba selama outage.
    expect(classifyFailureMessage('Semua kandidat video (telah di-stream 1 video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "X": Gatekeeper unavailable')).toBe('infra');
  });

  it('pola infra eksplisit mengalahkan isAiRejection yang salah tempel (salah kelas infra->content mahal)', () => {
    // Dulu kegagalan download ikut ditandai isAiRejection. Sejak klasifikasi memprioritaskan
    // pola infra, produk tidak blokir 14 hari hanya karena koneksi putus.
    const err = Object.assign(new Error('Gagal download preview 15s'), { isAiRejection: true });
    expect(classifyFailure({ err, message: err.message })).toBe('infra');
  });

  it('err null (mis. backfill riwayat yang hanya punya string) tetap terklasifikasi', () => {
    expect(classifyFailure({ err: null, message: GATEKEEPER_MSG })).toBe('content');
  });
});

describe('buildIdentityKeys — kunci coarse tidak boleh berisi tipe saja', () => {
  it('brand+tipe = coarse; +model = fine untuk audit granular (dinormalisasi seperti kunci lain)', () => {
    expect(buildIdentityKeys(HAN_RIVER)).toEqual({ coarse: 'han river|air fryer', fine: 'han river|air fryer|hr af22' });
    expect(buildIdentityKey(HAN_RIVER)).toBe('han river|air fryer|hr af22');
  });

  it('tanpa brand TIDAK ada kunci coarse (tipe saja akan memblokir seluruh kategori)', () => {
    expect(buildIdentityKeys({ productType: 'Air Fryer', model: 'X' })).toEqual({ coarse: '', fine: '' });
  });

  it('tanpa tipe TIDAK ada coarse brand-only (satu vonis jangan memblokir seluruh merek)', () => {
    // Jalur backfill sering kehilangan productType — di sana coarse brand-only dulu
    // memblokir SEMUA produk Han River dari satu vonis air fryer.
    expect(buildIdentityKeys({ brand: 'Han River', model: 'HR-AF22' })).toEqual({ coarse: '', fine: '' });
  });

  it('tanpa model, fine kosong (satu kunci saja, tidak dobel)', () => {
    expect(buildIdentityKeys({ brand: 'Han River', productType: 'Air Fryer' })).toEqual({ coarse: 'han river|air fryer', fine: '' });
  });
});

describe('recordProductRejection + findProductRejection', () => {
  it('mencatat vonis konten lalu menahannya lewat lookup brand+tipe', () => {
    const r = recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, stage: 'ai_vision', jobId: 'auto_16a6680995', env: ENV() });
    expect(r.recorded).toBe(true);
    expect(r.entry.attempts).toBe(1);

    const hit = findProductRejection({ ...HAN_RIVER, env: ENV() });
    expect(hit).not.toBeNull();
    expect(hit.identity).toBe('han river|air fryer');
    expect(hit.stages).toContain('ai_vision');
  });

  it('model yang terekstraksi berbeda di run berikutnya tetap tertahan (kunci coarse)', () => {
    recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env: ENV() });
    const hit = findProductRejection({
      brand: 'Han River',
      productType: 'Air Fryer',
      model: 'HR-AF22-BARU',
      title: 'REVIEW HAN RIVER AIR FRYER 5 LITER',
      env: ENV(),
    });
    expect(hit).not.toBeNull();
  });

  it('TIDAK mencatat kegagalan infrastruktur', () => {
    const r = recordProductRejection({ ...HAN_RIVER, message: INFRA_MSG, env: ENV() });
    expect(r).toMatchObject({ recorded: false, reason: 'infra' });
    expect(findProductRejection({ ...HAN_RIVER, env: ENV() })).toBeNull();
  });

  it('klasifikasi: pola infra pada pesan agregat menang; isAiRejection menang atas kata kebetulan di judul', () => {
    // (a) yt-dlp di PESAN AGREGAT = penyebab nyata -> bukan vonis produk, jangan tercatat.
    const rInfra = recordProductRejection({
      ...HAN_RIVER,
      err: { isAiRejection: true, rejectionReason: 'Video dipenuhi teks/watermark burned-in' },
      message: 'Gagal: yt-dlp exited dengan code 1',
      env: ENV(),
    });
    expect(rInfra).toMatchObject({ recorded: false, reason: 'infra' });
    // (b) sebaliknya, kata bebas di JUDUL ("Camera Network 4G") tidak boleh membalik
    // vonis konten ber-flag isAiRejection menjadi infra.
    const errContent = { isAiRejection: true, message: 'Frame kotor: Video "Camera Network Kit 4G" dipenuhi watermark' };
    const rContent = recordProductRejection({ ...HAN_RIVER, err: errContent, message: errContent.message, env: ENV() });
    expect(rContent.recorded).toBe(true);
    expect(findProductRejection({ ...HAN_RIVER, env: ENV() })).not.toBeNull();
  });

  it('flag AUTO_PRODUCT_REJECT_LEDGER=0 menonaktifkan catat dan cek', () => {
    const env = { ...ENV(), AUTO_PRODUCT_REJECT_LEDGER: '0' };
    expect(recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env })).toMatchObject({ recorded: false, reason: 'flag_off' });
    expect(findProductRejection({ ...HAN_RIVER, env })).toBeNull();
  });

  it('judul mirip (5 kata signifikan) tetap tertahan walau brand/tipe tidak dikirim', () => {
    recordProductRejection({ ...HAN_RIVER, message: GATEKEEPER_MSG, env: ENV() });
    const nearSameTitle = findProductRejection({
      title: 'Cooking Use Han River Air Fryer | Chicken Crispy without deep fried 2026',
      env: ENV(),
    });
    expect(nearSameTitle).not.toBeNull();
  });

  it('produk berbeda tidak kena getah', () => {
    recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env: ENV() });
    expect(findProductRejection({ brand: 'Maspion', productType: 'Kukusan', model: 'X1', title: 'UNBOXING STEAMER MURAAAHH BRONITA MASPION', env: ENV() })).toBeNull();
  });

  it('awalan judul sama tapi brand berbeda TIDAK memblokir (guard merek)', () => {
    recordProductRejection({
      ...HAN_RIVER,
      title: 'Air Fryer Tanpa Minyak Terbaik 2026 Han River Review',
      message: CONTENT_MSG,
      env: ENV(),
    });
    const otherBrand = findProductRejection({
      brand: 'Philips',
      productType: 'Air Fryer',
      title: 'Air Fryer Tanpa Minyak Terbaik 2026 Philips Review Jujur',
      env: ENV(),
    });
    expect(otherBrand).toBeNull();
  });

  it('kedua kali mencatat menaikkan attempts (satu produk, bukan entri ganda)', () => {
    recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env: ENV() });
    recordProductRejection({ ...HAN_RIVER, message: GATEKEEPER_MSG, env: ENV() });
    const stats = getRejectLedgerStats({ env: ENV() });
    // coarse + fine disimpan 2 kunci utk 1 produk, tapi entri fine ditandai aliasOf:
    // stats/report harus melihat SATU produk, bukan dua (review putaran ke-2).
    expect(stats.total).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.recent).toHaveLength(1);
    expect(stats.recent[0].identity).toBe('han river|air fryer');
    expect(stats.recent[0].attempts).toBe(2);
  });

  it('keluar cooldown tidak lagi diblokir', () => {
    recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env: ENV() });
    const env30 = { ...ENV(), AUTO_PRODUCT_REJECT_COOLDOWN_DAYS: '14' };
    const muchLater = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(findProductRejection({ ...HAN_RIVER, env: env30, nowMs: muchLater })).toBeNull();
  });

  it('file ledger korup diarsipkan dan Auto Mode tidak dijatuhkan', () => {
    const env = ENV();
    fs.writeFileSync(path.join(tmpDir, 'rejects.json'), '{ bukan json', 'utf-8');
    expect(findProductRejection({ ...HAN_RIVER, env })).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'rejects.json.bad'))).toBe(true);
    // Setelah dinormalisasi, pencatatan berikutnya berjalan lagi.
    expect(recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env }).recorded).toBe(true);
  });

  it('clearRejectLedger mengosongkan ledger dan mengunci seed agar riwayat lama tidak masuk lagi', () => {
    recordProductRejection({ ...HAN_RIVER, message: CONTENT_MSG, env: ENV() });
    const cleared = clearRejectLedger({ env: ENV() });
    expect(cleared.cleared).toBe(true);
    expect(getRejectLedgerStats({ env: ENV() }).total).toBe(0);
    expect(backfillFromJobs([{ jobId: 'auto_x', stage: 'error', ...HAN_RIVER, lastError: CONTENT_MSG }], { env: ENV() }))
      .toMatchObject({ seeded: 0, skipped: 'already_seeded' });
  });
});

describe('backfillFromJobs — seed sekali dari riwayat job (SQLite, dibaca pemanggil)', () => {
  const HISTORY = [
    { jobId: 'auto_a', stage: 'error', brand: 'Han River', productType: 'Air Fryer', model: 'HR-AF22', productTitle: HAN_RIVER.title, lastError: CONTENT_MSG },
    { jobId: 'auto_b', stage: 'error', brand: 'Sokany', productType: 'Hand Blender', productTitle: 'HARGA SOKANY HAND BLENDER 4 IN 1', lastError: INFRA_MSG },
    { jobId: 'auto_c', stage: 'completed', brand: 'Philips', productType: 'Airfryer', productTitle: 'Bikin Ikan Bakar SEJUICY ITU Pakai Philips Airfryer', lastError: '' },
  ];

  it('hanya men-seed job beralasan konten, dan bisa menerima iterable (cursor SQLite)', () => {
    const result = backfillFromJobs(HISTORY, { env: ENV() });
    expect(result.seeded).toBe(1);
    const stats = getRejectLedgerStats({ env: ENV() });
    expect(stats.active).toBe(1);
    expect(stats.recent[0].identity).toContain('han river');
    expect(stats.seededAt).toBeTruthy();

    // Bentuk kedua: generator (pemanggil produksi mengumpulkan dari activeJobs.entries()).
    const env2 = { AUTO_PRODUCT_REJECT_FILE: path.join(tmpDir, 'rejects2.json') };
    const asGenerator = (function* () { for (const j of HISTORY) yield j; })();
    expect(backfillFromJobs(asGenerator, { env: env2 }).seeded).toBe(1);
  });

  it('seed hanya sekali - dipanggil lagi tanpa force tidak menambah entri', () => {
    expect(backfillFromJobs(HISTORY, { env: ENV() }).seeded).toBe(1);
    expect(backfillFromJobs(HISTORY, { env: ENV() })).toMatchObject({ seeded: 0, skipped: 'already_seeded' });
    expect(backfillFromJobs(HISTORY, { env: ENV(), force: true }).seeded).toBe(1);
  });

  it('AUTO_PRODUCT_REJECT_BACKFILL=0 melewati seed', () => {
    const env = { ...ENV(), AUTO_PRODUCT_REJECT_BACKFILL: '0' };
    expect(backfillFromJobs(HISTORY, { env })).toMatchObject({ seeded: 0, skipped: 'flag_off' });
    expect(getRejectLedgerStats({ env }).total).toBe(0);
  });

  it('tanpa identitas (brand+tipe kosong) tetap tercatat lewat judul, bukan ditolak', () => {
    const r = recordProductRejection({ title: 'Video Tanpa Merk Diketahui', message: GATEKEEPER_MSG, env: ENV() });
    expect(r.recorded).toBe(true);
    expect(findProductRejection({ title: 'Video Tanpa Merk Diketahui', env: ENV() })).not.toBeNull();
  });
});

describe('detectForeignLanguageOrMarket (gerbang bahasa saat riset produk)', () => {
  it('judul Vietnam -> vietnamese (bukan sekadar lolos karena skrip Latin)', () => {
    expect(detectForeignLanguageOrMarket('Nồi chiên không dầu G5 2.5L # Xiaomi LIVEN G-5 Intelligent Oil-free Air Fryer 2.5L')).toBe('vietnamese');
  });

  it('pasar asing eksplisit -> foreign_market', () => {
    expect(detectForeignLanguageOrMarket('HARGA SOKANY HAND BLENDER 4 IN 1 DI BANGLADESH')).toBe('foreign_market');
  });

  it('Indonesia/Inggris biasa TIDAK kena', () => {
    expect(detectForeignLanguageOrMarket('Review Air Fryer Philips Harga Murah 2 Jutaan')).toBeNull();
    expect(detectForeignLanguageOrMarket('Crème Brûlée Maker Machine Test')).toBeNull();
    expect(detectForeignLanguageOrMarket('unboxing诱导')).toBeNull(); // Hanzi ditangani gerbang lain, bukan ini
  });

  it('teks kosong aman', () => {
    expect(detectForeignLanguageOrMarket('')).toBeNull();
  });
});
