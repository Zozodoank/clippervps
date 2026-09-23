/**
 * Professional short-form editing helpers.
 * Pure functions only: no network, no filesystem, no AI calls.
 */

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

function distributeTotal(rawDurations, total, mins, maxs) {
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

export function conformClipsToVoiceover({ clips = [], script = '', audioDurationSec = 0, creativePlan = {} } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const audioDuration = Number(audioDurationSec) || clips.reduce((s, c) => s + (Number(c.duration) || 3), 0);
  const starts = extractScriptSceneStarts(script);
  const planShots = Array.isArray(creativePlan.shots) ? creativePlan.shots : [];

  let desired = [];
  if (starts.length >= 2) {
    const relevantStarts = starts.slice(0, clips.length);
    for (let i = 0; i < clips.length; i++) {
      const start = relevantStarts[i] ?? (i * audioDuration / clips.length);
      const next = relevantStarts[i + 1] ?? audioDuration;
      desired.push(Math.max(0.8, next - start));
    }
  } else {
    desired = clips.map((_, i) => Number(planShots[i]?.targetSec) || (audioDuration / clips.length));
  }

  const mins = clips.map((_, i) => Number(planShots[i]?.minSec) || 1.5);
  const maxs = clips.map((_, i) => Number(planShots[i]?.maxSec) || 4.2);
  const fitted = distributeTotal(desired, audioDuration, mins, maxs);

  return clips.map((clip, i) => {
    const duration = Math.max(1.5, Number(fitted[i] || clip.duration || 3));
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
