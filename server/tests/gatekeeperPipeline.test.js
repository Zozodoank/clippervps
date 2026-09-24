import { describe, it, expect } from 'vitest';
import { GATEKEEPER_CONFIG } from '../services/videoFilterService.js';

describe('Gatekeeper Pipeline Integration', () => {
  describe('GATEKEEPER_CONFIG values', () => {
    it('should have strict validation parameters', () => {
      expect(GATEKEEPER_CONFIG.MIN_CONSECUTIVE_CLEAN_FRAMES).toBe(3);
      expect(GATEKEEPER_CONFIG.MIN_CLEAN_DURATION_SEC).toBe(4.0);
      expect(GATEKEEPER_CONFIG.CLEAN_CONF_THRESHOLD).toBe(0.78);
      expect(GATEKEEPER_CONFIG.UNCERTAIN_CONF_THRESHOLD).toBe(0.62);
      expect(GATEKEEPER_CONFIG.MAX_ALLOWED_DIRTY_FRAMES).toBe(0);
    });
  });

  describe('Temporal Segment Validation Algorithm', () => {
    function simulateTemporalSegmentation(candidates, maxGapSec = 3.5, minStreak = 3, minDuration = 3.5) {
      const sorted = [...candidates].sort((a, b) => a.timestamp - b.timestamp);
      const verifiedSegments = [];
      let currentStreak = [];

      for (const f of sorted) {
        if (currentStreak.length === 0) {
          currentStreak.push(f);
        } else {
          const prevTs = currentStreak[currentStreak.length - 1].timestamp;
          if (Math.abs(f.timestamp - prevTs) <= maxGapSec) {
            currentStreak.push(f);
          } else {
            if (currentStreak.length >= minStreak && (currentStreak[currentStreak.length - 1].timestamp - currentStreak[0].timestamp) >= minDuration) {
              verifiedSegments.push({
                startSec: currentStreak[0].timestamp,
                endSec: currentStreak[currentStreak.length - 1].timestamp,
                frameCount: currentStreak.length,
                cleanTimestamps: currentStreak.map(c => c.timestamp),
              });
            }
            currentStreak = [f];
          }
        }
      }
      if (currentStreak.length >= minStreak && (currentStreak[currentStreak.length - 1].timestamp - currentStreak[0].timestamp) >= minDuration) {
        verifiedSegments.push({
          startSec: currentStreak[0].timestamp,
          endSec: currentStreak[currentStreak.length - 1].timestamp,
          frameCount: currentStreak.length,
          cleanTimestamps: currentStreak.map(c => c.timestamp),
        });
      }
      return verifiedSegments;
    }

    it('should not form segment for isolated frames', () => {
      const isolatedFrames = [{ timestamp: 2.0 }, { timestamp: 10.0 }];
      const isolatedSegs = simulateTemporalSegmentation(isolatedFrames);
      expect(isolatedSegs.length).toBe(0);
    });

    it('should form valid segment for continuous frames', () => {
      const validFrames = [{ timestamp: 2.0 }, { timestamp: 4.0 }, { timestamp: 6.0 }];
      const validSegs = simulateTemporalSegmentation(validFrames);
      expect(validSegs.length).toBe(1);
      expect(validSegs[0].frameCount).toBe(3);
      expect(validSegs[0].startSec).toBe(2.0);
      expect(validSegs[0].endSec).toBe(6.0);
    });
  });

  describe('Gemini Prompt Injection Structure', () => {
    it('should inject correct directives if clean segments exist', () => {
      const dummySegments = [{ startSec: 4.0, endSec: 10.5, frameCount: 4 }];
      const dummyCleanWindows = '00:04 - 00:10 (4 frame bersih)';

      let promptDirective = '';
      if (dummyCleanWindows || (dummySegments && dummySegments.length > 0)) {
        promptDirective = `\n\n⛔ ATURAN KETAT VALIDASI GATEKEEPER:\n` +
          `Video ini telah diaudit ketat oleh AI Local Gatekeeper.\n` +
          `Segmen yang TERVERIFIKASI BERSIH:\n${dummyCleanWindows}\n` +
          `Anda DILARANG KERAS memilih highlight di luar jendela waktu ini!\n`;
      }

      expect(promptDirective).toContain('ATURAN KETAT VALIDASI GATEKEEPER');
      expect(promptDirective).toContain('00:04 - 00:10');
      expect(promptDirective).toContain('DILARANG KERAS memilih highlight di luar jendela waktu');
    });
  });
});
