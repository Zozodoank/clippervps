import { describe, it, expect } from 'vitest';
import { parseDuration, parseResolution } from '../services/finalMasterQcService.js';

describe('Final Master QC Parsers', () => {
  describe('parseDuration', () => {
    it('should correctly parse valid FFmpeg duration strings', () => {
      expect(parseDuration('Duration: 00:01:23.45, start:')).toBe(83.45);
      expect(parseDuration('  Duration: 01:10:05.00 ')).toBe(4205);
      expect(parseDuration('Duration: 00:00:15')).toBe(15);
    });

    it('should return null for invalid strings', () => {
      expect(parseDuration('No duration here')).toBeNull();
      expect(parseDuration('')).toBeNull();
      expect(parseDuration()).toBeNull();
    });
  });

  describe('parseResolution', () => {
    it('should correctly parse valid FFmpeg Video output', () => {
      const ffmpegOutput = `
      Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
        Metadata:
          major_brand     : isom
        Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s
        Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 1000 kb/s, 30 fps, 30 tbr, 90k tbn, 60 tbc (default)
      `;
      expect(parseResolution(ffmpegOutput)).toEqual({ width: 1920, height: 1080 });
    });

    it('should return null if resolution is not found', () => {
      expect(parseResolution('Audio: aac, 44100 Hz, stereo')).toBeNull();
      expect(parseResolution('')).toBeNull();
      expect(parseResolution()).toBeNull();
    });
  });
});
