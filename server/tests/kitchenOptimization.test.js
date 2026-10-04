import { describe, it, expect } from 'vitest';
import { buildCleanYouTubeQuery, DIRTY_NEGATIVE_OPERATORS } from '../services/downloader.js';
import { isBulkyOrUnsuitableProduct, buildShopeeSearchUrl, getAutoKeywords, bingTitleRelevancePredicate } from '../services/discoveryService.js';
import { buildNicheProductCriterion } from '../services/aiService.js';
import { getNichePreset } from '../config/nichePresets.js';

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

  describe('DIRTY_NEGATIVE_OPERATORS', () => {
    it('should correctly filter negative operators for kitchen', () => {
      expect(DIRTY_NEGATIVE_OPERATORS).not.toContain('-chopper');
      expect(DIRTY_NEGATIVE_OPERATORS).not.toContain('-choper');
      expect(DIRTY_NEGATIVE_OPERATORS.some(op => op.includes('chopper pakan'))).toBe(true);
    });
  });

  describe('Bulky & Unsuitable Product Filtering for Kitchen Tools', () => {
    it('should allow valid kitchen tools', () => {
      expect(isBulkyOrUnsuitableProduct('chopper manual tarik serbaguna viral')).toBe(false);
      expect(isBulkyOrUnsuitableProduct('alat pembuat dumpling pastel manual')).toBe(false);
      expect(isBulkyOrUnsuitableProduct('batu asahan pisau roll serbaguna')).toBe(false);
      expect(isBulkyOrUnsuitableProduct('gunting dapur serbaguna stainless sk5')).toBe(false);
    });

    it('should disqualify bulky or irrelevant agricultural tools', () => {
      expect(isBulkyOrUnsuitableProduct('mesin chopper rumput pakan ternak')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('rak piring besar lemari dapur')).toBe(true);
    });

    // Larangan servis dulunya hanya hidup di dalam blok niche gadget (dan banyak
    // pemanggil tidak mengirim opsi niche sama sekali) -> listing jasa lolos.
    it('menolak listing JASA SERVIS di niche apa pun, termasuk tanpa opsi niche', () => {
      expect(isBulkyOrUnsuitableProduct('Servis Megicom Matot Tidak Bisa Masak')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('Servis Megicom Matot', { niche: 'kitchen_tools' })).toBe(true);
      expect(isBulkyOrUnsuitableProduct('Jasa Reparasi Dispenser Panggilan')).toBe(true);
      expect(isBulkyOrUnsuitableProduct('DIY tempat tisu dari botol bekas')).toBe(true);
    });
  });

  describe('AI Prompt Criteria', () => {
    it('should handle standard mode correctly', () => {
      const standardPrompt = buildNicheProductCriterion('kitchen_tools', 'Chopper Manual', 'Chopper Tarik Mini', false);
      expect(standardPrompt).toContain('WHITE-LABEL OEM TOLERANCE');
      expect(standardPrompt).not.toContain('HIGH-VARIATION COMMODITY & MOLD/KNIFE BAN');
      expect(standardPrompt).toContain('Dumpling molds');
    });

    it('should handle video-first mode correctly', () => {
      const videoFirstPrompt = buildNicheProductCriterion('kitchen_tools', 'Alat Dapur Viral', '', true);
      expect(videoFirstPrompt).toContain('VIDEO-FIRST DISCOVERY DOES NOT OVERRIDE PRODUCT IDENTITY');
      expect(videoFirstPrompt).toContain('The TARGET PRODUCT defines what may be accepted');
    });
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
    it('should have adequate curated keywords', () => {
      const kitchenPreset = getNichePreset('kitchen_tools');
      expect(kitchenPreset.defaultKeywords.length).toBeGreaterThanOrEqual(30);
      const autoKws = getAutoKeywords(50, { niche: 'kitchen_tools', excludeUsed: false });
      expect(autoKws.length).toBeGreaterThanOrEqual(30);
    });
  });
});
