// ─────────────────────────────────────────────────────────────────────────────
// P6.1 (irisan aman): lapisan PURE yang diizinkan keluar dari monolith aiService.js.
// Hanya memuat parser/fallback deterministik TANPA panggilan jaringan, sehingga bisa
// dikunci oleh characterization test (lihat tests/aiResponseParsers.test.js) sebelum
// & sesudah pemindahan. aiService.js tetap re-export `repairJson` & memakai helper ini
// dari sini, sehingga PERMUKAAN PUBLIK aiService tidak berubah bagi konsumennya.
//
// Fungsi AI yang memanggil jaringan (analyzeYouTubeVideoWithGemini, selectHighlightWithAI,
// verify*WithAI, generateAdAdvisorScriptWithAI, detectPhoneticLexiconWithAI) SENGAJA
// BELUM dipindah: gerbang P6.4 mewajibkan 1 job render nyata ujung-ke-ujung setelah tiap
// perpindahan — tidak bisa diverifikasi aman lewat unit test saja.
// ─────────────────────────────────────────────────────────────────────────────
import { formatSeconds } from './aiValidators.js';
import { getDynamicProductHookFallback } from './promptBuilders.js';

/**
 * Perbaiki string JSON rusak dari keluaran LLM (fence code, kutip/bracket belum tertutup).
 * @param {string} raw
 * @returns {object} hasil parse; {} untuk input non-string/kosong; melempar Error bila tetap rusak.
 */
export function repairJson(raw) {
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

/**
 * Bangun daftar scene fallback deterministik (8 template) untuk niche alat dapur.
 * Jumlah scene diturunkan dari durasi; tiap scene memakai template berurutan (dijepit ke indeks terakhir).
 */
export function buildFallbackScenes(productName, segmentDuration, sceneDuration = 3.3) {
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

/**
 * Ratakan scene keluaran AI ke jumlah scene fallback: overlay field dari source (bila ada),
 * fallback ke template. Scene ekstra dari source diabaikan; yang hilang diisi template.
 */
export function normalizeShortScenes(scenes, productName, segmentDuration, sceneDuration = 3.3) {
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
