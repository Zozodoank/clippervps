// ─────────────────────────────────────────────────────────────────────────────
// BLUEPRINT ALUR BARU — runSourceAcquisitionV2 (L2 -> L5)
//
// Menggantikan funnel `evaluateCandidate` lama (TAHAP 2-6) + pre-flight + whisper
// window ketika flag ACQUISITION_FLOW=v2 aktif (lihat config/runtimeFlags.js,
// isNewFlowEnabled). L1 (pencarian kandidat gambar+keyword) TETAP dilakukan
// pemanggil (stage1Render) — modul ini menerima `candidatePool` hasil L1.
//
// RANGKAIAN (keputusan user 1c/2b/3/4b):
//   Pre-screen metadata (murah)  ->  ambil klip 15s crop 9:16  ->  GATEKEEPER
//   PRE-FILTER lokal (1c, 0 token)  ->  VONIS BATCH Gemini (satu panggilan,
//   produk + kebersihan)  ->  pilih >=2 sumber layak (4b)  ->  TRANKRIP WHISPER
//   PENUH audio 5-15 mnt (3)  ->  AI TEKS pilih window + draf naskah  ->  ZIGZAG
//   per window (2b).
//
// Output: { sources, orderedWindows, scriptDraft, diagnostics } siap dipakai
// tahap unduh-per-segmen (L4) & render (L6) yang ADA di stage1Render.
//
// Semantik error (P1-5): gangguan infrastruktur (gatekeeper/whisper/AI mati)
// dilempar dengan flag `isInfraError` agar master loop TIDAK mem-blacklist; vonis
// konten (produk tak cocok / frame kotor) cukup menjatuhkan kandidat tanpa throw.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getYtDlpPath, getFFmpegPath } from '../services/binaryChecker.js';
import { findCookiesFile, extractVideoId } from '../services/downloader.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  fastProbeLocal,
  mergeLocalSuspicion,
} from '../services/videoFilterService.js';
import { downloadQuickPreview } from '../services/quickPreviewService.js';
import { isVlmOracleEnabled, isLocalGatekeeperAdvisory } from '../config/runtimeFlags.js';
import { applyOracleVeto } from '../services/vlmOracleService.js';
import { extractSourceAudio, transcribeAudio } from '../services/audioBeatService.js';
import {
  verdictCandidatesWithGemini,
  selectAffiliateWindowsWithAIText,
} from '../services/aiService.js';

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
    cleanFrames: s.cleanFrames || [],
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
    narration: { hasNarration: true, source: 'v2_full_transcribe' },
    pipelineVersion: 'v2_batch',
    productHook: null,
    isV2Flow: true,
  };
  return { hl, candidateResults };
}

// ── UNDIUH AUDIO SAJA (murah, untuk transkrip penuh L3) ──────────────────────
async function downloadAudioTrack(url, outDir, jobId, { timeoutMs = 120000 } = {}) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ytDlpPath = await getYtDlpPath();
  const outPath = path.join(outDir, `audio_${jobId}_${Date.now()}.m4a`);
  const cookieFile = findCookiesFile();
  const args = [
    '--no-playlist',
    '--js-runtimes', 'node',
    '-f', 'bestaudio/best',
    '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '7',
    ...(cookieFile ? ['--cookies', cookieFile] : []),
    '-o', outPath,
    url,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { proc.kill('SIGKILL'); } catch {}
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        reject(Object.assign(new Error(`Unduh audio timeout (${Math.round(timeoutMs / 1000)}s)`), { isInfraError: true }));
      }
    }, timeoutMs);
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 2048) resolve(outPath);
      else {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        reject(Object.assign(new Error(`yt-dlp audio gagal (code ${code})`), { isInfraError: true }));
      }
    });
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(err, { isInfraError: true }));
    });
  });
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
    requireSources = 2,
    targetClipDurationSec = 30,
    gatePreviewSec = Number(process.env.QUICK_PREVIEW_DURATION_SEC) || 15,
  } = p;

  const diagnostics = { screened: 0, gated: 0, verdictEligible: 0, transcribed: 0, oracleVetoed: 0 };
  // Kecurigaan AI Local Gatekeeper per kandidat; dirangkum ke prompt Oracle (Qwen) supaya
  // aturan lokal diperiksa model besar alih-alih memutuskan sendiri.
  const localSuspicionNotes = [];
  if (!candidatePool.length) {
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L1/Filter1) Pre-screen metadata murah + rank durasi menengah.
  updateProgress({ step: 'acquisition_v2_screen', message: '🧹 [V2] Pre-screen metadata & urutkan durasi menengah...', progress: 12 });
  const ordered = rankByMidDuration(candidatePool);
  const screened = [];
  for (const cand of ordered) {
    if (screened.length >= requireSources * 2 + 2) break; // buffer utk gate+verdict (4b)
    if (!cand?.url) continue;
    try {
      const { metadata: meta } = await fetchVideoMetadataAndStream(cand.url, { onProgress: updateProgress });
      const compliance = checkVideoMetadataCompliance(meta, productTitle, { ...options, isVisualSearch: Boolean(productImage), productImage, imageUrl: productImage });
      diagnostics.screened++;
      if (!compliance.eligible) continue; // vonis konten metadata -> drop tanpa throw
      screened.push({ url: cand.url, meta, sourceId: extractVideoId(cand.url) || cand.url, title: meta.title });
    } catch (err) {
      if (err?.isInfraError) throw err; // gangguan -> serahkan ke master loop (jangan blacklist)
      // metadata tak terbaca = kandidat buruk, lanjut.
    }
  }
  if (!screened.length) {
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L2 + 1c) klip 15s @9:16 -> gatekeeper pre-filter -> kumpulkan frame bersih.
  updateProgress({ step: 'acquisition_v2_gate', message: `🔎 [V2] Klip 15s 9:16 + Gatekeeper pre-filter (${screened.length} kandidat)...`, progress: 18 });
  const gatedCandidates = [];
  for (const cand of screened) {
    const preview = await downloadQuickPreview(cand.url, tempDir, `${jobId}_g`, {
      onProgress: updateProgress,
      durationSec: gatePreviewSec,
      sourceDurationSec: cand.meta.duration,
      cropTo9_16: true,
    });
    if (!preview?.filePath) continue;
    let probe;
    let usableFrames = [];
    try {
      probe = await fastProbeLocal(preview.filePath, `${jobId}`, { onProgress: updateProgress, niche, durationSec: preview.actualDurationSec, sourceId: cand.sourceId });
    } catch (err) {
      if (err?.isInfraError) throw err; // gatekeeper mati -> infra, jangan blacklist
      continue;
    }
    if (!probe?.eligible || !Array.isArray(probe.cleanFrames) || probe.cleanFrames.length < 3) {
      // PERAN VONIS LOKAL = ADVISORY (mandate user 2026-10): selama Oracle Kaggle aktif,
      // tuduhan model kecil (MediaPipe/DBNet/MobileNet) BUKAN pemutus. Kandidat tetap
      // dibawa ke Qwen memakai SELURUH frame probe, dan kecurigaan lokal dikirim sebagai
      // bagian prompt agar Qwen memeriksa aturan itu sendiri pada frame. Hanya
      // GK_LOCAL_VETO=strict yang masih membuang kandidat di sini (perilaku lama).
      if (!isLocalGatekeeperAdvisory(process.env)) {
        try { if (fs.existsSync(preview.filePath)) fs.unlinkSync(preview.filePath); } catch {}
        continue; // frame kotor = vonis konten -> drop
      }
      if (probe?.localSuspicion) localSuspicionNotes.push(probe.localSuspicion);
      // Pesan infrastruktur ("Gatekeeper tidak tersedia", "jumlah frame tidak mencukupi",
      // "gagal mengekstrak frame") BUKAN tuduhan konten — jangan disematkan ke prompt
      // Qwen sebagai aturan lokal (review putaran ke-2).
      else if ((probe?.discardedFrames || []).some((f) => f && f.stage && f.stage !== 'io_error')) {
        localSuspicionNotes.push(probe?.reason || 'frame dicurigai gatekeeper lokal');
      }
      console.log(`[Job ${jobId}] 🛰️ [V2][Vonis lokal => penasihat] ${probe?.reason || 'frame dicurigai'} — kandidat tetap dikirim ke Oracle Kaggle.`);
      // Kirim SELURUH frame hasil probe (termasuk yang dituduh) supaya ada yang divisit Qwen.
      usableFrames = (Array.isArray(probe?.frames) && probe.frames.length) ? probe.frames : (probe?.cleanFrames || []);
    } else {
      if (probe?.localSuspicion) localSuspicionNotes.push(probe.localSuspicion);
      usableFrames = probe.cleanFrames;
      // Kandidat dinyatakan layak tapi sebagian frame terbuang lokal: di mode advisory
      // yang terbuang ikut ke Oracle, tidak hilang diam-diam (konsisten dgn stage1Render).
      if (isLocalGatekeeperAdvisory(process.env)) {
        const suspected = (probe.discardedFrames || []).filter((f) => f && f.filePath && f.stage !== 'io_error');
        if (suspected.length) usableFrames = [...usableFrames, ...suspected];
      }
    }
    if (!usableFrames.length) {
      // Tidak ada satu frame pun yang berhasil diekstrak (preview rusak) - ini bukan vonis
      // konten maupun infra, cukup lewati kandidat tanpa membakar antrean oracle.
      try { if (fs.existsSync(preview.filePath)) fs.unlinkSync(preview.filePath); } catch {}
      continue;
    }
    diagnostics.gated++;
    gatedCandidates.push({ ...cand, cleanFrames: usableFrames, clipPath: preview.filePath });
    if (gatedCandidates.length >= requireSources * 2) break;
  }
  if (!gatedCandidates.length) {
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L2b) ORACLE KAGGLE (VISION_VERIFY_MODE=oracle — satu-satunya mode yang diizinkan) —
  // veto model besar SEBELUM vonis Gemini. Tanpa blok ini, ACQUISITION_FLOW=v2 lolos
  // sepenuhnya dari filter model besar karena jalur lama (stage1Render storyboard) tidak
  // dilewati.
  // Kebijakan SAMA dengan stage1Render (STRICT, mandate 2026-10): oracle diam/timeout/
  // vonis tidak sah -> applyOracleVeto melempar OracleUnavailableError dan job BERHENTI
  // (propagate ke pemanggil di stage1Render). Tidak ada lagi "keputusan gatekeeper lokal
  // (L2a) + Gemini tetap berlaku".
  if (isVlmOracleEnabled(process.env)) {
    updateProgress({ step: 'vlm_oracle', message: '🛰️ [V2] Oracle Kaggle memvonis frame kandidat...', progress: 19 });
    const vetoed = [];
    for (const cand of gatedCandidates) {
      const res = await applyOracleVeto(cand.cleanFrames, {
        jobId,
        niche,
        onProgress: updateProgress,
        logger: console,
        localHints: mergeLocalSuspicion(localSuspicionNotes),
      });
      if (res.rejected > 0) {
        diagnostics.oracleVetoed = (diagnostics.oracleVetoed || 0) + res.rejected;
        vetoed.push({
          sourceId: cand.sourceId,
          rejected: res.rejected,
          checked: res.checked,
          reason: res.blacklisted.length ? 'frame diveto model besar' : '',
        });
      }
      cand.cleanFrames = res.frames;
    }
    // Ambang 3 frame sama dengan gate lokal di atas: kandidat yang tinggal sedikit
    // frame bersihnya setelah veto tidak layak dikirim ke vonis batch.
    const survivors = gatedCandidates.filter((c) => c.cleanFrames.length >= 3);
    const dropped = gatedCandidates.length - survivors.length;
    if (dropped > 0) {
      console.warn(`[Job ${jobId}] [Oracle][V2] ${dropped} kandidat dibuang setelah veto (sisa frame < 3).`);
      gatedCandidates.length = 0;
      gatedCandidates.push(...survivors);
    }
    if (vetoed.length) console.log(`[Job ${jobId}] ⛔ [Oracle][V2] ${diagnostics.oracleVetoed} frame diveto model besar dari ${vetoed.length} kandidat.`);
    if (!gatedCandidates.length) {
      return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
    }
  }

  // (L2c) VONIS BATCH Gemini — satu panggilan utk semua kandidat yang lolos gate.
  const { verdicts } = await verdictCandidatesWithGemini({
    apiKey, aiProvider, productImage, productTitle, productDescription, productFingerprint, niche,
    candidates: gatedCandidates.map((c) => ({ sourceId: c.sourceId, frames: c.cleanFrames })),
    onProgress: updateProgress,
  });
  diagnostics.verdictEligible = verdicts.filter((v) => v.eligible).length;
  const accepted = pickEligibleSources(verdicts, gatedCandidates, requireSources);
  if (!accepted.length) {
    return { sources: [], orderedWindows: [], scriptDraft: '', diagnostics };
  }

  // (L3) transkrip WHISPER PENUH + AI teks pilih window per sumber layak.
  const sourcesData = [];
  for (const cand of accepted) {
    updateProgress({ step: 'full_transcribe', message: `🎧 [V2] Transkrip penuh audio kandidat (${cand.title || cand.sourceId})...`, progress: 30 });
    let audioPath = null;
    try {
      audioPath = await downloadAudioTrack(cand.url, tempDir, `${jobId}_aud`);
      const extracted = await extractSourceAudio({ videoPath: audioPath, outWav: null, logger: console });
      if (!extracted.ok) throw Object.assign(new Error(`Ekstrak audio gagal: ${extracted.error}`), { isInfraError: !extracted.noAudio });
      const transcribed = await transcribeAudio({ wavPath: extracted.wavPath, env: process.env });
      try { if (extracted.wavPath && fs.existsSync(extracted.wavPath)) fs.unlinkSync(extracted.wavPath); } catch {}
      if (!transcribed.ok) throw Object.assign(new Error(`Transkrip gagal: ${transcribed.error}`), { isInfraError: true });
      diagnostics.transcribed++;

      updateProgress({ step: 'text_window_select', message: `🧠 [V2] AI teks pilih window menarik (${cand.sourceId})...`, progress: 34 });
      const { windows } = await selectAffiliateWindowsWithAIText({
        apiKey, aiProvider, segments: transcribed.segments, targetDurationSec: targetClipDurationSec,
        productTitle, niche, sourceId: cand.sourceId, onProgress: updateProgress,
      });
      if (windows.length) sourcesData.push({ sourceId: cand.sourceId, url: cand.url, meta: cand.meta, windows });
    } finally {
      try { if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
    }
  }

  // (L5) zigzag per window.
  const plan = buildAcquisitionPlan(sourcesData, interleave);
  return { sources: sourcesData, orderedWindows: plan.orderedWindows, scriptDraft: plan.scriptDraft, diagnostics };
}
