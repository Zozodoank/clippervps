import { extractCoreProductInfo, isBulkyOrUnsuitableProduct } from '../discoveryService.js';
import { getNichePreset } from '../../config/nichePresets.js';

export function truncateProductDescription(desc = '', maxChars = 500) {
  const clean = String(desc || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
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
  const identityInfo = extractCoreProductInfo(effectiveTitle, effectiveDesc);
  const productIdentity = identityInfo.productIdentity || coreNoun || effectiveTitle || 'Produk';
  const productBrand = identityInfo.brand || '';
  const productModel = identityInfo.model || '';
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
    return `CRITERION 1: STRICT TARGET PRODUCT MATCH (VIDEO-FIRST DISCOVERY DOES NOT OVERRIDE PRODUCT IDENTITY)
- Target Product Family: "${coreNoun}" (Listing: "${effectiveTitle}")
${effectiveDesc ? `- Product Description: "${effectiveDesc}"` : ''}
- NON-NEGOTIABLE RULE: The TARGET PRODUCT defines what may be accepted. "Video-first" only means the candidate came from search; it NEVER means the video is allowed to define a new product.
- ACCEPT only when the physical item demonstrated is the SAME product family / same primary function as the target.
- OEM / white-label tolerance is allowed: color, minor shape, brand, handle contour, and small styling differences may vary, but the PRIMARY OBJECT AND PRIMARY FUNCTION must stay the same.
- If a reference product image is attached, compare the demonstrated physical object against that reference image and reject clear category/object mismatches.
- REJECT immediately when the video mainly demonstrates a different tool, cookware, food, recipe, meal preparation, or another kitchen object while the target product is absent or only incidental.
- REJECT recipe / cooking / food footage when the target product is not the object being actively demonstrated.
- REJECT if the selected footage shows ingredients or cookware as the main subject and the target product is not clearly visible and operated.
- REJECT large furniture, cabinets, standing racks, refrigerators, washing machines, large appliances, industrial machinery, factory production, outdoor grills, multi-product compilations, repair/service tutorials, DIY tutorials, and unrelated categories.
- The detected product may be a cleaner OEM name than the listing title, but it must remain inside the target product family.
- Output 'isExactProductMatch: false' whenever the physical product/category is materially different, even if the video itself is clean and faceless.
- A clean/faceless video is NOT sufficient for acceptance; PRODUCT MATCH is mandatory.`;
  }

  return `CRITERION 1: FUNCTIONAL & PHYSICAL PRODUCT MATCH (STRICT COMPACT KITCHEN TOOLS NICHE)
- Target Product Identity: "${productIdentity}"${productBrand ? ` | Brand: "${productBrand}"` : ''}${productModel ? ` | Model/Type: "${productModel}"` : ''}
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
  * The video does NOT contain at least 5 clean, satisfying, 100% faceless hands-only tabletop action clips (${clipSec}s each).
  * In rejection output, set reason to: "Menampilkan wajah atau presenter manusia (wajib 100% faceless peragaan tangan)"`;
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
  clipSec = 3.5,
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

  // Anti-repetition / packaging guard:
  // Never reuse the exact source frame, and never reuse overlapping moments from the same source video.
  const selectedFrameKeys = new Set();
  const selectedTimestampsByCandidate = new Map();
  const frameAuditByIndex = new Map(
    (Array.isArray(parsed?.frameAudit) ? parsed.frameAudit : [])
      .map((a) => [Number(a?.frameIndex), a])
      .filter(([idx]) => Number.isFinite(idx) && idx > 0)
  );

  const getFrameKey = (f) =>
    f?.filePath ||
    `${f?.videoId || f?.candidate?.id || f?.candidateUrl || 'candidate'}:${Math.round((Number(f?.timestamp) || 0) * 10) / 10}`;

  const isForbiddenFrame = (f) => {
    if (!f) return true;
    const idx = validFrames.indexOf(f) + 1;
    const audit = frameAuditByIndex.get(idx);
    if (audit) {
      if (audit.containsTargetProduct === false || audit.isPackaging === true || audit.isMachine === true || audit.isActiveProductDemo === false) {
        return true;
      }
    }
    const frameText = [
      f?.displayLabel,
      f?.label,
      f?.description,
      f?.category,
      f?.datasetTag,
      f?.candidateTitle,
      audit?.visualDescription,
      audit?.detectedAction,
      audit?.reason,
    ].filter(Boolean).join(' ').toLowerCase();

    return /bubble\s*wrap|kardus\s+kosong|cardboard\s+box|empty\s+package|resi\s+pengiriman|paper\s+manual|buku\s+panduan|industrial\s+machine|factory\s+machine|machinery|mesin\s+industri|mesin\s+pabrik|mesin\s+produksi|meteran|penggaris|tape\s*measure|ruler|caliper|alat\s*ukur|measuring\s*tape|dimensi|angka\s*mengambang|floating\s*number|stiker\s*diskon|badge\s*diskon/.test(frameText);
  };

  // Multi-video harvesting: distribusikan slot antar kandidat jika tersedia lebih dari 1 video terverifikasi
  const sourceRank = candIndices
    .map((candidateIndex) => ({
      candidateIndex,
      count: framesByCand.get(candidateIndex)?.length || 0,
    }))
    .sort((a, b) => b.count - a.count);
  const primaryCandidate = sourceRank[0]?.candidateIndex ?? null;

  const isUsableDistinctFrame = (f) => {
    if (!f || isForbiddenFrame(f)) return false;

    const key = getFrameKey(f);
    if (selectedFrameKeys.has(key)) return false;

    const cand = f?.candidateIndex !== undefined ? f.candidateIndex : 0;
    const ts = Number(f?.timestamp) || 0;
    const previous = selectedTimestampsByCandidate.get(cand) || [];

    // Same-source scenes must be separated by at least 8.0s to ensure a visibly different moment/action
    if (previous.some((p) => Math.abs(p - ts) < 8.0)) return false;

    return true;
  };

  const chooseDistinctFrame = (preferred, preferredCandidate = null) => {
    // Phase 1: strictly try the required source for this scene.
    if (preferredCandidate !== null) {
      const required = [];
      if (preferred && (preferred.candidateIndex ?? 0) === preferredCandidate) {
        required.push(preferred);
      }
      for (const f of validFrames) {
        const cand = f?.candidateIndex !== undefined ? f.candidateIndex : 0;
        if (cand === preferredCandidate && f !== preferred) required.push(f);
      }

      for (const f of required) {
        if (isUsableDistinctFrame(f)) return f;
      }
    }

    // If the primary source cannot satisfy this role, allow another independently
    // verified source rather than leaving the slot empty. Product verification happened
    // before pooling, so this remains identity-safe.
    if (preferred && isUsableDistinctFrame(preferred)) return preferred;
    for (const f of validFrames) {
      if (isUsableDistinctFrame(f)) return f;
    }
    return null;
  };

  for (let sIdx = 0; sIdx < slotsConfig.length; sIdx++) {
    // Rotasi target kandidat jika ada multi-kandidat untuk mendiversifikasi sumber antar adegan
    const targetCandidate = (candIndices.length > 1)
      ? candIndices[sIdx % candIndices.length]
      : primaryCandidate;
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
      // Slot 6 & 7: cari hero/closing frame yang BENAR-BENAR berbeda.
      if (!frameObj) {
        const lateHeroCandidates = validFrames
          .filter((f, i) => i >= Math.floor(totalFramesCount * 0.70) && (f.timestamp || 0) > 0);
        frameObj = lateHeroCandidates[config.slot === 6 ? 0 : 1] || lateHeroCandidates[0] || null;
      }
    }

    // Multi-candidate diversity: Prioritaskan frame pilihan AI jika valid dan distinct
    let distinctFrame = null;
    if (frameObj && isUsableDistinctFrame(frameObj)) {
      distinctFrame = frameObj;
    } else {
      distinctFrame = chooseDistinctFrame(frameObj, targetCandidate);
    }

    if (!distinctFrame) {
      console.warn(`[build7SlotStoryboardClips] Tidak ada frame unik yang cukup untuk Slot #${config.slot}; slot dilewati agar tidak mengulang visual.`);
      continue;
    }
    frameObj = distinctFrame;

    const candIdx = frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : 0;
    const candDuration = frameObj?.candidate?.duration || totalDuration;
    const frameTs = frameObj.timestamp !== undefined ? frameObj.timestamp : (sIdx * (candDuration / 7));

    let startSec = Math.max(0, Math.min(candDuration - clipSec, Math.round(frameTs * 10) / 10));
    if (startSec < minSafeStart && config.slot !== 6 && config.slot !== 7) {
      startSec = minSafeStart;
    }

    // Universal anti-overlap rule: same source video must use non-overlapping clips separated by at least 8.0s
    const collides = storyboardClips.some(sc =>
      sc.candidateIndex === candIdx &&
      Math.abs(sc.startSeconds - startSec) < 8.0
    );
    if (collides) {
      console.warn(`[build7SlotStoryboardClips] Slot #${config.slot} bentrok dengan clip sebelumnya pada video yang sama; slot dilewati.`);
      continue;
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
      reframe: (() => {
        const baseY = config.slot === 7 ? 0.60 : (config.slot === 4 ? 0.65 : 0.55);
        const panDirection = config.slot % 2 === 0 ? -1 : 1;
        const aiTrack = parsed?.reframeBySlot?.[config.key] || parsed?.reframeBySlot?.[config.fallbackKey] || {};
        const clampTrack = (value, fallback) => {
          const n = Number(value);
          return Number.isFinite(n) ? Math.max(0.05, Math.min(0.95, n)) : fallback;
        };
        return {
          ...DEFAULT_REFRAME,
          renderMode: 'stage_80',
          focusX: 0.50,
          focusY: baseY,
          focusXStart: clampTrack(aiTrack.focusXStart, Math.max(0.38, Math.min(0.62, 0.50 - (0.025 * panDirection)))),
          focusXEnd: clampTrack(aiTrack.focusXEnd, Math.max(0.38, Math.min(0.62, 0.50 + (0.025 * panDirection)))),
          focusYStart: clampTrack(aiTrack.focusYStart, Math.max(0.35, Math.min(0.80, baseY - 0.015))),
          focusYEnd: clampTrack(aiTrack.focusYEnd, Math.max(0.35, Math.min(0.80, baseY + 0.015))),
          dynamicTracking: true,
          notes: Object.keys(aiTrack).length
            ? 'AI product-aware reframe trajectory from selected source frames.'
            : 'Subtle fallback reframe trajectory; keep product inside center safe zone.'
        };
      })()
    };

    if (config.slot === 1) slot1Clip = clipObj;

    const selectedKey = getFrameKey(frameObj);
    selectedFrameKeys.add(selectedKey);
    const selectedCand = frameObj?.candidateIndex !== undefined ? frameObj.candidateIndex : candIdx;
    const selectedTs = Number(frameObj?.timestamp) || startSec;
    if (!selectedTimestampsByCandidate.has(selectedCand)) {
      selectedTimestampsByCandidate.set(selectedCand, []);
    }
    selectedTimestampsByCandidate.get(selectedCand).push(selectedTs);

    storyboardClips.push(clipObj);
  }

  return storyboardClips;
}

