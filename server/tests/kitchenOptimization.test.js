import { describe, it, expect } from 'vitest';
import { buildCleanYouTubeQuery, DIRTY_NEGATIVE_OPERATORS } from '../services/downloader.js';
import { isBulkyOrUnsuitableProduct, buildShopeeSearchUrl, getAutoKeywords } from '../services/discoveryService.js';
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

  describe('Auto Keywords & Preset Verification', () => {
    it('should have adequate curated keywords', () => {
      const kitchenPreset = getNichePreset('kitchen_tools');
      expect(kitchenPreset.defaultKeywords.length).toBeGreaterThanOrEqual(30);
      const autoKws = getAutoKeywords(50, { niche: 'kitchen_tools', excludeUsed: false });
      expect(autoKws.length).toBeGreaterThanOrEqual(30);
    });
  });
});
