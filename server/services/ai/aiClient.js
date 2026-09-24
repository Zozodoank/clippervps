import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '.env.txt'),
  path.join(__dirname, '..', '..', '.env'),
  path.join(__dirname, '..', '..', '.env.txt'),
  path.join(process.cwd(), 'server', '.env'),
  path.join(process.cwd(), 'server', '.env.txt'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '.env.txt'),
];

function cleanEnvKey(key) {
  if (!key) return '';
  let cleaned = String(key).trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function loadEnvFromDisk() {
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = dotenv.parse(raw);
        for (const [key, value] of Object.entries(parsed)) {
          const cleaned = cleanEnvKey(value);
          if (cleaned && !cleaned.startsWith('your_') && !cleaned.endsWith('_here')) {
            process.env[key] = cleaned;
            process.env[key.toUpperCase()] = cleaned;
          }
        }
        // Manual line-by-line fallback parser (handles Android/Google Drive line endings & BOM)
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).replace(/^\uFEFF/, '').trim();
            const v = cleanEnvKey(trimmed.slice(eqIdx + 1));
            if (v && !v.startsWith('your_') && !v.endsWith('_here')) {
              process.env[k] = v;
              process.env[k.toUpperCase()] = v;
            }
          }
        }
      } catch (err) {
        console.warn(`[Peringatan] Gagal membaca file ${envPath}: ${err.message}. (Jika ini di Termux, mungkin masalah izin/permission. Coba jalankan: chmod 644 ${envPath})`);
      }
    }
  }
}

// Daftar model OpenRouter gratis 100% (tidak pernah memotong saldo / dilarang menggunakan openrouter/auto & minimax)
const defaultOpenRouterModels = [
  "openrouter/free",
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
];

function isBannedOpenRouterModel(modelName) {
  const m = String(modelName || '').trim().toLowerCase();
  return (
    m === 'openrouter/auto' ||
    m === 'openrouter:auto' ||
    m === 'auto' ||
    m.endsWith('/auto') ||
    m.endsWith(':auto') ||
    m.includes('minimax')
  );
}

function getEffectiveOpenRouterModels() {
  loadEnvFromDisk();
  const customModel = (process.env.OPENROUTER_MODEL || '').trim();
  const models = [];
  if (customModel && !customModel.startsWith('your_') && !customModel.endsWith('_here')) {
    if (isBannedOpenRouterModel(customModel)) {
      console.warn(`[AIService] ⚠️ Model '${customModel}' DITOLAK / DILARANG karena dapat menguras saldo OpenRouter (berbayar/auto-routing). Menggunakan model gratis (:free) saja.`);
    } else {
      models.push(customModel);
    }
  }
  for (const m of defaultOpenRouterModels) {
    if (!models.includes(m) && !isBannedOpenRouterModel(m)) {
      models.push(m);
    }
  }
  return models;
}

function getOpenRouterKeys(apiKeyOverride) {
  loadEnvFromDisk();
  const keys = [];
  if (apiKeyOverride) {
    const cleaned = cleanEnvKey(apiKeyOverride);
    if (cleaned && !cleaned.startsWith('your_') && !cleaned.endsWith('_here')) {
      keys.push(cleaned);
    }
  }

  const envKeys = Object.keys(process.env).filter(k => k.startsWith('OPENROUTER_API_KEY')).sort();

  for (const k of envKeys) {
    const cleaned = cleanEnvKey(process.env[k]);
    if (cleaned && !cleaned.startsWith('your_') && !cleaned.endsWith('_here')) {
      if (!keys.includes(cleaned)) keys.push(cleaned);
    }
  }
  return keys;
}

let currentOpenRouterKeyIndex = 0;

export const defaultGeminiDirectModels = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash',
];

export function getDirectGeminiApiKey(apiKeyOverride) {
  loadEnvFromDisk();
  if (apiKeyOverride) {
    const cleaned = cleanEnvKey(apiKeyOverride);
    if (cleaned.startsWith('AIzaSy')) return cleaned;
  }
  return cleanEnvKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
}

export function getDirectGeminiClientConfig({ apiKeyOverride } = {}) {
  const apiKey = getDirectGeminiApiKey(apiKeyOverride);
  if (!apiKey || apiKey.startsWith('your_') || apiKey.endsWith('_here')) return null;

  return {
    client: new OpenAI({
      apiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: 35000,
      maxRetries: 0,
    }),
    models: defaultGeminiDirectModels,
    provider: 'Google Gemini Direct',
  };
}

export function getAiClientConfig({ apiKeyOverride, aiProvider } = {}) {
  loadEnvFromDisk();

  const reqProvider = (aiProvider || '').trim().toLowerCase();
  const envEngine = (process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
  const selectedEngine = reqProvider || envEngine || 'gemini';

  // Pola 2: FFmpeg + OpenRouter (hanya jika dipilih secara eksplisit oleh pengguna, bukan fallback)
  if (selectedEngine === 'openrouter') {
    const openRouterKeys = getOpenRouterKeys(apiKeyOverride);
    if (openRouterKeys.length === 0) {
      throw new Error('OPENROUTER_API_KEY belum disetel di server/.env untuk Pola FFmpeg + OpenRouter.');
    }
    const safeIndex = currentOpenRouterKeyIndex % openRouterKeys.length;
    currentOpenRouterKeyIndex++;

    console.log(`[AIService] Initialize OpenRouter Client: Key=${openRouterKeys[safeIndex].substring(0, 10)}... (Models: ${getEffectiveOpenRouterModels().join(', ')})`);

    return {
      client: new OpenAI({
        apiKey: openRouterKeys[safeIndex],
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 120000,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/affiliate-clipper",
          "X-Title": "AI Affiliate Clipper",
        }
      }),
      models: getEffectiveOpenRouterModels(),
      provider: 'OpenRouter',
      keyIndex: safeIndex,
      totalKeys: openRouterKeys.length
    };
  }

  // Pola 1: Gemini File API + Gemini Direct (Jadikan DEFAULT)
  const geminiConf = getDirectGeminiClientConfig({ apiKeyOverride });
  if (geminiConf) {
    console.log(`[AIService] Initialize Direct Google Gemini Client (${geminiConf.models[0]})...`);
    return geminiConf;
  }

  throw new Error('GEMINI_API_KEY belum disetel di server/.env untuk Pola Gemini File API + Gemini.');
}

/**
 * Helper to format AI API errors into clear Indonesian messages.
 */
export function formatApiError(err, modelName = 'AI', provider = 'AI') {
  const status = err.status || err.statusCode;
  const message = err.message || '';

  if (status === 402 || message.toLowerCase().includes('insufficient') || message.toLowerCase().includes('balance') || message.toLowerCase().includes('quota') || message.toLowerCase().includes('credit')) {
    return `Saldo / Kuota ${provider} API Anda tidak mencukupi. Silakan periksa akun ${provider} Anda.`;
  }
  if (status === 402 || message.toLowerCase().includes('more credits') || message.toLowerCase().includes('can only afford')) {
    return `Saldo / Credit OpenRouter Anda tidak mencukupi untuk memproses video ini. Silakan lakukan top-up (Deposit) di https://openrouter.ai/settings/credits.`;
  }
  if (status === 401 || message.toLowerCase().includes('invalid api key') || message.toLowerCase().includes('unauthorized') || message.toLowerCase().includes('api_key_invalid')) {
    return `${provider} API Key tidak valid atau tidak memiliki izin akses. Silakan periksa kembali API Key Anda di file server/.env.`;
  }
  if (status === 429 || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('resource_exhausted')) {
    return `Batas frekuensi permintaan (Rate Limit) ${provider} tercapai. Silakan tunggu beberapa saat dan coba lagi.`;
  }
  if (status === 404 || message.toLowerCase().includes('model_not_found') || message.toLowerCase().includes('does not exist')) {
    return `Semua model fallback gagal. Model terakhir yang dicoba ('${modelName}') tidak tersedia di akun ${provider} Anda.`;
  }
  return `${provider} API Error (${modelName}): ${message}`;
}

export function isQuotaError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  const message = String(err.message || '').toLowerCase();
  return (
    status === 429 ||
    status === 402 ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('kuota') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('saldo') ||
    message.includes('insufficient') ||
    message.includes('credits') ||
    message.includes('tokens')
  );
}

export function isDailyQuotaExhaustedError(err) {
  if (!err) return false;
  const message = String(err.message || '').toLowerCase();
  return (
    message.includes('perday') ||
    message.includes('per day') ||
    message.includes('daily') ||
    message.includes('requests per day') ||
    (message.includes('quota') && message.includes('exceeded') && !message.includes('minute'))
  );
}

/**
 * Resolves an image source (data URI, local file path, or remote URL)
 * into a base64 string and MIME type for AI multimodal vision input.
 */
export async function resolveImageBufferAndBase64(imageSource) {
  if (!imageSource || typeof imageSource !== 'string') return null;

  try {
    const trimmed = imageSource.trim();

    // 1. Data URI (e.g. data:image/jpeg;base64,...)
    if (trimmed.startsWith('data:image/')) {
      const match = trimmed.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        return {
          mimeType: match[1],
          base64: match[2],
          dataUri: trimmed,
        };
      }
    }

    // 2. Local file path
    if (fs.existsSync(trimmed)) {
      const buf = fs.readFileSync(trimmed);
      if (buf.length > 50) {
        const ext = path.extname(trimmed).toLowerCase().replace('.', '');
        const mimeType = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        const b64 = buf.toString('base64');
        return {
          mimeType,
          base64: b64,
          dataUri: `data:${mimeType};base64,${b64}`,
        };
      }
    }

    // 3. Web URL (http / https)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
      const res = await fetch(trimmed, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (res && res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (buf.length > 100) {
          const contentType = res.headers.get('content-type') || 'image/jpeg';
          const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';
          const b64 = buf.toString('base64');
          return {
            mimeType,
            base64: b64,
            dataUri: `data:${mimeType};base64,${b64}`,
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[resolveImageBufferAndBase64] Gagal memuat referensi foto produk: ${err.message}`);
  }
  return null;
}

