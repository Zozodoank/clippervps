import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MD_PATH = path.join(__dirname, '..', 'TALING_DICTIONARY.md');

/**
 * Modul Fonetik Bahasa Indonesia untuk Model TTS
 * Memetakan kata dasar taling (/e/ atau /ɛ/) ke bentuk beraksen 'é' agar model TTS
 * melafalkannya dengan tepat, sekaligus menjaga vokal pepet (/ə/) tetap 'e' biasa.
 */

// Kamus fallback kata dasar taling jika file TALING_DICTIONARY.md tidak ditemukan
export const DEFAULT_TALING_DICTIONARY = {
  // Paling sering digunakan / Contoh user (meja, beres, keju dinonaktifkan sesuai feedback)
  'keju': 'keju',
  'beres': 'beres',
  'meja': 'meja',
  'keren': 'kéren',
  'kesel': 'késél',
  'capek': 'capék',
  'cape': 'capé',
  'bosen': 'bosén',
  'nyesel': 'nyésél',
  'ribet': 'ribét',
  'cewek': 'céwék',
  'lele': 'lélé',
  'bebek': 'bébék',
  'sate': 'saté',
  'cabe': 'cabé',
  'tempe': 'témpé',
  'sore': 'soré',
  'besok': 'bésok',
  'enak': 'énak',
  'geser': 'gésér',
  'heboh': 'héboh',
  'geprek': 'géprék',
  'kepo': 'képo',
  'lelet': 'lélét',
  'sepele': 'sépélé',
  'kamera': 'kaméra',
  'model': 'modél',
  'modern': 'modérn',
  'konten': 'kontén',
  'momen': 'momén',
  'tren': 'trén',
  'ember': 'émbér',
  'kelereng': 'keléréng',
  'resep': 'résép',
  'leher': 'léhér',
  'koleksi': 'koléksi',
  'paket': 'pakét',
  'dompet': 'dompét',
  'jaket': 'jakét',
  'helm': 'hélm',
  'kece': 'kécé',
  'bela': 'béla',
  'beda': 'béda',
  'bebas': 'bébas',
  'becek': 'bécék',
  'bengkel': 'béngkél',
  'repot': 'répot',
  'sendok': 'séndok',
  'tempel': 'témpél',
  'terong': 'térong',
  'tes': 'tés',
  'video': 'fidéo',
  'akses': 'aksés',
  'ekstra': 'ékstra',
  'efektif': 'éféktif',
  'efisien': 'éfisién',
  'hemat': 'hémat',
  'elegan': 'élégan',
  'elektronik': 'éléktronik',
  'estetik': 'éstétik',
  'eksklusif': 'éksklusif',
  'alergi': 'alérgi',
  'awet': 'awét',
  'adem': 'adém',
  'aneh': 'anéh',
  'area': 'aréa',
  'artikel': 'artikél',
  'aset': 'asét',
  'baper': 'bapér',
  'baret': 'barét',
  'bel': 'bél',
  'belerang': 'belérang',
  'benyek': 'bényék',
  'beo': 'béo',
  'beton': 'béton',
  'boleh': 'boléh',
  'bonceng': 'boncéng',
  'bule': 'bulé',
  'butek': 'buték',
  'cetak': 'cétak',
  'cengeng': 'céngéng',
  'ceper': 'cépér',
  'ceret': 'cérét',
  'coret': 'corét',
  'daerah': 'daérah',
  'debat': 'débat',
  'dekorasi': 'dékorasi',
  'demam': 'démam',
  'derek': 'dérék',
  'desa': 'désa',
  'desain': 'désain',
  'detail': 'détail',
  'dewasa': 'déwasa',
  'diet': 'diét',
  'dosen': 'dosén',
  'duren': 'durén',
  'edukasi': 'édukasi',
  'ekonomi': 'ékonomi',
  'ekor': 'ékor',
  'eksis': 'éksis',
  'ekspres': 'éksprés',
  'elitis': 'élitis',
  'engsel': 'éngsél',
  'enteng': 'énténg',
  'episode': 'épisodé',
  'era': 'éra',
  'es': 'és',
  'esensi': 'ésénsi',
  'etiket': 'étikét',
  'gadget': 'gadjét',
  'game': 'gém',
  'gaptek': 'gapték',
  'geleng': 'géléng',
  'genit': 'génit',
  'genjot': 'génjot',
  'genteng': 'génténg',
  'gesek': 'gésék',
  'goreng': 'goréng',
  'hebat': 'hébat',
  'ide': 'idé',
  'ideal': 'idéal',
  'identitas': 'idéntitas',
  'intel': 'intél',
  'internet': 'intérnét',
  'jelek': 'jélék',
  'jendela': 'jendéla',
  'joget': 'jogét',
  'kabel': 'kabél',
  'kaget': 'kagét',
  'kakek': 'kakék',
  'kaleng': 'kaléng',
  'karet': 'karét',
  'keju': 'keju',
  'kencan': 'kéncan',
  'kereta': 'keréta',
  'komedo': 'komédo',
  'komedi': 'komédi',
  'kompeten': 'kompétén',
  'komplet': 'komplét',
  'koneksi': 'konéksi',
  'konsep': 'konsép',
  'koper': 'kopér',
  'korek': 'korék',
  'kosmetik': 'kosmétik',
  'kue': 'kué',
  'label': 'labél',
  'lebar': 'lébar',
  'ledeng': 'lédéng',
  'legendaris': 'légendaris',
  'lem': 'lém',
  'lempar': 'lémpar',
  'lensa': 'lénsa',
  'lepek': 'lépék',
  'lereng': 'léréng',
  'level': 'lévél',
  'lezat': 'lézat',
  'luber': 'lubér',
  'luwes': 'luwés',
  'macet': 'macét',
  'mager': 'magér',
  'magnet': 'magnét',
  'materi': 'matéri',
  'matematika': 'matématika',
  'melodi': 'mélodi',
  'mentega': 'mentéga',
  'merah': 'mérah',
  'merek': 'mérék',
  'merdeka': 'merdéka',
  'mewah': 'méwah',
  'mode': 'modé',
  'moge': 'mogé',
  'moles': 'molés',
  'monyet': 'monyét',
  'nempel': 'némpél',
  'nyontek': 'nyonték',
  'obeng': 'obéng',
  'objek': 'objék',
  'oles': 'olés',
  'omzet': 'omzét',
  'oprek': 'oprék',
  'orde': 'ordé',
  'order': 'ordér',
  'outlet': 'outlét',
  'pamer': 'pamér',
  'panen': 'panén',
  'paten': 'patén',
  'pelet': 'pélét',
  'pendek': 'péndék',
  'pesta': 'pésta',
  'poles': 'polés',
  'proses': 'prosés',
  'proyek': 'proyék',
  'pulpen': 'pulpén',
  'rekomendasi': 'rékoméndasi',
  'rekor': 'rékor',
  'relevan': 'rélévan',
  'renovasi': 'rénovasi',
  'robek': 'robék',
  'seksi': 'séksi',
  'sekunder': 'sékundér',
  'seluler': 'sélulér',
  'sepeda': 'sepéda',
  'seret': 'sérét',
  'sewa': 'séwa',
  'siluet': 'siluét',
  'skincare': 'skinkér',
  'sobek': 'sobék',
  'spesial': 'spésial',
  'spesifikasi': 'spésifikasi',
  'stempel': 'stémpél',
  'sukses': 'suksés',
  'sumpel': 'sumpél',
  'suplemen': 'suplémén',
  'tante': 'tanté',
  'target': 'targét',
  'teh': 'téh',
  'teknik': 'téknik',
  'teknologi': 'téknologi',
  'teko': 'téko',
  'tekstur': 'tékstur',
  'tema': 'téma',
  'tenda': 'ténda',
  'tengok': 'téngok',
  'tensi': 'ténsi',
  'tetes': 'tétés',
  'toilet': 'toilét',
  'ulek': 'ulék',
  'ventilasi': 'féntilasi',
  'versi': 'férsi',
  'viral': 'firal',
  'voucher': 'fowcer',
  'variasi': 'fariasi',
  'varian': 'farian',
  'volume': 'folume',
  'vakum': 'fakum',
  'vitamin': 'fitamin',
  'vintage': 'fintij',
  'wastafel': 'wastafél',
  'zipper': 'zipér',
};

// Cache runtime untuk kamus dari file TALING_DICTIONARY.md
let cachedDictionary = null;
let lastMtime = 0;

/**
 * Mengambil daftar kata taling terkini:
 * Membaca langsung dari server/TALING_DICTIONARY.md setiap kali file tersebut diedit oleh user.
 */
export function getTalingDictionary() {
  try {
    if (fs.existsSync(MD_PATH)) {
      const stats = fs.statSync(MD_PATH);
      if (!cachedDictionary || stats.mtimeMs !== lastMtime) {
        const content = fs.readFileSync(MD_PATH, 'utf8');
        const dict = {};
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          // Match "kata = lafal" atau "kata: lafal"
          const match = trimmed.match(/^([a-zA-Z-]+)\s*[=:]\s*([a-zA-Z\u00C0-\u017F-]+)/);
          if (match) {
            dict[match[1].toLowerCase()] = match[2];
          }
        }
        cachedDictionary = dict;
        lastMtime = stats.mtimeMs;
      }
      return cachedDictionary;
    }
  } catch (err) {
    console.warn('[PhoneticData] Gagal membaca TALING_DICTIONARY.md:', err.message);
  }

  return DEFAULT_TALING_DICTIONARY;
}

// Backward compatibility
export const TALING_DICTIONARY = DEFAULT_TALING_DICTIONARY;

// Daftar kata pepet umum (/ə/) atau kata standar yang TIDAK BOLEH diubah jadi taling (tetap huruf 'e' biasa)
export const PROTECTED_PEPET_WORDS = new Set([
  'keju', 'beres', 'meja',
  'pegel', 'segar', 'besar', 'benar', 'senang', 'tenang', 'beli', 'berat',
  'tebal', 'sempurna', 'cepat', 'lewat', 'lemah', 'remuk', 'sederhana',
  'sedikit', 'selesai', 'tenggelam', 'pedas', 'peduli', 'pegang', 'pelan',
  'pelindung', 'penting', 'periksa', 'pernah', 'pesan', 'petir', 'sejuk',
  'sekarang', 'selang', 'selimut', 'semprot', 'sepatu', 'serba', 'serbu',
  'sering', 'setir', 'tebak', 'tebus', 'teduh', 'tegap', 'tegas', 'teguk',
  'tekan', 'telan', 'telat', 'teliti', 'telur', 'teman', 'tembus', 'tempat',
  'tempur', 'tenar', 'tepat', 'tepung', 'terang', 'terbang', 'terbit',
  'teriak', 'terik', 'kena', 'sedih', 'selamat', 'belum', 'belanja', 'terasa'
]);

// Pola awalan (prefix) bahasa Indonesia yang dijamin pepet (diurutkan dari yang terpanjang)
const PREFIXES = [
  'memper', 'meng', 'meny', 'peng', 'peny',
  'mem', 'men', 'pem', 'pen', 'per',
  'ber', 'ter', 'se', 'ke', 'di', 'me', 'pe'
];

// Pola akhiran (suffix) umum (diurutkan dari yang terpanjang)
const SUFFIXES = [
  'kannya', 'annya', 'kan', 'lah', 'kah', 'pun', 'nya', 'an', 'ku', 'mu', 'i'
];

/**
 * Pertahankan huruf kapital sesuai kata asli (Contoh: "Keren" -> "Kéren", "KEREN" -> "KÉREN")
 */
function preserveCase(original, replacement) {
  if (!original || !replacement) return replacement;
  if (original === original.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement.toLowerCase();
}

/**
 * Mengubah satu kata bahasa Indonesia jika merupakan kata taling (atau turunan berimbuhan dari kata taling)
 */
export function fixIndonesianWordPhonetics(word) {
  if (!word || typeof word !== 'string') return word;

  const lower = word.toLowerCase();

  // 1. Jika kata sudah memiliki tanda aksen é/è, biarkan
  if (/[éèê]/.test(lower)) {
    return word;
  }

  // 2. Jika kata termasuk dalam daftar pepet yang dilindungi, jangan diubah
  if (PROTECTED_PEPET_WORDS.has(lower)) {
    return word;
  }

  const dictionary = getTalingDictionary();

  // 3. Cek langsung kata dasar di kamus taling (tanpa imbuhan)
  if (dictionary[lower]) {
    return preserveCase(word, dictionary[lower]);
  }

  // 4. Analisis imbuhan (Morphology analysis):
  // 4a. Cek akhiran saja (misal: "kerennya" -> "keren" + "nya")
  for (const suf of SUFFIXES) {
    if (lower.endsWith(suf) && lower.length > suf.length + 2) {
      const stem = lower.slice(0, -suf.length);
      if (PROTECTED_PEPET_WORDS.has(stem)) {
        return word;
      }
      if (dictionary[stem]) {
        return preserveCase(word, dictionary[stem] + suf);
      }
    }
  }

  // 4b. Cek awalan saja (misal: "sekeren" -> "se" + "keren", "menggeser" -> "meng" + "geser")
  for (const pref of PREFIXES) {
    if (lower.startsWith(pref) && lower.length > pref.length + 2) {
      const stem = lower.slice(pref.length);
      if (PROTECTED_PEPET_WORDS.has(stem)) {
        return word;
      }
      if (dictionary[stem]) {
        return preserveCase(word, pref + dictionary[stem]);
      }
    }
  }

  // 4c. Cek kombinasi awalan + akhiran (misal: "dibereskan" -> "di" + "beres" + "kan")
  for (const pref of PREFIXES) {
    if (lower.startsWith(pref) && lower.length > pref.length + 3) {
      for (const suf of SUFFIXES) {
        if (lower.endsWith(suf) && lower.length > pref.length + suf.length + 2) {
          const stem = lower.slice(pref.length, -suf.length);
          if (PROTECTED_PEPET_WORDS.has(stem)) {
            return word;
          }
          if (dictionary[stem]) {
            return preserveCase(word, pref + dictionary[stem] + suf);
          }
        }
      }
    }
  }

  return word;
}

/**
 * Terapkan perbaikan fonetik taling pada seluruh teks naskah
 */
export function applyTalingPhonetics(text) {
  if (!text || typeof text !== 'string') return '';

  // Regex menangkap kata (hanya alfabet dan tanda hubung kata ulang)
  return text.replace(/\b[a-zA-Z]+(?:-[a-zA-Z]+)?\b/g, (match) => {
    // Tangani kata ulang seperti "geser-geser"
    if (match.includes('-')) {
      const parts = match.split('-');
      return parts.map(part => fixIndonesianWordPhonetics(part)).join('-');
    }
    return fixIndonesianWordPhonetics(match);
  });
}
