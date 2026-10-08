// ─────────────────────────────────────────────────────────────────────────────
// BLUEPRINT ALUR BARU — runSourceAcquisitionV2 (L2 -> L5)
//
// Menggantikan funnel `evaluateCandidate` lama (TAHAP 2-6) + pre-flight + whisper
// window ketika flag ACQUISITION_FLOW=v2 aktif (lihat config/runtimeFlags.js,
// isNewFlowEnabled). L1 (pencarian kandidat gambar+keyword) TETAP dilakukan
// pemanggil (stage1Render) — modul ini menerima `candidatePool` hasil L1.
//
// RANGKAIAN (keputusan user 1c/2b/3/4b):
//   Pre-screen metadata (murah)  ->  ambil klip preview 9:16 -> teruskan frame ke Oracle Kaggle (satu-satunya pemutus visual) ->
//   produk + kebersihan)  ->  pilih >=2 sumber layak (4b)  ->  WINDOW UNIFORM
//   (tengah video)  ->  zigzag per window (2b).
//
// [PERUBAHAN] L3 transkrip Whisper penuh DIHAPUS — video YouTube tidak diwajibkan
// memiliki voice-over. Window ditentukan dari tengah video secara uniform.
//
// Output: { sources, orderedWindows, scriptDraft, diagnostics } siap dipakai
// tahap unduh-per-segmen (L4) & render (L6) yang ADA di stage1Render.
//
// Semantik error (P1-5): gangguan infrastruktur (frame extraction/Whisper/Oracle tidak tersedia)
// dilempar dengan flag `isInfraError` agar master loop TIDAK mem-blacklist; vonis
// konten (produk tak cocok / frame kotor) cukup menjatuhkan kandidat tanpa throw.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'path';
import fs from 'fs';
import { extractVideoId } from '../services/downloader.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  fastProbeLocal,
} from '../services/videoFilterService.js';
import { downloadQuickPreview } from '../services/quickPreviewService.js';
import { analyzeYouTubeVideoWithGemini } from '../services/aiService.js';

// ── HELPER MURNI (diuji terpisah, tanpa I/O/jaringan) ────────────────────────

/**
 * Urutkan kandidat agar "durasi menengah" (paling dekat median target) diproses
 * lebih dulu. Kandidat tanpa durasi diketahui diletakkan di belakang (stabil).
 * @param {Array<{duration?:number}>} pool
 * @param {number} medianTargetSec target tengah (default 480s = 8 menit, ditengah 5-15)
 */
export function rankByMidDuration(pool, medianTargetSec = 480) {
  const withDur = [];
  const noDur = [];
  (pool || []).forEach((c, i) => {
    const d = Number(c?.duration);
    if (Number.isFinite(d) && d > 0) withDur.push({ c, i, gap: Math.abs(d - medianTargetSec) });
    else noDur.push({ c, i });
  });
  withDur.sort((a, b) => a.gap - b.gap || a.i - b.i);
  noDur.sort((a, b) => a.i - b.i);
  return [...withDur.map((x) => x.c), ...noDur.map((x) => x.c)];
}

/**
 * Dari hasil vonis batch, ambil maksimal `requireN` kandidat yang `eligible`,
 * mempertahankan urutan indeks (== urutan pool yang sudah di-rank).
 * @param {Array<{index:number, eligible:boolean}>} verdicts
 * @param {Array} gatedCandidates kandidat yang ikut dikirim ke vonis (indeks selaras)
 * @param {number} requireN jumlah sumber layak yang dikejar (default 2 -> keputusan 4b)
 */
export function pickEligibleSources(verdicts, gatedCandidates, requireN = 2) {
  const chosen = [];
  for (const v of verdicts || []) {
    if (chosen.length >= requireN) break;
    if (v?.eligible) {
      const cand = gatedCandidates[v.index];
      if (cand) chosen.push(cand);
    }
  }
  return chosen;
}

/**
 * Gabungkan window antar-sumber lalu susun zigzag (L5). Mengelompokkan window
 * per sumber, menyusun ulang agar sumber bergantian via interleaveBySource, dan
 * merangkai draf naskah akhir dari potongan teks tiap window.
 * @param {Array} sourcesData [{ sourceId, windows:[{startSec,endSec,scriptDraft}] }]
 * @param {(a,b)=>Array} interleave injeksi interleaveBySource (agar murni & teruji)
 */
export function buildAcquisitionPlan(sourcesData, interleave) {
  const flat = [];
  for (const s of sourcesData || []) {
    for (const w of s.windows || []) {
      flat.push({ ...w, sourceId: s.sourceId });
    }
  }
  const ordered = typeof interleave === 'function'
    ? interleave(flat, { getKey: (x) => x.sourceId })
    : flat;
  const scriptDraft = ordered.map((w) => w.scriptDraft).filter(Boolean).join(' ');
  return { orderedWindows: ordered, scriptDraft, totalWindows: ordered.length };
}

/**
 * JEMBATAN V2 -> struktur legacy yang DIKONSUMSI tahap unduh-per-segmen (L4) & render
 * (L6) di stage1Render: blok hilir membaca `hl.clips[].candidateIndex` ( utk memetakan
 * klip -> file sumber via candidateResults[candIdx].candidate.url ) plus startSeconds/
 * endSeconds. Mapper ini MURNI & teruji supaya bentuk data cocok persis dgn yang
 * diproduksi jalur panen lama (lihat blok rescue/whisper_first yg men-set `hl`).
 * @param {Array<{sourceId,url,meta}>} sources hasil runSourceAcquisitionV2
 * @param {Array<{sourceId,startSec,endSec,scriptDraft}>} orderedWindows (sudah zigzag)
 */
export function buildLegacyStructuresFromV2(sources, orderedWindows) {
  const candidateResults = (sources || []).map((s, i) => ({
    candidateIndex: i,
    candidate: { url: s.url, id: s.sourceId, duration: s.meta?.duration, title: s.meta?.title },
    videoMeta: s.meta,
    // These frames come from the center preview, so convert preview-relative timestamps
    // back to the original YouTube timeline. ClipAudit recovery uses them to build
    // alternative full-resolution sections after a selected window is rejected.
    cleanFrames: (s.cleanFrames || []).map((f) => ({
      ...f,
      candidateIndex: i,
      timestamp: (Number(f.timestamp) || 0) + (Number(s.previewStartSec) || 0),
    })),
    productVerification: { verified: true, confidence: 1, reason: 'V2 vonis batch' },
    highlight: { pipelineVersion: 'v2_batch' },
  }));
  const idxBySource = new Map((sources || []).map((s, i) => [s.sourceId, i]));
  const clips = (orderedWindows || []).map((w) => ({
    candidateUrl: sources.find((s) => s.sourceId === w.sourceId)?.url || w.sourceId,
    sourceId: w.sourceId,
    candidateIndex: idxBySource.has(w.sourceId) ? idxBySource.get(w.sourceId) : 0,
    startSeconds: w.startSec,
    endSeconds: w.endSec,
    duration: (Number(w.endSec) || 0) - (Number(w.startSec) || 0),
    isClean: true,
    scriptDraft: w.scriptDraft || '',
  }));
  const total = clips.reduce((a, c) => a + c.duration, 0);
  const hl = {
    clips,
    startTime: clips.length ? clips[0].startSeconds : 0,
    endTime: clips.length ? clips[clips.length - 1].endSeconds : 0,
    duration: total,
    bestWindow: clips.length
      ? { sourceId: clips[0].sourceId, startSec: clips[0].startSeconds, endSec: clips[clips.length - 1].endSeconds, durationSec: total }
      : null,
    narration: { hasNarration: true, source: 'v2_visual_only' },
    pipelineVersion: 'v2_batch',
    productHook: null,
    isV2Flow: true,
  };
  return { hl, candidateResults };
}

// ── ORKESTRATOR ──────────────────────────────────────────────────────────────
/**
 * @param {object} p
 * @param {Array<{url:string,title?:string,duration?:number}>} p.candidatePool hasil L1
 * @param {string} p.productImage path/URL gambar produk (untuk vonis batch)
 * @param {number} [p.requireSources=2] jumlah sumber layak yang dikejar (4b)
 * @param {number} [p.targetClipDurationSec=30] target durasi klip akhir untuk AI teks
 * @param {Function} p.updateProgress penanda progres pipeline
 * @param {string} p.tempDir direktori temp session job
 * @returns {Promise<{ sources, orderedWindows, scriptDraft, diagnostics }>}
 */
export async function runSourceAcquisitionV2(p) {
  const {
    candidatePool = [],
    productTitle = '',
    productDescription = '',
    productImage = '',
    productFingerprint = null,
    niche = 'kitchen_tools',
    apiKey,
    aiProvider,
    options = {},
    tempDir,
    jobId,
    updateProgress = () => {},
    interleave,
    manualMode = false,
    requireSources = 2,
    targetClipDurationSec = 30,
    gatePreviewSec = Number(process.env.QUICK_PREVIEW_DURATION_SEC) || 15,
  } = p;

  const diagnostics = { screened: 0, gated: 0, verdictEligible: 0, transcribed: 0, oracleVetoed: 0, metadataInfraFailures: 0, previewInfraFailures: 0 };
  let lastSourceInfraError = null;
  const sourceKeys = new Set((candidatePool || []).map((cand) => {
    const url = String(cand?.url || (typeof cand === 'string' ? cand : '')).trim();
    return url ? (extractVideoId(url) || url) : '';
  }).filter(Boolean));
  const requiredSourceCount = Math.min(Math.max(1, Number(requireSources) || 1), sourceKeys.size);
  diagnostics.requiredSources = requiredSourceCount;
  if (!candidatePool.length) {
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L1/Filter1) Pre-screen metadata murah + rank durasi menengah.
  updateProgress({ step: 'acquisition_v2_screen', message: '🧹 [V2] Pre-screen metadata & urutkan durasi menengah...', progress: 12 });
  const ordered = rankByMidDuration(candidatePool);
  const screened = [];
  const seenSourceIds = new Set();
  for (const cand of ordered) {
    if (screened.length >= requireSources * 2 + 2) break; // buffer utk gate+verdict (4b)
    if (!cand?.url) continue;
    try {
      const { metadata: meta } = await fetchVideoMetadataAndStream(cand.url, { onProgress: updateProgress });
      const compliance = checkVideoMetadataCompliance(meta, productTitle, { ...options, isVisualSearch: Boolean(productImage), productImage, imageUrl: productImage });
      diagnostics.screened++;
      if (!compliance.eligible) {
        diagnostics.metadataRejected = (diagnostics.metadataRejected || 0) + 1;
        continue; // vonis konten metadata -> drop tanpa throw
      }
      // Analyze the complete YouTube stream before downloading even the short gate
      // preview. Gemini's selected timestamps become the only section plan for L4.
      updateProgress({ step: 'full_video_gemini', message: `Gemini menganalisis video penuh (${meta.title}); memilih adegan sebelum unduh section...`, progress: 14 });
      let fullVideoPlan;
      try {
        fullVideoPlan = await analyzeYouTubeVideoWithGemini({
          youtubeUrl: cand.url, apiKey, productTitle, productDescription,
          productImage, totalDuration: Number(meta.duration) || 0,
          introCutoffSec: 10, outroCutoffSec: 10,
          sceneDuration: Number(process.env.SCENE_DURATION_SEC) || 3.3,
          allowFallbackClips: false, niche, onProgress: updateProgress,
        });
      } catch (analysisError) {
        if (analysisError?.isAiRejection) {
          diagnostics.fullVideoRejected = (diagnostics.fullVideoRejected || 0) + 1;
          console.warn(`[Job ${jobId}] [V2] Kandidat ditolak Gemini dari analisis video penuh sebelum preview/section: ${analysisError.message}`);
          continue;
        }
        analysisError.isInfraError = true;
        throw analysisError;
      }
      if ((fullVideoPlan.clips || []).length === 0) {
        diagnostics.fullVideoEmptyPlans = (diagnostics.fullVideoEmptyPlans || 0) + 1;
        continue;
      }
      const sourceId = extractVideoId(cand.url) || cand.url;
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      screened.push({ url: cand.url, meta, sourceId, title: meta.title, fullVideoPlan });
    } catch (err) {
      if (err?.isInfraError) {
        diagnostics.metadataInfraFailures++;
        lastSourceInfraError = err;
        continue;
      }
      // metadata tak terbaca = kandidat buruk, lanjut.
    }
  }
  if (!screened.length) {
    const contentFailures = (diagnostics.metadataRejected || 0) +
      (diagnostics.fullVideoRejected || 0) +
      (diagnostics.fullVideoEmptyPlans || 0);
    if (diagnostics.metadataInfraFailures > 0 && contentFailures === 0) {
      const infraErr = lastSourceInfraError || new Error('Akuisisi V2 gagal membaca kandidat karena gangguan sumber/AI.');
      infraErr.isInfraError = true;
      infraErr.acquisitionDiagnostics = diagnostics;
      throw infraErr;
    }
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L2) Klip preview @9:16 -> frame konteks tanpa keputusan visual sumber.
  updateProgress({ step: 'acquisition_v2_probe', message: `?? [V2] Mengekstrak frame konteks (${screened.length} kandidat)...`, progress: 18 });
  const gatedCandidates = [];
  for (const cand of screened) {
    let preview;
    try {
      preview = await downloadQuickPreview(cand.url, tempDir, `${jobId}_g`, {
        onProgress: updateProgress,
        durationSec: gatePreviewSec,
        sourceDurationSec: cand.meta.duration,
        cropTo9_16: true,
      });
    } catch (err) {
      diagnostics.previewInfraFailures++;
      lastSourceInfraError = err;
      continue;
    }
    if (!preview?.filePath) {
      diagnostics.previewInfraFailures++;
      lastSourceInfraError = Object.assign(new Error(`Download preview gagal untuk kandidat ${cand.sourceId}.`), { isInfraError: true });
      continue;
    }
    let probe;
    let usableFrames = [];
    try {
      probe = await fastProbeLocal(preview.filePath, `${jobId}`, { onProgress: updateProgress, niche, durationSec: preview.actualDurationSec, sourceId: cand.sourceId });
    } catch (err) {
      if (err?.isInfraError) {
        diagnostics.previewInfraFailures++;
        lastSourceInfraError = err;
      }
      continue;
    }
    // Tidak ada pemfilteran visual lokal; seluruh frame dikirim ke Oracle Kaggle.
    usableFrames = (Array.isArray(probe?.frames) && probe.frames.length) ? probe.frames : (probe?.cleanFrames || []);
    if (!usableFrames.length) {
      // Kegagalan ekstraksi bukan penolakan produk; hentikan sebagai gangguan sistem.
      throw Object.assign(new Error(`Frame preview gagal diekstrak untuk kandidat ${cand.sourceId}; tidak ada frame yang dapat dikirim ke Oracle.`), { isInfraError: true });
    }
    diagnostics.gated++;
    gatedCandidates.push({
      ...cand,
      cleanFrames: usableFrames,
      clipPath: preview.filePath,
      previewStartSec: Number(preview.sourceStartSec) || 0,
    });
    if (gatedCandidates.length >= requireSources * 2) break;
  }
  if (!gatedCandidates.length) {
    if (diagnostics.previewInfraFailures > 0) {
      const infraErr = lastSourceInfraError || new Error('Semua ekstraksi preview kandidat gagal.');
      infraErr.isInfraError = true;
      infraErr.acquisitionDiagnostics = diagnostics;
      throw infraErr;
    }
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // A preview near the beginning of a video cannot veto clean sections elsewhere.
  // Keep its frames as context; Oracle reviews the actual downloaded sections later.

  // Gemini supplies section timestamps only. It cannot issue a source/product veto.
  // Candidate metadata was checked above; frame quality is decided by Kaggle Oracle.
  const accepted = gatedCandidates.slice(0, Math.max(1, Number(requireSources) || 1));
  diagnostics.verdictEligible = accepted.length;
  if (manualMode) diagnostics.manualProductApproval = 'operator';
  console.log(`[Job ${jobId}] [V2] ${accepted.length} sumber diteruskan setelah audit frame Oracle; tidak ada vonis sumber Gemini.`);
  diagnostics.acceptedSources = accepted.length;
  if (accepted.length < requiredSourceCount) {
    diagnostics.sourceShortfall = requiredSourceCount - accepted.length;
    console.warn(`[Job ${jobId}] [V2] Hanya ${accepted.length}/${requiredSourceCount} sumber lolos semua gerbang; tidak membuat storyboard satu sumber diam-diam.`);
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L3) WINDOW DINAMIS TERSEBAR — Mengambil potongan kecil di banyak titik (meningkatkan variasi).
  // Mengabaikan 10 detik awal dan akhir, mengambil 10 titik masing-masing 3 detik.
  const sourcesData = [];
  for (const cand of accepted) {
    updateProgress({ step: 'text_window_select', message: `📊 [V2] Menentukan 10 titik ekstraksi visual (${cand.title || cand.sourceId})...`, progress: 30 });
    const vidDur = Number(cand.meta?.duration) || 60;
    
    // Abaikan 10 detik awal dan akhir (atau proporsional jika video pendek)
    const safeStart = Math.min(10, Math.max(0, vidDur * 0.1));
    const safeEnd = Math.max(safeStart + 3, vidDur - 10);
    const usableDur = safeEnd - safeStart;
    
    // Do not invent uniform windows: use only scenes Gemini verified across the full video.
    const windows = (cand.fullVideoPlan?.clips || []).map((clip) => ({
      startSec: Number(clip.startSeconds),
      endSec: Number(clip.endSeconds),
      scriptDraft: clip.reason || '',
    })).filter((w) => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) &&
      w.startSec >= 10 && w.endSec <= vidDur - 10 && w.endSec > w.startSec);
    if (windows.length === 0) {
      console.warn(`[Job ${jobId}] [V2] ${cand.sourceId} tidak memiliki timestamp section Gemini yang valid; lanjut ke kandidat berikutnya.`);
      diagnostics.emptySectionPlans = (diagnostics.emptySectionPlans || 0) + 1;
      continue;
    }
    diagnostics.transcribed++;
    sourcesData.push({
      sourceId: cand.sourceId,
      url: cand.url,
      meta: cand.meta,
      previewStartSec: cand.previewStartSec || 0,
      cleanFrames: cand.cleanFrames || [],
      windows,
    });
  }

  // (L5) zigzag per window.
  const plan = buildAcquisitionPlan(sourcesData, interleave);
  return { sources: sourcesData, orderedWindows: plan.orderedWindows, scriptDraft: plan.scriptDraft, diagnostics };
}
