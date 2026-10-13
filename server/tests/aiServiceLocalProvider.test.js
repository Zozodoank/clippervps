// FASE INFRA (Keputusan A): tes provider branch di aiService — SEMUA MOCK, tanpa
// server/model/ffmpeg. Yang dikunci:
//   • flag ON + model lokal menghasilkan parsed layak -> Gemini TIDAK dipanggil sama sekali;
//   • model lokal gagal -> fallback ke rantai Gemini APA ADANYA (perilaku hari ini);
//   • flag OFF (default) -> chatJson tidak pernah disentuh (jalur lama identik);
//   • gerbang kind: seleksi vs storyboard dipisah (bug guard gate per-jenis tugas).
// Catatan: eskalasi repairStoryboardWithGemini DIHAPUS (Opsi B) — rencana rancu kini
// memicu master loop mencari kandidat baru, bukan fallback Gemini.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatJson: vi.fn(),
  generateContent: vi.fn(),
  recordCall: vi.fn(async () => {}),
  recordFail: vi.fn(async () => {}),
  trackBandwidth: vi.fn(),
  geminiKey: vi.fn(() => 'test-key'),
}));

// aiClient memuat ulang server/.env dari disk -> satu-satunya cara deterministik
// mensimulasikan "tanpa API key" adalah mock getDirectGeminiApiKey.
vi.mock('../services/ai/aiClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDirectGeminiApiKey: () => mocks.geminiKey() };
});

vi.mock('../services/localTextModelService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, chatJson: (...args) => mocks.chatJson(...args) };
});

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() { return { generateContent: mocks.generateContent }; }
  },
}));
vi.mock('@google/generative-ai/server', () => ({ GoogleAIFileManager: class {} }));
vi.mock('../services/aiUsageService.js', () => ({
  recordGeminiCall: mocks.recordCall,
  recordGeminiFailure: mocks.recordFail,
  withAiUsageJob: (fn) => fn,
}));
vi.mock('../services/bandwidthTracker.js', () => ({ trackBandwidth: mocks.trackBandwidth }));

const { analyzeYouTubeVideoWithGemini, analyzeMultipleYouTubeVideosWithGemini } = await import('../services/aiService.js');

const LOCAL_OK_SELECTION = {
  ok: true,
  parsed: {
    status: 'select',
    detectedProduct: 'Kaca Mobil Anti Gores',
    productHook: 'Hook lokal',
    hasProductBrand: false,
    selectedClips: [
      { startSeconds: 12, endSeconds: 15.3, reason: 'demo produk lokal' },
      { startSeconds: 40, endSeconds: 43.3, reason: 'pasang di pintu' },
    ],
    timestamps: [12, 40],
  },
  raw: '{}', latencyMs: 12, error: '', response: { usage: { total_tokens: 42 } }, model: 'qwen-test', usage: { total_tokens: 42 },
};
const LOCAL_OK_MULTI = {
  ...LOCAL_OK_SELECTION,
  parsed: {
    status: 'select',
    productHook: 'Hook storyboard',
    selectedClips: [
      { sourceVideoIndex: 0, startSeconds: 20, endSeconds: 23.3, clean: true, containsTargetProduct: true, isActiveProductDemo: true, reason: 'demo A' },
      { sourceVideoIndex: 1, startSeconds: 60, endSeconds: 63.3, clean: true, containsTargetProduct: true, isActiveProductDemo: true, reason: 'demo B' },
    ],
  },
};
const GEMINI_JSON = JSON.stringify({
  status: 'select',
  detectedProduct: 'Kaca Mobil Anti Gores',
  productHook: 'Hook gemini',
  hasProductBrand: false,
  selectedClips: [{ startSeconds: 30, endSeconds: 33.3, reason: 'demo gemini' }],
  timestamps: [30],
});
// Jalur multi-video menyaring klip yang tidak "explicitlyClean" -> payload Gemini untuk
// tes multi wajib membawa flag bersih agar bisa membuktikan fallback sampai klip jadi.
const GEMINI_JSON_MULTI = JSON.stringify({
  status: 'select',
  productHook: 'Hook gemini multi',
  selectedClips: [{ sourceVideoIndex: 0, startSeconds: 30, endSeconds: 33.3, clean: true, containsTargetProduct: true, isActiveProductDemo: true, reason: 'demo gemini' }],
});

const ENV_KEYS = ['GEMINI_API_KEY', 'LOCAL_TEXT_MODEL', 'USE_LOCAL_SELECTION', 'USE_LOCAL_STORYBOARD'];
let savedEnv = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.LOCAL_TEXT_MODEL = 'qwen2.5-vl-3b-q4';
  // Default SDK fetch-style: Gemini selalu "sukses" saat memang dipanggil.
  mocks.generateContent.mockResolvedValue({ response: { text: () => GEMINI_JSON } });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('analyzeYouTubeVideoWithGemini — rute seleksi lokal + fallback Gemini', () => {
  it('flag ON & lokal layak -> parsed lokal dipakai, NOL panggilan Gemini', async () => {
    process.env.USE_LOCAL_SELECTION = '1';
    mocks.chatJson.mockResolvedValue(LOCAL_OK_SELECTION);
    const res = await analyzeYouTubeVideoWithGemini({
      youtubeUrl: 'https://youtu.be/abc', productTitle: 'Kaca Mobil Anti Gores', totalDuration: 600,
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(res.clips.length).toBeGreaterThanOrEqual(1);
    expect(res.productHook).toBe('Hook lokal');
    // Ledger terlacak dengan penanda provider.
    const localLedger = mocks.recordCall.mock.calls.find(([evt]) => evt.provider === 'local-qwen');
    expect(localLedger).toBeTruthy();
    expect(localLedger[0].site).toContain('Selection');
  });

  it('lokal gagal (ok:false) -> fallback ke rantai Gemini, perilaku sama seperti kini', async () => {
    process.env.USE_LOCAL_SELECTION = 'true';
    mocks.chatJson.mockResolvedValue({ ok: false, parsed: null, raw: '', latencyMs: 1, error: 'http_503', response: null, model: 'qwen-test', usage: null });
    const res = await analyzeYouTubeVideoWithGemini({
      youtubeUrl: 'https://youtu.be/abc', productTitle: 'Kaca Mobil Anti Gores', totalDuration: 600,
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(mocks.recordFail).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local-qwen', error: expect.any(Error) }));
    expect(res.clips.length).toBeGreaterThanOrEqual(1);
    expect(res.productHook).toBe('Hook gemini');
  });

  it('lokal "sukses" tapi parsed tak layak -> tetap fallback Gemini (isParsedUsable ketat)', async () => {
    process.env.USE_LOCAL_SELECTION = '1';
    mocks.chatJson.mockResolvedValue({ ...LOCAL_OK_SELECTION, parsed: { note: 'tidak ada struktur' } });
    const res = await analyzeYouTubeVideoWithGemini({
      youtubeUrl: 'https://youtu.be/abc', productTitle: 'Kaca Mobil', totalDuration: 600,
    });
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(res.productHook).toBe('Hook gemini');
  });

  it('flag OFF (default produksi) -> chatJson TIDAK PERNAH dipanggil; jalur lama identik', async () => {
    delete process.env.USE_LOCAL_SELECTION;
    const res = await analyzeYouTubeVideoWithGemini({
      youtubeUrl: 'https://youtu.be/abc', productTitle: 'Kaca Mobil', totalDuration: 600,
    });
    expect(mocks.chatJson).not.toHaveBeenCalled();
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(res.clips.length).toBeGreaterThanOrEqual(1);
  });
});

describe('analyzeMultipleYouTubeVideosWithGemini — gerbang kind storyboard terpisah', () => {
  const MULTI_ARGS = {
    youtubeUrls: ['https://youtu.be/a', 'https://youtu.be/b'],
    productTitle: 'Kaca Mobil Anti Gores',
    totalDuration: 600,
  };

  it('storyboard ON & lokal layak -> NOL panggilan Gemini', async () => {
    process.env.USE_LOCAL_STORYBOARD = '1';
    mocks.chatJson.mockResolvedValue(LOCAL_OK_MULTI);
    const res = await analyzeMultipleYouTubeVideosWithGemini(MULTI_ARGS);
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(res.clips.length).toBeGreaterThanOrEqual(1);
    const localLedger = mocks.recordCall.mock.calls.find(([evt]) => evt.provider === 'local-qwen');
    expect(localLedger[0].site).toContain('Storyboard');
  });

  it('hanya flag SELEKSI ON -> tugas storyboard TIDAK memakai lokal (guard gerbang per-kind)', async () => {
    process.env.USE_LOCAL_SELECTION = '1';
    delete process.env.USE_LOCAL_STORYBOARD;
    await analyzeMultipleYouTubeVideosWithGemini(MULTI_ARGS);
    expect(mocks.chatJson).not.toHaveBeenCalled();
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
  });

  it('storyboard ON tapi lokal gagal -> fallback Gemini', async () => {
    process.env.USE_LOCAL_STORYBOARD = '1';
    mocks.chatJson.mockResolvedValue({ ok: false, parsed: null, raw: '', latencyMs: 1, error: 'timeout', response: null, model: 'qwen-test', usage: null });
    mocks.generateContent.mockResolvedValue({ response: { text: () => GEMINI_JSON_MULTI } });
    const res = await analyzeMultipleYouTubeVideosWithGemini(MULTI_ARGS);
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(res.clips.length).toBeGreaterThanOrEqual(1);
  });
});
