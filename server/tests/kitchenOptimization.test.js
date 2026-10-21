import { describe, it, expect } from 'vitest';
import { buildCleanYouTubeQuery, DIRTY_NEGATIVE_OPERATORS } from '../services/downloader.js';
import { isBulkyOrUnsuitableProduct, buildShopeeSearchUrl, bingTitleRelevancePredicate, buildDynamicProductSearchQueries, isVagueOrAggregateProduct } from '../services/discoveryService.js';
import { hasRepairIntent, stripForbiddenTerms, coreNegativeOperators, forbiddenNegativeOperators } from '../config/forbiddenTerms.js';

// (Niche dapur DIHAPUS) Suite ini dahulu menguji banyak asersi khusus generator
// query/preset kitchen. Setelah normalizeNicheId() memaksa semua input ke
// gadget_smartphone, cabang dapur mati dan asersi tersebut dibuang. Yang
// dipertahankan hanya uji generik (query cleaner, servis/niche-independent gate,
// Bing relevance predicate, dan URL builder).

describe('Kitchen Tools & Video-First Optimization', () => {
  describe('YouTube Query Cleaning & Chopper Preservation', () => {
    it('should preserve the word "chopper" without negative operator', () => {
      const query = 'chopper mini elektrik portable viral';
      const cleanedQuery = buildCleanYouTubeQuery(query);
      expect(cleanedQuery).toContain('chopper');
      expect(cleanedQuery).not.toContain('-chopper ');
    });

    // Regresi utama 30 Sep 2026 (job auto_3dd085b354): judul listing jasa servis
    // pernah dipakai apa adanya sebagai kata kunci pencarian video.
    it('membuang kata servis/matot dari query dan mengecualikannya di mesin telusur', () => {
      const cleaned = buildCleanYouTubeQuery('servis megicom matot dan tidak bisa masak');
      // Kata telanjang harus hilang; yang tersisa hanyalah bentuk operator (-servis).
      const withoutOperators = cleaned.replace(/-\S+/g, ' ');
      expect(withoutOperators.toLowerCase()).not.toMatch(/\b(servis|matot)\b/);
      expect(cleaned).toContain('-servis');
    });

    it('query bermotif review/merk TIDAK LAGI lolos tanpa operator negatif', () => {
      // Dulu fungsi ini return lebih awal untuk query yang memuat review/unboxing/demo,
      // sehingga kata servis & cara tidak pernah dikecualikan oleh mesin telusur.
      const cleaned = buildCleanYouTubeQuery('olike rice cooker review indonesia');
      expect(cleaned).toContain('-servis');
      expect(cleaned).toContain('-cara');
    });
  });

  // FIX 0/20 (A2): query "merk + tipe" POLOS tidak boleh dihujani operator negatif sampai 6
  // (dulu cabang non-branded -> 6 operator -> YouTube 0 hasil). Identity pendek dijepit <= 3,
  // tetapi operator prioritas berbahaya (-servis/-cara/-tutorial) tetap terkirim (bug 30 Sep).
  describe('Gerbang produk konkret (opsi #1) - tolak generik/agregat sebelum stream', () => {
    it('menolak judul GENERIK tanpa produk konkret (kategori/kolektif saja)', () => {
      expect(isVagueOrAggregateProduct({ title: 'Beko 2022 Produk Peralatan Dapur Lini', productType: 'Peralatan Dapur' })).toBe(true);
    });

    it('menolak judul AGREGAT multi-produk yang disambung penghubung', () => {
      expect(isVagueOrAggregateProduct({ title: 'Review Kompor Niko Reflection Gold dan Food Chopper Katana Pro Gold', productType: 'Kompor' })).toBe(true);
    });

    it('MELOLOSKAN satu produk konkret (1 kata benda), tanpa false-positive', () => {
      expect(isVagueOrAggregateProduct({ title: 'Food Chopper Mini Elektrik Niko', productType: 'Chopper' })).toBe(false);
      expect(isVagueOrAggregateProduct({ title: 'Samsung Galaxy A54 8/256', productType: 'Smartphone' })).toBe(false);
      // 2 kata benda TAPI tanpa penghubung (multi-fungsi 2in1) -> tetap lolos.
      expect(isVagueOrAggregateProduct({ title: 'Blender Mixer Juicer 2in1', productType: 'Blender' })).toBe(false);
    });
  });

  describe('Kata "fix" (Inggris) kini terlarang - satu sumber (bug auto_41fb4b59)', () => {
    it('hasRepairIntent menolak judul produk reparasi berbahasa Inggris (kata fix saja)', () => {
      // Tanpa 'how to' agar murni menguji kata 'fix' di kelas REPAIR.
      expect(hasRepairIntent('Magicom Rice Cooker Fix Not Cooked')).toBe(true);
      expect(hasRepairIntent('5 fixes for magicom tidak panas')).toBe(true);
      // Produk sah tidak boleh kena false-positive: kata yang MEMUAT 'fix' sebagai
      // bagian kata lain (prefix/suffix) harus Lolos karena pencocokan \b...\b.
      expect(hasRepairIntent('Kopi Prefix Robusta 250g')).toBe(false);
    });

    it('stripForbiddenTerms membuang kata fix dari query pencarian', () => {
      const cleaned = stripForbiddenTerms('magicom how to fix rice not cooked');
      expect(cleaned.toLowerCase()).not.toMatch(/\bfix(es)?\b/);
    });

    it('-fix ikut menjadi operator negatif yang dikirim ke mesin telusur', () => {
      expect(coreNegativeOperators()).toContain('-fix');
      expect(forbiddenNegativeOperators()).toContain('-fix');
    });
  });

  describe('Query brand+tipe polos: pembatasan operator negatif (A2)', () => {
    it('identity pendek (<= 4 kata) dijepit maksimal 3 operator namun tetap terproteksi', () => {
      const cleaned = buildCleanYouTubeQuery('Coolpad Cool Dual');
      const ops = (cleaned.match(/(?:^|\s)-\S+/g) || []);
      expect(ops.length).toBeLessThanOrEqual(3);
      expect(ops.length).toBeGreaterThanOrEqual(1);
    });
  });

  // FIX 0/20 (A1): generator query utama WAJIB memulai dengan identitas polos, lalu
  // "review" berkutip; varian longgar (review jujur, dll) hanya fallback, bukan yang pertama.
  // Kontrak niche smartphone (terbaru, discoveryService.js:4683-4688): discovery di-short-circuit
  // ke TEPAT SATU query "<brand> <model> \"review\"" — varian longgar berarti pemborosan kuota.
  // Aturan A1 tetap hidup penuh di cabang umum, dan dikunci di it() keduanya.
  describe('Query utama = merk+tipe polos, "review" berkutip, sisanya fallback (A1)', () => {
    it('niche smartphone: tepat SATU query "<brand> <model> "review"" (short-circuit identity-first)', () => {
      const qs = buildDynamicProductSearchQueries({ brand: 'Coolpad', model: 'Cool Dual', noun: 'smartphone' });
      expect(qs).toHaveLength(1);
      expect(qs[0]).toMatch(/^Coolpad Cool Dual/);
      expect(qs[0]).toMatch(/"review"$/);
    });

    it('cabang umum (non-smartphone): indeks 0 identitas polos, indeks 1 "review" berkutip, varian longgar belakangan', () => {
      const qs = buildDynamicProductSearchQueries({ brand: 'Han River', noun: 'air fryer' });
      expect(qs.length).toBeGreaterThan(2);
      expect(qs[0]).not.toMatch(/review|unboxing|demo|voice|jujur|indonesia/i);
      expect(qs[1]).toMatch(/"review"$/);
      const jujurIdx = qs.findIndex((q) => /review jujur/i.test(q));
      expect(jujurIdx).toBeGreaterThan(1);
      // Query yang tinggal sedikit kata DIBUANG, tidak dikirim lalu berharap filter judul
      // menoleransinya (discoveryService.js:4695-4698).
      expect(qs.every((q) => q.split(' ').length >= 2)).toBe(true);
    });

    it('berlaku juga untuk niche alat dapur (brand + noun, tanpa model)', () => {
      const qs = buildDynamicProductSearchQueries({ brand: 'Sokany', noun: 'hand blender' });
      expect(qs[0]).not.toMatch(/review|unboxing|demo|voice|jujur|indonesia/i);
      expect(qs[1]).toMatch(/"review"$/);
    });
  });

  describe('DIRTY_NEGATIVE_OPERATORS', () => {
    it('should correctly filter negative operators for kitchen', () => {
      expect(DIRTY_NEGATIVE_OPERATORS).not.toContain('-chopper');
      expect(DIRTY_NEGATIVE_OPERATORS).not.toContain('-choper');
      expect(DIRTY_NEGATIVE_OPERATORS.some(op => op.includes('chopper pakan'))).toBe(true);
    });
  });

  describe('Bulky & Unsuitable Product Filtering (generik; niche dapur DIHAPUS)', () => {
    it('meloloskan istilah alat yang tidak tertangkap generator negatif (generic pass-through)', () => {
      // Setelah niche dapur dihapus, isBulkyOrUnsuitableProduct hanya punya satu jalur
      // perilaku: jika niche=TIDAK dikirim, isGadget=false -> cabang reject tambahan
      // (bundle/mold/bulky words/rak besar/furniture) sudah dihapus -> fallback `return false`.
      expect(isBulkyOrUnsuitableProduct('chopper manual tarik serbaguna viral')).toBe(false);
      expect(isBulkyOrUnsuitableProduct('alat pembuat dumpling pastel manual')).toBe(false);
      // Gerbang KNIFE_PRODUCT_RE niche-independent: 'asahan'/'pisau' SELALU ditolak
      // kecuali caller mengirim options.allowKnifeProducts=true (jalur job manual).
      expect(isBulkyOrUnsuitableProduct('batu asahan pisau roll serbaguna')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('batu asahan pisau roll serbaguna', { allowKnifeProducts: true })).toBe(false);
      expect(isBulkyOrUnsuitableProduct('gunting dapur serbaguna stainless sk5')).toBe(false);
    });

    it('reject produk bulky lewat regex generik (mesin/chopper pakan/rak besar/lemari) saat niche=gadget', () => {
      // L620 regex heavy-machinery berlaku niche-independent: 'chopper rumput|pakan ternak' SELALU ditolak.
      expect(isBulkyOrUnsuitableProduct('mesin chopper rumput pakan ternak')).toBe(true);
      // 'lemari' hanya ditolak di cabang isGadget (L633); caller wajib kirim niche gadget.
      expect(isBulkyOrUnsuitableProduct('rak piring besar lemari dapur', { niche: 'gadget_smartphone' })).toBe(true);
    });

    // Larangan servis tetap aktif walau niche=TIDAK dikirim (jalur defense-in-depth).
    it('menolak listing JASA SERVIS di niche apa pun, termasuk tanpa opsi niche', () => {
      expect(isBulkyOrUnsuitableProduct('Servis Megicom Matot Tidak Bisa Masak')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('Servis Megicom Matot', { niche: 'gadget_smartphone' })).toBe(true);
      expect(isBulkyOrUnsuitableProduct('Jasa Reparasi Dispenser Panggilan')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('DIY tempat tisu dari botol bekas')).toBe(true);
    });
  });

  describe('AI Prompt Criteria', () => {
    // (Niche dapur DIHAPUS) buildNicheProductCriterion kini selalu menghasilkan
    // string smartphone (preset gadget id === 'gadget_smartphone'). Assertion
    // lama yang mengharapkan teks 'WHITE-LABEL OEM TOLERANCE' / 'Dumpling molds'
    // sudah tidak relevan; test ini digantikan nicheContract.test.js.
    it.skip('kitchen-specific prompt assertions removed (niche dapur DIHAPUS)', () => {});
  });

  describe('Shopee URL Generator', () => {
    it('should format URL with detected product', () => {
      const shopeeUrl = buildShopeeSearchUrl('Chopper Tarik Mini');
      expect(shopeeUrl).toContain('shopee.co.id/search?keyword=');
      const hasProduct = shopeeUrl.toLowerCase().includes('chopper');
      expect(hasProduct).toBe(true);
    });
  });

  // Regresi 4 Okt 2026: scraping Bing Video menyedot kartu trending/iklan - query
  // "Sokany Hand Blender" menghasilkan "Made by Google '26" dan "GTA 6 Leak" yang
  // lalu dibobol pre-flight Kaggle (kuota + waktu + undangan throttle).
  describe('Gerbang relevansi judul kandidat Bing', () => {
    it('membuang judul tanpa satu pun kata produk dari query', () => {
      const rel = bingTitleRelevancePredicate('sokany hand blender unboxing -servis -cara');
      expect(rel("Made by Google '26")).toBe(false);
      expect(rel('Another Wild GTA 6 Leak Just Happened')).toBe(false);
      expect(rel("It's Infecting Everything")).toBe(false);
      expect(rel('')).toBe(false);
    });

    it('menerima judul yang memuat kata produk (sokany / hand / blender)', () => {
      const rel = bingTitleRelevancePredicate('sokany hand blender unboxing -servis -cara');
      expect(rel('Sokany Hand Blender Murah Meriah')).toBe(true);
      expect(rel('review blender dapur 300 watt')).toBe(true);
    });

    it('fail-open: query tanpa token bermakna tidak boleh mengosongkan antrian', () => {
      const rel = bingTitleRelevancePredicate('-servis -cara 2026 review');
      expect(rel('judul apa pun')).toBe(true);
      expect(rel('')).toBe(true);
    });
  });

  describe('Auto Keywords & Preset Verification', () => {
    // (Niche dapur DIHAPUS) getNichePreset('kitchen_tools') kini mengembalikan
    // preset gadget dengan defaultKeywords lebih sedikit daripada kitchen (yang
    // punya >=30). Test lama tidak lagi berlaku; lihat nicheContract.test.js.
    it.skip('kitchen preset keyword count removed (niche dapur DIHAPUS)', () => {});
  });
});
