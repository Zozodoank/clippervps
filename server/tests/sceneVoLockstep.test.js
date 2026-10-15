import { describe, it, expect } from 'vitest';
import {
  scenesToSlotKeys,
  validateScriptSlotAlignment,
  buildSceneVoSegments,
  groupClipsBySlot,
  assessStoryboardPlan,
  assembleStoryboardClips,
} from '../services/professionalPipelineService.js';
import { build7SlotStoryboardClips } from '../services/ai/promptBuilders.js';
import { getNichePreset } from '../config/nichePresets.js';

const GADGET_SLOT2 = 'clip2_memory';

function makeScenes(n, voicePrefix = 'Kalimat VO') {
  return Array.from({ length: n }, (_, i) => ({
    sceneNumber: i + 1,
    timeRange: `00:${String(i * 6).padStart(2, '0')} - 00:${String(i * 6 + 6).padStart(2, '0')}`,
    visualDescription: `Klaim visual adegan ${i + 1}`,
    voiceover: `[excited] ${voicePrefix} ${i + 1}`,
  }));
}

describe('Face Policy (Fase 5) - Scene<->VO lockstep', () => {
  describe('scenesToSlotKeys', () => {
    it('pemetaan default by-index ke slotsConfig preset gadget (5 slot)', () => {
      const keys = scenesToSlotKeys('gadget_smartphone', makeScenes(5));
      expect(keys[1]).toBe('clip2_memory');
      expect(keys[3]).toBe('clip4_camera');
      expect(keys[4]).toBe('clip5_price_cta');
      expect(keys.length).toBe(5);
      expect(keys.every(k => k)).toBe(true);
    });

    it('scene dengan slotKey eksplisit yang valid dipakai; yang ngawur jatuh ke by-index', () => {
      const scenes = makeScenes(5);
      scenes[0].storyboardSlotKey = 'clip4_camera'; // explicit swap aneh tapi key valid
      const keys = scenesToSlotKeys('gadget_smartphone', scenes);
      expect(keys[0]).toBe('clip4_camera');
      scenes[1].slotKey = 'bukan_key_asli';
      const keys2 = scenesToSlotKeys('gadget_smartphone', scenes);
      expect(keys2[1]).toBe(GADGET_SLOT2); // fallback by-index
    });
  });

  describe('validateScriptSlotAlignment', () => {
    const creativePlan = { shots: Array.from({ length: 8 }, (_, i) => ({ role: `r${i}` })) };

    it('gadget strict: klip lebih sedikit dari baris VO = error lockstep', () => {
      const clips = Array.from({ length: 5 }, (_, i) => ({ storyboardSlot: i + 1, duration: 3 }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(8), niche: 'gadget_smartphone' });
      expect(res.strictMode).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.errors.some(e => e.includes('lockstep'))).toBe(true);
    });

    it('niche legacy "kitchen_tools" di-koersi ke gadget → strict (niche dapur DIHAPUS)', () => {
      const clips = Array.from({ length: 5 }, (_, i) => ({ storyboardSlot: i + 1, duration: 3 }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(8), niche: 'kitchen_tools' });
      // validateScriptSlotAlignment membaca preset melalui getNichePreset() yang
      // sudah memakai chokepoint normalizeNicheId -> preset gadget (strictSceneVoSync=true).
      // Dengan demikian input legacy 'kitchen_tools' kini berperilaku identik dengan
      // 'gadget_smartphone': jumlah scene & slot harus lockstep.
      expect(res.strictMode).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.errors.some(e => e.includes('lockstep'))).toBe(true);
    });

    it('gerbang face policy: clip slot strict bersumber frame camera-eligible = error', () => {
      const eligible = new Set(['/f/kamera.jpg']);
      const clips = Array.from({ length: 8 }, (_, i) => ({
        storyboardSlot: i + 1,
        duration: 3,
        sourceFramePath: i === 1 ? '/f/kamera.jpg' : `/f/clean_${i}.jpg`, // slot 2 (strict) nyolong frame kamera
      }));
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(8), niche: 'gadget_smartphone', eligibleFramePaths: eligible });
      expect(res.ok).toBe(false);
      expect(res.errors.some(e => e.includes('camera-eligible') && e.includes('strict'))).toBe(true);
    });

    it('gerbang face policy: slot kamera (4) presenter_only BOLEH memakai frame camera-eligible', () => {
      const eligible = new Set(['/f/kamera.jpg']);
      // Model grup-per-slot: slot 1 montase butuh 2 klip (montageMin), slot 2-5 satu klip per slot.
      const clips = [
        { storyboardSlot: 1, duration: 3, sourceFramePath: '/f/clean_0.jpg' },
        { storyboardSlot: 1, duration: 3, sourceFramePath: '/f/clean_1.jpg' },
        ...Array.from({ length: 4 }, (_, i) => ({
          storyboardSlot: i + 2,
          duration: 3,
          sourceFramePath: i === 2 ? '/f/kamera.jpg' : `/f/clean_${i + 2}.jpg`,
        })),
      ];
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(5), niche: 'gadget_smartphone', eligibleFramePaths: eligible });
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
    });

    it('montase valid: 6 klip / 5 grup slot (slot 1 dua klip) dengan 5 scene = lulus tanpa error', () => {
      const clips = [
        { storyboardSlot: 1, duration: 4, startSeconds: 10 },
        { storyboardSlot: 1, duration: 5, startSeconds: 30 },
        { storyboardSlot: 2, duration: 8, startSeconds: 50 },
        { storyboardSlot: 3, duration: 7, startSeconds: 70 },
        { storyboardSlot: 4, duration: 9, startSeconds: 90 },
        { storyboardSlot: 5, duration: 7, startSeconds: 110 },
      ];
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(5), niche: 'gadget_smartphone' });
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
    });

    it('montase kurang dari montageMin (slot 1 cuma 1 klip) = error; non-montase 2 klip = error', () => {
      const tooFew = [
        { storyboardSlot: 1, duration: 3 },
        ...Array.from({ length: 4 }, (_, i) => ({ storyboardSlot: i + 2, duration: 3 })),
      ];
      const resFew = validateScriptSlotAlignment({ clips: tooFew, creativePlan, scenes: makeScenes(5), niche: 'gadget_smartphone' });
      expect(resFew.ok).toBe(false);
      expect(resFew.errors.some(e => e.includes('montase'))).toBe(true);

      const dupSlot2 = [
        { storyboardSlot: 1, duration: 3 },
        { storyboardSlot: 1, duration: 3 },
        { storyboardSlot: 2, duration: 3 },
        { storyboardSlot: 2, duration: 3 },
        { storyboardSlot: 3, duration: 3 },
        { storyboardSlot: 4, duration: 3 },
        { storyboardSlot: 5, duration: 3 },
      ];
      const resDup = validateScriptSlotAlignment({ clips: dupSlot2, creativePlan, scenes: makeScenes(5), niche: 'gadget_smartphone' });
      expect(resDup.ok).toBe(false);
      expect(resDup.errors.some(e => e.includes('non-montase'))).toBe(true);
    });

    it('urutan slot dengan pengulangan montase (1,1,2,3,4,5) bukan penurunan = tidak ada error urutan', () => {
      const clips = [
        { storyboardSlot: 1, duration: 3 },
        { storyboardSlot: 1, duration: 3 },
        { storyboardSlot: 2, duration: 3 },
        { storyboardSlot: 3, duration: 3 },
        { storyboardSlot: 4, duration: 3 },
        { storyboardSlot: 5, duration: 3 },
      ];
      const res = validateScriptSlotAlignment({ clips, creativePlan, scenes: makeScenes(5), niche: 'gadget_smartphone' });
      expect(res.errors.some(e => e.includes('turun'))).toBe(false);
    });
  });

  describe('kontrak montase - helper grup & kecukupan rencana (D2)', () => {
    const gadgetSlots = getNichePreset('gadget_smartphone')?.slotsConfig || [];

    it('groupClipsBySlot: slot sama dikumpulkan, slot 0 paling belakang, input tak memutasi', () => {
      const clips = [
        { storyboardSlot: 2, id: 'a' },
        { storyboardSlot: 1, id: 'b' },
        { id: 'noslot' },
        { storyboardSlot: 1, id: 'c' },
      ];
      const frozen = JSON.stringify(clips);
      const groups = groupClipsBySlot(clips);
      expect(groups.map(g => g.slot)).toEqual([1, 2, 0]);
      expect(groups[0].clips.map(c => c.id)).toEqual(['b', 'c']);
      expect(JSON.stringify(clips)).toBe(frozen);
    });

    it('assessStoryboardPlan: slot lengkap + durasi >= 45s = ok; montase <2 atau durasi kurang = gagal', () => {
      const full = [
        { storyboardSlot: 1, duration: 6 },
        { storyboardSlot: 1, duration: 6 },
        { storyboardSlot: 2, duration: 12 },
        { storyboardSlot: 3, duration: 10 },
        { storyboardSlot: 4, duration: 11 },
        { storyboardSlot: 5, duration: 9 },
      ];
      const okRes = assessStoryboardPlan(full, gadgetSlots, { requiredTotalSec: 45 });
      expect(okRes.ok).toBe(true);
      expect(okRes.totalDurationSec).toBeGreaterThanOrEqual(45);
      expect(okRes.missingSlots).toEqual([]);

      const shortDur = full.map((c) => ({ ...c, duration: 3 }));
      const shortRes = assessStoryboardPlan(shortDur, gadgetSlots, { requiredTotalSec: 45 });
      expect(shortRes.ok).toBe(false);
      expect(shortRes.durationShort).toBe(true);

      const noMontage = full.slice(1);
      const montageRes = assessStoryboardPlan(noMontage, gadgetSlots, { requiredTotalSec: 0 });
      expect(montageRes.ok).toBe(false);
      expect(montageRes.missingSlots.some((s) => s.includes('montase'))).toBe(true);

      const missingSlot3 = full.filter((c) => c.storyboardSlot !== 3);
      const missRes = assessStoryboardPlan(missingSlot3, gadgetSlots, { requiredTotalSec: 0 });
      expect(missRes.missingSlots).toContain('clip3_durability');
    });

    it('assembleStoryboardClips: gabungan 2 sumber jadi satu grup per slot (montase 2-4 sumber sama, slot lain 1 klip)', () => {
      const merged = [
        // Sumber 0: montase slot 1 (3 klip) + slot 2-5
        ...[0, 1, 2].map((i) => ({ storyboardSlot: 1, duration: 5 + i, startSeconds: 10 + i * 20, candidateIndex: 0, candidateUrl: 'u0' })),
        { storyboardSlot: 2, duration: 8, startSeconds: 80, candidateIndex: 0, candidateUrl: 'u0' },
        { storyboardSlot: 3, duration: 7, startSeconds: 90, candidateIndex: 0, candidateUrl: 'u0' },
        { storyboardSlot: 4, duration: 9, startSeconds: 100, candidateIndex: 0, candidateUrl: 'u0' },
        { storyboardSlot: 5, duration: 6, startSeconds: 110, candidateIndex: 0, candidateUrl: 'u0' },
        // Sumber 1: tumpang tindih slot yang sama (klip lebih panjang) - tidak boleh grup ganda
        { storyboardSlot: 2, duration: 12, startSeconds: 40, candidateIndex: 1, candidateUrl: 'u1' },
        { storyboardSlot: 5, duration: 11, startSeconds: 60, candidateIndex: 1, candidateUrl: 'u1' },
      ];
      const out = assembleStoryboardClips(merged, gadgetSlots);
      const slotsOut = out.map((c) => c.storyboardSlot);
      expect(groupClipsBySlot(out).map((g) => g.slot)).toEqual([1, 2, 3, 4, 5]);
      expect(out.find((c) => c.storyboardSlot === 2).candidateIndex).toBe(1); // klip terpanjang menang
      expect(out.find((c) => c.storyboardSlot === 5).candidateIndex).toBe(1);
      const montage = out.filter((c) => c.storyboardSlot === 1);
      expect(montage.length).toBeGreaterThanOrEqual(2);
      expect(montage.length).toBeLessThanOrEqual(4);
      expect(montage.every((c) => c.candidateIndex === 0)).toBe(true); // prioritas satu sumber
      expect(slotsOut.every((s) => s >= 1 && s <= 5)).toBe(true);
    });

    it('assembleStoryboardClips: klip tanpa slot (kitchen) dikembalikan apa adanya', () => {
      const plain = [{ startSeconds: 1 }, { startSeconds: 2 }];
      expect(assembleStoryboardClips(plain, [])).toEqual(plain);
      expect(assembleStoryboardClips(plain, gadgetSlots)).toEqual(plain);
    });
  });

  describe('buildSceneVoSegments', () => {
    it('menghasilkan timeStart akumulatif, voLine tanpa tag emosi, visualClaim per slot', () => {
      const clips = Array.from({ length: 5 }, (_, i) => ({
        storyboardSlot: i + 1,
        duration: 6,
        startSeconds: 10 + i * 20,
        videoId: 'vidA',
      }));
      const segs = buildSceneVoSegments({ clips, scenes: makeScenes(5), creativePlan: { shots: [] }, niche: 'gadget_smartphone' });
      expect(segs.length).toBe(5);
      expect(segs[0].timeStart).toBe(0);
      expect(segs[4].timeStart).toBe(24);
      expect(segs[3].slotKey).toBe('clip4_camera');
      expect(segs[3].facePolicy).toBe('presenter_only');
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

      // Slot strict gadget hanya memakai frame pilihan Gemini; supply storyboard 5-slot.
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
      // Slot 1 montase menghasilkan 2 sub-klip (B8) -> total 6 klip, tetap 5 grup slot.
      expect(clips.length).toBe(6);
      expect(groupClipsBySlot(clips).map((g) => g.slot)).toEqual([1, 2, 3, 4, 5]);
      expect(clips.every(c => typeof c.sourceFramePath === 'string' && c.sourceFramePath.endsWith('.jpg'))).toBe(true);

      const cameraClip = clips.find(c => c.sourceFramePath === '/f/kamera.jpg');
      expect(cameraClip.storyboardSlot).toBe(4);

      // Validator harus meluluskan slot kamera presenter_only dengan frame kamera
      const res = validateScriptSlotAlignment({
        clips,
        creativePlan: { shots: Array.from({ length: 5 }, (_, i) => ({ role: `r${i}` })) },
        scenes: makeScenes(5),
        niche: 'gadget_smartphone',
        eligibleFramePaths: new Set(['/f/kamera.jpg']),
      });
      expect(res.errors).toEqual([]);
    });
  });
});
