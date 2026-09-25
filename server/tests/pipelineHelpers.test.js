import { describe, it, expect } from 'vitest';
import { distributeTotal } from '../services/professionalPipelineService.js';
import { getNichePreset } from '../config/nichePresets.js';
import { pickValidIdentitySearchQuery } from '../services/discoveryService.js';

describe('pickValidIdentitySearchQuery (fix skip permanen niche smartphone)', () => {
  // Data nyata dari log PC: produk "Oukitel WP500" selalu di-skip "query brand + type tidak valid"
  it('smartphone: query brand+model valid meski productType generik tanpa kata "smartphone"', () => {
    const kw = pickValidIdentitySearchQuery('Oukitel', 'Smartphone', 'WP500', [
      'Oukitel WP500 review indonesia',
      'Oukitel WP500 unboxing',
    ]);
    expect(kw).toBe('Oukitel WP500 review indonesia');
  });

  it('smartphone tanpa model: jatuh ke query yang memuat kata tipe', () => {
    const kw = pickValidIdentitySearchQuery('Poco', 'Smartphone 5G', '', [
      'poco review indonesia',
      'poco X6 smartphone 5g',
    ]);
    expect(kw).toBe('poco X6 smartphone 5g');
  });

  it('tetap menolak query tanpa brand (identitas tidak terjaga)', () => {
    const kw = pickValidIdentitySearchQuery('Infinix', 'Smartphone', 'Hot 40', ['realme gt neo review']);
    expect(kw).toBe('');
  });

  it('kitchen: perilaku lama tetap lolos via kata tipe produk', () => {
    const kw = pickValidIdentitySearchQuery('Gaabor', 'Air Fryer', '', ['gaabor air fryer demo']);
    expect(kw).toBe('gaabor air fryer demo');
  });
});

describe('Niche minVerifiedSources (gate multi-video harvesting)', () => {
  it('smartphone/gadget preset mengizinkan 1 sumber terverifikasi langsung diproses', () => {
    const preset = getNichePreset('gadget_smartphone');
    const target = Math.max(1, Number(preset?.minVerifiedSources) || 2);
    expect(target).toBe(1);
  });

  it('kitchen preset tetap butuh 2 sumber (default lama, tanpa regresi)', () => {
    const preset = getNichePreset('kitchen_tools');
    const target = Math.max(1, Number(preset?.minVerifiedSources) || 2);
    expect(target).toBe(2);
  });
});

describe('Pipeline Helpers', () => {
  describe('distributeTotal', () => {
    it('should distribute total duration correctly within min and max bounds', () => {
      const rawDurations = [3, 4, 3];
      const mins = [2, 2, 2];
      const maxs = [5, 5, 5];
      const total = 12; // sum of max is 15, we need 12. current is 10. Needs +2.

      const result = distributeTotal(rawDurations, total, mins, maxs);
      const sum = result.reduce((a, b) => a + b, 0);

      // We expect the sum to be very close to the requested total
      expect(Math.abs(sum - total)).toBeLessThan(0.05);

      // We expect all values to be within bounds
      result.forEach((val, i) => {
        expect(val).toBeGreaterThanOrEqual(mins[i] - 0.01);
        expect(val).toBeLessThanOrEqual(maxs[i] + 0.01);
      });
    });

    it('should handle exact bounds constraint gracefully', () => {
      const rawDurations = [2, 2];
      const mins = [2, 2];
      const maxs = [3, 3];
      const result = distributeTotal(rawDurations, 6, mins, maxs); // wants 6, but maxs sum to 6.
      
      expect(Math.abs(result[0] - 3)).toBeLessThan(0.01);
      expect(Math.abs(result[1] - 3)).toBeLessThan(0.01);
    });
  });
});
