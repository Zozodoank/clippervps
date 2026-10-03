// ============================================================================
// AI USAGE - uji END-TO-END lewat fungsi sisi Gemini yang SESUNGGUHNYA di-instrumen.
//
// aiUsage.test.js mengunci helper + scan statis teks. File ini menutup celah yang
// tersisa: "apakah recordGeminiCall benar-benar ada di jalur kode fungsi aslinya,
// dan apakah jobId pipeline (AsyncLocalStorage) sampai ke baris DB?" Kalau penempatan
// salah (mis. setelah `return`, atau di cabang yang tidak pernah dilewati), hanya uji
// semacam ini yang tahu.
//
// SDK Gemini dan bandwidthTracker di-mock: tidak ada jaringan, tidak ada API key,
// tidak ada file statistik yang tersentuh.
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(os.tmpdir(), `jobs-aiusage-sites-${process.pid}-${Date.now()}.db`);
process.env.JOBS_DB_PATH = testDbPath;

// Satu-satunya titik yang menentukan apa yang "dikatakan" model pada panggilan ini.
const h = vi.hoisted(() => ({ behavior: null }));

vi.mock('@google/generative-ai', () => {
  class FakeGoogleGenerativeAI {
    constructor() {}
    getGenerativeModel(cfg = {}) {
      return {
        generateContent: async (parts) => h.behavior(parts, cfg),
        _model: cfg.model,
      };
    }
  }
  return { GoogleGenerativeAI: FakeGoogleGenerativeAI };
});

// trackBandwidth menulis server/bandwidth_stats.json - bukan urusan uji ini.
vi.mock('../services/bandwidthTracker.js', () => ({ trackBandwidth: () => {} }));

const store = await import('../store/jobStore.js');
const { discoverSceneWindowsWithGemini, analyzeYouTubeVideoWithGemini } = await import('../services/aiService.js');
const { withAiUsageJob } = await import('../services/aiUsageService.js');

// Harus diawali 'AIzaSy' dan lolos cleanEnvKey: override ini dipakai
// getDirectGeminiApiKey sehingga process.env user tidak perlu disentuh.
const FAKE_KEY = 'AIzaSy-TEST-ONLY';

beforeEach(() => { h.behavior = null; });
afterAll(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(testDbPath + s, { force: true }); } catch {} }
});

const geminiResult = (text, usage) => ({
  response: { text: () => text, ...(usage ? { usageMetadata: usage } : {}) },
});

describe('discoverSceneWindowsWithGemini tercatat end-to-end', () => {
  it('jalur sukses: token asli + jobId konteks pipeline masuk ke satu baris yang sama', async () => {
    h.behavior = async () => geminiResult(
      JSON.stringify({ windows: [{ startSec: 12, endSec: 16, reason: 'hands-on' }] }),
      { promptTokenCount: 1200, candidatesTokenCount: 80, totalTokenCount: 1280 },
    );

    const out = await withAiUsageJob('sites-ctx-1', () =>
      discoverSceneWindowsWithGemini({ youtubeUrl: 'https://youtu.be/FAKE1', apiKey: FAKE_KEY, productTitle: 'Pisau Dapur' }),
    );
    expect(out.status).toBe('accept');
    expect(out.windows).toHaveLength(1);

    const rows = store.listAiUsage({ jobId: 'sites-ctx-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      site: 'Gemini Scene Discovery',
      provider: 'Google Gemini',
      inputKind: 'youtube_url_stream',
      mediaCount: 1,
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      ok: true,
    });
    expect(rows[0].note).toBe(''); // usageMetadata ADA -> tidak ada catatan "tidak dilaporkan"
    expect(rows[0].model).toBe('gemini-2.5-flash');
  });

  it('usageMetadata hilang dicatat sebagai baris ok dengan note, bukan sebagai kegagalan', async () => {
    h.behavior = async () => geminiResult(JSON.stringify({ windows: [{ startSec: 1, endSec: 5 }] }));
    await withAiUsageJob('sites-nometa', () =>
      discoverSceneWindowsWithGemini({ youtubeUrl: 'https://youtu.be/FAKE2', apiKey: FAKE_KEY }),
    );
    const [row] = store.listAiUsage({ jobId: 'sites-nometa' });
    expect(row.ok).toBe(true);
    expect(row.totalTokens).toBe(0);
    expect(row.note).toMatch(/tidak dilaporkan/);
  });

  it('setiap model yang gagal dalam rantai fallback menyumbang SATU baris gagal', async () => {
    h.behavior = async () => { throw Object.assign(new Error('Resource has been exhausted. status code 429'), { status: 429 }); };
    const out = await withAiUsageJob('sites-allfail', () =>
      discoverSceneWindowsWithGemini({ youtubeUrl: 'https://youtu.be/FAKE3', apiKey: FAKE_KEY }),
    );
    expect(out.status).toBe('empty');

    const rows = store.listAiUsage({ jobId: 'sites-allfail' });
    // 4 model kandidat di fungsi ini; tidak boleh ada yang hilang tanpa jejak.
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.ok === false)).toBe(true);
    expect(rows.every((r) => r.errorCode === 'status code 429')).toBe(true);
    expect(new Set(rows.map((r) => r.model)).size).toBe(4);
    // Inilah angka yang selama ini tidak pernah terlihat: biaya percobaan fallback.
    const sum = store.summarizeAiUsage({ jobId: 'sites-allfail' });
    expect(sum.totals.failedCalls).toBe(4);
    expect(sum.totals.promptTokens).toBe(0);
  });

  it('model pertama gagal lalu model kedua sukses: kedua baris tercatat, tanpa dobel', async () => {
    let n = 0;
    h.behavior = async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('blocked status code 400'), { status: 400 });
      return geminiResult(JSON.stringify({ windows: [{ startSec: 3, endSec: 7 }] }), { promptTokenCount: 500, totalTokenCount: 540 });
    };
    const out = await withAiUsageJob('sites-mixed', () =>
      discoverSceneWindowsWithGemini({ youtubeUrl: 'https://youtu.be/FAKE4', apiKey: FAKE_KEY }),
    );
    expect(out.status).toBe('accept');
    const rows = store.listAiUsage({ jobId: 'sites-mixed' });
    expect(rows).toHaveLength(2);
    expect(rows[0].ok).toBe(true); // terbaru lebih dulu
    expect(rows[1].ok).toBe(false);
  });

  it('tanpa konteks job, baris tetap tertulis (job_id kosong) dan tidak melempar', async () => {
    h.behavior = async () => geminiResult(JSON.stringify({ windows: [{ startSec: 8, endSec: 12 }] }), { totalTokenCount: 300 });
    const out = await discoverSceneWindowsWithGemini({ youtubeUrl: 'https://youtu.be/FAKE5', apiKey: FAKE_KEY });
    expect(out.status).toBe('accept');
    // Tidak ada jobId yang bisa dipakai untuk assertion; cukup pastikan tidak mengganggu.
    expect(store.summarizeAiUsage({}).totals.calls).toBeGreaterThan(0);
  });
});

describe('analyzeYouTubeVideoWithGemini tercatat end-to-end', () => {
  // Judul "Pisau Dapur" sengaja dipakai: heuristik isBulkyOrUnsuitableProduct menolaknya,
  // jadi uji ini sekalian membuktikan hal yang paling penting bagi tagihan AI -
  // token TETAP tercatat walaupun job akhirnya gagal/melempar. Pencatatan terjadi
  // sebelum keputusan bisnis, bukan di jalur sukses saja.
  it('token tercatat walau fungsi akhirnya melempar vonis tolak', async () => {
    h.behavior = async () => geminiResult(
      JSON.stringify({ status: 'accept', timestamps: [10, 20], detectedProduct: 'Pisau' }),
      { promptTokenCount: 8000, candidatesTokenCount: 200, totalTokenCount: 8200 },
    );
    await expect(withAiUsageJob('sites-yt-1', () =>
      analyzeYouTubeVideoWithGemini({
        youtubeUrl: 'https://youtu.be/FAKE6',
        apiKey: FAKE_KEY,
        productTitle: 'Pisau Dapur',
        productDescription: 'Pisau serbaguna',
      }),
    )).rejects.toThrow(/ditolak/i);

    const [row] = store.listAiUsage({ jobId: 'sites-yt-1' });
    expect(row.site).toBe('Gemini YouTube Stream');
    expect(row.promptTokens).toBe(8000);
    expect(row.totalTokens).toBe(8200);
    // Tidak ada productImage pada panggilan di atas -> hanya 1 video.
    expect(row.mediaCount).toBe(1);
    // Pemanggilan AI-nya sendiri BERHASIL (yang gagal adalah keputusan bisnis).
    expect(row.ok).toBe(true);
  });
});
