// ============================================================================
// ANTI-PLAGIARISM PARAPHRASE (Fase 2) — model TEKS memparafrase transkrip
// voice-over sumber per beat, supaya TIDAK plagiat 100% dari kreator asal,
// dengan MENJAGA jumlah kata agar durasi TTS tetap ≈ durasi beat sumber.
//
// Alur: beats (dari audioBeatService) → teks model (Gemini Flash diutamakan,
// fallback OpenRouter:free) → tiap beat dapat field `reworded` → nanti
// digabung jadi naskah untuk Gemini TTS.
//
// Modul MANDIRI, di-backing flag yang sama (AUDIO_DRIVEN_SCENES). Belum
// disambungkan ke worker live.
// ============================================================================
import { getAiClientConfig } from './ai/aiClient.js';

export function countWords(text = '') {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// Penjaga rasio jumlah kata: hasil parafrase harus mendekati panjang asli agar
// timing adegan tidak melar. Deviasi > tolerance → tandai (pemanggil putuskan).
export function wordCountDrift(original = '', reworded = '', tolerance = 0.3) {
  const a = countWords(original);
  const b = countWords(reworded);
  if (a === 0) return { drift: b === 0 ? 0 : 1, withinTolerance: b === 0 };
  const drift = Math.abs(b - a) / a;
  return { drift: +drift.toFixed(3), withinTolerance: drift <= tolerance };
}

function buildSystemPrompt() {
  return `Kamu adalah penulis naskah voice-over untuk video affiliate pendek (Reels/Shorts/TikTok) berbahasa Indonesia.
Tugasmu MEMARAfrase setiap baris narasi sumber supaya TIDAK menjiplak persis kata-kata kreator asal, NAMUN:
1. MAKNA, klaim fitur, dan informasi produk WAJIB tetap sama. Jangan menambah fakta baru, jangan mengarang harga/spesifikasi yang tidak ada di teks asli.
2. PANJANG tiap hasil harus SANGAT DEKAT dengan aslinya (jumlah kata ± 20%), karena audio akan dipotong mengikuti durasi beat asli. Jangan membuat jauh lebih panjang atau pendek.
3. Ganti struktur kalimat & sinonim, tetap terdengar natural, luwes, dan promosional untuk penutur bahasa Indonesia.
4. PERTAHANKAN istilah/angka penting (nama produk, angka, harga) apa adanya.
5. Keluarkan HANYA JSON valid: {"items":[{"index":<angka>,"text":"<hasil parafrase>"}]} dengan index persis sama seperti input, tanpa komentar tambahan.`;
}

// Safely parse a possibly-fenced / trailing-comma JSON blob from a text model.
function parseModelJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

// Model list untuk parafrase teks. Gemini Flash diutamakan bila engine gemini;
// OpenRouter memakai daftar gratis yang sudah dikurasi aiClient.
function resolveModelList(config, env = process.env) {
  const override = (env.ANTIPLAGIAT_MODEL || '').trim();
  if (override) return [override, ...config.models.filter((m) => m !== override)];
  if (config.provider === 'OpenRouter') return config.models;
  // Gemini: prioritaskan varian flash untuk ketepatan teks + biaya hemat.
  const flash = config.models.filter((m) => /flash/i.test(m));
  const rest = config.models.filter((m) => !/flash/i.test(m));
  return [...flash, ...rest];
}

/**
 * Parafrase daftar beat untuk anti-plagiat.
 * @param {Array<{start:number,end:number,text:string}>} beats
 * @returns {Promise<{ok:boolean, error?:string, beats?:Array}>}
 *          beat hasil punya tambahan `reworded` + `drift`.
 */
export async function paraphraseBeats({ beats = [], apiKey, aiProvider, logger = console, env = process.env } = {}) {
  if (!beats.length) return { ok: true, beats: [] };

  // Engine: khusus anti-plagiat bisa dioverride, default ikut engine utama.
  const provider = (aiProvider || env.ANTIPLAGIAT_AI_ENGINE || '').trim();
  let config;
  try {
    config = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider: provider });
  } catch (err) {
    return { ok: false, error: `Gagal inisialisasi klien teks anti-plagiat: ${err.message}` };
  }

  const modelList = resolveModelList(config, env);
  const items = beats.map((b, i) => ({ index: i, text: (b.text || '').trim() }));
  const userPrompt = `Parafrase daftar narasi berikut sesuai aturan. Kembalikan JSON {"items":[{"index","text"}]}.\n\nINPUT:\n${JSON.stringify({ items }, null, 0)}`;

  const tolerance = Number(env.ANTIPLAGIAT_WORD_TOLERANCE) || 0.3;

  for (let attempt = 0; attempt < modelList.length; attempt++) {
    const model = modelList[attempt];
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
      const response = await config.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 3000,
      });

      const msg = response.choices?.[0]?.message;
      const raw = (msg?.content && msg.content.trim()) ? msg.content : (msg?.reasoning || '');
      const parsed = parseModelJson(raw);
      const returned = Array.isArray(parsed?.items) ? parsed.items : null;
      if (!returned) throw new Error('Model mengembalikan JSON tanpa array "items".');

      const byIndex = new Map(returned.map((it) => [Number(it.index), String(it.text || '').trim()]));
      const out = beats.map((b, i) => {
        const reworded = byIndex.get(i) || b.text;
        const wc = wordCountDrift(b.text, reworded, tolerance);
        return { ...b, reworded: wc.withinTolerance ? reworded : (reworded || b.text), drift: wc.drift, keptLength: wc.withinTolerance };
      });

      logger.log(`[AntiPlagiat] ${model} memparafrase ${out.length} beat.`);
      return { ok: true, provider: config.provider, model, beats: out };
    } catch (err) {
      const status = err.status || err.statusCode;
      const m = (err.message || '').toLowerCase();
      const isAuth = status === 401 || status === 402 || m.includes('balance') || m.includes('credit');
      logger.warn(`[AntiPlagiat] Model ${model} gagal (${status || err.message}). ${attempt < modelList.length - 1 ? 'Coba model berikutnya...' : 'Kehabisan model.'}`);
      if (isAuth) break; // auth/billing: model lain tak akan menolong
      if (attempt === modelList.length - 1) {
        return { ok: false, error: `Semua model parafrase gagal. Terakhir (${model}): ${err.message}` };
      }
    }
  }
  return { ok: false, error: 'Parafrase anti-plagiat gagal (auth/kuota).' };
}

// Gabung beat terparafrase menjadi satu naskah linear untuk Gemini TTS.
// Memakai `reworded` bila ada,Else fallback ke teks asli.
export function beatsToScript(beats = []) {
  return beats
    .map((b) => (b.reworded && b.reworded.trim()) || (b.text || '').trim())
    .filter(Boolean)
    .join(' ');
}
