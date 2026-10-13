import { describe, it, expect } from 'vitest';
import { planSectionDownloads, applyClusterPaths, pickSectionFor } from '../services/renderSections.js';
import {
  groupClipsBySlot,
  assessStoryboardPlan,
  assembleStoryboardClips,
  validateScriptSlotAlignment,
} from '../services/professionalPipelineService.js';
import { getNichePreset } from '../config/nichePresets.js';

// ============================================================================
// RANTAI PENUH "instruksi Gemini -> unduhan section -> susun klip".
// Murni (tanpa jaringan/ffmpeg): mensimulasikan hasil unduhan per-cluster persis
// pola produksi stage1Render (ref._cluster = { videoPath, sourceOffsetSec }),
// lalu memakai helper produksi yang sama (applyClusterPaths + sort per-slot)
// untuk membuktikan klip tersusun sesuai instruksi Gemini dari FILE SEG MEN yang benar.
// ============================================================================

const gadgetSlots = getNichePreset('gadget_smartphone')?.slotsConfig || [];

// Klip ala Gemini: 2 kandidat; slot 1 montase (2 klip berjauhan -> 2 cluster terpisah).
function geminiClips() {
  return [
    { candidateIndex: 0, candidateUrl: 'https://yt/v0', storyboardSlot: 1, storyboardSlotKey: 'clip1_opening_spec', startSeconds: 20, duration: 8 },
    { candidateIndex: 0, candidateUrl: 'https://yt/v0', storyboardSlot: 1, storyboardSlotKey: 'clip1_opening_spec', startSeconds: 120, duration: 7 },
    { candidateIndex: 0, candidateUrl: 'https://yt/v0', storyboardSlot: 2, storyboardSlotKey: 'clip2_memory', startSeconds: 200, duration: 8 },
    { candidateIndex: 1, candidateUrl: 'https://yt/v1', storyboardSlot: 3, storyboardSlotKey: 'clip3_perf', startSeconds: 30, duration: 8 },
    { candidateIndex: 1, candidateUrl: 'https://yt/v1', storyboardSlot: 4, storyboardSlotKey: 'clip4_camera', startSeconds: 60, duration: 8 },
    { candidateIndex: 1, candidateUrl: 'https://yt/v1', storyboardSlot: 5, storyboardSlotKey: 'clip5_price_cta', startSeconds: 90, duration: 8 },
  ];
}

// Simulasi loop unduhan stage1Render: per kandidat -> cluster -> file segmen + katalog.
function simulateSectionDownload(clips, { padSec = 2, tailPadSec = 5, gapSec = 15 } = {}) {
  const catalog = new Map(); // candIdx -> [{ videoPath, sourceOffsetSec, endSec }]
  const candIndices = [...new Set(clips.map((c) => c.candidateIndex))];
  for (const candIdx of candIndices) {
    const candClips = clips.filter((c) => c.candidateIndex === candIdx);
    const clusters = planSectionDownloads(candClips, { padSec, tailPadSec, gapSec });
    clusters.forEach((cluster, k) => {
      const videoPath = `cand${candIdx}_seg${k}.mp4`;
      if (!catalog.has(candIdx)) catalog.set(candIdx, []);
      catalog.get(candIdx).push({ videoPath, sourceOffsetSec: cluster.sourceOffsetSec, endSec: cluster.endSec });
      cluster.refs.forEach((ref) => { ref._cluster = { videoPath, sourceOffsetSec: cluster.sourceOffsetSec }; });
    });
  }
  return catalog;
}

// Transformasi produksi pasca-download (stage1Render): applyClusterPaths + sort stabil per-slot.
function productionMapAndSort(clips, fallbackMap = new Map()) {
  const mapped = applyClusterPaths(clips, fallbackMap);
  return [...mapped].sort((a, b) => (Number(a.storyboardSlot) || 99) - (Number(b.storyboardSlot) || 99));
}

describe('rantai Gemini -> unduhan section -> susun klip', () => {
  it('montase slot 1 berjauhan (gap > gapSec) terpecah ke cluster terpisah milik kandidat yang sama', () => {
    const clips = geminiClips();
    const cand0 = clips.filter((c) => c.candidateIndex === 0);
    const clusters = planSectionDownloads(cand0, { padSec: 2, tailPadSec: 5, gapSec: 15 });
    // t=20(+8=28) vs t=120: gap 92s; t=120(+7=127) vs t=200: gap 73s -> 3 cluster.
    expect(clusters.length).toBe(3);
    for (const cluster of clusters) {
      for (const ref of cluster.refs) {
        expect(cluster.startSec).toBeLessThanOrEqual(ref.startSeconds);
        expect(cluster.endSec).toBeGreaterThanOrEqual(ref.startSeconds + ref.duration);
      }
    }
  });

  it('klip tersusun sesuai instruksi Gemini: timeline per-slot, montase paling awal, tiap klip dari file segmen yang MEMUATnya', () => {
    const clips = geminiClips();
    const catalog = simulateSectionDownload(clips);
    const final = productionMapAndSort(clips);

    // (a) Urutan timeline = slot ascending; montase slot 1 di indeks 0-1 (00:00).
    expect(final.map((c) => c.storyboardSlot)).toEqual([1, 1, 2, 3, 4, 5]);

    // (b) Grup per-slot sesuai kontrak: 5 grup, slot 1 = 2 klip.
    const groups = groupClipsBySlot(final);
    expect(groups.map((g) => g.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(groups[0].clips.length).toBe(2);

    // (c) Tiap klip memakai file segmen yang memuat startSeconds-nya BUKAN file pertama kandidat,
    //     dan -ss renderer (startSeconds - sourceOffsetSec) berada di dalam file.
    for (const c of final) {
      const entries = catalog.get(c.candidateIndex);
      const chosen = entries.find((e) => e.videoPath === c.videoPath);
      expect(chosen, `klip slot ${c.storyboardSlot} harus punya entri katalog untuk file-nya`).toBeTruthy();
      expect(chosen.sourceOffsetSec).toBeLessThanOrEqual(c.startSeconds);
      expect(c.startSeconds + c.duration).toBeLessThanOrEqual(chosen.endSec);
      const fileStart = c.startSeconds - chosen.sourceOffsetSec;
      const fileDur = chosen.endSec - chosen.sourceOffsetSec;
      expect(fileStart).toBeGreaterThanOrEqual(0);
      expect(fileStart + c.duration).toBeLessThanOrEqual(fileDur);
    }
    // Klip slot 2 (t=200) wajib dilayani segmen TERAKHIR kandidat 0, bukan seg0.
    expect(final.find((c) => c.storyboardSlot === 2).videoPath).toBe('cand0_seg2.mp4');
    // Montase: dua klip slot 1 dari DUA file segmen berbeda (t=20 dan t=120 saling jauh).
    const montagePaths = final.filter((c) => c.storyboardSlot === 1).map((c) => c.videoPath);
    expect(new Set(montagePaths).size).toBe(2);

    // (d) penanda internal tidak bocor ke renderer.
    expect(final.every((c) => c._cluster === undefined)).toBe(true);
    expect(final.every((c) => typeof c.sourceOffsetSec === 'number')).toBe(true);
  });

  it('rencana hasil rantai lulus assessStoryboardPlan (>=45s) + validator lockstep 5 baris VO (mode montase)', () => {
    const clips = geminiClips();
    simulateSectionDownload(clips);
    const final = productionMapAndSort(clips);

    const assessment = assessStoryboardPlan(final, gadgetSlots, { requiredTotalSec: 45 });
    expect(assessment.ok).toBe(true);
    expect(assessment.missingSlots).toEqual([]);
    expect(assessment.totalDurationSec).toBeGreaterThanOrEqual(45);

    // assembleStoryboardClips idempoten untuk rencana yang sudah satu grup per slot.
    const assembled = assembleStoryboardClips(final, gadgetSlots);
    expect(assembled.length).toBe(6);
    expect(groupClipsBySlot(assembled).map((g) => g.slot)).toEqual([1, 2, 3, 4, 5]);

    const scenes = Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1,
      timeRange: `00:${String(i * 6).padStart(2, '0')} - 00:${String(i * 6 + 6).padStart(2, '0')}`,
      visualDescription: `Adegan ${i + 1}`,
      voiceover: `[excited] Kalimat VO ${i + 1}`,
    }));
    const res = validateScriptSlotAlignment({
      clips: assembled,
      creativePlan: { shots: Array.from({ length: 5 }, (_, i) => ({ role: `r${i}` })) },
      scenes,
      niche: 'gadget_smartphone',
    });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('gerbang floor smartphone (Fix 4): 6 klip / 5 grup durasi >= 45s LULUS; 5 klip / 4 grup tertolak', () => {
    const clips = geminiClips();
    simulateSectionDownload(clips);
    const final = productionMapAndSort(clips);
    const finalDur = final.reduce((s, c) => s + (Number(c.duration) || 0), 0);
    const groups = groupClipsBySlot(final).filter((g) => g.slot > 0).length;
    // Hitung lama "clips.length < 8" akan menolak rencana sah ini (6 klip) -> false-positive.
    expect(final.length).toBe(6);
    expect(groups >= 5 && finalDur >= 45).toBe(true);

    // Slot 1 Kehilangan SATU klip montase: grup tetap 5 tapi durasi anjlok < 45 -> gerbang tetap menolak.
    const droppedOne = final.filter((c, i) => i !== 1);
    expect(groupClipsBySlot(droppedOne).filter((g) => g.slot > 0).length).toBe(5);
    expect(droppedOne.reduce((s, c) => s + c.duration, 0)).toBeLessThan(45);

    // Slot 1 hilang TOTAL (kedua klip montase gagal terunduh): grup tinggal 4 -> gerbang menolak.
    const dropped = final.filter((c) => Number(c.storyboardSlot) !== 1);
    const droppedGroups = groupClipsBySlot(dropped).filter((g) => g.slot > 0).length;
    expect(droppedGroups).toBe(4);
    expect(droppedGroups < 5 || dropped.reduce((s, c) => s + c.duration, 0) < 45).toBe(true);
  });

  it('klip pemulihan pasca-audit resolve ke segmen yang benar lewat katalog (Fix 2), bukan file pertama', () => {
    const clips = geminiClips();
    const catalog = simulateSectionDownload(clips);
    // Frame pooled di t=121 (kandidat 0) harus mendarat di segmen #1 (118-132), bukan seg0.
    const pick = pickSectionFor(catalog.get(0), 121, 3.8);
    expect(pick).toEqual({ videoPath: 'cand0_seg1.mp4', sourceOffsetSec: expect.any(Number) });
    expect(pick.sourceOffsetSec).toBeLessThanOrEqual(121);
    // Frame di luar semua segmen (t=160 celah antar-cluster) -> null: DILEWATI, bukan salah file.
    expect(pickSectionFor(catalog.get(0), 160, 3.8)).toBeNull();
  });
});
