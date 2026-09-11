import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import https from 'https';
import { searchYouTubeVideos, extractVideoId } from './downloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USED_KEYWORDS_FILE = path.join(__dirname, '..', 'used_keywords.json');
const JOBS_FILE = path.join(__dirname, '..', 'jobs.json');

export const DEFAULT_AUTO_KEYWORDS = [
  // =========================================================================
  // 1. ALAT DAPUR, PEMOTONG & FOOD PREP (Kitchen Prep & Choppers)
  // =========================================================================
  'chopper mini elektrik portable viral',
  'chopper manual tarik serbaguna viral',
  'alat potong sayur multifungsi slicer',
  'mandoline slicer parutan serbaguna',
  'alat pengupas buah praktis serbaguna',
  'alat pemotong bawang cabai mini praktis',
  'gunting dapur serbaguna stainless multifungsi',
  'alat pemisah kuning telur praktis viral',
  'alat pembuat dumpling pastel manual',
  'alat pemeras jeruk lemon manual stainless',
  'pemotong semangka melon praktis viral',
  'alat pemotong kentang spiral praktis',
  'food chopper blender mini portable',
  'alat pelumat bawang putih press garlic',
  'parutan keju kelapa stainless praktis',
  'cetakan bakso manual praktis serbaguna',
  'alat pengupas kulit udang praktis',
  'alat pembuang biji apel buah praktis',
  'alat pemotong nanas spiral stainless',
  'alat pengiris daging beku manual slicer',
  'alat perajang bawang manual putar praktis',
  'alat pencacah daging manual serbaguna',
  'alat pelubang kelapa muda praktis stainless',
  'parutan wortel kentang 6 in 1 multifungsi',
  'alat pencabut bulu ayam ikan stainless',
  'alat pemotong alpukat 3 in 1 praktis',
  'alat pengiris telur rebus praktis stainless',
  'alat pemotong jagung serut stainless',
  'alat pengupas sisik ikan stainless praktis',
  'alat pemecah cangkang kepiting walnut',
  'blender kapsul serbaguna mini cutter',
  'alat pelumat kentang potato masher stainless',
  'alat pengiris mentega keju butter slicer',
  'alat pemeras santan kelapa manual mini',
  'alat penusuk daging tenderizer empuk',
  'gunting daging tulang unggas heavy duty',
  'alat pemotong pizza roda stainless bulat',
  'alat pembuka kaleng putar praktis aman',
  'alat pembuka tutup botol toples serbaguna',
  'parutan serbaguna wadah penampung baskom',
  'alat pemipil jagung serbaguna praktis',
  'alat pemotong kentang french fries cutter',
  'alat peremas kentang stainless potato ricer',
  'gunting daun bawang sayur 5 lapis stainless',
  'alat pembersih sisik ikan dengan wadah',
  'sendok pembuat bakso bakwan anti lengket',
  'alat pencetak burger patty press manual',
  'pemisah putih kuning telur stainless',
  'alat pengupas nanas nenas corer slicer',
  'pemotong telur rebus kawat stainless',
  'sendok porsi es krim scoop trigger stainless',
  'pemeras bawang putih rocker stainless garlic',
  'alat pemotong keju kawat stainless steel',
  'parutan keju putar rotary cheese grater',
  'pengupas kulit jeruk lemon zester stainless',
  'alat perajang rempah daun stainless herb cutter',
  'alat pengocok telur semi otomatis putar tekan',

  // =========================================================================
  // 2. PERALATAN MASAK MINI, BAKING & GADGET KOMPOR (Mini Cooking & Baking)
  // =========================================================================
  'wajan penggorengan mini telur 4 lubang anti lengket',
  'panci listrik mini serbaguna portable',
  'alat pembuat waffle mini elektrik praktis',
  'sutil silikon set anti panas food grade',
  'timbangan digital dapur mini presisi',
  'timer dapur digital magnetik masak',
  'alat pengasah pisau dapur praktis 3 stage',
  'alat pembuat es batu silikon pencet praktis',
  'cetakan es batu bulat bola silikon viral',
  'splash guard pelindung cipratan minyak kompor',
  'alas silikon adonan kue baking anti lengket',
  'alat pencetak kue kering biskuit praktis',
  'capitan makanan silikon stainless food grade',
  'termometer makanan digital masak dapur',
  'alat pembuat crepes mini elektrik anti lengket',
  'panci kukus mini elektrik serbaguna',
  'cetakan takoyaki mini anti lengket teflon',
  'wajan grill pan mini anti lengket pemanggang',
  'mixer tangan mini elektrik portable usb',
  'frother pengocok susu kopi mini elektrik',
  'kertas baking parchment paper air fryer bulat',
  'silikon pot air fryer reusable anti lengket',
  'cetakan es loli popsicle silikon bpa free',
  'dispenser adonan kue pencet pancake batter',
  'spatula silikon tahan panas food grade set',
  'kuas minyak silikon baking tahan panas',
  'cetakan donat manual praktis adonan',
  'rolling pin kayu silikon penggiling adonan',
  'cetakan puding silikon bentuk bunga estetik',
  'sendok takar bumbu dapur digital lcd',
  'saringan tepung stainless putar manual praktis',
  'pemanggang sandwich toaster mini elektrik',
  'cetakan sushi roll manual praktis bazooka',
  'cetakan onigiri nasi bento segitiga praktis',
  'alat tusuk sate praktis pembuat sate cepat',
  'cetakan martabak mini 7 lubang anti lengket',
  'panci rebus mie telur mini stainless gagang',
  'penutup silikon microwave anti cipratan',
  'tatakan kompor gas pelindung api hemat gas',
  'pematik api kompor gas elektrik usb recharge',
  'wajan tamagoyaki teflon telur gulung jepang mini',
  'sarung tangan oven silikon anti panas tebal',
  'jepitan mangkok piring panas silikon stainless',
  'alas tatakan panci panas silikon tahan panas',
  'sendok ukur bumbu set stainless magnetic',
  'saringan tirisan mie minyak serbaguna stainless',
  'pembuat churros cetakan kue semprit manual',
  'capitan gorengan stainless dengan saringan tirisan',
  'tatakan sutil tutup panci silikon anti panas',

  // =========================================================================
  // 3. WADAH BUMBU, BOTOL & AKSESORIS MEJA DAPUR KOMPAK (Compact Kitchen Storage)
  // (CATATAN: HANYA wadah mini/tabletop, BUKAN lemari atau rak besar!)
  // =========================================================================
  'botol minyak kuas silikon 2 in 1 anti tumpah',
  'botol semprot minyak spray olive oil praktis',
  'tempat bumbu putar serbaguna dapur viral',
  'dispenser beras mini otomatis anti kutu praktis',
  'kotak telur organizer kulkas tingkat otomatis',
  'sealer plastik mini portable perekat makanan',
  'tutup makanan silikon stretch elastis reusable',
  'wadah penyimpanan makanan kedap udara mini',
  'tempat sendok garpu tirisan mini anti debu',
  'wadah tirisan cuci beras buah sayur praktis',
  'botol bumbu dapur sendok terintegrasi praktis',
  'wadah bumbu 4 sekat praktis sendok',
  'tempat pisau dapur magnetic strip dinding',
  'wadah penyimpanan sayur kulkas drain basket',
  'kotak bumbu dapur putar 360 derajat mini',
  'dispenser minyak goreng kaca otomatis tuang',
  'wadah kantong teh kopi gula kedap udara',
  'kotak penyimpanan bawang cabai mini kulkas',
  'wadah bumbu dapur kaca sendok label estetik',
  'tatakan sendok spatula silikon anti kotor praktis',
  'toples kaca kedap udara tutup bambu estetik',
  'wadah minyak bekas jelantah saringan stainless',
  'kotak organizer bumbu sachet mini kulkas',
  'penutup makanan payung tudung saji lipat',
  'corong lipat silikon minyak air serbaguna',
  'wadah pencuci beras sayur drain bowl putar',
  'botol saus mayones kecap squeeze bottle putar',
  'saringan teh kopi stainless reusable infuser',

  // =========================================================================
  // 4. ALAT KEBERSIHAN KHUSUS WASTAFEL & DAPUR MINI (Kitchen Cleaning Tools)
  // =========================================================================
  'dispenser sabun cuci piring otomatis sponge pump',
  'spons cuci piring nano magic sponge pembersih kerak',
  'sikat cuci piring dispenser sabun cair otomatis',
  'spons kawat cuci piring sabut stainless anti gores',
  'kain lap nano berserat pembersih minyak dapur',
  'alat pembersih kerak wajan panci serbaguna',
  'sikat pembersih botol tumbler sedotan set',
  'sikat pembersih blender mata pisau dapur'
];

export const BULKY_EXCLUDE_WORDS = [
  // Lemari, kabinet, kitchen set & furniture besar
  'lemari',
  'wardrobe',
  'kabinet',
  'cabinet',
  'kitchen set',
  'kitchen island',
  'buffet',
  'etalase',
  'sideboard',
  'credensa',
  'kulkas',
  'refrigerator',
  'freezer',
  'kasur',
  'springbed',
  'spring bed',
  'matras',
  'meja belajar',
  'meja makan',
  'meja kantor',
  'meja tamu',
  'meja tv',
  'meja bar',
  'island table',
  'meja kasir',
  'sofa',
  'dipan',
  'ranjang',
  'kursi',
  'kursi gaming',
  'kursi kantor',
  'kursi roda',
  'kursi makan',
  'mesin cuci',
  'washing machine',
  'ac portable',
  'tv cabinet',
  'furniture',
  'perabot besar',

  // Rak besar, rak piring bertingkat, & organizer jumbo yang memenuhi frame
  'rak besar',
  'rak jumbo',
  'rak besi',
  'rak piring',
  'dish rack',
  'dish drainer',
  'rak susun',
  'rak bertingkat',
  'rak tingkat',
  'rak wastafel',
  'rak sink',
  'rak lemari',
  'rak sudut',
  'standing rack',
  'rak standing',
  'rak troli',
  'troli dapur',
  'trolley',
  'rak roda',
  'rak dinding',
  'rak gantung piring',
  'rak bumbu susun',
  'rak bumbu tingkat',
  'rak bawah wastafel',
  'rak dapur susun',
  'rak dapur besar',
  'drying rack',

  // Kompor & oven besar
  'kompor tanam',
  'kompor gas 2 tungku',
  'kompor gas kaca',
  'kompor standing',
  'oven besar',
  'standing stove',
  'cooker hood',
  'exhaust fan',
  'dispenser galon bawah',
  'standing dispenser',

  // Kategori non-dapur (kebersihan umum rumah, pakaian, kamar mandi, lifestyle, pertukangan)
  'rak sepatu',
  'rak buku',
  'rak baju',
  'gantungan baju',
  'jemuran',
  'shower',
  'kloset',
  'toilet',
  'keset',
  'spray mop',
  'pel lantai',
  'pel peras',
  'pel putar',
  'vacuum cleaner',
  'kemoceng',
  'obeng',
  'tang lipat',
  'holder hp',
  'stand laptop',
  'catokan',
  'alat pijat',
  'lampu tidur'
];

export function isBulkyOrUnsuitableProduct(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  // 1. Direct match on exclude list
  if (BULKY_EXCLUDE_WORDS.some((word) => normalized.includes(word))) {
    return true;
  }

  // 2. Any combination of "rak" with frame-filling descriptors
  if (/\brak\b/.test(normalized) && /(?:besar|jumbo|susun|tingkat|piring|wastafel|dapur|besi|standing|troli|roda|tinggi|dinding|gantung)/.test(normalized)) {
    return true;
  }

  // 3. Furniture or cabinet indicators
  if (/\b(?:lemari|kabinet|cabinet|furniture|wardrobe|kitchen\s+set|meja\s+makan|kursi)\b/.test(normalized)) {
    return true;
  }

  return false;
}

// ─── PERSISTENT USED KEYWORDS & ANTI-DUPLICATION STORE ─────────────────────────

export function normalizeKeyword(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Loads used keywords from disk and auto-syncs with existing jobs.json
 * to guarantee that any product or keyword ever processed previously
 * is automatically excluded and never repeated.
 */
export function loadUsedKeywords() {
  let store = {
    keywords: {},
    productTitles: {},
    lastUpdated: null
  };

  try {
    if (fs.existsSync(USED_KEYWORDS_FILE)) {
      const raw = fs.readFileSync(USED_KEYWORDS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      store = {
        keywords: parsed.keywords || {},
        productTitles: parsed.productTitles || {},
        lastUpdated: parsed.lastUpdated || null
      };
    }
  } catch (err) {
    console.warn('[Discovery] Failed to read used_keywords.json, initializing new store:', err.message);
  }

  // Backfill from jobs.json if available so historical jobs are never re-generated
  let dirty = false;
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const rawJobs = fs.readFileSync(JOBS_FILE, 'utf-8');
      const jobsObj = JSON.parse(rawJobs);
      for (const [jobId, jobData] of Object.entries(jobsObj)) {
        if (!jobData) continue;
        if (jobData.keyword) {
          const normK = normalizeKeyword(jobData.keyword);
          if (normK && !store.keywords[normK]) {
            store.keywords[normK] = {
              usedAt: Date.parse(jobData.createdAt) || Date.now(),
              dateStr: jobData.createdAt || new Date().toISOString(),
              productTitle: jobData.productTitle || null,
              jobId,
              source: 'jobs.json'
            };
            dirty = true;
          }
        }
        if (jobData.productTitle) {
          const normT = normalizeKeyword(jobData.productTitle);
          if (normT && !store.productTitles[normT]) {
            store.productTitles[normT] = {
              usedAt: Date.parse(jobData.createdAt) || Date.now(),
              dateStr: jobData.createdAt || new Date().toISOString(),
              jobId,
              source: 'jobs.json'
            };
            dirty = true;
          }
        }
        if (jobData.cleanProductTitle) {
          const normC = normalizeKeyword(jobData.cleanProductTitle);
          if (normC && !store.productTitles[normC]) {
            store.productTitles[normC] = {
              usedAt: Date.parse(jobData.createdAt) || Date.now(),
              dateStr: jobData.createdAt || new Date().toISOString(),
              jobId,
              source: 'jobs.json'
            };
            dirty = true;
          }
        }
        if (jobData.coreProductNoun) {
          const normN = normalizeKeyword(jobData.coreProductNoun);
          if (normN && !store.keywords[normN]) {
            store.keywords[normN] = {
              usedAt: Date.parse(jobData.createdAt) || Date.now(),
              dateStr: jobData.createdAt || new Date().toISOString(),
              jobId,
              source: 'jobs.json'
            };
            dirty = true;
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal if jobs.json doesn't exist or is empty
  }

  if (dirty) {
    store.lastUpdated = new Date().toISOString();
    saveUsedKeywords(store);
  }

  return store;
}

export function saveUsedKeywords(store) {
  try {
    fs.writeFileSync(USED_KEYWORDS_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Discovery] Failed to write used_keywords.json:', err.message);
  }
}

/**
 * Marks a keyword and associated product title as used so it will never be generated again.
 */
export function markKeywordAsUsed(keyword, meta = {}) {
  const norm = normalizeKeyword(keyword);
  if (!norm) return;
  const store = loadUsedKeywords();
  store.keywords[norm] = {
    usedAt: Date.now(),
    dateStr: new Date().toISOString(),
    productTitle: meta.productTitle || null,
    jobId: meta.jobId || null,
    source: meta.source || 'system'
  };
  if (meta.productTitle) {
    const normTitle = normalizeKeyword(meta.productTitle);
    if (normTitle) {
      store.productTitles[normTitle] = {
        usedAt: Date.now(),
        dateStr: new Date().toISOString(),
        jobId: meta.jobId || null
      };
    }
  }
  store.lastUpdated = new Date().toISOString();
  saveUsedKeywords(store);
}

/**
 * Returns true if a keyword has been used before in history.
 */
export function isKeywordUsed(keyword) {
  const norm = normalizeKeyword(keyword);
  if (!norm) return false;
  const store = loadUsedKeywords();
  if (store.keywords && store.keywords[norm]) return true;
  if (store.productTitles && store.productTitles[norm]) return true;
  return false;
}

/**
 * Returns true if a product title was already used, including prefix match to prevent duplicate listings.
 */
export function isProductTitleUsed(title) {
  const norm = normalizeKeyword(title);
  if (!norm) return false;
  const store = loadUsedKeywords();
  if (store.productTitles && store.productTitles[norm]) return true;
  if (store.keywords && store.keywords[norm]) return true;

  // Check if first 5 significant words match an existing title
  const words = norm.split(' ').filter((w) => w.length > 2).slice(0, 5).join(' ');
  if (words.length >= 10) {
    for (const stored of Object.keys(store.productTitles || {})) {
      if (stored.includes(words)) return true;
    }
  }
  return false;
}

/**
 * Returns stats on processed keywords and recent history.
 */
export function getUsedKeywordsStats() {
  const store = loadUsedKeywords();
  const keywordCount = Object.keys(store.keywords || {}).length;
  const titleCount = Object.keys(store.productTitles || {}).length;
  const recentKeywords = Object.entries(store.keywords || {})
    .sort((a, b) => (b[1].usedAt || 0) - (a[1].usedAt || 0))
    .slice(0, 10)
    .map(([k, v]) => ({ keyword: k, usedAt: v.dateStr, productTitle: v.productTitle }));

  return {
    totalUsedKeywords: keywordCount,
    totalUsedTitles: titleCount,
    lastUpdated: store.lastUpdated,
    recentKeywords
  };
}

/**
 * Resets the used keywords database.
 */
export function clearUsedKeywords() {
  const store = { keywords: {}, productTitles: {}, lastUpdated: new Date().toISOString() };
  saveUsedKeywords(store);
  return store;
}

// ─── COMBINATORIAL KITCHEN KEYWORDS GENERATOR ─────────────────────────────────
// Curated exclusively for compact, tabletop kitchen gadgets & tools (100% kitchen tools, 0% bulky furniture/racks)

export const KITCHEN_CORE_TOOLS = [
  // Choppers, Slicers, Cutters & Graters
  'chopper mini manual tarik',
  'chopper mini elektrik portable',
  'food chopper blender mini',
  'blender kapsul mini portable',
  'mandoline slicer parutan',
  'parutan multifungsi baskom wadah',
  'parutan keju kelapa stainless',
  'parutan sayur wortel kentang',
  'alat pemotong sayur serbaguna',
  'alat pemotong bawang cabai mini',
  'alat perajang bawang manual putar',
  'alat pengiris daging beku slicer',
  'alat pengiris mentega keju butter',
  'alat pemotong kentang spiral tornado',
  'alat pemotong kentang french fries',
  'alat pemotong semangka melon',
  'alat pemotong alpukat 3 in 1',
  'alat pemotong nanas spiral corer',
  'alat pemotong pizza roda stainless',
  'alat serut jagung pipil stainless',
  'alat pemipil jagung serbaguna',
  'alat pengiris telur rebus stainless',
  'alat pemecah cangkang kepiting walnut',
  'sendok pembuat bakso bakwan',
  'cetakan bakso manual serbaguna',
  'alat pencetak burger patty press',

  // Peelers, Mashers, Presses & Extractors
  'alat pengupas buah sayur peeler',
  'alat pengupas kulit udang praktis',
  'alat pembuang biji apel pir',
  'alat pelumat kentang potato masher',
  'alat peremas kentang potato ricer',
  'alat pelumat bawang putih garlic press',
  'alat pemeras jeruk lemon stainless',
  'alat pemeras jeruk nipis manual',
  'alat pemeras santan kelapa manual',
  'alat pemisah kuning telur praktis',
  'alat penusuk daging tenderizer empuk',
  'sendok porsi es krim scoop trigger',
  'alat pelubang kelapa muda stainless',

  // Knives, Shears, Openers & Sharpeners
  'pisau dapur stainless tajam',
  'pisau kupas buah sayur mini',
  'pisau roti kue gerigi stainless',
  'pisau daging mini cleaver dapur',
  'gunting dapur serbaguna stainless',
  'gunting tulang ayam unggas heavy duty',
  'gunting sayur daun bawang 5 lapis',
  'alat pengasah pisau praktis 3 tahap',
  'batu asah pisau dapur grit halus',
  'alat pembuka kaleng putar praktis',
  'alat pembuka tutup botol toples',

  // Spatulas, Tongs, Strainers & Mats
  'spatula silikon tahan panas food grade',
  'sutil silikon anti leleh anti gores',
  'capitan makanan gorengan silikon',
  'capitan gorengan stainless penjepit',
  'centong nasi anti lengket silikon',
  'sendok kuah sup sayur silikon',
  'irus kuah sayur stainless gagang kayu',
  'wadah tirisan cuci beras sayur',
  'wadah saringan minyak jelantah stainless',
  'saringan teh kopi stainless halus',
  'saringan tepung ayakan stainless',
  'tutup panci silikon anti tumpah boil over',
  'tatakan sutil tutup panci silikon',

  // Mini Tabletop Organizers, Dispensers & Sealers (Compact tabletop only - NO bulky racks)
  'botol minyak goreng kuas silikon 2 in 1',
  'botol spray semprot minyak goreng',
  'wadah bumbu dapur 4 sekat sendok',
  'dispenser bumbu dapur putar',
  'dispenser minyak kecap saus kaca',
  'kotak telur roll otomatis slide',
  'dispenser sabun cuci piring tekan spons',
  'tutup silikon stretch penutup makanan',
  'penjepit kantong plastik snack kedap udara',
  'alat sealer plastik mini portable heat',

  // Baking, Dough & Specialty Snacks Makers
  'alat pembuat dumpling pastel manual',
  'cetakan pastel dumpling pangsit gyoza',
  'cetakan donat manual praktis',
  'cetakan sushi roll bazooka praktis',
  'cetakan onigiri bento segitiga',
  'cetakan martabak mini teflon',
  'cetakan pukis mini teflon anti lengket',
  'cetakan kue kering cookies biskuit',
  'alas silikon gilasan adonan kue baking mat',
  'rolling pin silikon adonan kue pastry',
  'whisk pengocok telur adonan manual stainless',
  'frother pengocok susu kopi mini elektrik',
  'timer dapur digital magnet masak',
  'timbangan digital dapur presisi gram',
  'termometer makanan digital masak daging',

  // Compact Cookware & Mini Gadgets
  'wajan mini 4 lubang teflon telur burger',
  'wajan tamagoyaki teflon kotak telur gulung',
  'panci listrik mini portable serbaguna',
  'panci kukus mini stainless serbaguna',
  'pemanggang sandwich toaster mini lipat',
  'alat pembuat waffle mini elektrik',
  'alat pembuat crepes mini pan elektrik',
  'silikon pot wadah air fryer anti lengket',
  'kertas baking air fryer alas loyang anti lengket',
  'pematik api kompor elektrik usb rechargeable',

  // Compact Kitchen Cleaning Tools
  'spons cuci piring nano antibakteri',
  'spons sabut kawat stainless anti gores',
  'sikat cuci piring dispenser sabun otomatis',
  'sikat pembersih botol tumbler sedotan set',
  'sikat pembersih blender mata pisau dapur',
  'kain lap microfiber dapur nano serat pembersih minyak',
  'alat pembersih kerak wajan panci gosong',
  'alat pengupas sisik ikan stainless wadah'
];

export const KITCHEN_VARIANTS = [
  'mini portable praktis',
  'multifungsi serbaguna',
  'manual putar cepat',
  'manual tarik praktis anti ribet',
  'elektrik rechargeable usb',
  'otomatis hemat waktu',
  'stainless steel food grade 304',
  'silikon food grade tahan panas anti leleh',
  'teflon anti lengket mudah dibersihkan',
  'ergonomis nyaman digenggam',
  'tebal kokoh awet tahan lama',
  'anti tumpah kedap udara rapat',
  'praktis mudah dicuci higienis',
  'estetik minimalis dapur modern',
  'model terbaru viral aesthetic',
  '3 in 1 multifungsi praktis',
  '4 in 1 serbaguna hemat ruang',
  '5 in 1 serbaguna komplit',
  '6 in 1 multifungsi komplit wadah',
  'hemat tempat ringkas dapur sempit',
  'compact gampang disimpan di laci',
  'travel friendly ringkas mudah dibawa',
  'mata pisau tajam presisi anti karat',
  'aman digunakan food grade bpa free',
  'bebas bpa bpa free higienis',
  'hemat minyak goreng sehat',
  'cepat halus merata hitungan detik',
  'tanpa listrik hemat daya manual',
  'gagang kayu tahan panas estetik',
  'tahan suhu panas tinggi oven kukus',
  'kapasitas mini pas masak porsi keluarga',
  'mudah dibongkar pasang dan dicuci',
  'dilengkapi wadah penampung transparan',
  'dua sisi bolak balik serbaguna',
  'roll otomatis sistem gravitasi praktis',
  'desain modern cantik dapur minimalis',
  'tekan otomatis sekali tekan praktis',
  'anti gores aman untuk wajan teflon',
  'tahan lama awet tidak mudah patah',
  'anti bocor anti tumpah presisi'
];

export const KITCHEN_TARGETS = [
  'untuk bumbu dapur bawang cabai',
  'untuk buah sayur segar harian',
  'untuk daging ayam sapi beku cincang',
  'untuk adonan kue roti donat nastar',
  'untuk kentang wortel mentimun labu',
  'untuk telur dadar telur gulung sarapan',
  'untuk sambal ulek praktis cepat',
  'untuk mpasi bayi anak balita sehat',
  'untuk bekal anak sekolah bento lucu',
  'untuk gorengan minyak panas renyah',
  'untuk kuah sop soto bakso hangat',
  'untuk kopi susu latte foam lembut',
  'untuk air fryer oven microwave',
  'untuk cuci beras buah sayuran tiris',
  'untuk botol tumbler sedotan blender',
  'untuk wajan panci teflon anti gores',
  'untuk jus buah smoothie segar sehat',
  'untuk dumpling pastel pangsit gyoza',
  'untuk sushi roll kimbap jepang',
  'untuk kentang goreng french fries renyah',
  'untuk keju parut kelapa coklat baking',
  'untuk minyak goreng kecap saus kecap',
  'untuk es batu higienis mudah lepas',
  'untuk snack makanan ringan sisa renyah',
  'untuk barbeque sate panggangan daging',
  'untuk baking kue kering pastry bolu',
  'untuk salad sayur buah diet sehat',
  'untuk dapur sempit anak kost praktis',
  'untuk masak cepat praktis harian rumah tangga',
  'untuk persiapan masak food prep mingguan'
];

export const KITCHEN_INTENT_MODIFIERS = [
  'viral tiktok',
  'shopee haul murah',
  'rekomendasi shopee termurah',
  'review alat dapur viral',
  'racun dapur viral estetik',
  'alat masak wajib punya ibu cerdas',
  'solusi masak praktis harian',
  'peralatan masak unik berfaedah',
  'alat dapur canggih viral',
  'peralatan dapur anak kost praktis',
  'rekomendasi ibu rumah tangga hemat',
  'alat dapur estetik murah kekinian',
  'alat dapur kekinian multifungsi',
  'rekomendasi kitchen hacks dapur',
  'alat dapur terbaik viral rating tinggi',
  'spill alat dapur murah awet viral',
  'perabot dapur mungil serbaguna praktis',
  'gadget dapur unik praktis kekinian',
  'perkakas dapur serbaguna viral',
  'peralatan dapur fungsional hemat ruang',
  'alat masak praktis hemat waktu tenaga',
  'alat masak anti ribet wajib punya',
  'peralatan masak serba guna praktis',
  'alat dapur simpel berkualitas awet',
  'alat bantu masak dapur wajib ada',
  'kitchen tool viral shopee termurah',
  'kitchen gadget praktis masa kini',
  'alat masak praktis rekomendasi chef',
  'barang unik dapur viral bermanfaat',
  'perlengkapan masak praktis serbaguna'
];

/**
 * Generates an unlimited stream of unique, authentic kitchen tool keywords
 * using combinatorial cross-product patterns, strictly avoiding any bulky items
 * or keywords in the excluded set.
 */
export function generateCombinatorialKitchenKeywords(limit = 1000, excludedSet = new Set()) {
  const resultSet = new Set();

  const patterns = [
    (tool, variant, target, mod) => `${tool} ${variant}`,
    (tool, variant, target, mod) => `${tool} ${target}`,
    (tool, variant, target, mod) => `${tool} ${mod}`,
    (tool, variant, target, mod) => `${tool} ${variant} ${mod}`,
    (tool, variant, target, mod) => `${tool} ${target} ${mod}`,
    (tool, variant, target, mod) => `${mod} ${tool} ${variant}`,
    (tool, variant, target, mod) => `${mod} ${tool}`,
  ];

  // Fisher-Yates shuffle clones of our arrays so each invocation produces unique orders
  const tools = [...KITCHEN_CORE_TOOLS];
  for (let i = tools.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tools[i], tools[j]] = [tools[j], tools[i]];
  }

  const variants = [...KITCHEN_VARIANTS];
  for (let i = variants.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [variants[i], variants[j]] = [variants[j], variants[i]];
  }

  const targets = [...KITCHEN_TARGETS];
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }

  const mods = [...KITCHEN_INTENT_MODIFIERS];
  for (let i = mods.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [mods[i], mods[j]] = [mods[j], mods[i]];
  }

  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const patternFn = patterns[pIdx];
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      for (let j = 0; j < variants.length; j++) {
        const variant = variants[j];
        const target = targets[(i + j) % targets.length];
        const mod = mods[(i * 3 + j) % mods.length];

        const candidate = patternFn(tool, variant, target, mod).trim();
        const norm = normalizeKeyword(candidate);

        if (!excludedSet.has(norm) && !resultSet.has(candidate)) {
          if (!isBulkyOrUnsuitableProduct(candidate)) {
            resultSet.add(candidate);
            if (resultSet.size >= limit) return Array.from(resultSet);
          }
        }
      }
    }
  }

  return Array.from(resultSet);
}

/**
 * Returns a randomized, expansive array of 1000+ unique kitchen tool keywords.
 * Automatically excludes any keywords or product titles that have already been generated/processed.
 */
export function getAutoKeywords(limit = 1000, { excludeUsed = true, shuffle = true } = {}) {
  const usedStore = loadUsedKeywords();
  const excludedSet = new Set();

  if (excludeUsed) {
    if (usedStore.keywords) {
      for (const k of Object.keys(usedStore.keywords)) {
        excludedSet.add(normalizeKeyword(k));
      }
    }
    if (usedStore.productTitles) {
      for (const t of Object.keys(usedStore.productTitles)) {
        excludedSet.add(normalizeKeyword(t));
      }
    }
  }

  const resultSet = new Set();

  // 1. First include any unused default curated keywords
  for (const kw of DEFAULT_AUTO_KEYWORDS) {
    const norm = normalizeKeyword(kw);
    if (!excludedSet.has(norm) && !isBulkyOrUnsuitableProduct(kw)) {
      resultSet.add(kw);
      if (resultSet.size >= limit) break;
    }
  }

  // 2. Dynamically synthesize remaining keywords from combinatorial kitchen matrix
  if (resultSet.size < limit) {
    const needed = limit - resultSet.size;
    const combinedExcluded = new Set([...excludedSet]);
    for (const item of resultSet) {
      combinedExcluded.add(normalizeKeyword(item));
    }
    const generated = generateCombinatorialKitchenKeywords(needed * 2, combinedExcluded);
    for (const g of generated) {
      resultSet.add(g);
      if (resultSet.size >= limit) break;
    }
  }

  let result = Array.from(resultSet);

  if (shuffle) {
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
  }

  return result.slice(0, limit);
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const insecureTlsAgent = new https.Agent({ rejectUnauthorized: false });

let cachedDdgIp = '20.43.161.105'; // Known Azure IP for DuckDuckGo
let lastDdgIpLookup = 0;

async function resolveDdgIp() {
  const now = Date.now();
  if (cachedDdgIp && now - lastDdgIpLookup < 3600000) {
    return cachedDdgIp;
  }
  try {
    const res = await fetch('https://dns.google/resolve?name=html.duckduckgo.com&type=A', {
      agent: insecureTlsAgent,
      timeout: 3000,
    });
    if (res.ok) {
      const json = await res.json();
      const ip = json?.Answer?.find((a) => a.type === 1)?.data;
      if (ip) {
        cachedDdgIp = ip;
        lastDdgIpLookup = now;
        return ip;
      }
    }
  } catch {
    // Keep fallback IP
  }
  return cachedDdgIp;
}

function formatKeywordToProductTitle(keyword) {
  if (!keyword) return 'Alat Dapur Praktis Viral';
  return keyword
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export async function discoverSingleShopeeProduct(keyword, seen = new Set()) {
  try {
    const results = (await searchDuckDuckGoShopee(keyword)).filter(r => !seen.has(r.url));
    results.forEach(r => seen.add(r.url));

    if (results.length > 0) {
      const batch = results.slice(0, 3);
      const metas = await Promise.allSettled(batch.map(r => fetchShopeePageMeta(r.url)));

      for (let i = 0; i < batch.length; i++) {
        const result = batch[i];
        const pageMeta = metas[i].status === 'fulfilled' ? metas[i].value : {};

        const rawTitle = pageMeta.title || result.title || '';
        let titleCandidate = cleanTitle(rawTitle, result.url);
        if (!titleCandidate || isGenericShopeeTitle(titleCandidate)) {
          titleCandidate = formatKeywordToProductTitle(keyword);
        }
        const descCandidate = cleanDescription(pageMeta.description || result.snippet || '') || `Produk alat dapur praktis: ${titleCandidate}.`;

        if (isBulkyOrUnsuitableProduct(titleCandidate) || isBulkyOrUnsuitableProduct(descCandidate) || isBulkyOrUnsuitableProduct(keyword)) {
          continue;
        }

        return {
          keyword,
          title: titleCandidate,
          description: descCandidate,
          url: result.url,
        };
      }
    }
  } catch (err) {
    console.warn(`[Discovery] Search engine lookup failed for "${keyword}":`, err.message);
  }

  // Instant Resilient Fallback: If Brave/Google/DuckDuckGo throw 429 or are blocked,
  // directly generate a clean Shopee product candidate from our curated viral keyword list.
  // This guarantees 0-second lag and completely bypasses 429 rate limit errors!
  const formattedTitle = formatKeywordToProductTitle(keyword);
  const shopeeUrl = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;
  
  if (seen.has(shopeeUrl)) return null;
  seen.add(shopeeUrl);

  return {
    keyword,
    title: formattedTitle,
    description: `Produk alat dapur praktis: ${formattedTitle}. Kualitas terjamin, multifungsi dan sangat cocok untuk kebutuhan masak sehari-hari.`,
    url: shopeeUrl,
  };
}

export async function discoverShopeeProducts({
  keywords = DEFAULT_AUTO_KEYWORDS,
  limit = 5,
  onProgress = () => {},
} = {}) {
  const products = [];
  const seen = new Set();
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));

  const candidateKeywords = [...keywords];
  for (let i = candidateKeywords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidateKeywords[i], candidateKeywords[j]] = [candidateKeywords[j], candidateKeywords[i]];
  }

  for (const keyword of candidateKeywords) {
    if (products.length >= safeLimit) break;

    onProgress({
      step: 'auto_shopee_search',
      message: `Cari produk (${products.length + 1}/${safeLimit}): "${keyword}"...`,
      progress: Math.min(18, 4 + Math.floor((products.length / safeLimit) * 14)),
    });

    const product = await discoverSingleShopeeProduct(keyword, seen);
    if (product) {
      products.push(product);
    }

    if (products.length < safeLimit) {
      await delayWithJitter(400, 800);
    }
  }

  return products;
}

export async function discoverYouTubeCandidatesForProduct({
  productTitle,
  productDescription = '',
  limit = 10,
  excludeVideoIds = new Set(),
  searchIteration = 0,
  onProgress = () => {},
} = {}) {
  const excludeSet = excludeVideoIds instanceof Set ? excludeVideoIds : new Set(excludeVideoIds || []);
  const productInfo = extractCoreProductInfo(productTitle, productDescription);
  const coreNoun = productInfo.coreProductNoun || cleanTitle(productTitle) || 'Produk';
  const coreWords = productInfo.coreWords || [];

  // Dynamic search query candidate sets from productInfo (high-intent, zero promo-spam)
  const baseQueryCandidates = productInfo.searchQueries;

  // Rotate query order based on searchIteration so consecutive auto retry attempts hit fresh queries first
  const offset = searchIteration % baseQueryCandidates.length;
  const queryCandidates = [...baseQueryCandidates.slice(offset), ...baseQueryCandidates.slice(0, offset)];

  let candidates = [];
  let usedQuery = queryCandidates[0];

  for (const query of queryCandidates) {
    const rawResults = await searchYouTubeVideos(query, { limit, onProgress });
    if (rawResults && rawResults.length) {
      // 1. Filter out videos that have already been processed in past or current jobs
      const freshResults = rawResults.filter((c) => {
        const vid = c.id || extractVideoId(c.url);
        return vid && !excludeSet.has(vid);
      });

      // 2. Only accept if the query produced compliant candidate(s) (5-15 min, faceless, multi-word matching)
      const cleanResults = freshResults.filter((c) => isLikelyCleanYouTubeCandidate(c, coreWords));

      if (cleanResults.length > 0) {
        candidates = cleanResults;
        usedQuery = query;
        break;
      }
    }
    await delayWithJitter(300, 600);
  }

  // Fallback: If all results were previously used or cleanResults was empty, search exact core noun
  if (!candidates.length) {
    const fallbackResults = await searchYouTubeVideos(`${coreNoun} review`, { limit, onProgress });
    const nonExcluded = (fallbackResults || []).filter((c) => {
      const vid = c.id || extractVideoId(c.url);
      return vid && !excludeSet.has(vid) && isLikelyCleanYouTubeCandidate(c, coreWords);
    });
    candidates = nonExcluded;
  }

  const cleanCandidates = candidates
    .filter((candidate) => isLikelyCleanYouTubeCandidate(candidate, coreWords))
    .map((candidate) => ({
      ...candidate,
      searchQuery: usedQuery,
      coreProductNoun: coreNoun,
      matchScore: scoreCandidateMatch(candidate, coreWords, productDescription),
    }))
    .filter((candidate) => candidate.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);

  // Return strictly vetted, compliant candidates (5-15 min, clean content); NEVER leak disqualified raw candidates
  return cleanCandidates;
}

export function delayWithJitter(minMs, maxMs) {
  const min = Number(minMs) || 0;
  const max = Math.max(min, Number(maxMs) || min);
  const duration = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function searchDuckDuckGoShopee(keyword) {
  const cleanKeyword = String(keyword || '').replace(/\s+/g, ' ').trim();
  // Target real kitchen tools Shopee products
  const searchQueries = [
    `"${cleanKeyword}" alat dapur site:shopee.co.id`,
    `${cleanKeyword} alat dapur site:shopee.co.id`,
    `"${cleanKeyword}" site:shopee.co.id`,
  ];

  const ddgIp = await resolveDdgIp();
  const ddgAgent = new https.Agent({
    rejectUnauthorized: false,
    servername: 'html.duckduckgo.com',
  });

  for (const searchQuery of searchQueries) {
    try {
      const url = `https://${ddgIp}/html/?q=${encodeURIComponent(searchQuery)}`;
      const response = await fetch(url, {
        agent: ddgAgent,
        timeout: 4500,
        headers: {
          'Host': 'html.duckduckgo.com',
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response || !response.ok) continue;

      const html = await response.text();
      if (html.includes('internetbaik.telkomsel.com') || html.includes('blocked')) continue;

      const $ = cheerio.load(html);
      const results = [];

      $('.result').each((_, element) => {
        const anchor = $(element).find('a.result__a').first();
        const rawHref = anchor.attr('href');
        const productUrl = normalizeSearchResultUrl(rawHref);
        if (!isShopeeProductUrl(productUrl)) return;

        results.push({
          title: anchor.text().trim(),
          snippet: $(element).find('.result__snippet').text().trim(),
          url: productUrl,
        });
      });

      if (results.length > 0) {
        return dedupeByUrl(results);
      }
    } catch {
      // Continue to next query / search engine
    }
  }

  return searchBraveShopee(keyword);
}

async function searchBraveShopee(keyword) {
  for (const searchQuery of buildShopeeSearchQueries(keyword).slice(0, 1)) {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(searchQuery)}`;
    try {
      const response = await fetchWithTlsFallback(url, {
        timeoutMs: 2500,
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response || !response.ok) {
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const results = [];

      $('a').each((_, element) => {
        const productUrl = normalizeSearchResultUrl($(element).attr('href'));
        if (!isShopeeProductUrl(productUrl)) return;

        results.push({
          title: $(element).text().trim(),
          snippet: $(element).closest('[data-type="web"]').text().trim(),
          url: productUrl,
        });
      });

      const deduped = dedupeByUrl(results);
      if (deduped.length) return deduped;
    } catch {
      continue;
    }
  }

  return searchBingShopee(keyword);
}

async function searchBingShopee(keyword) {
  for (const searchQuery of buildShopeeSearchQueries(keyword)) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}`;
    try {
      const response = await fetchWithTlsFallback(url, {
        timeoutMs: 3000,
        headers: {
          'user-agent': USER_AGENT,
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response || !response.ok) {
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const results = [];

      $('li.b_algo').each((_, element) => {
        const anchor = $(element).find('h2 a').first();
        const productUrl = normalizeSearchResultUrl(anchor.attr('href'));
        if (!isShopeeProductUrl(productUrl)) return;

        results.push({
          title: anchor.text().trim(),
          snippet: $(element).find('.b_caption p').first().text().trim(),
          url: productUrl,
        });
      });

      const deduped = dedupeByUrl(results);
      if (deduped.length) return deduped;
    } catch {
      continue;
    }
  }

  return [];
}

async function fetchShopeePageMeta(url) {
  try {
    const response = await fetchWithTlsFallback(url, {
      timeoutMs: 3000,
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!response || !response.ok) return {};

    const html = await response.text();
    const $ = cheerio.load(html);
    return {
      title: $('meta[property="og:title"]').attr('content') || $('title').text(),
      description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'),
    };
  } catch {
    return {};
  }
}

async function fetchWithTlsFallback(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const cleanOptions = { ...options };
    delete cleanOptions.timeoutMs;
    const response = await fetch(url, {
      agent: insecureTlsAgent,
      ...cleanOptions,
      signal: cleanOptions.signal || controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function normalizeSearchResultUrl(rawHref) {
  if (!rawHref) return '';

  try {
    const parsed = new URL(rawHref, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    const bingTarget = decodeBingRedirect(parsed.searchParams.get('u'));
    const target = redirected ? new URL(redirected) : bingTarget ? new URL(bingTarget) : parsed;
    target.hash = '';
    target.search = '';
    return target.toString();
  } catch {
    return '';
  }
}

function decodeBingRedirect(value) {
  if (!value) return '';
  try {
    const normalized = value.startsWith('a1') ? value.slice(2) : value;
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function buildShopeeSearchQueries(keyword) {
  const cleanKeyword = keyword.replace(/\s+/g, ' ').trim();
  return [
    `site:shopee.co.id ${cleanKeyword} "i."`,
    `site:shopee.co.id/ ${cleanKeyword}`,
    `site:shopee.co.id ${cleanKeyword}`,
    `"shopee.co.id" ${cleanKeyword}`,
  ];
}

export function isShopeeProductUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'shope.ee' || host === 's.shopee.co.id') return true;
    if (host !== 'shopee.co.id') return false;
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (['/search', '/mall', '/buyer', '/cart', '/list', '/flash_sale'].some((prefix) => path.startsWith(prefix))) return false;
    if (/\/shop\/?\d*/.test(path)) return false;
    return path.includes('/product/') || /-i\.\d+\.\d+/.test(path) || /\.\d+\.\d+/.test(path);
  } catch {
    return false;
  }
}

export function extractShopeeLinkFromText(text = '') {
  if (!text || typeof text !== 'string') return '';
  const match = text.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?(?:shopee\.co\.id|shope\.ee|s\.shopee\.co\.id)\/[^\s"'>\)]+/i);
  if (match) {
    let url = match[0].trim();
    url = url.replace(/[.,;!?]+$/, '');
    return url;
  }
  return '';
}

export function isLikelyCleanYouTubeCandidate(candidate, productWords = []) {
  if (!candidate.url || !candidate.id) return false;
  // If duration is known, reject if too short (< 5 min / 300s) or too long (> 15 min / 900s)
  if (candidate.duration > 0 && (candidate.duration < 300 || candidate.duration > 900)) return false;

  const titleText = normalizeText(candidate.title || '');
  if (isBulkyOrUnsuitableProduct(titleText)) return false;

  const excludedTitleWords = [
    'podcast', 'reaction', 'kompilasi', 'compilation', 'kumpulan', 'full album', 'playlist',
    'vlog', 'daily vlog', 'a day in my life', 'cerita', 'bincang', 'talkshow', 'ngobrol',
    'cara belanja', 'cara checkout', 'daftar akun', 'tutorial aplikasi', 'cara jualan', 'cara live',
    'shopee affiliate tutorial', 'aplikasi shopee',
    // Creator/face-centric and person-focused videos
    'muka', 'wajah', 'facecam', 'webcam', 'selfie', 'grwm', 'get ready with me',
    'try on haul', 'try on', 'outfit', 'ootd', 'mukbang', 'skincare routine', 'makeup tutorial',
    // Subtitle & lyric indicators (wajib dihindari agar tidak tabrakan subtitle)
    'sub indo', 'subtitle', 'subtitles', 'sub english', 'eng sub', 'terjemahan', 'lirik',
    // Social media re-uploads & watermark indicators (wajib bersih tanpa logo sosmed/watermark)
    'tiktok', 'douyin', 'kuaishou', 'capcut', 'repost', 'watermark', 'shorts tiktok', 'video tiktok', 'vt tiktok',
    // Compilation / multi-product videos (cause mismatch with single Shopee link)
    'top 10', 'top 5', 'top 7', 'top 3', '5 alat', '10 alat', '7 alat', 'rekomendasi barang',
    'racun shopee haul', 'haul shopee', 'haul tiktok', 'unboxing haul', 'berbagai alat', 'kumpulan gadget',
    // Filter AI-generated, synthetic, and cartoon/3D animation
    'ai generated', 'ai video', 'generative ai', 'sora', 'runway', 'kling', 'hailuo', 'pika',
    'animation', 'animasi', '3d animation', 'cgi', 'cartoon', 'kartun', 'anime'
  ];
  if (excludedTitleWords.some((keyword) => titleText.includes(keyword))) return false;

  // Flexible check: Candidate title, description, or tags MUST match core product keywords with cross-category exclusion
  if (Array.isArray(productWords) && productWords.length > 0) {
    if (!isTitleMatchingProduct(candidate.title, productWords, { description: candidate.description, tags: candidate.tags })) {
      return false;
    }
  }

  return true;
}

export function scoreCandidateMatch(candidate, productWords, productDescription) {
  const titleText = normalizeText(candidate.title || '');
  const descText = normalizeText(candidate.description || '');
  const fullText = `${titleText} ${descText}`;

  // Prioritize title hits over description to guarantee exact product alignment
  const titleHits = productWords.filter((word) => titleText.includes(word)).length;
  const fullHits = productWords.filter((word) => fullText.includes(word)).length;

  const desc = normalizeText(productDescription);
  const descHits = desc
    .split(' ')
    .filter((word) => word.length >= 5)
    .filter((word) => fullText.includes(word))
    .slice(0, 5).length;

  return (titleHits * 3) + fullHits + (descHits * 0.5);
}

function dedupeByUrl(results) {
  const seen = new Set();
  return results.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

export function isGenericShopeeTitle(title = '') {
  const norm = normalizeText(title);
  if (!norm || norm.length < 4) return true;
  const genericPatterns = [
    'shopee indonesia',
    'situs belanja online',
    'terlengkap terpercaya',
    'jual beli online',
    'pusat perbelanjaan',
    'online shopping',
    'shopee co id',
    'marketplace',
  ];
  return genericPatterns.some((pattern) => norm.includes(pattern));
}

export function cleanTitle(value = '', productUrl = '') {
  let cleaned = String(value || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:cod|promo|murah|diskon|ori|import|garansi)[^)]*\)/gi, ' ')
    .replace(/[【】〔〕〖〗（）]/g, ' ')
    .replace(/(?:🛒|🔥|⭐|💥|⚡|✨|🏆|🎉|👍|✅|📢|🔴|▶️)/gu, ' ')
    .replace(/\s*\|\s*Shopee.*$/i, '')
    .replace(/\s*-\s*Shopee.*$/i, '')
    .replace(/^Shopee\s*(Indonesia)?\s*[:|–-]?\s*/i, '')
    .replace(/\b(?:cod|bisa cod|bayar di tempat|ready stock|ready|promo|diskon|murah|termurah|terlaris|terbaru|terlengkap|original|ori|asli|import|impor|100% original|official store|hot sale|flash sale|best seller|viral|viral tiktok|gratis ongkir|free ongkir|hemat|garansi resmi|garansi \d+ tahun)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  if (cleaned && !isGenericShopeeTitle(cleaned)) return cleaned;
  
  const fromUrl = titleFromShopeeUrl(productUrl);
  if (fromUrl && !isGenericShopeeTitle(fromUrl)) return fromUrl;

  return '';
}

export const PRODUCT_ANCHORS = [
  // 1. Kitchen Prep, Choppers & Cutters
  {
    pattern: /\b(?:chopper\s+(?:mini|elektrik|portable|tarik|wireless)|food\s+chopper|blender\s+mini|blender\s+kapsul|mini\s+cutter)\b/i,
    noun: 'Chopper Mini Elektrik',
    englishNoun: 'Mini Electric Food Chopper',
    category: 'kitchen_prep',
    core: ['chopper', 'mini'],
    multilingual: ['chopper', 'mini', 'blender', 'food chopper', 'garlic chopper', 'meat grinder', 'mincer', 'pelumat', 'gilingan', '绞肉机', '蒜泥器', 'máy xay', 'cối xay', 'เครื่องบด', 'เครื่องสับ']
  },
  {
    pattern: /\b(?:gunting\s+dapur|gunting\s+sk5|gunting\s+tulang|kitchen\s+shears)\b/i,
    noun: 'Gunting Dapur SK5',
    englishNoun: 'SK5 Kitchen Shears',
    category: 'kitchen_prep',
    core: ['gunting', 'dapur'],
    multilingual: ['gunting', 'shears', 'scissors', 'kitchen shears', 'poultry shears', 'sk5', 'kitchen scissors', 'gunting dapur', '厨房剪', '剪刀', 'kéo nhà bếp', 'kéo cắt gà', 'กรรไกรครัว', 'กรรไกรตัดอาหาร']
  },
  {
    pattern: /\b(?:mandoline\s+slicer|pemotong\s+sayur|parutan\s+multifungsi|parutan\s+serbaguna|parutan\s+6\s*in\s*1)\b/i,
    noun: 'Pemotong Sayur Multifungsi',
    englishNoun: 'Multifunctional Mandoline Slicer',
    category: 'kitchen_prep',
    core: ['pemotong', 'sayur'],
    multilingual: ['mandoline', 'slicer', 'grater', 'shredder', 'cutter', 'pemotong', 'parutan', 'pengiris', 'serutan', '切菜器', '擦丝器', '刨丝器', 'máy cắt rau', 'bào rau', 'nạo rau', 'ที่สไลด์ผัก', 'เครื่องหั่นผัก', 'ที่ขูดผัก']
  },
  {
    pattern: /\b(?:pengupas\s+buah|peeler\s+buah|pengupas\s+kulit|pisau\s+peeler)\b/i,
    noun: 'Alat Pengupas Buah Praktis',
    englishNoun: 'Fruit Peeler',
    category: 'kitchen_prep',
    core: ['pengupas', 'buah'],
    multilingual: ['peeler', 'pengupas', 'kupas', 'parer', 'skin remover', 'fruit peeler', 'apple peeler', 'rotary peeler', '削皮器', '削皮刀', '刨皮刀', 'dao gọt', 'nạo vỏ', 'ที่ปอกผลไม้', 'มีดปอกเปลือก', 'pambalat']
  },
  {
    pattern: /\b(?:pemeras\s+jeruk|pemeras\s+lemon|citrus\s+squeezer|perasan\s+jeruk)\b/i,
    noun: 'Alat Pemeras Jeruk Manual',
    englishNoun: 'Manual Citrus Juicer Squeezer',
    category: 'kitchen_prep',
    core: ['pemeras', 'jeruk'],
    multilingual: ['squeezer', 'juicer', 'pemeras', 'perasan', 'lemon squeezer', 'citrus squeezer', 'orange juicer', 'hand juicer', '压汁机', '榨汁器', 'vắt cam', 'ép cam', 'ép chanh', 'ที่คั้นน้ำส้ม', 'ที่บีบมะนาว', 'pigaan']
  },
  {
    pattern: /\b(?:pemotong\s+semangka|pemotong\s+melon|watermelon\s+slicer)\b/i,
    noun: 'Pemotong Semangka Praktis',
    englishNoun: 'Watermelon Slicer Cutter',
    category: 'kitchen_prep',
    core: ['pemotong', 'semangka'],
    multilingual: ['watermelon slicer', 'melon slicer', 'pemotong semangka', 'semangka', 'watermelon cutter', '切西瓜器', 'cắt dưa hấu', 'ที่ตัดแตงโม', 'ที่หั่นแตงโม']
  },
  {
    pattern: /\b(?:pelumat\s+bawang|press\s+garlic|penghancur\s+bawang|garlic\s+press)\b/i,
    noun: 'Alat Pelumat Bawang Putih',
    englishNoun: 'Garlic Press Crusher',
    category: 'kitchen_prep',
    core: ['bawang', 'garlic'],
    multilingual: ['garlic press', 'garlic crusher', 'garlic mincer', 'bawang', 'garlic', 'pelumat bawang', 'penghancur bawang', '压蒜器', '蒜泥器', 'kẹp tỏi', 'nghiền tỏi', 'ép tỏi', 'ที่บดกระเทียม', 'ที่กดกระเทียม', 'pandurog ng bawang']
  },
  {
    pattern: /\b(?:cetakan\s+bakso|pembuat\s+bakso|meatball\s+maker)\b/i,
    noun: 'Cetakan Bakso Manual Praktis',
    englishNoun: 'Meatball Maker Spoon Mold',
    category: 'kitchen_prep',
    core: ['cetakan', 'bakso'],
    multilingual: ['meatball maker', 'meatball mold', 'cetakan bakso', 'pembuat bakso', 'bakso', 'meatball spoon', '肉丸器', '丸子模具', 'khuôn làm thịt viên', 'แม่พิมพ์ทำลูกชิ้น', 'ที่ทำลูกชิ้น']
  },
  {
    pattern: /\b(?:pemotong\s+daging\s+beku|meat\s+slicer\s+manual|pengiris\s+daging)\b/i,
    noun: 'Alat Pengiris Daging Manual',
    englishNoun: 'Manual Frozen Meat Slicer',
    category: 'kitchen_prep',
    core: ['pengiris', 'daging'],
    multilingual: ['meat slicer', 'frozen meat', 'pengiris daging', 'pemotong daging', 'meat cutter', 'slicer manual', '切肉机', '切片机', 'máy cắt thịt', 'thái thịt', 'เครื่องสไลด์เนื้อ', 'ที่สไลด์เนื้อ']
  },
  {
    pattern: /\b(?:pembuat\s+dumpling|cetakan\s+pastel|dumpling\s+maker)\b/i,
    noun: 'Alat Pembuat Dumpling Pastel',
    englishNoun: 'Dumpling Maker Mold Press',
    category: 'kitchen_prep',
    core: ['dumpling', 'pastel'],
    multilingual: ['dumpling maker', 'dumpling press', 'empanada maker', 'cetakan dumpling', 'pembuat pastel', 'cetakan pastel', 'dumpling', 'pastel', '包饺子神器', '饺子模具', 'khuôn làm sủi cảo', 'khuôn bánh bao', 'ที่ทำเกี๊ยว', 'แม่พิมพ์เกี๊ยว']
  },
  {
    pattern: /\b(?:sealer\s+plastik|perekat\s+plastik|heat\s+sealer|mini\s+sealer)\b/i,
    noun: 'Sealer Plastik Mini Portable',
    englishNoun: 'Mini Bag Heat Sealer',
    category: 'kitchen_prep',
    core: ['sealer', 'plastik'],
    multilingual: ['sealer', 'heat sealer', 'bag sealer', 'plastic sealer', 'mini sealer', 'perekat plastik', 'sealer plastik', 'press plastik', '封口机', 'máy hàn miệng túi', 'เครื่องซีลถุง', 'ที่ซีลถุง']
  },
  {
    pattern: /\b(?:pengasah\s+pisau|knife\s+sharpener|asah\s+pisau)\b/i,
    noun: 'Alat Pengasah Pisau Praktis',
    englishNoun: 'Kitchen Knife Sharpener',
    category: 'kitchen_prep',
    core: ['pengasah', 'pisau'],
    multilingual: ['knife sharpener', 'blade sharpener', 'sharpening', 'whetstone', 'pengasah pisau', 'asah pisau', 'asahan pisau', '磨刀器', '磨刀石', 'dụng cụ mài dao', 'mài dao', 'ที่ลับมีด', 'เครื่องลับมีด']
  },
  {
    pattern: /\b(?:timbangan\s+digital|kitchen\s+scale|timbangan\s+dapur)\b/i,
    noun: 'Timbangan Dapur Digital',
    englishNoun: 'Digital Kitchen Food Scale',
    category: 'kitchen_prep',
    core: ['timbangan', 'digital'],
    multilingual: ['kitchen scale', 'digital scale', 'food scale', 'baking scale', 'timbangan dapur', 'timbangan digital', 'timbangan', '厨房秤', '电子秤', 'cân điện tử', 'cân tiểu ly', 'ตาชั่งดิจิตอล', 'เครื่องชั่งดิจิตอล']
  },
  {
    pattern: /\b(?:timer\s+dapur|kitchen\s+timer)\b/i,
    noun: 'Timer Dapur Digital Magnetik',
    englishNoun: 'Digital Kitchen Timer',
    category: 'kitchen_prep',
    core: ['timer', 'dapur'],
    multilingual: ['kitchen timer', 'cooking timer', 'digital timer', 'timer dapur', 'timer digital', '厨房定时器', 'đồng hồ hẹn giờ', 'นาฬิกาจับเวลาในครัว']
  },
  {
    pattern: /\b(?:frother|pengocok\s+susu|pengocok\s+telur\s+mini|milk\s+frother)\b/i,
    noun: 'Frother Pengocok Susu Mini',
    englishNoun: 'Handheld Milk Frother Whisk',
    category: 'kitchen_prep',
    core: ['frother', 'pengocok'],
    multilingual: ['milk frother', 'frother', 'hand frother', 'whisk', 'egg beater', 'pengocok susu', 'pengocok telur', 'mixer mini', '奶泡机', '打蛋器', 'máy tạo bọt sữa', 'đánh trứng', 'ที่ตีฟองนม', 'ที่ตีไข่']
  },
  {
    pattern: /\b(?:hand\s+mixer|mixer\s+tangan\s+mini|mixer\s+portable)\b/i,
    noun: 'Mixer Tangan Mini Portable',
    englishNoun: 'Portable Hand Mixer',
    category: 'kitchen_prep',
    core: ['mixer', 'mini'],
    multilingual: ['hand mixer', 'portable mixer', 'cordless mixer', 'mixer tangan', 'mixer mini', 'mixer', '无线打蛋器', 'máy đánh trứng mini', 'เครื่องผสมอาหารมือถือ']
  },
  {
    pattern: /\b(?:pemotong\s+kentang|potato\s+cutter|french\s+fries\s+cutter|kentang\s+spiral)\b/i,
    noun: 'Alat Pemotong Kentang Praktis',
    englishNoun: 'French Fry Potato Cutter',
    category: 'kitchen_prep',
    core: ['pemotong', 'kentang'],
    multilingual: ['potato cutter', 'french fry cutter', 'potato slicer', 'pemotong kentang', 'kentang spiral', 'french fries', '切薯条器', '切土豆条', 'máy cắt khoai tây', 'ที่หั่นมันฝรั่ง', 'ที่ตัดเฟรนช์ฟรายส์']
  },
  {
    pattern: /\b(?:serut\s+jagung|pemipil\s+jagung|corn\s+stripper)\b/i,
    noun: 'Alat Pemipil Jagung Serbaguna',
    englishNoun: 'Corn Stripper Peeler Thresher',
    category: 'kitchen_prep',
    core: ['serut', 'jagung'],
    multilingual: ['corn stripper', 'corn peeler', 'corn thresher', 'corn kernel remover', 'pemipil jagung', 'serut jagung', 'kupas jagung', '玉米剥粒器', 'tách hạt bắp', 'nạo ngô', 'ที่ฝานข้าวโพด', 'ที่แกะเมล็ดข้าวโพด']
  },
  {
    pattern: /\b(?:parutan\s+keju|cheese\s+grater|parutan\s+kelapa)\b/i,
    noun: 'Parutan Keju Kelapa Stainless',
    englishNoun: 'Stainless Steel Cheese Grater',
    category: 'kitchen_prep',
    core: ['parutan', 'keju'],
    multilingual: ['cheese grater', 'grater', 'zester', 'parutan keju', 'parutan kelapa', 'parutan stainless', '芝士擦丝器', '奶酪刨', 'bào phô mai', 'nạo phô mai', 'ที่ขูดชีส', 'ที่ขูดเนย']
  },
  {
    pattern: /\b(?:pisau\s+dapur|chef\s+knife|pisau\s+stainless)\b/i,
    noun: 'Pisau Dapur Stainless Praktis',
    englishNoun: 'Kitchen Chef Knife Stainless',
    category: 'kitchen_prep',
    core: ['pisau', 'dapur'],
    multilingual: ['chef knife', 'kitchen knife', 'cleaver', 'santoku', 'pisau dapur', 'pisau stainless', 'pisau', '菜刀', '主厨刀', 'dao nhà bếp', 'dao bếp', 'มีดทำครัว', 'มีดเชฟ']
  },

  // 2. Cookware, Mini Cooking & Baking
  {
    pattern: /\b(?:panci\s+listrik|panci\s+elektrik|electric\s+(?:pot|cooker|pan|skillet)|multi\s+cooker\s+mini)\b/i,
    noun: 'Panci Listrik Mini Serbaguna',
    englishNoun: 'Mini Electric Hot Pot Cooker',
    category: 'cooking_pot',
    core: ['panci', 'listrik'],
    multilingual: ['electric pot', 'electric cooker', 'hot pot', 'electric skillet', 'multi cooker', 'panci listrik', 'panci elektrik', 'panci mini', '电热锅', '电煮锅', '小电锅', 'nồi lẩu điện mini', 'nồi điện đa năng', 'หม้อไฟฟ้ามินิ', 'หม้อต้มไฟฟ้า']
  },
  {
    pattern: /\b(?:wajan\s+telur\s+4|wajan\s+mini|frypan\s+mini|pan\s+4\s+lubang)\b/i,
    noun: 'Wajan Mini Telur 4 Lubang',
    englishNoun: '4 Hole Egg Frying Pan',
    category: 'cooking_pot',
    core: ['wajan', 'telur'],
    multilingual: ['egg frying pan', '4 hole pan', 'egg pan', 'pancake pan', 'wajan telur 4', 'wajan mini', 'pan 4 lubang', '四孔煎锅', '早餐锅', 'chảo 4 lỗ', 'chảo chiên trứng', 'กระทะ 4 หลุม', 'กระทะทอดไข่']
  },
  {
    pattern: /\b(?:tamagoyaki|telur\s+gulung|egg\s+roll\s+pan)\b/i,
    noun: 'Wajan Tamagoyaki Mini Anti Lengket',
    englishNoun: 'Japanese Tamagoyaki Omelette Pan',
    category: 'cooking_pot',
    core: ['wajan', 'tamagoyaki'],
    multilingual: ['tamagoyaki pan', 'egg roll pan', 'omelette pan', 'tamagoyaki', 'wajan tamagoyaki', 'telur gulung', '玉子烧锅', '蛋卷锅', 'chảo tamagoyaki', 'chảo cuộn trứng', 'กระทะไข่ม้วน']
  },
  {
    pattern: /\b(?:pembuat\s+waffle|waffle\s+maker|cetakan\s+waffle)\b/i,
    noun: 'Alat Pembuat Waffle Mini',
    englishNoun: 'Mini Waffle Maker Machine',
    category: 'cooking_pot',
    core: ['waffle', 'maker'],
    multilingual: ['waffle maker', 'waffle iron', 'mini waffle', 'pancake maker', 'pembuat waffle', 'cetakan waffle', 'waffle', '华夫饼机', 'máy làm bánh waffle', 'máy nướng waffle', 'เครื่องทำวาฟเฟิล']
  },
  {
    pattern: /\b(?:sutil\s+silikon|spatula\s+silikon|spatula\s+set|silicone\s+spatula)\b/i,
    noun: 'Sutil Silikon Set Tahan Panas',
    englishNoun: 'Silicone Cooking Utensils Spatula Set',
    category: 'cooking_pot',
    core: ['sutil', 'silikon'],
    multilingual: ['silicone spatula', 'spatula set', 'kitchen utensils', 'turner', 'sutil silikon', 'spatula silikon', 'sutil', 'spatula', '硅胶铲', '硅胶锅铲', 'xẻng silicon', 'bộ muỗng silicon', 'ตะหลิวซิลิโคน', 'พายซิลิโคน']
  },
  {
    pattern: /\b(?:cetakan\s+es\s+batu|ice\s+cube\s+tray|cetakan\s+es\s+silikon)\b/i,
    noun: 'Cetakan Es Batu Silikon',
    englishNoun: 'Silicone Ice Cube Tray Mold',
    category: 'cooking_pot',
    core: ['cetakan', 'batu'],
    multilingual: ['ice cube tray', 'ice mold', 'ice maker', 'ice tray', 'cetakan es batu', 'cetakan es silikon', 'es batu', '制冰盒', '硅胶冰格', 'khay làm đá', 'khuôn đá silicon', 'ถาดทำน้ำแข็ง', 'แม่พิมพ์น้ำแข็ง']
  },
  {
    pattern: /\b(?:pemanggang\s+sandwich|sandwich\s+maker|toaster\s+mini)\b/i,
    noun: 'Pemanggang Sandwich Mini Elektrik',
    englishNoun: 'Electric Sandwich Toaster Maker',
    category: 'cooking_pot',
    core: ['sandwich', 'pemanggang'],
    multilingual: ['sandwich maker', 'toaster', 'sandwich toaster', 'pemanggang sandwich', 'sandwich', 'pemanggang roti', '三明治机', '轻食机', 'máy nướng sandwich', 'kẹp bánh mì', 'เครื่องทำแซนด์วิช']
  },
  {
    pattern: /\b(?:cetakan\s+takoyaki|takoyaki\s+pan)\b/i,
    noun: 'Cetakan Takoyaki Mini',
    englishNoun: 'Takoyaki Pan Grill Maker',
    category: 'cooking_pot',
    core: ['cetakan', 'takoyaki'],
    multilingual: ['takoyaki pan', 'takoyaki maker', 'takoyaki grill', 'cetakan takoyaki', 'takoyaki', '章鱼烧机', '章鱼烧盘', 'chảo làm takoyaki', 'เตาทาโกะยากิ']
  },
  {
    pattern: /\b(?:pot\s+air\s+fryer|silikon\s+air\s+fryer|wadah\s+air\s+fryer)\b/i,
    noun: 'Wadah Silikon Air Fryer',
    englishNoun: 'Air Fryer Silicone Pot Liner Basket',
    category: 'cooking_pot',
    core: ['silikon', 'fryer'],
    multilingual: ['air fryer silicone', 'silicone pot', 'air fryer liner', 'air fryer basket', 'silikon air fryer', 'wadah air fryer', 'air fryer', '空气炸锅硅胶垫', 'khay silicon nồi chiên không dầu', 'แผ่นซิลิโคนหม้อทอดไร้น้ำมัน']
  },
  {
    pattern: /\b(?:termometer\s+makanan|cooking\s+thermometer)\b/i,
    noun: 'Termometer Makanan Digital',
    englishNoun: 'Digital Food Meat Cooking Thermometer',
    category: 'cooking_pot',
    core: ['termometer', 'makanan'],
    multilingual: ['food thermometer', 'meat thermometer', 'cooking thermometer', 'termometer makanan', 'termometer digital', '食品温度计', 'nhiệt kế nấu ăn', 'nhiệt kế thực phẩm', 'ที่วัดอุณหภูมิอาหาร']
  },
  {
    pattern: /\b(?:cetakan\s+sushi|sushi\s+bazooka|cetakan\s+onigiri)\b/i,
    noun: 'Cetakan Sushi Onigiri Praktis',
    englishNoun: 'Sushi Onigiri Maker Mold Roller',
    category: 'cooking_pot',
    core: ['cetakan', 'sushi'],
    multilingual: ['sushi maker', 'sushi mold', 'onigiri mold', 'sushi bazooka', 'cetakan sushi', 'cetakan onigiri', 'sushi', 'onigiri', '寿司模具', '饭团模具', 'khuôn làm sushi', 'khuôn cơm nắm', 'แม่พิมพ์ซูชิ', 'ที่ทำซูชิ']
  },
  {
    pattern: /\b(?:capitan\s+makanan|food\s+tongs|capitan\s+silikon)\b/i,
    noun: 'Capitan Makanan Silikon Stainless',
    englishNoun: 'Silicone Kitchen Food Tongs',
    category: 'cooking_pot',
    core: ['capitan', 'makanan'],
    multilingual: ['food tongs', 'kitchen tongs', 'cooking tongs', 'capitan makanan', 'capitan silikon', 'penjepit makanan', '食品夹', '硅胶食物夹', 'kẹp gắp thức ăn', 'ที่คีบอาหาร', 'ที่คีบซิลิโคน']
  },

  // 3. Compact Kitchen Containers, Dispensers & Tabletop Accessories
  {
    pattern: /\b(?:botol\s+minyak\s+kuas|botol\s+minyak|oil\s+dispenser|spray\s+minyak)\b/i,
    noun: 'Botol Minyak Kuas Silikon',
    englishNoun: 'Oil Bottle with Silicone Brush Sprayer',
    category: 'storage_organizer',
    core: ['botol', 'minyak'],
    multilingual: ['oil bottle', 'oil dispenser', 'oil sprayer', 'oil brush', 'botol minyak', 'spray minyak', 'kuas minyak', '喷油壶', '油刷瓶', 'chai đựng dầu', 'bình xịt dầu', 'ขวดน้ำมัน', 'ขวดสเปรย์น้ำมัน']
  },
  {
    pattern: /\b(?:tempat\s+bumbu\s+putar|kotak\s+bumbu\s+putar|wadah\s+bumbu\s+4\s*sekat)\b/i,
    noun: 'Tempat Bumbu Putar Dapur',
    englishNoun: 'Rotating Spice Rack Seasoning Organizer',
    category: 'storage_organizer',
    core: ['bumbu', 'putar'],
    multilingual: ['spice rack', 'rotating spice', 'seasoning organizer', 'tempat bumbu', 'wadah bumbu', 'bumbu putar', '旋转调料架', 'kệ gia vị xoay', 'hộp đựng gia vị', 'ชั้นวางเครื่องปรุงหมุนได้']
  },
  {
    pattern: /\b(?:dispenser\s+beras|tempat\s+beras|rice\s+dispenser|kotak\s+beras)\b/i,
    noun: 'Dispenser Beras Otomatis Mini',
    englishNoun: 'Automatic Rice Dispenser Storage Box',
    category: 'storage_organizer',
    core: ['dispenser', 'beras'],
    multilingual: ['rice dispenser', 'rice container', 'grain dispenser', 'dispenser beras', 'tempat beras', 'kotak beras', '米桶', '米箱', 'thùng đựng gạo', 'hộp đựng gạo thông minh', 'ถังเก็บข้าวสาร']
  },
  {
    pattern: /\b(?:wadah\s+telur|kotak\s+telur|rolling\s+egg)\b/i,
    noun: 'Wadah Telur Kulkas Otomatis',
    englishNoun: 'Automatic Rolling Egg Storage Holder',
    category: 'storage_organizer',
    core: ['wadah', 'telur'],
    multilingual: ['egg holder', 'rolling egg', 'egg dispenser', 'egg storage', 'wadah telur', 'kotak telur', 'rak telur', '滚蛋器', '鸡蛋收纳盒', 'khay đựng trứng', 'hộp đựng trứng lăn', 'ที่เก็บไข่', 'กล่องใส่ไข่']
  },
  {
    pattern: /\b(?:tutup\s+makanan\s+silikon|silicone\s+stretch\s+lid)\b/i,
    noun: 'Tutup Makanan Silikon Stretch',
    englishNoun: 'Silicone Stretch Lids Reusable Bowl Covers',
    category: 'storage_organizer',
    core: ['tutup', 'silikon'],
    multilingual: ['silicone stretch lids', 'bowl covers', 'food covers', 'silicone lids', 'tutup silikon', 'penutup makanan', 'silikon stretch', '硅胶保鲜盖', 'nắp đậy silicon', 'màng bọc thực phẩm silicon', 'ฝาซิลิโคนถนอมอาหาร']
  },
  {
    pattern: /\b(?:tirisan\s+beras|wadah\s+cuci|cuci\s+beras|drain\s+basket)\b/i,
    noun: 'Wadah Tirisan Cuci Beras Sayur',
    englishNoun: 'Kitchen Washing Drain Basket Colander',
    category: 'storage_organizer',
    core: ['tirisan', 'beras'],
    multilingual: ['drain basket', 'washing bowl', 'colander', 'strainer bowl', 'tirisan beras', 'cuci beras', 'baskom tirisan', '沥水篮', '淘米器', 'rổ rửa rau', 'thau rửa gạo', 'กะละมังล้างผัก', 'ตะกร้าล้างผัก']
  },
  {
    pattern: /\b(?:wadah\s+minyak\s+jelantah|oil\s+pot\s+strainer|saringan\s+minyak)\b/i,
    noun: 'Wadah Saringan Minyak Jelantah',
    englishNoun: 'Stainless Steel Oil Strainer Pot',
    category: 'storage_organizer',
    core: ['minyak', 'jelantah'],
    multilingual: ['oil strainer', 'oil pot', 'oil filter pot', 'wadah minyak', 'saringan minyak', 'minyak jelantah', '滤油壶', 'ca lọc dầu', 'bình lọc dầu ăn', 'หม้อกรองน้ำมัน']
  },
  {
    pattern: /\b(?:dispenser\s+sabun\s+cuci\s+piring|soap\s+pump\s+sponge)\b/i,
    noun: 'Dispenser Sabun Cuci Piring Sponge',
    englishNoun: 'Kitchen Dish Soap Pump Dispenser with Sponge',
    category: 'storage_organizer',
    core: ['dispenser', 'sabun'],
    multilingual: ['soap pump', 'soap dispenser', 'sponge holder', 'dish soap', 'dispenser sabun', 'tempat sabun', 'sabun cuci piring', '皂液盒', '洗碗按压器', 'hộp đựng nước rửa chén', 'กล่องกดน้ำยาล้างจาน']
  },
  {
    pattern: /\b(?:nano\s+magic\s+sponge|spons\s+nano|spons\s+cuci\s+piring)\b/i,
    noun: 'Spons Nano Cuci Piring Magic',
    englishNoun: 'Magic Melamine Nano Cleaning Sponge',
    category: 'storage_organizer',
    core: ['spons', 'nano'],
    multilingual: ['magic sponge', 'nano sponge', 'cleaning sponge', 'melamine sponge', 'spons nano', 'spons cuci piring', 'spons magic', '魔术海绵', '纳米海绵', 'miếng bọt biển nano', 'ฟองน้ำนาโน']
  },
];

export function extractCoreProductInfo(rawTitle = '', rawDesc = '', rawUrl = '') {
  const cleaned = cleanTitle(rawTitle, rawUrl) || String(rawTitle || '').trim();
  const normalized = normalizeText(cleaned);

  for (const anchor of PRODUCT_ANCHORS) {
    if (anchor.pattern.test(normalized)) {
      const allWords = Array.from(new Set([
        ...(anchor.core || []),
        ...(anchor.multilingual || []),
      ]));
      const englishNoun = anchor.englishNoun || anchor.noun;

      return {
        cleanTitle: cleaned,
        coreProductNoun: anchor.noun,
        englishNoun,
        category: anchor.category,
        coreWords: allWords,
        multilingualWords: allWords,
        searchQueries: [
          `${anchor.noun} review cara pakai`,
          `${englishNoun} demo review`,
          `${anchor.noun} demo peragaan`,
          `${englishNoun} unboxing test`,
          anchor.noun,
          englishNoun,
        ]
      };
    }
  }

  // Fallback: Smart token extraction from title
  const stopWords = [
    'dan', 'yang', 'untuk', 'dengan', 'dari', 'bisa', 'anti', 'super', 'termurah',
    'viral', 'original', 'promo', 'murah', 'ready', 'stock', 'import', 'impor',
    'terlaris', 'terbaru', 'terpercaya', 'kualitas', 'garansi', 'resmi', 'official',
    'bisa', 'cod', 'gratis', 'ongkir', 'diskon', 'terlengkap', 'store', 'shop', 'indonesia'
  ];
  const words = normalized.split(/\s+/).filter(w => w.length >= 3 && !stopWords.includes(w));
  const fallbackNoun = words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || cleaned.slice(0, 30) || 'Produk Praktis';
  const fallbackWords = words.slice(0, 3);

  return {
    cleanTitle: cleaned,
    coreProductNoun: fallbackNoun,
    category: 'general_gadget',
    coreWords: fallbackWords.length > 0 ? fallbackWords : ['produk'],
    multilingualWords: fallbackWords.length > 0 ? fallbackWords : ['produk'],
    searchQueries: [
      `${fallbackNoun} review cara pakai`,
      `${fallbackNoun} demo review`,
      `${fallbackNoun} test pemakaian`,
      `${fallbackNoun} unboxing`,
      fallbackNoun,
    ]
  };
}

export function isTitleMatchingProduct(candidateTitle, productWords = [], extraMeta = {}) {
  const normTitle = normalizeText(candidateTitle || '');
  const normDesc = normalizeText(extraMeta?.description || '').slice(0, 800);
  const normTags = Array.isArray(extraMeta?.tags)
    ? extraMeta.tags.map((t) => normalizeText(String(t))).join(' ')
    : '';
  const combinedText = `${normTitle} ${normDesc} ${normTags}`;

  // Cross-category exclusion for non-kitchen / automotive / phone / clothing / personal vlog
  const crossCategoryExclusions = [
    'las', 'pagar', 'bengkel', 'servis hp', 'servis motor', 'knalpot', 'mobil', 'motor', 'sepeda',
    'gameplay', 'game', 'manga', 'anime', 'vlog', 'skincare', 'makeup', 'gamis', 'hijab', 'outfit'
  ];

  if (crossCategoryExclusions.some((badWord) => normTitle.includes(badWord))) {
    return false;
  }

  if (!Array.isArray(productWords) || productWords.length === 0) return true;

  // Normalize common Indonesian/English affiliate product synonyms
  const synonymMap = {
    'elektrik': 'listrik',
    'electric': 'listrik',
    'peeler': 'pengupas',
    'slicer': 'pemotong',
    'mop': 'pel',
    'blender': 'chopper',
    'penggiling': 'chopper',
    'shears': 'gunting',
    'scale': 'timbangan',
    'juicer': 'pemeras',
  };

  let enrichedCombined = combinedText;
  for (const [syn, base] of Object.entries(synonymMap)) {
    if (enrichedCombined.includes(syn)) {
      enrichedCombined += ` ${base}`;
    }
  }

  // Check if at least ONE significant product keyword matches in combinedText
  for (const word of productWords) {
    const w = normalizeText(word);
    if (w.length >= 2 && enrichedCombined.includes(w)) {
      return true; // Match found!
    }
  }

  return false;
}

function titleFromShopeeUrl(productUrl = '') {
  try {
    const parsed = new URL(productUrl);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const slug = decodedPath.split('/').filter(Boolean).pop() || '';
    const titleSlug = slug.replace(/-i\.\d+\.\d+.*$/i, '').replace(/\.\d+\.\d+.*$/i, '');
    const formatted = titleSlug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return formatted;
  } catch {
    return '';
  }
}

function cleanDescription(value = '') {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeText(value = '') {
  return value.toString().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export async function findMatchingShopeeProductUrl(productTitle, detectedBrand = '', videoDesc = '') {
  if (!productTitle || typeof productTitle !== 'string') return '';
  const cleanTitleStr = cleanTitle(productTitle) || productTitle.trim();
  const brand = (detectedBrand && detectedBrand !== 'none' && !detectedBrand.includes('Terdeteksi')) ? detectedBrand.trim() : '';
  const searchPhrase = `${brand ? `${brand} ` : ''}${cleanTitleStr}`.trim();

  // 1. Direct match from YouTube video description if available
  const fromDesc = extractShopeeLinkFromText(videoDesc);
  if (fromDesc) {
    console.log(`[Discovery] ✅ Menemukan link Shopee langsung dari deskripsi video YouTube: ${fromDesc}`);
    return fromDesc;
  }

  console.log(`[Discovery] Mencari link Shopee yang cocok untuk produk video: "${searchPhrase}"...`);
  try {
    const results = await searchDuckDuckGoShopee(searchPhrase);
    if (results && results.length > 0) {
      const match = results.find(r => isShopeeProductUrl(r.url));
      if (match) {
        console.log(`[Discovery] ✅ Menemukan link Shopee cocok via DDG: "${match.title}" -> ${match.url}`);
        return match.url;
      }
    }
  } catch (err) {
    console.warn(`[Discovery] Gagal mencari link Shopee via DuckDuckGo:`, err.message);
  }

  // 2. Bing fallback
  try {
    const bingResults = await searchBingShopee(searchPhrase);
    if (bingResults && bingResults.length > 0) {
      const match = bingResults.find(r => isShopeeProductUrl(r.url));
      if (match) {
        console.log(`[Discovery] ✅ Menemukan link Shopee cocok via Bing: "${match.title}" -> ${match.url}`);
        return match.url;
      }
    }
  } catch (bingErr) {
    console.warn(`[Discovery] Gagal mencari link Shopee via Bing:`, bingErr.message);
  }

  // 3. Fallback: direct search page URL with refined kitchen tools keyword
  const fallbackUrl = `https://shopee.co.id/search?keyword=${encodeURIComponent(`${searchPhrase} alat dapur`)}`;
  console.log(`[Discovery] Menggunakan fallback link Shopee: ${fallbackUrl}`);
  return fallbackUrl;
}

