/**
 * Professional short-form editing helpers.
 * Pure functions only: no network, no filesystem, no AI calls.
 */

import { getNichePreset, getSlotFacePolicy } from '../config/nichePresets.js';

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function buildProductFingerprint({ title = '', description = '', productInfo = {} } = {}) {
  const source = normalizeText(`${title} ${description}`);
  const hard = [];
  const soft = [];

  const addHard = (key, value) => {
    if (value) hard.push({ key, value });
  };
  const addSoft = (key, value) => {
    if (value) soft.push({ key, value });
  };

  const mechanismRules = [
    [/\b(manual tarik|tali tarik|tarik tali|pull cord|pull string|rope pull)\b/i, 'manual_pull_cord'],
    [/\b(manual putar|putar manual|hand crank|rotary)\b/i, 'manual_rotary'],
    [/\b(tekan manual|manual press|push press|hand press)\b/i, 'manual_press'],
    [/\b(vakum|vacuum|suction)\b/i, 'vacuum_suction'],
    [/\b(pump|pompa)\b/i, 'pump'],
    [/\b(gravity feed|gravitasi)\b/i, 'gravity_feed'],
    [/\b(electric|elektrik|listrik|rechargeable|usb|cordless)\b/i, 'electric_motor'],
  ];
  const mechanism = mechanismRules.find(([rx]) => rx.test(source))?.[1] || '';

  const construction = [];
  if (/\b(lipat|foldable|collapsible)\b/i.test(source)) construction.push('foldable');
  if (/\b(transparan|transparent|clear bowl)\b/i.test(source)) construction.push('transparent_body');
  if (/\b(stainless|steel|baja)\b/i.test(source)) construction.push('metal_construction');
  if (/\b(silicone|silikon)\b/i.test(source)) construction.push('silicone_component');

  const capacityMatch = source.match(/\b(\d+(?:[.,]\d+)?)\s*(ml|l|ltr|liter|litre|g|gr|kg)\b/i);
  const dimensionMatch = source.match(/\b(\d+(?:[.,]\d+)?)\s*(cm|mm|inch|in)\b/i);

  addHard('productType', productInfo.coreProductNoun || productInfo.englishNoun || '');
  addHard('mechanism', mechanism);
  construction.forEach((v) => addHard('construction', v));
  if (productInfo.brand) addHard('brand', productInfo.brand);
  if (productInfo.model) addHard('model', productInfo.model);

  if (capacityMatch) addSoft('capacity', `${capacityMatch[1]}${capacityMatch[2]}`);
  if (dimensionMatch) addSoft('dimension', `${dimensionMatch[1]}${dimensionMatch[2]}`);

  return {
    productType: productInfo.coreProductNoun || productInfo.englishNoun || title || 'Produk',
    englishProductType: productInfo.englishNoun || '',
    brand: productInfo.brand || '',
    model: productInfo.model || '',
    mechanism,
    construction: uniq(construction),
    hardMatchAttributes: hard,
    softMatchAttributes: soft,
    sourceTitle: title,
  };
}

export function buildCreativeShotPlan({ fingerprint = {}, niche = 'kitchen_tools' } = {}) {
  if (niche === 'gadget_smartphone') {
    return {
      strategy: 'story_first',
      sourcePolicy: 'multi_angle_dynamic_preferred',
      shots: [
        { role: 'hook_hero', purpose: 'Buka dengan hero shot paling kuat', targetSec: 1.8, minSec: 1.4, maxSec: 2.4 },
        { role: 'design_detail', purpose: 'Detail fisik/build quality', targetSec: 2.6, minSec: 2.0, maxSec: 3.3 },
        { role: 'screen_action', purpose: 'Interaksi layar/UI yang nyata', targetSec: 3.2, minSec: 2.5, maxSec: 3.8 },
        { role: 'performance_demo', purpose: 'Aksi penggunaan/performa', targetSec: 3.2, minSec: 2.5, maxSec: 3.8 },
        { role: 'camera_result', purpose: 'Bukti hasil kamera/fitur', targetSec: 2.8, minSec: 2.2, maxSec: 3.5 },
        { role: 'proof', purpose: 'Bukti tambahan yang terlihat', targetSec: 2.5, minSec: 2.0, maxSec: 3.2 },
        { role: 'cta_hero', purpose: 'Hero shot penutup untuk CTA', targetSec: 2.3, minSec: 1.8, maxSec: 3.0 },
      ],
    };
  }

  const mechanismLabel = fingerprint.mechanism
    ? `mekanisme ${fingerprint.mechanism.replace(/_/g, ' ')}`
    : 'mekanisme utama produk';

  return {
    strategy: 'story_first',
    sourcePolicy: 'multi_angle_dynamic_preferred',
    shots: [
      { role: 'hook_hero', purpose: 'Hero shot produk utuh paling estetik & dinamis tanpa sapaan', targetSec: 1.7, minSec: 1.3, maxSec: 2.3 },
      { role: 'feature_angle', purpose: 'Sudut pandang 45 derajat atau perspektif meja yang elegan', targetSec: 2.2, minSec: 1.8, maxSec: 2.8 },
      { role: 'mechanism_demo', purpose: `Peragakan ${mechanismLabel} (putar carousel/buka tutup) secara aktif`, targetSec: 3.3, minSec: 2.7, maxSec: 3.8 },
      { role: 'macro_detail', purpose: 'Close-up makro detail tekstur, motif bunga, handle, atau material', targetSec: 2.5, minSec: 2.0, maxSec: 3.2 },
      { role: 'action_demo', purpose: 'Aksi pemakaian/penyajian nyata berbeda dari shot sebelumnya', targetSec: 3.2, minSec: 2.6, maxSec: 3.8 },
      { role: 'result_proof', purpose: 'Hasil nyata penataan produk/hidangan secara menarik', targetSec: 2.8, minSec: 2.2, maxSec: 3.5 },
      { role: 'cta_hero', purpose: 'Produk utuh/sudut elegan penutup untuk CTA', targetSec: 2.4, minSec: 1.8, maxSec: 3.0 },
    ],
  };
}

export function describeCreativePlan(plan = {}) {
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  return shots
    .map((s, i) => `${i + 1}. ${s.role}: ${s.purpose} (ideal ${s.targetSec}s; ${s.minSec}-${s.maxSec}s)`)
    .join('\n');
}

function parseTimestampSeconds(raw = '') {
  const m = String(raw).match(/\[\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*\]/);
  if (!m) return null;
  if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function extractScriptSceneStarts(script = '') {
  return String(script || '')
    .split(/\r?\n/)
    .map(parseTimestampSeconds)
    .filter((v) => Number.isFinite(v));
}

export function distributeTotal(rawDurations, total, mins, maxs) {
  const out = rawDurations.map((d, i) => Math.max(mins[i], Math.min(maxs[i], d)));
  let delta = total - out.reduce((a, b) => a + b, 0);

  for (let pass = 0; pass < 6 && Math.abs(delta) > 0.02; pass++) {
    const expandable = out
      .map((v, i) => ({ i, room: delta > 0 ? maxs[i] - v : v - mins[i] }))
      .filter(x => x.room > 0.01);
    if (!expandable.length) break;
    const totalRoom = expandable.reduce((s, x) => s + x.room, 0);
    for (const x of expandable) {
      const portion = Math.min(Math.abs(delta), Math.abs(delta) * (x.room / totalRoom));
      out[x.i] += delta > 0 ? portion : -portion;
    }
    delta = total - out.reduce((a, b) => a + b, 0);
  }
  return out;
}

export function conformClipsToVoiceover({ clips = [], script = '', audioDurationSec = 0, creativePlan = {}, niche = 'kitchen_tools' } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const MIN_CONFORM_DURATION = 18.0;
  const audioDuration = Math.max(MIN_CONFORM_DURATION, Number(audioDurationSec) || clips.reduce((s, c) => s + (Number(c.duration) || 3), 0));
  const starts = extractScriptSceneStarts(script);
  const planShots = Array.isArray(creativePlan.shots) ? creativePlan.shots : [];

  // FACE POLICY (Fase 4): niche dengan strictSceneVoSync=true (gadget_smartphone) MELARANG
  // ekspansi loop klip — jumlah adegan WAJIB sama persis dengan baris voiceover (lockstep Scene<->VO).
  const strictSceneVoSync = Boolean(getNichePreset(niche)?.strictSceneVoSync);

  // Hitung target jumlah adegan yang dibutuhkan agar pacing visual tetap dinamis (~2.5s - 3.8s per cut)
  const targetSceneCount = Math.max(
    clips.length,
    starts.length,
    Math.ceil(audioDuration / 3.5)
  );

  // Jika jumlah klip visual lebih sedikit daripada adegan yang dibutuhkan oleh audio voiceover,
  // ekspansi klip dengan variasi reframe alternatif (stage 80 vs center crop) agar pacing Reels tetap hidup
  let targetClips = [...clips];
  if (!strictSceneVoSync && targetClips.length < targetSceneCount && targetClips.length > 0) {
    const originalCount = targetClips.length;
    for (let i = originalCount; i < targetSceneCount; i++) {
      const baseClip = targetClips[i % originalCount];
      const altRenderMode = (i % 2 === 0) ? 'stage_80' : 'center_crop';
      targetClips.push({
        ...baseClip,
        isConformedLoop: true,
        reframe: {
          ...(baseClip.reframe || {}),
          renderMode: altRenderMode,
        },
      });
    }
  }

  let desired = [];
  if (starts.length >= 2) {
    for (let i = 0; i < targetClips.length; i++) {
      const start = starts[i] ?? (i * audioDuration / targetClips.length);
      const next = starts[i + 1] ?? audioDuration;
      desired.push(Math.max(1.0, next - start));
    }
  } else {
    desired = targetClips.map((_, i) => Number(planShots[i]?.targetSec) || (audioDuration / targetClips.length));
  }

  const avgNeeded = audioDuration / targetClips.length;
  const mins = targetClips.map((_, i) => Math.min(Number(planShots[i]?.minSec) || 1.5, Math.max(1.0, avgNeeded * 0.6)));
  const maxs = targetClips.map((_, i) => Math.max(Number(planShots[i]?.maxSec) || 4.2, avgNeeded * 1.4));
  const fitted = distributeTotal(desired, audioDuration, mins, maxs);

  return targetClips.map((clip, i) => {
    const duration = Math.max(1.2, Number(fitted[i] || clip.duration || 3));
    const startSeconds = Number(clip.startSeconds) || 0;
    return {
      ...clip,
      duration: +duration.toFixed(3),
      endSeconds: +(startSeconds + duration).toFixed(3),
      storyboardRole: clip.storyboardRole || planShots[i]?.role || `scene_${i + 1}`,
      creativePurpose: clip.creativePurpose || planShots[i]?.purpose || '',
    };
  });
}

export function choosePreferredCandidateSet(candidateResults = []) {
  const verified = (candidateResults || []).filter(c => c?.productVerification?.verified === true);
  if (!verified.length) return [];

  const scored = verified.map((c) => {
    const cleanCount = c.cleanFrames?.length || 0;
    const confidence = Number(c.productVerification?.confidence) || 0;
    const usable = Math.min(Number(c.videoMeta?.duration) || 60, cleanCount * 4);
    return { c, score: confidence * 100 + Math.min(cleanCount, 20) * 2 + Math.min(usable, 40) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const selected = [best.c];
  // Multi-Video Synergy: Gabungkan hingga 2-3 sumber terverifikasi untuk variasi sudut kamera, latar, & pencahayaan
  for (const item of scored.slice(1)) {
    if (selected.length >= 3) break;
    const candConfidence = Number(item.c.productVerification?.confidence) || 0;
    if (candConfidence >= 0.75 && (item.c.cleanFrames?.length || 0) >= 2) {
      selected.push(item.c);
    }
  }
  return selected;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE <-> VOICEOVER LOCKSTEP (Fase 5, khusus niche strictSceneVoSync)
// Segment plan: [{ slot, timeStart, voLine, visualClaim }] — satu entri per klip final,
// dipakai QC visualMatchesNarration dan perbaikan per-adegan.
// ─────────────────────────────────────────────────────────────────────────────

export function scenesToSlotKeys(niche = '', scenes = []) {
  const preset = getNichePreset(niche);
  const slots = Array.isArray(preset?.slotsConfig) ? preset.slotsConfig : [];
  return (Array.isArray(scenes) ? scenes : []).map((s, i) => {
    const explicit = String(s?.storyboardSlotKey || s?.slotKey || '').trim();
    if (explicit && slots.some(sl => sl.key === explicit)) return explicit;
    const byIndex = slots[i]?.key || '';
    return byIndex;
  });
}

/**
 * Validasi alignment naskah <-> slot storyboard. Hanya MENGHASILKAN ERROR bila strictMode=true
 * (niche strictSceneVoSync). Untuk niche non-strict, hasil dipakai sebagai warning informatif saja.
 */
export function validateScriptSlotAlignment({
  clips = [],
  creativePlan = {},
  scenes = [],
  niche = 'kitchen_tools',
  eligibleFramePaths = null,
} = {}) {
  const preset = getNichePreset(niche);
  const strictMode = Boolean(preset?.strictSceneVoSync);
  const errors = [];
  const warnings = [];
  const planShots = Array.isArray(creativePlan?.shots) ? creativePlan.shots : [];
  const clipList = Array.isArray(clips) ? clips : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];

  // 1) Lockstep 1:1: jumlah klip == jumlah baris voiceover scene (ekspansi loop dilarang)
  if (strictMode && sceneList.length > 0 && clipList.length !== sceneList.length) {
    errors.push(`Jumlah klip visual (${clipList.length}) != jumlah baris voiceover scene (${sceneList.length}) - lockstep Scene<->VO melanggar.`);
  }

  // 2) Urutan storyboardSlot harus monotonik sesuai formula slot preset
  const slotsSeq = clipList.map(c => Number(c?.storyboardSlot) || 0);
  for (let i = 1; i < slotsSeq.length; i++) {
    if (slotsSeq[i] > 0 && slotsSeq[i - 1] > 0 && slotsSeq[i] <= slotsSeq[i - 1]) {
      warnings.push(`Urutan slot storyboard tidak naik pada klip #${i + 1} (${slotsSeq[i - 1]} -> ${slotsSeq[i]}).`);
    }
  }

  // 3) Gerbang Face Policy provenance frame: slot strict DILARANG bersumber dari frame camera-eligible
  const eligibleSet = eligibleFramePaths && typeof eligibleFramePaths.has === 'function' ? eligibleFramePaths : null;
  if (eligibleSet) {
    clipList.forEach((c, i) => {
      const slotKey = c?.storyboardSlotKey || scenesToSlotKeys(niche, sceneList)[i] || '';
      const policy = slotKey ? getSlotFacePolicy(preset, slotKey) : 'strict';
      const framePath = c?.sourceFramePath || c?.anchorFramePath || '';
      if (policy !== 'presenter_only' && framePath && eligibleSet.has(framePath)) {
        errors.push(`Klip slot #${i + 1} (${slotKey || 'tanpa-key'}) bersumber dari frame camera-eligible padahal policy strict.`);
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings, strictMode };
}

/**
 * Bangun segment plan lockstep dari klip final + scene naskah.
 * timeStart = detik klip ke-0 (akumulasi durasi render), voLine = baris scene slot terkait,
 * visualClaim = klaim visual yang HARUS tampak di adegan (bahan QC visualMatchesNarration).
 */
export function buildSceneVoSegments({
  clips = [],
  scenes = [],
  creativePlan = {},
  niche = 'kitchen_tools',
} = {}) {
  const clipList = Array.isArray(clips) ? clips : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const planShots = Array.isArray(creativePlan?.shots) ? creativePlan.shots : [];
  const slotKeys = scenesToSlotKeys(niche, sceneList);
  let cursor = 0;
  return clipList.map((c, i) => {
    const duration = Number(c?.duration) || 0;
    const timeStart = +(cursor).toFixed(3);
    cursor += duration;
    const slotIdx = (Number(c?.storyboardSlot) || (i + 1)) - 1;
    const scene = sceneList[i] || sceneList[slotIdx] || null;
    const slotKey = c?.storyboardSlotKey || slotKeys[i] || planShots[i]?.role || `scene_${i + 1}`;
    const rawVo = String(scene?.voiceover || '').trim();
    return {
      slot: Number(c?.storyboardSlot) || (i + 1),
      slotKey,
      facePolicy: getSlotFacePolicy(getNichePreset(niche), slotKey) || 'strict',
      timeStart,
      duration,
      voLine: rawVo.replace(/^\[[^\]]*\]\s*/, ''),
      visualClaim: String(scene?.visualDescription || planShots[i]?.purpose || c?.creativePurpose || '').trim(),
      sourceVideoId: c?.videoId || c?.candidate?.id || '',
      sourceStartSeconds: Number(c?.startSeconds) || 0,
    };
  });
}
