import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import https from 'https';
import { searchYouTubeVideos, extractVideoId, buildCleanYouTubeQuery, DIRTY_NEGATIVE_OPERATORS } from './downloader.js';
import { getNichePreset, generateCombinatorialGadgetKeywords } from '../config/nichePresets.js';

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
  'sendok tirisan penggorengan stainless serbaguna',
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
  'alat pembuka kaleng putar can opener praktis',
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
  'alat pelindung jari iris sayur stainless cutter guard',
  'alat pemotong nanas nenas spiral stainless',
  'alat pengupas kulit apel putar otomatis praktis',
  'alat pemeras jeruk perasan lemon stainless',
  'alat pemecah cangkang kepiting walnut stainless',
  'alat pelubang kelapa muda stainless praktis',
  'alat penusuk daging tenderizer empuk stainless',
  'alat pemotong pisang sosis praktis stainless',
  'pemotong mentimun spiral wortel slicer',

  // =========================================================================
  // 2. PERALATAN MASAK MINI, BAKING & GADGET KOMPOR (Mini Cooking & Baking)
  // =========================================================================
  'wajan penggorengan mini telur 4 lubang anti lengket',
  'panci listrik mini serbaguna portable',
  'alat pembuat waffle mini elektrik praktis',
  'sutil silikon anti panas food grade',
  'timbangan digital dapur mini presisi',
  'timer dapur digital magnetik masak',
  'saringan teh infuser stainless reusable praktis',
  'pematik api kompor gas elektrik usb recharge',
  'tatakan kompor gas pelindung api hemat gas',
  'splash guard pelindung cipratan minyak kompor',
  'alas silikon adonan kue baking anti lengket',
  'alat pembuat crepes mini pan elektrik',
  'capitan makanan silikon stainless food grade',
  'termometer makanan digital masak dapur',
  'alat pembuat crepes mini elektrik anti lengket',
  'panci kukus mini elektrik serbaguna',
  'alat pembersih kerak wajan gosong stainless',
  'wajan grill pan mini anti lengket pemanggang',
  'mixer tangan mini elektrik portable usb',
  'frother pengocok susu kopi mini elektrik',
  'kertas baking parchment paper air fryer bulat',
  'silikon pot air fryer reusable anti lengket',
  'spons kawat cuci piring sabut stainless anti gores',
  'dispenser adonan kue pencet pancake batter',
  'spatula silikon tahan panas food grade',
  'kuas minyak silikon baking tahan panas',
  'alat pemipil jagung serbaguna stainless',
  'rolling pin kayu silikon penggiling adonan',
  'alat pemeras jeruk lemon putar manual',
  'sendok takar bumbu dapur digital lcd',
  'saringan tepung stainless putar manual praktis',
  'pemanggang sandwich toaster mini elektrik',
  'alat pembuka tutup botol toples serbaguna',
  'alat pemotong alpukat 3 in 1 multifungsi',
  'alat tusuk sate praktis pembuat sate cepat',
  'wajan tamagoyaki teflon telur gulung jepang mini',
  'panci rebus mie telur mini stainless gagang',
  'penutup silikon microwave anti cipratan',
  'tatakan kompor gas pelindung api hemat gas',
  'pematik api kompor gas elektrik usb recharge',
  'wajan tamagoyaki teflon telur gulung jepang mini',
  'sarung tangan oven silikon anti panas tebal',
  'jepitan mangkok piring panas silikon stainless',
  'alas tatakan panci panas silikon tahan panas',
  'sendok ukur bumbu stainless magnetic',
  'saringan tirisan mie minyak serbaguna stainless',
  'saringan tepung ayakan stainless putar manual',
  'capitan gorengan stainless dengan saringan tirisan',
  'tatakan sutil tutup panci silikon anti panas',
  'pemanggang sandwich toaster mini kompor',
  'centong nasi silikon anti lengket berdiri',
  'sendok kuah sup sayur silikon gagang kayu',
  'irus sayur kuah stainless gagang tahan panas',
  'panci sauce pan mini anti lengket susu mie',
  'wajan teflon mini penggorengan telur 12cm',
  'pemanggang roti bakar lipat kompor gas',
  'alat pembuat sempol sate telur gulung mini',
  'capitan silikon gorengan barbecue anti panas',

  // =========================================================================
  // 3. WADAH BUMBU, BOTOL & PERABOTAN DAPUR KOMPAK (Tabletop Furniture & Storage)
  // (CATATAN: HANYA perabot meja/tabletop kompak, BUKAN lemari atau rak besar!)
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
  'gantungan alat masak dinding putar 360',
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
  'tikar pengering piring silikon dish drying mat',
  'wadah bumbu sekat toples bumbu kaca sendok',
  'kotak telur organizer kulkas roll gravitasi',
  'dispenser sabun cuci piring sponge pump otomatis',
  'tempat spons cuci piring gantung kran wastafel',
  'wadah saringan tirisan minyak gorengan stainless',
  'botol kecap minyak kaca otomatis buka tutup',
  'gantungan alat masak dinding putar 360 serbaguna',
  'rak bumbu meja 2 tingkat mini portable compact',
  'klip penjepit bungkus snack kedap udara rapat',
  'tikar pengering piring silikon dish drying mat',

  // =========================================================================
  // 4. PERLENGKAPAN DAPUR & PERLENGKAPAN MEMASAK LAINNYA (Kitchen Supplies & Tools)
  // =========================================================================
  'penjepit kantong plastik makanan sealer clip praktis',
  'tutup panci silikon anti tumpah boil over safeguard',
  'wadah tirisan sayur buah kulkas drainer serbaguna',
  'kantong silikon penyimpan makanan ziplock reusable',
  'corong tuang minyak bumbu stainless saringan mini',
  'penutup mangkok silikon elastis tahan panas microwave',
  'jepitan piring mangkok panas stainless silikon gripper',
  'tatakan panci silikon sarang lebah anti panas meja',
  'splash guard kompor pelindung cipratan minyak lipat',
  'pematik api elektrik usb kompor gas tanpa gas',
  'termometer minyak daging digital probe lcd dapur',
  'timer dapur digital magnetik pengingat waktu masak',
  'sendok takar digital timbangan bumbu lcd presisi',
  'sendok takar bumbu stainless magnetik multifungsi',
  'silikon pot air fryer tahan panas anti lengket loyang',
  'kertas minyak alas air fryer baking paper bulat',
  'alat pemotong pisang sosis praktis stainless',
  'alat perajang bawang manual putar praktis',
  'sutil spatula silikon tahan panas multifungsi',
  'capitan makanan capitan kue silikon jepit makanan',
  'gunting serbaguna dapur potong tulang ayam daging sk5',
  'alat pemotong kentang sayur spiral tornado fries',
  'parutan keju coklat putar rotary stainless steel',
  'alat pemeras santan kelapa perasan manual praktis',
  'sendok scoop es krim trigger release stainless',

  // =========================================================================
  // 5. ALAT KEBERSIHAN KHUSUS WASTAFEL & DAPUR MINI (Kitchen Cleaning Tools)
  // =========================================================================
  'dispenser sabun cuci piring otomatis sponge pump',
  'spons cuci piring nano magic sponge pembersih kerak',
  'sikat cuci piring dispenser sabun cair otomatis',
  'spons kawat cuci piring sabut stainless anti gores',
  'kain lap nano berserat pembersih minyak dapur',
  'alat pembersih kerak wajan panci serbaguna',
  'sikat pembersih botol tumbler sedotan panjang',
  'sikat pembersih tabung botol dapur',
  'alat pembersih sisik ikan stainless dengan wadah',
  'sikat pembersih celah kompor wastafel serbaguna',
  'spons cuci piring jaring busa tebal higienis anti bau'
];

export const TOOL_INDICATORS = [
  'alat', 'wadah', 'saringan', 'pembuat', 'parutan',
  'gunting', 'wajan', 'panci', 'spatula', 'sutil', 'capitan',
  'timbangan', 'termometer', 'dispenser', 'sealer', 'pengupas', 'peeler',
  'slicer', 'chopper', 'blender', 'grater', 'organizer', 'tempat bumbu', 'rak bumbu meja',
  'penjepit', 'tatakan', 'kuas silikon', 'frother', 'whisk', 'rolling pin', 'loyang',
  'serutan', 'pemeras', 'pelumat', 'perajang', 'sikat', 'spons', 'kain lap',
  'tudung saji', 'sarung tangan oven', 'pematik', 'splash guard', 'masher',
  'ricer', 'timer dapur', 'sendok takar', 'sendok ukur', 'centong', 'irus', 'corong',
  'tirisan', 'pencacah', 'pengocok', 'pengiris', 'pemipil',
  'pan', 'pot', 'steamer', 'toaster', 'waffle maker', 'botol minyak', 'botol bumbu',
  'botol semprot', 'botol spray', 'botol saus', 'botol kecap', 'squeeze bottle',
  'grinder', 'french press', 'coffee maker', 'teko', 'drain bowl', 'drying mat'
];

export const FOOD_DRINK_EXCLUDE_WORDS = [
  // Resep, tutorial masak, kuliner & mukbang (bukan demonstrasi alat dapur)
  'resep', 'recipe', 'cara membuat', 'cara memasak', 'menu masakan', 'masakan rumahan',
  'kuliner', 'culinary', 'mukbang', 'asmr makan', 'asmr eating', 'food review',
  'drink review', 'jajanan', 'street food', 'warung makan', 'restoran', 'cafe',
  'makan siang', 'makan malam', 'sarapan enak', 'kuliner viral', 'cemilan viral',

  // Minuman & Minuman Olahan (Beverages)
  'minuman', 'beverage', 'drink', 'minuman kemasan', 'minuman sachet', 'minuman botol',
  'boba', 'bubble tea', 'milk tea', 'thai tea', 'matcha latte', 'matcha tea',
  'kopi bubuk', 'kopi sachet', 'kopi luwak', 'kopi hitam', 'kopi susu', 'kopi gula aren', 'espresso',
  'biji kopi', 'coffee bean', 'cold brew', 'cappuccino sachet',
  'susu sapi', 'susu uht', 'susu formula', 'susu kental manis', 'susu evaporasi', 'susu kedelai',
  'sirup', 'syrup', 'teh celup', 'teh tubruk', 'teh kotak', 'teh botol', 'jus buah',
  'minuman bersoda', 'soft drink', 'minuman isotonik', 'minuman energi', 'minuman collagen',
  'minuman herbal', 'jamu', 'jamu tradisional', 'bir', 'beer', 'alkohol', 'wine',

  // Makanan Ringan, Snack & Camilan
  'makanan ringan', 'snack', 'camilan', 'cemilan', 'keripik', 'kerupuk', 'kripik',
  'basreng', 'seblak', 'makaroni pedas', 'biskuit', 'wafer', 'cokelat', 'chocolate',
  'permen', 'candy', 'kue kering toples', 'nastar toples', 'kastengel', 'kue basah',
  'roti tawar', 'roti sobek', 'donat manis', 'martabak manis', 'brownies', 'bolu panggang',
  'puding cup', 'dessert box', 'popcorn',

  // Makanan Instan, Olahan & Frozen Food
  'makanan instan', 'mie instan', 'indomie', 'sedap goreng', 'ramen instan', 'samyang',
  'frozen food', 'nugget ayam', 'sosis sapi', 'sosis bakar', 'bakso sapi kemasan',
  'siomay beku', 'dimsum frozen', 'pempek palembang', 'cireng bumbu rujak', 'cilok',
  'rendang siap saji', 'sambal kemasan', 'sambal sachet', 'bumbu instan', 'bumbu racik',

  // Bahan Pangan Mentah Tanpa Konteks Alat
  'daging sapi 1kg', 'daging ayam segar', 'daging fillet', 'daging slice beef',
  'ikan segar', 'udang vaname', 'cumi asin', 'kepiting laut', 'telur ayam 1kg',
  'beras ramos', 'beras pandan wangi', 'beras merah 5kg', 'tepung terigu segitiga',
  'tepung tapioka 1kg', 'tepung beras rose brand', 'gula pasir gulaku', 'garam dapur beryodium',
  'minyak goreng 2l', 'minyak goreng sania', 'minyak goreng filma', 'minyak goreng bimoli'
];

export function isFoodOrBeverageProduct(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  // 1. Direct match on food/drink exclude list
  if (FOOD_DRINK_EXCLUDE_WORDS.some((word) => normalized.includes(word))) {
    // If it contains a pure recipe/mukbang/beverage/snack term, always exclude
    if (/\b(?:resep|recipe|mukbang|asmr makan|asmr eating|kuliner|street food|food review|drink review|camilan|cemilan|minuman kemasan|boba milk tea|frozen food|mie instan|kopi susu|kopi gula aren)\b/i.test(normalized)) {
      // Unless it explicitly mentions a recognized appliance/prep tool (frother, blender, grinder, mixer, teko, saringan teh)
      if (!/\b(?:frother|pengocok\s+susu|milk\s+frother|grinder|penggiling|french\s+press|teko|infuser|blender|saringan\s+teh)\b/i.test(normalized)) {
        return true;
      }
    }

    // If it has a clear physical tool/utensil indicator, allowed (e.g. cetakan bakso, parutan keju, botol minyak kuas)
    const hasTool = TOOL_INDICATORS.some((tool) => normalized.includes(tool));
    if (!hasTool) {
      return true;
    }
  }

  // 2. Pure food/drink keywords without physical tool indicator
  if (/\b(?:makanan|minuman|snack|camilan|cemilan|boba|kopi|teh|susu|sirup|jus|keripik|biskuit|cokelat|nugget|sosis|bakso|siomay|dimsum|seblak|basreng)\b/i.test(normalized)) {
    const hasTool = TOOL_INDICATORS.some((tool) => normalized.includes(tool));
    if (!hasTool) {
      return true;
    }
  }

  return false;
}

export const BUNDLE_SET_EXCLUDE_WORDS = [
  'set', 'pack', 'packs', 'package', 'paket', 'bundle', 'bundling', 'kombo', 'combo',
  'lusin', 'grosir', 'renteng', 'multipack'
];

export function isBundleOrSetProduct(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  // 1. Check for standalone bundle/set words: "set", "pack", "packs", "package", "paket", "bundle", "bundling", "combo", "kombo"
  // Using \b word boundary so words like "keset", "reset", "offset" are not falsely flagged
  if (/\b(?:set|pack|packs|package|paket|bundle|bundling|kombo|combo|lusin|grosir|renteng|multipack)\b/i.test(normalized)) {
    return true;
  }

  // 2. Multi-item quantity indicators: "isi 3", "isi 5", "isi 10", "isi 12", "isi banyak"
  if (/\bisi\s*(?:\d+|banyak|beberapa)\b/i.test(normalized)) {
    return true;
  }

  // 3. Piece count indicators: "3 pcs", "5pcs", "10 pcs", "12 pcs"
  if (/\b\d+\s*pcs\b/i.test(normalized)) {
    return true;
  }

  // 4. "1 set", "satu set", "1 paket", "1 pack"
  if (/\b(?:1\s*set|satu\s*set|1\s*paket|1\s*pack|se-set)\b/i.test(normalized)) {
    return true;
  }

  return false;
}

export const HIGH_VARIATION_EXCLUDE_WORDS = [
  // Cetakan & Molds (terlalu banyak variasi bentuk, ukuran, dan motif antar produsen)
  'cetakan', 'pencetak', 'cetak', 'mold', 'mould', 'patty press', 'pancake mold', 'ice mold', 'ice tray',
  'popsicle mold', 'silicone mold', 'cetakan kue', 'cetakan puding', 'cetakan es', 'cetakan donat',
  'cetakan pastel', 'cetakan dumpling', 'cetakan sushi', 'cetakan onigiri', 'cetakan bakso',
  'cetakan takoyaki', 'cetakan pukis', 'cetakan martabak', 'cetakan semprit', 'cetakan tumpeng',
  'cetakan jelly', 'cetakan cokelat', 'cetakan coklat', 'cetakan burger', 'cetakan bento',

  // Pisau & Aksesoris Bilah/Pengasah (terlalu banyak variasi model bilah, gagang, dan motif baja)
  'pisau', 'knife', 'knives', 'cleaver', 'santoku', 'golok', 'chef knife', 'paring knife',
  'utility knife', 'carving knife', 'boning knife', 'bread knife', 'pisau dapur', 'pisau buah',
  'pisau daging', 'pisau set', 'pisau lipat', 'pisau kupas', 'pisau roti', 'tempat pisau',
  'rak pisau', 'knife block', 'knife holder', 'pengasah pisau', 'asah pisau', 'asahan pisau',
  'batu asah', 'batu asahan', 'whetstone', 'sharpening stone', 'knife sharpener',

  // Peralatan bentuk umum / komoditas polos tanpa mekanisme unik (sulit dicocokkan 1-ke-1 dengan video)
  'talenan', 'cutting board', 'chopping board',
  'piring keramik', 'piring makan', 'mangkok keramik', 'mangkok makan',
  'cangkir keramik', 'mug keramik', 'gelas kaca',
  'sendok makan', 'garpu makan', 'sumpit makan',
  'serbet kain', 'lap piring', 'kain lap dapur'
];

export function isHighVariationOrHardToMatchProduct(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  // Izinkan alat dapur viral mekanik & praktis (dumpling maker, tamagoyaki pan, waffle maker, asahan pisau roll, gunting SK5, peeler, chopper)
  const isViralMechanicGadget = /\b(?:dumpling|pastel|tamagoyaki|waffle|takoyaki|roll\s+sharpener|batu\s+asah|asahan|sk5|chopper|slicer|peeler|garlic\s+press|sealer)\b/i.test(normalized);
  if (isViralMechanicGadget) {
    // Tetap tolak jika hanya menjual sparepart / suku cadang mata pisau saja
    if (/\b(?:sparepart|cadangan|pengganti|mata\s+pisau\s+saja)\b/i.test(normalized)) {
      return true;
    }
    return false;
  }

  // 1. Cetakan kue motif kecil / silikon coklat polos tanpa mekanisme
  if (/\b(?:cetakan\s+coklat|cetakan\s+es\s+batu|cetakan\s+kue\s+kering|cetakan\s+puding|silicone\s+mold\s+cake)\b/i.test(normalized)) {
    return true;
  }

  // 2. Pisau biasa / pisau daging tanpa alat mekanis (kecuali alat iris / slicer mekanis)
  if (/\b(?:pisau\s+dapur|pisau\s+buah|pisau\s+chef|santoku|golok\s+daging)\b/i.test(normalized) && !/\b(?:slicer|peeler|chopper|roll|asahan)\b/i.test(normalized)) {
    return true;
  }

  // 3. Talenan polos tanpa fungsi multifungsi
  if (/\b(?:talenan\s+kayu|talenan\s+plastik|chopping\s+board)\b/i.test(normalized) && !/\b(?:multifungsi|drain|baskom|lipat)\b/i.test(normalized)) {
    return true;
  }

  // 4. Periksa kecocokan daftar kata komoditas polos (piring polos, cangkir polos, serbet)
  if (HIGH_VARIATION_EXCLUDE_WORDS.some((word) => normalized.includes(word))) {
    return true;
  }

  return false;
}

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
  'lampu tidur',

  // Pemanggang besar / Outdoor Grills / Commercial BBQ (Blackstone dsb)
  'blackstone',
  'weber',
  'smoker',
  'barbecue',
  'bbq outdoor',
  'grill outdoor',
  'pemanggang besar',
  'panggangan besar',
  'panggangan standing',
  'griddle outdoor',
  'commercial grill',

  // Mesin Industri Berat / Alat Berat / Pertanian Skala Raksasa
  'alat berat',
  'mesin pabrik besar',
  'mesin industri berat',

  // Pertanian / Peternakan Skala Besar / Mesin Berat
  'pakan ternak',
  'mesin ternak',
  'mesin selep gabah',
  'perontok padi',
  'traktor',
  'chopper pakan ternak',
  'silase'
];

export function isBulkyOrUnsuitableProduct(text = '', options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const isGadget = options?.niche === 'gadget_smartphone';

  // 1. Food or drink exclusion check
  if (isFoodOrBeverageProduct(normalized)) {
    return true;
  }

  // 1B. Disqualify 'cara', 'tutorial', 'DIY', 'how to', 'do it yourself'
  if (/\b(?:cara|tutorial|diy|how\s+to|do\s+it\s+yourself)\b/i.test(normalized)) {
    return true;
  }

  // 1C. Heavy machinery / agricultural machinery (bukan alat rumah tangga praktis)
  if (/\b(?:blackstone|weber|smoker|barbecue|bbq|alat\s+berat|traktor|pakan\s+ternak|selep\s+gabah|perontok\s+padi|pemanen\s+padi|chopper\s+ternak|chopper\s+rumput|cacah\s+rumput|silase|janggel)\b/i.test(normalized)) {
    return true;
  }

  if (isGadget) {
    // Smartphone & Gadget specific exclusions:
    // Exclude repair/service tutorials, broken screens, dead boards, teardown
    if (/\b(?:servis|service|reparasi|repair|ganti\s+lcd|lcd\s+pecah|mati\s+total|matot|bongkar|disassembly|teardown|skematik|jalur|solder)\b/i.test(normalized)) {
      return true;
    }
    // Exclude bulky non-gadgets: big appliances, vehicles, furniture
    if (/\b(?:kulkas|mesin\s+cuci|televisi|\btv\b|ac\b|lemari|sofa|kasur|motor|mobil|sepeda|sepeda\s+listrik)\b/i.test(normalized)) {
      return true;
    }
    return false;
  }

  // 1D. Disqualify sets, packs, bundles, multi-item packages (sulit dicocokkan dengan 1 video demo)
  if (isBundleOrSetProduct(normalized)) {
    return true;
  }

  // 1E. Disqualify molds (cetakan), knives (pisau), sharpeners, and hard-to-match high-variation items
  if (isHighVariationOrHardToMatchProduct(normalized)) {
    return true;
  }

  // 2. Direct match on exclude list
  if (BULKY_EXCLUDE_WORDS.some((word) => normalized.includes(word))) {
    return true;
  }

  // 3. Any combination of "rak" with frame-filling descriptors
  if (/\brak\b/.test(normalized) && /(?:besar|jumbo|susun|tingkat|piring|wastafel|dapur|besi|standing|troli|roda|tinggi|dinding|gantung)/.test(normalized)) {
    return true;
  }

  // 4. Furniture or cabinet indicators
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
    const coreNoun = extractCoreProductInfo(meta.productTitle)?.coreProductNoun;
    if (coreNoun) {
      const normNoun = normalizeKeyword(coreNoun);
      if (normNoun) {
        store.productTitles[normNoun] = {
          usedAt: Date.now(),
          dateStr: new Date().toISOString(),
          jobId: meta.jobId || null
        };
      }
    }
  }
  const kwCoreNoun = extractCoreProductInfo(keyword)?.coreProductNoun;
  if (kwCoreNoun) {
    const normKwNoun = normalizeKeyword(kwCoreNoun);
    if (normKwNoun) {
      store.keywords[normKwNoun] = {
        usedAt: Date.now(),
        dateStr: new Date().toISOString(),
        jobId: meta.jobId || null,
        source: 'core_noun'
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
  const coreNoun = extractCoreProductInfo(keyword)?.coreProductNoun;
  if (coreNoun) {
    const normNoun = normalizeKeyword(coreNoun);
    if (normNoun) {
      if (store.keywords && store.keywords[normNoun]) return true;
      if (store.productTitles && store.productTitles[normNoun]) return true;
    }
  }
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
  // ── 1. ALAT DAPUR, PEMOTONG & FOOD PREP (Kitchen Tools & Cutters) ──
  'chopper mini manual tarik',
  'chopper mini elektrik portable',
  'food chopper blender mini',
  'blender kapsul mini portable',
  'mandoline slicer parutan multifungsi',
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
  'alat pemotong semangka melon praktis',
  'alat pemotong alpukat 3 in 1',
  'alat pemotong nanas spiral corer',
  'alat pemotong pizza roda stainless',
  'alat serut jagung pipil stainless',
  'alat pemipil jagung serbaguna praktis',
  'alat pengiris telur rebus stainless',
  'alat pemecah cangkang kepiting walnut',
  'sendok pembuat bakso bakwan anti lengket',
  'sendok tirisan minyak stainless serbaguna',
  'alat pembuka tutup kaleng putar can opener',
  'alat pengupas buah sayur peeler praktis',
  'alat pengupas kulit udang praktis',
  'alat pembuang biji apel pir praktis',
  'alat pelumat kentang potato masher',
  'alat peremas kentang stainless potato ricer',
  'alat pelumat bawang putih garlic press',
  'pemeras bawang putih rocker stainless',
  'alat pemeras jeruk lemon manual stainless',
  'alat pemeras jeruk nipis manual',
  'alat pemeras santan kelapa manual mini',
  'alat pemisah kuning telur praktis',
  'alat penusuk daging tenderizer empuk',
  'sendok porsi es krim scoop trigger',
  'alat pelubang kelapa muda stainless',
  'alat pemotong nanas spiral corer stainless',
  'alat pengupas apel putar otomatis',
  'alat pemotong pisang sosis praktis stainless',
  'alat pemecah cangkang kepiting walnut',
  'gunting dapur serbaguna stainless sk5',
  'gunting daging tulang unggas heavy duty',
  'gunting sayur daun bawang 5 lapis',
  'alat pelubang kelapa muda stainless',
  'alat penusuk daging tenderizer empuk',
  'alat pembuka kaleng putar praktis aman',
  'alat pembuka tutup botol toples serbaguna',
  'alat pencabut bulu ayam ikan stainless',
  'alat pemotong keju kawat stainless',
  'parutan keju putar rotary cheese grater',
  'pengupas kulit jeruk lemon zester stainless',
  'alat perajang rempah daun stainless herb cutter',
  'alat pengocok telur semi otomatis putar tekan',
  'alat pelindung jari iris sayur stainless',

  // ── 2. PERABOTAN DAPUR (TABLETOP, RAK BUMBU & ORGANIZER MEJA KOMPAK) ──
  'tempat bumbu putar 360 derajat meja',
  'wadah bumbu dapur 4 sekat praktis sendok',
  'kotak bumbu dapur putar serbaguna',
  'tempat sendok garpu tirisan mini tertutup',
  'tempat sendok tirisan meja anti debu',
  'gantungan alat masak dinding putar 360',
  'tikar pengering piring silikon dish drying mat',
  'toples kaca kedap udara tutup bambu estetik',
  'wadah bumbu kaca sendok label terintegrasi',
  'dispenser beras mini otomatis anti kutu',
  'kotak telur organizer kulkas roll otomatis',
  'kotak telur bertingkat otomatis slide kulkas',
  'tatakan tutup panci sutil meja silikon',
  'rak bumbu meja 2 tingkat mini portable',
  'rak bumbu putar putaran halus meja',
  'gantungan alat masak dinding putar 360',
  'tempat spons tirisan kran wastafel praktis',
  'wadah kotak penyimpanan bawang cabai kulkas',
  'organizer bumbu sachet mini gantung kulkas',
  'kotak penyimpanan kulkas sekat drain basket',
  'dispenser sabun cuci piring sponge pump',

  // ── 3. PERLENGKAPAN DAPUR & FOOD PREPARATION (Kitchen Supplies & Storage) ──
  'botol minyak kuas silikon 2 in 1 anti tumpah',
  'botol semprot spray minyak goreng olive oil',
  'botol minyak goreng kaca otomatis buka tuang',
  'botol saus kecap squeeze bottle plastik lentur',
  'alat sealer plastik mini portable heat sealer',
  'klip penjepit bungkus makanan snack kedap udara',
  'penutup makanan silikon stretch elastis reusable',
  'penutup makanan payung tudung saji lipat',
  'wadah tirisan cuci beras sayur drain bowl',
  'baskom pencuci beras buah tirisan putar 2 in 1',
  'wadah saringan tirisan minyak jelantah stainless',
  'corong lipat silikon minyak air serbaguna',
  'corong tuang minyak bumbu stainless saringan',
  'kantong silikon penyimpan makanan ziplock reusable',
  'penutup mangkok silikon elastis anti tumpah',
  'jepitan kantong plastik makanan sealer clip',
  'tutup panci silikon anti tumpah boil over safeguard',
  'wadah tirisan sayur buah kulkas drainer',
  'saringan teh kopi stainless reusable infuser',
  'tikar pengering piring silikon dish drying mat',

  // ── 4. PERLENGKAPAN MEMASAK, WAJAN & BAKING (Cookware, Baking & Cooking Tools) ──
  'wajan penggorengan mini telur 4 lubang anti lengket',
  'wajan tamagoyaki teflon kotak telur gulung',
  'wajan grill pan mini anti lengket pemanggang',
  'panci listrik mini serbaguna portable anak kost',
  'panci kukus mini stainless serbaguna',
  'panci rebus mie telur mini stainless gagang',
  'pemanggang sandwich toaster mini lipat kompor',
  'alat pembuat waffle mini elektrik praktis',
  'alat pembuat crepes mini pan elektrik',
  'wajan tamagoyaki teflon telur gulung jepang',
  'alat pembuat sempol sate telur gulung mini',
  'panci sauce pan mini anti lengket susu mie',
  'wajan teflon mini penggorengan telur 12cm',
  'saringan tepung ayakan stainless putar manual',
  'dispenser adonan kue pencet batter dispenser',
  'alat pembersih kerak wajan panci gosong',
  'penutup silikon microwave anti cipratan',
  'saringan tirisan mie goreng minyak stainless',
  'sutil silikon tahan panas food grade',
  'spatula silikon tahan panas gagang kayu estetik',
  'capitan makanan gorengan silikon stainless',
  'capitan gorengan stainless dengan saringan tirisan',
  'centong nasi silikon anti lengket berdiri',
  'sendok kuah sup sayur silikon tahan panas',
  'irus kuah sayur stainless gagang kayu anti panas',
  'alas silikon adonan kue baking mat anti lengket',
  'rolling pin silikon penggiling adonan kue pastry',
  'kuas minyak silikon baking tahan panas',
  'silikon pot air fryer reusable anti lengket',
  'kertas baking parchment paper air fryer bulat',
  'timer dapur digital magnetik masak baking',
  'termometer makanan digital masak probe presisi',
  'timbangan digital dapur mini presisi gram',
  'sendok takar bumbu dapur magnetic stainless',
  'sendok takar digital timbangan bumbu lcd',
  'saringan tepung ayakan stainless putar manual',
  'whisk pengocok adonan telur manual stainless',
  'frother pengocok susu kopi mini elektrik usb',
  'splash guard pelindung cipratan minyak kompor',
  'tatakan kompor gas pelindung api hemat gas',
  'pematik api kompor gas elektrik usb recharge',
  'sarung tangan oven silikon anti panas tebal',
  'jepitan mangkok piring panas silikon stainless',
  'alas tatakan panci wajan panas silikon meja',
  'alat tusuk sate praktis pembuat sate cepat',
  'penutup silikon microwave anti cipratan makanan',

  // ── 5. PERLENGKAPAN KEBERSIHAN WASTAFEL & GADGET DAPUR TERKAIT ──
  'spons cuci piring nano magic sponge pembersih kerak',
  'spons sabut kawat stainless anti gores cuci piring',
  'sikat cuci piring dispenser sabun otomatis',
  'sikat pembersih botol tumbler sedotan panjang',
  'sikat pembersih tabung botol dapur',
  'kain lap microfiber nano berserat pembersih minyak',
  'alat pembersih kerak wajan panci gosong',
  'alat pembersih sisik ikan stainless dengan wadah',
  'spons cuci piring jaring busa tebal higienis',
  'sikat pembersih celah kompor wastafel serbaguna'
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
  'estetik minimalis modern',
  'model terbaru viral aesthetic',
  '3 in 1 multifungsi praktis',
  '4 in 1 serbaguna hemat ruang',
  '5 in 1 serbaguna komplit',
  '6 in 1 multifungsi komplit wadah',
  'hemat tempat ringkas dapur sempit',
  'compact gampang disimpan di laci',
  'travel friendly ringkas mudah dibawa',
  'mata pemotong tajam presisi anti karat',
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
  'anti bocor anti tumpah presisi',
  'magnetik kuat nempel di kulkas dinding',
  'dilengkapi sensor otomatis presisi',
  'gagang ergonomis anti selip licin',
  'lapisan marmer granit anti lengket',
  'food grade aman untuk bayi mpasi',
  'desain lipat hemat tempat serbaguna',
  'tahan banting bahan tebal berkualitas',
  'putaran 360 derajat putar halus',
  'tekanan vakum kedap udara rapat',
  'gagang panjang anti cipratan panas',
  'tutup bambu alami kedap udara',
  'kapasitas presisi dengan garis takar',
  'multifungsi untuk segala jenis masakan',
  'ringan kokoh mudah dipakai sehari hari',
  'anti lumut anti karat higienis',
  'tampilan lcd digital presisi tinggi',
  'sistem pegas semi otomatis cepat',
  'anti panas ganda pelindung tangan',
  'alas anti slip tidak mudah bergeser',
  'wadah transparan mudah pantau isi'
];

export const KITCHEN_TARGETS = [
  'untuk perlengkapan dapur minimalis',
  'untuk perabotan dapur estetik modern',
  'untuk peralatan masak praktis harian',
  'untuk persiapan masak food prep mingguan',
  'untuk dapur sempit anak kost hemat ruang',
  'untuk memotong merajang bumbu bawang cabai',
  'untuk menghaluskan bumbu masak praktis',
  'untuk mengupas buah sayur harian',
  'untuk memotong mengiris daging beku cincang',
  'untuk mengaduk meratakan adonan kue roti',
  'untuk menggoreng telur sarapan 4 lubang',
  'untuk memanggang sarapan roti sandwich praktis',
  'untuk membuat waffle kue mini cemilan anak',
  'untuk meniriskan gorengan minyak panas',
  'untuk menyaring minyak jelantah sisa goreng',
  'untuk mencuci beras buah sayur tiris cepat',
  'untuk wadah penyimpanan bumbu garam gula',
  'untuk wadah minyak kecap saus anti tumpah',
  'untuk menata telur rapi di kulkas',
  'untuk merekatkan bungkus plastik makanan sisa',
  'untuk menutup wadah mangkok elastis kedap udara',
  'untuk memotong merapikan sayur buah bumbu',
  'untuk membuka kaleng toples tutup botol keras',
  'untuk mengukur menimbang takaran bumbu resep',
  'untuk mengukur suhu minyak daging panggang',
  'untuk pelindung cipratan minyak kompor gas',
  'untuk tatakan wajan panci panas di meja',
  'untuk membuat sarapan telur praktis hemat waktu',
  'untuk menyaring memeras santan jeruk higienis',
  'untuk mengocok telur adonan cepat mengembang',
  'untuk membuat foam busa susu kopi lembut',
  'untuk membersihkan kerak wajan panci gosong',
  'untuk mencuci piring wastafel higienis',
  'untuk membersihkan botol tumbler sedotan sempit',
  'untuk memasak mpasi bayi higienis sehat',
  'untuk perlengkapan memasak anti ribet',
  'untuk ibu rumah tangga cerdas hemat waktu',
  'untuk memasak cepat praktis tanpa ribet',
  'untuk alat dapur wajib ada di rumah',
  'untuk aksesoris dapur serbaguna kekinian'
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
  'perlengkapan masak praktis serbaguna',
  'perlengkapan dapur estetik kekinian',
  'rekomendasi perabot dapur minimalis',
  'alat dapur serbaguna harga terjangkau',
  'perlengkapan dapur wajib punya 2026',
  'perabotan dapur modern hemat tempat',
  'peralatan memasak kekinian viral',
  'perabot dapur aesthetic shopee haul',
  'alat dapur pintar mempermudah masak',
  'peralatan dapur terlengkap paling dicari',
  'solusi dapur rapi bersih hemat ruang',
  'peralatan masak anti ribet serbaguna',
  'alat dapur viral racun shopee',
  'perlengkapan masak ibu rumah tangga',
  'alat masak serbaguna kualitas premium',
  'gadget dapur praktis rekomendasi ibu muda',
  'perabot dapur multifungsi modern',
  'perlengkapan dapur serbaguna termurah',
  'alat masak canggih praktis harian',
  'kitchen hacks alat masak praktis',
  'spill perlengkapan dapur murah viral'
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
    (tool, variant, target, mod) => `${tool} ${variant} ${target}`,
    (tool, variant, target, mod) => `${mod} ${tool} ${target}`,
    (tool, variant, target, mod) => `rekomendasi ${tool} ${variant}`,
    (tool, variant, target, mod) => `spill ${tool} ${mod}`,
    (tool, variant, target, mod) => `${tool} multifungsi ${variant}`,
    (tool, variant, target, mod) => `alat dapur ${tool} ${variant}`,
    (tool, variant, target, mod) => `perlengkapan masak ${tool} ${target}`
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
 * Returns a randomized, expansive array of keywords tailored to the active niche.
 * Automatically excludes any keywords or product titles that have already been generated/processed.
 */
export function getAutoKeywords(limit = 1000, { niche = 'kitchen_tools', excludeUsed = true, shuffle = true } = {}) {
  const preset = getNichePreset(niche);
  const isGadget = preset.id === 'gadget_smartphone';

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
  const seenBatchNouns = new Set();

  // 1. First include any unused default curated keywords from the active niche preset
  const curatedList = preset.defaultKeywords || DEFAULT_AUTO_KEYWORDS;
  for (const kw of curatedList) {
    const norm = normalizeKeyword(kw);
    const coreNoun = normalizeKeyword(extractCoreProductInfo(kw)?.coreProductNoun || '');
    if (!excludedSet.has(norm) && (!coreNoun || (!excludedSet.has(coreNoun) && !seenBatchNouns.has(coreNoun)))) {
      if (isGadget || !isBulkyOrUnsuitableProduct(kw)) {
        resultSet.add(kw);
        if (coreNoun) seenBatchNouns.add(coreNoun);
        if (resultSet.size >= limit) break;
      }
    }
  }

  // 2. Dynamically synthesize remaining keywords from combinatorial matrix
  if (resultSet.size < limit) {
    const needed = limit - resultSet.size;
    const combinedExcluded = new Set([...excludedSet, ...seenBatchNouns]);
    for (const item of resultSet) {
      combinedExcluded.add(normalizeKeyword(item));
      const cn = normalizeKeyword(extractCoreProductInfo(item)?.coreProductNoun || '');
      if (cn) combinedExcluded.add(cn);
    }
    const generated = isGadget
      ? generateCombinatorialGadgetKeywords(needed * 2, combinedExcluded)
      : generateCombinatorialKitchenKeywords(needed * 2, combinedExcluded);

    for (const g of generated) {
      const gNoun = normalizeKeyword(extractCoreProductInfo(g)?.coreProductNoun || '');
      if (!gNoun || !seenBatchNouns.has(gNoun)) {
        resultSet.add(g);
        if (gNoun) seenBatchNouns.add(gNoun);
        if (resultSet.size >= limit) break;
      }
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
// VPS datacenter environments can have broken/slow IPv6 routes. Force IPv4 for all HTTPS scraping
// so Bing/Brave/DuckDuckGo do not sit until AbortController kills an otherwise healthy request.
const insecureTlsAgent = new https.Agent({
  rejectUnauthorized: false,
  family: 4,
  keepAlive: true,
});

function formatKeywordToProductTitle(keyword) {
  if (!keyword) return 'Alat Dapur Praktis Viral';
  return keyword
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export async function discoverSingleShopeeProduct(keyword, seen = new Set()) {
  try {
    const results = (await searchShopeeProducts(keyword))
      .filter(r => !seen.has(r.url) && !isBundleOrSetProduct(r.title));
    results.forEach(r => seen.add(r.url));

    // Inspect several marketplace results and accept ONLY a listing with a
    // reliable brand + concrete product type. OEM/unbranded listings are skipped.
    const batch = results.slice(0, 10);
    const metas = await Promise.allSettled(batch.map(r => fetchShopeePageMeta(r.url)));

    for (let i = 0; i < batch.length; i++) {
      const result = batch[i];
      const pageMeta = metas[i].status === 'fulfilled' ? metas[i].value : {};
      const rawTitle = pageMeta.title || result.title || '';

      if (!rawTitle || isBundleOrSetProduct(rawTitle) || isGenericShopeeTitle(rawTitle)) {
        continue;
      }

      const titleCandidate = cleanTitle(rawTitle, result.url);
      if (!titleCandidate || isGenericShopeeTitle(titleCandidate)) {
        continue;
      }

      const descCandidate = cleanDescription(pageMeta.description || result.snippet || '');
      if (
        isBulkyOrUnsuitableProduct(titleCandidate) ||
        isBulkyOrUnsuitableProduct(descCandidate) ||
        isBulkyOrUnsuitableProduct(keyword)
      ) {
        continue;
      }

      const productInfo = extractCoreProductInfo(
        titleCandidate,
        descCandidate,
        result.url,
        pageMeta.brand || ''
      );

      const brand = String(productInfo?.brand || pageMeta.brand || '').trim();
      const productType = String(productInfo?.coreProductNoun || '').trim();
      const model = String(productInfo?.model || '').trim();
      const searchQueries = Array.isArray(productInfo?.searchQueries)
        ? productInfo.searchQueries.filter((q) => /\\S/.test(String(q || '')))
        : [];

      // Hard gate: AutoRun accepts no OEM/unbranded product.
      if (
        !brand ||
        !productType ||
        productType === 'Produk Praktis' ||
        searchQueries.length === 0
      ) {
        continue;
      }

      return {
        keyword,
        title: titleCandidate,
        description: descCandidate || `Produk bermerek: ${titleCandidate}.`,
        url: result.url,
        imageUrl: pageMeta.imageUrl || result.thumbnail || '',
        brand,
        model,
        productType,
        searchQueries,
        brandedVerified: true,
      };
    }
  } catch (err) {
    console.warn(`[Discovery] Search engine lookup failed for "${keyword}":`, err.message);
  }

  // Never fabricate a product from a generic keyword. OEM/unbranded results are
  // intentionally rejected and must be supplied through the manual OEM flow.
  return null;
}

const brandedDiscoveryMisses = new Map();
const BRANDED_DISCOVERY_MISS_COOLDOWN_MS = 15 * 60 * 1000;
const BRANDED_DISCOVERY_MAX_BRANDS_PER_PASS = 4;

function isBrandedSeedOnCooldown(brandSeed) {
  const until = Number(brandedDiscoveryMisses.get(String(brandSeed || '').toLowerCase()) || 0);
  return until > Date.now();
}

function markBrandedSeedMiss(brandSeed) {
  const key = String(brandSeed || '').trim().toLowerCase();
  if (!key) return;
  brandedDiscoveryMisses.set(key, Date.now() + BRANDED_DISCOVERY_MISS_COOLDOWN_MS);
}

export async function discoverBrandedShopeeProduct({
  niche = 'kitchen_tools',
  seen = new Set(),
  attemptedBrands = new Set(),
} = {}) {
  const preset = getNichePreset(niche);
  const isGadget = preset?.id === 'gadget_smartphone';

  // Brand-first discovery. No OEM keyword generator and no product-only query.
  const brandSeeds = isGadget
    ? ['Samsung', 'Xiaomi', 'Redmi', 'POCO', 'OPPO', 'vivo', 'realme', 'Infinix', 'TECNO']
    : ['Maspion', 'Oxone', 'Cosmos', 'Miyako', 'Kirin', 'Philips', 'Tefal', 'Maxim', 'LocknLock', 'BOLDe', 'Mito', 'Han River'];

  const normalizedAttempted = attemptedBrands instanceof Set
    ? attemptedBrands
    : new Set(Array.isArray(attemptedBrands) ? attemptedBrands : []);

  const candidates = [...brandSeeds]
    .filter((brand) => {
      const key = String(brand).trim().toLowerCase();
      return !normalizedAttempted.has(key) && !isBrandedSeedOnCooldown(brand);
    })
    .sort(() => Math.random() - 0.5)
    .slice(0, BRANDED_DISCOVERY_MAX_BRANDS_PER_PASS);

  if (!candidates.length) {
    console.log('[BrandedDiscovery] Semua merk kandidat sedang dalam cooldown; tidak mengulang pencarian yang sama.');
    return null;
  }

  for (const brandSeed of candidates) {
    const brandKey = String(brandSeed).trim().toLowerCase();
    normalizedAttempted.add(brandKey);

    const query = 'site:shopee.co.id "' + brandSeed + '" -set -pack -paket -bundle';
    const results = (await searchRawShopeeWeb(query))
      .filter((r) =>
        r?.url &&
        !seen.has(r.url) &&
        !isBundleOrSetProduct((r.title || '') + ' ' + (r.snippet || '')) &&
        !isFoodOrBeverageProduct((r.title || '') + ' ' + (r.snippet || ''))
      );

    console.log('[BrandedDiscovery] brand=' + brandSeed + ' candidates=' + results.length);

    for (const result of results.slice(0, 12)) {
      seen.add(result.url);

      let meta = {};
      try {
        meta = await fetchShopeePageMeta(result.url);
      } catch {
        meta = {};
      }

      const rawTitle = String(meta.title || result.title || '').trim();
      const description = cleanDescription(meta.description || result.snippet || '');
      if (!rawTitle || isGenericShopeeTitle(rawTitle) || isBundleOrSetProduct(rawTitle)) continue;

      const title = cleanTitle(rawTitle, result.url);
      if (!title || isGenericShopeeTitle(title)) continue;

      const info = extractCoreProductInfo(
        title,
        description,
        result.url,
        meta.brand || brandSeed
      );

      const brand = String(info?.brand || meta.brand || brandSeed).trim();
      const productType = String(info?.coreProductNoun || '').trim();
      const model = String(info?.model || '').trim();
      const searchQueries = Array.isArray(info?.searchQueries)
        ? info.searchQueries.filter((q) => /\S/.test(String(q || '')))
        : [];

      const titleNorm = normalizeText(title);
      const descriptionNorm = normalizeText(description);
      const seedNorm = normalizeText(brandSeed);
      const brandAppearsInListing =
        titleNorm.includes(seedNorm) ||
        descriptionNorm.includes(seedNorm) ||
        normalizeText(meta.brand || '').includes(seedNorm);

      const brandNorm = normalizeText(brand);
      const productTypeNorm = normalizeText(productType);
      const modelNorm = normalizeText(model);

      if (
        !brand ||
        !brandAppearsInListing ||
        !productType ||
        productType === 'Produk Praktis' ||
        !productTypeNorm ||
        productTypeNorm === brandNorm ||
        (modelNorm && productTypeNorm === modelNorm) ||
        !searchQueries.length
      ) {
        continue;
      }

      brandedDiscoveryMisses.delete(brandKey);
      console.log(
        '[BrandedDiscovery] ✅ Branded product found: ' +
        brand + ' | ' + productType + ' | ' + (model || 'no-model')
      );

      return {
        keyword: brandSeed,
        title,
        description,
        url: result.url,
        imageUrl: meta.imageUrl || result.thumbnail || '',
        brand,
        model,
        productType,
        searchQueries,
        brandedVerified: true,
      };
    }

    markBrandedSeedMiss(brandSeed);
    console.log(
      '[BrandedDiscovery] Merk "' + brandSeed +
      '" tidak menghasilkan listing bermerek + type yang valid; cooldown ' +
      Math.round(BRANDED_DISCOVERY_MISS_COOLDOWN_MS / 60000) + ' menit.'
    );
  }

  return null;
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
  limit = 16,
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
    // 1. Prioritize Bing Video search (100% safe from YouTube bot detection & IP blocking)
    let rawResults = await searchBingVideos(query, { limit, onProgress });
    if (!rawResults || rawResults.length === 0) {
      // 2. Fallback to YouTube search with anti-bot pacing
      rawResults = await searchYouTubeVideos(query, { limit, onProgress });
    }

    if (rawResults && rawResults.length) {
      // Filter out videos that have already been processed in past or current jobs
      const freshResults = rawResults.filter((c) => {
        const vid = c.id || extractVideoId(c.url);
        return vid && !excludeSet.has(vid);
      });

      // Only accept if the query produced compliant candidate(s) (5-15 min, faceless, multi-word matching)
      const cleanResults = freshResults.filter((c) => isLikelyCleanYouTubeCandidate(c, coreWords));

      if (cleanResults.length > 0) {
        candidates = cleanResults;
        usedQuery = query;
        break;
      }
    }
    await delayWithJitter(1500, 2500);
  }

  // Fallback: If all results were previously used or cleanResults was empty, search exact core noun
  if (!candidates.length) {
    let fallbackResults = await searchBingVideos(`${coreNoun} "b-roll"`, { limit, onProgress });
    if (!fallbackResults || fallbackResults.length === 0) {
      fallbackResults = await searchYouTubeVideos(`${coreNoun} "b-roll"`, { limit, onProgress });
    }
    const nonExcluded = (fallbackResults || []).filter((c) => {
      const vid = c.id || extractVideoId(c.url);
      return vid && !excludeSet.has(vid) && isLikelyCleanYouTubeCandidate(c, coreWords);
    });
    candidates = nonExcluded;
  }

  const scoredCandidates = candidates
    .filter((candidate) => isLikelyCleanYouTubeCandidate(candidate, coreWords))
    .map((candidate) => ({
      ...candidate,
      searchQuery: usedQuery,
      coreProductNoun: coreNoun,
      matchScore: scoreCandidateMatch(candidate, coreWords, productDescription),
    }));

  // Keyword discovery must have a textual product signal before it reaches expensive
  // visual analysis. Visual-search candidates are the only exception because the
  // physical reference image is the primary matching signal there.
  const visualCandidates = scoredCandidates.filter(
    (c) => Boolean(c.isVisualSearch || c.source === 'bing_visual_search' || c.source === 'visual_ai_query')
  );
  const matchedCandidates = scoredCandidates.filter((c) => c.matchScore > 0);
  const cleanCandidates = [...matchedCandidates, ...visualCandidates.filter((c) => c.matchScore <= 0)]
    .sort((a, b) => b.matchScore - a.matchScore);

  // Never leak a keyword-search candidate with zero product signal.
  return cleanCandidates;
}

/**
 * Scrapes Bing Videos for high-quality demonstration candidates matching the query.
 * Bing Video Search returns rich metadata: video title, duration, uploader, and direct YouTube URLs.
 */
export async function searchBingVideos(query, { limit = 20, onProgress = () => {} } = {}) {
  const cleanQuery = buildCleanYouTubeQuery(query);
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 20));
  const url = `https://www.bing.com/videos/search?q=${encodeURIComponent(cleanQuery)}&qft=+filterui:duration-medium+filterui:video-definition-high`;

  onProgress({
    step: 'auto_video_search',
    message: `Mencari video via Bing Video: "${cleanQuery}"...`,
    progress: 8,
  });

  try {
    const res = await fetchWithTlsFallback(url, {
      timeoutMs: 4000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (!res || !res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const candidates = [];
    const seenIds = new Set();

    $('div.mc_vtvc, div.vrwrap, [data-vid], li.b_algo').each((_, el) => {
      const $el = $(el);
      const htmlSnippet = $el.html() || '';
      const m = htmlSnippet.match(/(?:watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (!m) return;
      const id = m[1];
      if (seenIds.has(id)) return;
      seenIds.add(id);

      const ariaLabel = $el.find('a[aria-label]').attr('aria-label') || '';
      const rawTitle = $el.find('.b_tit, .vtru_title, .title').first().text().trim() || $el.find('a').first().text().trim();

      let title = rawTitle;
      let durationSec = 0;
      let channel = '';

      if (ariaLabel) {
        const titleMatch = ariaLabel.match(/^(.*?)(?:\s+dari\s+YouTube|\s+from\s+YouTube|\s+·)/i);
        if (titleMatch && titleMatch[1].trim()) {
          title = titleMatch[1].trim();
        }

        const durMinSec = ariaLabel.match(/(?:Durasi|Duration):\s*(\d+)\s*(?:menit|min|m)(?:\s*(\d+)\s*(?:detik|sec|s))?/i);
        const durSecOnly = ariaLabel.match(/(?:Durasi|Duration):\s*(\d+)\s*(?:detik|sec|s)/i);
        if (durMinSec) {
          durationSec = Number(durMinSec[1]) * 60 + (Number(durMinSec[2]) || 0);
        } else if (durSecOnly) {
          durationSec = Number(durSecOnly[1]);
        }

        const uploaderMatch = ariaLabel.match(/(?:uploaded by|diunggah oleh)\s+([^·\.]+)/i);
        if (uploaderMatch) channel = uploaderMatch[1].trim();
      }

      // Filter out videos with known duration < 2.5 min (150s) or > 10 min (600s)
      if (durationSec > 0 && (durationSec < 150 || durationSec > 600)) return;

      // Filter out videos with banned / tutorial / DIY / repair keywords
      if (/\b(cara|tutorial|diy|how\s+to|do\s+it\s+yourself|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|ganti|repair|reparasi|bongkar)\b/i.test(title)) return;

      candidates.push({
        id,
        title: title || query,
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: durationSec,
        channel,
        source: 'bing_video',
      });

      if (candidates.length >= safeLimit) return false;
    });

    if (candidates.length < safeLimit) {
      const ytRegex = /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g;
      let rm;
      while ((rm = ytRegex.exec(html)) !== null && candidates.length < safeLimit) {
        const id = rm[1];
        if (!seenIds.has(id)) {
          seenIds.add(id);
          candidates.push({
            id,
            title: query,
            url: `https://www.youtube.com/watch?v=${id}`,
            duration: 0,
            channel: '',
            source: 'bing_video',
          });
        }
      }
    }

    return candidates;
  } catch (err) {
    console.warn(`[Discovery] Bing Video search notice: ${err.message}`);
    return [];
  }
}

/**
 * Searches video demonstration candidates across search engines (YouTube & Bing Videos).
 * Deduplicates by video ID, filters out previously used videos, and applies Stage 1 metadata filters.
 */
export async function searchMultiEngineVideos(query, {
  limit = 20,
  excludeVideoIds = new Set(),
  onProgress = () => {},
  strictIdentity = false,
} = {}) {
  const excludeSet = excludeVideoIds instanceof Set ? excludeVideoIds : new Set(excludeVideoIds || []);
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 20));

  onProgress({
    step: 'auto_video_search',
    message: `Mencari video di mesin telusur (YouTube & Bing) untuk: "${query}"...`,
    progress: 5,
  });

  const allCandidates = [];
  const seenIds = new Set(excludeSet);

  // 1. Query YouTube (Native Web Search + yt-dlp)
  try {
    const ytResults = await searchYouTubeVideos(query, { limit: safeLimit, onProgress });
    if (Array.isArray(ytResults)) {
      for (const item of ytResults) {
        const vid = item.id || extractVideoId(item.url);
        if (vid && !seenIds.has(vid)) {
          seenIds.add(vid);
          allCandidates.push({ ...item, id: vid, source: 'youtube' });
        }
      }
    }
  } catch (err) {
    console.warn(`[MultiEngineVideo] YouTube search error: ${err.message}`);
  }

  // 2. Query Bing Videos (Fast, independent video index)
  try {
    const bingResults = await searchBingVideos(query, { limit: safeLimit, onProgress });
    if (Array.isArray(bingResults)) {
      for (const item of bingResults) {
        const vid = item.id || extractVideoId(item.url);
        if (vid && !seenIds.has(vid)) {
          seenIds.add(vid);
          allCandidates.push({ ...item, id: vid, source: 'bing_video' });
        }
      }
    }
  } catch (err) {
    console.warn(`[MultiEngineVideo] Bing Video search error: ${err.message}`);
  }

  // 2B. Generic core-noun fallback is forbidden in strict identity mode.
  // It can turn a branded query back into broad OEM/generic searches.
  if (allCandidates.length === 0 && !strictIdentity) {
    try {
      const coreInfo = extractCoreProductInfo(query);
      const coreQuery = coreInfo?.coreProductNoun;
      if (coreQuery && coreQuery.toLowerCase() !== query.toLowerCase() && coreQuery.split(' ').length < query.split(' ').length) {
        console.log(`[MultiEngineVideo] Query awal panjang tidak menemukan hasil, mencoba core product noun: "${coreQuery}"`);
        const ytCoreResults = await searchYouTubeVideos(coreQuery, { limit: safeLimit, onProgress });
        if (Array.isArray(ytCoreResults)) {
          for (const item of ytCoreResults) {
            const vid = item.id || extractVideoId(item.url);
            if (vid && !seenIds.has(vid)) {
              seenIds.add(vid);
              allCandidates.push({ ...item, id: vid, source: 'youtube' });
            }
          }
        }
      }
    } catch (coreErr) {
      console.warn(`[MultiEngineVideo] Core noun YouTube search notice: ${coreErr.message}`);
    }
  }

  // 3. Extract the product family from the actual search query. This is the
  // semantic guardrail for auto-search: a result must still mention the target
  // product family in its title/description unless it came from visual search.
  const queryInfo = extractCoreProductInfo(query);
  const ignoredQueryWords = new Set(['watermark', 'lyric', 'subtitle', 'logo', 'intro', 'overlay', 'cara', 'tutorial', 'diy', 'how', 'unboxing', 'perbaikan', 'penggantian', 'pergantian', 'mengganti', 'rusak', 'service', 'servis', 'ganti', 'repair', 'reparasi', 'bongkar', 'roll', 'footage', 'version', 'graphics', 'clean', 'raw', 'review', 'demo', 'test', 'produk']);
  const queryWords = (queryInfo?.coreWords || normalizeText(query).split(' '))
    .map((w) => normalizeText(w))
    .filter((w) => w.length >= 3 && !ignoredQueryWords.has(w));

  // In strict identity mode, preserve the exact brand/model/type signal in the
  // query and never allow a broad product-family fallback to pass.
  if (strictIdentity) {
    const identityInfo = extractDynamicProductIdentity(query);
    const identityTokens = [identityInfo.brand, identityInfo.model]
      .filter(Boolean)
      .map((v) => normalizeText(v))
      .filter((v) => v.length >= 2);
    if (identityTokens.length === 0) return [];
    const strictCandidates = allCandidates.filter((candidate) => {
      const text = normalizeText(`${candidate.title || ''} ${candidate.description || ''}`);
      return identityTokens.some((token) => text.includes(token));
    });
    allCandidates.length = 0;
    allCandidates.push(...strictCandidates);
  }

  // 4. Filter through Stage 1 Metadata Pre-filter.
  const metadataClean = allCandidates.filter((candidate) => isLikelyCleanYouTubeCandidate(candidate, queryWords));

  // 5. Rank by actual target-product signal, then refuse zero-match keyword results.
  const ranked = metadataClean
    .map((candidate) => ({
      ...candidate,
      matchScore: scoreCandidateMatch(candidate, queryWords, queryInfo?.cleanTitle || query),
    }))
    .filter((candidate) => {
      const isVisual = Boolean(candidate.isVisualSearch || candidate.source === 'bing_visual_search' || candidate.source === 'visual_ai_query');
      return isVisual || candidate.matchScore > 0;
    })
    .sort((a, b) => b.matchScore - a.matchScore);

  console.log(`[MultiEngineVideo] Ditemukan ${allCandidates.length} total video (${ranked.length} lolos filter metadata + product-match) untuk: "${query}"`);
  return ranked.slice(0, safeLimit);
}

/**
 * ── PENCARIAN VISUAL (REVERSE IMAGE SEARCH) VIA BING ──────────────────────────
 * Menggunakan URL gambar produk untuk mencari halaman & link video yang memuat gambar yang sama.
 */
export async function searchBingVisualSearch(imageUrl, { limit = 10, onProgress = () => {} } = {}) {
  if (!imageUrl || typeof imageUrl !== 'string') return { candidates: [], visualTags: [] };

  onProgress({
    step: 'visual_search_bing',
    message: 'Mencari video via Bing Visual Search (Reverse Image Search)...',
    progress: 8,
  });

  const targetUrl = `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(imageUrl)}`;
  try {
    const res = await fetchWithTlsFallback(targetUrl, {
      timeoutMs: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    if (!res || !res.ok) return { candidates: [], visualTags: [] };

    const html = await res.text();
    const $ = cheerio.load(html);

    const candidates = [];
    const seenVids = new Set();

    // 1. Cari link video YouTube langsung dari hasil halaman visual search
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      const vid = extractVideoId(href);
      if (vid && !seenVids.has(vid)) {
        seenVids.add(vid);
        candidates.push({
          id: vid,
          url: `https://www.youtube.com/watch?v=${vid}`,
          title: text || 'Video dari Pencarian Visual Produk',
          duration: 180,
          source: 'bing_visual_search',
        });
      }
    });

    // 2. Kumpulkan visual tags yang dikenali oleh Bing
    const visualTags = [];
    $('.tag, a.tag, .b_visualSearchTitle, .b_focusText').each((i, el) => {
      const tagText = $(el).text().trim();
      if (tagText && tagText.length >= 3 && !visualTags.includes(tagText)) {
        visualTags.push(tagText);
      }
    });

    return { candidates: candidates.slice(0, limit), visualTags };
  } catch (err) {
    console.warn(`[BingVisualSearch] Gagal melakukan pencarian gambar: ${err.message}`);
    return { candidates: [], visualTags: [] };
  }
}

/**
 * ── ANALISIS GAMBAR PRODUK VIA GEMINI VISION (IMAGE-TO-QUERY) ─────────────────
 * Membaca foto produk fisik untuk mengekstrak nama produk universal (bahasa Inggris/global)
 * dan 3 query pencarian YouTube yang presisi untuk menemukan video demonstrasi hands-on.
 */
export async function extractVisualKeywordsWithAI({ imageUrl, productTitle = '' } = {}) {
  if (!imageUrl || typeof imageUrl !== 'string') return [];

  try {
    const rawApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    if (!rawApiKey) return [];

    const imgRes = await fetchWithTlsFallback(imageUrl, {
      timeoutMs: 5000,
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!imgRes || !imgRes.ok) return [];

    const arrayBuffer = await imgRes.arrayBuffer();
    const imgBuffer = Buffer.from(arrayBuffer);
    if (imgBuffer.length < 500) return [];

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';
    const base64Data = imgBuffer.toString('base64');

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(rawApiKey);
    const candidateModels = [
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash'
    ];

    const prompt = `Analisa gambar produk fisik ini dengan sangat teliti untuk keperluan pencarian footage demonstrasi produk di YouTube.
Judul referensi (jika ada): "${productTitle}"

Tugas:
1. Identifikasi nama benda/gadget fisik ini dalam bahasa Inggris universal (nama produk OEM/pabrik yang biasa dipakai reviewer global di YouTube/Amazon/AliExpress).
2. Buat 4 frasa pencarian YouTube paling efektif dalam bahasa Inggris untuk menemukan footage produk yang bersih, jernih, dan sinematik:
   - WAJIB kombinasikan nama produk dengan kata kunci aset mentah: "raw footage", "b-roll", "textless", "clean version", "no graphics".
   - DILARANG KERAS menggunakan kata kunci: cara, tutorial, diy, how to, unboxing, perbaikan, penggantian, rusak, service, servis, ganti, repair, haul, vlog, review wajah.
   - Hindari kata-kata promo belanja seperti: COD, murah, promo, terlaris, diskon.

Keluarkan JSON dengan format persis:
{
  "detectedProductEnglish": "<nama produk universal bahasa Inggris>",
  "searchQueries": [
    "<query 1>",
    "<query 2>",
    "<query 3>",
    "<query 4>"
  ]
}`;

    for (const modelName of candidateModels) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        });

        const result = await model.generateContent([
          prompt,
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          }
        ]);

        const text = result?.response?.text();
        if (text) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed.searchQueries) && parsed.searchQueries.length > 0) {
            return parsed.searchQueries;
          }
        }
      } catch (mErr) {
        // try next candidate model
      }
    }
    return [];
  } catch (err) {
    console.warn(`[VisualSearchAI] Gagal menganalisa gambar dengan AI: ${err.message}`);
    return [];
  }
}

/**
 * ── ORKESTRATOR UTAMA PENCARIAN VIDEO BERBASIS GAMBAR (VISUAL SEARCH) ─────────
 * Menggabungkan Bing Visual Search (Reverse Image Lookup) dan Gemini Vision (Image-to-Query)
 * dengan Multi-Engine Video Search untuk menemukan kandidat video YouTube terbaik.
 */
export async function searchVideosByProductImage({
  imageUrl,
  productTitle = '',
  productDescription = '',
  limit = 20,
  excludeVideoIds = new Set(),
  onProgress = () => {},
} = {}) {
  const excludeSet = excludeVideoIds instanceof Set ? excludeVideoIds : new Set(excludeVideoIds || []);
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 20));

  onProgress({
    step: 'visual_video_search',
    message: `Memulai pencarian video berbasis gambar produk (${productTitle ? productTitle.slice(0, 30) : 'foto produk'})...`,
    progress: 10,
  });

  const candidates = [];
  const seenIds = new Set(excludeSet);

  // 1. Jalankan Bing Visual Search (Reverse Image Lookup)
  if (imageUrl) {
    try {
      const { candidates: bingVisualCandidates, visualTags } = await searchBingVisualSearch(imageUrl, {
        limit: safeLimit,
        onProgress
      });

      for (const c of bingVisualCandidates) {
        if (!seenIds.has(c.id)) {
          seenIds.add(c.id);
          candidates.push({ ...c, isVisualSearch: true });
        }
      }

      if (Array.isArray(visualTags) && visualTags.length > 0 && candidates.length < safeLimit) {
        console.log(`[VisualSearch] Bing Visual Tags terdeteksi: ${visualTags.slice(0, 3).join(', ')}`);
        for (const tag of visualTags.slice(0, 2)) {
          if (candidates.length >= safeLimit) break;
          const tagVideos = await searchMultiEngineVideos(`${tag} "b-roll"`, {
            limit: 8,
            excludeVideoIds: seenIds,
            onProgress
          });
          for (const tv of tagVideos) {
            if (!seenIds.has(tv.id)) {
              seenIds.add(tv.id);
              candidates.push({ ...tv, isVisualSearch: true });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[VisualSearch] Bing Visual Search error: ${err.message}`);
    }
  }

  // 2. Jalankan Gemini Vision (Image-to-Query) jika kandidat masih kurang
  if (imageUrl && candidates.length < safeLimit) {
    onProgress({
      step: 'visual_ai_keywords',
      message: 'AI Vision menganalisis bentuk fisik produk untuk menemukan video YouTube global...',
      progress: 20,
    });

    try {
      const visualQueries = await extractVisualKeywordsWithAI({
        imageUrl,
        productTitle
      });

      if (Array.isArray(visualQueries) && visualQueries.length > 0) {
        console.log(`[VisualSearch] Gemini Vision menghasilkan query pencarian:`, visualQueries);

        for (const query of visualQueries) {
          if (candidates.length >= safeLimit) break;
          const multiResults = await searchMultiEngineVideos(query, {
            limit: 10,
            excludeVideoIds: seenIds,
            onProgress: (p) => onProgress({
              step: 'visual_multi_search',
              message: `Pencarian visual: "${query}" (${p.message})`,
              progress: 25,
            }),
          });

          for (const item of multiResults) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              candidates.push({ ...item, source: 'visual_ai_query', isVisualSearch: true });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[VisualSearch] Gemini Visual Keywords error: ${err.message}`);
    }
  }

  console.log(`[VisualSearch] Selesai: Ditemukan ${candidates.length} video kandidat melalui pencarian visual gambar.`);
  return candidates.slice(0, safeLimit);
}

export function delayWithJitter(minMs, maxMs) {
  const min = Number(minMs) || 0;
  const max = Math.max(min, Number(maxMs) || min);
  const duration = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((resolve) => setTimeout(resolve, duration));
}

export async function searchShopeeProducts(keyword) {
  // 1. Prioritas Utama: Bing Search (sangat responsif ~200-350ms di VPS, tidak memblokir IP Datacenter)
  try {
    const bingResults = await searchBingShopee(keyword);
    if (bingResults && bingResults.length > 0) return bingResults;
  } catch (e) {
    // continue to next engine
  }

  // 2. Prioritas Kedua: Brave Search (fallback cepat ~200ms)
  try {
    const braveResults = await searchBraveShopee(keyword);
    if (braveResults && braveResults.length > 0) return braveResults;
  } catch (e) {
    // continue to next engine
  }

  // 3. Prioritas Ketiga: DuckDuckGo (timeout ketat 1.5 detik agar tidak pernah freeze)
  try {
    const ddgResults = await searchDuckDuckGoShopee(keyword);
    if (ddgResults && ddgResults.length > 0) return ddgResults;
  } catch (e) {
    // continue to fallback
  }

  return [];
}

export async function searchDuckDuckGoShopee(keyword) {
  const cleanKeyword = String(keyword || '').replace(/\s+/g, ' ').trim();
  const searchQueries = [
    `"${cleanKeyword}" alat dapur site:shopee.co.id`,
    `${cleanKeyword} alat dapur site:shopee.co.id`,
  ];

  for (const searchQuery of searchQueries) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      const response = await fetchWithTlsFallback(url, {
        timeoutMs: 1500,
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response || !response.ok) continue;

      const html = await response.text();
      if (html.includes('internetbaik.telkomsel.com') || html.includes('blocked') || html.includes('anomaly')) continue;

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
      // Continue to next query
    }
  }

  return [];
}

export async function searchBraveShopee(keyword) {
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

  return [];
}

export async function searchBingShopee(keyword) {
  for (const searchQuery of buildShopeeSearchQueries(keyword)) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}`;
    try {
      const response = await fetchWithTlsFallback(url, {
        timeoutMs: 2500,
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


export function isShopeeDiscoveryUrl(url = '') {
  if (!url) return false;
  if (isShopeeProductUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'shopee.co.id') return false;

    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (/^\/(?:search|cart|buyer|list|mall)(?:\/|$)/.test(path)) return true;
    if (/^\/shop\/\d+(?:\/|$)/.test(path)) return true;

    // Shopee official/brand storefronts commonly use a vanity path such as
    // /miyako.official.store. Treat those as discovery pages and expand them.
    if (path.split('/').filter(Boolean).length === 1 && path !== '/') {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function dedupeShopeeSearchResults(results = []) {
  const seen = new Set();
  const output = [];

  for (const item of results) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push({
      title: String(item?.title || '').trim(),
      snippet: String(item?.snippet || '').trim(),
      url,
    });
  }

  return output;
}

function extractShopeeProductCandidatesFromHtml(html = '', limit = 20) {
  // Search engines and embedded JSON frequently escape forward slashes as
  // "\\/" and HTML-escape ampersands. Normalize those representations first.
  const source = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');

  const results = [];
  const seen = new Set();
  const patterns = [
    /https?:\/\/(?:www\.)?shopee\.co\.id\/[^"'\s<>]+/gi,
    /(?:^|[^a-z0-9])(?:www\.)?shopee\.co\.id\/[^"'\s<>]+/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null && results.length < limit) {
      let rawUrl = match[0];
      rawUrl = rawUrl.replace(/^[^h]*(?=https?:\/\/)/i, '');
      if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = `https://${rawUrl.replace(/^\/+/, '')}`;
      }

      const url = normalizeSearchResultUrl(rawUrl);
      if (!isShopeeProductUrl(url) || seen.has(url)) continue;

      seen.add(url);
      results.push({
        title: titleFromShopeeUrl(url),
        snippet: '',
        url,
      });
    }
    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

function mergeShopeeCandidates(primary = [], fallback = [], limit = 20) {
  const output = [];
  const seen = new Set();

  for (const item of [...primary, ...fallback]) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(item);
    if (output.length >= limit) break;
  }

  return output;
}

async function expandShopeeDiscoveryPage(url, { limit = 20 } = {}) {
  if (!isShopeeDiscoveryUrl(url)) return [];
  if (isShopeeRequestBlocked()) return [];

  try {
    const response = await fetchWithTlsFallback(url, {
      timeoutMs: 7000,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (!response?.ok) {
      console.warn(`[BrandedDiscovery] Shopee discovery page HTTP ${response?.status || 'unknown'}: ${url}`);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    const addProduct = (rawHref, anchorEl = null) => {
      const productUrl = normalizeSearchResultUrl(rawHref);
      if (!isShopeeProductUrl(productUrl) || seen.has(productUrl)) return;

      seen.add(productUrl);
      const anchorText = anchorEl ? $(anchorEl).text().replace(/\s+/g, ' ').trim() : '';
      const parentText = anchorEl
        ? $(anchorEl).closest('[data-sqe], [data-sqe="item"], [data-testid], li, article, div').text().replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';

      results.push({
        title: anchorText.slice(0, 220),
        snippet: parentText.slice(0, 500),
        url: productUrl,
      });
    };

    $('a[href]').each((_, element) => {
      addProduct($(element).attr('href'), element);
      if (results.length >= limit) return false;
    });

    const embedded = extractShopeeProductCandidatesFromHtml(html, limit);
    return mergeShopeeCandidates(dedupeShopeeSearchResults(results), embedded, limit);
  } catch (err) {
    console.warn(`[BrandedDiscovery] Failed expanding Shopee discovery page ${url}: ${err.message}`);
    return [];
  }
}

async function expandShopeeSearchResults(results = [], { limit = 20 } = {}) {
  const direct = [];
  const discoveryPages = [];

  for (const result of results) {
    if (isShopeeProductUrl(result?.url)) {
      direct.push(result);
    } else if (isShopeeDiscoveryUrl(result?.url)) {
      discoveryPages.push(result);
    }
  }

  const output = dedupeShopeeSearchResults(direct).slice(0, limit);
  if (output.length >= limit || discoveryPages.length === 0) {
    return output.slice(0, limit);
  }

  const remaining = Math.max(1, limit - output.length);
  const pages = discoveryPages.slice(0, 4);

  const expanded = await Promise.all(
    pages.map((page) => expandShopeeDiscoveryPage(page.url, {
      limit: Math.min(remaining, 12),
    }))
  );

  for (const items of expanded.flat()) {
    if (!output.some((item) => item.url === items.url)) {
      output.push(items);
      if (output.length >= limit) break;
    }
  }

  return output.slice(0, limit);
}

function buildRawShopeeQueryVariants(cleanQuery) {
  const variants = [];
  const add = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized && !variants.includes(normalized)) variants.push(normalized);
  };

  const quotedBrand = [...String(cleanQuery || '').matchAll(/"([^"]{2,80})"/g)]
    .map((match) => match[1].trim())
    .find(Boolean);

  add(cleanQuery);

  const withoutNegativeOperators = String(cleanQuery || '')
    .replace(/\s+-[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  add(withoutNegativeOperators);

  if (quotedBrand) {
    add('"' + quotedBrand + '" Shopee Indonesia');
  }

  return variants.slice(0, 3);
}

let shopeeRequestBlockedUntil = 0;
const SHOPEE_REQUEST_BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

function isShopeeRequestBlocked() {
  return Date.now() < shopeeRequestBlockedUntil;
}

function markShopeeRequestsBlocked(reason = '') {
  shopeeRequestBlockedUntil = Date.now() + SHOPEE_REQUEST_BLOCK_COOLDOWN_MS;
  console.warn(
    '[BrandedDiscovery] Shopee server-side access temporarily blocked for ' +
    Math.round(SHOPEE_REQUEST_BLOCK_COOLDOWN_MS / 60000) +
    ' minutes' +
    (reason ? ' (' + reason + ')' : '') +
    '. Using external indexed search only.'
  );
}

async function searchShopeePublicApi(brand, { limit = 20 } = {}) {
  const cleanBrand = String(brand || '')
    .replace(/[^\p{L}\p{N} ._&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanBrand || isShopeeRequestBlocked()) return [];

  const safeLimit = Math.min(30, Math.max(1, Number(limit) || 20));
  const endpoints = [
    'https://shopee.co.id/api/v4/search/search_items?by=relevancy&keyword=' +
      encodeURIComponent(cleanBrand) +
      '&limit=' + safeLimit +
      '&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2',
    'https://shopee.co.id/api/v4/search/search_page_common?keyword=' +
      encodeURIComponent(cleanBrand),
  ];

  const compact = (value) =>
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');

  const brandCompact = compact(cleanBrand);

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTlsFallback(endpoint, {
        timeoutMs: 7000,
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'application/json,text/plain,*/*',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'referer': 'https://shopee.co.id/',
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
        },
      });

      const status = Number(response?.status || 0);
      if (!response?.ok) {
        console.warn('[BrandedDiscovery] Shopee API HTTP ' + (status || 'unknown') + ' for "' + cleanBrand + '"');

        if (status === 403 || status === 429) {
          markShopeeRequestsBlocked('HTTP ' + status);
          break;
        }

        continue;
      }

      const rawBody = await response.text();
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        console.warn('[BrandedDiscovery] Shopee API returned non-JSON for "' + cleanBrand + '"');
        continue;
      }

      const items =
        (Array.isArray(payload?.items) && payload.items) ||
        (Array.isArray(payload?.data?.items) && payload.data.items) ||
        (Array.isArray(payload?.data?.items_response?.items) && payload.data.items_response.items) ||
        [];

      if (!items.length) {
        console.warn('[BrandedDiscovery] Shopee API returned 0 items for "' + cleanBrand + '"');
        continue;
      }

      const results = [];

      for (const entry of items) {
        const item =
          entry?.item_basic ||
          entry?.item ||
          entry?.item_data ||
          entry ||
          {};

        const shopId = item?.shopid ?? item?.shop_id ?? entry?.shopid ?? entry?.shop_id;
        const itemId = item?.itemid ?? item?.item_id ?? entry?.itemid ?? entry?.item_id;
        const name = String(
          item?.name ||
          item?.item_card_displayed_asset?.name ||
          item?.item_card_displayed_asset?.item_name ||
          entry?.name ||
          ''
        ).replace(/\s+/g, ' ').trim();

        if (!name || !/^\d+$/.test(String(shopId)) || !/^\d+$/.test(String(itemId))) {
          continue;
        }

        const imageKey =
          item?.image ||
          item?.item_card_displayed_asset?.image ||
          '';

        results.push({
          title: name,
          snippet: String(item?.description || entry?.description || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500),
          url: 'https://shopee.co.id/product/' + shopId + '/' + itemId,
          imageUrl: imageKey
            ? 'https://down-id.img.susercontent.com/file/' + imageKey
            : '',
        });

        if (results.length >= safeLimit) break;
      }

      const usable = results.filter((item) => compact(item.title).includes(brandCompact));
      if (usable.length) {
        console.log(
          '[BrandedDiscovery] Shopee API returned ' + usable.length +
          ' branded product(s): "' + cleanBrand + '"'
        );
        return usable;
      }

      console.warn(
        '[BrandedDiscovery] Shopee API returned ' + results.length +
        ' products but none matched brand "' + cleanBrand + '"'
      );
    } catch (err) {
      console.warn('[BrandedDiscovery] Shopee API failed for "' + cleanBrand + '": ' + err.message);
    }
  }

  return [];
}

export async function searchRawShopeeWeb(query) {
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
  if (!cleanQuery) return [];

  const quotedBrand = [...cleanQuery.matchAll(/"([^"]{2,80})"/g)]
    .map((match) => match[1].trim())
    .find(Boolean);

  if (quotedBrand) {
    const apiResults = await searchShopeePublicApi(quotedBrand, { limit: 20 });
    if (apiResults.length) return apiResults;
  }

  const queryVariants = buildRawShopeeQueryVariants(cleanQuery);

  const engines = [
    {
      name: 'Google',
      run: async (engineQuery) => {
        const url = 'https://www.google.com/search?q=' + encodeURIComponent(engineQuery) + '&num=20&hl=id';
        const response = await fetchWithTlsFallback(url, {
          timeoutMs: 8000,
          headers: {
            'user-agent': USER_AGENT,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          },
        });
        if (!response?.ok) return [];

        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];

        $('a[href]').each((_, element) => {
          const targetUrl = normalizeSearchResultUrl($(element).attr('href'));
          if (!isShopeeProductUrl(targetUrl) && !isShopeeDiscoveryUrl(targetUrl)) return;
          results.push({
            title: $(element).text().trim(),
            snippet: $(element).closest('div').text().replace(/\s+/g, ' ').trim().slice(0, 500),
            url: targetUrl,
          });
        });

        const embedded = extractShopeeProductCandidatesFromHtml(html, 20);
        return expandShopeeSearchResults(
          mergeShopeeCandidates(results, embedded, 20),
          { limit: 20 }
        );
      },
    },
    {
      name: 'Bing',
      run: async (engineQuery) => {
        const url = 'https://www.bing.com/search?q=' + encodeURIComponent(engineQuery);
        const response = await fetchWithTlsFallback(url, {
          timeoutMs: 8000,
          headers: {
            'user-agent': USER_AGENT,
            'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          },
        });
        if (!response?.ok) return [];

        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];

        $('li.b_algo').each((_, element) => {
          const anchor = $(element).find('h2 a').first();
          const targetUrl = normalizeSearchResultUrl(anchor.attr('href'));
          if (!isShopeeProductUrl(targetUrl) && !isShopeeDiscoveryUrl(targetUrl)) return;
          results.push({
            title: anchor.text().trim(),
            snippet: $(element).find('.b_caption p').first().text().trim(),
            url: targetUrl,
          });
        });

        const embedded = extractShopeeProductCandidatesFromHtml(html, 20);
        return expandShopeeSearchResults(
          mergeShopeeCandidates(results, embedded, 20),
          { limit: 20 }
        );
      },
    },
    {
      name: 'Brave',
      run: async (engineQuery) => {
        const url = 'https://search.brave.com/search?q=' + encodeURIComponent(engineQuery);
        const response = await fetchWithTlsFallback(url, {
          timeoutMs: 8000,
          headers: {
            'user-agent': USER_AGENT,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          },
        });
        if (!response?.ok) return [];

        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];

        $('a').each((_, element) => {
          const targetUrl = normalizeSearchResultUrl($(element).attr('href'));
          if (!isShopeeProductUrl(targetUrl) && !isShopeeDiscoveryUrl(targetUrl)) return;
          results.push({
            title: $(element).text().trim(),
            snippet: $(element).closest('[data-type="web"]').text().trim().slice(0, 500),
            url: targetUrl,
          });
        });

        const embedded = extractShopeeProductCandidatesFromHtml(html, 20);
        return expandShopeeSearchResults(
          mergeShopeeCandidates(results, embedded, 20),
          { limit: 20 }
        );
      },
    },
  ];

  const searchRound = async (engineQuery) => {
    const settled = await Promise.all(
      engines.map(async (engine) => {
        try {
          const results = await engine.run(engineQuery);
          return { engine: engine.name, results: Array.isArray(results) ? results : [] };
        } catch (err) {
          console.warn(
            '[BrandedDiscovery] ' + engine.name +
            ' search failed for "' + engineQuery + '": ' + err.message
          );
          return { engine: engine.name, results: [] };
        }
      })
    );

    for (const hit of settled) {
      if (hit.results.length) {
        console.log(
          '[BrandedDiscovery] ' + hit.engine +
          ' returned ' + hit.results.length +
          ' Shopee product result(s): "' + engineQuery + '"'
        );
        return hit.results;
      }
      console.log(
        '[BrandedDiscovery] ' + hit.engine +
        ' returned no usable Shopee products: "' + engineQuery + '"'
      );
    }

    return [];
  };

  for (const engineQuery of queryVariants) {
    const results = await searchRound(engineQuery);
    if (results.length) return results;
  }

  console.warn(
    '[BrandedDiscovery] No indexed Shopee products found for branded query: "' +
    cleanQuery + '"'
  );
  return [];
}

export async function fetchShopeePageMeta(url) {
  if (isShopeeRequestBlocked()) return {};

  try {
    const response = await fetchWithTlsFallback(url, {
      timeoutMs: 4000,
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!response || !response.ok) return {};

    const html = await response.text();
    const $ = cheerio.load(html);
    const rawImg = $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="og:image:url"]').attr('content') ||
      $('link[rel="image_src"]').attr('href') || '';
    const imageUrl = rawImg.startsWith('//') ? `https:${rawImg}` : rawImg;

    let brand = (
      $('meta[property="product:brand"]').attr('content') ||
      $('meta[itemprop="brand"]').attr('content') ||
      $('[itemprop="brand"] [itemprop="name"]').attr('content') ||
      $('[itemprop="brand"] [itemprop="name"]').text() ||
      $('meta[name="brand"]').attr('content') ||
      ''
    ).trim();

    // Shopee pages may expose Product/Brand in JSON-LD rather than meta tags.
    if (!brand) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (brand) return;
        try {
          const parsed = JSON.parse($(el).text().trim());
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          for (const entry of entries) {
            const candidates = Array.isArray(entry?.['@graph']) ? entry['@graph'] : [entry];
            for (const item of candidates) {
              const rawBrand = item?.brand;
              const candidate = typeof rawBrand === 'string'
                ? rawBrand
                : rawBrand?.name;
              if (candidate && typeof candidate === 'string') {
                brand = candidate.trim();
                break;
              }
            }
            if (brand) break;
          }
        } catch {
          // Ignore malformed JSON-LD.
        }
      });
    }

    return {
      title: $('meta[property="og:title"]').attr('content') || $('title').text(),
      description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'),
      imageUrl: imageUrl || '',
      brand,
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

    // Make transport failures actionable in VPS logs. The old message only said
    // "The operation was aborted", which hid whether the AbortController fired.
    if (error?.name === 'AbortError' || /aborted/i.test(String(error?.message || ''))) {
      const target = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return 'unknown-host';
        }
      })();
      const diagnostic = new Error(
        `Request timeout/abort after ${timeoutMs}ms: ${target}. IPv4 transport is enabled.`
      );
      diagnostic.name = error?.name || 'AbortError';
      diagnostic.cause = error;
      throw diagnostic;
    }

    throw error;
  }
}

function normalizeSearchResultUrl(rawHref) {
  if (!rawHref) return '';

  try {
    const parsed = new URL(rawHref, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    const bingTarget = decodeBingRedirect(parsed.searchParams.get('u'));
    const googleTarget = parsed.searchParams.get('q') || parsed.searchParams.get('url');
    const target = redirected
      ? new URL(redirected)
      : bingTarget
        ? new URL(bingTarget)
        : googleTarget
          ? new URL(decodeURIComponent(googleTarget))
          : parsed;

    const host = target.hostname.replace(/^www\./, '').toLowerCase();
    const isShopee = host === 'shopee.co.id' || host === 'shope.ee' || host === 's.shopee.co.id';

    target.hash = '';

    if (isShopee && target.searchParams.has('itemId')) {
      const itemId = target.searchParams.get('itemId');
      const shopId = target.searchParams.get('shopId');
      const params = new URLSearchParams();
      if (itemId) params.set('itemId', itemId);
      if (shopId) params.set('shopId', shopId);
      target.search = params.toString() ? `?${params.toString()}` : '';
    } else {
      target.search = '';
    }

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
  const cleanKeyword = keyword
    .replace(/\b(?:set|pack|packs|package|paket|bundle|bundling|kombo|combo|isi\s*\d+|\d+\s*pcs)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const negativeSetOperators = '-set -pack -paket -bundle';
  return [
    `site:shopee.co.id ${cleanKeyword} ${negativeSetOperators} "i."`,
    `site:shopee.co.id/ ${cleanKeyword} ${negativeSetOperators}`,
    `site:shopee.co.id ${cleanKeyword} ${negativeSetOperators}`,
    `"shopee.co.id" ${cleanKeyword} ${negativeSetOperators}`,
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

    // Newer Shopee PDP links often use a store slug plus itemId/shopId query
    // instead of the classic /product/... or -i.shopId.itemId form.
    if (
      parsed.searchParams.has('itemId') &&
      /^\d+$/.test(parsed.searchParams.get('itemId') || '') &&
      !['/search', '/cart', '/buyer'].some((prefix) => path.startsWith(prefix))
    ) {
      return true;
    }

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
    const slugTitle = titleFromShopeeUrl(url);
    if (slugTitle && isBundleOrSetProduct(slugTitle)) {
      return '';
    }
    return url;
  }
  return '';
}

export function isLikelyCleanYouTubeCandidate(candidate, productWords = []) {
  if (!candidate.url || !candidate.id) return false;
  // If duration is known, reject if too short (< 150s / 2.5 min) or too long (> 10 min / 600s)
  if (candidate.duration > 0 && (candidate.duration < 150 || candidate.duration > 600)) return false;

  // Reject vertical Shorts (which already have hardburned music/captions)
  if (candidate.url.includes('/shorts/') || /#shorts\b/i.test(candidate.title || '')) return false;

  const titleText = normalizeText(candidate.title || '');
  if (isBulkyOrUnsuitableProduct(titleText)) return false;

  const isToolDemoTitle = /\b(alat|cetakan|maker|chopper|slicer|parutan|peeler|presser|cutter|pisau|gunting|wajan|panci|dispenser|sealer|praktis|review|demo|pakai|menggunakan)\b/i.test(titleText);

  // Disqualify broken / repair / disassembly / maintenance tutorials / DIY / set / pack / bundle / western retail
  if (/\b(set|pack|paket|bundle|kombo|combo|isi\s*\d+|\d+\s*pcs|perbaikan|penggantian|pergantian|mengganti|rusak|service|servis|repair|reparasi|bongkar|membongkar|mati total|amazon|walmart|target|bestbuy|homedepot)\b/i.test(titleText)) return false;

  // Jika bukan peragaan alat fisik, tolak kata cara/tutorial murni (reparasi/diy umum)
  if (!isToolDemoTitle && /\b(cara|tutorial|diy|how\s+to|do\s+it\s+yourself)\b/i.test(titleText)) return false;

  const excludedTitleWords = [
    // Packaging/unboxing is never a valid primary affiliate source.
    'unboxing', 'unbox', 'unpack', 'unpacking', 'bubble wrap', 'bubblewrap',
    'kardus', 'cardboard', 'paket dibuka', 'buka paket', 'open box', 'opening box',
    'packaging', 'package opening', 'box opening', 'kemasan paket',
    // Western / US retail chain & Amazon exclusive haul filters (incompatible with Shopee)
    'amazon finds', 'amazon haul', 'amazon must haves', 'amazon favorites', 'found on amazon', 'bought on amazon',
    'walmart', 'target haul', 'best buy', 'home depot', 'dollar tree',
    'podcast', 'reaction', 'kompilasi', 'compilation', 'kumpulan', 'full album', 'playlist',
    'vlog', 'daily vlog', 'a day in my life', 'cerita', 'bincang', 'talkshow', 'ngobrol',
    'rutinitas', 'keseharian', 'beres-beres', 'beberes', 'bersih-bersih', 'ibu rumah tangga', 'irt', 'belanja bulanan',
    'room tour', 'house tour', 'kitchen tour', 'keseharian irt', 'aktivitas pagi', 'kegiatan harian', 'beres rumah',
    'cara belanja', 'cara checkout', 'daftar akun', 'tutorial aplikasi', 'cara jualan', 'cara live',
    'shopee affiliate tutorial', 'aplikasi shopee',
    // Exclude cooking recipes, food vlogs, and mukbangs (kecuali video peragaan alat cetakan/pemotong)
    ...(isToolDemoTitle ? [] : ['resep', 'resep masakan', 'cara memasak', 'cooking recipe', 'baking recipe', 'food recipe']),
    'food vlog', 'kuliner', 'mukbang', 'asmr eating', 'masakan rumahan', 'dapur umami',
    'cook with me', 'masak yuk', 'meal prep', 'food prep', 'cooking vlog', 'cooking show', 'menu harian',
    // Creator/face-centric and person-focused videos
    'muka', 'wajah', 'facecam', 'webcam', 'selfie', 'grwm', 'get ready with me',
    'try on haul', 'try on', 'outfit', 'ootd', 'skincare routine', 'makeup tutorial',
    // Subtitle & lyric indicators (wajib dihindari agar tidak tabrakan subtitle)
    'sub indo', 'subtitle', 'subtitles', 'sub english', 'eng sub', 'terjemahan', 'lirik',
    // Social media re-uploads & watermark indicators (wajib bersih tanpa logo sosmed/watermark)
    'tiktok', 'douyin', 'kuaishou', 'capcut', 'repost', 'watermark', 'shorts tiktok', 'video tiktok', 'vt tiktok',
    // Compilation / multi-product videos (cause mismatch with single Shopee link)
    'top 10', 'top 5', 'top 7', 'top 3', '5 alat', '10 alat', '7 alat', 'rekomendasi barang',
    'racun shopee haul', 'haul shopee', 'haul tiktok', 'unboxing haul', 'berbagai alat', 'kumpulan gadget',
    // Filter AI-generated, synthetic, and cartoon/3D animation
    'ai generated', 'ai video', 'generative ai', 'sora', 'runway', 'kling', 'hailuo', 'pika',
    'animation', 'animasi', '3d animation', 'cgi', 'cartoon', 'kartun', 'anime',
    // Filter Perbaikan / Service / Kerusakan / Penggantian (Bukan video demo produk baru)
    'perbaikan', 'penggantian', 'pergantian', 'mengganti', 'rusak', 'service', 'servis', 'ganti', 'repair', 'reparasi', 'bongkar', 'membongkar', 'mati total',
    // Filter pabrik / proses pembuatan / industrial manufacturing (Bukan peragaan konsumen)
    'pabrik', 'manufacturing', 'factory', 'proses pembuatan', 'industrial', 'produksi masal', 'how it\'s made', 'how its made',
    // Filter pemanggang besar / bulky outdoor grill / Blackstone / smoker
    'blackstone', 'weber', 'smoker', 'barbecue', 'bbq outdoor', 'grill outdoor', 'pemanggang besar', 'panggangan besar', 'commercial grill',
    // Filter slide foto statis
    'slideshow', 'slide foto', 'katalog foto',
    // Filter mesin pertanian, peternakan, limbah, dan chopper pakan (JANGAN tolak chopper dapur mini/elektrik!)
    'pakan ternak', 'mesin ternak', 'limbah', 'janggel', 'selep', 'pemipil', 'perontok', 'pemanen', 'traktor', 'chopper pakan', 'chopper rumput', 'chopper ternak', 'pencacah rumput', 'pencacah ranting', 'pencacah pakan', 'silase', 'alat berat'
  ];
  if (excludedTitleWords.some((keyword) => titleText.includes(keyword))) return false;

  // Hard blacklist for factory/industrial/large-machine footage.
  // Compact countertop appliances are allowed only when the target explicitly describes
  // a compact electric machine; otherwise a generic "mesin/machine" result is noise.
  const targetHasCompactMachine =
    Array.isArray(productWords) &&
    productWords.some((w) => /\b(mesin|machine)\b/i.test(String(w))) &&
    productWords.some((w) => /\b(mini|portable|compact|countertop|kitchen|dapur|handheld|usb|electric|elektrik|chopper|blender|mixer|frother|sealer|toaster|waffle|food processor)\b/i.test(String(w)));

  const industrialMachineTitle =
    /\b(?:industrial\s+machine|factory\s+machine|production\s+machine|packing\s+machine|packaging\s+machine|commercial\s+machine|industrial|machinery|mesin\s+industri|mesin\s+pabrik|mesin\s+produksi|mesin\s+packing|mesin\s+pengemas|mesin\s+komersial|mesin\s+besar|mesin\s+raksasa|cnc|conveyor|hydraulic\s+press|lathe\s+machine|milling\s+machine|washing\s+machine|mesin\s+cuci)\b/i.test(titleText);

  const genericMachineTitle =
    /\b(?:mesin|machine|machinery)\b/i.test(titleText) &&
    !/\b(?:mini|portable|compact|countertop|kitchen|dapur|handheld|usb|electric|elektrik|chopper|blender|mixer|frother|sealer|toaster|waffle)\b/i.test(titleText);

  if (industrialMachineTitle || (genericMachineTitle && !targetHasCompactMachine)) return false;

  // Flexible check: Cross-category exclusion for non-kitchen items
  // Per instruksi pengguna: Verifikasi fisik produk diserahkan ke AI Vision, backend hanya memblokir kategori silang terlarang.
  if (Array.isArray(productWords) && productWords.length > 0) {
    if (!isTitleMatchingProduct(candidate.title, productWords, {
      description: candidate.description,
      tags: candidate.tags,
      isVisualSearch: Boolean(candidate.isVisualSearch || candidate.source === 'bing_visual_search' || candidate.source === 'visual_ai_query')
    })) {
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
    pattern: /\b(?:pembuka\s+kaleng|can\s+opener)\b/i,
    noun: 'Alat Pembuka Kaleng Putar',
    englishNoun: 'Manual Can Opener Tool',
    category: 'kitchen_prep',
    core: ['pembuka', 'kaleng'],
    multilingual: ['can opener', 'tin opener', 'pembuka kaleng', 'can opener manual', '开罐器', 'dụng cụ mở hộp', 'ที่เปิดกระป๋อง']
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
    pattern: /\b(?:pembersih\s+sisik|pengupas\s+sisik|fish\s+scaler)\b/i,
    noun: 'Alat Pembersih Sisik Ikan',
    englishNoun: 'Fish Scale Scraper Remover',
    category: 'kitchen_prep',
    core: ['sisik', 'ikan'],
    multilingual: ['fish scaler', 'fish scale scraper', 'fish scale remover', 'pembersih sisik', 'pengupas sisik', '刮鱼鳞器', 'dụng cụ đánh vảy cá', 'ที่ขูดเกล็ดปลา']
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
    pattern: /\b(?:pelubang\s+kelapa|coconut\s+opener|pembuka\s+kelapa)\b/i,
    noun: 'Alat Pelubang Kelapa Muda Stainless',
    englishNoun: 'Coconut Opener Tool Stainless Steel',
    category: 'kitchen_prep',
    core: ['pelubang', 'kelapa'],
    multilingual: ['coconut opener', 'coconut drill', 'pelubang kelapa', 'pembuka kelapa', '开椰器', 'dụng cụ khui dừa', 'ที่เจาะมะพร้าว']
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
    pattern: /\b(?:pengupas\s+nanas|pemotong\s+nanas|pineapple\s+corer)\b/i,
    noun: 'Alat Pemotong Pengupas Nanas Spiral',
    englishNoun: 'Pineapple Corer Slicer Tool',
    category: 'kitchen_prep',
    core: ['pengupas', 'nanas'],
    multilingual: ['pineapple corer', 'pineapple slicer', 'pineapple peeler', 'pengupas nanas', 'pemotong nanas', '削菠萝器', 'dụng cụ gọt dứa', 'ที่ปอกสับปะรด']
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
    pattern: /\b(?:pembuat\s+waffle|waffle\s+maker)\b/i,
    noun: 'Alat Pembuat Waffle Mini',
    englishNoun: 'Mini Waffle Maker Machine',
    category: 'cooking_pot',
    core: ['waffle', 'maker'],
    multilingual: ['waffle maker', 'waffle iron', 'mini waffle', 'pancake maker', 'pembuat waffle', 'waffle', '华夫饼机', 'máy làm bánh waffle', 'máy nướng waffle', 'เครื่องทำวาฟเฟิล']
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
    pattern: /\b(?:pematik\s+api|pemantik\s+kompor|electric\s+lighter)\b/i,
    noun: 'Pematik Api Kompor Gas Elektrik',
    englishNoun: 'Electric Arc USB Gas Lighter',
    category: 'cooking_pot',
    core: ['pematik', 'kompor'],
    multilingual: ['electric lighter', 'arc lighter', 'gas lighter', 'pematik api', 'pemantik kompor', '点火枪', 'bật lửa điện', 'ปืนจุดแก๊ส']
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
    pattern: /\b(?:pemeras\s+santan|perasan\s+kelapa|coconut\s+press)\b/i,
    noun: 'Alat Pemeras Santan Manual',
    englishNoun: 'Manual Coconut Milk Squeezer Press',
    category: 'kitchen_prep',
    core: ['pemeras', 'santan'],
    multilingual: ['coconut squeezer', 'milk press', 'pemeras santan', 'perasan santan', 'dụng cụ ép nước cốt dừa', 'ที่คั้นกะทิ']
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
    pattern: /\b(?:pemecah\s+kepiting|walnut\s+cracker|nut\s+cracker)\b/i,
    noun: 'Alat Pemecah Cangkang Kepiting Walnut',
    englishNoun: 'Crab Walnut Nut Cracker Tool',
    category: 'kitchen_prep',
    core: ['pemecah', 'kepiting'],
    multilingual: ['crab cracker', 'nut cracker', 'walnut cracker', 'pemecah kepiting', 'pemecah walnut', '螃蟹钳', 'kẹp cua', 'ที่หนีบก้ามปู']
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

/**
 * Extracts a dynamic product identity from any marketplace title.
 * No hard-coded brand database is required: brand/model signals are learned
 * from the actual Shopee title and preserved for downstream video search.
 */
export function extractCoreProductInfo(rawTitle = '', rawDesc = '', rawUrl = '', rawBrand = '') {
  const cleaned = cleanTitle(rawTitle, rawUrl) || String(rawTitle || '').trim();
  const normalized = normalizeText(cleaned);
  for (const anchor of PRODUCT_ANCHORS) {
    if (anchor.pattern.test(normalized)) {
      const allWords = Array.from(new Set([...(anchor.core || []), ...(anchor.multilingual || [])]));
      const englishNoun = anchor.englishNoun || anchor.noun;
      const dynamicIdentity = extractDynamicProductIdentity(cleaned, rawDesc, rawBrand);
      return {
        cleanTitle: cleaned, coreProductNoun: anchor.noun, englishNoun,
        category: anchor.category, brand: dynamicIdentity.brand, model: dynamicIdentity.model,
        productIdentity: dynamicIdentity.identity, identityWords: dynamicIdentity.words,
        coreWords: Array.from(new Set([...allWords, ...dynamicIdentity.words])),
        multilingualWords: Array.from(new Set([...allWords, ...dynamicIdentity.words])),
        searchQueries: buildDynamicProductSearchQueries({
          title: cleaned, noun: anchor.noun, englishNoun,
          brand: dynamicIdentity.brand, model: dynamicIdentity.model, identity: dynamicIdentity.identity,
        })
      };
    }
  }

  const stopWords = [
    'dan','yang','untuk','dengan','dari','bisa','anti','super','termurah','viral','original',
    'promo','murah','ready','stock','import','impor','terlaris','terbaru','terpercaya',
    'kualitas','garansi','resmi','official','cod','gratis','ongkir','diskon','terlengkap',
    'store','shop','indonesia','free','shipping','sale','best','seller','new','limited','edition'
  ];
  const words = normalized.split(/\s+/).filter(w => w.length >= 2 && !stopWords.includes(w));
  const dynamicIdentity = extractDynamicProductIdentity(cleaned, rawDesc, rawBrand);
  const fallbackTokens = words.slice(0, 6);
  const fallbackNoun = dynamicIdentity.identity ||
    fallbackTokens.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') ||
    cleaned.slice(0, 40) || 'Produk Praktis';
  const fallbackWords = Array.from(new Set([...fallbackTokens, ...dynamicIdentity.words]));
  return {
    cleanTitle: cleaned, coreProductNoun: fallbackNoun, englishNoun: fallbackNoun,
    category: 'general_gadget', brand: dynamicIdentity.brand, model: dynamicIdentity.model,
    productIdentity: dynamicIdentity.identity || fallbackNoun, identityWords: dynamicIdentity.words,
    coreWords: fallbackWords.length > 0 ? fallbackWords : ['produk'],
    multilingualWords: fallbackWords.length > 0 ? fallbackWords : ['produk'],
    searchQueries: buildDynamicProductSearchQueries({
      title: cleaned, noun: fallbackNoun, englishNoun: fallbackNoun,
      brand: dynamicIdentity.brand, model: dynamicIdentity.model,
      identity: dynamicIdentity.identity || fallbackNoun,
    })
  };
}

/** Generic identity extraction; no fixed brand database is required. */
function isMeasurementOrVariantToken(value = '') {
  const compact = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return false;

  // Marketplace sizes/capacities/specs are product attributes, not model numbers.
  if (/^\d+(?:[.,]\d+)?(?:ml|ltr|liter|litre|l|gr|g|kg|mg|cm|mm|m|in|inch|oz|w|kw|v|mah|ah|hz|pcs?|pc)$/i.test(compact)) {
    return true;
  }
  if (/^\d+(?:[x×]\d+){1,2}(?:cm|mm|m|in|inch)?$/i.test(compact)) {
    return true;
  }
  return false;
}

function extractDynamicProductIdentity(title = '', description = '', explicitBrand = '') {
  const source = String(title || '').replace(/\s+/g, ' ').trim();
  const desc = String(description || '').replace(/\s+/g, ' ').trim();

  const modelMatches = source.match(/\b(?=[A-Z0-9-]{3,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:[-/][A-Z0-9]+){1,3}\b/gi) || [];
  const compactModelMatches = source.match(/\b[A-Z]{1,5}\d{2,}[A-Z0-9-]*\b/gi) || [];
  const numericSeriesMatches = source.match(/\b\d{2,}[A-Z]{1,5}[-]?[A-Z0-9]*\b/gi) || [];
  const model = Array.from(new Set([...modelMatches, ...compactModelMatches, ...numericSeriesMatches]))
    .map(v => v.replace(/[.,;:!?]+$/g, ''))
    .find(v => !/^\d+$/.test(v) && !isMeasurementOrVariantToken(v)) || '';

  const tokens = source.split(/\s+/).map(v => v.replace(/^[^\w]+|[^\w-]+$/g, '')).filter(Boolean);
  const brandBlacklist = new Set([
    'original','official','store','shop','mall','promo','murah','viral','terbaru','terlaris',
    'premium','portable','multifungsi','serbaguna','electric','elektrik','manual','mini',
    'besar','kecil','set','paket','bundle','new','sale','ready','stock','import','indonesia',
    'murah','termurah','terbaik','best','seller','top','hits','favorit','rekomendasi',
    'praktis','portable','simple','smart','universal','standar','standart','premium',
    'grosir','eceran','official store','free','gratis','promo store',
    'review','demo','test','unboxing','produk','alat','barang','tanpa','merek','brand','no','merk'
  ]);
  const genericProductWords = new Set([
    'chopper','pencacah','blender','mixer','panci','wajan','pan','pot','kompor','dispenser',
    'vacuum','cleaner','mop','pel','brush','sikat','knife','pisau','gunting','slicer','cutter',
    'pemotong','peeler','pengupas','grater','parutan','press','crusher','penggiling','juicer',
    'pemeras','kettle','cooker','fryer','rak','rack','shelf','sepatu','shoe','organizer',
    'storage','tempat','wadah','box','kotak','botol','bottle','gelas','cup','mug','piring',
    'plate','mangkok','bowl','sendok','spoon','garpu','fork','tongs','capitan','lampu','light',
    'kipas','fan','humidifier','sealer','timbangan','scale','thermometer','termometer',
    'kitchen','dapur','tools','tool','holder','stand','lipat','foldable','tarik','putar',
    'tekan','rotary','rechargeable','usb','cordless','isi','pcs','buah','food'
  ]);

  const isPossibleBrand = (candidate) => {
    if (!candidate || candidate.length < 2) return false;
    const lower = candidate.toLowerCase();
    return /^[A-Za-z][A-Za-z0-9&.-]{1,}$/.test(candidate) &&
      !brandBlacklist.has(lower) &&
      !genericProductWords.has(lower) &&
      !isMeasurementOrVariantToken(candidate) &&
      !/^\d/.test(candidate);
  };

  let brand = String(explicitBrand || '').trim();

  if (brand) {
    // Strip marketplace noise from structured brand metadata before using it.
    brand = brand
      .replace(/^(?:brand|merk|merek)\s*[:\-]?\s*/i, '')
      .replace(/[|,:;]+$/g, '')
      .trim();
    if (!isPossibleBrand(brand)) brand = '';
  }

  if (!brand && model) {
    const mi = tokens.findIndex(t => t.toLowerCase() === model.toLowerCase());
    if (mi > 0) {
      // Search backwards because titles often place the product noun between brand and model:
      // "Philips Blender HR7301" -> Philips, not Blender.
      for (let i = mi - 1; i >= 0 && i >= mi - 4; i--) {
        const candidate = tokens[i];
        if (isPossibleBrand(candidate)) {
          brand = candidate;
          break;
        }
      }
    }
  }

  if (!brand) {
    // Conservative fallback: inspect only the beginning of the listing title.
    // Capitalization is not required because marketplace titles are often lowercase.
    brand = tokens.slice(0, 4).find(t => isPossibleBrand(t)) || '';
  }

  const identityParts = [];
  if (brand) identityParts.push(brand);
  if (model && !identityParts.some(p => p.toLowerCase() === model.toLowerCase())) identityParts.push(model);

  const identity = identityParts.join(' ').trim();
  const words = Array.from(new Set([
    ...identity.split(/\s+/).filter(Boolean),
    ...(model ? model.split(/[-/]/).filter(Boolean) : [])
  ]));
  return { brand, model, identity, words, source: desc ? source + ' ' + desc : source };
}

function extractDynamicSearchAttributes(title = '') {
  const normalized = normalizeText(title);
  const attributes = [];

  const add = (value) => {
    if (value && !attributes.includes(value)) attributes.push(value);
  };

  if (/\b(?:manual\s+tarik|tali\s+tarik|tarik\s+tali|pull\s+cord|pull\s+string|rope\s+pull)\b/i.test(normalized)) {
    add('manual pull cord');
  } else if (/\b(?:manual\s+putar|putar\s+manual|rotary|hand\s+crank)\b/i.test(normalized)) {
    add('manual rotary');
  } else if (/\b(?:tekan\s+manual|press\s+manual|hand\s+press|push\s+press)\b/i.test(normalized)) {
    add('manual press');
  } else if (/\b(?:elektrik|electric|listrik|rechargeable|usb|cordless)\b/i.test(normalized)) {
    add('electric rechargeable');
  }

  if (/\b(?:lipat|foldable|collapsible)\b/i.test(normalized)) add('foldable');
  if (/\b(?:vakum|vacuum|suction)\b/i.test(normalized)) add('vacuum suction');

  const capacity = String(title || '').match(/\b(\d+(?:[.,]\d+)?)\s*(ml|ltr|liter|litre|l|g|gr|kg)\b/i);
  if (capacity) add(`${capacity[1]}${capacity[2].toLowerCase()}`);

  return attributes.slice(0, 3);
}

function buildDynamicProductSearchQueries({ title = '', noun = '', englishNoun = '', brand = '', model = '', identity = '' } = {}) {
  const queries = [];
  const add = (query) => {
    const clean = String(query || '').replace(/\s+/g, ' ').trim();
    if (clean && !queries.includes(clean)) queries.push(clean);
  };

  // Discovery is intentionally identity-first:
  // 1) Brand + model/type when available.
  // 2) Brand + product type when only brand is known.
  // 3) Model + product type when only model is known.
  // 4) Product type alone when the listing is genuinely OEM/unbranded.
  // Do NOT expand discovery with marketplace adjectives, dimensions, capacity,
  // generic attributes, or the full seller title: those queries create unrelated footage.
  const type = String(noun || englishNoun || '').replace(/\s+/g, ' ').trim();
  // Auto/video discovery must keep brand + product type together.
  // If a model exists, include it as an additional identity signal rather than
  // replacing the product type.
  const exactIdentity = brand && type
    ? [brand, model, type].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    : '';
  const fallbackIdentity = String(identity || '').trim();

  if (exactIdentity) {
    add(`"${exactIdentity}" demo`);
    add(`"${exactIdentity}" review`);
    add(`"${exactIdentity}" demonstration`);
    add(`"${exactIdentity}" hands on`);
  } else if (fallbackIdentity && !brand) {
    // Kept for non-auto/manual callers. Auto Mode validates brand + type before
    // reaching video search, so this cannot create generic Auto Mode queries.
    add(`"${fallbackIdentity}" demo`);
    add(`"${fallbackIdentity}" review`);
  }

  if (brand && type) {
    add(`${brand} ${type} demo`);
    add(`${brand} ${type} review`);
  }

  if (model && type) {
    add(`${model} ${type} demo`);
    add(`${model} ${type} review`);
  }

  // Never generate type-only or full-title discovery queries here.
  // Unbranded/OEM products are handled exclusively through the manual URL flow.
  return queries.slice(0, 12);
}

export function isTitleMatchingProduct(candidateTitle, productWords = [], extraMeta = {}) {
  const normTitle = normalizeText(candidateTitle || '');
  const normDesc = normalizeText(extraMeta?.description || '').slice(0, 800);
  const normTags = Array.isArray(extraMeta?.tags)
    ? extraMeta.tags.map((t) => normalizeText(String(t))).join(' ')
    : '';
  const combinedText = `${normTitle} ${normDesc} ${normTags}`;

  // Cross-category exclusion for non-kitchen / automotive / clothing / personal vlog / recipes / food / drinks
  const isGadget = extraMeta?.niche === 'gadget_smartphone' ||
    /\b(hp|smartphone|ponsel|handphone|poco|redmi|infinix|samsung|galaxy|xiaomi|realme|tecno|vivo|oppo|iqoo)\b/i.test(candidateTitle || '') ||
    (Array.isArray(productWords) && productWords.some(w => /\b(hp|smartphone|ponsel|poco|redmi|infinix|samsung|galaxy|xiaomi|realme|tecno|vivo|oppo|iqoo)\b/i.test(w)));
  const crossCategoryRegex = isGadget
    ? /\b(?:las|pagar|bengkel|servis hp|servis motor|knalpot|mobil|motor|sepeda|manga|anime|vlog|skincare|makeup|gamis|hijab|outfit|resep|recipe|mukbang|kuliner|jajanan|street food|makanan viral|minuman viral|boba milk tea|camilan)\b/i
    : /\b(?:las|pagar|bengkel|servis hp|servis motor|knalpot|mobil|motor|sepeda|gameplay|game|manga|anime|vlog|skincare|makeup|gamis|hijab|outfit|resep|recipe|mukbang|kuliner|jajanan|street food|makanan viral|minuman viral|boba milk tea|camilan)\b/i;
  if (crossCategoryRegex.test(normTitle)) {
    return false;
  }

  // Visual Search / Image verification bypass:
  // When candidates are found via Reverse Image Search, Bing Visual Search, Gemini Vision queries,
  // or when an official product image is being verified, the title may be OEM / global English.
  // We pass them through Filter 1 so AI Vision can verify physical product correspondence directly.
  if (extraMeta?.isVisualSearch || extraMeta?.skipKeywordMatch || !Array.isArray(productWords) || productWords.length === 0) {
    return true;
  }

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
    'ladle': 'sendok kuah centong sop sup',
    'skimmer': 'saringan tirisan',
    'turner': 'spatula sutil',
    'whisk': 'pengocok telur',
    'tongs': 'capitan makanan',
    'grater': 'parutan',
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

export function normalizeText(value = '') {
  return value.toString().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Membangun URL pencarian Shopee Indonesia yang bersih, akurat, dan bebas captcha.
 * Link pencarian langsung membuka aplikasi Shopee dan menampilkan daftar produk terkait dengan rating/harga terbaik
 * tanpa terhalang slide puzzle / captcha bot protection seperti pada link produk langsung.
 * @param {string} productTitle 
 * @param {string} detectedBrand 
 * @returns {string}
 */
export function buildShopeeSearchUrl(productTitle = '', detectedBrand = '') {
  if (!productTitle || typeof productTitle !== 'string') {
    return 'https://shopee.co.id';
  }

  // 1. Coba ambil kata kunci inti produk dari PRODUCT_ANCHORS
  const coreInfo = extractCoreProductInfo(productTitle);
  let baseKeyword = '';

  if (coreInfo?.coreProductNoun && coreInfo.coreProductNoun !== 'Produk Praktis') {
    baseKeyword = coreInfo.coreProductNoun;
  } else {
    // 2. Bersihkan kata-kata clickbait, promo, review, dan stop words
    const cleaned = cleanTitle(productTitle) || productTitle.trim();
    const stopWords = new Set([
      'dan', 'yang', 'untuk', 'dengan', 'dari', 'bisa', 'anti', 'super', 'termurah',
      'viral', 'original', 'promo', 'murah', 'ready', 'stock', 'import', 'impor',
      'terlaris', 'terbaru', 'terpercaya', 'kualitas', 'garansi', 'resmi', 'official',
      'bisa', 'cod', 'gratis', 'ongkir', 'diskon', 'terlengkap', 'store', 'shop', 'indonesia',
      'review', 'jujur', 'banget', 'ini', 'itu', 'pada', 'saat', 'dalam', 'fungsi', 'maksimal',
      'alternatif', 'hemat', 'solusi', 'instan', 'rekomendasi', 'spill', 'racun'
    ]);
    const words = cleaned
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => (w.length >= 2 || /\d/.test(w)) && !stopWords.has(w.toLowerCase()));

    // Ambil 3 sampai 5 kata kunci paling esensial (optimal untuk mesin pencari Shopee)
    baseKeyword = words.slice(0, 5).join(' ');
  }

  // 3. Tambahkan merek produk jika terdeteksi dan valid
  const brandClean = (detectedBrand && detectedBrand !== 'none' && !detectedBrand.includes('Terdeteksi'))
    ? detectedBrand.trim()
    : '';

  let finalKeyword = baseKeyword || cleanTitle(productTitle) || productTitle.trim().slice(0, 40);
  if (brandClean && !finalKeyword.toLowerCase().includes(brandClean.toLowerCase())) {
    finalKeyword = `${brandClean} ${finalKeyword}`;
  }

  finalKeyword = finalKeyword
    .replace(/\b(?:set|pack|packs|package|paket|bundle|bundling|kombo|combo|isi\s*\d+|\d+\s*pcs)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return `https://shopee.co.id/search?keyword=${encodeURIComponent(finalKeyword)}`;
}

export async function findMatchingShopeeProductUrl(productTitle, detectedBrand = '', videoDesc = '') {
  if (!productTitle || typeof productTitle !== 'string') return '';
  const searchUrl = buildShopeeSearchUrl(productTitle, detectedBrand);
  console.log(`[Discovery] ✅ Menggunakan link pencarian Shopee akurat (anti-captcha): ${searchUrl}`);
  return searchUrl;
}

