import { describe, it, expect } from 'vitest';
import { distributeTotal } from '../services/professionalPipelineService.js';

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
