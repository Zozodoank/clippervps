import { describe, it, expect } from 'vitest';
import { build7SlotStoryboardClips } from '../services/ai/promptBuilders.js';
import { conformClipsToVoiceover } from '../services/professionalPipelineService.js';
import { getNichePreset, getSlotFacePolicy } from '../config/nichePresets.js';

// Pool frame sintetis: 1 kandidat, timestamp berjauhan (>= 8s) agar lolos guard distinct
function makePool(withEligible) {
  const frames = Array.from({ length: 12 }, (_, i) => ({
    filePath: `/f/safe_${i}.jpg`,
    timestamp: 8 + i * 9, // 8..107
    candidateIndex: 0,
    candidate: { id: 'vidA', title: 'Review Produk A', url: 'https://yt/watch?v=vidA', duration: 240 },
    candidateTitle: 'Review Produk A',
    videoId: 'vidA',
  }));
  if (withEligible) {
    frames.push({
      filePath: '/f/kamera_eligible.jpg',
      timestamp: 150,
      candidateIndex: 0,
      candidate: frames[0].candidate,
      candidateTitle: 'Review Produk A',
      videoId: 'vidA',
      isCameraResultEligible: true,
      cameraResultEligible: true,
    });
  }
  return frames;
}

describe('Face Policy (Fase 4) - storyboard solver & VO conform', () => {
  describe('getSlotFacePolicy (preset contract)', () => {
    it('hanya slot sampel kamera gadget yang presenter_only; semua slot kitchen strict', () => {
      const gadget = getNichePreset('gadget_smartphone');
      const kitchen = getNichePreset('kitchen_tools');
      expect(getSlotFacePolicy(gadget, 'clip7_camera_sample')).toBe('presenter_only');
      expect(getSlotFacePolicy(gadget, 'clip8_camera_detail')).toBe('presenter_only');
      for (const s of gadget.slotsConfig.filter(x => !['clip7_camera_sample', 'clip8_camera_detail'].includes(x.key))) {
        expect(getSlotFacePolicy(gadget, s.key)).toBe('strict');
      }
      for (const s of kitchen.slotsConfig) {
        expect(getSlotFacePolicy(kitchen, s.key)).toBe('strict');
      }
    });
  });

  describe('build7SlotStoryboardClips - pool kamera khusus slot presenter_only', () => {
    it('gadget: slot kamera mengambil frame camera-eligible, slot lain tidak menyentuhnya', () => {
      const frames = makePool(true);
      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'gadget_smartphone' });

      const cameraClip = clips.find(c => c.startSeconds === 150);
      expect(cameraClip).toBeTruthy();
      expect([7, 8]).toContain(cameraClip.storyboardSlot);
      expect(clips.filter(c => c.startSeconds === 150).length).toBe(1);
      expect(clips.length).toBe(8);
    });

    it('gadget: slot lain tetap strict walau frame eligible ada di pool (fallback tidak mencuri)', () => {
      // Pool di mana frame biasa HABIS (semua bentrok), hanya eligible yang tersisa untuk fallback
      const frames = makePool(true).map(f => (f.isCameraResultEligible ? f : { ...f, timestamp: 8 }));
      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'gadget_smartphone' });
      // Hanya slot kamera 7-8 yang boleh pakai eligible.
      for (const c of clips) {
        if (c.storyboardSlot >= 7) continue;
        expect(c.startSeconds).not.toBe(150);
      }
    });

    it('kitchen: frame camera-eligible tidak pernah dipakai slot mana pun', () => {
      const frames = makePool(true);
      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'kitchen_tools' });
      expect(clips.every(c => c.startSeconds !== 150)).toBe(true);
    });

    it('AI memilih index frame eligible untuk slot strict: solver menggantinya dengan frame bersih', () => {
      const frames = makePool(true);
      const eligibleIdx = frames.length; // frameIndex 1-based dari akhir pool
      const parsed = { storyboard: { clip3_action_demo: eligibleIdx } };
      const clips = build7SlotStoryboardClips({ parsed, frames, totalDuration: 240, niche: 'gadget_smartphone' });
      const slot3 = clips.find(c => c.storyboardSlot === 3);
      expect(slot3).toBeTruthy();
      expect(slot3.startSeconds).not.toBe(150);
    });
  });

  describe('conformClipsToVoiceover - strictSceneVoSync melarang loop expansion', () => {
    const baseClips = Array.from({ length: 4 }, (_, i) => ({
      startSeconds: i * 4,
      duration: 3.5,
      candidateIndex: 0,
    }));

    it('kitchen (default): klip diekspansi dengan isConformedLoop saat audio lebih panjang', () => {
      const out = conformClipsToVoiceover({ clips: baseClips, script: '', audioDurationSec: 28, niche: 'kitchen_tools' });
      expect(out.length).toBeGreaterThan(4);
      expect(out.some(c => c.isConformedLoop === true)).toBe(true);
    });

    it('gadget (strictSceneVoSync): jumlah klip TIDAK diekspansi, durasi tetap di-fit ke audio', () => {
      const out = conformClipsToVoiceover({ clips: baseClips, script: '', audioDurationSec: 28, niche: 'gadget_smartphone' });
      expect(out.length).toBe(4);
      expect(out.some(c => c.isConformedLoop === true)).toBe(false);
      const total = out.reduce((s, c) => s + c.duration, 0);
      expect(total).toBeCloseTo(28, 0);
    });

    it('niche tidak dikenal: fail-safe ke perilaku lama (expansion diizinkan)', () => {
      const out = conformClipsToVoiceover({ clips: baseClips, script: '', audioDurationSec: 28, niche: 'niche_gaada' });
      expect(out.some(c => c.isConformedLoop === true)).toBe(true);
    });
  });
});
