import { describe, it, expect } from 'vitest';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { loadJobsFromDisk, activeJobs } from '../store/jobStore.js';

describe('Modules Wiring Smoke Test', () => {
  it('should successfully import and call quotaService methods', () => {
    const limit = getDailyOutputVideoLimit();
    expect(limit).toBeGreaterThan(0);
    
    const stats = getDailyOutputVideoStats();
    expect(stats).toHaveProperty('limit');
    expect(stats).toHaveProperty('count');
  });

  it('should successfully import and call antiDupService methods', () => {
    const usedVideoIds = getAllUsedYouTubeVideoIds();
    expect(usedVideoIds).toBeInstanceOf(Set);
    
    const usedBrands = getAllUsedBrandProductPairsToday();
    expect(usedBrands).toBeInstanceOf(Set);
    
    const usedNouns = getAllUsedProductNounsToday();
    expect(usedNouns).toBeInstanceOf(Set);
  });

  it('should successfully import and call jobStore methods', () => {
    expect(typeof loadJobsFromDisk).toBe('function');
    expect(activeJobs).toBeDefined();
    expect(typeof activeJobs.size).toBe('number');
  });
});
