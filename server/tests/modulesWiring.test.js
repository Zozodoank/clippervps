import { describe, it, expect } from 'vitest';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { loadJobsFromDisk, activeJobs, autoRuns } from '../store/jobStore.js';

import { serverRoot, outputDir, tempDir, uploadsDir, rejectedYunetDir, cookiesPath } from '../utils/paths.js';

describe('Path Resolution', () => {
  it('all shared paths must live under server/ and never under api/routes', () => {
    const norm = (p) => p.replace(/\\/g, '/');
    for (const p of [outputDir, tempDir, uploadsDir, rejectedYunetDir, cookiesPath, serverRoot]) {
      const normalizedPath = norm(p);
      expect(normalizedPath).toMatch(/\/server(\/|$)/);
      expect(normalizedPath).not.toContain('api/routes/');
      expect(normalizedPath).not.toMatch(/api\/routes$/);
    }
  });
});

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

  it('loadJobsFromDisk resets a stuck "running" job WITHOUT throwing (better-sqlite3 iterate+write regression)', () => {
    const jobId = 'test_stuck_running';
    activeJobs.set(jobId, { id: jobId, stage: 'running', message: 'sedang diproses' });
    try {
      // Old code wrote via activeJobs.set() inside activeJobs.entries() (.iterate()) and
      // threw "This database connection is busy executing a query", crashing boot.
      expect(() => loadJobsFromDisk()).not.toThrow();
      const after = activeJobs.get(jobId);
      expect(after.stage).toBe('stopped');
    } finally {
      activeJobs.delete(jobId);
    }
  });

  it('loadJobsFromDisk reconciles a stale non-terminal autoRun to "stopped" (phantom Auto Mode fix)', () => {
    const runId = 'test_orphan_autorun';
    autoRuns.set(runId, { runId, status: 'stopping', failures: [], startedAt: new Date().toISOString() });
    try {
      expect(() => loadJobsFromDisk()).not.toThrow();
      expect(autoRuns.get(runId).status).toBe('stopped');
    } finally {
      autoRuns.delete(runId);
    }
  });
});
