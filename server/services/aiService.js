import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { getMediaDurationSec } from './videoRenderer.js';
import { saveToEnglishDictionary } from './dictionaryService.js';
import { trackBandwidth } from './bandwidthTracker.js';
import { extractCoreProductInfo, isBulkyOrUnsuitableProduct } from './discoveryService.js';
import { getNichePreset } from '../config/nichePresets.js';

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

function getAiClientConfig({ apiKeyOverride, aiProvider } = {}) {
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

const DEFAULT_REFRAME = {
  focusX: 0.5,
  focusY: 0.5,
  cropStrategy: 'faceless_product_hands_avoid_creator_text',
  renderMode: 'stage_80',
  avoidTextZones: [],
  avoidFaceZones: ['top', 'upper_middle'],
  faceSafety: true,
  notes: '',
};

/**
 * Helper to format AI API errors into clear Indonesian messages.
 */
function formatApiError(err, modelName = 'AI', provider = 'AI') {
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

export function truncateProductDescription(desc = '', maxChars = 500) {
  const clean = String(desc || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
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

/**
 * Generates a dynamic, high-converting Indonesian affiliate video hook for the first 3 seconds.
 * Provides distinct natural angles for both Kitchen and Gadget/Smartphone niches and completely avoids repetitive robotic phrasing or the slang "fix".
 */
export function getDynamicProductHookFallback(productName = '', niche = 'kitchen_tools') {
  const cleanName = (productName || '').trim() || 'produk ini';
  const preset = getNichePreset(niche);
  if (preset.id === 'gadget_smartphone') {
    const gadgetHooks = [
      `Cari HP spek gahar harga ramah kantong? Kenalan dulu sama ${cleanName}!`,
      `Layar AMOLED 120Hz semulus ini, performanya juara buat harian: ${cleanName}!`,
      `Budget pas-pasan tapi pengen HP kamera jernih & gaming lancar? Cek ${cleanName}!`,
      `HP sekeren ini harganya bikin kaget, worth it banget: ${cleanName}!`,
      `Desain mewah, baterai awet, multitasking mulus: ${cleanName}!`,
      `Jangan salah beli HP! Di kelas harganya, ${cleanName} ini juaranya!`,
      `Kamera stabil hasil tajam, ini dia HP idaman: ${cleanName}!`,
      `Upgrade HP tanpa boncos, fitur lengkap banget di ${cleanName}!`
    ];
    return gadgetHooks[Math.floor(Math.random() * gadgetHooks.length)];
  }

  // 30 Curated Dynamic Non-AI Hooks for Kitchen Tools (Tanpa kata "alat dapur" & tanpa kata "Shopee"):
  if (preset.curatedHooks && preset.curatedHooks.length > 0) {
    const randIdx = Math.floor(Math.random() * preset.curatedHooks.length);
    return preset.curatedHooks[randIdx];
  }

  const hooks = [
    `Emak-emak wajib nonton! Ini solusi biar area masak enggak berantakan lagi.`,
    `Capek banget tiap hari harus bersihin percikan minyak pas goreng? Sini berkumpul.`,
    `Bikin sarapan jadi 2x lebih cepat cuma modal barang receh yang satu ini.`,
    `Buat yang punya ruangan sempit, barang ini bener-bener penyelamat tempat banget!`,
    `Solusi cerdas buat yang malas potong-potong bahan masakan sampai nangis.`,
    `Transformasi meja masak yang berantakan jadi rapi instan cuma pakai ini.`,
    `Jangan checkout barang lain sebelum kalian lihat fungsi benda ini!`,
    `Barang receh online tapi gunanya bener-bener di luar nalar pas dipakai.`,
    `Bisa tebak gak benda sekecil ini fungsinya buat apa?`,
    `Satu trik rahasia yang disembunyikin para ibu rumah tangga biar urusan masak cepat beres.`
  ];
  const randIdx = Math.floor(Math.random() * hooks.length);
  return hooks[randIdx];
}

/**
 * Builds dynamic Acceptance & Rejection Criterion #1 tailored to the active niche.
 */
export function buildNicheProductCriterion(niche = 'kitchen_tools', coreNoun = '', effectiveTitle = '', isVideoFirstMode = false, effectiveDesc = '') {
  const preset = getNichePreset(niche);
  if (preset.id === 'gadget_smartphone') {
    return `CRITERION 1: PRODUCT IDENTIFICATION & VALIDATION (SMARTPHONE & GADGET NICHE)
- Target Gadget / Smartphone: "${coreNoun}" (Listing/Topic: "${effectiveTitle}")
${effectiveDesc ? `- Description: "${effectiveDesc}"` : ''}
- PURPOSE: Identify the physical smartphone or gadget demonstrated and verify it is suitable for a 9:16 vertical affiliate video ad.
- ACCEPTANCE STANDARD:
  * ACCEPT smartphone review B-roll, hands-on physical demonstrations, screen 120Hz smooth scrolling, gaming tests in hands, and unboxing B-roll (cherry-pick active usage/chassis shots, discard cardboard packaging and paper manuals).
  * CRITICAL MANDATE - 100% PHYSICAL SMARTPHONE HARDWARE VISIBILITY:
    Every selected clip/frame MUST show the physical smartphone hardware unit itself (hands holding the device, bezel, back cover, camera bump, or screen actively touched by fingers).
  * In "detectedProduct", output the specific model name (e.g. "Infinix Note 40 Pro", "Poco X6 5G", "Samsung Galaxy A15 5G", "Redmi Note 13 Pro 5G").
  * In "detectedBrand", output the brand (e.g. "Infinix", "Xiaomi", "Samsung", "Poco", "Realme", "Vivo", "Tecno").
- REJECTION STANDARD:
  * ZERO SCENERY / OUTDOOR PHOTO B-ROLL BAN: REJECT IMMEDIATELY if the video or clips display random outdoor scenery, night cityscapes, skyscrapers, trees, roads, or sample camera shots where the physical smartphone unit is ABSENT! A smartphone affiliate ad must showcase the actual physical smartphone hardware, not random scenery photos!
  * PILLARBOX & BLACK BARS BAN: REJECT IMMEDIATELY if the video has vertical black bars (pillarbox) on the left and right sides.
  * ROTATED / SIDEWAYS 90° FOOTAGE BAN: REJECT IMMEDIATELY if the video or gameplay is rotated sideways 90 degrees.
  * REJECT IF TALKING HEAD / PODCAST: REJECT if the video is pure talking-head presenter without hands-on close-up B-roll of the physical smartphone.
  * REPAIR / SERVICE / TEARDOWN BAN: REJECT IMMEDIATELY (status: 'reject') if the video is about repairing, servicing, fixing broken glass/LCD, replacing batteries, or soldering/disassembly (servis, bongkar, hp rusak, mati total, ganti lcd). Video must showcase a working pristine smartphone in action!
  * BULKY APPLIANCES & VEHICLES BAN: REJECT if the video is about large appliances, TVs, monitors, refrigerators, furniture, cars, or motorcycles.
  * REJECT if compilation/haul of multiple random non-gadget items.
  * REJECT food, cooking recipes, fashion, or kitchen tools.`;
  }

  // Default: Kitchen tools
  if (isVideoFirstMode) {
    return `CRITERION 1: VIDEO-FIRST PRODUCT IDENTIFICATION & VALIDATION (COMPACT KITCHEN TOOLS NICHE)
- Discovery Topic / Keyword: "${coreNoun}"
- PURPOSE: This video was retrieved via video search engine. Your task is to identify the physical kitchen tool/gadget demonstrated and verify it is suitable for an affiliate video ad.
- VIDEO-FIRST REVERSE DISCOVERY RULE (MANDATORY):
  * IN VIDEO-FIRST MODE, THE VIDEO DEFINES THE PRODUCT!
  * If the video demonstrates ANY compact, useful tabletop or handheld kitchen tool/gadget with clean hands-on action (e.g. food choppers, mandoline slicers, peelers, garlic presses, dumpling/waffle/egg molds, rolling knife sharpeners, scissors, oil pots, dispensers, graters, mini sealers, etc.), ALWAYS ACCEPT THE VIDEO (status: 'accept', isExactProductMatch: true).
  * In "detectedProduct", output the clean, specific Indonesian name of the product shown in the video (e.g. "Chopper Manual Tarik Serbaguna", "Alat Pengupas Apel Putar", "Batu Asahan Pisau Roll", "Gunting Dapur Stainless SK5", "Pemotong Sayur Mandoline Slicer", "Garlic Press Rocker Stainless", "Alat Pembuat Dumpling Pastel").
  * In "detectedBrand", output any brand name visible on the physical body (or "none").
  * DO NOT REJECT merely because the detected product differs from the initial search keyword. The backend will automatically link the detected product to Shopee!
- REJECTION STANDARD:
  * STRICT KITCHEN NICHE ONLY: REJECT IMMEDIATELY if it demonstrates large furniture, big cabinets (lemari, kabinet, kitchen set), big shelving racks (rak piring besar, rak susun standing besar, rak wastafel), or bulky large appliances (kulkas, mesin cuci, meja makan).
  * INDUSTRIAL / FACTORY / MANUFACTURING PROCESS BAN: REJECT IMMEDIATELY (status: 'reject') if the video demonstrates factory assembly lines, mass industrial manufacturing, metal stamping, molten plastic injection molding, machinery fabrication, or industrial factory workers ("pabrik", "proses pembuatan", "factory", "manufacturing").
  * BULKY OUTDOOR GRILLS / BLACKSTONE BAN: REJECT IMMEDIATELY (status: 'reject') if the demonstrated product is a large outdoor griddle/grill (Blackstone, Weber, smoker, BBQ).
  * REJECT if compilation / haul of multiple random gadgets instead of demonstrating this product.
  * REJECT if non-kitchen unrelated items (pakaian, kosmetik, sepatu, mainan).
  * STRICT NO-FOOD / NO-DRINK / NO-RECIPE: REJECT IMMEDIATELY (status: 'reject') if the video is purely about cooking food recipes or mukbang without focusing on a specific compact kitchen tool/gadget.
  * STRICT NO-TUTORIAL / NO-CARA / NO-DIY BAN: REJECT IMMEDIATELY (status: 'reject') if the video is a tutorial ("cara membuat", "cara memasak", "tutorial"), DIY crafting, or repair tutorial.
  * STRICT SINGLE PRODUCT ONLY (NO SET / NO PACK / NO BUNDLE): REJECT IMMEDIATELY (status: 'reject') if the product is an arbitrary combo pack, multi-item set, bundle, or multi-piece kit.`;
  }

  return `CRITERION 1: FUNCTIONAL & PHYSICAL PRODUCT MATCH (STRICT COMPACT KITCHEN TOOLS NICHE)
- Target Product Category / Model: "${coreNoun}" (Listing: "${effectiveTitle}")
${effectiveDesc ? `  (Product Description: "${effectiveDesc}")` : ''}
- Does the item demonstrated in the video physically and functionally match this product category/tool?
- ACCEPTANCE STANDARD & WHITE-LABEL OEM TOLERANCE (CRITICAL MANDATE):
  * Products in the kitchen tools niche are generic OEM / white-label commodities sold across Shopee under dozens of brand names, colors, and minor styling variations.
  * FUNCTIONAL FAMILY MATCH IS SUFFICIENT: If the tool demonstrated performs the same primary function as "${coreNoun}" (e.g. manual pull chopper vs rotary chopper, mandoline slicer with different blade variations, fruit peeler with different handle color, garlic press rocker vs squeeze press, dumpling maker, kitchen scissors SK5, roll knife sharpener, oil pot), ACCEPT IT (status: 'accept', isExactProductMatch: true).
  * ZERO REJECTION FOR COSMETIC/OEM DIFFERENCES: NEVER reject a video because of color (e.g. green vs grey vs red vs white), handle contour, absence/presence of printed brand logos, or minor material styling variations.
  * KITCHEN MOLDS, SCISSORS, PEELERS & SHARPENERS ARE 100% WELCOME: Dumpling molds (cetakan pastel/dumpling), tamagoyaki pans, rolling knife sharpeners, and kitchen scissors SK5 are core viral kitchen products and are FULLY ACCEPTED!
- REJECTION STANDARD:
  * STRICT KITCHEN NICHE ONLY: REJECT IMMEDIATELY if it is a completely DIFFERENT product category, non-kitchen item, or random household gadget (pakaian, kosmetik, sepatu, hp).
  * BULKY OUTDOOR GRILLS / BLACKSTONE BAN: REJECT IMMEDIATELY (status: 'reject') if the demonstrated product is a large outdoor griddle/grill.
  * BULKY / FRAME-FILLING FURNITURE & BIG RACKS BAN: REJECT IMMEDIATELY if large furniture, cabinet, or big standing rack.
  * INDUSTRIAL / FACTORY / MANUFACTURING PROCESS BAN: REJECT IMMEDIATELY (status: 'reject') if the video demonstrates factory assembly lines, mass industrial manufacturing, or machinery fabrication.
  * REJECT IMMEDIATELY if it is a multi-product haul/compilation video.
  * REPAIR / SERVICE / DISASSEMBLY BAN: REJECT IMMEDIATELY (status: 'reject') if the video is about repairing, servicing, or disassembling broken items.
  * STRICT NO-FOOD / NO-DRINK / NO-RECIPE: REJECT IMMEDIATELY (status: 'reject') if the video is purely cooking recipes without demonstrating a compact tool.
  * STRICT NO-TUTORIAL / NO-CARA / NO-DIY BAN: REJECT IMMEDIATELY (status: 'reject') if tutorial, DIY, or repair.
  * STRICT SINGLE PRODUCT ONLY (NO SET / NO PACK / NO BUNDLE): REJECT IMMEDIATELY (status: 'reject') if arbitrary combo pack or bundle.`;
}

/**
 * Builds dynamic Criterion #4 (Face, Talking-Head & Motion/Still-Photo Rules) tailored to the active niche.
 */
export function buildFaceAndMotionCriterion(niche = 'kitchen_tools', clipSec = 4.8) {
  const preset = getNichePreset(niche);
  if (preset.id === 'gadget_smartphone') {
    return `CRITERION 4: VLOGGER TALKING-HEAD BAN & PHYSICAL HARDWARE FOCUS (SMARTPHONE NICHE)
- MANDATORY SHORT-FORM VIDEO STANDARD:
  * This is an automated smartphone showcase video. The core focus MUST be physical hardware B-roll: hands holding the device, bezel, back cover, 120Hz scrolling, physical gaming in hands.
  * STRICT BAN ON VLOGGER TALKING-HEAD IN STUDIO:
    DILARANG KERAS memilih klip presenter/vlogger berbicara menghadap kamera di studio (talking-head intro/outro/talking scenes).
  * ZERO TOLERANCE FOR SCENERY OR RANDOM B-ROLL WITHOUT THE SMARTPHONE:
    DILARANG KERAS memilih foto/video pemandangan alam, gedung/kota malam, langit, jalan raya, atau sample foto kamera yang HANYA menampilkan objek pemandangan tanpa fisik smartphone di tangan! Setiap cuplikan WAJIB menampakkan unit smartphone fisik yang sedang dipegang atau dioperasikan tangan.
  * SLIDESHOW BAN:
    DILARANG KERAS memilih frame atau klip yang berupa foto diam (slideshow statis)! Klip wajib memiliki gerakan fisik nyata (tangan memegang, memutar bodi HP, scrolling layar, swipe jari, tombol ditekan).
  * REJECT ONLY IF:
    The video is purely a vlogger talking to the camera without hands-on phone B-roll, or lacks at least 6 distinct smartphone physical hardware B-roll clips.
  * In rejection output, set reason to: "Menampilkan vlogger talking-head studio tanpa B-roll fisik HP yang cukup"`;
  }

  return `CRITERION 4: ZERO FACES & ZERO HUMANS (STRICT 100% FACELESS HANDS-ONLY TABLETOP CLOSE-UP)
- MANDATORY AFFILIATE STANDARD:
  * This is an automated affiliate product video advertisement. It MUST be 100% faceless hands-on product demonstration on a tabletop or countertop (hands/fingers operating the tool close-up).
  * ZERO TOLERANCE FOR FACES, HEADS, OR HUMAN BODIES:
    DILARANG KERAS menampilkan wajah, kepala, rambut, mata, mulut, dagu, leher, atau tubuh/torso manusia di dalam frame 9:16 pada detik-detik klip yang dipilih, BAHKAN UNTUK 0.5 DETIK SEKALI PUN!
  * HANYA pilih timestamps ketika kamera menyorot CLOSE-UP produk fisik yang sedang dioperasikan oleh jari/tangan di atas meja atau alas kerja.
- SLIDESHOW & DIGITAL ZOOM (KEN BURNS) BAN:
  * DILARANG KERAS memilih frame atau klip yang berupa foto/gambar diam (slideshow katalog) dengan efek zoom perlahan (Ken Burns effect)!
  * Klip WAJIB memiliki gerakan fisik dinamis dan nyata (tangan mengoperasikan produk, bahan terpotong/terkupas, cairan mengalir, tombol ditekan, motor berputar).
- REJECT IMMEDIATELY (status: 'reject') IF:
  * The video is a personal vlog, cooking recipe vlog, food show, talking-head, mukbang, or presenter-led show where a person is speaking or presenting in the kitchen.
  * The video does NOT contain at least 10 distinct, satisfying, 100% faceless hands-only tabletop action clips (${clipSec}s each).
  * In rejection output, set reason to: "Menampilkan wajah atau presenter manusia (wajib 100% faceless peragaan tangan)"`;
}

/**
 * Stage 1 Jalur 1: Analyzes a public YouTube video directly via Google Gemini API using native video streaming (fileUri).
 * Zero download on local server, zero FFmpeg frame extraction, zero base64 payload.
 */
export async function analyzeYouTubeVideoWithGemini({
  youtubeUrl,
  apiKey,
  productTitle,
  productDescription,
  productImage = '',
  shopeeLink,
  sceneDuration = 3.3,
  allowFallbackClips = false,
  totalDuration = 600,
  introCutoffSec = 0,
  discardedFaceTimestamps = [],
  discardedViolationTimestamps = [],
  cleanTimeWindows = [],
  verifiedSegments = [],
  isVideoFirst = false,
  niche = 'kitchen_tools',
  onProgress = () => { },
}) {
  const geminiKey = getDirectGeminiApiKey(apiKey);
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY belum disetel di server/.env untuk Google Gemini.');
  }

  if (!youtubeUrl) {
    throw new Error('URL YouTube tidak valid.');
  }

  const clipSec = Math.max(2.5, Math.min(5.0, Number(sceneDuration) || 3.3));
  const isVideoFirstMode = Boolean(isVideoFirst || !shopeeLink);
  const prodInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreNoun = prodInfo.coreProductNoun || 'Produk Praktis';
  const effectiveTitle = prodInfo.cleanTitle || (productTitle || '').trim() || coreNoun;
  const effectiveDesc = (productDescription || '').trim().slice(0, 500);

  let refImageInlineData = null;
  if (productImage) {
    try {
      const resolvedImg = await resolveImageBufferAndBase64(productImage);
      if (resolvedImg?.base64) {
        refImageInlineData = {
          inlineData: {
            data: resolvedImg.base64,
            mimeType: resolvedImg.mimeType || 'image/jpeg',
          },
        };
        console.log(`[Gemini YouTube Stream] Menambahkan foto referensi produk Shopee (${resolvedImg.mimeType}) untuk verifikasi visual AI.`);
      }
    } catch (imgErr) {
      console.warn(`[Gemini YouTube Stream] Gagal memuat foto referensi produk: ${imgErr.message}`);
    }
  }

  onProgress({
    step: 'gemini_vision',
    message: isVideoFirstMode
      ? `Google Gemini 3.6 Flash menganalisa stream video YouTube (Mode: Video-First Discovery)...`
      : (refImageInlineData
          ? 'Google Gemini 3.6 Flash menganalisa stream video YouTube & membandingkan dengan foto produk Shopee...'
          : 'Google Gemini 3.6 Flash menganalisa stream video langsung dari YouTube (0 MB kuota lokal)...'),
    progress: 46,
  });

  const allViolationTimestamps = Array.from(new Set([
    ...(Array.isArray(discardedFaceTimestamps) ? discardedFaceTimestamps : []),
    ...(Array.isArray(discardedViolationTimestamps) ? discardedViolationTimestamps : [])
  ])).map(t => Math.round(t)).sort((a, b) => a - b);

  const violationBlacklistWarning = allViolationTimestamps.length > 0
    ? `\nCRITICAL BLACKLIST (DETEKSI AI LOKAL: WAJAH, TEKS OVERLAY, PILLARBOX, DOKUMEN MANUAL): Frame visual pada detik [${allViolationTimestamps.join(', ')}s] terdeteksi melanggar aturan kualitas (wajah presenter / teks overlay / unboxing manual / pillarbox). DILARANG KERAS memilih timestamps dalam rentang +-3 detik dari detik-detik ini!\n`
    : '';

  const cleanWindowsDirective = Array.isArray(cleanTimeWindows) && cleanTimeWindows.length > 0
    ? `\nCRITICAL MANDATE (VERIFIED CLEAN TEMPORAL SEGMENTS): AI Local Gatekeeper telah memverifikasi segmen-segmen waktu bersih berikut: [${cleanTimeWindows.map(w => `${w.start}s-${w.end}s`).join(', ')}]. Anda HANYA BOLEH memilih timestamps di dalam rentang waktu yang terverifikasi bersih ini! DILARANG KERAS memilih timestamps di luar segmen bersih ini.\n`
    : '';

  const genAI = new GoogleGenerativeAI(geminiKey);
  const videoPrompt = `You are an elite Quality Control (QC) Director for Affiliate Product Video Ads.
Evaluate this YouTube video carefully against the following 5 MANDATORY ACCEPTANCE CRITERIA:
${violationBlacklistWarning}
${cleanWindowsDirective}

${buildNicheProductCriterion(niche, coreNoun, effectiveTitle, isVideoFirstMode, effectiveDesc)}

CRITERION 2: WATERMARKS, SOCIAL MEDIA LOGOS, & CHANNEL IDENTITIES (9:16 CROP GEOMETRY RULE)
- 9:16 CROP GEOMETRY MANDATE (HORIZONTAL 16:9 vs VERTICAL 9:16 SOURCE VIDEOS):
  * HORIZONTAL 16:9 VIDEOS: The final Short uses ONLY the central 9:16 vertical strip (the middle 56.25% width: horizontal X from 22% to 78%). The entire outer left side (0% to 22%) and outer right side (78% to 100%) ARE COMPLETELY DISCARDED AND CUT OFF BY FFMPEG!
    CRITICAL RULE: Channel logos, channel badges, subscriber icons, or watermarks located in the far-right corner (X > 78%, such as top-right or bottom-right creator icons) or far-left corner (X < 22%) WILL NEVER APPEAR in the 9:16 crop! DO NOT REJECT HORIZONTAL 16:9 VIDEOS FOR CORNER LOGOS LOCATED IN THE FAR-RIGHT (X > 78%) OR FAR-LEFT (X < 22%) EDGES! Only reject if a digital watermark or channel logo directly intrudes into the central 56% peragaan area.
  * VERTICAL 9:16 VIDEOS (SHORTS / REELS / TIKTOK): ZERO HORIZONTAL CROPPING OCCURS! The full 100% width and all four corners remain completely visible in the final output!
    THEREFORE: In vertical videos, ANY watermark, channel handle, or creator text overlay anywhere in the frame (including corners and margins) CANNOT be cropped out and MUST BE REJECTED IMMEDIATELY!
- STRICT ZERO-TOLERANCE INSIDE THE 9:16 OUTPUT FRAME (THE CENTRAL 56% ZONE):
  * DILARANG KERAS jika watermark digital, logo TikTok/YouTube, atau identitas channel MASUK KE DALAM FRAME 9:16 TENGAH (area yang menutupi peragaan produk)!
  * Setiap watermark atau logo yang benar-benar masuk ke dalam area tengah 9:16 wajib DITOLAK karena tidak bisa terpotong.
- PHYSICAL PRODUCT BRANDING IS 100% ACCEPTABLE:
  * Merek, logo, atau tulisan yang tercetak/terukir secara fisik pada bodi produk (misal: "SilverCrest", "Philips", "Joybos", "Xiaomi") BUKAN watermark dan 100% DITERIMA!

CRITERION 3: ZERO SUBTITLES, ZERO FLOATING TEXT, ZERO COLORED BANNERS, & ZERO GRAPHIC OVERLAYS
- HARD REJECT CRITERIA (IMMEDIATE ZERO TOLERANCE INSIDE 9:16 CROP):
  * NON-TEXT GRAPHIC OVERLAYS: Pointing arrows (panah penunjuk merah/kuning), highlight circles/rectangles, animated emojis, stickers, subscription/bell/like buttons, floating price badges, or discount callouts added by video editors.
  * CREATOR PROMOTIONAL TEXT: "da di deskripsi", "link di bio", "klik keranjang kuning", "cek bio", "follow", or running text captions.
  * STATIC TEXT BANNERS: Colored background cards (kotak warna kuning/merah/putih dengan tulisan), lower-third bars, or digital promo stickers.
  * SPEECH DIALOGUE & SUBTITLES: Speech dialogue captions, translated subtitles, or lyric bars.
- OPENING INTRO BUMPER / TITLE CARD TOLERANCE (CRITICAL MANDATE):
  * JIKA VIDEO MEMILIKI KARTU INTRO / BUMPER PEMBUKA / LOGO CHANNEL ANIMASI DI DETIK 0 SAMPAI DETIK 5: JANGAN DITOLAK!
  * Video TETAP DITERIMA (status: 'accept') asalkan bagian peragaan produk setelahnya bersih dan faceless.
  * GEMINI WAJIB MEMBUANG INTRO TERSEBUT dengan cara: HANYA memilih timestamps klip yang dimulai SETELAH INTRO SELESAI (misal: mulai detik >= 5s, saat video sudah murni masuk ke peragaan produk fisik oleh tangan)!
  * Timestamps di array "timestamps" TIDAK BOLEH memasukkan detik-detik kartu intro pembuka!
- REJECT ONLY IF:
  * Kartu bumper foto / slide diam mendominasi isi video (video berupa kumpulan foto/slideshow statis).
  * Grafis animasi overlay, panah penunjuk, stiker kartun, atau subtitle ucapan menutupi peragaan produk fisik di dalam frame 9:16 tengah secara terus-menerus sehingga tidak ada cukup cuplikan bersih.
- ONLY physical text printed directly on the physical product body ('Power', 'ON/OFF', volume numbers) is acceptable. Paper manuals, brochures, and packaging labels are NOT exempt!

${buildFaceAndMotionCriterion(niche, clipSec)}

CRITERION 4B: UNBOXING & PACKAGING DISCARD MANDATE (CHERRY-PICK ACTIVE USAGE, DISCARD UNBOXING FRAMES)
- JANGAN MENOLAK VIDEO HANYA KARENA ADA PROSES UNBOXING:
  * Jika video memiliki proses unboxing (membuka kardus, merobek bubble wrap/plastik, mengeluarkan barang dari kotak): Video TETAP DITERIMA (status: 'accept').
- MANDAT PEMBUANGAN PROSES UNBOXING:
  * AI WAJIB MEMBUANG DAN MENYINGKIRKAN SEMUA SCENE YANG MENAMPILKAN PROSES UNBOXING, KOTAK KARDUS, KEMASAN PAKET, BUBBLE WRAP, BUKU PANDUAN MANUAL KERTAS, KARTU GARANSI, ATAU BUSA PACKAGING!
  * Timestamps di array "timestamps" DILARANG KERAS memasukkan proses unboxing, buku panduan manual kertas, atau menyorot kotak kardus/kemasan!
  * HANYA pilih timestamps ketika produk fisik di luar kemasan SEDANG DIGUNAKAN SECARA AKTIF / DIDEMONSTRASIKAN FUNGSINYA (misal: saat memotong, mengupas, memasak, menyalakan mesin, scrolling layar HP, gaming fisik di tangan).
- TOLAK (status: 'reject') HANYA JIKA:
  * 100% seluruh isi video HANYA unboxing paket / membaca buku manual tanpa ada sedikit pun demonstrasi fungsi fisik produk.

CRITERION 4C: NORMAL CAMERA ORIENTATION & ZERO PILLARBOX / ZERO ROTATED 90° FOOTAGE
- ZERO TOLERANCE FOR ROTATED OR SIDEWAYS FOOTAGE (MIRING / ROTATE 90 DERAJAT):
  * DILARANG KERAS MEMILIH CUPLIKAN DENGAN ORIENTASI KAMERA MIRING / TERPUTAR 90 DERAJAT (SIDEWAYS ORIENTATION)!
  * Permukaan meja kerja, kompor, wajan, talenan, atau tangan memegang HP HARUS berada pada posisi horizontal/vertikal normal (gravitasi bumi normal).
- ZERO TOLERANCE FOR PILLARBOX & VERTICAL BLACK BARS:
  * DILARANG KERAS video yang memiliki pilar / garis hitam vertikal tebal di sisi kiri dan kanan (pillarbox narrow slit)! Video harus mengisi penuh frame secara proporsional.
- Jika video secara keseluruhan direkam/diupload miring 90 derajat atau ber-pillarbox hitam tebal: VIDEO WAJIB LANGSUNG DITOLAK: {"status": "reject", "reason": "Video ditolak: Orientasi kamera miring 90 derajat atau terdapat pillarbox hitam tebal di sisi samping."}.

CRITERION 5: CLEAN TIMESTAMP SELECTION & ACTION PROGRESSION SEQUENCE
- HARD REJECT (ZERO-TOLERANCE for selected clips):
  * Every timestamp in "timestamps" MUST be 100% free of faces, subtitles, creator text, watermarks, pointing arrows, stickers, emojis, price tags, unboxing cardboard, paper manuals, and static slides.
- SOFT SCORE (PRIORITIZE HIGH-QUALITY CLIPS):
  * Give highest priority to clips showing clear hands-on demonstration, crisp natural lighting, and active physical product motion.
- ACTION PROGRESSION (NATURAL STORY FLOW):
  * Order the selected timestamps to follow a coherent demonstration sequence:
    1. Phase 1 (Product Overview / Hook): 1-2 clips introducing the complete physical product in action.
    2. Phase 2 (Hands-on Preparation): Hands preparing, holding, or loading ingredients/product.
    3. Phase 3 (Active Demonstration): Core action of the product operating (cutting, frying, blending, cleaning).
- Determine 5 to 8 clean, strong non-overlapping segments (each 2 to 5 seconds long according to natural shot boundaries) to construct a coherent 30 to 35 second video ad.
- If the video does NOT contain at least 5 clean faceless product clips inside the 9:16 frame: MUST BE REJECTED.

Output valid JSON ONLY with this exact format:
If ACCEPTED:
{
  "status": "accept",
  "detectedProduct": "<nama produk>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": true,
  "hasHumanOrFaceAnywhereInVideo": false,
  "hasFaceIn916Frame": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasOnlyPhysicalProductText": true,
  "isAiGeneratedOrSynthetic": false,
  "timestamps": [10, 22, 35, 48, 62, 75, 90, 105, 120, 135],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk (DILARANG pakai kata 'fix' / 'fiks'!)",
  "hasProductBrand": false,
  "detectedBrand": "none"
}

If REJECTED:
{
  "status": "reject",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": false,
  "hasHumanOrFaceAnywhereInVideo": false,
  "hasFaceIn916Frame": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasOnlyPhysicalProductText": false,
  "isAiGeneratedOrSynthetic": false,
  "reason": "<PILIH SATU alasan akurat: 'Terdapat grafis animasi overlay/stiker di dalam frame 9:16 tengah' ATAU 'Foto bumper statis terdeteksi' ATAU 'Logo channel statis masuk ke frame 9:16' ATAU 'Menampilkan wajah orang/vlogger' ATAU 'Mengandung subtitle ucapan' ATAU 'Produk tidak cocok'>"
}

CRITICAL RULES FOR REJECTION OUTPUT:
1. "isExactProductMatch": Set to true if the item demonstrated in the video matches "${coreNoun}", even if rejected for policy. Set to false ONLY if the product is physically different.
2. "reason": DILARANG KERAS MENGGABUNGKAN DUA ALASAN BERBEDA (seperti "produk tidak cocok dengan menampilkan wajah atau vlogger")! Berikan SATU alasan tunggal yang presisi. Stiker kartun, animasi, atau emoji BUKAN vlogger manusia!`;

  const candidateModels = [
    'gemini-flash-latest',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ];
  let parsed = null;
  let activeGeminiModel = candidateModels[0];
  let lastGeminiErr = null;
  let allQuotaErrors = true;

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];
    try {
      console.log(`[Gemini YouTube Stream] Calling model [${i + 1}/${candidateModels.length}]: ${modelName} for ${youtubeUrl}...`);
      activeGeminiModel = modelName;
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          mediaResolution: 'MEDIA_RESOLUTION_LOW',
        },
      });

      trackBandwidth('aiRequests', 2500, `Gemini YouTube Stream (${modelName})`);
      const contentParts = [
        {
          fileData: {
            fileUri: youtubeUrl,
            mimeType: 'video/mp4',
          },
          videoMetadata: {
            fps: 0.5,
          },
        },
      ];
      if (refImageInlineData) {
        contentParts.push(refImageInlineData);
      }
      contentParts.push({ text: videoPrompt });

      const result = await model.generateContent(contentParts);

      const rawText = result.response.text();
      console.log(`[Gemini YouTube Stream ${modelName}] Response:`, rawText);
      parsed = repairJson(rawText);
      if (parsed && (parsed.status || parsed.timestamps || parsed.reason)) {
        break;
      }
    } catch (gemErr) {
      lastGeminiErr = gemErr;
      const isQuota = isQuotaError(gemErr);
      if (!isQuota) {
        allQuotaErrors = false;
      }
      const isDailyQuota = isQuota && (gemErr.message?.toLowerCase().includes('per-day') || gemErr.message?.toLowerCase().includes('daily') || gemErr.message?.toLowerCase().includes('per day'));
      console.warn(`[Gemini YouTube Stream] Model ${modelName} gagal: ${gemErr.message}. ${isQuota ? '⚠️ [Limit Kuota/Token Tercapai]' : ''} ${i < candidateModels.length - 1 ? `Mencoba model fallback berikutnya (${candidateModels[i + 1]})...` : 'Semua model Gemini dalam rantai fallback telah dicoba.'}`);
      if (isDailyQuota) {
        console.warn('[Gemini YouTube Stream] ⛔ Kuota harian API Key habis (Daily RPD limit). Menghentikan loop fallback.');
        break;
      }
    }
  }

  if (!parsed) {
    const isLastQuota = isQuotaError(lastGeminiErr) || (lastGeminiErr?.status === 429) || (lastGeminiErr?.statusCode === 429);
    if ((allQuotaErrors || isLastQuota) && candidateModels.length > 0) {
      const quotaErr = new Error(`Model Gemini Visual (${candidateModels.join(' & ')}) telah mencapai batas limit kuota token: ${lastGeminiErr?.message || 'Resource exhausted'}`);
      quotaErr.isAllModelsQuotaExhausted = true;
      quotaErr.isQuotaError = true;
      throw quotaErr;
    }
    throw lastGeminiErr || new Error('Gemini YouTube Stream gagal menganalisa video.');
  }

  const rawStatus = String(parsed.status || '').toLowerCase().trim();
  const isRejectStatus = rawStatus === 'reject' || rawStatus === 'rejected' || rawStatus === 'ditolak';
  const isBulky = isBulkyOrUnsuitableProduct(parsed.detectedProduct, { niche });
  const isMatchFalse = isVideoFirstMode
    ? (isBulky || parsed.isUsableSourceVideo === false)
    : (parsed.isProductMatch === false || parsed.isExactProductMatch === false || isBulky);
  const hasFace = parsed.hasFaceIn916Frame === true ||
    parsed.hasFaceOrHumanInSelectedFrames === true ||
    parsed.hasFaceInSelectedClips === true;
  const hasWatermarkInFrame = parsed.hasWatermarkIn916Frame === true || parsed.hasCenterObstructingWatermark === true;
  const hasSocialOrChannelInFrame = parsed.hasSocialOrChannelLogoIn916Frame === true || parsed.hasSocialMediaOrChannelIdentityIn916Frame === true;
  const hasSubtitles = parsed.hasSubtitlesIn916Frame === true || parsed.hasSubtitlesOrBurnedText === true || parsed.hasBurnedText === true;
  const hasFloatingText = parsed.hasFloatingTextIn916Frame === true || parsed.hasTextOverlaysIn916Frame === true;
  const hasGraphic = parsed.hasAnimatedGraphicOverlayIn916Frame === true;
  const hasBumper = parsed.hasBumperPhotoInFrame === true || parsed.hasBumperPhotoOrIntroCard === true;
  const hasStaticLogo = parsed.hasStaticChannelLogoIn916Frame === true;
  const isSynthetic = parsed.isAiGeneratedOrSynthetic === true;
  const reasonText = String(parsed.reason || parsed.rejectionReason || '').trim();
  const reasonLower = reasonText.toLowerCase();

  const mentionsGraphicInReason = isRejectStatus &&
    (reasonLower.includes('animasi') || reasonLower.includes('grafis') || reasonLower.includes('overlay') || reasonLower.includes('stiker') || reasonLower.includes('kartun')) &&
    (reasonLower.includes('9:16') || reasonLower.includes('tengah') || reasonLower.includes('menutupi') || reasonLower.includes('center')) &&
    !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16') && !reasonLower.includes('tidak ada animasi') && !reasonLower.includes('bebas animasi');
  const mentionsBumperInReason = reasonLower.includes('bumper') || reasonLower.includes('intro card') || reasonLower.includes('opening card') || reasonLower.includes('slide statis');
  const mentionsFaceInReason = reasonLower.includes('wajah') || reasonLower.includes('face') || reasonLower.includes('manusia') || reasonLower.includes('orang');
  const mentionsWatermarkInFrame = isRejectStatus && (reasonLower.includes('watermark') || reasonLower.includes('capcut')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');
  const mentionsLogoInFrame = (isRejectStatus || hasStaticLogo) && (reasonLower.includes('logo') || reasonLower.includes('tiktok') || reasonLower.includes('channel') || reasonLower.includes('identitas') || reasonLower.includes('sosmed')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');
  const mentionsSubtitlesInReason = reasonLower.includes('subtitle') || reasonLower.includes('caption') || reasonLower.includes('teks berjalan') || reasonLower.includes('terjemahan') || reasonLower.includes('teks mengambang') || reasonLower.includes('floating text') || reasonLower.includes('stiker teks') || reasonLower.includes('teks promo') || reasonLower.includes('tulisan');

  const shouldReject = isRejectStatus || isMatchFalse || hasFace || hasWatermarkInFrame || hasSocialOrChannelInFrame || hasSubtitles || hasFloatingText || hasGraphic || hasBumper || hasStaticLogo || isSynthetic ||
    mentionsFaceInReason || mentionsGraphicInReason || mentionsBumperInReason || mentionsWatermarkInFrame || mentionsLogoInFrame || mentionsSubtitlesInReason;

  if (shouldReject) {
    let rejectionMsg = reasonText;

    // Sanitize nonsensical AI conflations (e.g. "produk tidak cocok dengan menampilkan wajah atau vlogger")
    const lower = (rejectionMsg || '').toLowerCase();
    const hasConflation = lower.includes('tidak cocok') && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia') || lower.includes('orang'));
    const isGraphicMisclassifiedAsFace = (hasGraphic || mentionsGraphicInReason) && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia'));

    if (hasConflation || isGraphicMisclassifiedAsFace || !rejectionMsg) {
      if (hasGraphic || mentionsGraphicInReason) {
        rejectionMsg = 'Video ditolak oleh AI: Mengandung grafis animasi overlay, stiker kartun, atau elemen grafis tempelan di frame 9:16.';
      } else if (hasBumper || mentionsBumperInReason) {
        rejectionMsg = 'Video ditolak oleh AI: Mengandung foto bumper atau kartu intro statis pada video.';
      } else if (hasSocialOrChannelInFrame || hasStaticLogo || mentionsLogoInFrame) {
        rejectionMsg = 'Video ditolak oleh AI: Mengandung logo media sosial atau identitas channel yang masuk ke frame 9:16.';
      } else if (hasWatermarkInFrame || mentionsWatermarkInFrame) {
        rejectionMsg = 'Video ditolak oleh AI: Mengandung watermark digital yang masuk ke dalam frame 9:16 output.';
      } else if (hasSubtitles || hasFloatingText || mentionsSubtitlesInReason) {
        rejectionMsg = 'Video ditolak oleh AI: Mengandung subtitle, teks mengambang, atau stiker teks editan pada frame 9:16.';
      } else if (hasFace || mentionsFaceInReason) {
        rejectionMsg = 'Video ditolak oleh AI: Video didominasi wajah/vlogger manusia tanpa cukup cuplikan peragaan tangan (wajib cuplikan tangan/hands-only bersih).';
      } else if (isSynthetic) {
        rejectionMsg = 'Video ditolak oleh AI: Terdeteksi video AI / animasi / CGI, bukan demonstrasi fisik nyata.';
      } else if (isBulky) {
        rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'perabot besar / produk set'}) tergolong perabot/rak besar atau paket/set/bundle yang dilarang.`;
      } else if (isMatchFalse) {
        rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'tidak cocok'}) tidak cocok dengan link Shopee.`;
      } else {
        rejectionMsg = 'Video ditolak oleh AI: Tidak memenuhi syarat affiliate faceless / bersih.';
      }
    }
    console.warn(`[Gemini YouTube Stream] ⛔ VIDEO RESMI DITOLAK OLEH AI: ${rejectionMsg}`);
    const rejectError = new Error(`Video ditolak oleh Gemini: ${rejectionMsg}`);
    rejectError.isAiRejection = true;
    rejectError.rejectionReason = rejectionMsg;
    throw rejectError;
  }

  let rawTimestamps = [];
  if (Array.isArray(parsed.timestamps)) {
    rawTimestamps = parsed.timestamps;
  } else if (Array.isArray(parsed.clips)) {
    rawTimestamps = parsed.clips.map((c) => c.startSeconds ?? c.startTime);
  }

  let candidateClips = [];
  if (rawTimestamps.length > 0) {
    for (const rawTs of rawTimestamps) {
      const sec = typeof rawTs === 'number' ? rawTs : parseTimeToSeconds(rawTs);
      if (isNaN(sec) || sec < 0 || sec > totalDuration) continue;
      // Filter out timestamps colliding with locally detected violation frames (+- 3.0s)
      if (allViolationTimestamps.length > 0 && allViolationTimestamps.some(vt => Math.abs(vt - sec) < 3.0)) {
        console.log(`[Gemini YouTube Stream] Discarding timestamp ${sec}s because it collides with detected violation frame (+-3s)`);
        continue;
      }
      const minSafeStart = Math.max(introCutoffSec || 0, (parsed.hasOpeningIntro ? (Number(parsed.introDurationSeconds) || 5) : 0));
      let startSec = Math.max(0, Math.min(totalDuration - clipSec, Math.round(sec * 10) / 10));
      if (startSec < minSafeStart) {
        startSec = Math.min(totalDuration - clipSec, minSafeStart);
      }
      const endSec = Math.round((startSec + clipSec) * 10) / 10;
      candidateClips.push({
        startSeconds: startSec,
        endSeconds: endSec,
        duration: clipSec,
        startTime: formatSeconds(startSec),
        endTime: formatSeconds(endSec),
        reason: `Cuplikan produk di detik ${formatSeconds(startSec)}`,
        isCleanAffiliateShot: true,
        hasProductBrand: Boolean(parsed.hasProductBrand),
        reframe: {
          ...DEFAULT_REFRAME,
          renderMode: 'stage_80',
        },
      });
    }
  }

  const hasProductBrand = Boolean(parsed.hasProductBrand);
  const detectedBrand = (parsed.detectedBrand || '').trim() || (hasProductBrand ? 'Brand Terdeteksi' : 'none');
  const allowHflip = hasProductBrand ? false : (parsed.allowHflip !== false);

  const clips = normalizeClipPlan(candidateClips, totalDuration, {
    allowFallback: allowFallbackClips,
    hasProductBrand,
    allowHflip,
    sceneDuration: clipSec,
  });
  const duration = clips.reduce((total, clip) => total + (clip.endSeconds - clip.startSeconds), 0);

  onProgress({
    step: 'gemini_vision',
    message: `${activeGeminiModel} selected ${clips.length} clean ${clipSec}s product shots (${duration.toFixed(1)}s total).`,
    progress: 55,
  });

  return {
    detectedProduct: (parsed.detectedProduct || '').trim() || productTitle,
    startTime: clips[0].startTime,
    endTime: clips[clips.length - 1].endTime,
    startSeconds: clips[0].startSeconds,
    endSeconds: clips[clips.length - 1].endSeconds,
    duration,
    productHook: parsed.productHook || getDynamicProductHookFallback(productTitle),
    hasProductBrand,
    detectedBrand,
    allowHflip,
    reframe: clips[0].reframe,
    clips,
  };
}

/**
 * Fallback Video Analysis using Google Gemini File API (Gemini 1.5 Flash).
 * Uploads video directly to Google's File API, allowing native video comprehension
 * without relying on frame extraction.
 */
export async function analyzeVideoWithGeminiFileApi({
  videoPath,
  apiKey,
  productTitle,
  productDescription,
  productImage = '',
  shopeeLink,
  sceneDuration = 3.3,
  allowFallbackClips = false,
  introCutoffSec = 0,
  isVideoFirst = false,
  niche = 'kitchen_tools',
  onProgress = () => { },
}) {
  const geminiKey = getDirectGeminiApiKey(apiKey);
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY belum disetel di server/.env untuk fallback Gemini File API.');
  }

  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`File video tidak ditemukan di: ${videoPath}`);
  }

  const clipSec = Math.max(2.5, Math.min(5.0, Number(sceneDuration) || 3.3));
  const isVideoFirstMode = Boolean(isVideoFirst || !shopeeLink);
  const prodInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreNoun = prodInfo.coreProductNoun || 'Produk Praktis';
  const effectiveTitle = prodInfo.cleanTitle || (productTitle || '').trim() || coreNoun;
  const effectiveDesc = (productDescription || '').trim().slice(0, 500);

  let refImageInlineData = null;
  if (productImage) {
    try {
      const resolvedImg = await resolveImageBufferAndBase64(productImage);
      if (resolvedImg?.base64) {
        refImageInlineData = {
          inlineData: {
            data: resolvedImg.base64,
            mimeType: resolvedImg.mimeType || 'image/jpeg',
          },
        };
        console.log(`[Gemini File API] Menambahkan foto referensi produk Shopee (${resolvedImg.mimeType}) untuk verifikasi visual AI.`);
      }
    } catch (imgErr) {
      console.warn(`[Gemini File API] Gagal memuat foto referensi produk: ${imgErr.message}`);
    }
  }

  let totalDuration = 60;
  try {
    const d = await getMediaDurationSec(videoPath);
    if (d && d > 5) totalDuration = d;
  } catch { }

  onProgress({
    step: 'gemini_vision',
    message: 'Mengunggah video ke Google Gemini File API (Gemini 1.5 Flash)...',
    progress: 46,
  });

  const fileManager = new GoogleAIFileManager(geminiKey);
  const genAI = new GoogleGenerativeAI(geminiKey);

  let uploadResponse = null;
  try {
    uploadResponse = await fileManager.uploadFile(videoPath, {
      mimeType: 'video/mp4',
      displayName: `clip_${path.basename(videoPath, path.extname(videoPath))}_${Date.now()}`,
    });

    onProgress({
      step: 'gemini_vision',
      message: 'Menunggu proses video di Google Gemini File API...',
      progress: 48,
    });

    // Wait until file is ACTIVE
    let fileState = await fileManager.getFile(uploadResponse.file.name);
    let pollCount = 0;
    while (fileState.state === 'PROCESSING' && pollCount < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCount++;
      fileState = await fileManager.getFile(uploadResponse.file.name);
    }

    if (fileState.state !== 'ACTIVE') {
      throw new Error(`Gemini File API processing error: status ${fileState.state}`);
    }

    onProgress({
      step: 'gemini_vision',
      message: 'Gemini 1.5 Flash menganalisa video, verifikasi faceless, dan menentukan cuplikan...',
      progress: 50,
    });

    const videoPrompt = `You are an elite Quality Control (QC) Director for Affiliate Product Video Ads.
Evaluate this full video carefully against the following 5 MANDATORY ACCEPTANCE CRITERIA:

${buildNicheProductCriterion(niche, coreNoun, effectiveTitle, isVideoFirstMode, effectiveDesc)}

CRITERION 2: WATERMARKS, SOCIAL MEDIA LOGOS, & CHANNEL IDENTITIES (9:16 CROP GEOMETRY RULE)
- 9:16 CROP GEOMETRY MANDATE (HORIZONTAL 16:9 vs VERTICAL 9:16 SOURCE VIDEOS):
  * HORIZONTAL 16:9 VIDEOS: The backend crops the central 9:16 vertical frame (~45-50% width). Outer left margins (0-20%) and outer right margins (80-100%) are completely cropped out. Peripheral corner watermarks in the far corners are safely cut off.
  * VERTICAL 9:16 VIDEOS (SHORTS / REELS / TIKTOK): ZERO HORIZONTAL CROPPING OCCURS! The full 100% width and all four corners remain completely visible in the final output!
    THEREFORE: In vertical videos, ANY watermark, channel handle, or creator text overlay anywhere in the frame (including corners and margins) CANNOT be cropped out and MUST BE REJECTED IMMEDIATELY!
- STRICT ZERO-TOLERANCE INSIDE THE 9:16 OUTPUT FRAME:
  * DILARANG KERAS jika watermark digital, logo TikTok/YouTube, atau identitas channel MASUK KE DALAM FRAME 9:16 TENGAH (area yang menutupi peragaan produk)!
  * Setiap watermark atau logo yang masuk ke dalam frame 9:16 wajib DITOLAK karena tidak bisa terpotong.
  * PERINGATAN KERAS WATERMARK ABU-ABU / TRANSPARAN / SAMAR:
    Perhatikan dengan sangat teliti setiap watermark semi-transparan, watermark abu-abu muda, logo rumah/bangunan/karakter, atau teks merek kreator/studio (seperti logo channel samar, teks abu-abu di sudut atas atau tengah frame).
    JIKA WATERMARK ABU-ABU/SAMAR INI TERLIHAT DI DALAM AREA FRAME PERAGAAN (tidak terpotong habis di luar layar), VIDEO WAJIB LANGSUNG DITOLAK: {"status": "reject", "hasWatermarkIn916Frame": true, "reason": "Video ditolak: Mengandung watermark abu-abu/logo samar di dalam frame."}
- PHYSICAL PRODUCT BRANDING IS 100% ACCEPTABLE:
  * Merek, logo, atau tulisan yang tercetak/terukir secara fisik pada bodi produk (misal: "Philips", "Joybos", "Xiaomi") BUKAN watermark dan 100% DITERIMA!

CRITERION 3: ZERO SUBTITLES, ZERO FLOATING TEXT, ZERO COLORED BANNERS, & ZERO ANIMATED GRAPHIC OVERLAYS INSIDE 9:16 OUTPUT
- The backend generates and burns its own clean, animated subtitles.
- CREATOR PROMOTIONAL TEXT & OVERLAY BAN (CRITICAL FOR VERTICAL VIDEOS):
  * DILARANG KERAS teks ajakan promosi kreator seperti "da di deskripsi", "link di bio", "klik keranjang kuning", "cek bio", "baca deskripsi", "follow", atau running caption!
  * Pada video vertikal 9:16, teks overlay di pojok kiri atas/bawah TIDAK AKAN TERPOTONG dan wajib langsung DITOLAK!
- STATIC TEXT BANNERS & COLORED BACKGROUND CARDS BAN:
  * DILARANG KERAS jika ada banner teks statis, kartu persegi berlatar warna (misal: kotak kuning/merah/putih dengan tulisan di dalamnya), lower-third card, atau label promosi digital yang menempel di dalam frame 9:16 tengah!
- OPENING INTRO BUMPER / TITLE CARD TOLERANCE (CRITICAL MANDATE):
  * JIKA VIDEO MEMILIKI KARTU INTRO / BUMPER PEMBUKA / LOGO CHANNEL ANIMASI DI DETIK 0 SAMPAI DETIK 5: JANGAN DITOLAK!
  * Video TETAP DITERIMA (status: 'accept') asalkan bagian peragaan produk setelahnya bersih dan faceless.
  * GEMINI WAJIB MEMBUANG INTRO TERSEBUT dengan cara: HANYA memilih timestamps klip yang dimulai SETELAH INTRO SELESAI (misal: mulai detik >= 5s, saat video sudah murni masuk ke peragaan produk fisik oleh tangan)!
  * Timestamps di array "timestamps" TIDAK BOLEH memasukkan detik-detik kartu intro pembuka!
- REJECT ONLY IF:
  * STATIC TEXT BANNERS & COLORED BACKGROUND CARDS: Ada banner teks statis, kartu persegi berlatar warna, atau kartu promo.
  * Kartu bumper foto / slide diam mendominasi isi tengah video (video berupa kumpulan foto/slideshow statis).
  * Grafis animasi overlay, stiker kartun, atau subtitle ucapan menutupi peragaan produk fisik di dalam frame 9:16 tengah secara terus-menerus sehingga tidak ada cukup cuplikan bersih.
  * Speech dialogue captions, translated subtitles, lyric bars, running dialogue text, or FLOATING PROMOTIONAL TEXT (price tags, discount callouts, feature arrows, Chinese floating text, text stickers) are visible inside the central 9:16 frame.
- ONLY physical text printed directly on the physical product body ('Power', 'ON/OFF', volume numbers) is acceptable. Paper manuals, brochures, and packaging labels are NOT exempt!

${buildFaceAndMotionCriterion(niche, clipSec)}

CRITERION 4B: UNBOXING & PACKAGING DISCARD MANDATE (CHERRY-PICK ACTIVE USAGE, DISCARD UNBOXING FRAMES)
- JANGAN MENOLAK VIDEO HANYA KARENA ADA PROSES UNBOXING:
  * Jika video memiliki proses unboxing (membuka kardus, merobek bubble wrap/plastik, mengeluarkan barang dari kotak): Video TETAP DITERIMA (status: 'accept').
- MANDAT PEMBUANGAN PROSES UNBOXING:
  * AI WAJIB MEMBUANG DAN MENYINGKIRKAN SEMUA SCENE YANG MENAMPILKAN PROSES UNBOXING, KOTAK KARDUS, KEMASAN PAKET, BUBBLE WRAP, BUKU PANDUAN MANUAL KERTAS, KARTU GARANSI, ATAU BUSA PACKAGING!
  * Timestamps di array "timestamps" DILARANG KERAS memasukkan proses unboxing, buku panduan manual kertas, atau menyorot kotak kardus/kemasan!
  * HANYA pilih timestamps ketika produk fisik di luar kemasan SEDANG DIGUNAKAN SECARA AKTIF / DIDEMONSTRASIKAN FUNGSINYA (misal: saat memotong, mengupas, memasak, menyalakan mesin, scrolling layar HP, gaming fisik di tangan).
- TOLAK (status: 'reject') HANYA JIKA:
  * 100% seluruh isi video HANYA unboxing paket / membaca buku manual tanpa ada sedikit pun demonstrasi fungsi fisik produk.

CRITERION 4C: NORMAL CAMERA ORIENTATION & ZERO PILLARBOX / ZERO ROTATED 90° FOOTAGE
- ZERO TOLERANCE FOR ROTATED OR SIDEWAYS FOOTAGE (MIRING / ROTATE 90 DERAJAT):
  * DILARANG KERAS MEMILIH CUPLIKAN DENGAN ORIENTASI KAMERA MIRING / TERPUTAR 90 DERAJAT (SIDEWAYS ORIENTATION)!
  * Permukaan meja kerja, kompor, wajan, talenan, atau tangan memegang HP HARUS berada pada posisi horizontal/vertikal normal (gravitasi bumi normal).
- ZERO TOLERANCE FOR PILLARBOX & VERTICAL BLACK BARS:
  * DILARANG KERAS video yang memiliki pilar / garis hitam vertikal tebal di sisi kiri dan kanan (pillarbox narrow slit)! Video harus mengisi penuh frame secara proporsional.
- Jika video secara keseluruhan direkam/diupload miring 90 derajat atau ber-pillarbox hitam tebal: VIDEO WAJIB LANGSUNG DITOLAK: {"status": "reject", "reason": "Video ditolak: Orientasi kamera miring 90 derajat atau terdapat pillarbox hitam tebal di sisi samping."}.

CRITERION 5: CLEAN TIMESTAMP SELECTION (30 TO 35 SECONDS TOTAL RUNTIME)
- Determine 5 to 8 clean, strong non-overlapping segments (each 2 to 5 seconds long according to natural shot boundaries) to construct a coherent 30 to 35 second video ad.
- Each timestamp in "timestamps" MUST be in seconds from the start of the video where the 9:16 center area is 100% faceless, free of subtitles, free of floating text, free of graphic overlays, free of colored background cards, and free of watermarks/logos.
- If the video does NOT contain at least 5 clean faceless product clips inside the 9:16 frame: MUST BE REJECTED.

Output valid JSON ONLY with this exact format:
If ACCEPTED:
{
  "status": "accept",
  "detectedProduct": "<nama produk>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": true,
  "hasFaceIn916Frame": false,
  "hasHumanOrFaceAnywhereInVideo": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasOnlyPhysicalProductText": true,
  "isAiGeneratedOrSynthetic": false,
  "timestamps": [10, 22, 35, 48, 62, 75, 90, 105, 120, 135],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk (DILARANG pakai kata 'fix' / 'fiks'!)",
  "hasProductBrand": false,
  "detectedBrand": "none"
}

If REJECTED:
{
  "status": "reject",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": false,
  "hasHumanOrFaceAnywhereInVideo": false,
  "hasFaceIn916Frame": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasOnlyPhysicalProductText": false,
  "isAiGeneratedOrSynthetic": false,
  "reason": "<PILIH SATU alasan akurat: 'Terdapat grafis animasi overlay/stiker di dalam frame 9:16 tengah' ATAU 'Foto bumper statis terdeteksi' ATAU 'Logo channel statis masuk ke frame 9:16' ATAU 'Menampilkan wajah orang/vlogger' ATAU 'Mengandung subtitle ucapan' ATAU 'Produk tidak cocok'>"
}

CRITICAL RULES FOR REJECTION OUTPUT:
1. "isExactProductMatch": Set to true if the item demonstrated in the video matches "${coreNoun}", even if rejected for policy. Set to false ONLY if the product is physically different.
2. "reason": DILARANG KERAS MENGGABUNGKAN DUA ALASAN BERBEDA (seperti "produk tidak cocok dengan menampilkan wajah atau vlogger")! Berikan SATU alasan tunggal yang presisi. Stiker kartun, animasi, atau emoji BUKAN vlogger manusia!`;

    const candidateModels = [
      process.env.GEMINI_MODEL || 'gemini-flash-latest',
      'gemini-flash-latest',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite'
    ];
    let parsed = null;
    let activeGeminiModel = candidateModels[0];
    let lastGeminiErr = null;

    for (const modelName of candidateModels) {
      try {
        console.log(`[Gemini File API] Calling model: ${modelName}...`);
        activeGeminiModel = modelName;
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        });

        const contentParts = [
          {
            fileData: {
              mimeType: uploadResponse.file.mimeType,
              fileUri: uploadResponse.file.uri,
            },
          },
        ];
        if (refImageInlineData) {
          contentParts.push(refImageInlineData);
        }
        contentParts.push({ text: videoPrompt });

        const result = await model.generateContent(contentParts);

        const rawText = result.response.text();
        console.log(`[Gemini File API ${modelName}] Response:`, rawText);
        parsed = repairJson(rawText);
        if (parsed && (parsed.status || parsed.timestamps || parsed.reason)) {
          break;
        }
      } catch (gemErr) {
        console.warn(`[Gemini File API] Model ${modelName} error:`, gemErr.message);
        lastGeminiErr = gemErr;
      }
    }

    if (!parsed) {
      if (isQuotaError(lastGeminiErr) || (lastGeminiErr?.status === 429) || (lastGeminiErr?.statusCode === 429)) {
        const quotaErr = new Error(`Model Gemini Visual File API telah mencapai batas limit kuota/rate limit token: ${lastGeminiErr?.message}`);
        quotaErr.isAllModelsQuotaExhausted = true;
        quotaErr.isQuotaError = true;
        throw quotaErr;
      }
      throw lastGeminiErr || new Error('Gemini File API gagal menganalisa video.');
    }

    const rawStatus = String(parsed.status || '').toLowerCase().trim();
    const isRejectStatus = rawStatus === 'reject' || rawStatus === 'rejected' || rawStatus === 'ditolak';
    const isBulky = isBulkyOrUnsuitableProduct(parsed.detectedProduct, { niche });
    const isMatchFalse = isVideoFirstMode
      ? (isBulky || parsed.isUsableSourceVideo === false)
      : (parsed.isProductMatch === false || parsed.isExactProductMatch === false || isBulky);
    const hasFace = parsed.hasFaceIn916Frame === true ||
      parsed.hasFaceOrHumanInSelectedFrames === true ||
      parsed.hasFaceInSelectedClips === true;
    const hasWatermarkInFrame = parsed.hasWatermarkIn916Frame === true || parsed.hasCenterObstructingWatermark === true;
    const hasSocialOrChannelInFrame = parsed.hasSocialOrChannelLogoIn916Frame === true || parsed.hasSocialMediaOrChannelIdentityIn916Frame === true;
    const hasSubtitles = parsed.hasSubtitlesIn916Frame === true || parsed.hasSubtitlesOrBurnedText === true || parsed.hasBurnedText === true;
    const hasFloatingText = parsed.hasFloatingTextIn916Frame === true || parsed.hasTextOverlaysIn916Frame === true;
    const hasGraphic = parsed.hasAnimatedGraphicOverlayIn916Frame === true;
    const hasBumper = parsed.hasBumperPhotoInFrame === true || parsed.hasBumperPhotoOrIntroCard === true;
    const hasStaticLogo = parsed.hasStaticChannelLogoIn916Frame === true;
    const isSynthetic = parsed.isAiGeneratedOrSynthetic === true;
    const reasonText = String(parsed.reason || parsed.rejectionReason || '').trim();
    const reasonLower = reasonText.toLowerCase();

    // Check if the reason explicitly cites violations inside the 9:16 frame
    const mentionsGraphicInReason = isRejectStatus &&
      (reasonLower.includes('animasi') || reasonLower.includes('grafis') || reasonLower.includes('overlay') || reasonLower.includes('stiker') || reasonLower.includes('kartun')) &&
      (reasonLower.includes('9:16') || reasonLower.includes('tengah') || reasonLower.includes('menutupi') || reasonLower.includes('center')) &&
      !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16') && !reasonLower.includes('tidak ada animasi') && !reasonLower.includes('bebas animasi');
    const mentionsBumperInReason = reasonLower.includes('bumper') || reasonLower.includes('intro card') || reasonLower.includes('opening card') || reasonLower.includes('slide statis');
    const mentionsFaceInReason = reasonLower.includes('wajah') || reasonLower.includes('face') || reasonLower.includes('manusia') || reasonLower.includes('orang');
    const mentionsWatermarkInFrame = isRejectStatus && (reasonLower.includes('watermark') || reasonLower.includes('capcut')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');
    const mentionsLogoInFrame = (isRejectStatus || hasStaticLogo) && (reasonLower.includes('logo') || reasonLower.includes('tiktok') || reasonLower.includes('channel') || reasonLower.includes('identitas') || reasonLower.includes('sosmed')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');
    const mentionsSubtitlesInReason = reasonLower.includes('subtitle') || reasonLower.includes('caption') || reasonLower.includes('teks berjalan') || reasonLower.includes('terjemahan') || reasonLower.includes('teks mengambang') || reasonLower.includes('floating text') || reasonLower.includes('stiker teks') || reasonLower.includes('teks promo') || reasonLower.includes('tulisan');

    const shouldReject = isRejectStatus || isMatchFalse || hasFace || hasWatermarkInFrame || hasSocialOrChannelInFrame || hasSubtitles || hasFloatingText || hasGraphic || hasBumper || hasStaticLogo || isSynthetic ||
      mentionsFaceInReason || mentionsGraphicInReason || mentionsBumperInReason || mentionsWatermarkInFrame || mentionsLogoInFrame || mentionsSubtitlesInReason;

    if (shouldReject) {
      let rejectionMsg = reasonText;

      // Sanitize nonsensical AI conflations (e.g. "produk tidak cocok dengan menampilkan wajah atau vlogger")
      const lower = (rejectionMsg || '').toLowerCase();
      const hasConflation = lower.includes('tidak cocok') && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia') || lower.includes('orang'));
      const isGraphicMisclassifiedAsFace = (hasGraphic || mentionsGraphicInReason) && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia'));

      if (hasConflation || isGraphicMisclassifiedAsFace || !rejectionMsg) {
        if (hasGraphic || mentionsGraphicInReason) {
          rejectionMsg = 'Video ditolak oleh AI: Mengandung grafis animasi overlay, stiker kartun, atau elemen grafis tempelan di frame 9:16.';
        } else if (hasBumper || mentionsBumperInReason) {
          rejectionMsg = 'Video ditolak oleh AI: Mengandung foto bumper atau kartu intro statis pada video.';
        } else if (hasSocialOrChannelInFrame || hasStaticLogo || mentionsLogoInFrame) {
          rejectionMsg = 'Video ditolak oleh AI: Mengandung logo media sosial atau identitas channel yang masuk ke frame 9:16.';
        } else if (hasWatermarkInFrame || mentionsWatermarkInFrame) {
          rejectionMsg = 'Video ditolak oleh AI: Mengandung watermark digital yang masuk ke dalam frame 9:16 output.';
        } else if (hasSubtitles || hasFloatingText || mentionsSubtitlesInReason) {
          rejectionMsg = 'Video ditolak oleh AI: Mengandung subtitle, teks mengambang, atau stiker teks editan pada frame 9:16.';
        } else if (hasFace || mentionsFaceInReason) {
          rejectionMsg = 'Video ditolak oleh AI: Video didominasi wajah/vlogger manusia tanpa cukup cuplikan peragaan tangan (wajib cuplikan tangan/hands-only bersih).';
        } else if (isSynthetic) {
          rejectionMsg = 'Video ditolak oleh AI: Terdeteksi video AI / animasi / CGI, bukan demonstrasi fisik nyata.';
        } else if (isBulky) {
          rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'perabot besar / produk set'}) tergolong perabot/rak besar atau paket/set/bundle yang dilarang.`;
        } else if (isMatchFalse) {
          rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'tidak cocok'}) tidak cocok dengan link Shopee.`;
        } else {
          rejectionMsg = 'Video ditolak oleh AI: Tidak memenuhi syarat affiliate faceless / bersih.';
        }
      }
      console.warn(`[Gemini File API] ⛔ VIDEO RESMI DITOLAK OLEH AI: ${rejectionMsg}`);
      const rejectError = new Error(`Video ditolak oleh Gemini 1.5 Flash: ${rejectionMsg}`);
      rejectError.isAiRejection = true;
      rejectError.rejectionReason = rejectionMsg;
      throw rejectError;
    }

    let rawTimestamps = [];
    if (Array.isArray(parsed.timestamps)) {
      rawTimestamps = parsed.timestamps;
    } else if (Array.isArray(parsed.clips)) {
      rawTimestamps = parsed.clips.map((c) => c.startSeconds ?? c.startTime);
    } else if (Array.isArray(parsed.frames)) {
      rawTimestamps = parsed.frames;
    }

    let candidateClips = [];
    if (rawTimestamps.length > 0) {
      for (const rawTs of rawTimestamps) {
        const sec = typeof rawTs === 'number' ? rawTs : parseTimeToSeconds(rawTs);
        if (isNaN(sec) || sec < 0 || sec > totalDuration) continue;
        const minSafeStart = Math.max(introCutoffSec || 0, (parsed.hasOpeningIntro ? (Number(parsed.introDurationSeconds) || 5) : 0));
        let startSec = Math.max(0, Math.min(totalDuration - clipSec, Math.round(sec * 10) / 10));
        if (startSec < minSafeStart) {
          startSec = Math.min(totalDuration - clipSec, minSafeStart);
        }
        const endSec = Math.round((startSec + clipSec) * 10) / 10;
        candidateClips.push({
          startSeconds: startSec,
          endSeconds: endSec,
          duration: clipSec,
          startTime: formatSeconds(startSec),
          endTime: formatSeconds(endSec),
          reason: `Cuplikan produk di detik ${formatSeconds(startSec)}`,
          isCleanAffiliateShot: true,
          hasProductBrand: Boolean(parsed.hasProductBrand),
          reframe: {
            ...DEFAULT_REFRAME,
            renderMode: 'stage_80',
          },
        });
      }
    }

    const hasProductBrand = Boolean(parsed.hasProductBrand);
    const detectedBrand = (parsed.detectedBrand || '').trim() || (hasProductBrand ? 'Brand Terdeteksi' : 'none');
    const allowHflip = hasProductBrand ? false : (parsed.allowHflip !== false);

    const clips = normalizeClipPlan(candidateClips, totalDuration, {
      allowFallback: allowFallbackClips,
      hasProductBrand,
      allowHflip,
      sceneDuration: clipSec,
    });
    const duration = clips.reduce((total, clip) => total + (clip.endSeconds - clip.startSeconds), 0);

    onProgress({
      step: 'gemini_vision',
      message: `Gemini 1.5 Flash selected ${clips.length} clean ${clipSec}s product shots (${duration.toFixed(1)}s total).`,
      progress: 55,
    });

    return {
      detectedProduct: (parsed.detectedProduct || '').trim() || productTitle,
      startTime: clips[0].startTime,
      endTime: clips[clips.length - 1].endTime,
      startSeconds: clips[0].startSeconds,
      endSeconds: clips[clips.length - 1].endSeconds,
      duration,
      productHook: parsed.productHook || getDynamicProductHookFallback(productTitle),
      hasProductBrand,
      detectedBrand,
      allowHflip,
      reframe: clips[0].reframe,
      clips,
    };
  } finally {
    if (uploadResponse?.file?.name) {
      try {
        await fileManager.deleteFile(uploadResponse.file.name);
        console.log(`[Gemini File API] Cleaned up uploaded file: ${uploadResponse.file.name}`);
      } catch (delErr) {
        console.warn('[Gemini File API] Cleanup file warning:', delErr.message);
      }
    }
  }
}

/**
 * Stage 1, Step A: Calls AI Vision API (OpenRouter with ffmpeg frames)
 * with automatic fallback to Gemini File API (Gemini 1.5 Flash).
 */
export async function selectHighlightWithAI({
  apiKey,
  aiProvider,
  frames,
  videoPath = null,
  youtubeUrl = null,
  videoMetadata,
  productTitle,
  productDescription,
  productImage = '',
  shopeeLink,
  sceneDuration = 4.8,
  allowFallbackClips = false,
  introCutoffSec = 0,
  isVideoFirst = false,
  niche = 'kitchen_tools',
  onProgress = () => { }
}) {
  const reqProvider = (aiProvider || '').trim().toLowerCase();
  const envEngine = (process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
  const selectedEngine = reqProvider || envEngine || 'gemini';
  const isGeminiMode = selectedEngine === 'gemini' || selectedEngine === 'gemini_direct';
  const geminiKey = getDirectGeminiApiKey(apiKey);

  // Pola 1: Gemini File API + Gemini (Jadikan DEFAULT)
  if (isGeminiMode) {
    if (geminiKey && youtubeUrl && (youtubeUrl.includes('youtube.com') || youtubeUrl.includes('youtu.be'))) {
      console.log('[AIService Vision] Pola Gemini: Menganalisa via native YouTube Stream URL (0 MB kuota lokal)...');
      return await analyzeYouTubeVideoWithGemini({
        youtubeUrl,
        apiKey,
        productTitle,
        productDescription,
        productImage,
        shopeeLink,
        sceneDuration,
        allowFallbackClips,
        totalDuration: videoMetadata?.duration || 600,
        introCutoffSec,
        isVideoFirst,
        niche,
        onProgress,
      });
    }

    if (geminiKey && videoPath && fs.existsSync(videoPath)) {
      console.log('[AIService Vision] Pola Gemini: Menganalisa via Gemini File API...');
      return await analyzeVideoWithGeminiFileApi({
        videoPath,
        apiKey,
        productTitle,
        productDescription,
        productImage,
        shopeeLink,
        sceneDuration,
        allowFallbackClips,
        introCutoffSec,
        isVideoFirst,
        niche,
        onProgress,
      });
    }
  }

  // Jika Pola 2 (FFmpeg + OpenRouter) atau Pola 1 fallback ke frame analisis via Gemini Direct
  let activeConfig = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider: selectedEngine });
  let { client, models: modelFallbackList, provider } = activeConfig;
  let activeModel = modelFallbackList[0];

  const clipSec = Math.max(3.5, Math.min(5.0, Number(sceneDuration) || 4.8));
  const isVideoFirstMode = Boolean(isVideoFirst || !shopeeLink);

  onProgress({
    step: 'gemini_vision',
    message: isVideoFirstMode
      ? `Analyzing frames with ${provider} (${activeModel}) [Mode: Video-First Discovery]...`
      : `Analyzing full video frames with ${provider} (${activeModel}) to plan fast ${clipSec}s product shots...`,
    progress: 45
  });

  const totalDuration = videoMetadata?.duration || 60;
  const prodInfo = extractCoreProductInfo(productTitle || videoMetadata?.title, productDescription || videoMetadata?.description);
  const coreNoun = prodInfo.coreProductNoun || 'Produk Praktis';
  const effectiveTitle = prodInfo.cleanTitle || (productTitle || videoMetadata?.title || '').trim() || coreNoun;
  const effectiveDesc = (productDescription || videoMetadata?.description || '').trim().slice(0, 500);
  const preset = getNichePreset(niche);

  let resolvedRefImage = null;
  if (productImage) {
    try {
      resolvedRefImage = await resolveImageBufferAndBase64(productImage);
      if (resolvedRefImage) {
        console.log(`[selectHighlightWithAI] Menambahkan foto referensi produk Shopee (${resolvedRefImage.mimeType}) sebagai Gambar #1.`);
      }
    } catch (imgErr) {
      console.warn(`[selectHighlightWithAI] Gagal memuat foto referensi produk: ${imgErr.message}`);
    }
  }

  const systemPrompt = `You are an expert Short-Form Affiliate Video QC Director specializing in Shopee Video FYP Algorithms.
Evaluate the ${frames.length} sampled frames of the source video for the target Shopee product: "${coreNoun}" (Listing: "${effectiveTitle}").

CRITICAL MANDATORY ZERO-TOLERANCE RULES:

RULE 1: ABSOLUTE ZERO HARDCODED SPEECH SUBTITLES & ZERO BURNED-IN CAPTION BARS:
- DILARANG KERAS MENERIMA VIDEO YANG MEMILIKI SUBTITLE / TEKS CAPTION UCAPAN BAWAAN!
- Inspect every frame (bottom, middle, top, edges) for burned-in speech subtitles, translated lyric bars, or running dialogue captions.
- Reason: The affiliate clipper generates and burns its own clean, animated Indonesian subtitles. Any source video with existing burned-in speech subtitles causes terrible overlapping double-subtitles and is unwatchable!
- ZERO TOLERANCE FOR POST-PRODUCTION TEXT OVERLAYS & COLORED BANNERS: Dilarang ada stiker teks, teks keterangan digital editan, banner teks statis, atau kartu persegi berlatar warna (misal: kotak kuning/merah/putih dengan teks) di frame 9:16 tengah.
- OPENING INTRO BUMPER / TITLE CARD TOLERANCE (CRITICAL MANDATE):
  * JIKA VIDEO MEMILIKI KARTU INTRO / BUMPER PEMBUKA / LOGO CHANNEL ANIMASI DI DETIK 0 SAMPAI DETIK 5 (Frame 1 atau 2): JANGAN DITOLAK!
  * Video TETAP DITERIMA (status: 'accept') asalkan frame demonstrasi produk setelahnya bersih dan faceless.
  * AI WAJIB MEMBUANG INTRO TERSEBUT: HANYA pilih frame yang dimulai SETELAH INTRO SELESAI (misal: frame dengan timestamp >= 5s, saat video sudah murni masuk ke peragaan produk fisik oleh tangan)!
  * Frame kartu bumper intro pembuka TIDAK BOLEH dimasukkan ke dalam daftar "frames"!
- CRITICAL EXCEPTION (PHYSICAL PRODUCT TEXT IS 100% PERMITTED):
  * Real physical text, brand marks, buttons, or embossed markings directly ON THE PHYSICAL PRODUCT APPLIANCE CHASSIS ITSELF (e.g. brand logo "Philips", "Joybos", "Midea", "Xiaomi", button markings "ON/OFF", "Power", "Speed 1 2", volume "500ml", "100°C", "Stainless Steel 304") is 100% NATURAL AND FULLY ACCEPTABLE!
  * STRICT BAN ON PAPER MANUALS & PACKAGING TEXT: Paper instruction manuals, warranty cards, cardboard packaging text, shipping labels, and leaflets are STRICTLY FORBIDDEN! Do NOT select frames displaying paper documents or cardboard packaging text!
  * NEVER reject a video because of text or brand logos printed physically on the product body itself!

RULE 2: PRODUCT IDENTIFICATION & NICHE VALIDATION:
${buildNicheProductCriterion(niche, coreNoun, effectiveTitle, isVideoFirstMode, effectiveDesc)}
- If rejected for wrong product, category mismatch, or bulky items:
  {"status": "reject", "detectedProduct": "<nama produk yang tampak>", "isExactProductMatch": false, "reason": "Produk di video (<nama produk>) tidak cocok dengan niche ${preset.shortName} atau terlarang"}

${buildFaceAndMotionCriterion(niche, clipSec)}

RULE 3B: UNBOXING & PACKAGING DISCARD MANDATE (CHERRY-PICK ACTIVE USAGE, DISCARD UNBOXING FRAMES):
- JANGAN MENOLAK VIDEO HANYA KARENA ADA PROSES UNBOXING:
  * Jika video memiliki proses unboxing di awal (membuka kardus, merobek bubble wrap/plastik, unboxing paket): Video TETAP DITERIMA (status: 'accept').
- MANDAT PEMBUANGAN FRAME UNBOXING & MANUAL KERTAS:
  * AI WAJIB MEMBUANG DAN MENYINGKIRKAN SEMUA FRAME YANG MENAMPILKAN PROSES UNBOXING, KOTAK KARDUS, KEMASAN PAKET, BUBBLE WRAP, BUKU PANDUAN MANUAL KERTAS, ATAU BUSA PACKAGING!
  * Frame proses unboxing, buku panduan kertas, atau kemasan kardus DILARANG KERAS dimasukkan ke dalam daftar "frames" terpilih!
  * HANYA pilih indeks frame ("frames") ketika produk SEDANG DIGUNAKAN SECARA AKTIF / DIDEMONSTRASIKAN FUNGSINYA di luar kemasan (misal: saat memotong, mengupas, memasak, menyalakan mesin, scrolling layar HP, gaming fisik di tangan).
- TOLAK (status: 'reject') HANYA JIKA:
  * 100% seluruh video HANYA unboxing paket / membaca buku manual tanpa ada sedikit pun peragaan cara kerja fisik produk.

RULE 4: REAL AUTHENTIC PHYSICAL FOOTAGE (NO AI/CGI SLOP, NO TALKING HEADS):
- REJECT if AI-generated / synthetic / CGI / 3D animated / cartoon video.
- REJECT if pure talking-head / vlog without direct hands-on product demonstration.
- REJECT if pure parcel unboxing / bubble wrap without active product demonstration.
- REJECT if video is about repairing, fixing, servicing, replacing parts, or disassembling broken items (perbaikan, servis, barang rusak, ganti sparepart, bongkar mesin).

RULE 4B: NORMAL CAMERA ORIENTATION & ZERO PILLARBOX / NO ROTATED FOOTAGE:
- ZERO TOLERANCE FOR ROTATED OR SIDEWAYS FRAMES (MIRING / ROTATE 90 DERAJAT):
  * DILARANG KERAS memilih frame dengan orientasi kamera miring / terputar 90 derajat (sideways orientation).
  * Permukaan meja, wajan, kompor, atau tangan memegang HP harus berada pada orientasi horizontal/vertikal normal (gravitasi normal).
- ZERO TOLERANCE FOR PILLARBOX & BLACK BARS:
  * DILARANG KERAS video yang memiliki pilar hitam vertikal tebal di sisi samping (pillarbox)! Video harus memenuhi frame secara proporsional.
  * Jika video secara keseluruhan terputar/miring 90 derajat atau ber-pillarbox hitam: REJECT with reason "Orientasi kamera miring 90 derajat atau terdapat pillarbox hitam di sisi samping".

RULE 5: WATERMARKS, SOCIAL MEDIA LOGOS & CHANNEL IDENTITIES (9:16 CROP GEOMETRY RULE):
- 9:16 CROP GEOMETRY MANDATE (HORIZONTAL 16:9 vs VERTICAL 9:16 SOURCE VIDEOS):
  * HORIZONTAL 16:9 VIDEOS: The backend crops the central 9:16 vertical frame (~45-50% width). Outer margins (far left 0-20% and far right 80-100%) are completely cropped out or covered by background pillars!
  * VERTICAL 9:16 VIDEOS (SHORTS / REELS / TIKTOK): ZERO HORIZONTAL CROPPING OCCURS! The full 100% width and all four corners remain completely visible in the final output!
    THEREFORE: In vertical videos, ANY watermark, channel handle, or creator text overlay anywhere in the frame (including corners and margins) CANNOT be cropped out and MUST BE REJECTED IMMEDIATELY!
- STRICT ZERO-TOLERANCE INSIDE THE 9:16 OUTPUT FRAME:
  * DILARANG KERAS jika watermark digital, logo TikTok/YouTube, atau identitas channel MASUK KE DALAM FRAME 9:16 TENGAH (area yang menutupi peragaan produk)!
  * Setiap watermark atau logo yang masuk ke dalam frame 9:16 wajib DITOLAK karena tidak bisa terpotong.
  * PERINGATAN KERAS WATERMARK ABU-ABU / TRANSPARAN / SAMAR:
    Perhatikan dengan sangat teliti setiap watermark semi-transparan, watermark abu-abu muda, logo rumah/bangunan/karakter, atau teks merek kreator/studio (seperti logo channel samar, teks abu-abu di sudut atas atau tengah frame).
    JIKA WATERMARK ABU-ABU/SAMAR INI TERLIHAT DI DALAM AREA FRAME PERAGAAN (tidak terpotong habis di luar layar), VIDEO WAJIB LANGSUNG DITOLAK: {"status": "reject", "hasWatermarkIn916Frame": true, "reason": "Video ditolak: Mengandung watermark abu-abu/logo samar di dalam frame."}
- PHYSICAL PRODUCT BRANDING IS FULLY ACCEPTABLE:
  * Merek, logo, atau tulisan yang tercetak/terukir secara fisik pada bodi produk (misal: "Philips", "Joybos", "Xiaomi") BUKAN watermark dan 100% DITERIMA!

RULE 5B: ANIMATED GRAPHICS, STICKERS & OVERLAYS (9:16 CROP TOLERANCE RULE):
- Area sayap kiri dan kanan di luar frame tengah 9:16 akan terpotong habis atau tertutup pilar.
- Jika stiker kartun, animasi, emoji, banner subscribe, atau overlay grafis berada di sayap KIRI atau KANAN (di luar area 9:16 tengah): TETAP DITERIMA (100% ACCEPTABLE)! JANGAN DITOLAK!
- Grafis animasi AKAN TERTOLAK HANYA JIKA ADA DI DALAM FRAME 9:16 TENGAH dan menutupi peragaan produk.
- Jika pada frame tertentu terdapat grafis animasi/transisi sekilas di dalam 9:16, AI CUKUP MEMBUANG frame tersebut dan TIDAK memasukkannya ke dalam daftar "frames" terpilih.

CRITERIA FOR ACCEPTANCE (ALL MUST BE TRUE):
1. Functionally & physically matches target product: "${coreNoun}" (${effectiveTitle}).
   - MARKET COMPATIBILITY: The product demonstrated MUST match generic OEM / white-label household gadgets, kitchen tools, or daily appliances widely sold across Shopee regional markets (Shopee Indonesia, Malaysia, Thailand, Vietnam, Philippines, Singapore, Taiwan, Brazil).
   - Multi-country Shopee / Asian OEM demonstration videos (hands-on tabletop demos from SEA/Asian sellers or creators) are 100% WELCOME and ACCEPTABLE.
   - STRICTLY REJECT US/Western-exclusive retail items: If the video clearly shows an exclusive US/Western retail product or retail packaging with Amazon, Walmart, Target, Home Depot, or Best Buy branding not found on Shopee, output status reject.
2. Clean Hands-On Demonstration in Selected Frames: Every single selected frame is 100% faceless (hands/fingers operating on tabletop only). Any face frames from the source video are discarded.
3. 100% Clean from hardburned speech subtitles/captions and colored text banner boxes inside 9:16 frame (physical text/labels on the product are 100% allowed).
4. 100% Clean from watermarks, social media logos, and channel identities inside the 9:16 central frame (outer left/right watermarks that get cropped/covered are acceptable).
5. Real authentic physical demonstration (5 to 8 clean clips across the storyboard for full 30 to 35 second video ad).

Output strictly valid JSON with this exact schema:
If ACCEPTED:
{
  "status": "accept",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": true,
  "hasFaceIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasOnlyPhysicalProductText": true,
  "isAiGeneratedOrSynthetic": false,
  "storyboard": {
    "clip1_full_product": 2,
    "clip2_feature": 5,
    "clip3_action_demo": 9,
    "clip4_action_demo_diff": 14,
    "clip5_action_demo": 19,
    "clip6_full_product": 25,
    "clip7_full_product": 28
  },
  "frames": [2, 5, 9, 14, 19, 25, 28],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk (DILARANG pakai kata 'fix' / 'fiks'!)",
  "hasProductBrand": false,
  "detectedBrand": "none"
}

If REJECTED:
{
  "status": "reject",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "isFacelessIn916Frame": false,
  "hasHumanOrFaceAnywhereInFrames": false,
  "hasFaceIn916Frame": false,
  "hasAnimatedGraphicOverlayIn916Frame": false,
  "hasBumperPhotoInFrame": false,
  "hasStaticChannelLogoIn916Frame": false,
  "hasWatermarkIn916Frame": false,
  "hasSocialOrChannelLogoIn916Frame": false,
  "hasSubtitlesIn916Frame": false,
  "hasFloatingTextIn916Frame": false,
  "hasOnlyPhysicalProductText": false,
  "isAiGeneratedOrSynthetic": false,
  "reason": "<PILIH SATU alasan akurat: 'Terdapat grafis animasi overlay/stiker di dalam frame 9:16 tengah' ATAU 'Foto bumper statis terdeteksi' ATAU 'Logo channel statis masuk ke frame 9:16' ATAU 'Menampilkan wajah orang/vlogger' ATAU 'Mengandung subtitle ucapan' ATAU 'Produk tidak cocok'>"
}

CRITICAL RULES FOR REJECTION OUTPUT:
1. "isExactProductMatch": Set to true if the item demonstrated in the video matches "${effectiveTitle}", even if rejected for policy. Set to false ONLY if the product is physically different.
2. "reason": DILARANG KERAS MENGGABUNGKAN DUA ALASAN BERBEDA (seperti "produk tidak cocok dengan menampilkan wajah atau vlogger")! Berikan SATU alasan tunggal yang presisi. Stiker kartun, animasi, atau emoji BUKAN vlogger manusia!`;

  // Bound frames to at most 30 keyframes for Gemini Vision / AI APIs
  let evalFrames = frames || [];
  if (evalFrames.length > 30) {
    const step = (evalFrames.length - 1) / 29;
    const sampled = [];
    for (let i = 0; i < 30; i++) {
      const idx = Math.round(i * step);
      if (evalFrames[idx] && !sampled.includes(evalFrames[idx])) {
        sampled.push(evalFrames[idx]);
      }
    }
    evalFrames = sampled;
  }

  const userPrompt = `Target Shopee Product: "${effectiveTitle}"
${effectiveDesc ? `Product Description: "${effectiveDesc}"` : ''}
${resolvedRefImage ? `[OFFICIAL REFERENCE PRODUCT PHOTO (SHOPEE LISTING) ATTACHED AS IMAGE #1]:
Image #1 is the OFFICIAL REFERENCE PHOTO of the target product from the Shopee listing.
The subsequent ${evalFrames.length} images are sampled frames from the candidate video(s).
Carefully compare the candidate video frames directly against the reference product in Image #1:
- The physical item demonstrated in the video frames MUST match or be the same product / OEM equivalent as shown in Image #1.
- Minor variations in brand logo on chassis, color accent, or button placement are 100% ACCEPTABLE.
- If the video shows a completely DIFFERENT product or category, output:
  {"status": "reject", "detectedProduct": "<nama produk>", "isExactProductMatch": false, "reason": "Produk di video tidak cocok dengan foto produk target"}
` : ''}
Total Duration: ${totalDuration}s
Sampled Frames:
${evalFrames.map((f, i) => `#${i + 1} (${f.displayLabel || f.timeFormatted || formatSeconds(f.timestamp)})`).join(', ')}

Review visual frames carefully against the 5 Mandatory Acceptance Criteria:
1. Exact Product Match & Shopee Regional Market Compatibility:
   - Does the physical item in the video match "${effectiveTitle}" and is it compatible with products sold across Shopee (Shopee Indonesia, Malaysia, Thailand, Vietnam, Philippines, Taiwan)? Hands-on tabletop demos of Asian OEM items are 100% WELCOME.
   - If DIFFERENT product, compilation, or US/Western-exclusive retail item (prominent Amazon, Walmart, Target packaging not found on Shopee): output {"status": "reject", "detectedProduct": "<nama produk>", "isExactProductMatch": false, "reason": "Produk di video tidak cocok dengan ekosistem produk Shopee (eksklusif pasar barat/Amazon)"}
2. Faceless QC: Inspect ALL ${evalFrames.length} frames. Does ANY frame show a human face, head, hair, or person talking?
   - If ANY face or person is visible in ANY frame: output {"status": "reject", "hasHumanOrFaceAnywhereInFrames": true, "isFacelessIn916Frame": false, "hasFaceIn916Frame": true, "reason": "Video ditolak: Menampilkan wajah/orang (wajib 100% faceless tabletop)"}
   - Dilarang memilih frame tangan dari video yang ada vlogger/orangnya!
3. Subtitle, Floating Text, & Graphic Overlay QC (with Opening Intro Bumper Tolerance):
   - OPENING INTRO TOLERANCE: If frame #1 (or opening 0-5s) contains an intro bumper or title card, DO NOT REJECT the video! Simply DISCARD the intro frame by picking frames only from index #2 onwards!
   - NOTE: Physical text, brand names, or button markings printed/molded ON THE PHYSICAL PRODUCT are 100% ACCEPTABLE and NOT subtitles!
   - Only reject if speech captions, dialogue subtitles, floating promotional text, or cartoon graphic overlays cover the product demonstration, or if the entire video is a static photo bumper slideshow.
4. Watermark & Logo QC (9:16 Crop Tolerance):
   - Watermark/logo di pojok KIRI atau KANAN video (di luar area tengah 9:16) TETAP DITERIMA karena akan terpotong/tertutup pilar.
   - Hanya tolak jika watermark digital, logo TikTok/YouTube, atau identitas channel MASUK KE AREA 9:16 TENGAH: output {"status": "reject", "hasWatermarkIn916Frame": true, "reason": "Video ditolak: Watermark masuk ke dalam frame 9:16."}
5. MANDATORY 7-SLOT AFFILIATE STORYBOARD ARCHITECTURE (WAJIB 7 ADENGAN BERBEDA):
   Video reels/shorts affiliate WAJIB berganti adegan setiap ~5 detik dan DILARANG KERAS monoton!
   - ATURAN KHUSUS SLOT 1: "clip1_full_product" (00:00-00:05) WAJIB MENAMPILKAN FISIK PRODUK SECARA UTUH (Opening Hero Shot / beauty shot produk di atas meja / unboxing rapi / penampakan fisik produk). DILARANG KERAS frame sedang digosok, diperas, dipotong, atau aksi ekstrem di Slot 1!
   ${preset.storyboardInstructions}
6. 100% PRODUCT VISUAL CONSISTENCY & DYNAMIC SCENE DIVERSITY:
   - KONSISTENSI PRODUK ADALAH ATURAN NOMOR 1: Seluruh 7 adegan yang dipilih (Slot 1 sampai Slot 7) WAJIB menampakkan MODEL PRODUK FISIK YANG SAMA PERSIS (model, bentuk, material, warna, dan fungsi identik dengan produk target: "${coreNoun}").
   - DILARANG KERAS MENCAMPUR PRODUK BERBEDA DI ANTARA POTONGAN KLIP! (Contoh TERLARANG: Slot 1 chopper hijau 3 pisau, Slot 2 chopper putih 2 pisau; atau Slot 1 toples kaca, Slot 2 panci masak). Jika ada kandidat video yang produk fisiknya berbeda tipe/warna/model dengan produk target, JANGAN pilih frame dari video tersebut!
   - ATURAN PEMILIHAN SUMBER VIDEO:
     * JIKA HANYA 1 VIDEO SUMBER YANG PRODUKNYA COCOK PERSIS:
       PILIH SELURUH 7 SLOT DARI 1 VIDEO TERSEBUT dengan memilih momen, sudut kamera (angle), zoom hero shot, aksi pemakaian, dan tahapan demonstrasi yang berbeda agar video dinamis dan tidak monoton. JANGAN PERNAH MENOLAK (REJECT) hanya karena berasal dari 1 video sumber! Satu video sumber yang konsisten adalah pilihan terbaik untuk iklan affiliate!
     * JIKA ADA 2 ATAU LEBIH VIDEO SUMBER YANG PRODUK FISIKNYA TERBUKTI SAMA PERSIS:
       Boleh kombinasikan klip di antara video-video tersebut untuk variasi sudut pandang. Namun jika produk di video lain berbeda model/warna/bentuk, AMBIL SELURUH KLIP DARI 1 VIDEO YANG PALING SESUAI!
7. Output Format:
   - Isi objek "storyboard" dengan 7 indeks frame (bisa berupa angka N atau {"frameIndex": N, "candidateIndex": C}).
   - Isi array "frames" dengan urutan ke-7 indeks frame tersebut.
   - Output {"status": "accept", "detectedProduct": "<nama produk>", "isExactProductMatch": true, "isFacelessIn916Frame": true, "hasHumanOrFaceAnywhereInFrames": false, "hasSubtitlesIn916Frame": false, "hasFloatingTextIn916Frame": false, "hasFaceIn916Frame": false, "hasWatermarkIn916Frame": false, "hasSocialOrChannelLogoIn916Frame": false, "hasAnimatedGraphicOverlayIn916Frame": false, "hasBumperPhotoInFrame": false, "hasStaticChannelLogoIn916Frame": false, "storyboard": {"clip1_full_product": N1, "clip2_feature": N2, "clip3_action_demo": N3, "clip4_action_demo_diff": N4, "clip5_action_demo": N5, "clip6_full_product": N6, "clip7_full_product": N7}, "frames": [N1, N2, N3, N4, N5, N6, N7], "productHook": "Hook pembuka 3 detik dinamis (tanpa kata fix)", "hasProductBrand": false}`;

  const messageContent = [
    { type: 'text', text: userPrompt },
  ];

  if (resolvedRefImage) {
    messageContent.push({
      type: 'image_url',
      image_url: {
        url: resolvedRefImage.dataUri,
        detail: 'low',
      },
    });
  }

  for (const f of evalFrames) {
    let imgUrl = f.base64;
    if (!imgUrl && f.filePath && fs.existsSync(f.filePath)) {
      try {
        const mime = f.filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        imgUrl = `data:${mime};base64,${fs.readFileSync(f.filePath).toString('base64')}`;
        f.base64 = imgUrl;
      } catch {}
    }
    if (imgUrl && typeof imgUrl === 'string' && (imgUrl.startsWith('data:image/') || imgUrl.startsWith('http'))) {
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: imgUrl,
          detail: 'low',
        },
      });
    }
  }

  const startTimeMs = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startTimeMs) / 1000);
    onProgress({
      step: 'gemini_vision',
      message: `${provider} (${activeModel}) menganalisis frame video & verifikasi produk... (${elapsedSec} detik)`,
      progress: Math.min(54, 45 + Math.floor(elapsedSec / 3)),
    });
  }, 2000);

  let totalRetries = modelFallbackList.length;
  let lastError = null;
  let hasFallenBackToGemini = (provider === 'Google Gemini Direct');

  for (let attempt = 0; attempt < totalRetries; attempt++) {
    activeModel = modelFallbackList[attempt];
    try {
      if (attempt > 0) {
        for (let t = 4; t > 0; t--) {
          onProgress({
            step: 'gemini_vision',
            message: `AI model sebelumnya bermasalah. Mencoba model fallback (${activeModel}) dalam ${t} detik...`,
            progress: 48,
          });
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      console.log(`[AIService Vision] Calling ${provider} with model: ${activeModel}...`);
      const payloadBytes = frames.reduce((acc, f) => acc + (f.base64 ? f.base64.length : 15000), 0) + Buffer.byteLength(systemPrompt + userPrompt, 'utf-8');
      trackBandwidth('aiRequests', payloadBytes, `AI Vision (${provider} - ${activeModel}): ${frames.length} frame`);
      const response = await client.chat.completions.create({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: messageContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 4096,
      }, { timeout: 60000, maxRetries: 0 });

      clearInterval(heartbeat);

      const msg = response.choices?.[0]?.message;
      const rawContent = (msg?.content && msg.content.trim()) ? msg.content : (msg?.reasoning || '{}');
      console.log(`[AIService ${provider} ${activeModel}] Raw response:`, rawContent);
      let parsed = repairJson(rawContent);

      const rawStatus = String(parsed.status || '').toLowerCase().trim();
      const isRejectStatus = rawStatus === 'reject' || rawStatus === 'rejected' || rawStatus === 'ditolak';
      const isBulky = isBulkyOrUnsuitableProduct(parsed.detectedProduct, { niche });
      const isMatchFalse = isVideoFirstMode
        ? (isBulky || parsed.isUsableSourceVideo === false)
        : (parsed.isProductMatch === false || parsed.isExactProductMatch === false || isBulky || parsed.isUsableSourceVideo === false);
      const hasFace = parsed.hasFaceIn916Frame === true ||
        parsed.hasFaceOrHumanInSelectedFrames === true ||
        parsed.hasFaceInSelectedClips === true;
      const hasSubtitles = parsed.hasSubtitlesIn916Frame === true || parsed.hasSubtitlesOrBurnedText === true || parsed.hasBurnedText === true;
      const hasFloatingText = parsed.hasFloatingTextIn916Frame === true || parsed.hasTextOverlaysIn916Frame === true;
      const hasGraphic = parsed.hasAnimatedGraphicOverlayIn916Frame === true;
      const hasBumper = parsed.hasBumperPhotoInFrame === true || parsed.hasBumperPhotoOrIntroCard === true;
      const hasStaticLogo = parsed.hasStaticChannelLogoIn916Frame === true;
      const hasWatermarkInFrame = parsed.hasWatermarkIn916Frame === true || parsed.hasCenterObstructingWatermark === true;
      const hasSocialOrChannelInFrame = parsed.hasSocialOrChannelLogoIn916Frame === true || parsed.hasSocialMediaOrChannelIdentityIn916Frame === true;
      const isSynthetic = parsed.isAiGeneratedOrSynthetic === true;

      const reasonText = String(parsed.reason || parsed.rejectionReason || '').trim();
      const reasonLower = reasonText.toLowerCase();

      const mentionsGraphicInReason = isRejectStatus &&
        (reasonLower.includes('animasi') || reasonLower.includes('grafis') || reasonLower.includes('overlay') || reasonLower.includes('stiker') || reasonLower.includes('kartun')) &&
        (reasonLower.includes('9:16') || reasonLower.includes('tengah') || reasonLower.includes('menutupi') || reasonLower.includes('center')) &&
        !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16') && !reasonLower.includes('tidak ada animasi') && !reasonLower.includes('bebas animasi');
      const mentionsBumperInReason = reasonLower.includes('bumper') || reasonLower.includes('intro card') || reasonLower.includes('opening card') || reasonLower.includes('slide statis');
      const mentionsFaceInReason = reasonLower.includes('wajah') || reasonLower.includes('face') || reasonLower.includes('manusia') || reasonLower.includes('orang');
      const mentionsSubtitlesInReason = reasonLower.includes('subtitle') || reasonLower.includes('caption') || reasonLower.includes('teks berjalan') || reasonLower.includes('terjemahan') || reasonLower.includes('teks mengambang') || reasonLower.includes('floating text') || reasonLower.includes('stiker teks') || reasonLower.includes('teks promo') || reasonLower.includes('tulisan');
      const mentionsWatermarkInFrame = isRejectStatus && (reasonLower.includes('watermark') || reasonLower.includes('capcut')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');
      const mentionsLogoInFrame = (isRejectStatus || hasStaticLogo) && (reasonLower.includes('logo') || reasonLower.includes('tiktok') || reasonLower.includes('channel') || reasonLower.includes('identitas') || reasonLower.includes('sosmed')) && !reasonLower.includes('terpotong') && !reasonLower.includes('luar frame') && !reasonLower.includes('di luar 9:16');

      const selectedIndices = Array.isArray(parsed.frames) ? parsed.frames : [];
      const hasValidFrames = selectedIndices.length >= 1;

      const shouldReject = isRejectStatus || isMatchFalse || hasFace || hasWatermarkInFrame || hasSocialOrChannelInFrame || hasSubtitles || hasFloatingText || hasGraphic || hasBumper || hasStaticLogo || isSynthetic ||
        mentionsFaceInReason || mentionsGraphicInReason || mentionsBumperInReason || mentionsWatermarkInFrame || mentionsLogoInFrame || mentionsSubtitlesInReason || !hasValidFrames;

      if (shouldReject) {
        let rejectionMsg = reasonText;

        // Sanitize nonsensical AI conflations (e.g. "produk tidak cocok dengan menampilkan wajah atau vlogger")
        const lower = (rejectionMsg || '').toLowerCase();
        const hasConflation = lower.includes('tidak cocok') && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia') || lower.includes('orang'));
        const isGraphicMisclassifiedAsFace = (hasGraphic || mentionsGraphicInReason) && (lower.includes('wajah') || lower.includes('vlog') || lower.includes('manusia'));

        if (hasConflation || isGraphicMisclassifiedAsFace || !rejectionMsg) {
          if (hasGraphic || mentionsGraphicInReason) {
            rejectionMsg = 'Video ditolak: Mengandung grafis animasi overlay, stiker kartun, atau elemen grafis tempelan di frame 9:16.';
          } else if (hasBumper || mentionsBumperInReason) {
            rejectionMsg = 'Video ditolak: Mengandung foto bumper atau kartu intro statis pada video.';
          } else if (hasSocialOrChannelInFrame || hasStaticLogo || mentionsLogoInFrame) {
            rejectionMsg = 'Video ditolak: Mengandung logo media sosial atau identitas channel/kreator di frame 9:16.';
          } else if (hasWatermarkInFrame || mentionsWatermarkInFrame) {
            rejectionMsg = 'Video ditolak: Mengandung watermark digital atau watermark aplikasi editor.';
          } else if (hasSubtitles || hasFloatingText || mentionsSubtitlesInReason) {
            rejectionMsg = 'Video ditolak: Mengandung subtitle, teks mengambang, atau stiker teks editan pada frame 9:16.';
          } else if (hasFace || mentionsFaceInReason) {
            rejectionMsg = 'Video ditolak: Video didominasi wajah atau vlogger manusia tanpa cukup cuplikan peragaan tangan (wajib cuplikan peragaan tangan bersih).';
          } else if (isSynthetic) {
            rejectionMsg = 'Video ditolak: Terdeteksi video AI / animasi / CGI, bukan demonstrasi fisik nyata.';
          } else if (isBulky) {
            rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'perabot besar / produk set'}) tergolong perabot/rak besar atau paket/set/bundle yang dilarang.`;
          } else if (isMatchFalse) {
            rejectionMsg = `Video ditolak oleh AI: Produk di video (${parsed.detectedProduct || 'tidak cocok'}) tidak cocok dengan link Shopee.`;
          } else if (!hasValidFrames) {
            rejectionMsg = 'Video ditolak oleh AI: Tidak ditemukan cukup frame cuplikan produk yang bersih dan memenuhi syarat affiliate.';
          } else {
            rejectionMsg = 'Video ditolak oleh AI: Tidak memenuhi syarat affiliate faceless & bersih.';
          }
        }
        console.warn(`[AIService ${provider} ${activeModel}] ⛔ VIDEO RESMI DITOLAK OLEH AI: ${rejectionMsg}`);
        const rejectError = new Error(`Video ditolak oleh AI (${activeModel}): ${rejectionMsg}`);
        rejectError.isAiRejection = true;
        rejectError.rejectionReason = rejectionMsg;
        throw rejectError;
      }

      // Gunakan 7-Slot Storyboard Architecture sesuai permintaan pengguna:
      // Slot 1: Visual produk utuh (Opening Hero)
      // Slot 2: Fitur & keunggulan fisik
      // Slot 3: Peragaan #1 (Aksi awal)
      // Slot 4: Peragaan #2 dengan visual berbeda (angle / surface / video berbeda)
      // Slot 5: Peragaan #3 (hasil / pembuktian / busa / bilas)
      // Slot 6 & 7: WAJIB visual produk utuh (Penutup & Call to Action Checkout)
      let candidateClips = build7SlotStoryboardClips({
        parsed,
        frames: evalFrames,
        totalDuration,
        clipSec,
        introCutoffSec,
        niche
      });

      // Fallback ke legacy loop jika build7SlotStoryboardClips kosong
      if ((!candidateClips || candidateClips.length === 0) && selectedIndices.length > 0) {
        candidateClips = [];
        for (const rawIdx of selectedIndices) {
          const idx = parseInt(rawIdx, 10);
          if (isNaN(idx) || idx < 1 || idx > evalFrames.length) continue;
          const frameObj = evalFrames[idx - 1];
          const ts = frameObj ? frameObj.timestamp : (idx * (totalDuration / evalFrames.length));
          const minSafeStart = Math.max(introCutoffSec || 0, 0);
          const rawStart = Math.max(0, Math.min(totalDuration - clipSec, Math.round(ts * 10) / 10));
          if (rawStart < minSafeStart) {
            continue; // Lewati frame yang berada di area intro bumper
          }
          const startSec = rawStart;
          // Cegah memasukkan frame dengan timestamp berdekatan (< 2.5s) pada kandidat video yang sama
          const candIdx = frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : null;
          if (candidateClips.some(c => (c.candidateIndex === candIdx || (!c.candidateIndex && !candIdx)) && Math.abs(c.startSeconds - startSec) < 2.5)) {
            continue;
          }
          const endSec = Math.round((startSec + clipSec) * 10) / 10;
          candidateClips.push({
            startSeconds: startSec,
            endSeconds: endSec,
            duration: clipSec,
            startTime: formatSeconds(startSec),
            endTime: formatSeconds(endSec),
            candidateIndex: frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : null,
            candidateTitle: frameObj?.candidateTitle || '',
            candidateUrl: frameObj?.candidateUrl || '',
            videoId: frameObj?.videoId || '',
            candidate: frameObj?.candidate || null,
            reason: `Frame #${idx} (${frameObj?.displayLabel || formatSeconds(startSec)}) peragaan produk memuaskan`,
            isCleanAffiliateShot: true,
            hasProductBrand: Boolean(parsed.hasProductBrand),
            reframe: {
              ...DEFAULT_REFRAME,
              renderMode: 'stage_80',
            }
          });
        }
      }

      const hasProductBrand = Boolean(parsed.hasProductBrand);
      const detectedBrand = (parsed.detectedBrand || '').trim() || (hasProductBrand ? 'Brand Terdeteksi' : 'none');
      const allowHflip = hasProductBrand ? false : (parsed.allowHflip !== false);

      const clips = normalizeClipPlan(candidateClips, totalDuration, {
        allowFallback: allowFallbackClips,
        hasProductBrand,
        allowHflip,
        sceneDuration: clipSec,
      });
      const duration = clips.reduce((total, clip) => total + (clip.endSeconds - clip.startSeconds), 0);

      onProgress({
        step: 'gemini_vision',
        message: `${provider} (${activeModel}) selected ${clips.length} clean ${clipSec}s product shots (${duration.toFixed(1)}s total).`,
        progress: 55
      });

      return {
        detectedProduct: (parsed.detectedProduct || '').trim() || productTitle,
        startTime: clips[0].startTime,
        endTime: clips[clips.length - 1].endTime,
        startSeconds: clips[0].startSeconds,
        endSeconds: clips[clips.length - 1].endSeconds,
        duration,
        productHook: parsed.productHook || getDynamicProductHookFallback(productTitle),
        hasProductBrand,
        detectedBrand,
        allowHflip,
        reframe: clips[0].reframe,
        clips,
      };
    } catch (err) {
      if (err.isAiRejection || String(err?.message || '').toLowerCase().includes('ditolak oleh ai') || String(err?.message || '').toLowerCase().includes('ai menolak video')) {
        clearInterval(heartbeat);
        err.isAiRejection = true;
        if (!err.rejectionReason) {
          err.rejectionReason = err.message || 'Video ditolak oleh AI';
        }
        console.warn(`[AIService ${provider}] Menghentikan model fallback karena video ditolak isi/kontennya: ${err.message}`);
        throw err;
      }
      lastError = err;
      const status = err.status || err.statusCode;
      const msg = (err.message || '').toLowerCase();
      const isFatalAuthOrBilling = status === 401 || status === 402 || msg.includes('balance') || msg.includes('credits');
      const isDailyQuotaExhausted = msg.includes('per-day') || msg.includes('daily') || msg.includes('per day') || msg.includes('quota exceeded for metric');

      if (isFatalAuthOrBilling || isDailyQuotaExhausted) {
        clearInterval(heartbeat);
        console.warn(`[AIService Vision] Fatal quota / billing error: ${msg}. Menghentikan rantai fallback.`);
        throw new Error(formatApiError(err, activeModel, provider));
      }

      if (attempt < totalRetries - 1) {
        console.warn(`[AIService Vision] AI model ${activeModel} (${provider}) gagal (attempt ${attempt + 1}, status: ${status}, error: ${msg}). Mencoba model berikutnya...`);
        continue;
      }

      clearInterval(heartbeat);
      console.error(`[AIService ${provider} ${activeModel}] Error:`, err);
      throw new Error(formatApiError(err, activeModel, provider));
    }
  }

  clearInterval(heartbeat);
  throw new Error(formatApiError(lastError, activeModel, provider));
}

/**
 * Stage 1, Step B: Calls Alibaba Qwen API (or Google Gemini)
 * using explicit user provided Product Title and Product Description to generate:
 * - Kotak Scene (Scene Breakdown)
 * - Sample Context (USPs, Target Audience, Core Problem)
 * - Google AI Studio Prompt Template
 * - Reels Caption & Hashtags
 */
export async function generateAdAdvisorScriptWithAI({
  apiKey,
  aiProvider,
  trimmedFrames,
  videoMetadata,
  productTitle,
  productDescription,
  shopeeLink,
  productHook,
  segmentDuration = 33,
  sceneDuration = 3.3,
  niche = 'kitchen_tools',
  onProgress = () => { }
}) {
  let activeConfig = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider });
  let { client, models: modelFallbackList, provider } = activeConfig;
  let activeModel = modelFallbackList[0];

  const isGadget = (niche === 'gadget_smartphone');

  onProgress({
    step: 'gpt_scripting',
    message: `Analyzing trimmed video frames with ${provider} (${activeModel}) for ${isGadget ? 'YouTube Shorts Smartphone Review' : 'Shopee FYP'} Kotak Scene & Naskah...`,
    progress: 75
  });

  const effectiveTitle = (productTitle || '').trim() || videoMetadata?.title || (isGadget ? 'Smartphone Flagship & Mid-Range' : 'Produk Viral Shopee');
  const effectiveDesc = truncateProductDescription(productDescription, 900);
  const targetDuration = Math.max(30, Math.min(45, Math.round(Number(segmentDuration) || 33)));
  const effectiveSceneSec = Math.max(2.5, Math.min(4.5, Number(sceneDuration) || 3.3));
  const sceneCount = Math.max(7, Math.min(12, Math.round(targetDuration / effectiveSceneSec)));
  const targetSpeechSec = Math.max(26, targetDuration - 3.5);
  const targetWords = Math.round(targetSpeechSec * 1.95); // ~55-60 words
  const minWords = Math.max(50, Math.round(targetSpeechSec * 1.8)); // >= 50 words
  const maxWords = Math.max(65, Math.round(targetSpeechSec * 2.1)); // <= 65 words

  const systemPrompt = isGadget
    ? `You are a Senior Tech Reviewer and Creative Director specializing in Indonesian YouTube Shorts and TikTok smartphone reviews (Faceless B-roll tech content).

You will receive the Product Title, Product Description, and the sampled frames of a ${targetDuration}-second video clip (${sceneCount} fast scenes of ~${effectiveSceneSec.toFixed(1)}s each).

Use the proven 7-SLOT SMARTPHONE REVIEW STORYBOARD FORMULA engineered for high retention and engagement on YouTube Shorts without sounding like a hard-sell telemarketer:

CRITICAL 7-SLOT SMARTPHONE STORYBOARD FORMULA (${targetDuration}s Total Runtime):
The video consists of 7 dynamic scene cuts (~${effectiveSceneSec.toFixed(1)}s each). Your voiceover MUST contain EXACTLY 7 distinct spoken lines starting with these exact timestamps:

1. [00:00] [excited] SLOT 1: THE DYNAMIC HOOK (00:00 - 00:05) -> ~7-9 kata santai
   - MUST immediately grab viewer attention within the first 3-5 seconds.
   - DILARANG KERAS menggunakan kata "fix" atau "fiks"!
   - DILARANG kata "alat dapur", "Shopee", "keranjang kuning"!
   - Hook memancing rasa penasaran penonton YouTube Shorts mengenai keunggulan bodi, layar 120Hz mulus, performa kencang anti lag, atau value for money smartphone.
   - Contoh: "Capek pakai HP yang gampang patah-patah pas scrolling? Smartphone ini mulusnya kebangetan!" / "HP harga terjangkau tapi pas dipakai gaming rasanya kayak pakai HP belasan juta!" / "Siapa sangka HP di kelas harga segini bisa ngasilin rekaman video 4K yang stabil begini?"

2. [00:05] [emphasis] SLOT 2: HERO DESAIN BODI & BUILD QUALITY (00:05 - 00:10) -> ~7-9 kata santai
   - Sorot desain bodi belakang mewah, finishing elegan tahan sidik jari, dan frame kokoh yang nyaman digenggam.
   - Contoh: "Bodi belakangnya mewah dengan frame kokoh yang sangat nyaman digenggam."

3. [00:10] [neutral] SLOT 3: LAYAR AMOLED 120HZ & NAVIGASI UI (00:10 - 00:15) -> ~7-9 kata santai
   - Sensasi scrolling sosmed super mulus 120Hz dan transisi menu responsif tanpa patah-patah.
   - Contoh: "Layar AMOLED seratus dua puluh Hertz bikin scrolling sosmed super mulus."

4. [00:15] [emphasis] SLOT 4: PERFORMA CHIPSET & MULTITASKING (00:15 - 00:20) -> ~7-9 kata santai
   - Performa kencang, RAM 8GB, storage lega 256/512GB, dan gaming lancar anti lag (DILARANG istilah GPU rumit).
   - Contoh: "Chipset kencang dipadu RAM delapan giga, gaming lancar tanpa hambatan."

5. [00:20] [excited] SLOT 5: UJI KAMERA JERNIH & FOTO TAJAM (00:20 - 00:25) -> ~7-9 kata santai
   - Kualitas rekaman video 4K stabil dan hasil jepretan foto malam/outdoor yang detail dan natural.
   - Contoh: "Hasil jepretan kamera dan rekaman videonya jernih, tajam serta stabil."

6. [00:25] [emphasis] SLOT 6: BATERAI AWET & FAST CHARGING (00:25 - 00:30) -> ~7-9 kata santai
   - Daya tahan baterai seharian untuk mobilitas tinggi dan pengisian daya kilat.
   - Contoh: "Baterai awet seharian penuh didukung teknologi pengisian daya super cepat."

7. [00:30] [excited] SLOT 7: SOFT CTA: KISARAN HARGA & LEMPAR DISKUSI PENONTON (00:30 - ${formatSeconds(targetDuration)}) -> ~7-9 kata santai
   - Sebutkan perkiraan kisaran harga pasar (Rupiah atau konversi Yuan) serta pancingan interaksi penonton di kolom komentar:
   - DILARANG KERAS kata-kata jualan: "Shopee", "keranjang kuning", "checkout sekarang", "murah meriah", "link di bio"!
   - Contoh: "Di kisaran harga dua jutaan, menurut kalian worth it gak? Komen di bawah ya!" / "Harganya ada di kisaran tiga jutaan, kalian tertarik beli gak nih? Tulis di komentar ya!"

CRITICAL TIMING, LENGTH & PACING RULE (MANDATORY):
- TEMPO BICARA WAJIB SANTAI, JELAS, DAN TIDAK TERBURU-BURU!
- Total voiceover script MUST contain between ${minWords} and ${maxWords} words (Target ideal: exactly ~${targetWords} words, ~7-9 words per line across all 7 scenes).
- DILARANG menempelkan judul panjang SEO ke dalam naskah. Gunakan nama pendek produk (2-3 kata).
- Suara narator WAJIB terdistribusi merata dari detik [00:00] sampai detik [00:30] dengan tempo santai, rileks, dan artikulasi jelas.

STRICT RULES FOR VOICE OVER:
- NEVER mention unboxing cardboard boxes, bubble wrap, or plastic packaging. Focus 100% on phone aesthetics, UI, camera, performance, and battery.
- Write in natural, engaging conversational Indonesian.
- DILARANG KERAS menggunakan kata "kece" dan "kangen".
- HINDARI KATA SLANG "ng" (nggak, ngasih, ngeliat, dll) - gunakan kata baku.
- DILARANG menyebut nama medsos lain.
- DILARANG mengatakan "link di bio", "keranjang kuning", "checkout", atau ajakan beli langsung! Ini adalah Soft CTA murni untuk YouTube Shorts review.

Output MUST be strictly valid JSON matching the requested schema.`
    : `You are a Senior Creative Director and Ad Advisor specializing in Indonesian Short-Form Affiliate Video Marketing (Shopee Video, TikTok Shop, Instagram Reels).

You will receive the explicit Product Title, Product Description, and the sampled frames of a ${targetDuration}-second video clip (${sceneCount} fast scenes of ~${effectiveSceneSec.toFixed(1)}s each).

Use the proven 7-SLOT SHOPEE AFFILIATE STORYBOARD FORMULA engineered to fill the ${targetDuration}s runtime with calm, engaging, unhurried conversational speech and drive maximum Keranjang Kuning conversions:

CRITICAL 7-SLOT STORYBOARD FORMULA (${targetDuration}s Total Runtime):
The video consists of 7 dynamic scene cuts (~${effectiveSceneSec.toFixed(1)}s each). Your voiceover MUST contain EXACTLY 7 distinct spoken lines starting with these exact timestamps:

1. [00:00] [excited] SLOT 1: THE DYNAMIC HOOK (00:00 - 00:05) -> ~7-9 kata santai
   - MUST immediately grab viewer attention within the first 3-5 seconds.
   - DILARANG KERAS menggunakan kata "fix" atau "fiks" di hook maupun seluruh naskah!
   - DILARANG sapaan basi seperti "Stop scroll!", "Halo guys!", "Racun Shopee wajib punya!".
   - DILARANG menggunakan kata "alat dapur" maupun kata "Shopee" di hook pembuka! Fokuskan ke kegiatan memasak, food prep, kerapian meja makan, atau masalah spesifik saat menyiapkan makanan.
   - PILIH SALAH SATU DARI 6 SUDUT HOOK DINAMIS BERIKUT (Sesuaikan dengan karakter produk):
     a) 🍳 Solusi Masalah Memasak & Food Prep: "Bikin sarapan jadi 2x lebih cepat cuma modal barang ini!" / "Capek bersihin percikan minyak pas goreng? Sini berkumpul." / "Solusi cerdas buat yang malas potong bahan masakan sampai nangis."
     b) 🧼 Estetika & Kerapian Ruangan (Clean Vibes): "Transformasi meja masak yang berantakan jadi rapi instan cuma pakai ini." / "Nyesel baru tahu ada organizer se-aesthetic ini buat naruh bumbu." / "Spill barang rahasia yang bikin tempat food prep estetik dan betah dipandang."
     c) 💸 Racun Belanja & Worth It (FOMO): "Barang receh online tapi gunanya bener-bener di luar nalar!" / "Jangan checkout barang lain sebelum kalian lihat fungsi benda ini!" / "Gak nyangka barang semurah ini bisa awet dan sekokoh ini buat harian."
     d) 🤫 Penasaran & Demo Visual (Faceless): "Bisa tebak gak benda sekecil ini fungsinya buat apa?" / "Satu trik rahasia biar urusan masak cepat beres." / "Ada yang aneh dari benda ini, kelihatannya simpel tapi kok efektif banget?"
     e) 📉 Perbandingan & Edukasi: "Mending beli yang versi ini daripada versi lama yang harganya selangit!" / "Battle kupas buah pakai cara viral vs manual, mana yang bikin kerjaan cepat beres?" / "Jangan ketipu sama ukurannya yang kecil, lihat dulu pas dipakai."
     f) ⏱️ Urgensi & Dorongan Klik: "Uji coba langsung: beneran mempermudah food prep atau cuma gimmick iklan?" / "Buruan cek keranjang kuning sebelum harganya naik normal besok pagi!" / "Tantangan bikin cemilan praktis cuma pakai satu benda ini!"

2. [00:05] [emphasis] SLOT 2: HERO SOLUTION & MATERIAL (00:05 - 00:10) -> ~7-9 kata santai
   - Introduce product using a short, concise spoken name (2-3 words, e.g. "alat pemeras jeruk ini", DILARANG menempelkan seluruh judul SEO yang panjang!).
   - Contoh: "Untung ada pemeras manual ini, bahannya kokoh dan praktis!"

3. [00:10] [neutral] SLOT 3: PERAGAAN AKSI AWAL (00:10 - 00:15) -> ~7-9 kata santai
   - Describe the effortless initial hands-on demonstration.
   - Contoh: "Tinggal masukkan buahnya, tekan ringan sarinya langsung keluar tuntas."

4. [00:15] [emphasis] SLOT 4: SUDUT LAIN & KEMUDAHAN FITUR (00:15 - 00:20) -> ~7-9 kata santai
   - Highlight the versatility, multi-angle ease, or ergonomic handle.
   - Contoh: "Gagangnya ergonomis anti selip, sangat nyaman dipakai setiap hari."

5. [00:20] [excited] SLOT 5: BUKTI HASIL NYATA & KEPUASAN (00:20 - 00:25) -> ~7-9 kata santai
   - Describe the satisfying result shown on screen (clean cuts, spotless shine, pure juice).
   - Contoh: "Hasil perasannya jernih maksimal tanpa biji, bersihinnya super mudah."

6. [00:25] [emphasis] SLOT 6: VALUE FOR MONEY & PROMO HEMAT (00:25 - 00:30) -> ~7-9 kata santai
   - Voiceover MUST state the price appeal:
   - "Kualitas premium harganya murah meriah, hemat gak bikin boros!"

7. [00:30] [excited] SLOT 7: SHOPEE KERANJANG POJOK KIRI BAWAH CTA (00:30 - ${formatSeconds(targetDuration)}) -> ~7-9 kata santai
   - Direct viewers with urgent FOMO to the Shopee Keranjang Kuning at the bottom-left corner:
   - "Yuk buruan checkout di keranjang pojok kiri bawah sekarang!"

CRITICAL TIMING, LENGTH & PACING RULE (MANDATORY):
- TEMPO BICARA WAJIB SANTAI, JELAS, DAN TIDAK TERBURU-BURU!
- Total voiceover script MUST contain between ${minWords} and ${maxWords} words (Target ideal: exactly ~${targetWords} words, ~7-9 words per line across all 7 scenes).
- DILARANG menempelkan judul panjang SEO ke dalam naskah. Gunakan nama pendek produk (2-3 kata).
- Suara narator WAJIB terdistribusi merata dari detik [00:00] sampai detik [00:30] dengan tempo santai, rileks, dan artikulasi jelas.

1. 'sampleContext':
   - 'productName': Explicit product name.
   - 'videoDuration': "${targetDuration} detik"
   - 'targetAudience': Specific target audience profile in Indonesia.
   - 'coreProblem': The primary pain point from the old way/conventional tool.
   - 'keyFeatures': List of 3-4 key USPs (Unique Selling Propositions).
   - 'buyingTrigger': Psychological trigger (Problem-Solution relief, FOMO, harga murah meriah).

2. 'scenes' (Kotak Scene / Fast Scene Breakdown):
   - Break into EXACTLY ${sceneCount} fast scenes (~${effectiveSceneSec.toFixed(1)}s each).
   - For each scene provide:
     * 'sceneNumber': integer (1, 2, 3... up to ${sceneCount})
     * 'timeRange': exact range e.g. "00:00 - 00:03", "00:03 - 00:07", etc.
     * 'visualDescription': Satisfying visual action happening in Indonesian.
     * 'voiceover': Spoken narration line for this scene (hanya ~5-6 kata pendek, padat, dan jelas).
     * 'adAdvisorNotes': Director notes for sound effects (SFX), visual text overlays (yellow/white text), or emotional pacing.

3. 'voiceoverScript' (Naskah Voiceover Lengkap dengan Penanda Waktu & Tag Emosi):
   - Complete Indonesian spoken narration (${minWords} - ${maxWords} words total).
   - Use dynamic emotional tone & pacing tags so the AI voiceover (Edge-TTS Gadis) sounds lively, expressive, and NEVER monotone:
     * [excited] for energetic Problem Hooks, surprise moments, and closing CTA.
     * [emphasis] to place strong vocal stress on key product features and instant benefits.
     * [soft] for empathetic problem statements.
     * [pause] for natural human breathing pauses between sentences.
   - Each line MUST start with an exact timestamp corresponding to each scene (e.g. [00:00], [00:03], [00:07], up to the closing CTA), followed by the emotion tag and spoken line.
   - Closing line MUST have the price appeal ("murah meriah") and direct CTA to "keranjang pojok kiri bawah".

STRICT RULES FOR VOICE OVER:
- ORIGINALITY & TRANSFORMATION: DILARANG hanya sekadar mendeskripsikan apa yang terlihat di video secara datar (misal: "Ini adalah alat..."). Naskah WAJIB menyajikan alur transformasi bernilai tambah: 1) Hook Masalah/Pain Point cara lama, 2) Solusi & cara kerja praktis produk, 3) Bukti/kepuasan hasil, 4) CTA penutup. Ini wajib agar video dianggap konten original bernilai tambah oleh algoritma Meta/Reels dan Shorts.
- NEVER mention unboxing, packaging, bubble wrap, or cardboard. Focus 100% on product action and problem-solving.
- Write in natural, engaging conversational Indonesian.
- DILARANG KERAS menggunakan kata "kece" dan "kangen".
- HINDARI KATA SLANG "ng" (nggak, ngasih, ngeliat, dll) - gunakan kata baku.
- DILARANG menyebut nama medsos lain (TikTok, Instagram, YouTube, Facebook, dll).
- DILARANG mengatakan "link di bio" - WAJIB gunakan "keranjang pojok kiri bawah" atau "produk di bawah".
- Ejaan baku tanpa aksen é/è.

5. 'caption':
   - High-converting, full-length Social Media Affiliate Caption for Instagram Reels, TikTok, and Shopee Video.
   - It MUST contain the following 5 structured sections separated by double newlines:
     1) Hook headline with emojis (catchy problem-question or FOMO statement, e.g. "🔥 Masih repot pakai botol biasa yang bikin boros & berantakan? 🧼✨").
     2) Problem-Solution & product intro (1-2 compelling sentences explaining why this product is a game changer).
     3) Key advantages / benefits (3-4 bullet points using '✅', e.g. "Keunggulan Utama:\n✅ Sekali tekan busa melimpah\n✅ Desain 2-in-1 hemat tempat...").
     4) Urgency & Call to Action (CTA): "Buruan checkout sekarang mumpung lagi diskon spesial & gratis ongkir! 🔥\n\n🛒 Cek produk di bio / keranjang kuning sekarang sebelum kehabisan ya!"
     5) Hashtags: 10-15 viral, affiliate, and niche-relevant hashtags.

6. 'lexicon_to_replace' (Deteksi Istilah / Kata Bahasa Inggris Otomatis):
   - Deteksi SEMUA kata, merk, atau istilah bahasa Inggris yang ada di naskah voiceover maupun judul/deskripsi produk (misal: 'steak', 'juicy', 'online', 'chopper', 'mini chopper', 'food chopper', 'stainless steel', 'air fryer', 'food grade', 'rechargeable', 'wireless', 'magic', 'brush', 'sponge', 'cleaner', 'fry pan', dll).
   - Petakan ke ejaan pelafalan fonetik bahasa Indonesia yang kaku agar dibaca natural oleh TTS Bahasa Indonesia (misal: {"chopper": "coper", "stainless steel": "stenlis stil", "air fryer": "er frayer", "steak": "stik", "juicy": "jusi"}).
   - Format wajib: Objek key-value {"kata_inggris": "ejaan_fonetik_indonesia"}. Jika tidak ada kata bahasa Inggris, isi dengan {}.

Output MUST be strictly valid JSON matching the requested schema.`;

  const userPrompt = `=== INFORMASI PRODUK UTAMA ===
Judul / Nama Produk: "${effectiveTitle}"
${effectiveDesc ? `Deskripsi & Spesifikasi Produk: "${effectiveDesc}"` : 'Deskripsi: (Analisis dari visual frame video)'}
Visual Hook: "${productHook || (isGadget ? 'Smartphone Kencang Desain Mewah!' : 'Racun Viral Wajib Punya!')}"
Durasi Video Potongan: ${targetDuration} detik (Wajib naskah dengan panjang ${minWords} - ${maxWords} kata, target ideal: ~${targetWords} kata)

Visual Frames of the concatenated 5-second AI-selected product clips (${trimmedFrames.length} frames):
${trimmedFrames.map((f, i) => `Frame #${i + 1} at timestamp ${f.timeFormatted} (${f.timestamp}s)`).join('\n')}

Gunakan informasi judul dan deskripsi produk di atas agar naskah sangat relevan dan akurat.
Buat Kotak Scene, Sample Context, Naskah Voiceover Ad Advisor, dan AI Studio prompt.

PENTING - ATURAN DURASI, TIMESTAMP & TEMPO NASKAH:
1. Pada bagian 'Sample Context' (baik di JSON maupun di prompt AI Studio), WAJIB sertakan durasi voice over: "Durasi voice over ${targetDuration} detik. ${isGadget ? 'Review smartphone YouTube Shorts' : 'Iklan affiliate viral'}...".
2. Naskah voiceover HARUS pas ${minWords} s/d ${maxWords} kata (sekitar 7-8 kata tiap scene ~${effectiveSceneSec.toFixed(1)}s) agar mengisi penuh durasi video tanpa terputus atau hening di akhir!
3. Setiap baris naskah voiceover dan prompt AI Studio WAJIB diawali penanda waktu video yang merata, misal: [00:00], [00:03], [00:07], [00:11], [00:15], [00:19], [00:23], [00:27], [00:30], dst.
4. JANGAN gunakan nama karakter suara khusus (cukup gunakan header "Speaker 1").
5. DILARANG KERAS menggunakan kata "kece"! Gunakan kata seperti keren, elegan, praktis, atau bagus.
6. DILARANG KERAS menggunakan kata "kangen" dan HINDARI kata gaul berawalan "ng" (seperti: nggak, ngasih, ngeliat, ngerasain, ngapain, dll). Gunakan bahasa Indonesia baku (tidak, memberi, melihat, dll).
7. KATA "keju" DAN "beres" WAJIB DITULIS PERSIS: "keju" dan "beres" (keju=keju, beres=beres) tanpa tanda kecil atau aksen di atas huruf e.
8. DILARANG KERAS menyebutkan nama marketplace atau platform (Shopee, TikTok, Instagram, dll) di dalam naskah voiceover!
${isGadget ? `9. UNTUK SMARTPHONE: WAJIB gunakan Soft CTA di penutup naskah: Sebutkan kisaran harga dan pancing komentar penonton (contoh: "Di kisaran harga dua jutaan, menurut kalian worth it gak? Komen di bawah ya!"). DILARANG kata "checkout", "keranjang kuning", atau "link di bio"!` : `9. JANGAN PERNAH gunakan kata "link di bio" di dalam naskah voiceover. Selalu gunakan ajakan seperti "Cek produk di bawah sekarang", "Klik produk di bawah", atau "Checkout produk di bawah sebelum kehabisan".`}
10. PADA BAGIAN 'CAPTION' (WAJIB LENGKAP 5 STRUKTUR, DILARANG CUMA 1 KALIMAT):
    Susun caption lengkap profesional yang siap copy-paste langsung:
    - Bagian 1: Headline Hook & Emojis pemancing perhatian.
    - Bagian 2: Solusi & penjelasan produk mengapa layak dibeli / dipertimbangkan.
    - Bagian 3: Keunggulan Utama / Spesifikasi Kunci (3-4 bullet points dengan tanda '✅').
    - Bagian 4: Urgensi & CTA (${isGadget ? 'Pancingan diskusi: "Menurut kalian worth it gak? Tulis di komentar ya!"' : 'Ajakan checkout keranjang kuning'}).
    - Bagian 5: 10-15 hashtag viral relevan (${isGadget ? '#reviewhp #smartphoneterbaru #gadgetindonesia #hp2jutaan #hpmurah #shorts #techreview' : '#racunshopee #shopeehaul #spillracun #reelsviral #affiliateindonesia'}).
    - DILARANG KERAS menuliskan URL/link web, karakter China (Mandarin/Hanzi), dan DILARANG hanya membuat 1 kalimat pendek!
11. Gunakan ejaan bahasa Indonesia baku yang wajar (misal: keren, elegan, praktis, keju, beres) tanpa menambahkan tanda aksen é atau è.
12. WAJIB 100% Bahasa Indonesia: DILARANG KERAS menyertakan tulisan/karakter China (Mandarin/Hanzi) di seluruh output (naskah, visual, scene, caption, prompt).

Return strict JSON in this format:
{
  "sampleContext": {
    "productName": "${effectiveTitle}",
    "videoDuration": "${targetDuration} detik",
    "targetAudience": "${isGadget ? 'Pencari smartphone, tech enthusiast, dan penonton YouTube Shorts' : 'Target audiens'}",
    "coreProblem": "${isGadget ? 'HP lama lemot, kamera buram, dan baterai boros' : 'Masalah utama'}",
    "keyFeatures": [${isGadget ? '"Layar AMOLED 120Hz", "Chipset Kencang & RAM Lega", "Kamera Jernih 4K"' : '"Fitur 1", "Fitur 2", "Fitur 3"'}],
    "buyingTrigger": "${isGadget ? 'Spek gahar di harga terjangkau' : 'Alasan psikologis beli'}"
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "timeRange": "00:00 - 00:05",
      "visualDescription": "Deskripsi visual",
      "voiceover": "Teks narasi scene 1",
      "adAdvisorNotes": "Tips sutradara (SFX / Text Overlay)"
    }
  ],
  "voiceoverScript": "${isGadget ? '[00:00] Cari HP spek kencang harga ramah kantong?\\n[00:05] Bodi belakangnya mewah dan bezel layarnya tipis...\\n[00:30] Di kisaran harga dua jutaan, worth it gak? Komen di bawah!' : '[00:00] Masih repot marut keju pakai alat lama?\\n[00:05] Kenalin parutan serbaguna ini...\\n[00:30] Cek produk di bawah sekarang!'}",
  "aiStudioPrompt": "Scene\\nStudio rekaman energik...\\n\\nSample Context\\nDurasi voice over ${targetDuration} detik...\\n\\nSpeaker 1\\n[00:00] [excited] Hook pembuka...",
  "caption": "${isGadget ? '⚡ Smartphone 2 Jutaan Rasa Belasan Juta?! Layar 120Hz & Kamera Stabil! 📱✨\\n\\nKombinasi spek juara dan harga ramah kantong! Buat kalian yang butuh HP kencang anti lemot buat harian, smartphone ini wajib masuk wishlist 😍\\n\\nKeunggulan Utama:\\n✅ Layar AMOLED 120Hz super mulus\\n✅ Chipset kencang dipadu RAM lega\\n✅ Kamera jernih dengan rekaman stabil\\n✅ Baterai badak seharian + fast charging\\n\\nMenurut kalian di kisaran harga segini worth it gak? Coba tulis pendapat kalian di kolom komentar ya! 👇🔥\\n\\n#reviewhp #smartphoneterbaru #gadgetindonesia #hpmurah #hp2jutaan #rekomendasihp #shorts #techreview' : '🔥 Masih repot pakai cara lama yang bikin boros & berantakan? 🧼✨\\n\\nKenalin solusinya! Produk ini bikin pekerjaan harian kamu jadi 2x lebih cepat, praktis, dan hasilnya jauh lebih rapi maksimal 😍\\n\\nKeunggulan Utama:\\n✅ Desain praktis, inovatif, dan mudah digunakan\\n✅ Kualitas bahan premium, awet, dan tahan lama\\n✅ Hemat waktu, tenaga, dan bikin lebih efisien\\n✅ Bikin ruangan jadi lebih bersih, rapi, dan estetik\\n\\nBuruan checkout sekarang mumpung lagi diskon spesial & gratis ongkir! 🔥\\n\\n🛒 Cek produk di bio / keranjang kuning sekarang sebelum kehabisan ya!\\n\\n#racunshopee #shopeehaul #spillracun #racuntiktok #racunbelanja #reelsviral #affiliateindonesia #barangunik #perabotandapur #dapurminimalis #fyp'}",
  "lexicon_to_replace": {
    "istilah_inggris": "pelafalan_fonetik_indonesia"
  }
}`;

  const messageContent = [
    { type: 'text', text: userPrompt },
    ...trimmedFrames.map((f) => ({
      type: 'image_url',
      image_url: {
        url: f.base64,
        detail: 'low',
      },
    })),
  ];

  const startTimeMs = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startTimeMs) / 1000);
    onProgress({
      step: 'gpt_scripting',
      message: `${provider} (${activeModel}) menyusun Kotak Scene & Naskah Ad Advisor... (${elapsedSec} detik)`,
      progress: Math.min(88, 78 + Math.floor(elapsedSec / 4)),
    });
  }, 2000);

  let totalRetries = modelFallbackList.length;
  let parsed = {};
  let lastError;
  let hasFallenBackToGemini = (provider === 'Google Gemini Direct');

  for (let attempt = 0; attempt < totalRetries; attempt++) {
    activeModel = modelFallbackList[attempt];
    try {
      if (attempt > 0) {
        for (let t = 4; t > 0; t--) {
          onProgress({
            step: 'gpt_scripting',
            message: `API overloaded/error. Switching fallback model (${activeModel}) naskah dalam ${t} detik...`,
            progress: 78,
          });
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      const response = await client.chat.completions.create({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: messageContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4000,
      });

      clearInterval(heartbeat);

      const scriptMsg = response.choices?.[0]?.message;
      const rawContent = (scriptMsg?.content && scriptMsg.content.trim()) ? scriptMsg.content : (scriptMsg?.reasoning || '{}');
      console.log(`[AIService ${provider} ${activeModel} Scripting] Raw response length: ${rawContent.length}`);
      parsed = repairJson(rawContent);

      if (!parsed || (!parsed.sampleContext && !parsed.scenes && !parsed.voiceoverScript)) {
        throw new Error(`AI model ${activeModel} mengembalikan response kosong atau tidak lengkap.`);
      }

      break; // success — exit retry loop
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode;
      const msg = (err.message || '').toLowerCase();
      const isFatalAuthOrBilling = status === 401 || status === 402 || msg.includes('balance') || msg.includes('credits');
      const isOverloaded = status === 503 || status === 529 || status === 429 || msg.includes('overload') || msg.includes('overloaded') || msg.includes('rate limit');

      if (attempt < totalRetries - 1) {
        console.warn(`[AIService Scripting] AI model ${activeModel} (${provider}) gagal (attempt ${attempt + 1}, status: ${status}, error: ${msg}). Mencoba model berikutnya...`);
        continue;
      }

      clearInterval(heartbeat);
      console.error(`[AIService ${provider} ${activeModel}] Error:`, err);
      const scriptErr = new Error(formatApiError(err, activeModel, provider));
      if (isQuotaError(err) || isOverloaded || isFatalAuthOrBilling) {
        scriptErr.isAllModelsQuotaExhausted = true;
        scriptErr.isQuotaError = true;
      }
      throw scriptErr;
    }
  }

  if (lastError && !parsed.sampleContext && !parsed.scenes) {
    clearInterval(heartbeat);
    const scriptErr = new Error(formatApiError(lastError, activeModel, provider));
    if (isQuotaError(lastError)) {
      scriptErr.isAllModelsQuotaExhausted = true;
      scriptErr.isQuotaError = true;
    }
    throw scriptErr;
  }

  const scenes = normalizeShortScenes(parsed.scenes, effectiveTitle, segmentDuration, sceneDuration);

  let voiceoverScript = (parsed.voiceoverScript || '').trim();
  if (!voiceoverScript && scenes.length > 0) {
    voiceoverScript = scenes.map(s => `[${s.timeRange ? s.timeRange.split(' - ')[0] : '00:00'}] ${s.voiceover}`).join('\n');
  }
  if (!voiceoverScript) {
    const dynamicHook = productHook || getDynamicProductHookFallback(effectiveTitle, niche);
    voiceoverScript = isGadget
      ? `[00:00] [excited] ${dynamicHook}
[00:05] [emphasis] Bodi belakangnya mewah dengan frame kokoh yang sangat nyaman digenggam.
[00:10] [neutral] Layar AMOLED seratus dua puluh Hertz bikin scrolling sosmed super mulus.
[00:15] [emphasis] Chipset kencang dipadu RAM delapan giga, gaming lancar tanpa hambatan.
[00:20] [excited] Hasil jepretan kamera dan rekaman videonya jernih, tajam serta stabil.
[00:25] [emphasis] Baterai awet seharian penuh didukung teknologi pengisian daya super cepat.
[00:30] [excited] Di kisaran harga dua jutaan, menurut kalian worth it gak? Komen di bawah ya!`
      : `[00:00] [excited] ${dynamicHook}
[00:03] [emphasis] Untung sekarang ada ${effectiveTitle} ini yang bikin praktis.
[00:07] [soft] Busa melimpah, kotoran tebal langsung rontok seketika.
[00:11] [emphasis] Menjangkau sela-sela sempit bersih tuntas tanpa baret.
[00:15] [soft] Bahannya super awet, nyaman dipakai berkali-kali.
[00:18] [excited] Harganya murah meriah banget, ramah di kantong!
[00:21] [excited] Cek keranjang pojok kiri bawah sekarang juga!`;
  }

  let rawCaption = (parsed.caption || '').trim();
  let caption = formatEnrichedCaption({
    caption: rawCaption,
    productTitle: effectiveTitle,
    productDescription: effectiveDesc,
    sampleContext: parsed.sampleContext,
    scenes,
    platform: 'clipper'
  });

  let aiStudioPrompt = (parsed.aiStudioPrompt || '').trim();
  const fallbackLastSec = Math.max(0, targetDuration - 5);
  if (!aiStudioPrompt) {
    aiStudioPrompt = `Scene\nStudio rekaman energik dengan presenter Indonesia yang antusias dan percaya diri.\n\nSample Context\nDurasi voice over ${fallbackLastSec} detik. Iklan affiliate viral. Dimulai dengan hook yang mengejutkan, membangun ke demonstrasi manfaat produk, diakhiri CTA yang meyakinkan. Nada suara hangat, antusias, dan persuasif.\n\nSpeaker 1 - Orus\n[intrigue] Stop scroll dulu! [desire] ${effectiveTitle} yang satu ini beneran wajib kamu punya! [information] ${effectiveDesc ? effectiveDesc.slice(0, 120) + '.' : 'Produk ini hadir dengan kualitas premium dan desain yang praktis untuk kebutuhan sehari-hari.'} [excited] Udah ribuan orang pake dan reviewnya bagus semua! [inspiration] Kualitasnya terbukti awet dan terpercaya untuk jangka panjang. [confident] Buruan cek produk di bawah sekarang sebelum kehabisan!`;
  } else {
    // Normalize aiStudioPrompt duration in Sample Context based on the last speaker 1 timestamp
    const timestampMatches = [...aiStudioPrompt.matchAll(/\[(\d{1,2}):(\d{2})\]/g)];
    let lastSec = fallbackLastSec;
    if (timestampMatches.length > 0) {
      const lastMatch = timestampMatches[timestampMatches.length - 1];
      const mins = parseInt(lastMatch[1], 10);
      const secs = parseInt(lastMatch[2], 10);
      lastSec = mins * 60 + secs;
    }
    if (/durasi\s+(?:video|voice\s+over)?\s*\d+\s*detik/i.test(aiStudioPrompt)) {
      aiStudioPrompt = aiStudioPrompt.replace(/durasi\s+(?:video|voice\s+over)?\s*\d+\s*detik/i, `Durasi voice over ${lastSec} detik`);
    }
    aiStudioPrompt = aiStudioPrompt.replace(/durasi\s+video/gi, 'durasi voice over');
  }

  onProgress({
    step: 'gpt_scripting',
    message: `${provider} (${activeModel}) generated Kotak Scene, Sample Context, and Naskah successfully!`,
    progress: 88
  });

  voiceoverScript = sanitizeScriptVocabulary(voiceoverScript);
  aiStudioPrompt = sanitizeScriptVocabulary(aiStudioPrompt);
  caption = sanitizeScriptVocabulary(caption);
  for (const s of scenes) {
    if (s.voiceover) s.voiceover = sanitizeScriptVocabulary(s.voiceover);
    if (s.visualDescription) s.visualDescription = sanitizeScriptVocabulary(s.visualDescription);
    if (s.adAdvisorNotes) s.adAdvisorNotes = sanitizeScriptVocabulary(s.adAdvisorNotes);
  }

  // Deteksi dan simpan otomatis kata bahasa Inggris ke kamus fonetik backend (Pendekatan LLM Pre-processing)
  const detectedLexicon = (parsed && parsed.lexicon_to_replace && typeof parsed.lexicon_to_replace === 'object')
    ? parsed.lexicon_to_replace
    : {};

  if (Object.keys(detectedLexicon).length > 0) {
    console.log(`[AIService] 📖 Mendeteksi kata bahasa Inggris dari skrip AI:`, detectedLexicon);
    saveToEnglishDictionary(detectedLexicon);
  }

  return {
    sampleContext: parsed.sampleContext || {
      productName: effectiveTitle,
      videoDuration: `${targetDuration} detik`,
      targetAudience: "Pencari produk viral & praktis",
      coreProblem: "Mencari produk berkualitas dengan harga terjangkau",
      keyFeatures: ["Praktis & Multifungsi", "Bahan Berkualitas", "Harga Terjangkau"],
      buyingTrigger: "FOMO & Diskon Terbatas"
    },
    scenes,
    voiceoverScript,
    aiStudioPrompt,
    caption,
    lexicon_to_replace: detectedLexicon,
  };
}

/**
 * Format and enrich social media caption to guarantee high-converting 5-part structure:
 * 1. Hook & Opening with emojis
 * 2. Product solution / description
 * 3. Key benefits bullet points (✅)
 * 4. Urgency & Call to action
 * 5. 10-15 Viral & category hashtags
 */
export function formatEnrichedCaption({
  caption = '',
  productTitle = '',
  productDescription = '',
  sampleContext = null,
  scenes = [],
  platform = 'clipper', // 'clipper' | 'ytcliper'
} = {}) {
  let text = (caption || '').trim();

  // 1. Sanitize text: remove URLs, shopee links, Chinese characters, comment spam
  text = text
    .replace(/(?:🛒\s*)?(?:link\s+(?:produk|shopee|pembelian)?\s*:\s*)?https?:\/\/[^\s]+/gi, '')
    .replace(/(?:🛒\s*)?(?:link\s+(?:produk|shopee|pembelian)?\s*:\s*)?shope\.ee\/[^\s]+/gi, '')
    .replace(/(?:🛒\s*)?(?:cek\s+selengkapnya\s+)?(?:cek\s+)?(?:link\s+)?(?:di\s+)?(?:kolom\s+)?komentar\s+(?:pertama|ke-1|1|pin|bawah)?(?:\s+ya)?(?:\s*[,!?. -]*[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+)*(?:\s*[,!?. -])*/gi, '')
    .replace(/cek\s+selengkapnya\s+di\s+komentar(?:\s*[,!?.])?/gi, '')
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/gu, '')
    .replace(/^[ \t]*[,!?. -]+[ \t]*$/gm, '')
    .replace(/^[ \t]*[,!?. -]+(?=\s*#)/gm, '')
    .replace(/,\s*([!?.])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/[ \t]+([,!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Helper to generate relevant hashtags based on product keywords and platform
  const generateHashtags = () => {
    const combined = `${productTitle} ${productDescription} ${text}`.toLowerCase();
    const tags = new Set();

    if (platform === 'ytcliper') {
      tags.add('#youtubeshorts');
      tags.add('#shorts');
      tags.add('#rekomendasiproduk');
      tags.add('#racunbelanja');
      tags.add('#spillracun');
      tags.add('#gadgetunik');
      tags.add('#perabotdapur');
    } else {
      tags.add('#racunshopee');
      tags.add('#shopeehaul');
      tags.add('#spillracun');
      tags.add('#racuntiktok');
      tags.add('#racunbelanja');
      tags.add('#reelsviral');
      tags.add('#affiliateindonesia');
      tags.add('#fyp');
    }

    // Category detection
    if (/sabun|piring|dapur|kitchen|parut|chopper|pisau|wajan|panci|masak|spatula|blender|dispenser|botol|spons/i.test(combined)) {
      tags.add('#alatdapur');
      tags.add('#perabotandapur');
      tags.add('#dapurminimalis');
      tags.add('#dapurrapi');
    }
    if (/sapu|pel|sikat|bersih|clean|lap|debu|kain|kemoceng|vacuum/i.test(combined)) {
      tags.add('#alatkebersihan');
      tags.add('#rumahrapi');
      tags.add('#peralatanrumahtangga');
    }
    if (/rak|wadah|organizer|kotak|storage|gantungan/i.test(combined)) {
      tags.add('#organizer');
      tags.add('#rumahminimalis');
      tags.add('#dekorasirumah');
    }
    if (/baju|celana|gamis|dress|rok|tas|sepatu|kaos|hijab|dompet/i.test(combined)) {
      tags.add('#ootd');
      tags.add('#fashionhaul');
      tags.add('#spilloutfit');
    }
    if (/hp|charger|kabel|holder|tws|headset|speaker|elektronik|lampu|kipas/i.test(combined)) {
      tags.add('#gadgetunik');
      tags.add('#elektronikmurah');
    }
    tags.add('#barangunik');
    tags.add('#viral');

    return Array.from(tags).join(' ');
  };

  const defaultCta = platform === 'ytcliper'
    ? '🛒 Link pembelian produk resmi ada di deskripsi video ya!'
    : '🛒 Cek produk di bio / keranjang kuning sekarang sebelum kehabisan ya!';

  const defaultUrgency = 'Buruan checkout sekarang mumpung lagi diskon spesial & promo gratis ongkir! 🔥';

  // Check if caption already has multiple paragraphs and substantial content
  const paragraphs = text ? text.split(/\n\s*\n/).filter(p => p.trim()) : [];
  const hasHashtags = /#\w+/.test(text);
  const isTooShort = !text || text.length < 100 || paragraphs.length < 3 || !hasHashtags;

  if (!isTooShort) {
    let enriched = text;
    if (!/keranjang|bio|deskripsi|checkout|beli|pesan|cek\s+produk/i.test(enriched)) {
      enriched += `\n\n${defaultUrgency}\n\n${defaultCta}`;
    }
    if (!/#\w+/.test(enriched)) {
      enriched += `\n\n${generateHashtags()}`;
    }
    return enriched.trim();
  }

  // --- Caption is INCOMPLETE or SHORT (e.g. only 1 sentence hook like in screenshot) ---
  const cleanTitle = (productTitle || sampleContext?.productName || '').replace(/[\[\(\{\]\)\}].*$/g, '').trim();

  // 1. Hook
  let hook = text;
  // If text already has a strong hook (like user's: "Masih pakai botol sabun biasa yang bikin boros dan bikin dapur berantakan? 🧼✨"), preserve it!
  if (!hook || hook.length < 15) {
    hook = cleanTitle
      ? `🔥 Mau urusan rumah jadi 2x lebih cepat & praktis? Kenalin ${cleanTitle}! ✨`
      : `🔥 Masih repot pakai cara lama yang bikin boros & berantakan? Kenalin solusinya! 🧼✨`;
  }

  // 2. Product Solution & Description
  let solutionDesc = '';
  if (productDescription && productDescription.trim().length > 15) {
    const cleanDesc = productDescription.replace(/\s+/g, ' ').slice(0, 160).trim();
    solutionDesc = `Hadir dengan inovasi terbaru yang bikin kegiatan harian jauh lebih praktis, hemat waktu, dan hasil maksimal. ${cleanDesc.endsWith('.') ? cleanDesc : cleanDesc + '.'} 😍`;
  } else if (sampleContext?.coreProblem) {
    solutionDesc = `Solusi praktis buat kamu yang gak mau ribet mengatasi ${sampleContext.coreProblem.toLowerCase()}! Sangat praktis, efisien, dan bikin ruangan makin rapi estetik 😍`;
  } else {
    solutionDesc = `Bikin urusan harian jadi 2x lebih cepat, hemat tenaga, dan ruangan tetap rapi estetik tanpa ribet! Wajib banget punya buat kamu yang suka serba sat-set 😍`;
  }

  // 3. Key Benefits / Keunggulan
  let bulletPoints = [];
  if (Array.isArray(sampleContext?.keyFeatures) && sampleContext.keyFeatures.length > 0) {
    bulletPoints = sampleContext.keyFeatures.slice(0, 4).map(f => `✅ ${f.trim()}`);
  } else if (Array.isArray(scenes) && scenes.length >= 3) {
    bulletPoints = [
      `✅ Desain ergonomis, praktis, dan sangat mudah digunakan`,
      `✅ Kualitas bahan premium, awet, dan tahan lama`,
      `✅ Hemat waktu dan tenaga sehari-hari`,
      `✅ Bikin tampilan ruangan makin bersih, rapi, dan modern`
    ];
  } else {
    bulletPoints = [
      `✅ Sangat praktis dan mudah digunakan siapa saja`,
      `✅ Kualitas bahan pilihan yang awet dan tahan lama`,
      `✅ Desain modern, fungsional, dan estetik`,
      `✅ Hemat waktu & bikin aktivitas harian makin simpel`
    ];
  }
  const benefitsSection = `Keunggulan Utama:\n${bulletPoints.join('\n')}`;

  // Assemble full enriched caption
  const assembled = [
    hook,
    solutionDesc,
    benefitsSection,
    `${defaultUrgency}\n\n${defaultCta}`,
    generateHashtags()
  ].join('\n\n');

  return assembled.trim();
}

/**
 * Filter kata-kata script: hindari kata 'kangen' dan 'ng' slang, serta pastikan keju=keju dan beres=beres
 */
export function sanitizeScriptVocabulary(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    // 0. Hapus karakter China/Mandarin/Hanzi:
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/gu, '')

    // 1. Tulis persis keju=keju dan beres=beres tanpa tanda aksen kecil di atas huruf e:
    .replace(/\b(?:kéju|kèju|kêju)\b/gi, 'keju')
    .replace(/\b(?:bérés|bèrès|bêrês)\b/gi, 'beres')
    .replace(/\b(?:dibéréskan|dibèrèskan)\b/gi, 'dibereskan')
    .replace(/\b(?:membéréskan|membèrèskan)\b/gi, 'membereskan')
    .replace(/\b(?:méja|mèja|mêja)\b/gi, 'meja')

    // 2. Hindari kata kangen:
    .replace(/\bkangen\b/gi, 'ingin')

    // 3. Hindari kata gaul "fix" / "fiks" sebagai slang kepastian ("fix kurang maksimal" -> "pasti kurang maksimal")
    .replace(/\b(?:fix|fiks)\b/gi, 'pasti')

    // 4. Hindari kata slang awalan "ng":
    .replace(/\b(?:enggak|engga|nggak|ngga)\b/gi, 'tidak')
    .replace(/\bngasih\b/gi, 'kasih')
    .replace(/\bngeliat\b/gi, 'melihat')
    .replace(/\bngerasain\b/gi, 'merasakan')
    .replace(/\bngapain\b/gi, 'kenapa')
    .replace(/\bngerepotin\b/gi, 'merepotkan')
    .replace(/\bngaruh\b/gi, 'berpengaruh')
    .replace(/\bngelakuin\b/gi, 'melakukan')
    .replace(/\bngambil\b/gi, 'mengambil')
    .replace(/\bngatur\b/gi, 'mengatur')
    .replace(/\bngabisin\b/gi, 'menghabiskan')
    .replace(/\bngeluarin\b/gi, 'mengeluarkan')
    .replace(/\bngeringin\b/gi, 'mengeringkan')
    .replace(/\bngisi\b/gi, 'mengisi')
    .replace(/\bngiris\b/gi, 'mengiris')
    .replace(/\bngulek\b/gi, 'mengulek')
    .replace(/\bngaduk\b/gi, 'mengaduk')
    .replace(/\bngupas\b/gi, 'mengupas')
    .replace(/\bngoles\b/gi, 'mengoles')
    .replace(/\bngocok\b/gi, 'mengocok');
}

// Robust JSON parser with auto-repair for truncated output
function repairJson(raw) {
  if (!raw || typeof raw !== 'string') return {};
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (initialErr) {
    try {
      let str = cleaned;
      if (str.endsWith('\\')) str = str.slice(0, -1);

      // Check unclosed quote
      let inString = false;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === '"' && (i === 0 || str[i - 1] !== '\\')) {
          inString = !inString;
        }
      }
      if (inString) str += '"';

      // Balance braces and brackets
      const stack = [];
      let inStr = false;
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '"' && (i === 0 || str[i - 1] !== '\\')) {
          inStr = !inStr;
        } else if (!inStr) {
          if (c === '{' || c === '[') stack.push(c);
          else if (c === '}' && stack[stack.length - 1] === '{') stack.pop();
          else if (c === ']' && stack[stack.length - 1] === '[') stack.pop();
        }
      }

      while (stack.length > 0) {
        const top = stack.pop();
        if (top === '{') str += '}';
        else if (top === '[') str += ']';
      }

      return JSON.parse(str);
    } catch {
      throw initialErr;
    }
  }
}

// Helpers
export function formatSeconds(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function parseTimeToSeconds(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (!timeStr) return 0;
  const parts = timeStr.toString().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseFloat(timeStr) || 0;
}

function normalizeReframe(reframe = {}) {
  const focusX = clampNumber(reframe.focusX, 0, 1, DEFAULT_REFRAME.focusX);
  const focusY = clampNumber(reframe.focusY, 0, 1, DEFAULT_REFRAME.focusY);
  const avoidTextZones = Array.isArray(reframe.avoidTextZones)
    ? reframe.avoidTextZones.filter(Boolean).map((zone) => zone.toString().slice(0, 40))
    : [];
  const avoidFaceZones = Array.isArray(reframe.avoidFaceZones)
    ? reframe.avoidFaceZones.filter(Boolean).map((zone) => zone.toString().slice(0, 40))
    : DEFAULT_REFRAME.avoidFaceZones;

  const validRenderModes = ['stage_80', 'square_stage', 'fit_canvas', 'vertical_crop'];
  const renderMode = validRenderModes.includes(reframe.renderMode) ? reframe.renderMode : 'stage_80';

  return {
    focusX,
    focusY,
    renderMode,
    cropStrategy: (reframe.cropStrategy || DEFAULT_REFRAME.cropStrategy).toString().slice(0, 80),
    avoidTextZones,
    avoidFaceZones,
    faceSafety: reframe.faceSafety !== false,
    allowHflip: reframe.allowHflip !== false,
    hasProductBrand: Boolean(reframe.hasProductBrand),
    notes: (reframe.notes || DEFAULT_REFRAME.notes).toString().slice(0, 180),
  };
}

/**
 * Membangun 7 klip storyboard bervariasi sesuai permintaan pengguna:
 * Slot 1: Visual Produk Utuh (Opening Hero)
 * Slot 2: Fitur & Keunggulan Fisik
 * Slot 3: Peragaan #1 (Aksi Produk)
 * Slot 4: Peragaan #2 (Visual Berbeda / Angle Lain / Beda Video)
 * Slot 5: Peragaan #3 (Hasil / Bukti Nyata)
 * Slot 6: WAJIB Visual Produk Utuh (Penutup)
 * Slot 7: WAJIB Visual Produk Utuh (Call to Action Checkout)
 */
export function build7SlotStoryboardClips({
  parsed,
  frames = [],
  totalDuration = 60,
  clipSec = 4.8,
  introCutoffSec = 0,
  niche = 'kitchen_tools'
}) {
  const sb = parsed?.storyboard || {};
  const selectedIndices = Array.isArray(parsed?.frames) ? parsed.frames : [];
  const minSafeStart = Math.max(introCutoffSec || 0, 0);

  const validFrames = (frames || []).filter(f => f && (f.filePath || f.base64 || f.timestamp !== undefined));
  const totalFramesCount = validFrames.length;

  const preset = getNichePreset(niche);
  const slotsConfig = preset?.slotsConfig || [
    { slot: 1, key: 'clip1_full_product', fallbackKey: 'clip1', label: 'Visual Produk Utuh (Opening Hero)', role: 'full_product', datasetTag: 'valid_full_product' },
    { slot: 2, key: 'clip2_feature', fallbackKey: 'clip2', label: 'Fitur & Keunggulan Fisik', role: 'feature', datasetTag: 'valid_feature' },
    { slot: 3, key: 'clip3_action_demo', fallbackKey: 'clip3', label: 'Peragaan #1 (Aksi Produk)', role: 'action_demo', datasetTag: 'valid_action' },
    { slot: 4, key: 'clip4_action_demo_diff', fallbackKey: 'clip4_action_demo', label: 'Peragaan #2 (Visual Berbeda / Angle Lain)', role: 'action_demo_diff', datasetTag: 'valid_action' },
    { slot: 5, key: 'clip5_action_demo', fallbackKey: 'clip5_result', label: 'Peragaan #3 (Hasil / Bukti Nyata)', role: 'action_demo', datasetTag: 'valid_result' },
    { slot: 6, key: 'clip6_full_product', fallbackKey: 'clip6', label: 'WAJIB Visual Produk Utuh (Penutup)', role: 'full_product', datasetTag: 'valid_full_product' },
    { slot: 7, key: 'clip7_full_product', fallbackKey: 'clip7_display_cta', label: 'WAJIB Visual Produk Utuh (Call to Action)', role: 'full_product', datasetTag: 'valid_display_cta' }
  ];

  const storyboardClips = [];

  const getFrameByIdx = (idx) => {
    if (typeof idx !== 'number' || isNaN(idx) || idx < 1 || idx > totalFramesCount) return null;
    return validFrames[idx - 1];
  };

  // Kumpulkan index kandidat yang tersedia di pool frame
  const candIndices = [...new Set(validFrames.map(f => f.candidateIndex !== undefined ? f.candidateIndex : 0))];
  const framesByCand = new Map();
  for (const cIdx of candIndices) {
    framesByCand.set(cIdx, validFrames.filter(f => (f.candidateIndex !== undefined ? f.candidateIndex : 0) === cIdx));
  }

  const rawSlotIndices = [];
  for (let i = 0; i < slotsConfig.length; i++) {
    const config = slotsConfig[i];
    let chosenIdx = null;

    const candidateKeys = [config.key, config.fallbackKey].filter(Boolean);
    for (const k of candidateKeys) {
      if (sb[k] !== undefined && sb[k] !== null) {
        let rawVal = sb[k];
        if (rawVal && typeof rawVal === 'object') {
          rawVal = rawVal.frameIndex ?? rawVal.frame ?? rawVal.index;
        }
        const parsedIdx = parseInt(rawVal, 10);
        if (!isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= totalFramesCount) {
          chosenIdx = parsedIdx;
          break;
        }
      }
    }

    if (!chosenIdx && selectedIndices[i]) {
      let rawVal = selectedIndices[i];
      if (rawVal && typeof rawVal === 'object') {
        rawVal = rawVal.frameIndex ?? rawVal.frame ?? rawVal.index;
      }
      const parsedIdx = parseInt(rawVal, 10);
      if (!isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= totalFramesCount) {
        chosenIdx = parsedIdx;
      }
    }

    rawSlotIndices.push(chosenIdx);
  }

  let slot1Clip = null;

  for (let sIdx = 0; sIdx < slotsConfig.length; sIdx++) {
    const config = slotsConfig[sIdx];
    let frameObj = null;
    let chosenIdx = rawSlotIndices[sIdx];

    if (chosenIdx) {
      frameObj = getFrameByIdx(chosenIdx);
    }

    if (config.slot === 1) {
      // ── SLOT 1: WAJIB VISUAL PRODUK UTUH (Opening Hero Shot) ──
      // Dilarang peragaan aksi (menggosok, memotong, memeras) di Slot 1!
      const isCleanHeroCandidate = (f) => {
        if (!f) return false;
        const tag = f.datasetTag || f.category || '';
        return tag === 'valid_full_product' || tag === 'valid_display_cta' || ((f.timestamp || 0) <= 12.0 && tag !== 'valid_action');
      };

      if (!frameObj || !isCleanHeroCandidate(frameObj)) {
        // Cari frame produk utuh terbaik dari kandidat pertama atau kandidat mana pun
        const heroFromPool = validFrames.find(f => isCleanHeroCandidate(f));
        if (heroFromPool) {
          frameObj = heroFromPool;
        } else {
          // Fallback: ambil frame awal paling bersih (detik 1-8)
          const earlyFrame = validFrames.find(f => (f.timestamp || 0) >= 1.0 && (f.timestamp || 0) <= 8.0) || validFrames[0];
          frameObj = earlyFrame;
        }
      }
    } else if (config.slot === 2) {
      // Slot 2: Feature close-up
      if (!frameObj) {
        const featCandidateIdx = Math.min(totalFramesCount, Math.max(3, Math.floor(totalFramesCount * 0.28)));
        frameObj = getFrameByIdx(featCandidateIdx) || validFrames[Math.min(validFrames.length - 1, 2)];
      }
    } else if (config.slot === 3) {
      // Slot 3: Action demo 1
      if (!frameObj) {
        const demoCandidateIdx = Math.min(totalFramesCount, Math.max(4, Math.floor(totalFramesCount * 0.42)));
        frameObj = getFrameByIdx(demoCandidateIdx) || validFrames[Math.min(validFrames.length - 1, 4)];
      }
    } else if (config.slot === 4) {
      // Slot 4: Action demo 2 dengan visual / angle berbeda
      if (!frameObj) {
        const prevActionTs = storyboardClips[2]?.startSeconds || 0;
        const prevCandIdx = storyboardClips[2]?.candidateIndex;
        // Prioritaskan frame dengan timestamp berjarak signifikan dari kandidat yang sama
        const distantFrame = validFrames.find(f => (f.candidateIndex === prevCandIdx || f.candidateIndex === undefined) && Math.abs((f.timestamp || 0) - prevActionTs) >= 15.0)
          || validFrames.find(f => Math.abs((f.timestamp || 0) - prevActionTs) >= 15.0);
        if (distantFrame) {
          frameObj = distantFrame;
        } else {
          const midCandidateIdx = Math.min(totalFramesCount, Math.max(5, Math.floor(totalFramesCount * 0.60)));
          frameObj = getFrameByIdx(midCandidateIdx) || validFrames[Math.min(validFrames.length - 1, 6)];
        }
      }
    } else if (config.slot === 5) {
      // Slot 5: Action demo 3 (rinsing / proof / result)
      if (!frameObj) {
        const resultCandidateIdx = Math.min(totalFramesCount, Math.max(6, Math.floor(totalFramesCount * 0.78)));
        frameObj = getFrameByIdx(resultCandidateIdx) || validFrames[Math.min(validFrames.length - 1, 8)];
      }
    } else if (config.slot === 6 || config.slot === 7) {
      // Slot 6 & 7: WAJIB Visual Produk Utuh!
      if (!frameObj) {
        const lateCleanHero = validFrames.find((f, i) => i >= Math.floor(totalFramesCount * 0.82) && (f.timestamp || 0) > 0);
        if (lateCleanHero && config.slot === 6) {
          frameObj = lateCleanHero;
        } else if (slot1Clip) {
          frameObj = {
            candidateIndex: slot1Clip.candidateIndex,
            candidateTitle: slot1Clip.candidateTitle,
            candidateUrl: slot1Clip.candidateUrl,
            videoId: slot1Clip.videoId,
            candidate: slot1Clip.candidate,
            timestamp: config.slot === 6 ? slot1Clip.startSeconds : Math.min(totalDuration - clipSec, slot1Clip.startSeconds + 2.5)
          };
        } else {
          frameObj = validFrames[0];
        }
      }
    }

    if (!frameObj) frameObj = validFrames[0] || {};

    const candIdx = frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : 0;
    const candDuration = frameObj?.candidate?.duration || totalDuration;
    const frameTs = frameObj.timestamp !== undefined ? frameObj.timestamp : (sIdx * (candDuration / 7));

    let startSec = Math.max(0, Math.min(candDuration - clipSec, Math.round(frameTs * 10) / 10));
    if (startSec < minSafeStart && config.slot !== 6 && config.slot !== 7) {
      startSec = minSafeStart;
    }

    // Jika slot 2 sampai 5 bertabrakan (< 2.0s) dengan klip sebelumnya di kandidat yang sama, sebarkan
    if (config.slot >= 2 && config.slot <= 5) {
      const collides = storyboardClips.some(sc =>
        sc.candidateIndex === candIdx && Math.abs(sc.startSeconds - startSec) < 2.0
      );
      if (collides) {
        const span = Math.max(0, candDuration - clipSec - minSafeStart);
        const proportionalSec = minSafeStart + ((sIdx / 6) * span);
        startSec = Math.round(Math.min(candDuration - clipSec, Math.max(minSafeStart, proportionalSec)) * 10) / 10;
        while (storyboardClips.some(sc => sc.candidateIndex === candIdx && Math.abs(sc.startSeconds - startSec) < 1.5) && startSec + 1.5 <= candDuration - clipSec) {
          startSec = Math.round((startSec + 1.5) * 10) / 10;
        }
      }
    }

    if (config.slot === 7 && storyboardClips.length >= 6) {
      const slot6 = storyboardClips[5];
      if (slot6.candidateIndex === candIdx && Math.abs(slot6.startSeconds - startSec) < 2.0) {
        if (slot6.startSeconds + 2.5 <= candDuration - clipSec) {
          startSec = slot6.startSeconds + 2.5;
        } else {
          startSec = Math.max(0, slot6.startSeconds - 2.5);
        }
      }
    }

    const endSec = Math.round((startSec + clipSec) * 10) / 10;

    const clipObj = {
      startSeconds: startSec,
      endSeconds: endSec,
      duration: clipSec,
      startTime: formatSeconds(startSec),
      endTime: formatSeconds(endSec),
      candidateIndex: candIdx,
      candidateTitle: frameObj?.candidateTitle || frameObj?.candidate?.title || '',
      candidateUrl: frameObj?.candidateUrl || frameObj?.candidate?.url || '',
      videoId: frameObj?.videoId || frameObj?.candidate?.id || '',
      candidate: frameObj?.candidate || null,
      storyboardSlot: config.slot,
      storyboardRole: config.role,
      datasetTag: config.datasetTag,
      reason: `${config.label} [Slot #${config.slot} | ${config.datasetTag}]`,
      isCleanAffiliateShot: true,
      hasProductBrand: Boolean(parsed?.hasProductBrand),
      reframe: {
        ...DEFAULT_REFRAME,
        renderMode: 'stage_80',
        focusY: config.slot === 7 ? 0.60 : (config.slot === 4 ? 0.65 : 0.55)
      }
    };

    if (config.slot === 1) slot1Clip = clipObj;
    storyboardClips.push(clipObj);
  }

  return storyboardClips;
}

export function normalizeClipPlan(rawClips, totalDuration, { allowFallback = true, frameAudit = [], hasProductBrand = false, allowHflip = true, sceneDuration = 4.8 } = {}) {
  const clipLength = Math.max(3.5, Math.min(5.0, Number(sceneDuration) || 4.8));
  const sourceClips = Array.isArray(rawClips) ? rawClips : [];
  const normalized = [];
  let previousEnd = -1;

  console.log(`[normalizeClipPlan] totalDuration=${totalDuration}s, rawClips=${sourceClips.length}, clipLength=${clipLength}s, frameAudit=${frameAudit.length}, hasProductBrand=${hasProductBrand}, allowHflip=${allowHflip}`);

  // Build a set of timestamps containing detected floating text, subtitles, watermarks, faces, or amateur framing
  const dirtyTimestamps = [];
  if (Array.isArray(frameAudit)) {
    for (const audit of frameAudit) {
      const floatingText = (audit.detectedFloatingOverlay || audit.detectedFloatingOverlayText || audit.floatingText || '').toLowerCase().trim();
      const hasFloatingOverlay = audit.hasFloatingOverlay === true ||
        audit.hasFloatingOverlayText === true ||
        (floatingText && floatingText !== 'none' && floatingText !== 'null' && floatingText !== 'false');

      const isPhysicalBrand = audit.hasPhysicalBrandText === true ||
        audit.hasPhysicalProductBrandOrText === true ||
        (audit.detectedPhysicalBrand && audit.detectedPhysicalBrand.toLowerCase() !== 'none');

      // Only reject legacy text if it is NOT physical brand
      const legacyText = (audit.detectedText || '').toLowerCase().trim();
      const isLegacySubtitle = !isPhysicalBrand && (audit.hasTextOrSubtitles === true || (legacyText && legacyText !== 'none' && legacyText !== 'null' && legacyText !== 'false'));
      const hasFace = audit.hasFace === true;
      const isPoorlyFramed = audit.isWellFramed === false;
      const isUnboxing = audit.isUnboxing === true ||
        (audit.detectedAction && /unbox|kardus|paket|buka paket|kemasan|packaging|bubble wrap/i.test(audit.detectedAction));

      if (hasFloatingOverlay || isLegacySubtitle || hasFace || isPoorlyFramed || isUnboxing) {
        const sec = Math.round(parseTimeToSeconds(audit.timestamp ?? audit.frameIndex));
        dirtyTimestamps.push(sec);
      }
    }
  }

  const previousEndsByCand = new Map();
  const hasStoryboardSlots = sourceClips.some(c => c.storyboardSlot !== undefined);

  for (const rawClip of sourceClips) {
    let startSeconds = Math.max(0, Math.round(parseTimeToSeconds(rawClip?.startSeconds ?? rawClip?.startTime)));
    const candKey = rawClip?.candidateIndex !== null && rawClip?.candidateIndex !== undefined ? rawClip.candidateIndex : 'default';
    const prevEnd = previousEndsByCand.get(candKey) || 0;

    // In storyboard mode, cuts can jump backwards to reprise full product hero shots
    if (!hasStoryboardSlots && startSeconds < prevEnd) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s (Candidate ${candKey}): overlaps previous end ${prevEnd}s in same video`);
      continue;
    }
    if (startSeconds + clipLength > totalDuration) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: exceeds totalDuration ${totalDuration}s`);
      continue;
    }
    if (rawClip?.isCleanAffiliateShot === false && rawClip?.hasFloatingOverlay === true) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: hasFloatingOverlay=true`);
      continue;
    }
    if (hasSourceIdentityRisk(rawClip)) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: sourceIdentityRisk=${rawClip?.sourceIdentityRisk}`);
      continue;
    }

    // Strictly discard any clip that is flagged as unboxing or packaging
    const isUnboxingClip = rawClip?.isUnboxing === true ||
      /unbox|kardus|paket|kemasan|packaging|bubble wrap|buka paket/i.test(String(rawClip?.reason || ''));
    if (isUnboxingClip) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: unboxing activity rejected (pro-affiliate mode)`);
      continue;
    }

    const endSeconds = startSeconds + clipLength;

    // Discard any clip interval that covers dirty frames containing floating text/subtitles/watermarks/unboxing
    const overlapsDirtyFrame = dirtyTimestamps.some(ts => ts >= startSeconds && ts <= endSeconds);
    if (overlapsDirtyFrame) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}-${endSeconds}s: overlaps frame with detected subtitle/watermark/unboxing`);
      continue;
    }

    const clipHasBrand = hasProductBrand || rawClip?.hasProductBrand === true || rawClip?.hasPhysicalBrandText === true || rawClip?.reframe?.hasProductBrand === true;
    const clipAllowHflip = clipHasBrand ? false : (allowHflip !== false && rawClip?.allowHflip !== false && rawClip?.reframe?.allowHflip !== false);

    normalized.push({
      startSeconds,
      endSeconds,
      duration: clipLength,
      startTime: formatSeconds(startSeconds),
      endTime: formatSeconds(endSeconds),
      candidateIndex: rawClip?.candidateIndex !== undefined ? rawClip.candidateIndex : null,
      candidateTitle: rawClip?.candidateTitle || '',
      candidateUrl: rawClip?.candidateUrl || '',
      videoId: rawClip?.videoId || '',
      videoPath: rawClip?.videoPath || null,
      candidate: rawClip?.candidate || null,
      storyboardSlot: rawClip?.storyboardSlot,
      storyboardRole: rawClip?.storyboardRole,
      datasetTag: rawClip?.datasetTag,
      reason: (rawClip?.reason || 'Clean full-product affiliate shot.').toString().slice(0, 180),
      hasProductBrand: clipHasBrand,
      allowHflip: clipAllowHflip,
      reframe: normalizeReframe({
        ...rawClip?.reframe,
        hasProductBrand: clipHasBrand,
        allowHflip: clipAllowHflip,
      }),
    });
    previousEndsByCand.set(candKey, endSeconds);
    previousEnd = endSeconds;
    if (normalized.length === 8) break; // Target 7-8 distinct clips (~30-35s)
  }

  console.log(`[normalizeClipPlan] Accepted ${normalized.length} valid clips from AI vision`);

  // Continuous Stride Expansion if fewer than 7 clips
  if (normalized.length > 0 && normalized.length < 7) {
    console.log(`[normalizeClipPlan] AI menyetujui ${normalized.length} anchor clip bersih. Melakukan Dynamic Stride Expansion menuju 7-8 klip (30-35s)...`);
    const targetClips = Math.min(8, Math.max(7, Math.ceil(31 / clipLength)));
    const originalAnchors = [...normalized];

    const intervalsByCand = new Map();
    for (const clip of normalized) {
      const cKey = clip.candidateIndex !== null && clip.candidateIndex !== undefined ? clip.candidateIndex : 'default';
      if (!intervalsByCand.has(cKey)) intervalsByCand.set(cKey, []);
      intervalsByCand.get(cKey).push({ start: clip.startSeconds, end: clip.endSeconds });
    }

    const isIntervalFree = (cKey, start, end, candDuration) => {
      if (start < 0 || end > candDuration) return false;
      const hitsDirty = dirtyTimestamps.some(ts => ts >= start && ts <= end);
      if (hitsDirty) return false;
      const intervals = intervalsByCand.get(cKey) || [];
      const overlaps = intervals.some(iv => Math.max(start, iv.start) < Math.min(end, iv.end));
      return !overlaps;
    };

    let expanded = true;
    let strideRound = 1;
    while (normalized.length < targetClips && expanded && strideRound <= 5) {
      expanded = false;
      for (const baseClip of originalAnchors) {
        if (normalized.length >= targetClips) break;

        const cKey = baseClip.candidateIndex !== null && baseClip.candidateIndex !== undefined ? baseClip.candidateIndex : 'default';
        const candDuration = baseClip.candidate?.duration || totalDuration;

        const sceneJump = Math.max(3.5, strideRound * 3.5);
        const fwdStart = Math.round((baseClip.endSeconds + sceneJump) * 10) / 10;
        const fwdEnd = Math.round((fwdStart + clipLength) * 10) / 10;

        if (isIntervalFree(cKey, fwdStart, fwdEnd, candDuration)) {
          normalized.push({
            ...baseClip,
            startSeconds: fwdStart,
            endSeconds: fwdEnd,
            duration: clipLength,
            startTime: formatSeconds(fwdStart),
            endTime: formatSeconds(fwdEnd),
            storyboardSlot: normalized.length + 1,
            reason: `${baseClip.reason} (Dynamic Scene Cut #${strideRound})`,
          });
          intervalsByCand.get(cKey).push({ start: fwdStart, end: fwdEnd });
          expanded = true;
          if (normalized.length >= targetClips) break;
        } else {
          const bwdStart = Math.round((baseClip.startSeconds - sceneJump - clipLength) * 10) / 10;
          const bwdEnd = Math.round((bwdStart + clipLength) * 10) / 10;
          if (bwdStart >= 0 && isIntervalFree(cKey, bwdStart, bwdEnd, candDuration)) {
            normalized.push({
              ...baseClip,
              startSeconds: bwdStart,
              endSeconds: bwdEnd,
              duration: clipLength,
              startTime: formatSeconds(bwdStart),
              endTime: formatSeconds(bwdEnd),
              storyboardSlot: normalized.length + 1,
              reason: `${baseClip.reason} (Pre-Anchor Scene Cut #${strideRound})`,
            });
            intervalsByCand.get(cKey).push({ start: bwdStart, end: bwdEnd });
            expanded = true;
            if (normalized.length >= targetClips) break;
          }
        }
      }
      strideRound++;
    }

    // Preserve storyboard slot order if defined, otherwise sort ascending
    if (!hasStoryboardSlots) {
      normalized.sort((a, b) => {
        const candA = a.candidateIndex ?? 0;
        const candB = b.candidateIndex ?? 0;
        if (candA !== candB) return candA - candB;
        return a.startSeconds - b.startSeconds;
      });
    } else {
      normalized.sort((a, b) => (a.storyboardSlot || 0) - (b.storyboardSlot || 0));
    }

    console.log(`[normalizeClipPlan] ✅ Dynamic Stride Expansion sukses: menghasilkan total ${normalized.length} klip (${(normalized.length * clipLength).toFixed(1)}s total).`);
  } else if (hasStoryboardSlots) {
    normalized.sort((a, b) => (a.storyboardSlot || 0) - (b.storyboardSlot || 0));
  }

  // Deduplikasi ketat: Pastikan tidak ada 2 klip dari kandidat yang sama dengan selisih waktu < 2.0 detik
  const dedupedClips = [];
  for (const c of normalized) {
    const isDup = dedupedClips.some(e => {
      // Di storyboard mode, lindungi Slot 6 dan Slot 7 (reprise visual produk utuh penutup/CTA)
      if (hasStoryboardSlots && (c.storyboardSlot === 6 || c.storyboardSlot === 7)) {
        if (e.storyboardSlot === c.storyboardSlot) return true;
        if (e.storyboardSlot === 6 && c.storyboardSlot === 7 && Math.abs(e.startSeconds - c.startSeconds) < 1.0) return true;
        return false;
      }
      return (
        (e.candidateIndex === c.candidateIndex || (!e.candidateIndex && !c.candidateIndex)) &&
        Math.abs(e.startSeconds - c.startSeconds) < 2.0
      );
    });
    if (!isDup) {
      dedupedClips.push(c);
    }
  }

  if (dedupedClips.length > 0) {
    return dedupedClips;
  }

  if (!allowFallback) {
    const cleanErr = new Error('AI menolak video ini: tidak ditemukan potongan video bersih dari watermark, subtitle terjemahan, nama channel mengambang, wajah, atau proses unboxing.');
    cleanErr.isAiRejection = true;
    cleanErr.rejectionReason = 'Tidak ditemukan potongan video bersih dari watermark, subtitle terjemahan, nama channel, wajah, atau proses unboxing.';
    throw cleanErr;
  }

  // Fallback: build 10 to 12 evenly spaced clips (around 30 to 35 seconds total, exactly clipLength per clip)
  console.log(`[normalizeClipPlan] Building ~30-35s fallback clip plan for ${totalDuration}s video with clipLength=${clipLength}s`);
  const fallbackClips = [];
  const targetTotalSec = 33;
  const fallbackTargetClips = Math.min(12, Math.max(10, Math.floor(Math.min(totalDuration, targetTotalSec) / clipLength)));
  const maxStart = Math.max(0, Math.floor(totalDuration - clipLength));
  // Avoid first 15-18% of video in fallback to bypass intro unboxing segments on YouTube
  const fallbackStart = totalDuration > 30
    ? Math.min(maxStart, Math.max(0, Math.floor(totalDuration * 0.18)))
    : (totalDuration > 20 ? Math.min(maxStart, Math.max(0, Math.floor(totalDuration * 0.10))) : 0);
  const fallbackLastStart = totalDuration > 30
    ? Math.max(fallbackStart, Math.min(maxStart, Math.floor(totalDuration * 0.95) - clipLength))
    : maxStart;

  const span = fallbackLastStart - fallbackStart;
  const numSteps = Math.max(1, fallbackTargetClips - 1);
  const stepSize = fallbackTargetClips > 1 ? span / numSteps : clipLength;

  let lastStart = -1;
  for (let i = 0; i < fallbackTargetClips; i++) {
    const rawStart = Math.round(fallbackStart + (i * stepSize));
    const startSeconds = Math.min(maxStart, Math.max(lastStart + clipLength, rawStart));
    if (startSeconds + clipLength > totalDuration) break;

    fallbackClips.push({
      startSeconds,
      endSeconds: startSeconds + clipLength,
      duration: clipLength,
      startTime: formatSeconds(startSeconds),
      endTime: formatSeconds(startSeconds + clipLength),
      reason: `Fallback ${clipLength}s product shot.`,
      hasProductBrand,
      allowHflip,
      reframe: normalizeReframe({
        hasProductBrand,
        allowHflip,
      }),
    });
    lastStart = startSeconds;
  }

  if (!fallbackClips.length) {
    throw new Error(`Video terlalu pendek untuk membuat potongan produk utama (minimal ${Math.round(clipLength * 4)} detik).`);
  }
  return fallbackClips;
}

function hasSourceIdentityRisk(rawClip = {}) {
  if (rawClip.sourceOwnerIdentityVisible === true) return true;

  const risk = (rawClip.sourceIdentityRisk || '').toString().toLowerCase().trim();
  if (!risk || risk === 'none' || risk === 'low' || risk === 'false' || risk === 'no') return false;

  return true;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function buildFallbackScenes(productName, segmentDuration, sceneDuration = 3.3) {
  const totalDuration = Math.max(30, Math.min(45, Math.round(Number(segmentDuration) || 33)));
  const sceneLength = Math.max(2.5, Math.min(5.0, Number(sceneDuration) || 3.3));
  const sceneCount = Math.max(7, Math.min(12, Math.round(totalDuration / sceneLength)));
  const sceneTemplates = [
    {
      visualDescription: `Hook perbandingan visual: demonstrasi cara lama atau alat biasa yang kurang maksimal.`,
      voiceover: getDynamicProductHookFallback(productName),
      adAdvisorNotes: 'Teks hook merah/kuning tebal, SFX alert, potongan cepat 3 detik pertama.'
    },
    {
      visualDescription: `Solusi hero: ${productName} ditampilkan saat mulai digunakan dengan mudah.`,
      voiceover: `Untung sekarang ada ${productName} ini, sekali usap langsung beres.`,
      adAdvisorNotes: 'Transisi snappy, tunjukkan tangan memegang produk dengan percaya diri.'
    },
    {
      visualDescription: `Aksi satisfying demo: busa melimpah atau kotoran rontok seketika.`,
      voiceover: `Busanya melimpah banget dan langsung mengangkat semua kotoran membandel.`,
      adAdvisorNotes: 'Visual satisfying close-up, SFX desis busa / gosokan bersih.'
    },
    {
      visualDescription: `Menjangkau sela-sela sempit yang sulit dijangkau alat biasa.`,
      voiceover: `Bisa menjangkau sela-sela sempit tanpa bikin tangan lecet atau baret.`,
      adAdvisorNotes: 'Close-up sela-sela bersih kinclong, pergerakan tangan luwes.'
    },
    {
      visualDescription: `Detail material produk: tebal, lembut, dan awet dicuci berkali-kali.`,
      voiceover: `Materialnya tebal dan halus, gak gampang rontok walau dipakai tiap hari.`,
      adAdvisorNotes: 'Tunjukkan tekstur produk, teks benefit kuning di layar.'
    },
    {
      visualDescription: `Psikologi harga: produk ditampilkan siap pakai dengan tulisan promo hemat.`,
      voiceover: `Harganya murah meriah banget, bener-bener gak bikin kantong jebol!`,
      adAdvisorNotes: 'Teks harga promo mencolok, SFX kaching / coin.'
    },
    {
      visualDescription: `Hero shot penutup dengan animasi panah ke keranjang kuning pojok kiri bawah.`,
      voiceover: `Buruan cek keranjang pojok kiri bawah sekarang sebelum kehabisan!`,
      adAdvisorNotes: 'Grafis panah berkedip ke pojok kiri bawah, CTA mendesak.'
    },
    {
      visualDescription: `Stiker diskon dan keranjang kuning berkedip.`,
      voiceover: `Langsung checkout di keranjang pojok kiri bawah mumpung masih promo!`,
      adAdvisorNotes: 'Teks urgensi terakhir, SFX click.'
    },
  ];

  return Array.from({ length: sceneCount }, (_, index) => {
    const start = Math.round(index * sceneLength * 10) / 10;
    const end = Math.min(totalDuration, Math.round((start + sceneLength) * 10) / 10);
    const template = sceneTemplates[Math.min(index, sceneTemplates.length - 1)];

    return {
      sceneNumber: index + 1,
      timeRange: `${formatSeconds(start)} - ${formatSeconds(end)}`,
      ...template,
    };
  });
}

function normalizeShortScenes(scenes, productName, segmentDuration, sceneDuration = 3.3) {
  const fallbackScenes = buildFallbackScenes(productName, segmentDuration, sceneDuration);
  const sourceScenes = Array.isArray(scenes) ? scenes : [];

  return fallbackScenes.map((fallback, index) => {
    const source = sourceScenes[index] || {};
    return {
      ...fallback,
      visualDescription: source.visualDescription || fallback.visualDescription,
      voiceover: source.voiceover || fallback.voiceover,
      adAdvisorNotes: source.adAdvisorNotes || fallback.adAdvisorNotes,
    };
  });
}

/**
 * Stage 2 Helper: Detects English words, brands, and terms in a voiceover script / product title
 * using AI, determines their Indonesian phonetic pronunciation, and automatically saves
 * them into the persistent English dictionary.
 */
export async function detectPhoneticLexiconWithAI({
  script,
  productTitle = '',
  apiKey = '',
  aiProvider = '',
  onProgress = () => { }
}) {
  if (!script && !productTitle) {
    return {};
  }

  let activeConfig;
  try {
    activeConfig = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider });
  } catch (confErr) {
    console.warn('[AIService Lexicon] Could not init AI client:', confErr.message);
    return {};
  }

  let { client, models: modelFallbackList, provider } = activeConfig;
  let activeModel = modelFallbackList[0];

  const systemPrompt = `Kamu adalah pakar fonetik bahasa Indonesia dan linguistik Text-to-Speech (TTS).
Tugasmu adalah menganalisis teks naskah voiceover dan judul produk, lalu mendeteksi SEMUA kata, merk, produk, atau istilah bahasa Inggris / asing.
Untuk setiap istilah yang kamu temukan, buatlah ejaan pelafalan fonetik bahasa Indonesia yang sesuai agar mesin TTS Bahasa Indonesia (seperti Edge-TTS Gadis) dapat melafalkannya dengan fasih, natural, dan tepat tanpa terdengar kaku atau aneh.

CONTOH PEMETAAN FONETIK BAHASA INDONESIA:
- 'chopper' -> 'coper'
- 'food chopper' -> 'fud coper'
- 'stainless steel' -> 'stenlis stil'
- 'air fryer' / 'airfryer' -> 'er frayer'
- 'steak' -> 'stik'
- 'juicy' -> 'jusi'
- 'online' -> 'onlen'
- 'checkout' -> 'cekot'
- 'touch screen' -> 'tac skrin'
- 'wireless' -> 'wayirles'
- 'sponge' -> 'spons'
- 'freezer' -> 'frizer'
- 'portable' -> 'portebel'
- 'aesthetic' -> 'estetik'
- 'smart lock' -> 'smart lok'
- 'vacuum cleaner' -> 'vakum klinir'
- 'charger' -> 'carjer'
- 'earphone' / 'earphones' -> 'irfon'
- 'frypan' / 'fry pan' -> 'fray pen'

ATURAN OUTPUT:
- Output WAJIB strictly JSON murni:
{
  "lexicon_to_replace": {
    "istilah_inggris": "pelafalan_fonetik_indonesia"
  }
}
- Key istilah harus dalam huruf kecil (lowercase).
- Jika tidak ada kata bahasa Inggris yang ditemukan, kembalikan objek kosong:
{
  "lexicon_to_replace": {}
}`;

  const userPrompt = `Analisis teks berikut dan ekstrak semua istilah/kata bahasa Inggris beserta pelafalan fonetik Indonesianya:
Judul Produk: "${productTitle}"
Naskah:
"""
${script}
"""

Kembalikan format JSON persis:
{
  "lexicon_to_replace": {
    "istilah": "fonetik"
  }
}`;

  let parsed = {};
  let totalRetries = modelFallbackList.length;
  let hasFallenBackToGemini = (provider === 'Google Gemini Direct');

  for (let attempt = 0; attempt < totalRetries; attempt++) {
    activeModel = modelFallbackList[attempt];
    try {
      onProgress({
        step: 'ai_lexicon_detection',
        message: `Mendeteksi istilah Inggris & fonetik dengan AI (${provider} - ${activeModel})...`,
        progress: 25,
      });

      const response = await client.chat.completions.create({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500,
      });

      const scriptMsg = response.choices?.[0]?.message;
      const rawContent = (scriptMsg?.content && scriptMsg.content.trim()) ? scriptMsg.content : (scriptMsg?.reasoning || '{}');
      parsed = repairJson(rawContent);
      break;
    } catch (err) {
      const status = err.status || err.statusCode;
      const msg = (err.message || '').toLowerCase();
      const isFatalAuthOrBilling = status === 401 || status === 402 || msg.includes('balance') || msg.includes('credits');

      if (!hasFallenBackToGemini) {
        const geminiFallback = getDirectGeminiClientConfig({ apiKeyOverride: apiKey });
        if (geminiFallback && (isFatalAuthOrBilling || attempt >= totalRetries - 1)) {
          console.warn(`[AIService Lexicon] OpenRouter fallback ke Google Gemini Direct API...`);
          hasFallenBackToGemini = true;
          client = geminiFallback.client;
          modelFallbackList = geminiFallback.models;
          provider = geminiFallback.provider;
          totalRetries = modelFallbackList.length;
          attempt = -1;
          continue;
        }
      }

      if (attempt < totalRetries - 1) {
        console.warn(`[AIService Lexicon] Model ${activeModel} gagal. Mencoba model berikutnya...`);
        continue;
      }
      console.warn(`[AIService Lexicon] Semua model AI gagal, melanjutkan tanpa kamus baru:`, err.message);
      return {};
    }
  }

  const detected = (parsed && parsed.lexicon_to_replace && typeof parsed.lexicon_to_replace === 'object')
    ? parsed.lexicon_to_replace
    : {};

  const cleanDetected = {};
  for (const [k, v] of Object.entries(detected)) {
    if (k && v && typeof k === 'string' && typeof v === 'string') {
      const cleanKey = k.trim().toLowerCase();
      const cleanVal = v.trim().toLowerCase();
      if (cleanKey && cleanVal && cleanKey !== cleanVal) {
        cleanDetected[cleanKey] = cleanVal;
      }
    }
  }

  if (Object.keys(cleanDetected).length > 0) {
    console.log(`[AIService Lexicon] 📖 Menambahkan istilah fonetik ke kamus:`, cleanDetected);
    saveToEnglishDictionary(cleanDetected);
  }

  return cleanDetected;
}

