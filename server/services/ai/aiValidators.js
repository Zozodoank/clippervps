import { getMediaDurationSec } from '../videoRenderer.js';

// Helpers
export function formatSeconds(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function normalizeClipPlan(rawClips, totalDuration, { allowFallback = true, frameAudit = [], hasProductBrand = false, allowHflip = true, sceneDuration = 3.5 } = {}) {
  // Adaptive cadence: individual clips may be shorter/longer according to creative role,
  // while the default stays around 3.0-3.5s.
  const defaultClipLength = Math.max(2.0, Math.min(4.0, Number(sceneDuration) || 3.2));
  const sourceClips = Array.isArray(rawClips) ? rawClips : [];
  const normalized = [];
  let previousEnd = -1;

  console.log(`[normalizeClipPlan] totalDuration=${totalDuration}s, rawClips=${sourceClips.length}, defaultClipLength=${defaultClipLength}s, frameAudit=${frameAudit.length}, hasProductBrand=${hasProductBrand}, allowHflip=${allowHflip}`);

  // Build a set of timestamps containing detected floating text, subtitles, watermarks, faces, or amateur framing
  const dirtyTimestamps = [];
  if (Array.isArray(frameAudit)) {
    for (const audit of frameAudit) {
      const floatingText = (audit.detectedFloatingOverlay || audit.detectedFloatingOverlayText || audit.floatingText || '').toLowerCase().trim();
      const hasFloatingOverlay = audit.hasFloatingOverlay === true ||
        audit.hasFloatingOverlayText === true ||
        (floatingText && floatingText !== 'none' && floatingText !== 'null' && floatingText !== 'false');

      const isPhysicalBrand = audit.hasPhysicalBrandText === true ||
        audit.hasPhysicalProductBrandOrText === true ||
        (audit.detectedPhysicalBrand && audit.detectedPhysicalBrand.toLowerCase() !== 'none');

      // Only reject legacy text if it is NOT physical brand
      const legacyText = (audit.detectedText || '').toLowerCase().trim();
      const isLegacySubtitle = !isPhysicalBrand && (audit.hasTextOrSubtitles === true || (legacyText && legacyText !== 'none' && legacyText !== 'null' && legacyText !== 'false'));
      const hasFace = audit.hasFace === true;
      const isPoorlyFramed = audit.isWellFramed === false;
      // Hanya buang jika murni kardus kosong / bubble wrap tanpa produk
      const isPurePackaging = audit.isPackaging === true ||
        (audit.detectedAction && /(?:kardus\s+kosong|cardboard\s+box|bubble\s*wrap\s+only|resi\s+pengiriman|buka\s+kardus\s+kosong)/i.test(audit.detectedAction));

      if (hasFloatingOverlay || isLegacySubtitle || hasFace || isPoorlyFramed || isPurePackaging) {
        const sec = Math.round(parseTimeToSeconds(audit.timestamp ?? audit.frameIndex));
        dirtyTimestamps.push(sec);
      }
    }
  }

  const previousEndsByCand = new Map();
  const hasStoryboardSlots = sourceClips.some(c => c.storyboardSlot !== undefined);

  for (const rawClip of sourceClips) {
    const clipLength = Math.max(1.5, Math.min(4.5, Number(rawClip?.duration) || defaultClipLength));
    let startSeconds = Math.max(0, Math.round(parseTimeToSeconds(rawClip?.startSeconds ?? rawClip?.startTime)));
    const candKey = rawClip?.candidateIndex !== null && rawClip?.candidateIndex !== undefined ? rawClip.candidateIndex : 'default';
    const prevEnd = previousEndsByCand.get(candKey) || 0;

    // In storyboard mode, cuts can jump backwards to reprise full product hero shots
    if (!hasStoryboardSlots && startSeconds < prevEnd) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s (Candidate ${candKey}): overlaps previous end ${prevEnd}s in same video`);
      continue;
    }
    if (startSeconds + clipLength > totalDuration) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: exceeds totalDuration ${totalDuration}s`);
      continue;
    }
    if (rawClip?.isCleanAffiliateShot === false && rawClip?.hasFloatingOverlay === true) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: hasFloatingOverlay=true`);
      continue;
    }
    if (hasSourceIdentityRisk(rawClip)) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: sourceIdentityRisk=${rawClip?.sourceIdentityRisk}`);
      continue;
    }

    // Discard any clip that is purely empty packaging waste without product
    const isPurePackagingClip = rawClip?.isPackaging === true ||
      /(?:kardus\s+kosong|cardboard\s+box|bubble\s*wrap\s+only|resi\s+pengiriman|buka\s+kardus\s+kosong)/i.test(String(rawClip?.reason || ''));
    if (isPurePackagingClip) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}s: empty packaging rejected`);
      continue;
    }

    const endSeconds = startSeconds + clipLength;

    // Discard any clip interval that covers dirty frames containing floating text/subtitles/watermarks/packaging
    const overlapsDirtyFrame = dirtyTimestamps.some(ts => ts >= startSeconds && ts <= endSeconds);
    if (overlapsDirtyFrame) {
      console.log(`[normalizeClipPlan] Skip clip at ${startSeconds}-${endSeconds}s: overlaps frame with detected subtitle/watermark/empty packaging`);
      continue;
    }

    const clipHasBrand = hasProductBrand || rawClip?.hasProductBrand === true || rawClip?.hasPhysicalBrandText === true || rawClip?.reframe?.hasProductBrand === true;
    const clipAllowHflip = clipHasBrand ? false : (allowHflip !== false && rawClip?.allowHflip !== false && rawClip?.reframe?.allowHflip !== false);

    normalized.push({
      startSeconds,
      endSeconds,
      duration: clipLength,
      startTime: formatSeconds(startSeconds),
      endTime: formatSeconds(endSeconds),
      candidateIndex: rawClip?.candidateIndex !== undefined ? rawClip.candidateIndex : null,
      candidateTitle: rawClip?.candidateTitle || '',
      candidateUrl: rawClip?.candidateUrl || '',
      videoId: rawClip?.videoId || '',
      videoPath: rawClip?.videoPath || null,
      candidate: rawClip?.candidate || null,
      storyboardSlot: rawClip?.storyboardSlot,
      storyboardRole: rawClip?.storyboardRole,
      datasetTag: rawClip?.datasetTag,
      reason: (rawClip?.reason || 'Clean full-product affiliate shot.').toString().slice(0, 180),
      hasProductBrand: clipHasBrand,
      allowHflip: clipAllowHflip,
      reframe: normalizeReframe({
        ...rawClip?.reframe,
        hasProductBrand: clipHasBrand,
        allowHflip: clipAllowHflip,
      }),
    });
    previousEndsByCand.set(candKey, endSeconds);
    previousEnd = endSeconds;
    if (normalized.length === 8) break; // Target 7-8 distinct clips (~30-35s)
  }

  console.log(`[normalizeClipPlan] Accepted ${normalized.length} valid clips from AI vision`);

  // Urutkan klip berdasarkan storyboard slot atau urutan waktu alami
  if (!hasStoryboardSlots) {
    normalized.sort((a, b) => {
      const candA = a.candidateIndex ?? 0;
      const candB = b.candidateIndex ?? 0;
      if (candA !== candB) return candA - candB;
      return a.startSeconds - b.startSeconds;
    });
  } else {
    normalized.sort((a, b) => (a.storyboardSlot || 0) - (b.storyboardSlot || 0));
  }

  const normalizedDuration = normalized.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);
  console.log(`[normalizeClipPlan] ✅ Mempertahankan ${normalized.length} klip bersih asli hasil kurasi (${normalizedDuration.toFixed(1)}s total) dengan pacing adaptif.`);

  // Deduplikasi ketat: Pastikan tidak ada 2 klip dari kandidat yang sama dengan selisih waktu < 2.0 detik
  const dedupedClips = [];
  for (const c of normalized) {
    const isDup = dedupedClips.some(e => {
      // Di storyboard mode, lindungi Slot 6 dan Slot 7 (reprise visual produk utuh penutup/CTA)
      if (hasStoryboardSlots && (c.storyboardSlot === 6 || c.storyboardSlot === 7)) {
        if (e.storyboardSlot === c.storyboardSlot) return true;
        if (e.storyboardSlot === 6 && c.storyboardSlot === 7 && Math.abs(e.startSeconds - c.startSeconds) < 1.0) return true;
        return false;
      }
      return (
        (e.candidateIndex === c.candidateIndex || (!e.candidateIndex && !c.candidateIndex)) &&
        Math.abs(e.startSeconds - c.startSeconds) < Math.max(Number(c.duration) || defaultClipLength, 3.0)
      );
    });
    if (!isDup) {
      dedupedClips.push(c);
    }
  }

  // Standar kualitas: Minimal 3 aksi berbeda agar video tidak monoton atau mengulang 1 gerakan
  if (dedupedClips.length >= 3) {
    return dedupedClips;
  }

  if (dedupedClips.length > 0 && allowFallback) {
    return dedupedClips;
  }

  const cleanErr = new Error('AI menolak video ini: cuplikan aksi demonstrasi bersih terlalu sedikit (kurang dari 3 variasi aksi demonstrasi berbeda).');
  cleanErr.isAiRejection = true;
  cleanErr.rejectionReason = 'Cuplikan aksi demonstrasi bersih terlalu sedikit (kurang dari 3 variasi aksi demonstrasi berbeda).';
  throw cleanErr;

  // Fallback: build 10 to 12 evenly spaced clips (around 30 to 35 seconds total, exactly defaultClipLength per clip)
  console.log(`[normalizeClipPlan] Building ~30-35s fallback clip plan for ${totalDuration}s video with defaultClipLength=${defaultClipLength}s`);
  const fallbackClips = [];
  const targetTotalSec = 33;
  const fallbackTargetClips = Math.min(12, Math.max(10, Math.floor(Math.min(totalDuration, targetTotalSec) / defaultClipLength)));
  const maxStart = Math.max(0, Math.floor(totalDuration - defaultClipLength));
  // Avoid first 15-18% of video in fallback to bypass intro unboxing segments on YouTube
  const fallbackStart = totalDuration > 30
    ? Math.min(maxStart, Math.max(0, Math.floor(totalDuration * 0.18)))
    : (totalDuration > 20 ? Math.min(maxStart, Math.max(0, Math.floor(totalDuration * 0.10))) : 0);
  const fallbackLastStart = totalDuration > 30
    ? Math.max(fallbackStart, Math.min(maxStart, Math.floor(totalDuration * 0.95) - defaultClipLength))
    : maxStart;

  const span = fallbackLastStart - fallbackStart;
  const numSteps = Math.max(1, fallbackTargetClips - 1);
  const stepSize = fallbackTargetClips > 1 ? span / numSteps : defaultClipLength;

  let lastStart = -1;
  for (let i = 0; i < fallbackTargetClips; i++) {
    const rawStart = Math.round(fallbackStart + (i * stepSize));
    const startSeconds = Math.min(maxStart, Math.max(lastStart + defaultClipLength, rawStart));
    if (startSeconds + defaultClipLength > totalDuration) break;

    fallbackClips.push({
      startSeconds,
      endSeconds: startSeconds + defaultClipLength,
      duration: defaultClipLength,
      startTime: formatSeconds(startSeconds),
      endTime: formatSeconds(startSeconds + defaultClipLength),
      reason: `Fallback ${defaultClipLength}s product shot.`,
      hasProductBrand,
      allowHflip,
      reframe: normalizeReframe({
        hasProductBrand,
        allowHflip,
      }),
    });
    lastStart = startSeconds;
  }

  if (!fallbackClips.length) {
    throw new Error(`Video terlalu pendek untuk membuat potongan produk utama (minimal ${Math.round(defaultClipLength * 4)} detik).`);
  }
  return fallbackClips;
}

