// ============================================================================
// AI USAGE RECORDER — Lapis 1 dari rencana "hemat token Gemini".
//
// MASALAH YANG DIATASI: sampai file ini dibuat, TIDAK ADA satu pun tempat di repo
// yang membaca `usageMetadata` dari jawaban Gemini maupun `usage` dari jawaban
// OpenRouter/Gemini-OpenAI (diger grep `usageMetadata|promptTokenCount|totalTokenCount`
// di *.js, *.py, *.ipynb, *.md: 0 hasil). Angka yang ada hanyalah karangan:
// `trackBandwidth('aiRequests', 2500, ...)` dan `(..., 3500, ...)` di aiService.js.
// Akibatnya tidak ada cara untuk tahu panggilan mana yang membakar token, jadi
// tidak ada dasar memutuskan mana yang harus dipindah ke Oracle Kaggle.
//
// JANJI DESAIN:
//  1) TIDAK PERNAH melempar. Kegagalan pencatatan = hilang satu baris statistik,
//     BUKAN job gagal. Setiap cabang dijaga try/catch dan mengembalikan null.
//  2) TIDAK mengubah perilaku panggilan AI. Yang dikirim ke provider persis sama;
//     ini hanya mendengarkan.
//  3) Lengkap secara konstruktif untuk keluarga chat: pembungkus `fetch` dipasang di
//     DUA tempat `new OpenAI(...)` (services/ai/aiClient.js), sehingga semua titik
//     `client.chat.completions.create(...)` — yang ada hari ini (8 titik) dan yang
//     ditulis nanti — otomatis tercatat, termasuk yang gagal karena kuota.
//     Untuk SDK Gemini (`@google/generative-ai`, 6 titik `generateContent`) tidak ada
//     celah `fetch` yang bisa disuntik di versi 0.24, jadi di situ pencatatan eksplisit
//     per titik dan dikunci oleh test scan statis di tests/aiUsage.test.js.
//  4) Matikan tanpa deploy: AI_USAGE_RECORD=0. Bicara di log: AI_USAGE_LOG=1.
// ============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

const clip = (s, max) => String(s == null ? '' : s).slice(0, max);

/** Dipakai oleh penghitung byte request; String → byte, selain itu 0. */
function bodyBytes(body) {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf-8');
  if (Buffer.isBuffer(body)) return body.length;
  if (body && typeof body.byteLength === 'number') return body.byteLength;
  return 0;
}

function modelFromRequestBody(body) {
  if (typeof body !== 'string') return '';
  try {
    return clip(JSON.parse(body)?.model, 80);
  } catch {
    return '';
  }
}

/**
 * Baca usage dari objek hasil SDK Gemini (`result.response` = GenerateContentResponse).
 * `usageMetadata` bertipe OPTIONAL di SDK 0.24.1 dan bisa HILANG saat jawaban diblokir,
 * jadi hasilnya selalu membawa `hasMetadata` agar pembeda "nol token" vs "tidak dilaporkan"
 * tidak hilang saat dibaca nanti.
 */
export function extractGeminiUsage(responseLike) {
  const um = responseLike?.usageMetadata || responseLike?.response?.usageMetadata || null;
  if (!um || typeof um !== 'object') {
    return { promptTokens: 0, candidatesTokens: 0, totalTokens: 0, cachedTokens: 0, hasMetadata: false };
  }
  return {
    promptTokens: num(um.promptTokenCount),
    candidatesTokens: num(um.candidatesTokenCount),
    totalTokens: num(um.totalTokenCount),
    cachedTokens: num(um.cachedContentTokenCount),
    hasMetadata: true,
  };
}

/** Baca usage dari JSON respons OpenAI-compatible (OpenRouter & Gemini-OpenAI). */
export function extractChatUsage(json) {
  const u = json && typeof json === 'object' ? json.usage : null;
  if (!u || typeof u !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, hasMetadata: false };
  }
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
    // OpenRouter menyertakan biaya kredit USD per panggilan; provider lain 0.
    cost: Number(u.cost) > 0 ? Number(u.cost) : 0,
    hasMetadata: true,
  };
}

export function isRecordingEnabled(env = process.env) {
  return String(env.AI_USAGE_RECORD ?? '1').trim().toLowerCase() !== '0';
}

/**
 * KONTEKS JOB (AsyncLocalStorage).
 * Fungsi AI di aiService.js / discoveryService.js TIDAK menerima `jobId` sebagai
 * parameter (grep `jobId` di services/aiService.js: 0 hasil), dan mengubah 6 signature
 * sekaligus hanya untuk statistik berisiko merusak pipeline. Jadi identitas job diambil
 * dari konteks async: worker memanggil `withAiUsageJob(jobId, fn)` SATU kali di
 * `runStage1Pipeline`, dan seluruh turunan await-nya — termasuk pembungkus `fetch`
 * client OpenAI — otomatis tahu sedang mengerjakan job yang mana.
 *
 * Dipanggil di luar konteks (mis. rute manual, unit test): store kosong → job_id ''
 * di baris DB, artinya "pemakaian AI tanpa job tertentu". Tidak pernah error.
 */
const jobContext = new AsyncLocalStorage();

export function withAiUsageJob(jobId, fn) {
  return jobContext.run(String(jobId || ''), fn);
}

export function currentAiUsageJobId() {
  try {
    return jobContext.getStore() || '';
  } catch {
    return '';
  }
}

/**
 * Satu-satunya jalan tulis. jobStore di-import LAZY dan sengaja: aiService di-import
 * oleh banyak unit test yang tidak boleh ikut membuka jobs.db hanya karena ada di
 * rantai import. Setiap kegagalan (DB terkunci, kolom berubah, disk penuh) ditelan
 * dan hanya menjadi peringatan sesekali — tidak pernah menjalar ke pipeline.
 */
let storePromise = null;
function getStore() {
  if (!storePromise) storePromise = import('../store/jobStore.js');
  return storePromise;
}

let warned = false;
function warnOnce(logger, err) {
  if (warned) return;
  warned = true;
  try {
    (logger || console).warn(`[AiUsage] pencatatan usage nonaktif: ${err?.message || err}`);
  } catch {}
}

/**
 * Rekam satu kejadian pemakaian AI. Peta kolom ada di jobStore.recordAiUsage.
 * `site` = label manusia yang sama dengan yang ada di log ('Gemini Scene Discovery',
 * 'AI Vision', ...) supaya angka di DB dan baris log bisa dibaca silang.
 */
export async function recordAiCall(evt = {}, { env = process.env, logger = console } = {}) {
  if (!isRecordingEnabled(env)) return null;
  try {
    const store = await getStore();
    const row = {
      jobId: clip(evt.jobId || currentAiUsageJobId(), 120),
      site: clip(evt.site || 'unknown', 80),
      provider: clip(evt.provider || '', 40),
      model: clip(evt.model || '', 80),
      inputKind: clip(evt.inputKind || '', 60),
      promptTokens: num(evt.promptTokens),
      completionTokens: num(evt.completionTokens),
      totalTokens: num(evt.totalTokens),
      cachedTokens: num(evt.cachedTokens),
      cost: Number(evt.cost) > 0 ? Number(evt.cost) : 0,
      requestBytes: num(evt.requestBytes),
      responseBytes: num(evt.responseBytes),
      mediaCount: num(evt.mediaCount),
      durationMs: num(evt.durationMs),
      // `false` HARUS bertahan sampai DB. Dulu ditulis `evt.ok === false ? 0 : 1`, dan
      // jobStore menormalkan ulang dengan `row.ok === false` — angka 0 tidak sama dengan
      // false, sehingga semua panggilan gagal tercatat berhasil. Normalkan SEKALI di
      // sini, dan jobStore tetap punya penjaga sendiri untuk pemanggil lain.
      ok: !(evt.ok === false || evt.ok === 0 || evt.ok === '0'),
      errorCode: clip(evt.errorCode || '', 120),
      note: clip(evt.note || (evt.hasMetadata === false ? 'usage tidak dilaporkan provider' : ''), 200),
    };
    const id = store.recordAiUsage(row);
    if (String(env.AI_USAGE_LOG ?? '').trim() === '1') {
      logger.log(`[AiUsage] ${row.site} | ${row.provider || '?'} ${row.model || '?'} | in=${row.promptTokens} out=${row.completionTokens} total=${row.totalTokens} | ${row.ok ? 'ok' : `GAGAL ${row.errorCode}`}`);
    }
    return id;
  } catch (err) {
    warnOnce(logger, err);
    return null;
  }
}

/**
 * Pemanggil sisi Gemini: dipanggilnya SETELAH `await model.generateContent(...)`.
 * Menerima `result` utuh supaya pengambilan `usageMetadata` hanya punya satu bentuk
 * di seluruh repo. Tidak pernah melempar → aman dipakai `await` di tengah loop model.
 *
 * Argumen KEDUA (`{ env, logger }`) diterima dan diteruskan, sama seperti recordAiCall.
 * Pernah fungsi ini hanya menerima SATU objek argumen, sehingga `recordGeminiCall(evt,
 * { env, logger })` mengabaikan env/logger tanpa suara-suara — kill switch AI_USAGE_RECORD
 * dan peredaman log jadi tidak berlaku untuk jalur Gemini.
 */
export async function recordGeminiCall(evt = {}, options = {}) {
  const { jobId = '', site = '', provider = 'Google Gemini', model = '', inputKind = '', mediaCount = 0, result, requestBytes = 0, startedAt = 0, env, logger } = { ...evt, ...options };
  const u = extractGeminiUsage(result?.response ?? result);
  return recordAiCall({
    jobId, site, provider, model, inputKind, mediaCount, requestBytes,
    promptTokens: u.promptTokens,
    completionTokens: u.candidatesTokens,
    totalTokens: u.totalTokens,
    cachedTokens: u.cachedTokens,
    hasMetadata: u.hasMetadata,
    durationMs: startedAt ? Date.now() - startedAt : 0,
    ok: true,
  }, { env, logger });
}

/** Versi kegagalan (kuota/404/timeout) — inilah yang menjelaskan "kok sering fallback". */
export async function recordGeminiFailure(evt = {}, options = {}) {
  const { jobId = '', site = '', provider = 'Google Gemini', model = '', inputKind = '', error, startedAt = 0, env, logger } = { ...evt, ...options };
  const msg = String(error?.message || error || '');
  const codeMatch = msg.match(/ERR[_A-Z0-9]+|status code (\d{3})|(\d{3}) status/gi);
  return recordAiCall({
    jobId, site, provider, model, inputKind,
    durationMs: startedAt ? Date.now() - startedAt : 0,
    ok: false,
    errorCode: clip((codeMatch && codeMatch[0]) || (error?.status ? String(error.status) : '') || msg.split('\n')[0], 120),
    note: clip(msg, 200),
  }, { env, logger });
}

/**
 * Pembungkus `fetch` untuk client OpenAI-compatible. Dipasang di dua tempat konstruksi
 * client (aiClient.js) sehingga MENUTUP SEMUA titik chat tanpa menyentuh fungsinya,
 * termasuk cabang gagal yang selama ini tidak pernah terlihat di mana pun.
 *
 * Aturan keras: response yang dikembalikan HARUS objek asli yang belum dibaca.
 * Body dibaca lewat `.clone()` agar stream pemanggil tidak pernah tersita. Jawaban
 * SSE (`stream: true`) tidak punya body JSON tunggal → dicatat tanpa token, diberi
 * catatan, bukan dipaksa parse.
 */
export function buildInstrumentedFetch({ provider = '', env = process.env, logger = console, fetchImpl = null } = {}) {
  const base = fetchImpl || globalThis.fetch;
  if (typeof base !== 'function') return undefined; // SDK punya fetch default sendiri
  return async function instrumentedFetch(input, init = {}) {
    const startedAt = Date.now();
    const reqBytes = bodyBytes(init?.body);
    const model = modelFromRequestBody(init?.body);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    // Path /chat/completions saja: call lain (embeddings, files) bukan target Lapis 1.
    const isChat = /chat\/completions/.test(url);
    try {
      const res = await base(input, init);
      if (!isChat) return res;
      const out = {
        jobId: '', site: 'Chat Completions', provider, model,
        inputKind: 'chat', requestBytes: reqBytes, responseBytes: 0,
        durationMs: Date.now() - startedAt,
      };
      const ctype = String(res?.headers?.get?.('content-type') || '');
      if (!res?.ok) {
        let detail = '';
        try { detail = clip(await res.clone().text(), 400); } catch {}
        out.ok = false;
        out.errorCode = clip(String(res.status || ''), 120);
        out.note = detail;
      } else if (ctype.includes('event-stream')) {
        out.ok = true;
        out.note = 'jawaban streaming (usage tidak tersedia di Lapis 1)';
      } else {
        let json = null;
        try { json = await res.clone().json(); } catch {}
        const u = extractChatUsage(json);
        Object.assign(out, {
          promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens,
          cost: u.cost, hasMetadata: u.hasMetadata, ok: true,
        });
        out.responseBytes = json ? Buffer.byteLength(JSON.stringify(json), 'utf-8') : 0;
      }
      await recordAiCall(out, { env, logger });
      return res;
    } catch (err) {
      if (isChat) {
        await recordAiCall({
          jobId: '', site: 'Chat Completions', provider, model, inputKind: 'chat',
          requestBytes: reqBytes, durationMs: Date.now() - startedAt,
          ok: false, errorCode: clip(err?.name || err?.code || 'network_error', 120),
          note: clip(err?.message || String(err), 200),
        }, { env, logger });
      }
      throw err; // perilaku terhadap pemanggil tidak boleh berubah sedikit pun
    }
  };
}
