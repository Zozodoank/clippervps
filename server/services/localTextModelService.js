// localTextModelService.js
// ─────────────────────────────────────────────────────────────────────────────
// FASE INFRASTRUKTUR (Keputusan A): klien teks LOKAL untuk menggantikan Gemini di
// tugas SELEKSI + STORYBOARD. Model yang dipakai adalah Qwen2.5-VL-3B yang SUDAH
// berjalan sebagai Oracle visual, diakses lewat endpoint OpenAI-compatible llama-server
// (`/v1/chat/completions`) — BUKAN model baru, sehingga tidak ada unduhan besar ke PC.
//
// Desain keras:
//   • FAIL-CLOSED. Kegagalan apa pun (server mati/timeout/JSON rusak) SELALU
//     mengembalikan `{ ok:false, error }` dan TIDAK pernah melempar. Pemanggil dengan
//     begitu jatuh ke rantai fallback Gemini (perilaku hari ini tak berubah).
//   • SEMUA panggilan jaringan lewat `fetchFn` yang bisa DIINJEKSI (pola sama dengan
//     probeLlamaServerHealth) sehingga unit test berjalan tanpa server/model nyata.
//   • Default MATI. `localTextModelActive` hanya true bila `LOCAL_TEXT_MODEL` terisi
//     DAN flag seleksi/storyboard lokal ON. Tanpa itu modul ini tidak berpengaruh.
//
// Catatan fase: pemanggilan VISUAL nyata (mengirim frame gambar ke bagian mmproj) baru
// diaktifkan & diukur pada fase E2E yang eksplisit ditunda. Fase ini menyiapkan plumbing +
// kontrak JSON + tes mock agar cukup "nyolok model -> nyalakan flag" tanpa ubah kode lagi.
// ─────────────────────────────────────────────────────────────────────────────
import { repairJson } from './ai/aiResponseParsers.js';
import { isLocalSelectionEnabled, isLocalStoryboardEnabled } from '../config/runtimeFlags.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/**
 * Konfigurasi klien teks lokal. Base URL diambil dari LOCAL_LLM_BASE_URL, lalu
 * LLAMA_SERVER_URL (dipakai oracle), lalu default loopback. Dinormalisasi agar
 * `.../v1` dan `.../v1/` sama-sama menghasilkan `<root>/v1/chat/completions`.
 */
export function resolveLocalLlmConfig(env = process.env) {
  const raw = String(env.LOCAL_LLM_BASE_URL || '').trim()
    || String(env.LLAMA_SERVER_URL || '').trim()
    || DEFAULT_BASE_URL;
  // Lepas suffix /v1 (dan /) -> root, lalu pasang kembali path kanonik.
  const root = raw.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
  const timeoutSec = Math.max(5, Number(env.LOCAL_LLM_TIMEOUT_SEC) || 120);
  const temp = Number(env.LOCAL_LLM_TEMPERATURE);
  return {
    completionsUrl: `${root}/v1/chat/completions`,
    healthUrl: `${root}/health`,
    model: String(env.LOCAL_TEXT_MODEL || '').trim(),
    temperature: Number.isFinite(temp) ? temp : 0.2,
    maxTokens: Math.max(256, Number(env.LOCAL_LLM_MAX_TOKENS) || 2048),
    timeoutMs: Math.max(2000, timeoutSec * 1000),
  };
}

/**
 * "Gerbang aktif" jalur teks lokal: butuh NAMA model terisi DAN salah satu flag
 * cakupan ON (seleksi atau storyboard). Ini mencegah modul menembak endpoint/
 * pekerjaan yang belum diizinkan operator, walau llama-server kebetulan hidup.
 */
export function localTextModelActive(env = process.env) {
  const cfg = resolveLocalLlmConfig(env);
  if (!cfg.model) return false;
  return isLocalSelectionEnabled(env) || isLocalStoryboardEnabled(env);
}

/**
 * Kelayakan minimal `parsed` hasil model lokal sebelum diterima hilir. Longgar namun
 * tidak naif: harus berupa objek dan memuat SALAH SATU sinyal struktur yang dikenal
 * pemroses hilir (seleksi/storyboard/script). Kalau tidak layak -> pemanggil fallback.
 */
export function isParsedUsable(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.selectedClips) && parsed.selectedClips.length) return true;
  if (Array.isArray(parsed.clips) && parsed.clips.length) return true;
  if (Array.isArray(parsed.timestamps) && parsed.timestamps.length) return true;
  if (Array.isArray(parsed.scenes) && parsed.scenes.length) return true;
  return Boolean(parsed.status || parsed.voiceoverScript || parsed.detectedProduct || parsed.productHook);
}

/**
 * Satu panggilan chat JSON-only ke llama-server (OpenAI-compatible). Tidak melempar.
 * @returns {Promise<{ok:boolean, parsed:object|null, raw:string, latencyMs:number, error:string, response:object|null, model:string, usage:object|null}>}
 */
export async function chatJson({
  prompt = '',
  system = '',
  messages = null,
  maxTokens = null,
  fetchFn = null,
  timeoutMs = null,
  signal = null,
  env = process.env,
} = {}) {
  const cfg = resolveLocalLlmConfig(env);
  const base = { ok: false, parsed: null, raw: '', latencyMs: 0, error: '', response: null, model: cfg.model, usage: null };
  const f = fetchFn || globalThis.fetch;
  const startedAt = Date.now();
  if (typeof f !== 'function') return { ...base, error: 'no_fetch' };

  const chatMsgs = (Array.isArray(messages) && messages.length)
    ? messages
    : [
        ...(system ? [{ role: 'system', content: String(system) }] : []),
        { role: 'user', content: String(prompt || '') },
      ];

  const effTimeout = Math.max(1000, Number(timeoutMs) || cfg.timeoutMs);
  // Bila pemanggil mengirim signal sendiri, hormati itu; kalau tidak, buat timer internal.
  let ctrl = null;
  let timer = null;
  if (!signal) {
    ctrl = new AbortController();
    timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, effTimeout);
  }
  const useSignal = signal || (ctrl && ctrl.signal);

  try {
    const resp = await f(cfg.completionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: chatMsgs,
        temperature: cfg.temperature,
        max_tokens: Number(maxTokens) || cfg.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: useSignal,
    });
    if (timer) clearTimeout(timer);
    const text = resp && typeof resp.text === 'function' ? String(await resp.text()) : '';
    if (!resp || resp.status !== 200) {
      return { ...base, raw: text.slice(0, 500), latencyMs: Date.now() - startedAt, error: `http_${resp ? resp.status : 'no_resp'}` };
    }
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { /* envelope rusak */ }
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ...base, raw: text.slice(0, 500), latencyMs: Date.now() - startedAt, error: 'empty_content' };
    }
    const parsed = repairJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { ...base, raw: content.slice(0, 500), latencyMs: Date.now() - startedAt, error: 'unparseable_content' };
    }
    return {
      ok: true, parsed, raw: content, latencyMs: Date.now() - startedAt, error: '',
      response: envelope, model: cfg.model, usage: envelope?.usage || null,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return { ...base, latencyMs: Date.now() - startedAt, error: aborted ? 'timeout' : String(err?.message || 'fetch_error') };
  }
}
