// FASE INFRA (Keputusan A): tes MURNI klien teks lokal — TANPA model/ffmpeg/server.
// Semua jaringan lewat `fetchFn` injeksi (pola probeLlamaServerHealth).
import { describe, it, expect, vi } from 'vitest';
import {
  resolveLocalLlmConfig,
  localTextModelActive,
  isParsedUsable,
  chatJson,
} from '../services/localTextModelService.js';

const okEnvelope = (contentObjOrStr) => ({
  status: 200,
  text: async () => JSON.stringify({
    choices: [{ message: { content: typeof contentObjOrStr === 'string' ? contentObjOrStr : JSON.stringify(contentObjOrStr) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }),
});

describe('resolveLocalLlmConfig — penurunan base URL & normalisasi', () => {
  it('LOCAL_LLM_BASE_URL menang atas LLAMA_SERVER_URL', () => {
    const cfg = resolveLocalLlmConfig({
      LOCAL_LLM_BASE_URL: 'http://10.0.0.9:9999',
      LLAMA_SERVER_URL: 'http://127.0.0.1:8080/v1',
      LOCAL_TEXT_MODEL: 'qwen-test',
    });
    expect(cfg.completionsUrl).toBe('http://10.0.0.9:9999/v1/chat/completions');
    expect(cfg.healthUrl).toBe('http://10.0.0.9:9999/health');
    expect(cfg.model).toBe('qwen-test');
  });

  it('tanpa LOCAL_LLM_BASE_URL turun ke LLAMA_SERVER_URL; tanpa keduanya default loopback', () => {
    expect(resolveLocalLlmConfig({ LLAMA_SERVER_URL: 'http://127.0.0.1:8080/v1' }).completionsUrl)
      .toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(resolveLocalLlmConfig({}).completionsUrl)
      .toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('normalisasi /v1, /v1/ dan root tanpa trailing menghasilkan URL yang sama', () => {
    const a = resolveLocalLlmConfig({ LOCAL_LLM_BASE_URL: 'http://h:1234/v1' }).completionsUrl;
    const b = resolveLocalLlmConfig({ LOCAL_LLM_BASE_URL: 'http://h:1234/v1/' }).completionsUrl;
    const c = resolveLocalLlmConfig({ LOCAL_LLM_BASE_URL: 'http://h:1234' }).completionsUrl;
    expect(a).toBe('http://h:1234/v1/chat/completions');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('nama model di-trim; kosong = string kosong (gerbang mati)', () => {
    expect(resolveLocalLlmConfig({ LOCAL_TEXT_MODEL: '  qwen 2.5 vl  ' }).model).toBe('qwen 2.5 vl');
    expect(resolveLocalLlmConfig({}).model).toBe('');
  });

  it('temperature default 0.2; nilai eksplisit dihormati', () => {
    expect(resolveLocalLlmConfig({}).temperature).toBe(0.2);
    expect(resolveLocalLlmConfig({ LOCAL_LLM_TEMPERATURE: '0' }).temperature).toBe(0);
    expect(resolveLocalLlmConfig({ LOCAL_LLM_TEMPERATURE: '0.7' }).temperature).toBe(0.7);
  });

  it('timeoutMs punya floor 2000ms dan mengikuti LOCAL_LLM_TIMEOUT_SEC', () => {
    expect(resolveLocalLlmConfig({}).timeoutMs).toBe(120000);           // default 120s
    expect(resolveLocalLlmConfig({ LOCAL_LLM_TIMEOUT_SEC: '30' }).timeoutMs).toBe(30000);
    expect(resolveLocalLlmConfig({ LOCAL_LLM_TIMEOUT_SEC: '1' }).timeoutMs).toBe(5000); // floor 5s
  });
});

describe('localTextModelActive — gerbang kebijakan (model + flag)', () => {
  it('MATI saat LOCAL_TEXT_MODEL kosong walau kedua flag ON', () => {
    expect(localTextModelActive({ LOCAL_TEXT_MODEL: '', USE_LOCAL_SELECTION: '1', USE_LOCAL_STORYBOARD: '1' })).toBe(false);
  });

  it('MATI saat model terisi tapi kedua flag OFF (default produksi hari ini)', () => {
    expect(localTextModelActive({ LOCAL_TEXT_MODEL: 'qwen-test' })).toBe(false);
    expect(localTextModelActive({ LOCAL_TEXT_MODEL: 'qwen-test', USE_LOCAL_SELECTION: '0', USE_LOCAL_STORYBOARD: 'false' })).toBe(false);
  });

  it('AKTIF saat model terisi + flag seleksi ATAU storyboard ON (menerima "1" dan "true")', () => {
    expect(localTextModelActive({ LOCAL_TEXT_MODEL: 'qwen-test', USE_LOCAL_SELECTION: '1' })).toBe(true);
    expect(localTextModelActive({ LOCAL_TEXT_MODEL: 'qwen-test', USE_LOCAL_STORYBOARD: 'true' })).toBe(true);
  });
});

describe('isParsedUsable — kelayakan minimal parsed sebelum diterima hilir', () => {
  it('menolak null, array, dan objek kosong', () => {
    expect(isParsedUsable(null)).toBe(false);
    expect(isParsedUsable(undefined)).toBe(false);
    expect(isParsedUsable([1, 2])).toBe(false);
    expect(isParsedUsable({})).toBe(false);
  });

  it('menerima sinyal struktur: selectedClips/timestamps/scenes terisi atau status', () => {
    expect(isParsedUsable({ selectedClips: [{ start: 1 }] })).toBe(true);
    expect(isParsedUsable({ timestamps: [{ t: 2 }] })).toBe(true);
    expect(isParsedUsable({ scenes: [{ s: 1 }] })).toBe(true);
    expect(isParsedUsable({ status: 'select' })).toBe(true);
    expect(isParsedUsable({ voiceoverScript: 'halo' })).toBe(true);
  });

  it('menolak objek dengan array kosong dan tanpa sinyal lain', () => {
    expect(isParsedUsable({ selectedClips: [], timestamps: [], scenes: [] })).toBe(false);
  });
});

describe('chatJson — fail-closed penuh, TIDAK pernah melempar', () => {
  it('sukses: 200 + content JSON -> { ok:true, parsed, usage }', async () => {
    const r = await chatJson({
      prompt: 'buat rencana',
      env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async () => okEnvelope({ selectedClips: [{ startSeconds: 3, duration: 8 }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.selectedClips).toHaveLength(1);
    expect(r.error).toBe('');
    expect(r.model).toBe('qwen-test');
    expect(r.usage?.total_tokens).toBe(30);
  });

  it('mengirim body OpenAI-compatible (model, messages, response_format json_object)', async () => {
    let seen = null;
    await chatJson({
      prompt: 'P',
      system: 'S',
      env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return okEnvelope({ status: 'ok' }); },
    });
    expect(seen.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(seen.body.model).toBe('qwen-test');
    expect(seen.body.response_format).toEqual({ type: 'json_object' });
    expect(seen.body.messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(seen.body.messages[1]).toEqual({ role: 'user', content: 'P' });
  });

  it('non-200 -> { ok:false, error:"http_503" } tanpa melempar', async () => {
    const r = await chatJson({
      prompt: 'P',
      env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async () => ({ status: 503, text: async () => 'server sibuk' }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('http_503');
    expect(r.raw).toBe('server sibuk');
  });

  it('content kosong -> error "empty_content"; content skalar non-objek -> "unparseable_content"', async () => {
    const empty = await chatJson({
      prompt: 'P', env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async () => okEnvelope('   '),
    });
    expect(empty.ok).toBe(false);
    expect(empty.error).toBe('empty_content');
    const scalar = await chatJson({
      prompt: 'P', env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async () => okEnvelope('"hanya-string"'),
    });
    expect(scalar.ok).toBe(false);
    expect(scalar.error).toBe('unparseable_content');
  });

  it('fetch melempar AbortError (signal pemanggil sudah abort) -> error "timeout"', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await chatJson({
      prompt: 'P',
      signal: ctrl.signal,
      env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async (url, init) => {
        if (init?.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        return okEnvelope({ status: 'ok' });
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  });

  it('fetch melempar error jaringan -> { ok:false } dengan pesan, tanpa melempar', async () => {
    const r = await chatJson({
      prompt: 'P', env: { LOCAL_TEXT_MODEL: 'qwen-test' },
      fetchFn: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8080'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('tanpa fetch sama sekali -> error "no_fetch" (lingkungan tertanam tanpa jaringan)', async () => {
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', undefined);
    try {
      const r = await chatJson({ prompt: 'P', env: { LOCAL_TEXT_MODEL: 'qwen-test' } });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('no_fetch');
    } finally {
      vi.unstubAllGlobals();
      void prev;
    }
  });
});
