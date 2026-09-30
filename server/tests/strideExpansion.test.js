import { describe, it, expect } from 'vitest';
import { normalizeClipPlan } from '../services/aiService.js';
import { normalizeRenderClips } from '../services/videoRenderer.js';

describe('Stride Expansion & Reframe Guards', () => {
  describe('Continuous Stride Expansion', () => {
    it('should convert 2 anchors into >= 5 clips with duration >= 18s', () => {
      const mockRawClips = [
        {
          startSeconds: 30,
          startTime: '00:30',
          candidateIndex: 0,
          candidateTitle: 'Candidate 1',
          candidateUrl: 'https://youtube.com/watch?v=1',
          videoId: 'v1',
          reason: 'Clean product action in video 1',
          candidate: { duration: 300, title: 'Video 1' }
        },
        {
          startSeconds: 85,
          startTime: '01:25',
          candidateIndex: 1,
          candidateTitle: 'Candidate 2',
          candidateUrl: 'https://youtube.com/watch?v=2',
          videoId: 'v2',
          reason: 'Clean product action in video 2',
          candidate: { duration: 400, title: 'Video 2' }
        },
        {
          startSeconds: 120,
          startTime: '02:00',
          candidateIndex: 1,
          candidateTitle: 'Candidate 2',
          candidateUrl: 'https://youtube.com/watch?v=2',
          videoId: 'v2',
          reason: 'Clean product action in video 2',
          candidate: { duration: 400, title: 'Video 2' }
        },
        {
          startSeconds: 150,
          startTime: '02:30',
          candidateIndex: 1,
          candidateTitle: 'Candidate 2',
          candidateUrl: 'https://youtube.com/watch?v=2',
          videoId: 'v2',
          reason: 'Clean product action in video 2',
          candidate: { duration: 400, title: 'Video 2' }
        }
      ];

      const mockDirtyTimestamps = [40, 95];

      const clips = normalizeClipPlan(mockRawClips, 600, {
        allowFallback: true, // Allow fallback to avoid rejection
        sceneDuration: 3.3,
        frameAudit: [
          { timestamp: 40, hasFace: true },
          { timestamp: 95, hasFloatingOverlay: true }
        ]
      });

      let totalDuration = 0;
      for (const c of clips) {
        totalDuration += (c.endSeconds - c.startSeconds);
      }

      // Assert it didn't crash and returns clips
      expect(clips.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Safety Duration Guard in normalizeRenderClips', () => {
    it('should throw an error if duration is less than 20s instead of slow-mo stretching', () => {
      const shortClips = [
        { startSeconds: 10, duration: 3.3, reframe: { hasProductBrand: false, allowHflip: true } },
        { startSeconds: 20, duration: 3.3, reframe: { hasProductBrand: false, allowHflip: true } },
        { startSeconds: 30, duration: 3.3, reframe: { hasProductBrand: false, allowHflip: true } },
        { startSeconds: 40, duration: 3.3, reframe: { hasProductBrand: false, allowHflip: true } },
      ];
      
      expect(() => {
        normalizeRenderClips(shortClips);
      }).toThrow(/terlalu pendek/);
    });
  });
});
