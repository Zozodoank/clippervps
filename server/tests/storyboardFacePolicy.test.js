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
    it('hanya slot kamera gadget (slot 4) yang presenter_only; semua slot gadget lain & kitchen strict', () => {
      const gadget = getNichePreset('gadget_smartphone');
      const kitchen = getNichePreset('kitchen_tools');
      expect(getSlotFacePolicy(gadget, 'clip4_camera')).toBe('presenter_only');
      for (const s of gadget.slotsConfig.filter((x) => x.key !== 'clip4_camera')) {
        expect(getSlotFacePolicy(gadget, s.key)).toBe('strict');
      }
      for (const s of kitchen.slotsConfig) {
        expect(getSlotFacePolicy(kitchen, s.key)).toBe('strict');
      }
    });

    it('gadget slotsConfig kini 5 slot: slot 1 montage, kamera = slot 4', () => {
      const gadget = getNichePreset('gadget_smartphone');
      expect(gadget.slotsConfig.length).toBe(5);
      expect(gadget.slotsConfig[0].key).toBe('clip1_opening_spec');
      expect(gadget.slotsConfig[0].montage).toBe(true);
      expect(gadget.slotsConfig[3].key).toBe('clip4_camera');
      expect(gadget.slotsConfig[4].key).toBe('clip5_price_cta');
    });
  });

  describe('build7SlotStoryboardClips - pool kamera khusus slot presenter_only', () => {
    // Kontrak: slot strict gadget HANYA memakai frame storyboard pilihan Gemini (indeks 1-based
    // ke validFrames). Slot tidak diisi B-roll asing bila pilihan tak valid ("do not fill
    // missing scenes"). Karena itu test supply storyboard eksplisit untuk tiap slot.
    it('gadget: slot kamera (4) mengambil frame camera-eligible; total 5 klip', () => {
      const frames = makePool(true);
      // idx 1..12 = frame aman (ts 8..107), idx 13 = frame camera-eligible (ts 150).
      const parsed = {
        storyboard: {
          clip1_opening_spec: 1,
          clip2_memory: 4,
          clip3_durability: 7,
          clip4_camera: 13,
          clip5_price_cta: 10,
        },
      };
      const clips = build7SlotStoryboardClips({ parsed, frames, totalDuration: 240, niche: 'gadget_smartphone' });

      const cameraClip = clips.find(c => c.startSeconds === 150);
      expect(cameraClip).toBeTruthy();
      expect(cameraClip.storyboardSlot).toBe(4);
      expect(clips.filter(c => c.startSeconds === 150).length).toBe(1);
      expect(clips.length).toBe(5);
    });

    it('gadget: slot non-kamera tetap strict walau frame eligible ada di pool (fallback tidak mencuri)', () => {
      // Pool di mana frame biasa HABIS (semua bentrok), hanya eligible yang tersisa untuk fallback
      const frames = makePool(true).map(f => (f.isCameraResultEligible ? f : { ...f, timestamp: 8 }));
      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'gadget_smartphone' });
      // Hanya slot kamera (4) yang boleh pakai eligible.
      for (const c of clips) {
        if (c.storyboardSlot === 4) continue;
        expect(c.startSeconds).not.toBe(150);
      }
    });

    it('kitchen: frame camera-eligible tidak pernah dipakai slot mana pun', () => {
      const frames = makePool(true);
      const clips = build7SlotStoryboardClips({ parsed: {}, frames, totalDuration: 240, niche: 'kitchen_tools' });
      expect(clips.every(c => c.startSeconds !== 150)).toBe(true);
    });

    it('AI memilih frame camera-eligible untuk slot strict: slot tidak mencurinya (dilewati, bukan diisi B-roll)', () => {
      const frames = makePool(true);
      const eligibleIdx = frames.length; // frameIndex 1-based (frame kamera di ujung pool)
      const parsed = { storyboard: { clip2_memory: eligibleIdx } };
      const clips = build7SlotStoryboardClips({ parsed, frames, totalDuration: 240, niche: 'gadget_smartphone' });
      const slot2 = clips.find(c => c.storyboardSlot === 2);
      // Slot strict menolak frame kamera; tanpa frame bersih lain ia DILEWATI (kontrak anti-mencuri),
      // bukan dipaksa memakai B-roll tak relevan.
      expect(slot2).toBeUndefined();
      // Frame camera (ts 150) hanya boleh menempel di slot presenter_only (4).
      for (const c of clips) {
        if (c.storyboardSlot === 4) continue;
        expect(c.startSeconds).not.toBe(150);
      }
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

    it('gadget (strictSceneVoSync): jumlah klip TIDAK diekspansi, durasi di-fit dalam batas footage teraudit', () => {
      // Footage teraudit (4 klip x 8s = 32s) >= audio (28s) -> boleh di-TRIM, tidak ada ekspansi.
      const gadgetClips = Array.from({ length: 4 }, (_, i) => ({
        startSeconds: i * 9,
        duration: 8,
        candidateIndex: 0,
      }));
      const out = conformClipsToVoiceover({ clips: gadgetClips, script: '', audioDurationSec: 28, niche: 'gadget_smartphone' });
      expect(out.length).toBe(4);
      expect(out.some(c => c.isConformedLoop === true)).toBe(false);
      const total = out.reduce((s, c) => s + c.duration, 0);
      expect(total).toBeCloseTo(28, 0);
    });

    it('gadget (strictSceneVoSync): VO lebih panjang dari footage teraudit -> tolak (isRenderPlanShortfall)', () => {
      // Footage (4 x 3.5s = 14s) < audio (28s) dan ekspansi dilarang -> wajib ditolak, bukan
      // memaksakan frame yang belum diaudit ke timeline.
      const shortClips = Array.from({ length: 4 }, (_, i) => ({
        startSeconds: i * 4,
        duration: 3.5,
        candidateIndex: 0,
      }));
      expect(() => conformClipsToVoiceover({ clips: shortClips, script: '', audioDurationSec: 28, niche: 'gadget_smartphone' })).toThrow();
      try {
        conformClipsToVoiceover({ clips: shortClips, script: '', audioDurationSec: 28, niche: 'gadget_smartphone' });
      } catch (err) {
        expect(err.isRenderPlanShortfall).toBe(true);
      }
    });

    it('niche tidak dikenal: fail-safe ke perilaku lama (expansion diizinkan)', () => {
      const out = conformClipsToVoiceover({ clips: baseClips, script: '', audioDurationSec: 28, niche: 'niche_gaada' });
      expect(out.some(c => c.isConformedLoop === true)).toBe(true);
    });
  });
});
