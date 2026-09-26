import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DICT_PATH = path.join(__dirname, '..', 'english_dictionary.json');

// Default initial seed lexicon for affiliate e-commerce products
export const SEED_ENGLISH_LEXICON = {
  "steak": "stik",
  "juicy": "jusi",
  "online": "onlain",
  "chopper": "coper",
  "mini chopper": "mini coper",
  "food chopper": "fud coper",
  "stainless steel": "stenlis stil",
  "stainless": "stenlis",
  "air fryer": "er frayer",
  "food grade": "fud gret",
  "portable": "portabel",
  "wireless": "wayerles",
  "rechargeable": "ricarji-bel",
  "waterproof": "woterpruf",
  "best seller": "paling laris",
  "flash sale": "flas sel",
  "checkout": "cekout",
  "worth it": "wortit",
  "aesthetic": "estetik",
  "exclusive": "eksklusif",
  "magic": "mejik",
  "blade": "bleid",
  "handle": "hendel",
  "lock": "lok",
  "steamer": "stimer",
  "grill": "gril",
  "fry pan": "fray pen",
  "pan": "pen",
  "sealer": "siler",
  "spray": "sprei",
  "bottle": "botol",
  "brush": "bras",
  "vacuum": "fakum",
  "cleaner": "kliner",
  "sponge": "spons",
  "organizer": "organaiser",
  "holder": "holder",
  "hanger": "henger",
  "smart": "smart",
  "power": "pawer",
  "speed": "spid",
  "touch": "tac",
  "switch": "swic",
  "compact": "kompak"
};

/**
 * Loads the dictionary from english_dictionary.json, creating it with seed words if missing.
 */
export function loadEnglishDictionary() {
  try {
    if (!fs.existsSync(DICT_PATH)) {
      fs.writeFileSync(DICT_PATH, JSON.stringify(SEED_ENGLISH_LEXICON, null, 2), 'utf8');
      return { ...SEED_ENGLISH_LEXICON };
    }
    const content = fs.readFileSync(DICT_PATH, 'utf8');
    const parsed = JSON.parse(content);
    return { ...SEED_ENGLISH_LEXICON, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (err) {
    console.warn('[DictionaryService] Gagal membaca english_dictionary.json:', err.message);
    return { ...SEED_ENGLISH_LEXICON };
  }
}

/**
 * Saves new entries to english_dictionary.json, merging with existing dictionary.
 */
export function saveToEnglishDictionary(newEntries = {}) {
  if (!newEntries || typeof newEntries !== 'object') return;
  const validEntries = {};
  for (const [key, val] of Object.entries(newEntries)) {
    const cleanKey = String(key || '').toLowerCase().trim();
    const cleanVal = String(val || '').toLowerCase().trim();
    if (cleanKey && cleanVal && cleanKey !== cleanVal) {
      validEntries[cleanKey] = cleanVal;
    }
  }

  if (Object.keys(validEntries).length === 0) return;

  try {
    const current = loadEnglishDictionary();
    const merged = { ...current, ...validEntries };
    fs.writeFileSync(DICT_PATH, JSON.stringify(merged, null, 2), 'utf8');
    console.log(`[DictionaryService] ✅ Berhasil menambahkan ${Object.keys(validEntries).length} kata bahasa Inggris ke kamus fonetik:`, Object.keys(validEntries).join(', '));
  } catch (err) {
    console.warn('[DictionaryService] Gagal menyimpan ke english_dictionary.json:', err.message);
  }
}

/**
 * Replaces English words in text with their Indonesian phonetic spelling.
 * Prioritizes multi-word phrases over single words to avoid partial replacements.
 */
export function applyEnglishLexicon(text, customLexicon = {}) {
  if (!text || typeof text !== 'string') return '';
  const dictionary = { ...loadEnglishDictionary(), ...(customLexicon && typeof customLexicon === 'object' ? customLexicon : {}) };
  let result = text;
  // Sort keys by length descending (longest phrase first)
  const terms = Object.keys(dictionary).sort((a, b) => b.length - a.length);

  for (const term of terms) {
    const cleanTerm = term.trim();
    const replacement = String(dictionary[term] || '').trim();
    if (!cleanTerm || !replacement) continue;

    // Escape regex characters
    const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, replacement);
  }

  return result;
}

/**
 * Helper to preserve capitalization from original match to replacement text.
 */
function matchCase(source, target) {
  if (!source || !target) return target;
  if (source === source.toUpperCase() && source.length > 1) {
    return target.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target.toLowerCase();
}

/**
 * Restores phonetic spellings back to clean, standard English and Indonesian text for on-screen video subtitles.
 * Inverts SEED_ENGLISH_LEXICON + auto-learned dictionary, plus common Indonesian phonetic abbreviations.
 */
export function restoreStandardText(text, customLexicon = {}) {
  if (!text || typeof text !== 'string') return '';
  const dictionary = { ...loadEnglishDictionary(), ...(customLexicon && typeof customLexicon === 'object' ? customLexicon : {}) };

  // 1. Invert the English-to-phonetic dictionary: phonetic -> standard English
  const inverseMap = {};
  for (const [englishTerm, phoneticVal] of Object.entries(dictionary)) {
    const cleanPhonetic = String(phoneticVal || '').toLowerCase().trim();
    const cleanEnglish = String(englishTerm || '').trim();
    if (cleanPhonetic && cleanEnglish && cleanPhonetic !== cleanEnglish) {
      inverseMap[cleanPhonetic] = cleanEnglish;
    }
  }

  // 2. Add common Indonesian/e-commerce phonetic reversions
  const additionalReversions = {
    'cekout': 'checkout',
    'wortit': 'worth it',
    'firal': 'viral',
    'fowcer': 'voucher',
    'fidéo': 'video',
    'fideo': 'video',
    'fariasi': 'variasi',
    'farian': 'varian',
    'férsi': 'versi',
    'fersi': 'versi',
    'féntilasi': 'ventilasi',
    'fentilasi': 'ventilasi',
    'fakum': 'vacuum',
    'fitamin': 'vitamin',
    'fintij': 'vintage',
    'redi stok': 'ready stock',
    'ril-pik': 'real pict',
    'gais': 'guys',
    'syopi': 'Shopee',
    'ce o de': 'COD',
    'wan in wan': '1 in 1',
    'tu in wan': '2 in 1',
    'tri in wan': '3 in 1',
    'for in wan': '4 in 1',
    'flas sel': 'flash sale',
    'paling laris': 'best seller',
    'skinker': 'skincare',
    'desain': 'design',
    'reviu': 'review',
    'simpel': 'simple',
    'rekomended': 'recommended',
    'portabel': 'portable',
    'kompak': 'compact',
    'eksklusif': 'exclusive',
    'stenlis': 'stainless',
    'stil': 'steel',
    'frayer': 'fryer',
    'coper': 'chopper',
    'gret': 'grade',
    'flas': 'flash',
    'sel': 'sale',
  };

  const fullInverse = { ...additionalReversions, ...inverseMap };

  let result = text;
  // Sort keys by length descending (longest multi-word phrase first)
  const phoneticTerms = Object.keys(fullInverse).sort((a, b) => b.length - a.length);

  for (const term of phoneticTerms) {
    const cleanTerm = term.trim();
    const standardReplacement = fullInverse[term];
    if (!cleanTerm || !standardReplacement) continue;

    const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, (matched) => matchCase(matched, standardReplacement));
  }

  return result;
}
