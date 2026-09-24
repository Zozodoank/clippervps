import { describe, it, expect } from 'vitest';
import {
  scenesToSlotKeys,
  validateScriptSlotAlignment,
  buildSceneVoSegments,
} from '../services/professionalPipelineService.js';
import { build7SlotStoryboardClips } from '../services/ai/promptBuilders.js';

const GADGET_SLOT2 = 'clip2_feature';

function makeScenes(n, voicePrefix = 'Kalimat VO') {
  return Array.from({ length: n }, (_, i) => ({
    sceneNumber: i + 1,
    timeRange: `00:${String(i * 3).padStart(2, '0')} - 00:${String(i * 3 + 3).padStart(2, '0')}`,
    visualDescription: `Klaim visual adegan ${i + 1}`,
    voiceover: `[excited] ${voicePrefix} ${i + 1}`,
  }));
}

describe('Face Policy (Fase 5) - Scene<->VO lockstep', () => {
  describe('scenesToSlotKeys', () => {
    it('pemetaan default by-index ke slotsConfig preset gadget', () => {
      const keys = scenesToSlotKeys('gadget_smartphone', makeScenes(7));
      expect(keys[4]).toBe('clip5_action_demo');
      expect(keys.length).toBe(7);
      expect(keys.every(k => k)).toBe(true);
    });

    it('scene dengan slotKey eksplisit yang valid dipakai; yang ngawur jatuh ke by-index', () => {
      const scenes = makeScenes(7);
      scenes[0].storyboardSlotKey = 'clip7_full_product'; // explicit swap aneh tapi key valid
      const keys = scenesToSlotKeys('gadget_smartphone', scenes);
      expect(keys[0]).toBe('clip7_full_product');
      scenes[1].slotKey = 'bukan_key_asli';
      const keys2 = scenesToSlotKeys('gadget_smartphone', scenes);
      expect(keys2[1]).toBe(GADGET_SLOT2); // fallback by-index
    });
  });

  describe('validateScriptSlotAlignment', () => {
    const creativePlan = { shots: Array.from({ length: 7 }, (_, i) => ({ role: `r${i}` })) };

    it('gadget strict: klip lebih sedikit dari baris VO = error lockstep', () => {
      const clips = Array.from({ length: 5 }, (_, i) => ({ storyboardSlot: i + 1, duration: 3 }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(7), niche: 'gadget_smartphone' });
      expect(res.strictMode).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.errors.some(e => e.includes('lockstep'))).toBe(true);
    });

    it('kitchen: jumlah tidak cocok HANYA warning informatif (ok=true, perilaku lama)', () => {
      const clips = Array.from({ length: 5 }, (_, i) => ({ storyboardSlot: i + 1, duration: 3 }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(7), niche: 'kitchen_tools' });
      expect(res.strictMode).toBe(false);
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('gerbang face policy: clip slot strict bersumber frame camera-eligible = error', () => {
      const eligible = new Set(['/f/kamera.jpg']);
      const clips = Array.from({ length: 7 }, (_, i) => ({
        storyboardSlot: i + 1,
        duration: 3,
        sourceFramePath: i === 1 ? '/f/kamera.jpg' : `/f/clean_${i}.jpg`, // slot 2 (strict) nyolong frame kamera
      }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(7), niche: 'gadget_smartphone', eligibleFramePaths: eligible });
      expect(res.ok).toBe(false);
      expect(res.errors.some(e => e.includes('camera-eligible') && e.includes('strict'))).toBe(true);
    });

    it('gerbang face policy: slot 5 presenter_only BOLEH memakai frame camera-eligible', () => {
      const eligible = new Set(['/f/kamera.jpg']);
      const clips = Array.from({ length: 7 }, (_, i) => ({
        storyboardSlot: i + 1,
        duration: 3,
        sourceFramePath: i === 4 ? '/f/kamera.jpg' : `/f/clean_${i}.jpg`,
      }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(7), niche: 'gadget_smartphone', eligibleFramePaths: eligible });
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
    });
  });

  describe('buildSceneVoSegments', () => {
    it('menghasilkan timeStart akumulatif, voLine tanpa tag emosi, visualClaim per slot', () => {
      const clips = Array.from({ length: 7 }, (_, i) => ({
        storyboardSlot: i + 1,
        duration: 3,
        startSeconds: 10 + i * 20,
        videoId: 'vidA',
      }));
      const segs = buildSceneVoSegments({ clips, scenes: makeScenes(7), creativePlan: { shots: [] }, niche: 'gadget_smartphone' });
      expect(segs.length).toBe(7);
      expect(segs[0].timeStart).toBe(0);
      expect(segs[4].timeStart).toBe(12);
      expect(segs[4].slotKey).toBe('clip5_action_demo');
      expect(segs[4].facePolicy).toBe('presenter_only');
      expect(segs[0].facePolicy).toBe('strict');
      expect(segs[2].voLine).toBe('Kalimat VO 3'); // tag [excited] terbuang
      expect(segs[2].visualClaim).toBe('Klaim visual adegan 3');
      expect(segs[2].sourceVideoId).toBe('vidA');
      expect(segs[2].sourceStartSeconds).toBe(50);
    });
  });

  describe('integrasi solver -> lockstep (end-to-end murni fungsi)', () => {
    it('clip gadget punya sourceFramePath provenance yang cocok dengan pool', () => {
      const frames = Array.from({ length: 12 }, (_, i) => ({
        filePath: `/f/safe_${i}.jpg`,
        timestamp: 8 + i * 9,
        candidateIndex: 0,
        candidate: { id: 'vidA', title: 'Review A', url: 'u', duration: 240 },
        videoId: 'vidA',
      }));
      frames.push({ ...frames[0], filePath: '/f/kamera.jpg', timestamp: 150, isCameraResultEligible: true, cameraResultEligible: true });

      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'gadget_smartphone' });
      expect(clips.every(c => typeof c.sourceFramePath === 'string' && c.sourceFramePath.endsWith('.jpg'))).toBe(true);

      const slot5 = clips.find(c => c.storyboardSlot === 5);
      expect(slot5.sourceFramePath).toBe('/f/kamera.jpg');

      // Validator harus MELULUSKAN susunan slot 5 presenter_only dengan frame kamera
      const res = validateScriptSlotAlignment({
        clips,
        creativePlan: { shots: Array.from({ length: 7 }, (_, i) => ({ role: `r${i}` })) },
        scenes: makeScenes(7),
        niche: 'gadget_smartphone',
        eligibleFramePaths: new Set(['/f/kamera.jpg']),
      });
      expect(res.errors).toEqual([]);
    });
  });
});
