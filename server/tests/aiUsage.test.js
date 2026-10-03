// ============================================================================
// AI USAGE (Lapis 1 "hemat token Gemini") — kontrak pencatatan pemakaian AI.
//
// Yang dijaga di sini, urut dari yang paling berbahaya kalau rusak:
//  1) PENCATATAN TIDAK BOLEH MENJATUHKAN PIPELINE. Helper-nya selalu mengembalikan
//     nilai aman, termasuk saat store melempar (bagian terakhir file ini).
//  2) PEMANGGIL TIDAK BOLEH KEHILANGAN BODY. Pembungkus `fetch` wajib memakai
//     .clone(); kalau ada yang mengganti jadi res.json(), semua panggilan chat
//     rusak dan gejalanya muncul jauh dari sini.
//  3) TITIK PANGGILAN TIDAK BOLEH BERTAMBAH DIEM-DIEM. Scan statis mengunci setiap
//     `.generateContent(` punya pasangan `recordGeminiCall`, dan setiap client
//     OpenAI punya `fetch:` pembungkus. Titik baru tanpa pencatatan = test merah.
//  4) ANGKA ASLI vs ANGARA KARANGAN. `usageMetadata` yang hilang harus tetap
//     terbaca sebagai "tidak dilaporkan", bukan sebagai "nol token".
//
// DB terisolasi via JOBS_DB_PATH sebelum import jobStore (pola vlmOracle.test.js).
// ============================================================================
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(os.tmpdir(), `jobs-aiusage-test-${process.pid}-${Date.now()}.db`);
process.env.JOBS_DB_PATH = testDbPath;

const store = await import('../store/jobStore.js');
const {
  extractGeminiUsage,
  extractChatUsage,
  isRecordingEnabled,
  recordAiCall,
  recordGeminiCall,
  recordGeminiFailure,
  buildInstrumentedFetch,
  withAiUsageJob,
  currentAiUsageJobId,
} = await import('../services/aiUsageService.js');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const ENV_ON = { AI_USAGE_RECORD: '1' };

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(testDbPath + suffix, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// 1. Pembacaan usage
// ---------------------------------------------------------------------------
describe('extractGeminiUsage / extractChatUsage', () => {
  it('membaca usageMetadata Gemini lengkap', () => {
    const u = extractGeminiUsage({
      response: { usageMetadata: { promptTokenCount: 1400, candidatesTokenCount: 220, totalTokenCount: 1620, cachedContentTokenCount: 900 } },
    });
    expect(u).toMatchObject({ promptTokens: 1400, candidatesTokens: 220, totalTokens: 1620, cachedTokens: 900, hasMetadata: true });
  });

  it('menerima hasil generateContent() yang membungkus response langsung', () => {
    const u = extractGeminiUsage({ usageMetadata: { promptTokenCount: 10, totalTokenCount: 12 } });
    expect(u.promptTokens).toBe(10);
    expect(u.hasMetadata).toBe(true);
  });

  // Ini alasan kolom `note` ada: jawaban yang diblokir safety tidak mengirim
  // usageMetadata, dan "0 token" != "provider tidak melapor".
  it('membedakan token nol dari usage yang tidak dilaporkan', () => {
    const missing = extractGeminiUsage({ response: {} });
    expect(missing).toMatchObject({ promptTokens: 0, totalTokens: 0, hasMetadata: false });
    expect(extractGeminiUsage(null).hasMetadata).toBe(false);
    expect(extractGeminiUsage(undefined).hasMetadata).toBe(false);
  });

  it('menyaring nilai bukan angka (undefined/NaN/negatif/string)', () => {
    const u = extractGeminiUsage({ usageMetadata: { promptTokenCount: 'abc', candidatesTokenCount: -5, totalTokenCount: NaN } });
    expect(u).toMatchObject({ promptTokens: 0, candidatesTokens: 0, totalTokens: 0, hasMetadata: true });
  });

  it('membaca usage + biaya OpenRouter (credit USD)', () => {
    const u = extractChatUsage({ usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.00042 } });
    expect(u).toMatchObject({ promptTokens: 900, completionTokens: 100, totalTokens: 1000, cost: 0.00042, hasMetadata: true });
  });

  it('chat tanpa usage tetap aman dan ditandai', () => {
    expect(extractChatUsage({})).toMatchObject({ totalTokens: 0, hasMetadata: false });
    expect(extractChatUsage(null)).toMatchObject({ totalTokens: 0, hasMetadata: false });
  });

  it('kill switch AI_USAGE_RECORD=0 dikenali', () => {
    expect(isRecordingEnabled({ AI_USAGE_RECORD: '0' })).toBe(false);
    expect(isRecordingEnabled({ AI_USAGE_RECORD: ' 0 ' })).toBe(false);
    expect(isRecordingEnabled({})).toBe(true);
    expect(isRecordingEnabled({ AI_USAGE_RECORD: '1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Jalan tulis + konteks job
// ---------------------------------------------------------------------------
describe('recordAiCall dan konteks job (AsyncLocalStorage)', () => {
  it('menulis baris utuh dan bisa dibaca balik lewat listAiUsage', async () => {
    const id = await recordAiCall({
      jobId: 'au-write', site: 'Gemini Visual File API', provider: 'Google Gemini', model: 'gemini-flash-latest',
      inputKind: 'file_api_video', promptTokens: 1000, completionTokens: 50, totalTokens: 1050,
      requestBytes: 4096, mediaCount: 1, durationMs: 1234, ok: true,
    }, { env: ENV_ON, logger: silent });
    expect(typeof id).toBe('number');

    const [row] = store.listAiUsage({ jobId: 'au-write' });
    expect(row).toMatchObject({
      site: 'Gemini Visual File API', model: 'gemini-flash-latest', totalTokens: 1050,
      requestBytes: 4096, mediaCount: 1, durationMs: 1234, ok: true,
    });
  });

  it('jobId diambil dari konteks async walau pemanggil tidak mengirimnya', async () => {
    await withAiUsageJob('au-ctx', async () => {
      expect(currentAiUsageJobId()).toBe('au-ctx');
      await recordAiCall({ site: 'Gemini Scene Discovery', totalTokens: 7 }, { env: ENV_ON, logger: silent });
    });
    expect(currentAiUsageJobId()).toBe(''); // scope tutup lagi
    expect(store.listAiUsage({ jobId: 'au-ctx' })[0].site).toBe('Gemini Scene Discovery');
  });

  it('jobId eksplisit mengalahkan konteks, dan di luar konteks job_id kosong (bukan error)', async () => {
    await withAiUsageJob('au-ctx2', async () => {
      await recordAiCall({ jobId: 'au-eksplisit', site: 'X', totalTokens: 1 }, { env: ENV_ON, logger: silent });
    });
    expect(store.listAiUsage({ jobId: 'au-eksplisit' })[0].jobId).toBe('au-eksplisit');

    const id = await recordAiCall({ site: 'Y', totalTokens: 1 }, { env: ENV_ON, logger: silent });
    expect(typeof id).toBe('number');
  });

  it('argumen kedua { env, logger } benar-benar dipatuhi pembungkus Gemini', async () => {
    // Regresi nyata: kedua pembungkus pernah hanya menerima SATU objek argumen, jadi
    // panggilan model `recordGeminiCall(evt, { env, logger })` memakai process.env dan
    // console sungguhan tanpa suara-suara — kill switch tidak berlaku di jalur Gemini.
    const before = store.listAiUsage({ jobId: 'au-opts' }).length;
    const mati = await recordGeminiCall({ jobId: 'au-opts', site: 'X', result: { response: { usageMetadata: { totalTokenCount: 5 } } } }, { env: { AI_USAGE_RECORD: '0' }, logger: silent });
    expect(mati).toBeNull();
    expect(store.listAiUsage({ jobId: 'au-opts' }).length).toBe(before);

    const garis = [];
    const logger = { log: (...a) => garis.push(a.join(' ')), warn: () => {}, error: () => {} };
    await recordGeminiCall({ jobId: 'au-opts', site: 'Gemini Visual File API', model: 'gemini-flash-latest', result: { response: { usageMetadata: { promptTokenCount: 9120, candidatesTokenCount: 210, totalTokenCount: 9330 } } } }, { env: ENV_ON, logger });
    expect(garis).toEqual([]); // AI_USAGE_LOG tidak disetel -> diam
    await recordGeminiCall({ jobId: 'au-opts', site: 'Gemini Visual File API', model: 'gemini-flash-latest', result: { response: { usageMetadata: { promptTokenCount: 9120, candidatesTokenCount: 210, totalTokenCount: 9330 } } } }, { env: { AI_USAGE_RECORD: '1', AI_USAGE_LOG: '1' }, logger });
    expect(garis[0]).toBe('[AiUsage] Gemini Visual File API | Google Gemini gemini-flash-latest | in=9120 out=210 total=9330 | ok');
    await recordGeminiFailure({ jobId: 'au-opts', site: 'Gemini Pre-Flight Check', model: 'gemini-1.5-flash', error: new Error('kuota habis status code 429') }, { env: { AI_USAGE_RECORD: '1', AI_USAGE_LOG: '1' }, logger });
    expect(garis[1]).toContain('GAGAL status code 429');
  });

  it('AI_USAGE_RECORD=0 tidak menulis sama sekali', async () => {
    const before = store.listAiUsage({ jobId: 'au-off' }).length;
    const id = await recordAiCall({ jobId: 'au-off', site: 'Z', totalTokens: 99 }, { env: { AI_USAGE_RECORD: '0' }, logger: silent });
    expect(id).toBeNull();
    expect(store.listAiUsage({ jobId: 'au-off' }).length).toBe(before);
  });

  it('recordGeminiCall menyimpan catatan saat provider tidak mengirim usageMetadata', async () => {
    await recordGeminiCall({ jobId: 'au-nometa', site: 'Gemini YouTube Stream', model: 'gemini-2.5-flash', result: { response: {} } }, { env: ENV_ON, logger: silent });
    const [row] = store.listAiUsage({ jobId: 'au-nometa' });
    expect(row.totalTokens).toBe(0);
    expect(row.note).toMatch(/tidak dilaporkan/);
  });

  it('recordGeminiFailure mencatat kode error tanpa pernah melempar', async () => {
    await recordGeminiFailure({
      jobId: 'au-fail', site: 'Gemini Visual File API', model: 'gemini-flash-latest',
      error: Object.assign(new Error('Resource has been exhausted (daily quota). status code 429'), { status: 429 }),
      startedAt: Date.now() - 50,
    }, { env: ENV_ON, logger: silent });
    const [row] = store.listAiUsage({ jobId: 'au-fail' });
    expect(row.ok).toBe(false);
    expect(row.errorCode).toMatch(/429|ERR_/i);
    expect(row.note).toMatch(/exhausted/);
  });
});

// ---------------------------------------------------------------------------
// 3. Pembungkus fetch (satu-satunya jalan semua panggilan chat)
// ---------------------------------------------------------------------------
const jsonResponse = (obj, headers = {}) =>
  new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('buildInstrumentedFetch', () => {
  const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

  it('mencatat token DAN tetap menyerahkan body utuh ke pemanggil', async () => {
    const impl = async () => jsonResponse({ id: 'x', choices: [{ message: { content: 'halo' } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
    const wrapped = buildInstrumentedFetch({ provider: 'OpenRouter', env: ENV_ON, logger: silent, fetchImpl: impl });

    const res = await wrapped(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'gemini-2.5-flash', messages: [] }) });
    expect(res.ok).toBe(true);
    // Inilah alasan .clone() dipakai: pembacaan pemanggil tidak boleh habis.
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('halo');

    const rows = store.listAiUsage({ limit: 500 }).filter((r) => r.provider === 'OpenRouter');
    const hit = rows.find((r) => r.model === 'gemini-2.5-flash');
    expect(hit).toBeTruthy();
    expect(hit.totalTokens).toBe(150);
  });

  it('mencatat kegagalan HTTP (429) sebagai ok=false tanpa mengubah respons', async () => {
    const impl = async () => new Response('{"error":"rate limit"}', { status: 429, headers: { 'content-type': 'application/json' } });
    const wrapped = buildInstrumentedFetch({ provider: 'Google Gemini Direct', env: ENV_ON, logger: silent, fetchImpl: impl });
    const res = await wrapped(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'gemini-flash-latest' }) });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('rate limit');

    const hit = store.listAiUsage({ limit: 500 }).find((r) => r.provider === 'Google Gemini Direct');
    expect(hit.ok).toBe(false);
    expect(hit.errorCode).toBe('429');
  });

  it('jawaban SSE dicatat tapi tidak dipaksa parse JSON', async () => {
    const impl = async () => new Response('data: {"choices":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const wrapped = buildInstrumentedFetch({ provider: 'OpenRouter', env: ENV_ON, logger: silent, fetchImpl: impl });
    const res = await wrapped(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'sse-model', stream: true }) });
    expect(await res.text()).toContain('data:');
    const hit = store.listAiUsage({ limit: 500 }).find((r) => r.model === 'sse-model');
    expect(hit.ok).toBe(true);
    expect(hit.note).toMatch(/streaming/);
  });

  it('URL non-chat (files/embeddings) dilewatkan tanpa catatan', async () => {
    const before = store.listAiUsage({ limit: 1 })[0]?.id || 0;
    const impl = async () => jsonResponse({ done: true });
    const wrapped = buildInstrumentedFetch({ provider: 'Google Gemini Direct', env: ENV_ON, logger: silent, fetchImpl: impl });
    const res = await wrapped('https://generativelanguage.googleapis.com/upload/v1beta/files', { method: 'POST', body: 'binary-ish' });
    expect(res.ok).toBe(true);
    const after = store.listAiUsage({ limit: 1 })[0]?.id || 0;
    expect(after).toBe(before);
  });

  it('error jaringan dilempar ulang apa adanya (perilaku pemanggil tidak berubah)', async () => {
    const impl = async () => { throw Object.assign(new Error('socket hang up'), { name: 'FetchError' }); };
    const wrapped = buildInstrumentedFetch({ provider: 'OpenRouter', env: ENV_ON, logger: silent, fetchImpl: impl });
    await expect(wrapped(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'net-model' }) })).rejects.toThrow('socket hang up');
    const hit = store.listAiUsage({ limit: 500 }).find((r) => r.model === 'net-model');
    expect(hit.ok).toBe(false);
  });

  it('memakai jobId dari konteks pipeline', async () => {
    const impl = async () => jsonResponse({ usage: { total_tokens: 5 } });
    const wrapped = buildInstrumentedFetch({ provider: 'OpenRouter', env: ENV_ON, logger: silent, fetchImpl: impl });
    await withAiUsageJob('au-fetch-ctx', async () => {
      await wrapped(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'ctx-fetch-model' }) });
    });
    expect(store.listAiUsage({ jobId: 'au-fetch-ctx' })[0].model).toBe('ctx-fetch-model');
  });

  it('mengembalikan undefined bila global fetch tidak tersedia (biar SDK pakai default)', () => {
    const saved = globalThis.fetch;
    try {
      expect(buildInstrumentedFetch({ fetchImpl: async () => jsonResponse({}), env: ENV_ON })).toBeTypeOf('function');
      delete globalThis.fetch;
      expect(buildInstrumentedFetch({ env: ENV_ON })).toBeUndefined();
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Rute pembaca
// ---------------------------------------------------------------------------
let server = null;
let baseUrl = '';

async function startRouteApp(routerFactory) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', routerFactory);
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

const getJson = async (p) => {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const postJson = async (p, body) => {
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

describe('GET/POST /api/ai-usage', () => {
  beforeAll(async () => {
    const { default: aiUsageRoutes } = await import('../api/routes/aiUsageRoutes.js');
    await startRouteApp(aiUsageRoutes);
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    server = null;
  });

  it('maka ringkasan per situs + total untuk job tertentu', async () => {
    await recordAiCall({ jobId: 'au-route-1', site: 'Gemini YouTube Stream', provider: 'Google Gemini', model: 'gemini-2.5-flash', promptTokens: 9000, totalTokens: 9500 }, { env: ENV_ON, logger: silent });
    await recordAiCall({ jobId: 'au-route-1', site: 'Gemini Visual File API', provider: 'Google Gemini', model: 'gemini-flash-latest', promptTokens: 500, totalTokens: 600 }, { env: ENV_ON, logger: silent });

    const { status, json } = await getJson('/api/ai-usage?jobId=au-route-1&hours=1');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.recordingEnabled).toBe(true);
    expect(json.totals.calls).toBe(2);
    expect(json.totals.totalTokens).toBe(10100);
    expect(json.bySite[0].site).toBe('Gemini YouTube Stream'); // urut token terbesar
    expect(json.window.hours).toBe(1);
  });

  it('detail=1 menambah daftar mentah, dan tanpa detail tidak ada', async () => {
    const plain = await getJson('/api/ai-usage?jobId=au-route-1');
    expect(plain.json.events).toBeUndefined();
    const full = await getJson('/api/ai-usage?jobId=au-route-1&detail=1');
    expect(Array.isArray(full.json.events)).toBe(true);
    expect(full.json.events.length).toBe(2);
    expect(full.json.events[0].jobId).toBe('au-route-1');
  });

  it('memfilter lewat jendela waktu (hours kecil tidak melihat job lama)', async () => {
    store.recordAiUsage({ jobId: 'au-route-lama', site: 'Lama', totalTokens: 10 }, { now: Date.now() - 48 * 3600_000 });
    const { json } = await getJson('/api/ai-usage?hours=1');
    expect(json.bySite.find((s) => s.site === 'Lama')).toBeUndefined();
    const wide = await getJson('/api/ai-usage?hours=72');
    expect(wide.json.bySite.find((s) => s.site === 'Lama')).toBeTruthy();
  });

  it('failingSites hanya berisi situs dengan panggilan gagal', async () => {
    await recordGeminiFailure({ jobId: 'au-route-err', site: 'Gemini Pre-Flight Check', model: 'gemini-flash-latest', error: new Error('404 Not Found') }, { env: ENV_ON, logger: silent });
    const { json } = await getJson('/api/ai-usage?jobId=au-route-err');
    expect(json.totals.failedCalls).toBe(1);
    expect(json.failingSites[0]).toMatchObject({ site: 'Gemini Pre-Flight Check', failedCalls: 1 });
  });

  it('topForJob=1 tanpa jobId ditolak 400', async () => {
    const { status, json } = await getJson('/api/ai-usage?topForJob=1');
    expect(status).toBe(400);
    expect(json.error).toMatch(/jobId/);
  });

  it('jobId panjang dipotong, tidak pernah bocor ke SQL apa pun', async () => {
    const long = 'a'.repeat(400);
    const { status, json } = await getJson(`/api/ai-usage?jobId=${long}`);
    expect(status).toBe(200);
    expect(json.jobId).toBe('a'.repeat(120));
    expect(json.totals.calls).toBe(0);
  });

  it('POST prune membuang baris tua dan mengembalikan jumlahnya', async () => {
    store.recordAiUsage({ jobId: 'au-route-lama', site: 'Lama', totalTokens: 10 }, { now: Date.now() - 48 * 3600_000 });
    const { status, json } = await postJson('/api/ai-usage/prune', { keepDays: 1 });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.removed).toBeGreaterThanOrEqual(1);
    expect(store.listAiUsage({ jobId: 'au-route-lama' }).length).toBe(0);
  });

  it('keepDays selalu dalam rentang aman (bukan penghapusan seluruh tabel)', async () => {
    // 0 / negatif / bukan angka jatuh ke default 30 hari, bukan 0 hari (yang berarti "hapus semua").
    const { json } = await postJson('/api/ai-usage/prune', { keepDays: 0 });
    expect(json.keepDays).toBe(30);
    const { json: json2 } = await postJson('/api/ai-usage/prune', { keepDays: 9999 });
    expect(json2.keepDays).toBe(365);
    // data muda masih utuh
    expect(store.listAiUsage({ jobId: 'au-route-1' }).length).toBe(2);
  });

  it('memberi angka "token per klip jadi" saat tidak memfilter jobId', async () => {
    store.activeJobs.set('au-clip-a', { id: 'au-clip-a', stage: 'completed', finalFileName: 'final_clip_au-clip-a.mp4', updatedAt: new Date().toISOString() });
    store.activeJobs.set('au-clip-b', { id: 'au-clip-b', stage: 'completed', silentFileName: 'silent_clip_au-clip-b.mp4', updatedAt: new Date().toISOString() });
    await recordAiCall({ jobId: 'au-clip-a', site: 'Gemini Visual File API', totalTokens: 4000 }, { env: ENV_ON, logger: silent });

    const { json } = await getJson('/api/ai-usage?hours=24');
    expect(json.perClip).toBeTruthy();
    // Dua klip jadi dari test ini + klip dari test lain di file yang sama.
    expect(json.perClip.completedClips).toBeGreaterThanOrEqual(2);
    expect(json.perClip.tokensPerCompletedClip).toBeGreaterThan(0);
    // Pembilang harus benar-benar dibagi, bukan disalin mentah.
    expect(json.perClip.tokensPerCompletedClip)
      .toBe(Math.round(json.totals.totalTokens / json.perClip.completedClips));
    expect(typeof json.perClip.unfinishedJobs).toBe('number');
    expect(json.perClip.note).toMatch(/batas ATAS|penyebut/i);
  });

  it('perClip null saat jobId ditentukan (penyebutnya selalu 1, jadi tidak berguna)', async () => {
    const { json } = await getJson('/api/ai-usage?jobId=au-route-1');
    expect(json.perClip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4b. Penyebut "klip jadi" (countCompletedClips)
// ---------------------------------------------------------------------------
describe('countCompletedClips', () => {
  const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

  it('hanya menghitung job completed yang punya bukti file keluaran', () => {
    // Delta terhadap kondisi awal: file DB ini dipakai bersama seluruh bagian test,
    // jadi angka absolut akan pecah begitu ada test lain menambah job.
    const before = store.countCompletedClips({ sinceMs: 3600_000 });
    store.activeJobs.set('au-den-1', { id: 'au-den-1', stage: 'completed', finalFileName: 'f.mp4', updatedAt: iso(0) });
    store.activeJobs.set('au-den-2', { id: 'au-den-2', stage: 'completed', updatedAt: iso(0) }); // tanpa file = bukan klip jadi
    store.activeJobs.set('au-den-3', { id: 'au-den-3', stage: 'error', finalFileName: 'f.mp4', updatedAt: iso(0) });
    store.activeJobs.set('au-den-4', { id: 'au-den-4', stage: 'running', updatedAt: iso(0) });
    const after = store.countCompletedClips({ sinceMs: 3600_000 });
    expect(after.totalJobs).toBe(before.totalJobs + 4);
    expect(after.clips).toBe(before.clips + 1);        // hanya au-den-1
    expect(after.unfinished).toBe(before.unfinished + 1); // hanya au-den-4 (stage non-terminal)
  });

  it('memakai jendela waktu: klip lama tidak ikut pada jendela sempit', () => {
    store.activeJobs.set('au-den-tua', { id: 'au-den-tua', stage: 'completed', finalFileName: 'f.mp4', updatedAt: iso(48 * 3600_000) });
    const tua = store.countCompletedClips({ sinceMs: 49 * 3600_000 }).clips;
    const muda = store.countCompletedClips({ sinceMs: 3600_000 }).clips;
    expect(tua).toBeGreaterThanOrEqual(1);
    expect(muda).toBeLessThan(tua);
  });

  it('job tanpa stage/waktu tidak bikin fungsi melempar', () => {
    store.activeJobs.set('au-den-kosong', { id: 'au-den-kosong' });
    expect(() => store.countCompletedClips({ sinceMs: 3600_000 })).not.toThrow();
  });

  it('totals.distinctJobs menghitung job yang muncul di tabel pemakaian', async () => {
    await recordAiCall({ jobId: 'au-distinct-x', site: 'Gemini Scene Discovery', totalTokens: 100 }, { env: ENV_ON, logger: silent });
    await recordAiCall({ jobId: 'au-distinct-x', site: 'Gemini Pre-Flight Check', totalTokens: 100 }, { env: ENV_ON, logger: silent });
    await recordAiCall({ jobId: 'au-distinct-y', site: 'Gemini Scene Discovery', totalTokens: 100 }, { env: ENV_ON, logger: silent });
    const s = store.summarizeAiUsage({});
    // distinctJobs BUKAN jumlah nilai per-group (2 + 2), melainkan job unik = 3 di atas
    // ditambah job dari bagian sebelumnya yang juga punya baris pemakaian.
    expect(s.totals.distinctJobs).toBeGreaterThanOrEqual(3);
    expect(s.bySite.reduce((a, r) => a + r.distinctJobs, 0)).toBeGreaterThanOrEqual(s.totals.distinctJobs);
  });
});

// ---------------------------------------------------------------------------
// 5. Kunci statis: tidak boleh ada titik AI baru yang tidak tercatat
// ---------------------------------------------------------------------------
describe('instrumen terpasang di semua titik panggilan', () => {
  const EXPECTED_SITES = [
    'Gemini Scene Discovery',
    'Gemini YouTube Stream',
    'Gemini Multi-Video Stream',
    'Gemini Visual File API',
    'Gemini Pre-Flight Check',
    'Gemini Visual Keywords',
  ];

  it('setiap .generateContent( punya recordGeminiCall di bawahnya', () => {
    for (const rel of ['services/aiService.js', 'services/discoveryService.js']) {
      const src = readSrc(rel);
      const re = /\.generateContent\(/g;
      let m;
      let n = 0;
      while ((m = re.exec(src))) {
        n += 1;
        const after = src.slice(m.index, m.index + 900);
        expect(after, `${rel} punya .generateContent( tanpa recordGeminiCall (sekitar baris ${src.slice(0, m.index).split('\n').length})`).toMatch(/recordGeminiCall\(/);
      }
      expect(n).toBeGreaterThan(0);
    }
    // Jumlah titik yang diketahui pembaca rencana: 5 di aiService + 1 di discoveryService.
    expect((readSrc('services/aiService.js').match(/\.generateContent\(/g) || []).length).toBe(5);
    expect((readSrc('services/discoveryService.js').match(/\.generateContent\(/g) || []).length).toBe(1);
  });

  it('enam label situs dipakai, masing-masing punya pasangan sukses DAN gagal', () => {
    const src = readSrc('services/aiService.js') + readSrc('services/discoveryService.js');
    for (const site of EXPECTED_SITES) {
      const calls = (src.match(new RegExp(`site: '${site}'`, 'g')) || []).length;
      expect(calls, `situs ${site} harus muncul di recordGeminiCall dan recordGeminiFailure`).toBeGreaterThanOrEqual(2);
    }
    expect((src.match(/recordGeminiFailure\(/g) || []).length).toBeGreaterThanOrEqual(6);
  });

  it('kedua client OpenAI memakai fetch pembungkus (menutup semua chat.completions)', () => {
    const src = readSrc('services/ai/aiClient.js');
    const clients = (src.match(/new OpenAI\(/g) || []).length;
    expect(clients).toBe(2);
    expect((src.match(/fetch: buildInstrumentedFetch\(/g) || []).length).toBe(clients);
  });

  // Teks di source belum membuktikan SDK benar-benar MENERIMA opsi `fetch`. Diuji pada
  // versi terpasang (openai 4.104.0: core.js `this.fetch = overriddenFetch ?? fetch`).
  it('client OpenAI sungguhan menyimpan pembungkusnya di client.fetch', async () => {
    const saved = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        jsonResponse({ choices: [{ message: { content: 'oke' } }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } });
      const { getDirectGeminiClientConfig } = await import('../services/ai/aiClient.js');
      const conf = getDirectGeminiClientConfig({ apiKeyOverride: 'AIzaSy-TEST-ONLY' });
      expect(conf).toBeTruthy();
      expect(typeof conf.client.fetch).toBe('function');

      await conf.client.fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST', body: JSON.stringify({ model: 'sdk-wired-model', messages: [] }),
      });
      const hit = store.listAiUsage({ limit: 500 }).find((r) => r.model === 'sdk-wired-model');
      expect(hit, 'panggilan lewat client SDK harus tercatat').toBeTruthy();
      expect(hit.provider).toBe('Google Gemini Direct');
      expect(hit.totalTokens).toBe(13);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('pipeline membuka konteks job di SATU titik masuk', () => {
    const src = readSrc('worker/stage1Render.js');
    expect(src).toMatch(/withAiUsageJob\(args\?\.jobId/);
    // inside the queue callback, not outside it
    expect(src).toMatch(/heavyTaskQueue\(\(\) => withAiUsageJob\(/);
  });

  it('rute ai-usage tidak masuk allowlist publik tokenAuth', () => {
    const mw = readSrc('api/middleware/tokenAuth.js');
    expect(mw).not.toMatch(/ai-usage/);
    const srv = readSrc('server.js');
    const mount = srv.indexOf("app.use('/api', aiUsageRoutes)");
    const guard = srv.indexOf('app.use(tokenAuthMiddleware)');
    expect(mount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mount);
  });
});

// ---------------------------------------------------------------------------
// 6. Kegagalan store tidak boleh menjalar (diurut terakhir: reset modul)
// ---------------------------------------------------------------------------
describe('kegagalan penyimpanan ditelan', () => {
  it('helper tetap mengembalikan null walau jobStore melempar', async () => {
    vi.resetModules();
    vi.doMock('../store/jobStore.js', () => ({
      recordAiUsage: () => { throw new Error('database is locked'); },
    }));
    const fresh = await import('../services/aiUsageService.js');
    const id = await fresh.recordAiCall({ jobId: 'au-broken', site: 'X', totalTokens: 1 }, { env: ENV_ON, logger: silent });
    expect(id).toBeNull();
    await expect(fresh.recordGeminiCall({ jobId: 'au-broken', site: 'X', result: { response: { usageMetadata: { totalTokenCount: 3 } } } }, { env: ENV_ON, logger: silent })).resolves.toBeNull();
    // peringatan hanya sekali, dan hanya saat AI_USAGE_LOG aktif
    vi.doUnmock('../store/jobStore.js');
    vi.resetModules();
  });
});
