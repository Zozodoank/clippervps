import { repairJson, formatSeconds, normalizeClipPlan } from './ai/aiValidators.js';
export { formatSeconds, normalizeClipPlan };
import { defaultGeminiDirectModels, getDirectGeminiApiKey, getDirectGeminiClientConfig, getAiClientConfig, formatApiError, isQuotaError, isDailyQuotaExhaustedError, resolveImageBufferAndBase64 } from './ai/aiClient.js';
export { defaultGeminiDirectModels, getDirectGeminiApiKey, getDirectGeminiClientConfig, isQuotaError, isDailyQuotaExhaustedError, resolveImageBufferAndBase64 };
import { truncateProductDescription, getDynamicProductHookFallback, buildNicheProductCriterion, buildFaceAndMotionCriterion, formatEnrichedCaption, sanitizeScriptVocabulary, build7SlotStoryboardClips } from './ai/promptBuilders.js';
export { truncateProductDescription, getDynamicProductHookFallback, buildNicheProductCriterion, buildFaceAndMotionCriterion, formatEnrichedCaption, sanitizeScriptVocabulary, build7SlotStoryboardClips };
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

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js



// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved truncateProductDescription to ai/promptBuilders.js

// Moved to ai/aiClient.js

// Moved to ai/aiClient.js

// Moved getDynamicProductHookFallback to ai/promptBuilders.js

// Moved buildNicheProductCriterion to ai/promptBuilders.js

// Moved buildFaceAndMotionCriterion to ai/promptBuilders.js

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
  const isVideoFirstMode = Boolean(isVideoFirst);
  const prodInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreNoun = prodInfo.coreProductNoun || 'Produk Praktis';
  const effectiveTitle = prodInfo.cleanTitle || (productTitle || '').trim() || coreNoun;
  const productIdentity = prodInfo.productIdentity || coreNoun;
  const productBrand = prodInfo.brand || '';
  const productModel = prodInfo.model || '';
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
  * TRANSLUCENT SPECIFICATION BOXES, DIMENSION LABELS, & CALLOUT OVERLAYS: Semi-transparent badges, gray/white floating boxes, or labels stating dimensions (e.g. '< 32cm', '24cm', '5L', 'Glass Lid', '1000W', arrow dimension indicators '<--->', or product specification tags) added in video post-production ARE 100% FORBIDDEN ARTIFICIAL OVERLAYS!
  * NON-TEXT GRAPHIC OVERLAYS: Pointing arrows (panah penunjuk merah/kuning), highlight circles/rectangles, animated emojis, stickers, subscription/bell/like buttons, floating price badges, or discount callouts added by video editors.
  * CREATOR PROMOTIONAL TEXT: "da di deskripsi", "link di bio", "klik keranjang kuning", "cek bio", "follow", or running text captions.
  * STATIC TEXT BANNERS: Colored background cards (kotak warna kuning/merah/putih dengan tulisan), lower-third bars, or digital promo stickers.
  * SPEECH DIALOGUE & SUBTITLES: Speech dialogue captions, translated subtitles, or lyric bars.
- OPENING INTRO BUMPER / TITLE CARD TOLERANCE (CRITICAL MANDATE):
  * JIKA VIDEO MEMILIKI KARTU INTRO / BUMPER PEMBUKA / LOGO CHANNEL ANIMASI DI DETIK 0 SAMPAI DETIK 5: JANGAN DITOLAK!
  * Video TETAP DITERIMA (status: 'accept') asalkan bagian peragaan produk setelahnya bersih dan faceless.
  * GEMINI WAJIB MEMBUANG INTRO TERSEBUT dengan cara: HANYA memilih timestamps klip yang dimulai SETELAH INTRO SELESAI (misal: mulai detik >= 5s, saat video sudah murni masuk ke peragaan produk fisik oleh tangan)!
  * Timestamps di array "timestamps" TIDAK BOLEH memasukkan detik-detik kartu intro pembuka!
- SELECTION MANDATE (CRITICAL):
  * Every single timestamp you select MUST BE 100% FREE of any floating text, subtitles, dimension badges, or watermarks! If a scene has text overlay, DO NOT select it!
- REJECT ENTIRE VIDEO IF:
  * Kartu bumper foto / slide diam mendominasi isi video.
  * Teks overlay, stiker, atau subtitle muncul mendominasi sehingga Anda TIDAK BISA menemukan minimal 4 cuplikan bersih (clean clips).
- PHYSICAL PRODUCT TEXT EXCEPTION IS STRICT:
  * "hasOnlyPhysicalProductText" ONLY applies to physical text manufactured, stamped, molded, or laser-engraved onto the metallic/plastic body of the physical product itself (like the brand name on the bottom of a pan or button labels). ANY floating digital box, callout card, or translucent badge on top of the video is NOT physical product text and MUST BE REJECTED! Paper manuals, brochures, and packaging labels are NOT exempt!

${buildFaceAndMotionCriterion(niche, clipSec)}

CRITERION 4B: PRODUCT HANDS-ON SHOWCASE & CLEAN FOOTAGE (UNBOXING SHOWCASE WELCOMED)
- VIDEO UNBOXING / HANDS-ON REVIEW SANGAT DITERIMA KARENA MEMILIKI VARIASI VISUAL PRODUK YANG KAYA (close-up fisik produk, variasi sudut/angle bodi, tes layar/tombol/fitur, peragaan fungsi).
- YANG DILARANG HANYALAH KEMASAN KOSONG / KARDUS SAJA:
  * Jangan pilih frame yang hanya menampilkan kardus kosong, resi pengiriman, robekan bubble wrap, atau buku manual kertas tanpa produk.
  * Frame unboxing yang menampilkan PRODUK FISIK SECARA JELAS (misal: produk dipegang di tangan, diperlihatkan dari depan/belakang/samping, dinyalakan, diuji coba, diperagakan fungsinya) adalah FOOTAGE EMAS AFFILIATE dan 100% DIPERBOLEHKAN!
  * Untuk video unboxing: adegan fisik produk (memegang produk, memamerkan bodi/layar/kamera, mengoperasikan fitur, mendemokan alat) WAJIB ditandai sebagai containsTargetProduct=true, isPackaging=false, dan isActiveProductDemo=true.
- Jika frame awal menampilkan kardus/paket, cukup lewati frame kardus tersebut dan pilih frame-frame peragaan fisik produk yang variatif.
- Slot 1 WAJIB berupa beauty shot / produk fisik yang jelas (bodi produk di tangan atau di atas meja; bebas kardus/bubble wrap kosong).

CRITERION 4C: NORMAL CAMERA ORIENTATION & ZERO PILLARBOX / ZERO ROTATED 90° FOOTAGE
- ZERO TOLERANCE FOR ROTATED OR SIDEWAYS FOOTAGE (MIRING / ROTATE 90 DERAJAT):
  * DILARANG KERAS MEMILIH CUPLIKAN DENGAN ORIENTASI KAMERA MIRING / TERPUTAR 90 DERAJAT (SIDEWAYS ORIENTATION)!
  * Permukaan meja kerja, kompor, wajan, talenan, atau tangan memegang HP HARUS berada pada posisi horizontal/vertikal normal (gravitasi bumi normal).
- ZERO TOLERANCE FOR PILLARBOX & VERTICAL BLACK BARS:
  * DILARANG KERAS video yang memiliki pilar / garis hitam vertikal tebal di sisi kiri dan kanan (pillarbox narrow slit)! Video harus mengisi penuh frame secara proporsional.
- Jika video secara keseluruhan direkam/diupload miring 90 derajat atau ber-pillarbox hitam tebal: VIDEO WAJIB LANGSUNG DITOLAK: {"status": "reject", "reason": "Video ditolak: Orientasi kamera miring 90 derajat atau terdapat pillarbox hitam tebal di sisi samping."}.

CRITERION 5: DIVERSE ACTION DEMONSTRATION & ANTI-REPETITION MANDATE
- HARD REJECT (ZERO-TOLERANCE for selected clips):
  * Every timestamp in "timestamps" MUST be 100% free of faces, subtitles, creator text, watermarks, pointing arrows, stickers, emojis, price tags, empty cardboard boxes, paper manuals, and static slides.
- MOTION FIRST (ACTIVE DEMONSTRATION OVER FROZEN PRODUCT):
  * Give highest priority to clips showing clear hands-on demonstration, crisp natural lighting, and active physical product motion (operating, cutting, pressing, demonstrating function).
  * DO NOT select frozen or lifeless shots of the product sitting idly on a table.
- MANDATORY VISUAL & ACTION DIVERSITY (ANTI-MONOTONOUS RULE):
  * Each selected timestamp MUST represent a genuinely distinct action, angle, or demonstration phase.
  * DILARANG KERAS memilih cuplikan yang secara visual mengulang satu shot atau satu gerakan yang sama secara monoton!
  * If the video merely repeats the same static cutting action without varied angles, phases, or functions, REJECT IT:
    {"status": "reject", "reason": "Video ditolak: Footage monoton, hanya mengulang 1 gerakan/sudut yang sama tanpa variasi aksi yang memadai."}
- ACTION PROGRESSION (NATURAL STORY FLOW):
  * Order the selected timestamps to follow a coherent demonstration sequence:
    1. Phase 1 (Product Overview / Hook): 1-2 clips introducing the complete physical product in action.
    2. Phase 2 (Hands-on Preparation): Hands preparing, holding, or loading ingredients/product.
    3. Phase 3 (Active Demonstration): Core action of the product operating (cutting, frying, blending, cleaning).
    4. Phase 4 (Satisfying Result): Clear view of the final completed outcome.
- Determine 4 to 8 clean, strong non-overlapping segments (each 2 to 5 seconds long according to natural shot boundaries) to construct a high-retention video ad.
- If the video does NOT contain at least 4 genuinely distinct clean product demonstration clips inside the 9:16 frame: MUST BE REJECTED.
- For EVERY selected timestamp, return a matching "frameAudit" row containing timestamp + containsTargetProduct/isPackaging/isMachine/isActiveProductDemo.
- A selected timestamp is invalid if the target product is not visibly present and actively demonstrated, or if empty packaging/machine footage dominates.

Output valid JSON ONLY with this exact format:
If ACCEPTED:
{
  "status": "accept",
  "detectedProduct": "<nama produk>",
  "isExactProductMatch": true,
  "hasTargetProductInEverySelectedFrame": true,
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
  "frameAudit": [
    {"timestamp": 10, "containsTargetProduct": true, "isPackaging": false, "isMachine": false, "isActiveProductDemo": true}
  ],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk (DILARANG pakai kata 'fix' / 'fiks'!)",
  "hasProductBrand": false,
  "detectedBrand": "none"
}

If REJECTED:
{
  "status": "reject",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "hasTargetProductInEverySelectedFrame": false,
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
    'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash-lite',
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
  const isMatchFalse =
    parsed.isProductMatch === false ||
    parsed.isExactProductMatch === false ||
    parsed.hasTargetProductInEverySelectedFrame === false ||
    isBulky ||
    parsed.isUsableSourceVideo === false;
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

  // USER MANDATE: Jangan tolak seluruh video jika ada bagian intro/frame yang memiliki wajah/teks.
  // Hanya tolak jika terjadi fatal mismatch (produk berbeda, CGI/animasi, atau perabot besar).
  const isFatalMismatch = isMatchFalse || isSynthetic || isBulky;
  const hasUsableClipsOrTimestamps = (Array.isArray(parsed.timestamps) && parsed.timestamps.length >= 2) ||
                                     (Array.isArray(parsed.clips) && parsed.clips.length >= 2);

  const rawTimestampsForAudit = Array.isArray(parsed.timestamps)
    ? parsed.timestamps.map((t) => typeof t === 'number' ? t : parseTimeToSeconds(t)).filter((t) => Number.isFinite(t))
    : (Array.isArray(parsed.clips)
      ? parsed.clips.map((c) => Number(c?.startSeconds ?? parseTimeToSeconds(c?.startTime))).filter((t) => Number.isFinite(t))
      : []);

  const streamFrameAudit = Array.isArray(parsed.frameAudit) ? parsed.frameAudit : [];
  const auditEntriesValid = rawTimestampsForAudit.length === 0 || rawTimestampsForAudit.every((ts) =>
    streamFrameAudit.some((a) =>
      Number.isFinite(Number(a?.timestamp)) &&
      Math.abs(Number(a.timestamp) - ts) <= 1.5 &&
      a.containsTargetProduct === true &&
      a.isPackaging !== true &&
      a.isMachine !== true &&
      a.isActiveProductDemo === true
    )
  );
  const selectedProductProofFailure =
    rawTimestampsForAudit.length >= 2 &&
    (parsed.hasTargetProductInEverySelectedFrame === false || (streamFrameAudit.length > 0 && !auditEntriesValid));

  const shouldReject =
    isFatalMismatch ||
    selectedProductProofFailure ||
    (isRejectStatus && !hasUsableClipsOrTimestamps && !allowFallbackClips);

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
      } else if (selectedProductProofFailure) {
        rejectionMsg = 'Video ditolak oleh AI: Ada timestamp terpilih yang tidak membuktikan produk target terlihat aktif, atau mengandung packaging/mesin.';
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
  const acceptedStarts = [];
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
      // Never turn several nearby timestamps into repeated copies of the same scene.
      if (acceptedStarts.some((prev) => Math.abs(prev - startSec) < Math.max(clipSec, 4.0))) {
        continue;
      }
      acceptedStarts.push(startSec);

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
    frameAudit: streamFrameAudit,
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
 * Multi-Video YouTube Stream Analysis
 * Menganalisa 2-3 video sekaligus untuk menghasilkan keragaman klip (angle, aksi) yang lebih baik
 */
export async function analyzeMultipleYouTubeVideosWithGemini({
  youtubeUrls = [],
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
  if (!youtubeUrls || youtubeUrls.length === 0) {
    throw new Error('URL YouTube tidak tersedia.');
  }

  // Fallback to single jika hanya 1 URL
  if (youtubeUrls.length === 1) {
    return await analyzeYouTubeVideoWithGemini({
      youtubeUrl: youtubeUrls[0],
      apiKey,
      productTitle,
      productDescription,
      productImage,
      shopeeLink,
      sceneDuration,
      allowFallbackClips,
      totalDuration,
      introCutoffSec,
      discardedFaceTimestamps,
      discardedViolationTimestamps,
      cleanTimeWindows,
      verifiedSegments,
      isVideoFirst,
      niche,
      onProgress,
    });
  }

  const geminiKey = getDirectGeminiApiKey(apiKey);
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY belum disetel di server/.env untuk Google Gemini.');
  }

  const clipSec = Math.max(2.5, Math.min(5.0, Number(sceneDuration) || 3.3));
  const isVideoFirstMode = Boolean(isVideoFirst);
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
      }
    } catch (imgErr) {
      console.warn(`[Gemini Multi-Video Stream] Gagal memuat foto referensi produk: ${imgErr.message}`);
    }
  }

  onProgress({
    step: 'gemini_vision',
    message: `Google Gemini 3.6 Flash menganalisa ${youtubeUrls.length} stream video YouTube sekaligus untuk variasi adegan maksimal...`,
    progress: 46,
  });

  const allViolationTimestamps = Array.from(new Set([
    ...(Array.isArray(discardedFaceTimestamps) ? discardedFaceTimestamps : []),
    ...(Array.isArray(discardedViolationTimestamps) ? discardedViolationTimestamps : [])
  ])).map(t => Math.round(t)).sort((a, b) => a - b);

  const violationBlacklistWarning = allViolationTimestamps.length > 0
    ? `\nCRITICAL BLACKLIST (DETEKSI AI LOKAL: WAJAH, TEKS OVERLAY, PILLARBOX, DOKUMEN MANUAL): Frame visual pada detik [${allViolationTimestamps.join(', ')}s] terdeteksi melanggar aturan kualitas. DILARANG KERAS memilih timestamps dalam rentang +-3 detik dari detik-detik ini!\n`
    : '';

  const cleanWindowsDirective = Array.isArray(cleanTimeWindows) && cleanTimeWindows.length > 0
    ? `\nCRITICAL MANDATE (VERIFIED CLEAN TEMPORAL SEGMENTS): AI Local Gatekeeper telah memverifikasi segmen-segmen waktu bersih berikut: [${cleanTimeWindows.map(w => `${w.start}s-${w.end}s`).join(', ')}]. Anda HANYA BOLEH memilih timestamps di dalam rentang waktu yang terverifikasi bersih ini! DILARANG KERAS memilih timestamps di luar segmen bersih ini.\n`
    : '';

  const genAI = new GoogleGenerativeAI(geminiKey);
  const videoPrompt = `You are an elite Quality Control (QC) Director for Affiliate Product Video Ads.
Evaluate the provided ${youtubeUrls.length} YouTube videos carefully against the following 5 MANDATORY ACCEPTANCE CRITERIA:
${violationBlacklistWarning}
${cleanWindowsDirective}

${buildNicheProductCriterion(niche, coreNoun, effectiveTitle, isVideoFirstMode, effectiveDesc)}

CRITERION 2: WATERMARKS, SOCIAL MEDIA LOGOS, & CHANNEL IDENTITIES (9:16 CROP GEOMETRY RULE)
- 9:16 CROP GEOMETRY MANDATE (HORIZONTAL 16:9 vs VERTICAL 9:16 SOURCE VIDEOS):
  * HORIZONTAL 16:9 VIDEOS: The final Short uses ONLY the central 9:16 vertical strip (the middle 56.25% width: horizontal X from 22% to 78%). The entire outer left side (0% to 22%) and outer right side (78% to 100%) ARE COMPLETELY DISCARDED AND CUT OFF BY FFMPEG!
    CRITICAL RULE: DO NOT REJECT HORIZONTAL 16:9 VIDEOS FOR CORNER LOGOS LOCATED IN THE FAR-RIGHT (X > 78%) OR FAR-LEFT (X < 22%) EDGES! Only reject if a digital watermark or channel logo directly intrudes into the central 56% peragaan area.
  * VERTICAL 9:16 VIDEOS (SHORTS / REELS / TIKTOK): ZERO HORIZONTAL CROPPING OCCURS! ANY watermark or creator text overlay anywhere in the frame (including corners) CANNOT be cropped out and MUST BE REJECTED IMMEDIATELY!
- STRICT ZERO-TOLERANCE INSIDE THE 9:16 OUTPUT FRAME (THE CENTRAL 56% ZONE):
  * DILARANG KERAS jika watermark digital, logo TikTok/YouTube, atau identitas channel MASUK KE DALAM FRAME 9:16 TENGAH!
- PHYSICAL PRODUCT BRANDING IS 100% ACCEPTABLE:
  * Merek, logo, atau tulisan yang tercetak/terukir secara fisik pada bodi produk (misal: "SilverCrest", "Philips", "Joybos", "Xiaomi") BUKAN watermark dan 100% DITERIMA!

CRITERION 3: ZERO SUBTITLES, ZERO FLOATING TEXT, ZERO COLORED BANNERS, & ZERO GRAPHIC OVERLAYS
- HARD REJECT CRITERIA (IMMEDIATE ZERO TOLERANCE INSIDE 9:16 CROP):
  * TRANSLUCENT SPECIFICATION BOXES, DIMENSION LABELS, & CALLOUT OVERLAYS added in video post-production ARE 100% FORBIDDEN!
  * NON-TEXT GRAPHIC OVERLAYS: Pointing arrows, highlight circles, animated emojis, stickers, or floating price badges.
  * CREATOR PROMOTIONAL TEXT: "da di deskripsi", "link di bio", "klik keranjang kuning".
  * STATIC TEXT BANNERS: Colored background cards or lower-third bars.
  * SPEECH DIALOGUE & SUBTITLES: Speech dialogue captions, translated subtitles, or lyric bars.
- SELECTION MANDATE (CRITICAL):
  * Every single timestamp you select in 'selectedClips' MUST BE 100% FREE of any floating text, subtitles, dimension badges, or watermarks! If a scene has a text overlay, DO NOT select it!
- REJECT ENTIRE VIDEO IF:
  * Teks overlay, stiker, atau subtitle mendominasi semua video sehingga Anda TIDAK BISA menemukan cuplikan yang benar-benar bersih.
- PHYSICAL PRODUCT TEXT EXCEPTION IS STRICT:
  * "hasOnlyPhysicalProductText" ONLY applies to physical text manufactured, stamped, molded, or laser-engraved onto the metallic/plastic body of the physical product itself.

${buildFaceAndMotionCriterion(niche, clipSec)}

CRITERION 4B: PRODUCT HANDS-ON SHOWCASE & CLEAN FOOTAGE (UNBOXING SHOWCASE WELCOMED)
- VIDEO UNBOXING / HANDS-ON REVIEW SANGAT DITERIMA KARENA MEMILIKI VARIASI VISUAL PRODUK YANG KAYA.
- YANG DILARANG HANYALAH KEMASAN KOSONG / KARDUS SAJA: Jangan pilih frame yang hanya menampilkan kardus kosong atau buku manual tanpa produk.
- Frame unboxing yang menampilkan PRODUK FISIK SECARA JELAS (produk dipegang, dinyalakan, diuji coba) adalah FOOTAGE EMAS AFFILIATE!

CRITERION 4C: NORMAL CAMERA ORIENTATION & ZERO PILLARBOX / ZERO ROTATED 90° FOOTAGE
- DILARANG KERAS MEMILIH CUPLIKAN DENGAN ORIENTASI KAMERA MIRING 90 DERAJAT ATAU BER-PILLARBOX HITAM TEBAL!

CRITERION 5: MULTI-VIDEO DIVERSITY & ANTI-REPETITION MANDATE (CRITICAL RULE!)
- You have been provided with ${youtubeUrls.length} different videos. Your goal is to construct a highly engaging, varied product ad by extracting the best moments across ALL provided videos.
- Every selected clip MUST specify "sourceVideoIndex" (0 to ${youtubeUrls.length - 1}) corresponding to the order of the videos provided.
- MANDATORY VISUAL & ACTION DIVERSITY: Choose shots with distinct angles, backgrounds, or phases of demonstration. A combination of clips from DIFFERENT source videos is highly encouraged to maximize diversity!
- Determine 4 to 8 clean, strong non-overlapping segments (each 2 to 5 seconds long) from across the ${youtubeUrls.length} videos.

Output valid JSON ONLY with this exact format:
If ACCEPTED (found good clips from any of the videos):
{
  "status": "accept",
  "detectedProduct": "<nama produk>",
  "isExactProductMatch": true,
  "hasTargetProductInEverySelectedFrame": true,
  "isFacelessIn916Frame": true,
  "hasHumanOrFaceAnywhereInVideo": false,
  "hasOnlyPhysicalProductText": true,
  "selectedClips": [
    { "sourceVideoIndex": 0, "timestamp": 10, "containsTargetProduct": true, "isPackaging": false, "isMachine": false, "isActiveProductDemo": true, "reason": "Hook pembuka produk" },
    { "sourceVideoIndex": 1, "timestamp": 25, "containsTargetProduct": true, "isPackaging": false, "isMachine": false, "isActiveProductDemo": true, "reason": "Variasi sudut dari video 2" },
    { "sourceVideoIndex": 0, "timestamp": 45, "containsTargetProduct": true, "isPackaging": false, "isMachine": false, "isActiveProductDemo": true, "reason": "Hasil akhir masakan" }
  ],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk",
  "hasProductBrand": false,
  "detectedBrand": "none"
}

If REJECTED (Only reject if ALL videos are completely unusable):
{
  "status": "reject",
  "detectedProduct": "<nama produk di video>",
  "reason": "<PILIH SATU alasan akurat mengapa SEMUA video ditolak: 'Terdapat grafis animasi overlay/stiker di semua video' ATAU 'Menampilkan wajah orang/vlogger' ATAU 'Produk tidak cocok'>"
}

CRITICAL RULES FOR OUTPUT:
1. "isExactProductMatch": Set to true if the item demonstrated in the videos matches "${coreNoun}".
2. DILARANG KERAS MENGGABUNGKAN DUA ALASAN BERBEDA! Berikan SATU alasan tunggal yang presisi.`;

  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash-lite',
  ];
  let parsed = null;
  let activeGeminiModel = candidateModels[0];
  let lastGeminiErr = null;
  let allQuotaErrors = true;

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];
    try {
      console.log(`[Gemini Multi-Video Stream] Calling model [${i + 1}/${candidateModels.length}]: ${modelName} for ${youtubeUrls.length} URLs...`);
      activeGeminiModel = modelName;
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          mediaResolution: 'MEDIA_RESOLUTION_LOW',
        },
      });

      trackBandwidth('aiRequests', 3500, `Gemini Multi-Video Stream (${modelName})`);
      const contentParts = youtubeUrls.map((url) => ({
        fileData: { fileUri: url, mimeType: 'video/mp4' },
        videoMetadata: { fps: 0.5 },
      }));
      if (refImageInlineData) {
        contentParts.push(refImageInlineData);
      }
      contentParts.push({ text: videoPrompt });

      const result = await model.generateContent(contentParts);
      const rawText = result.response.text();
      console.log(`[Gemini Multi-Video Stream ${modelName}] Response:`, rawText);
      parsed = repairJson(rawText);
      if (parsed && (parsed.status || parsed.selectedClips || parsed.reason)) {
        break;
      }
    } catch (gemErr) {
      lastGeminiErr = gemErr;
      const isQuota = isQuotaError(gemErr);
      if (!isQuota) allQuotaErrors = false;
      const isDailyQuota = isQuota && (gemErr.message?.toLowerCase().includes('per-day') || gemErr.message?.toLowerCase().includes('daily'));
      console.warn(`[Gemini Multi-Video Stream] Model ${modelName} gagal: ${gemErr.message}. ${isQuota ? '⚠️ [Limit Kuota/Token Tercapai]' : ''}`);
      if (isDailyQuota) {
        console.warn('[Gemini Multi-Video Stream] ⛔ Kuota harian habis.');
        break;
      }
    }
  }

  if (!parsed) {
    const isLastQuota = isQuotaError(lastGeminiErr) || (lastGeminiErr?.status === 429) || (lastGeminiErr?.statusCode === 429);
    if ((allQuotaErrors || isLastQuota) && candidateModels.length > 0) {
      const quotaErr = new Error(`Model Gemini Visual telah mencapai batas kuota token: ${lastGeminiErr?.message}`);
      quotaErr.isAllModelsQuotaExhausted = true;
      quotaErr.isQuotaError = true;
      throw quotaErr;
    }
    throw lastGeminiErr || new Error('Gemini Multi-Video Stream gagal menganalisa video.');
  }

  const rawStatus = String(parsed.status || '').toLowerCase().trim();
  const isRejectStatus = rawStatus === 'reject' || rawStatus === 'rejected' || rawStatus === 'ditolak';
  const isBulky = isBulkyOrUnsuitableProduct(parsed.detectedProduct, { niche });
  const isMatchFalse = parsed.isProductMatch === false || parsed.isExactProductMatch === false || isBulky || parsed.isUsableSourceVideo === false;
  
  const hasUsableClips = Array.isArray(parsed.selectedClips) && parsed.selectedClips.length >= 2;
  
  const auditEntriesValid = !hasUsableClips || parsed.selectedClips.every((a) =>
      Number.isFinite(Number(a?.timestamp)) && a.containsTargetProduct === true && a.isPackaging !== true && a.isActiveProductDemo === true
  );

  const selectedProductProofFailure = hasUsableClips && !auditEntriesValid;
  const isFatalMismatch = isMatchFalse || isBulky;
  const shouldReject = isFatalMismatch || selectedProductProofFailure || (isRejectStatus && !hasUsableClips && !allowFallbackClips);

  if (shouldReject) {
    let rejectionMsg = String(parsed.reason || parsed.rejectionReason || '').trim() || 'Video ditolak oleh AI: Tidak memenuhi syarat affiliate faceless / bersih.';
    console.warn(`[Gemini Multi-Video Stream] ⛔ VIDEO RESMI DITOLAK OLEH AI: ${rejectionMsg}`);
    const rejectError = new Error(`Video ditolak oleh Gemini: ${rejectionMsg}`);
    rejectError.isAiRejection = true;
    rejectError.rejectionReason = rejectionMsg;
    throw rejectError;
  }

  let candidateClips = [];
  const acceptedStartsByVideo = {};
  
  if (Array.isArray(parsed.selectedClips)) {
    for (const clipData of parsed.selectedClips) {
      const sec = Number(clipData.timestamp);
      const vidIdx = Number(clipData.sourceVideoIndex) || 0;
      
      if (isNaN(sec) || sec < 0 || sec > totalDuration || vidIdx < 0 || vidIdx >= youtubeUrls.length) continue;
      if (!acceptedStartsByVideo[vidIdx]) acceptedStartsByVideo[vidIdx] = [];

      if (allViolationTimestamps.length > 0 && allViolationTimestamps.some(vt => Math.abs(vt - sec) < 3.0)) continue;

      const minSafeStart = Math.max(introCutoffSec || 0, (parsed.hasOpeningIntro ? (Number(parsed.introDurationSeconds) || 5) : 0));
      let startSec = Math.max(0, Math.min(totalDuration - clipSec, Math.round(sec * 10) / 10));
      if (startSec < minSafeStart) startSec = Math.min(totalDuration - clipSec, minSafeStart);
      
      if (acceptedStartsByVideo[vidIdx].some((prev) => Math.abs(prev - startSec) < Math.max(clipSec, 4.0))) continue;
      
      acceptedStartsByVideo[vidIdx].push(startSec);
      const endSec = Math.round((startSec + clipSec) * 10) / 10;
      
      candidateClips.push({
        candidateUrl: youtubeUrls[vidIdx], // Penting agar videoFilterService / downloader bisa download URL yang benar
        startSeconds: startSec,
        endSeconds: endSec,
        duration: clipSec,
        startTime: formatSeconds(startSec),
        endTime: formatSeconds(endSec),
        reason: clipData.reason || `Cuplikan produk dari video ${vidIdx + 1}`,
        isCleanAffiliateShot: true,
        hasProductBrand: Boolean(parsed.hasProductBrand),
        reframe: { ...DEFAULT_REFRAME, renderMode: 'stage_80' },
      });
    }
  }

  const hasProductBrand = Boolean(parsed.hasProductBrand);
  const detectedBrand = (parsed.detectedBrand || '').trim() || (hasProductBrand ? 'Brand Terdeteksi' : 'none');
  const allowHflip = hasProductBrand ? false : (parsed.allowHflip !== false);

  const clips = normalizeClipPlan(candidateClips, totalDuration, {
    allowFallback: allowFallbackClips,
    frameAudit: [],
    hasProductBrand,
    allowHflip,
    sceneDuration: clipSec,
  });
  
  const duration = clips.reduce((total, clip) => total + (clip.endSeconds - clip.startSeconds), 0);

  onProgress({
    step: 'gemini_vision',
    message: `${activeGeminiModel} selected ${clips.length} clean ${clipSec}s product shots from ${youtubeUrls.length} videos (${duration.toFixed(1)}s total).`,
    progress: 55,
  });

  return {
    detectedProduct: (parsed.detectedProduct || '').trim() || productTitle,
    startTime: clips[0]?.startTime || "00:00:00",
    endTime: clips[clips.length - 1]?.endTime || "00:00:00",
    startSeconds: clips[0]?.startSeconds || 0,
    endSeconds: clips[clips.length - 1]?.endSeconds || 0,
    duration,
    productHook: parsed.productHook || getDynamicProductHookFallback(productTitle),
    hasProductBrand,
    detectedBrand,
    allowHflip,
    reframe: clips[0]?.reframe || { ...DEFAULT_REFRAME, renderMode: 'stage_80' },
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
- SELECTION MANDATE (CRITICAL):
  * Every single timestamp you select MUST BE 100% FREE of any floating text, subtitles, dimension badges, colored cards, or watermarks! If a scene has text overlay, DO NOT select it!
- REJECT ENTIRE VIDEO IF:
  * STATIC TEXT BANNERS & COLORED BACKGROUND CARDS mendominasi video.
  * Kartu bumper foto / slide diam mendominasi isi video.
  * Speech dialogue captions, translated subtitles, or FLOATING PROMOTIONAL TEXT appear constantly, making it impossible to find enough clean clips.
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

CRITERION 5: DIVERSE ACTION DEMONSTRATION & ANTI-REPETITION MANDATE
- Determine 4 to 8 clean, strong non-overlapping segments (each 2 to 5 seconds long according to natural shot boundaries) to construct a high-retention video ad.
- Each timestamp in "timestamps" MUST be in seconds from the start of the video where the 9:16 center area is 100% faceless, free of subtitles, free of floating text, free of graphic overlays, free of colored background cards, and free of watermarks/logos.
- MOTION FIRST: Prioritize active hands-on demonstration (cutting, pressing, operating, tangible results) over frozen/static product displays.
- ANTI-MONOTONOUS RULE: Each timestamp MUST represent a distinct action, phase, or camera angle. If the footage repeats the same static cut without diversity, REJECT IT:
  {"status": "reject", "reason": "Video ditolak: Footage monoton, hanya mengulang 1 gerakan tanpa variasi aksi yang memadai."}
- If the video does NOT contain at least 4 genuinely distinct clean product demonstration clips inside the 9:16 frame: MUST BE REJECTED.

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
    const isMatchFalse =
      parsed.isProductMatch === false ||
      parsed.isExactProductMatch === false ||
      parsed.hasTargetProductInEverySelectedFrame === false ||
      isBulky ||
      parsed.isUsableSourceVideo === false;
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

    // USER MANDATE: Jangan tolak seluruh video jika ada bagian intro/frame yang memiliki wajah/teks.
    // Hanya tolak jika terjadi fatal mismatch (produk berbeda, CGI/animasi, atau perabot besar).
    const isFatalMismatch = isMatchFalse || isSynthetic || isBulky;
    const hasUsableClipsOrTimestamps = (Array.isArray(parsed.timestamps) && parsed.timestamps.length >= 2) ||
                                       (Array.isArray(parsed.clips) && parsed.clips.length >= 2);
    const shouldReject = isFatalMismatch || (isRejectStatus && !hasUsableClipsOrTimestamps && !allowFallbackClips);

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
  creativePlan = null,
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
- ZERO TOLERANCE FOR FLOATING NUMBERS, PROMO BADGES, PRICE TAGS & DIGITAL STICKERS:
  * DILARANG KERAS frame yang memiliki ANGKA MENGAMBANG, BADGE DISKON, HARGA, ATAU STIKER DIGITAL DI SUDUT MAUPUN TENGAH FRAME 9:16 (misal: angka kuning/merah/putih seperti "99", "9.9", "12.12", angka persentase diskon, atau stiker grafis editan)!
  * Setiap angka digital mengambang, nomor promosi, atau stiker grafis di dalam frame 9:16 adalah PELANGGARAN KERAS dan frame tersebut WAJIB DIBUANG / JANGAN DIPILIH!
  * Jika seluruh frame video memiliki angka mengambang atau stiker permanen di dalam frame 9:16 yang tidak bisa di-crop: REJECT the video!
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
- MANDAT PEMBUANGAN FRAME UNBOXING, METERAN & MANUAL KERTAS:
  * AI WAJIB MEMBUANG DAN MENYINGKIRKAN SEMUA FRAME YANG MENAMPILKAN PROSES UNBOXING, KOTAK KARDUS, KEMASAN PAKET, BUBBLE WRAP, BUKU PANDUAN MANUAL KERTAS, ATAU BUSA PACKAGING!
  * STRICT BAN ON TAPE MEASURES, RULERS, AND PACKAGING RESIDUE: DILARANG KERAS MEMILIH FRAME DENGAN METERAN JAHIT (kuning/putih), PENGGARIS, ALAT UKUR PANJANG, BUSA KEMASAN, BUKU PANDUAN MANUAL, RESI PENGIRIMAN, ATAU KARDUS KOSONG!
  * Cuplikan orang memegang meteran jahit mengukur mangkuk/produk adalah B-roll unboxing teknis yang SANGAT MEMBOSANKAN dan MEMATIKAN retensi penonton di Reels/TikTok. JANGAN PERNAH DIPILIH!
  * HANYA pilih indeks frame ("frames") ketika produk SEDANG DIGUNAKAN SECARA AKTIF / DIDEMONSTRASIKAN FUNGSINYA di luar kemasan (misal: saat memotong, mengupas, memasak, memutar rak carousel, menyajikan makanan, menyalakan mesin, scrolling layar HP, gaming fisik di tangan).
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
  * DILARANG KERAS jika watermark digital, angka mengambang ("99", "9.9"), logo TikTok/YouTube, atau identitas channel MASUK KE DALAM FRAME 9:16 TENGAH (area yang menutupi peragaan produk)!
  * Setiap watermark, logo, atau angka mengambang yang masuk ke dalam frame 9:16 wajib DITOLAK / DIBUANG karena tidak bisa terpotong.
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
{
  "status": "accept",
  "detectedProduct": "<nama produk di video>",
  "isExactProductMatch": true,
  "hasTargetProductInEverySelectedFrame": true,
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
  "rejectedFrames": [
    {
      "frameIndex": 2,
      "timestamp": 12.5,
      "reason": "Menampilkan wajah orang / subtitle ucapan / watermark / meteran jahit / angka mengambang '99' / bukan produk target"
    }
  ],
  "acceptedFrames": [1, 3, 5, 7, 8, 10],
  "missingSlots": ["clip3_action_demo", "clip4_action_demo_diff"],
  "suggestedSearchQueries": ["${effectiveTitle} demo", "${effectiveTitle} cara pakai"],
  "storyboard": {
    "clip1_full_product": 1,
    "clip2_feature": 3,
    "clip3_action_demo": 5,
    "clip4_action_demo_diff": 7,
    "clip5_action_demo": 8,
    "clip6_full_product": 10,
    "clip7_full_product": 10
  },
  "reframeBySlot": {
    "clip1_full_product": {"focusXStart": 0.50, "focusYStart": 0.55, "focusXEnd": 0.52, "focusYEnd": 0.55},
    "clip2_feature": {"focusXStart": 0.48, "focusYStart": 0.55, "focusXEnd": 0.53, "focusYEnd": 0.57}
  },
  "frames": [1, 3, 5, 7, 8, 10, 10],
  "productHook": "Hook pembuka 3 detik yang dinamis, menarik, & relate dengan masalah produk (DILARANG pakai kata 'fix' / 'fiks'!)",
  "hasProductBrand": false,
  "detectedBrand": "none",
  "reason": "<Ringkasan evaluasi jika ada frame ditolak atau status partial/reject>"
}

CRITICAL MANDATE FOR FRAME AUDIT & REJECTION REPORTING:
1. "rejectedFrames": You MUST inspect every single frame and list ALL frames that violate QC (human faces/heads, dialogue subtitles, promo cards, watermarks, floating numbers/stickers like '99', tape measures/rulers, or empty packaging without target product).
   Specify "frameIndex" (1-indexed matching frame #1, #2, ...), "timestamp" (approx seconds), and an explicit "reason".
2. "acceptedFrames": List every clean, faceless, hands-on demonstration frame index.
3. "missingSlots": If the pool of clean frames cannot fill all 7 diverse storyboard slots without repetition, list the unfilled slot keys (e.g. ["clip3_action_demo", "clip4_action_demo_diff"]).
4. "suggestedSearchQueries": Suggest 1-3 targeted YouTube search queries for backend to search replacement demonstration footage. WAJIB GUNAKAN merk dan tipe produk ("${effectiveTitle}") secara utuh dan akurat, meskipun nama merk berbahasa Inggris. Padukan dengan kata kunci pencarian dalam Bahasa Indonesia (contoh: "${effectiveTitle} cara pakai", "review ${effectiveTitle} indonesia") agar sesuai dengan audiens Shopee lokal.
5. DO NOT REJECT WHOLE VIDEO IF PRODUCT MATCHES: As long as the physical product demonstrated matches ("isExactProductMatch": true), NEVER output fatal status "reject" just because some frames have faces/text! Output status "accept" or "partial" and populate "rejectedFrames" and "acceptedFrames" so backend can harvest replacement footage adaptively!`;

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

  const creativeDirection = creativePlan && Array.isArray(creativePlan.shots)
    ? creativePlan.shots.map((shot, i) =>
        `${i + 1}. ${shot.role}: ${shot.purpose} (ideal ${shot.targetSec}s, range ${shot.minSec}-${shot.maxSec}s)`
      ).join('\n')
    : '';

  const userPrompt = `Target Shopee Product: "${effectiveTitle}"
${effectiveDesc ? `Product Description: "${effectiveDesc}"` : ''}
${resolvedRefImage ? `[OFFICIAL REFERENCE PRODUCT PHOTO (SHOPEE LISTING) ATTACHED AS IMAGE #1]:
Image #1 is the OFFICIAL REFERENCE PHOTO of the target product from the Shopee listing.
The subsequent ${evalFrames.length} images are sampled frames from the candidate video(s).
Carefully compare the candidate video frames directly against the reference product in Image #1:
- The physical item demonstrated in the video frames MUST match or be the same product / OEM equivalent as shown in Image #1.
- Brand is OPTIONAL for generic/OEM household products. A missing or different logo is acceptable when the physical construction and operating mechanism match.
- Minor variations in brand logo on chassis, color accent, or button placement are ACCEPTABLE only when they do NOT change the product's mechanism, form factor, or core construction.
- OPERATING MECHANISM IS A HARD MATCH REQUIREMENT: manual pull-cord vs electric motor, manual rotary vs push-press, suction/vacuum vs non-suction, foldable vs rigid, pump vs gravity-feed, etc. are DIFFERENT product variants and MUST NOT be treated as the same product merely because they perform the same general function.
- Capacity/size differences (for example 500ml vs 700ml) may be acceptable only when the body design and mechanism are visibly the same OEM family; mechanism differences are never acceptable.
- If the video shows a completely DIFFERENT product or category, output:
  {"status": "reject", "detectedProduct": "<nama produk>", "isExactProductMatch": false, "reason": "Produk di video tidak cocok dengan foto produk target"}
` : ''}
Total Duration: ${totalDuration}s
Sampled Frames:
${evalFrames.map((f, i) => `#${i + 1} (${f.displayLabel || f.timeFormatted || formatSeconds(f.timestamp)})`).join(', ')}

${creativeDirection ? `PROFESSIONAL STORY-FIRST SHOT PLAN:
${creativeDirection}
- Prefer one visually consistent exact-product source when it can satisfy the roles.
- Use additional sources only when they are independently exact-product verified and materially improve missing shot roles.
- Do not force equal-length scenes. Pick the strongest moment for each role; timing will be conformed to voiceover later.
` : ''}

Review visual frames carefully against the 5 Mandatory Acceptance Criteria:
1. Exact Product Match & Shopee Regional Market Compatibility:
   - Does the physical item in the video match "${effectiveTitle}" and is it compatible with products sold across Shopee (Shopee Indonesia, Malaysia, Thailand, Vietnam, Philippines, Taiwan)? Hands-on tabletop demos of Asian OEM items are 100% WELCOME.
   - For UNBRANDED / NO-BRAND / OEM products, do NOT require a brand name. Judge the match from product type, physical form, distinctive parts, and especially the operating mechanism.
   - SAME FUNCTION IS NOT ENOUGH. Example: a manual pull-cord food chopper is NOT an exact match for an electric chopper; a hand-crank slicer is NOT an exact match for a push-down slicer; a vacuum sealer mechanism is NOT interchangeable with a simple heat sealer.
   - If the title/reference photo shows a distinctive mechanism or construction, the candidate video MUST visibly demonstrate that same mechanism/construction before isExactProductMatch can be true.
   - If DIFFERENT product, compilation, mechanism variant, or US/Western-exclusive retail item (prominent Amazon, Walmart, Target packaging not found on Shopee): output {"status": "reject", "detectedProduct": "<nama produk>", "isExactProductMatch": false, "reason": "Produk di video tidak cocok dengan produk target atau mekanisme fisiknya berbeda"}
2. Granular Frame-Level Discard QC (CRITICAL POLICY - DO NOT REJECT WHOLE VIDEO):
   - JANGAN PERNAH MENOLAK SELURUH VIDEO hanya karena 1 atau beberapa frame terdapat wajah vlogger, subtitle ucapan, intro bumper, atau watermark!
   - HANYA BUANG FRAME YANG TIDAK SESUAI TERSEBUT (abaikan nomor indeks frame yang ada wajah/ada teks ucapan).
   - PILIH 7 SLOT ADEGAN DARI FRAME-FRAME PERAGAAN FISIK PRODUK YANG BERSIH! (Contoh: jika frame #1 intro ada wajah, frame #2-20 tangan memperagakan produk di meja, pilih 7 frame dari #2-#20!).
   - VIDEO HANYA BOLEH DITOLAK (status: "reject") JIKA:
     1) Produk fisik di video 100% BUKAN produk target ("isExactProductMatch": false).
     2) SELURUH frame (100% dari detik awal hingga akhir) adalah rekaman podcast wajah orang bicara tanpa ada sama sekali peragaan fisik produk.
     3) Video adalah animasi CGI / kartun / slide foto statis (gambar diam bergeser) tanpa video nyata bergerak.
   - Asalkan video memperagakan produk target dan memiliki frame peragaan yang bersih, OUTPUT SELALU {"status": "accept"} dengan memilih frame-frame peragaan bersih ke dalam 7 slot storyboard!
3. Subtitle, Floating Text, & Graphic Overlay QC (with Granular Frame Tolerance):
   - Teks merek/tombol yang tercetak langsung pada fisik produk (printed/molded on product) adalah 100% DITERIMA dan BUKAN subtitle!
   - Jika satu frame ada teks/stiker ucapan, buang frame itu saja dan pilih frame lain yang bersih dari video yang sama!
4. Watermark & Logo QC (9:16 Crop Tolerance):
   - Watermark/logo di pojok kiri/kanan video (di luar area 9:16 tengah) TETAP DITERIMA karena akan terpotong saat di-crop ke format vertikal 9:16.
   - Jika ada watermark di tengah pada satu frame, abaikan frame tersebut dan pilih frame lain yang bersih dari video yang sama!
5. MANDATORY 7-SLOT AFFILIATE STORYBOARD ARCHITECTURE (WAJIB 7 ADEGAN BERBEDA & DYNAMIC MULTI-ANGLE):
   Video reels/shorts affiliate WAJIB berganti adegan setiap ~3-5 detik dan DILARANG KERAS monoton!
   - ATURAN SUDUT PANDANG & VARIASI PERSPEKTIF (CRITICAL UNTUK RETENSI REELS):
     * DILARANG KERAS memilih 2 frame berurutan dengan sudut kamera & jarak yang sama persis (terutama sudut top-down tegak lurus dari atas meja).
     * WAJIB kombinasikan minimal 3 tipe visual berbeda di antara 7 slot:
       1) Hero Establishing Shot: Produk utuh di atas meja (Slot 1).
       2) Macro Close-up Shot: Menyorot detail motif bunga, handle, tutup, knob, atau tekstur bahan.
       3) Dynamic Action Shot: Tangan memutar rak saji carousel/lazy susan, membuka penutup, menyajikan makanan, atau fungsi mekanik.
       4) Angle Variety: Sudut 45 derajat (miring elegan) atau perspektif meja makan.
   - DILARANG KERAS FRAME METERAN JAHIT / PENGGARIS: Dilarang memilih frame orang memegang meteran jahit kuning / mengukur mangkuk / membaca buku manual!
   - ATURAN KHUSUS SLOT 1: "clip1_full_product" (00:00-00:05) WAJIB MENAMPILKAN FISIK PRODUK SECARA UTUH (Opening Hero Shot / beauty shot produk di atas meja / produk yang sudah keluar dari kemasan / hands-on showcase fisik produk). DILARANG KERAS kardus kosong, bubble wrap tanpa produk, meteran, paket resi pengiriman, atau frame tanpa produk di Slot 1!
   ${preset.storyboardInstructions}
5B. TARGET PRODUCT MUST BE VISIBLY PRESENT IN EVERY SELECTED FRAME:
   - Setiap frame/slot yang dimasukkan ke storyboard WAJIB benar-benar menampilkan FISIK PRODUK TARGET secara jelas di dalam frame.
   - REJECT frame yang hanya menampilkan tangan kosong, bahan makanan, makanan jadi, wajan/panci, meja kosong, pemandangan, kardus kosong, bubble wrap tanpa produk, resi paket, meteran pengukur, atau mesin industri/peralatan lain tanpa produk target.
   - Untuk kitchen_tools: jangan pernah menganggap aktivitas memasak sebagai bukti produk. Jika produk target tidak terlihat dan dioperasikan, frame TIDAK valid.
   - Set hasTargetProductInEverySelectedFrame menjadi true HANYA bila setiap frame yang dipilih lolos bukti visual tersebut; bila satu saja tidak memenuhi, set false.

6. 100% PRODUCT VISUAL CONSISTENCY & MULTI-VIDEO HARVESTING:
   - KONSISTENSI PRODUK ADALAH ATURAN NOMOR 1: Seluruh 7 adegan yang dipilih (Slot 1 sampai Slot 7) WAJIB menampakkan MODEL PRODUK FISIK YANG SAMA PERSIS (model, bentuk, material, warna, dan fungsi identik dengan produk target: "${coreNoun}").
   - DILARANG KERAS MENCAMPUR PRODUK BERBEDA DI ANTARA POTONGAN KLIP! Jika ada kandidat video yang produk fisiknya berbeda tipe/warna/model dengan produk target, JANGAN pilih frame dari video tersebut!
   - ATURAN PEMILIHAN SUMBER VIDEO (MULTI-VIDEO HARVESTING):
     * JIKA FRAME BERASAL DARI LEBIH DARI 1 VIDEO KANDIDAT (misal: "Video #1" dan "Video #2"):
       AI WAJIB MEMILIH KLIP DARI MINIMAL 2 VIDEO SUMBER BERBEDA (misal: Slot 1, 3, 5 dari Video #1; Slot 2, 4, 6 dari Video #2).
       Ini SANGAT PENTING agar video Reels memiliki variasi sudut kamera, pencahayaan, dan latar belakang berbeda yang cinematic dan tidak membosankan!
     * JIKA HANYA 1 VIDEO SUMBER YANG TERSEDIA:
       PILIH 7 SLOT DENGAN VARIASI MAKSIMAL: pilih momen-momen dengan perbedaan sudut pandang (angle 45°, top-down), zoom hero shot, macro close-up tekstur/motif, dan aksi pemutaran/penyajian yang paling kontras dari video tersebut.
7. Output Format:
   - WAJIB laporkan "rejectedFrames": Daftar rincian semua frame yang ditolak ([{"frameIndex": N, "timestamp": T, "reason": "alasan"}]).
   - WAJIB laporkan "acceptedFrames": Daftar indeks frame yang bersih dan faceless ([1, 2, ...]).
   - Laporkan "missingSlots": Slot storyboard yang masih kosong jika footage belum cukup beragam ([ "clip3_action_demo", ... ]).
   - Berikan "suggestedSearchQueries": Kata kunci pencarian video pengganti di YouTube untuk mencari footage tambahan.
   - Isi objek "storyboard" dengan 7 indeks frame terbaik dari acceptedFrames.
   - Isi "reframeBySlot" untuk setiap slot dengan focusXStart/focusYStart/focusXEnd/focusYEnd.
   - Isi array "frames" dengan urutan ke-7 indeks frame tersebut.
   - Isi "frameAudit" untuk SETIAP frame yang dipilih: [{"frameIndex": N, "timestamp": 10.0, "containsTargetProduct": true, "isPackaging": false, "isMachine": false, "isActiveProductDemo": true}].
   - Output JSON lengkap sesuai skema terstruktur.`;

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
      const isMatchFalse =
        parsed.isProductMatch === false ||
        parsed.isExactProductMatch === false ||
        parsed.hasTargetProductInEverySelectedFrame === false ||
        isBulky ||
        parsed.isUsableSourceVideo === false;
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
      const selectedFrameAudit = Array.isArray(parsed.frameAudit) ? parsed.frameAudit : [];
      const auditByFrameIndex = new Map(
        selectedFrameAudit
          .map((a) => [Number(a?.frameIndex), a])
          .filter(([idx]) => Number.isFinite(idx) && idx > 0)
      );
      const hasCompleteSelectedFrameAudit = selectedIndices.length === 0
        ? true
        : selectedIndices.every((rawIdx) => {
            const idx = typeof rawIdx === 'object'
              ? Number(rawIdx?.frameIndex ?? rawIdx?.frame ?? rawIdx?.index)
              : Number(rawIdx);
            const audit = auditByFrameIndex.get(idx);
            return Boolean(
              audit &&
              audit.containsTargetProduct === true &&
              audit.isPackaging !== true &&
              audit.isMachine !== true &&
              audit.isActiveProductDemo === true
            );
          });
      const selectedFrameProofFailure =
        selectedIndices.length >= 3 &&
        (parsed.hasTargetProductInEverySelectedFrame === false || (selectedFrameAudit.length > 0 && !hasCompleteSelectedFrameAudit));

      // ── EKSTRAKSI & NORMALISASI REJECTED & ACCEPTED FRAMES ──
      let normalizedRejectedFrames = [];
      if (Array.isArray(parsed.rejectedFrames)) {
        normalizedRejectedFrames = parsed.rejectedFrames.map(rf => {
          if (!rf) return null;
          const fIdx = Number(rf.frameIndex ?? rf.frame ?? rf.index);
          const matchedFrame = Number.isFinite(fIdx) && fIdx >= 1 && fIdx <= evalFrames.length ? evalFrames[fIdx - 1] : null;
          return {
            frameIndex: Number.isFinite(fIdx) ? fIdx : null,
            timestamp: Number.isFinite(Number(rf.timestamp)) ? Number(rf.timestamp) : (matchedFrame?.timestamp ?? null),
            reason: String(rf.reason || rf.rejectionReason || 'Ditolak AI Vision').trim(),
            filePath: matchedFrame?.filePath || null,
            candidateIndex: matchedFrame?.candidateIndex !== undefined ? matchedFrame.candidateIndex : null,
            videoId: matchedFrame?.videoId || matchedFrame?.candidate?.id || null,
          };
        }).filter(Boolean);
      }

      // Gabungkan frameAudit yang tidak memenuhi syarat jika belum ada di rejectedFrames
      if (Array.isArray(parsed.frameAudit)) {
        for (const audit of parsed.frameAudit) {
          const aIdx = Number(audit?.frameIndex);
          if (Number.isFinite(aIdx) && aIdx >= 1 && aIdx <= evalFrames.length) {
            const isBad = audit.containsTargetProduct === false || audit.isPackaging === true || audit.isMachine === true || audit.isActiveProductDemo === false;
            if (isBad && !normalizedRejectedFrames.some(r => r.frameIndex === aIdx)) {
              const matchedF = evalFrames[aIdx - 1];
              normalizedRejectedFrames.push({
                frameIndex: aIdx,
                timestamp: matchedF?.timestamp ?? audit.timestamp ?? null,
                reason: audit.reason || audit.visualDescription || 'Tidak memenuhi kualifikasi peragaan aktif produk target',
                filePath: matchedF?.filePath || null,
                candidateIndex: matchedF?.candidateIndex !== undefined ? matchedF.candidateIndex : null,
                videoId: matchedF?.videoId || null,
              });
            }
          }
        }
      }

      let normalizedAcceptedFrames = [];
      if (Array.isArray(parsed.acceptedFrames)) {
        normalizedAcceptedFrames = parsed.acceptedFrames
          .map(f => Number(f?.frameIndex ?? f?.frame ?? f))
          .filter(f => Number.isFinite(f) && f >= 1 && f <= evalFrames.length);
      } else if (Array.isArray(parsed.frames)) {
        normalizedAcceptedFrames = [...new Set(parsed.frames.map(f => Number(f?.frameIndex ?? f?.frame ?? f)).filter(f => Number.isFinite(f) && f >= 1 && f <= evalFrames.length))];
      }

      let normalizedMissingSlots = Array.isArray(parsed.missingSlots) ? parsed.missingSlots.map(s => String(s).trim()).filter(Boolean) : [];
      let normalizedSuggestedQueries = Array.isArray(parsed.suggestedSearchQueries) ? parsed.suggestedSearchQueries.map(q => String(q).trim()).filter(Boolean) : [];

      console.log(`\n======================================================`);
      console.log(`[AIService Vision] 🔍 LAPORAN AUDIT FRAME OLEH GEMINI (${activeModel}):`);
      console.log(`  - Status Evaluasi : ${rawStatus || 'accept'} (Produk Fisik Cocok: ${!isMatchFalse ? 'YA' : 'TIDAK'})`);
      console.log(`  - Frame Bersih Diterima (${normalizedAcceptedFrames.length} frame): [${normalizedAcceptedFrames.map(i => `#${i}`).join(', ') || 'kosong'}]`);
      if (normalizedRejectedFrames.length > 0) {
        console.log(`  - ❌ Frame Ditolak (${normalizedRejectedFrames.length} frame):`);
        normalizedRejectedFrames.forEach(rf => {
          const candStr = rf.candidateIndex !== null && rf.candidateIndex !== undefined ? ` [Cand #${rf.candidateIndex + 1}]` : '';
          const tsStr = rf.timestamp !== null && rf.timestamp !== undefined ? ` (${Number(rf.timestamp).toFixed(1)}s)` : '';
          console.log(`     * Frame #${rf.frameIndex}${tsStr}${candStr}: ${rf.reason}`);
        });
      }
      if (normalizedMissingSlots.length > 0) {
        console.log(`  - ⚠️ Storyboard Slot yang Kurang: [${normalizedMissingSlots.join(', ')}]`);
      }
      if (normalizedSuggestedQueries.length > 0) {
        console.log(`  - 💡 Saran Kueri Video Pengganti: ${normalizedSuggestedQueries.join(' | ')}`);
      }
      console.log(`======================================================\n`);

      if (normalizedRejectedFrames.length > 0) {
        onProgress({
          step: 'gemini_vision',
          message: `AI mendeteksi ${normalizedRejectedFrames.length} frame ditolak (${normalizedRejectedFrames.map(r => `#${r.frameIndex}`).join(', ')}). ${normalizedMissingSlots.length > 0 ? `Slot kurang: [${normalizedMissingSlots.join(', ')}]. ` : ''}Memproses footage bersih...`,
          progress: 42,
          status: 'running',
        });
      }

      // Penolakan FATAL video HANYA jika produk benar-benar salah/berbeda, buatan AI/CGI, atau perabot dilarang
      const isFatalMismatch = isMatchFalse || selectedFrameProofFailure || isSynthetic || isBulky || (isRejectStatus && (reasonLower.includes('tidak cocok') || reasonLower.includes('pasar barat') || reasonLower.includes('bukan produk')));

      if (isFatalMismatch) {
        let rejectionMsg = reasonText || 'Produk di video tidak cocok dengan produk target.';
        console.warn(`[AIService ${provider} ${activeModel}] ⛔ VIDEO RESMI DITOLAK OLEH AI (Produk Tidak Cocok): ${rejectionMsg}`);
        const rejectError = new Error(`Video ditolak oleh AI (${activeModel}): ${rejectionMsg}`);
        rejectError.isAiRejection = true;
        rejectError.rejectionReason = rejectionMsg;
        rejectError.rejectedFrames = normalizedRejectedFrames;
        rejectError.missingSlots = normalizedMissingSlots;
        rejectError.suggestedSearchQueries = normalizedSuggestedQueries;
        throw rejectError;
      }

      // Jika AI menolak hanya karena ada frame wajah/subtitle/watermark pada sebagian frame:
      // JANGAN BUANG VIDEO! Pulihkan frame-frame peragaan tangan bersih dari video sumber yang sama.
      if (isRejectStatus || !hasValidFrames) {
        console.log(`[AIService ${provider} ${activeModel}] 🛡️ AI mendeteksi kendala pada sebagian frame (${reasonText || 'wajah/subtitle'}), namun fisik produk cocok. Memulihkan cuplikan peragaan bersih dari video yang sama...`);
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
        const fallbackFrameKeys = new Set();
        for (const rawIdx of selectedIndices) {
          const idx = typeof rawIdx === 'object'
            ? Number(rawIdx?.frameIndex ?? rawIdx?.frame ?? rawIdx?.index)
            : parseInt(rawIdx, 10);
          if (isNaN(idx) || idx < 1 || idx > evalFrames.length) continue;
          const frameObj = evalFrames[idx - 1];
          const audit = auditByFrameIndex.get(idx);
          if (
            audit &&
            (
              audit.containsTargetProduct !== true ||
              audit.isPackaging === true ||
              audit.isMachine === true ||
              audit.isActiveProductDemo !== true
            )
          ) {
            continue;
          }
          const ts = frameObj ? frameObj.timestamp : (idx * (totalDuration / evalFrames.length));
          const minSafeStart = Math.max(introCutoffSec || 0, 0);
          const rawStart = Math.max(0, Math.min(totalDuration - clipSec, Math.round(ts * 10) / 10));
          if (rawStart < minSafeStart) continue;

          const candIdx = frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : null;
          const frameKey = frameObj?.filePath || `${frameObj?.videoId || frameObj?.candidate?.id || candIdx}:${Math.round(ts * 10) / 10}`;
          if (fallbackFrameKeys.has(frameKey)) continue;

          const collides = candidateClips.some(c =>
            (c.candidateIndex === candIdx || (!c.candidateIndex && !candIdx)) &&
            Math.abs(c.startSeconds - rawStart) < Math.max(clipSec, 4.0)
          );
          if (collides) continue;

          const endSec = Math.round((rawStart + clipSec) * 10) / 10;
          candidateClips.push({
            startSeconds: rawStart,
            endSeconds: endSec,
            duration: clipSec,
            startTime: formatSeconds(rawStart),
            endTime: formatSeconds(endSec),
            candidateIndex: frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : null,
            candidateTitle: frameObj?.candidateTitle || '',
            candidateUrl: frameObj?.candidateUrl || '',
            videoId: frameObj?.videoId || '',
            candidate: frameObj?.candidate || null,
            reason: `Frame #${idx} (${frameObj?.displayLabel || formatSeconds(rawStart)}) peragaan produk memuaskan`,
            isCleanAffiliateShot: true,
            hasProductBrand: Boolean(parsed.hasProductBrand),
            reframe: {
              ...DEFAULT_REFRAME,
              renderMode: 'stage_80',
            }
          });
          fallbackFrameKeys.add(frameKey);
        }
      }

      const hasProductBrand = Boolean(parsed.hasProductBrand);
      const detectedBrand = (parsed.detectedBrand || '').trim() || (hasProductBrand ? 'Brand Terdeteksi' : 'none');
      const allowHflip = hasProductBrand ? false : (parsed.allowHflip !== false);

      const clips = normalizeClipPlan(candidateClips, totalDuration, {
        allowFallback: allowFallbackClips,
        frameAudit: Array.isArray(parsed.frameAudit) ? parsed.frameAudit : [],
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

      if (!clips || clips.length === 0) {
        console.warn(`[AIService ${provider} ${activeModel}] ⚠️ Footage saat ini belum menghasilkan cuplikan yang memenuhi syarat storyboard. Mengembalikan status kekurangan footage ke backend...`);
        return {
          detectedProduct: (parsed.detectedProduct || '').trim() || productTitle,
          startTime: '00:00',
          endTime: '00:00',
          startSeconds: 0,
          endSeconds: 0,
          duration: 0,
          productHook: parsed.productHook || getDynamicProductHookFallback(productTitle),
          hasProductBrand,
          detectedBrand,
          allowHflip,
          reframe: DEFAULT_REFRAME,
          clips: [],
          rejectedFrames: normalizedRejectedFrames,
          acceptedFrames: normalizedAcceptedFrames,
          missingSlots: normalizedMissingSlots.length > 0 ? normalizedMissingSlots : ['clip1_full_product', 'clip2_feature', 'clip3_action_demo'],
          suggestedSearchQueries: normalizedSuggestedQueries,
          reason: reasonText || 'Cuplikan bersih tidak mencukupi untuk storyboard 7-slot'
        };
      }

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
        rejectedFrames: normalizedRejectedFrames,
        acceptedFrames: normalizedAcceptedFrames,
        missingSlots: normalizedMissingSlots,
        suggestedSearchQueries: normalizedSuggestedQueries,
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
 * Lightweight product identity gate used BEFORE frames enter the multi-video pool.
 * Cleanliness is intentionally not enough: this gate verifies type, mechanism and
 * distinctive physical construction for each candidate independently.
 */
export async function verifyProductCandidateWithAI({
  apiKey,
  aiProvider,
  frames = [],
  productTitle = '',
  productDescription = '',
  productImage = '',
  productFingerprint = null,
  niche = 'kitchen_tools',
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(frames) || frames.length < 2) {
    return { verified: false, confidence: 0, reason: 'Frame kandidat terlalu sedikit untuk verifikasi produk.' };
  }

  const selectedEngine = (aiProvider || process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
  const { client, models, provider } = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider: selectedEngine });
  const prodInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreNoun = prodInfo.coreProductNoun || productTitle || 'Produk';
  const effectiveTitle = prodInfo.cleanTitle || productTitle || coreNoun;
  const fingerprintText = productFingerprint
    ? JSON.stringify(productFingerprint)
    : JSON.stringify({
        productType: coreNoun,
        brand: prodInfo.brand || '',
        model: prodInfo.model || '',
      });

  let resolvedRefImage = null;
  if (productImage) {
    try {
      resolvedRefImage = await resolveImageBufferAndBase64(productImage);
    } catch (err) {
      console.warn(`[ProductVerify] Foto referensi tidak dapat dimuat: ${err.message}`);
    }
  }

  const sampleFrames = frames.length <= 12
    ? frames
    : Array.from({ length: 12 }, (_, i) => frames[Math.round(i * (frames.length - 1) / 11)]);

  const systemPrompt = `You are a strict product identity verifier for short-form affiliate video sourcing.
Your ONLY task is deciding whether the candidate frames show the same target physical product or a legitimate OEM-equivalent variant.

HARD MATCH RULES:
- Product type/category must match.
- Operating mechanism must match. Same function is NOT enough.
- Distinctive construction/form factor must match.
- If target brand/model is explicitly known, it is a hard match unless the reference is clearly generic/OEM.
- Brand/logo is optional for unbranded/OEM products.
- Capacity, color and small cosmetic differences are soft attributes only when mechanism and construction remain the same.
- Manual pull-cord != electric motor.
- Hand-crank/rotary != push-press.
- Vacuum/suction != non-vacuum.
- Foldable != rigid when foldability is a defining construction.
- If evidence is ambiguous, REJECT. Never guess true.

Return strict JSON only:
{
  "verified": true,
  "confidence": 0.0,
  "detectedProduct": "",
  "productTypeMatch": true,
  "mechanismMatch": true,
  "constructionMatch": true,
  "brandModelMatch": true,
  "reason": ""
}`;

  const userPrompt = `Target listing: "${effectiveTitle}"
Target description: "${String(productDescription || '').slice(0, 700)}"
Target fingerprint: ${fingerprintText}
Niche: ${niche}
${resolvedRefImage ? 'Image #1 is the official product reference. Remaining images are candidate video frames.' : 'No official reference image is available; use listing text/fingerprint conservatively.'}

Verify ONLY product identity. Do not accept a candidate merely because it is visually clean or has the same general use.`;

  const messageContent = [{ type: 'text', text: userPrompt }];
  if (resolvedRefImage) {
    messageContent.push({
      type: 'image_url',
      image_url: { url: resolvedRefImage.dataUri, detail: 'low' },
    });
  }

  for (const frame of sampleFrames) {
    let imgUrl = frame?.base64;
    if (!imgUrl && frame?.filePath && fs.existsSync(frame.filePath)) {
      try {
        const mime = frame.filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        imgUrl = `data:${mime};base64,${fs.readFileSync(frame.filePath).toString('base64')}`;
      } catch {}
    }
    if (typeof imgUrl === 'string' && (imgUrl.startsWith('data:image/') || imgUrl.startsWith('http'))) {
      messageContent.push({ type: 'image_url', image_url: { url: imgUrl, detail: 'low' } });
    }
  }

  let lastError = null;
  for (const model of models) {
    try {
      onProgress({
        step: 'product_verification',
        message: `Verifikasi produk kandidat dengan ${provider} (${model})...`,
        progress: 35,
        status: 'running',
      });

      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: messageContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.05,
        max_tokens: 900,
      }, { timeout: 45000, maxRetries: 0 });

      const msg = response.choices?.[0]?.message;
      const raw = (msg?.content && msg.content.trim()) ? msg.content : (msg?.reasoning || '{}');
      const parsed = repairJson(raw);
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      const hardMatch =
        parsed.productTypeMatch !== false &&
        parsed.mechanismMatch !== false &&
        parsed.constructionMatch !== false &&
        parsed.brandModelMatch !== false;

      const verified = parsed.verified === true && hardMatch && confidence >= 0.72;
      return {
        ...parsed,
        verified,
        confidence,
        reason: String(parsed.reason || (verified ? 'Produk terverifikasi cocok.' : 'Identitas produk tidak cukup meyakinkan.')),
        model,
        provider,
      };
    } catch (err) {
      lastError = err;
      const status = err?.status || err?.statusCode;
      if (status === 401 || status === 402) break;
    }
  }

  throw new Error(`Verifikasi produk kandidat gagal: ${lastError?.message || 'semua model AI gagal'}`);
}

/**
 * Final rendered-frame QC. Unlike source QC, burned affiliate subtitles are expected here.
 * This verifies that the final crop still presents the target product professionally.
 */
export async function verifyFinalRenderedFramesWithAI({
  apiKey,
  aiProvider,
  frames = [],
  productTitle = '',
  productFingerprint = null,
  niche = 'kitchen_tools',
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(frames) || frames.length < 3) {
    return { passed: false, reason: 'Frame final terlalu sedikit untuk QC visual.' };
  }

  const selectedEngine = (aiProvider || process.env.ACTIVE_AI_ENGINE || 'gemini').trim().toLowerCase();
  const { client, models, provider } = getAiClientConfig({ apiKeyOverride: apiKey, aiProvider: selectedEngine });
  const sampleFrames = frames.length <= 10
    ? frames
    : Array.from({ length: 10 }, (_, i) => frames[Math.round(i * (frames.length - 1) / 9)]);

  const systemPrompt = `You are the FINAL MASTER QC director for a finished 9:16 affiliate video.
These are frames from the already-rendered final output, so clean Indonesian burned subtitles are EXPECTED and must NOT be treated as source contamination.

Check:
1. Target product remains clearly visible and not severely cropped off-screen.
2. Product identity/form/mechanism is visually consistent across the final video.
3. No obvious repeated/frozen scene dominates the edit.
4. Subtitle block is legible and stays in a reasonable lower-middle safe zone; it must not cover the product's key mechanism in most frames.
5. No black/blank frame or broken render.
6. No talking-head/visible face that violates the faceless edit policy.
7. No third-party creator watermark, social handle, channel logo, or source identity remains visible in the final 9:16 frame. No floating specification boxes, dimension markers (e.g. '< 32cm', 'Glass Lid', capacity/wattage badges), animated arrows, price tags, or foreign creator overlays. Physical branding printed directly on the target product is allowed.
8. Composition looks intentional for vertical 9:16.

Be conservative but do not reject for normal hard cuts, minor color differences, hands, or our own subtitles.
Return strict JSON:
{
  "passed": true,
  "productVisible": true,
  "productConsistent": true,
  "severeCropIssue": false,
  "duplicateSceneRisk": false,
  "subtitleSafe": true,
  "faceOrTalkingHead": false,
  "sourceWatermarkOrCreatorLogo": false,
  "hasFloatingTextOrSpecificationBadge": false,
  "brokenFrame": false,
  "confidence": 0.0,
  "reason": ""
}`;

  const userPrompt = `Target product: "${productTitle}"
Product fingerprint: ${JSON.stringify(productFingerprint || {})}
Niche: ${niche}
Review these final rendered frames as one finished short-form edit.`;

  const content = [{ type: 'text', text: userPrompt }];
  for (const frame of sampleFrames) {
    let imgUrl = frame?.base64;
    if (!imgUrl && frame?.filePath && fs.existsSync(frame.filePath)) {
      try {
        const mime = frame.filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        imgUrl = `data:${mime};base64,${fs.readFileSync(frame.filePath).toString('base64')}`;
      } catch {}
    }
    if (typeof imgUrl === 'string' && imgUrl.startsWith('data:image/')) {
      content.push({ type: 'image_url', image_url: { url: imgUrl, detail: 'auto' } });
    }
  }

  let lastError = null;
  for (const model of models) {
    try {
      onProgress({
        step: 'final_visual_qc',
        message: `AI Final Visual QC dengan ${provider} (${model})...`,
        progress: 99,
        status: 'running',
      });

      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.05,
        max_tokens: 700,
      }, { timeout: 45000, maxRetries: 0 });

      const msg = response.choices?.[0]?.message;
      const raw = (msg?.content && msg.content.trim()) ? msg.content : (msg?.reasoning || '{}');
      const parsed = repairJson(raw);
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      const passed =
        parsed.passed === true &&
        parsed.productVisible !== false &&
        parsed.productConsistent !== false &&
        parsed.severeCropIssue !== true &&
        parsed.duplicateSceneRisk !== true &&
        parsed.subtitleSafe !== false &&
        parsed.faceOrTalkingHead !== true &&
        parsed.sourceWatermarkOrCreatorLogo !== true &&
        parsed.hasFloatingTextOrSpecificationBadge !== true &&
        parsed.brokenFrame !== true &&
        confidence >= 0.70;

      return {
        ...parsed,
        passed,
        confidence,
        reason: String(parsed.reason || (passed ? 'Final visual QC passed.' : 'Final visual QC tidak cukup meyakinkan.')),
        model,
        provider,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`AI Final Visual QC gagal: ${lastError?.message || 'semua model gagal'}`);
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
  const targetDuration = Math.max(18, Math.min(45, Math.round(Number(segmentDuration) || 22)));
  const effectiveSceneSec = Math.max(2.5, Math.min(4.5, Number(sceneDuration) || 3.3));
  const sceneCount = Math.max(5, Math.min(8, Math.round(targetDuration / effectiveSceneSec)));
  const targetSpeechSec = Math.max(17, targetDuration - 1.5);
  const targetWords = Math.round(targetSpeechSec * 2.2);
  const minWords = Math.max(38, Math.round(targetSpeechSec * 1.9));
  const maxWords = Math.max(48, Math.round(targetSpeechSec * 2.4));

  const systemPrompt = isGadget
    ? `You are a Senior Tech Reviewer and Creative Director specializing in Indonesian YouTube Shorts and TikTok smartphone reviews (Faceless B-roll tech content).

You will receive the Product Title, Product Description, and the sampled frames of a ${targetDuration}-second video clip (${sceneCount} fast scenes of ~${effectiveSceneSec.toFixed(1)}s each).

CRITICAL ${sceneCount}-SLOT SMARTPHONE STORYBOARD FORMULA (${targetDuration}s Total Runtime):
The video consists of ${sceneCount} dynamic scene cuts (~${effectiveSceneSec.toFixed(1)}s each). Your voiceover MUST contain EXACTLY ${sceneCount} distinct spoken lines matching the progression of the video:

- Slot 1 [00:00]: Dynamic Hook (tarik perhatian seputar keunggulan bodi, layar mulus, atau kamera).
- Slot 2 s/d Slot ${sceneCount - 1}: Sorot fitur dan pengujian fisik yang tampak di frame (desain bodi, layar, performa, kamera).
- Slot ${sceneCount}: Soft CTA penutup (kisaran harga pasar dan pancingan diskusi penonton).

CRITICAL TIMING, LENGTH & PACING RULE (MANDATORY):
- TEMPO BICARA WAJIB SANTAI, JELAS, DAN TIDAK TERBURU-BURU!
- Total voiceover script MUST contain between ${minWords} and ${maxWords} words (~${targetWords} words target, ~7-8 words per line across all ${sceneCount} scenes).
- DILARANG menempelkan judul panjang SEO ke dalam naskah. Gunakan nama pendek produk (2-3 kata).
- Suara narator WAJIB terdistribusi merata dari detik [00:00] sampai selesai dengan tempo santai.

STRICT RULES FOR VOICE OVER:
- TONE & NATURALITAS: Hindari gaya bahasa kaku seperti membaca brosur atau berita. Bicaralah dengan gaya santai, luwes, dan kasual layaknya Anda sedang mereview langsung di depan kamera.
- WAJIB BEREAKSI PADA ADEGAN: Voiceover harus mendeskripsikan secara spesifik apa yang SEDANG DITAMPILKAN di frame tersebut (misal: "Lihat deh desainnya...", "Layar depannya mulus banget kan..."). Jangan mengawang-awang atau bahas spesifikasi yang tidak terlihat.
- NEVER mention unboxing cardboard boxes, bubble wrap, or plastic packaging. Focus 100% on phone aesthetics, UI, camera, performance, and battery.
- Write in natural, engaging conversational Indonesian.
- DILARANG KERAS menggunakan kata "kece" dan "kangen".
- HINDARI KATA SLANG "ng" (nggak, ngasih, ngeliat, dll) - gunakan kata baku.
- DILARANG menyebut nama medsos lain.
- DILARANG mengatakan "link di bio", "keranjang kuning", "checkout", atau ajakan beli langsung! Ini adalah Soft CTA murni untuk YouTube Shorts review.

Output MUST be strictly valid JSON matching the requested schema.`
    : `You are a Senior Creative Director and Ad Advisor specializing in Indonesian Short-Form Affiliate Video Marketing (Shopee Video, TikTok Shop, Instagram Reels).

You will receive the explicit Product Title, Product Description, and the sampled frames of a ${targetDuration}-second video clip (${sceneCount} fast scenes of ~${effectiveSceneSec.toFixed(1)}s each).

CRITICAL ${sceneCount}-SLOT STORYBOARD FORMULA (${targetDuration}s Total Runtime):
The video consists of EXACTLY ${sceneCount} dynamic scene cuts (~${effectiveSceneSec.toFixed(1)}s each). Your voiceover MUST contain EXACTLY ${sceneCount} distinct spoken lines starting with appropriate timestamps:

MANDATORY VISUAL GROUNDING (CRITICAL ANTI-HALLUCINATION RULE):
- Frame video adalah sumber kebenaran utama untuk visual dan aksi. Product Description hanya boleh dipakai untuk nama/konteks produk, BUKAN sebagai bukti fitur yang tidak terlihat.
- Setiap baris voiceover WAJIB mencerminkan bukti fisik yang tampak pada frame-frame foto yang dilampirkan (${trimmedFrames.length} frames).
- DILARANG KERAS menyalin kalimat template generik seperti "busa melimpah", "kain biasa", "sela-sela sempit", "ergonomis anti selip", atau "murah meriah tidak bikin boros" jika aksi tersebut tidak tampak di frame gambar.
- JIKA visual hanya menunjukkan makanan, wajan, cobek, bahan masakan, atau proses memasak tanpa demonstrasi target product, JANGAN membuat narasi seolah-olah target product sedang dipakai.
- TONE & NATURALITAS: Hindari gaya bahasa kaku seperti membaca brosur atau SPG jualan. Bicaralah dengan gaya santai, luwes, kasual layaknya teman yang sedang merekomendasikan barang bagus.
- WAJIB BEREAKSI PADA ADEGAN: Voiceover harus mendeskripsikan secara spesifik apa yang SEDANG DITAMPILKAN di frame tersebut (misal: "Liat deh waktu aku tuang air ini...", "Cara pakenya segampang ini tinggal pencet...").
- DILARANG mengarang spesifikasi seperti bahan, kapasitas, ukuran, kecepatan, ketahanan, atau hasil tertentu kecuali terlihat jelas pada frame atau disebut eksplisit dalam deskripsi produk.
- Jelaskan secara spesifik apa yang sedang didemonstrasikan tangan: cara memasang, memotong, mengupas, mengoperasikan tuas/alat, atau memperlihatkan hasil kerja produk.

STRUKTUR NASKAH ${sceneCount} SLOT:
1. Slot 1 [00:00]: The Dynamic Hook (tarik perhatian penonton dalam 3 detik pertama sesuai masalah produk).
   - DILARANG sapaan basi seperti "Stop scroll!", "Halo guys!", "Racun Shopee wajib punya!".
   - Fokuskan ke kegiatan memasak, food prep, kerapian, atau masalah spesifik produk.
2. Slot 2 s/d Slot ${sceneCount - 1}: Peragaan aksi nyata & kemudahan fitur:
   - Deskripsikan peragaan tangan yang tampak di frame detik bersangkutan secara lugas dan meyakinkan.
   - Sorot hasil penggunaan nyata yang rapi dan memuaskan.
3. Slot ${sceneCount}: Call to Action Penutup:
   - Ajak penonton mengecek produk di bawah / keranjang pojok kiri bawah sebelum kehabisan.

CRITICAL TIMING, LENGTH & PACING RULE (MANDATORY):
- TEMPO BICARA WAJIB SANTAI, JELAS, DAN TIDAK TERBURU-BURU!
- Total voiceover script MUST contain between ${minWords} and ${maxWords} words (Target ideal: ~${targetWords} words, ~7-8 words per line across all ${sceneCount} scenes).
- DILARANG menempelkan judul panjang SEO ke dalam naskah. Gunakan nama pendek produk (2-3 kata).
- Suara narator WAJIB terdistribusi merata dari detik [00:00] sampai selesai dengan tempo santai, rileks, dan artikulasi jelas.
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
   - Closing line MUST have a direct, urgent CTA to "keranjang pojok kiri bawah" atau "produk di bawah".

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
        temperature: 0.2,
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

// Moved formatEnrichedCaption to ai/promptBuilders.js

// Moved sanitizeScriptVocabulary to ai/promptBuilders.js

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

// Moved to ai/aiValidators.js





// Moved build7SlotStoryboardClips to ai/promptBuilders.js

// Moved to ai/aiValidators.js





function buildFallbackScenes(productName, segmentDuration, sceneDuration = 3.3) {
  const totalDuration = Math.max(15, Math.min(45, Math.round(Number(segmentDuration) || 24)));
  const sceneLength = Math.max(2.5, Math.min(5.0, Number(sceneDuration) || 3.3));
  const sceneCount = Math.max(4, Math.min(8, Math.round(totalDuration / sceneLength)));
  const sceneTemplates = [
    {
      visualDescription: `Hook aksi: demonstrasi cara lama yang merepotkan vs solusi modern.`,
      voiceover: getDynamicProductHookFallback(productName),
      adAdvisorNotes: 'Teks hook kontras tebal, SFX alert, potongan cepat pembuka.'
    },
    {
      visualDescription: `Solusi hero: ${productName} mulai digunakan dengan tangan secara praktis.`,
      voiceover: `Untung sekarang ada ${productName} ini, sekali pakai langsung beres.`,
      adAdvisorNotes: 'Transisi snappy, tunjukkan tangan mengoperasikan produk secara mantap.'
    },
    {
      visualDescription: `Aksi peragaan aktif: peragaan fungsi fisik produk bekerja dengan lancar.`,
      voiceover: `Tinggal operasikan dengan santai, prosesnya cepat dan gak perlu tenaga ekstra.`,
      adAdvisorNotes: 'Visual satisfying close-up peragaan aksi produk.'
    },
    {
      visualDescription: `Detail fungsi & kepraktisan saat digunakan untuk kebutuhan harian.`,
      voiceover: `Desainnya ringkas dan presisi, bikin pekerjaan jadi jauh lebih efisien.`,
      adAdvisorNotes: 'Sorot detail pergerakan alat dan kepraktisan penggunaannya.'
    },
    {
      visualDescription: `Hasil peragaan nyata yang memuaskan dan rapi seketika.`,
      voiceover: `Lihat hasilnya, benar-benar rapi memuaskan dan gampang banget dibersihkan.`,
      adAdvisorNotes: 'Tunjukkan hasil kerja produk secara jelas di frame tengah.'
    },
    {
      visualDescription: `Kualitas dan fungsionalitas produk untuk penggunaan jangka panjang.`,
      voiceover: `Materialnya solid dan awet, cocok banget jadi andalan di rumah.`,
      adAdvisorNotes: 'Teks keunggulan di layar, SFX coin.'
    },
    {
      visualDescription: `Hero shot penutup dengan animasi panah ke keranjang pojok kiri bawah.`,
      voiceover: `Yuk buruan cek produk di keranjang pojok kiri bawah sebelum kehabisan!`,
      adAdvisorNotes: 'Grafis panah berkedip ke pojok kiri bawah, CTA mendesak.'
    },
    {
      visualDescription: `Stiker diskon dan keranjang pojok kiri bawah.`,
      voiceover: `Langsung checkout di keranjang pojok kiri bawah mumpung masih promo!`,
      adAdvisorNotes: 'Teks urgensi penutup, SFX click.'
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

