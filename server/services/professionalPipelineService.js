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

export function buildCreativeShotPlan({ fingerprint = {}, niche = 'gadget_smartphone' } = {}) {
  if (niche === 'gadget_smartphone') {
    const topics = [
      ['screen_review', 'Review layar dan antarmuka yang sedang terlihat'],
      ['screen_detail', 'Detail pengalaman layar dari aksi yang tampak'],
      ['feature_review', 'Demonstrasi fitur yang benar-benar terlihat'],
      ['feature_detail', 'Detail fungsi atau bentuk perangkat yang tampak'],
      ['memory_capacity', 'Kapasitas RAM atau penyimpanan yang terverifikasi'],
      ['memory_detail', 'Bukti visual kapasitas atau pengelolaan penyimpanan'],
      ['camera_sample', 'Sampel foto atau video hasil kamera ponsel'],
      ['camera_result', 'Review hasil kamera sebagai adegan terakhir'],
    ];
    const presetSlots = getNichePreset(niche)?.slotsConfig || [];
    return {
      strategy: 'story_first',
      sourcePolicy: 'multi_angle_dynamic_preferred',
      shots: topics.map(([role, purpose], index) => {
        const slot = presetSlots[index] || {};
        return {
          role,
          purpose,
          targetSec: Number(slot.targetSec) || 6,
          minSec: Number(slot.minSec) || 4.5,
          maxSec: Number(slot.maxSec) || 8,
        };
      }),
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

export function conformClipsToVoiceover({ clips = [], script = '', audioDurationSec = 0, creativePlan = {}, niche = 'gadget_smartphone' } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  // Keep conform output aligned with videoRenderer.normalizeRenderClips(), which
  // rejects auto-mode output below 20s. The old 18s floor produced audio/visual
  // retries that could never pass that downstream gate.
  const MIN_CONFORM_DURATION = 20.0;
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

  // Peta klip -> shot plan BERTASAR SLOT (bukan indeks array), sehingga beberapa klip
  // montase slot-1 berbagi anggaran shot slot 1 yang sama. Bila klip tidak punya
  // storyboardSlot (kitchen/legacy), jatuh ke indeks array -> perilaku lama tak berubah.
  const shotFor = (clip, i) => planShots[(Number(clip?.storyboardSlot) || (i + 1)) - 1] || planShots[i] || {};

  let desired = [];
  if (strictSceneVoSync) {
    // Montase: jumlah klip bisa != jumlah baris VO. Bagi audio proporsional ke durasi
    // footage tiap klip sehingga klip montase ikut kebagian tanpa memalsukan waktu scene.
    const totalFoot = targetClips.reduce((s, c) => s + (Number(c.duration) || 3), 0) || 1;
    desired = targetClips.map((c) => Math.max(1.0, ((Number(c.duration) || 3) / totalFoot) * audioDuration));
  } else if (starts.length >= 2) {
    for (let i = 0; i < targetClips.length; i++) {
      const start = starts[i] ?? (i * audioDuration / targetClips.length);
      const next = starts[i + 1] ?? audioDuration;
      desired.push(Math.max(1.0, next - start));
    }
  } else {
    desired = targetClips.map((clip, i) => Number(shotFor(clip, i)?.targetSec) || (audioDuration / targetClips.length));
  }

  const avgNeeded = audioDuration / targetClips.length;
  const mins = targetClips.map((clip, i) => {
    const planMin = Number(shotFor(clip, i)?.minSec) || 1.5;
    const sourceLength = Number(clip.duration) || planMin;
    return Math.min(planMin, Math.max(1.0, avgNeeded * 0.6), sourceLength);
  });
  const maxs = targetClips.map((clip, i) => {
    const planMax = Math.max(Number(shotFor(clip, i)?.maxSec) || 4.2, avgNeeded * 1.4);
    // Smartphone sections have already been downloaded and audited at this length;
    // conformance may trim them, but must not expose unaudited source frames.
    return strictSceneVoSync ? Math.min(Number(clip.duration) || planMax, planMax) : planMax;
  });
  const fitted = distributeTotal(desired, audioDuration, mins, maxs);
  if (strictSceneVoSync && Math.abs(fitted.reduce((sum, duration) => sum + duration, 0) - audioDuration) > 0.25) {
    const durationError = new Error(`Durasi voice-over ${audioDuration.toFixed(1)}s melampaui footage smartphone yang sudah diaudit (${fitted.reduce((sum, duration) => sum + duration, 0).toFixed(1)}s).`);
    durationError.isRenderPlanShortfall = true;
    durationError.rejectionReason = durationError.message;
    throw durationError;
  }

  return targetClips.map((clip, i) => {
    const shot = shotFor(clip, i);
    const duration = Math.max(1.2, Number(fitted[i] || clip.duration || 3));
    const startSeconds = Number(clip.startSeconds) || 0;
    return {
      ...clip,
      duration: +duration.toFixed(3),
      endSeconds: +(startSeconds + duration).toFixed(3),
      storyboardRole: clip.storyboardRole || shot.role || `scene_${Number(clip.storyboardSlot) || (i + 1)}`,
      creativePurpose: clip.creativePurpose || shot.purpose || '',
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
 * Kelompokkan klip menjadi SATU grup per storyboardSlot (menjaga urutan kemunculan dalam
 * tiap slot). Dipakai kontrak lockstep montase: sebuah slot boleh membawa 2-4 klip fisik
 * (slot 1 montase) namun tetap SATU scene. Pengelompokan tidak bergantung urutan array
 * (slot sama dikumpulkan), lalu grup disusun naik menurut slot agar timeline montase
 * selalu paling awal. Klip tanpa storyboardSlot (slot 0) dikumpulkan terakhir sebagai
 * satu grup (mode non-strict/kitchen). MURNI: tidak memutasi input.
 * @param {Array<{storyboardSlot?: number|string}>} clips
 * @returns {Array<{ slot: number, clips: object[] }>}
 */
export function groupClipsBySlot(clips = []) {
  const list = Array.isArray(clips) ? clips : [];
  const bySlot = new Map();
  for (const c of list) {
    const slot = Number(c?.storyboardSlot) || 0;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(c);
  }
  const slots = Array.from(bySlot.keys()).sort((a, b) => {
    if (a === b) return 0;
    if (a === 0) return 1;   // slot 0 (tanpa slot) paling belakang
    if (b === 0) return -1;
    return a - b;
  });
  return slots.map((slot) => ({ slot, clips: bySlot.get(slot) }));
}

/**
 * Nilai kecukupan rencana storyboard per-slot (D2 - floor gadget): semua slot slotsConfig
 * terisi (montase >= montageMin) dan total durasi rencana (pemilihan klip terbaik per slot)
 * >= requiredTotalSec. MURNI: tidak memutasi input.
 * @param {Array<{storyboardSlot?: number, duration?: number}>} clips
 * @param {Array<{slot: number, key?: string, montage?: boolean, montageMin?: number, montageMax?: number}>} slotsConfig
 * @param {{ requiredTotalSec?: number }} [opts]
 * @returns {{ missingSlots: string[], totalDurationSec: number, durationShort: boolean, ok: boolean }}
 */
export function assessStoryboardPlan(clips = [], slotsConfig = [], { requiredTotalSec = 0 } = {}) {
  const list = Array.isArray(clips) ? clips : [];
  const slots = Array.isArray(slotsConfig) ? slotsConfig : [];
  const bySlot = new Map(groupClipsBySlot(list).map((g) => [g.slot, g.clips]));
  const missingSlots = [];
  let totalDurationSec = 0;
  for (const cfg of slots) {
    const slot = Number(cfg?.slot);
    const pool = bySlot.get(slot) || [];
    const label = String(cfg?.key || `slot_${slot}`);
    if (!pool.length) { missingSlots.push(label); continue; }
    if (cfg.montage === true) {
      const lo = Number(cfg.montageMin) || 2;
      const hi = Number(cfg.montageMax) || 4;
      if (pool.length < lo) missingSlots.push(`${label}(montase ${pool.length}/${lo})`);
      const picked = pool.slice().sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0)).slice(0, hi);
      totalDurationSec += picked.reduce((s, c) => s + (Number(c.duration) || 0), 0);
    } else {
      const best = pool.slice().sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))[0];
      totalDurationSec += Number(best?.duration) || 0;
    }
  }
  const durationShort = requiredTotalSec > 0 && totalDurationSec < requiredTotalSec;
  return {
    missingSlots,
    totalDurationSec: Math.round(totalDurationSec * 10) / 10,
    durationShort,
    ok: missingSlots.length === 0 && !durationShort,
  };
}

/**
 * Rakit klip final per-slot dari gabungan beberapa sumber (kontrak montase):
 * SATU grup per slot — slot montase mengambil 2-4 klip (prioritas dari SATU sumber yang
 * paling banyak punya klip slot itu agar satu cluster unduhan; sisanya menumpuk dari
 * sumber lain sampai montageMax), slot non-montase mengambil klip terpanjang. Hasil
 * tersusun naik menurut slot (montase di 00:00). Klip tanpa storyboardSlot dikembalikan apa adanya.
 * MURNI: tidak memutasi input.
 * @param {Array<object>} clips
 * @param {Array<{slot: number, montage?: boolean, montageMin?: number, montageMax?: number}>} slotsConfig
 * @returns {object[]}
 */
export function assembleStoryboardClips(clips = [], slotsConfig = []) {
  const list = Array.isArray(clips) ? clips : [];
  const slots = Array.isArray(slotsConfig) ? slotsConfig : [];
  if (!slots.length || !list.some((c) => (Number(c?.storyboardSlot) || 0) > 0)) return [...list];
  const bySlot = new Map(groupClipsBySlot(list).filter((g) => g.slot > 0).map((g) => [g.slot, g.clips]));
  const byStart = (a, b) => (Number(a?.startSeconds) || 0) - (Number(b?.startSeconds) || 0);
  const byDurDesc = (a, b) => (Number(b?.duration) || 0) - (Number(a?.duration) || 0);
  const out = [];
  for (const cfg of slots) {
    const pool = bySlot.get(Number(cfg?.slot)) || [];
    if (!pool.length) continue;
    if (cfg.montage === true) {
      const hi = Number(cfg.montageMax) || 4;
      const bySource = new Map();
      for (const c of pool) {
        const key = c?.candidateUrl || c?.videoId || `cand:${c?.candidateIndex ?? 0}`;
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key).push(c);
      }
      const groups = [...bySource.values()].sort((a, b) => b.length - a.length);
      let picked = groups.length > 0 ? groups[0].slice().sort(byStart) : [];
      if (picked.length < hi && groups.length > 1) {
        const others = groups.slice(1).flat().sort(byDurDesc);
        picked = [...picked, ...others].slice(0, hi).sort(byStart);
      } else if (picked.length > hi) {
        picked = picked.slice(0, hi);
      }
      out.push(...picked);
    } else {
      out.push(pool.slice().sort(byDurDesc)[0]);
    }
  }
  return out;
}

/**
 * Validasi alignment naskah <-> slot storyboard. Hanya MENGHASILKAN ERROR bila strictMode=true
 * (niche strictSceneVoSync). Untuk niche non-strict, hasil dipakai sebagai warning informatif saja.
 */
export function validateScriptSlotAlignment({
  clips = [],
  creativePlan = {},
  scenes = [],
  niche = 'gadget_smartphone',
  eligibleFramePaths = null,
} = {}) {
  const preset = getNichePreset(niche);
  const strictMode = Boolean(preset?.strictSceneVoSync);
  const errors = [];
  const warnings = [];
  const planShots = Array.isArray(creativePlan?.shots) ? creativePlan.shots : [];
  const clipList = Array.isArray(clips) ? clips : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const requiredSlots = Array.isArray(preset?.slotsConfig)
    ? preset.slotsConfig.map((slot) => Number(slot?.slot)).filter(Number.isFinite)
    : [];

  // MODEL GRUP-PER-SLOT (montase): sebuah slot boleh membawa beberapa klip fisik (slot 1
  // montase 2-4 klip) tetapi tetap SATU scene. Semua pemeriksaan lockstep memakai jumlah
  // GRUP (distinct slot berurutan), bukan jumlah klip mentah, sehingga storyboard montase
  // berklip >5 tetap sah selama tiap beat editorial terisi tepat satu grup.
  const slotGroups = groupClipsBySlot(clipList);
  const groupSlots = slotGroups.map(g => g.slot);
  const slotKeyBySlot = new Map((Array.isArray(preset?.slotsConfig) ? preset.slotsConfig : []).map((sl) => [Number(sl?.slot), sl?.key]));

  // 1) Lockstep: jumlah GRUP slot == jumlah baris voiceover scene (bukan jumlah klip).
  if (strictMode && sceneList.length > 0 && slotGroups.length !== sceneList.length) {
    errors.push(`Storyboard memiliki ${slotGroups.length} grup slot != jumlah baris voiceover scene (${sceneList.length}) - lockstep Scene<->VO melanggar.`);
  }

  // Smartphone wajib memuat tiap beat persis SATU grup; montase boleh >1 klip dalam grupnya.
  if (strictMode && requiredSlots.length > 0) {
    if (sceneList.length !== requiredSlots.length) {
      errors.push(`Storyboard smartphone memiliki ${sceneList.length} scene; wajib ${requiredSlots.length} scene.`);
    }
    if (groupSlots.length !== requiredSlots.length || groupSlots.some((s, idx) => s !== requiredSlots[idx])) {
      errors.push(`Grup slot smartphone harus ${requiredSlots.join(' -> ')} (satu grup per slot); ditemukan ${groupSlots.join(' -> ') || 'kosong'}.`);
    } else {
      slotGroups.forEach((g, idx) => {
        const cfg = preset.slotsConfig[idx] || {};
        const n = g.clips.length;
        if (cfg.montage === true) {
          const lo = Number(cfg.montageMin) || 2;
          const hi = Number(cfg.montageMax) || 4;
          if (n < lo || n > hi) errors.push(`Slot ${g.slot} (montase) punya ${n} klip; harus ${lo}-${hi}.`);
        } else if (n !== 1) {
          errors.push(`Slot ${g.slot} punya ${n} klip; slot non-montase wajib tepat 1 klip.`);
        }
      });
    }
  }

  // 2) Urutan storyboardSlot per-klip harus NON-DECREASING (slot sama = montase, boleh; turun, salah).
  const slotsSeq = clipList.map(c => Number(c?.storyboardSlot) || 0);
  for (let i = 1; i < slotsSeq.length; i++) {
    if (slotsSeq[i] > 0 && slotsSeq[i - 1] > 0 && slotsSeq[i] < slotsSeq[i - 1]) {
      const message = `Urutan slot storyboard turun pada klip #${i + 1} (${slotsSeq[i - 1]} -> ${slotsSeq[i]}).`;
      if (strictMode) errors.push(message);
      else warnings.push(message);
    }
  }

  // 3) Gerbang Face Policy provenance frame: slot strict DILARANG bersumber dari frame camera-eligible.
  //    slotKey diselesaikan lewat SLOT klip (bukan indeks array) agar sub-klip montase memakai policy benar.
  const eligibleSet = eligibleFramePaths && typeof eligibleFramePaths.has === 'function' ? eligibleFramePaths : null;
  if (eligibleSet) {
    const indexSlotKeys = scenesToSlotKeys(niche, sceneList);
    clipList.forEach((c, i) => {
      const slot = Number(c?.storyboardSlot) || 0;
      const slotKey = c?.storyboardSlotKey || (slot ? slotKeyBySlot.get(slot) : '') || indexSlotKeys[i] || '';
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
  niche = 'gadget_smartphone',
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
    const slot = Number(c?.storyboardSlot) || (i + 1);
    const slotIdx = slot - 1;
    // Montase: beberapa klip berbagi SATU scene (slot). Resolusikan scene/plan BERTASAR SLOT,
    // jatuh ke indeks array bila slot tak tersedia -> perilaku lama untuk input tanpa slot.
    const scene = sceneList[slotIdx] || sceneList[i] || null;
    const slotKey = c?.storyboardSlotKey || slotKeys[slotIdx] || planShots[slotIdx]?.role || `scene_${slot}`;
    const rawVo = String(scene?.voiceover || '').trim();
    return {
      slot,
      slotKey,
      facePolicy: getSlotFacePolicy(getNichePreset(niche), slotKey) || 'strict',
      timeStart,
      duration,
      voLine: rawVo.replace(/^\[[^\]]*\]\s*/, ''),
      visualClaim: String(scene?.visualDescription || planShots[slotIdx]?.purpose || c?.creativePurpose || '').trim(),
      sourceVideoId: c?.videoId || c?.candidate?.id || '',
      sourceStartSeconds: Number(c?.startSeconds) || 0,
    };
  });
}
