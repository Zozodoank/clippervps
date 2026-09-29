// P2 JARING PENGAMAN — Kontrak NICHE (config/nichePresets.js + resolveNicheFacePolicy).
// Mengunci: resolusi alias, bentuk 7-slot, kebijakan wajah per-slot, dan generator kata kunci.
import { describe, it, expect } from 'vitest';
import {
  NICHE_PRESETS,
  DEFAULT_NICHE_ID,
  getNichePreset,
  getAllNiches,
  getSlotFacePolicy,
  generateCombinatorialGadgetKeywords,
} from '../config/nichePresets.js';
import { resolveNicheFacePolicy } from '../services/videoFilterService.js';

const ALL_NICHE_IDS = Object.keys(NICHE_PRESETS);

describe('getNichePreset — resolusi alias & fallback', () => {
  it('id kanonik kembali ke preset yang tepat', () => {
    expect(getNichePreset('kitchen_tools').id).toBe('kitchen_tools');
    expect(getNichePreset('gadget_smartphone').id).toBe('gadget_smartphone');
  });

  it('alias gadget/hp/smartphone/ytcliper => gadget_smartphone', () => {
    for (const alias of ['gadget', 'hp', 'smartphone', 'ytcliper']) {
      expect(getNichePreset(alias).id).toBe('gadget_smartphone');
    }
  });

  it('alias kitchen/dapur/alat_dapur => kitchen_tools', () => {
    for (const alias of ['kitchen', 'dapur', 'alat_dapur']) {
      expect(getNichePreset(alias).id).toBe('kitchen_tools');
    }
  });

  it('case-insensitive & toleran spasi', () => {
    expect(getNichePreset('  Gadget_SmartPhone ').id).toBe('gadget_smartphone');
    expect(getNichePreset('SMARTPHONE').id).toBe('gadget_smartphone');
  });

  it('kosong / tidak dikenal => DEFAULT_NICHE_ID', () => {
    for (const v of ['', '   ', undefined, null, 'bukan_niche']) {
      expect(getNichePreset(v).id).toBe(DEFAULT_NICHE_ID);
    }
  });
});

describe('Kontrak struktur setiap preset niche', () => {
  it.each(ALL_NICHE_IDS)('%s punya 7 slot berurut 1..7 dengan field wajib', (id) => {
    const preset = NICHE_PRESETS[id];
    expect(preset.id).toBe(id);
    expect(Array.isArray(preset.slotsConfig)).toBe(true);
    expect(preset.slotsConfig.length).toBe(7);
    preset.slotsConfig.forEach((slot, idx) => {
      expect(slot.slot).toBe(idx + 1);
      expect(typeof slot.key).toBe('string');
      expect(slot.key.length).toBeGreaterThan(0);
      expect(typeof slot.role).toBe('string');
    });
  });

  it.each(ALL_NICHE_IDS)('%s punya hook/keyword/storyboard terisi', (id) => {
    const preset = NICHE_PRESETS[id];
    expect(Array.isArray(preset.curatedHooks) && preset.curatedHooks.length > 0).toBe(true);
    expect(Array.isArray(preset.defaultKeywords) && preset.defaultKeywords.length > 0).toBe(true);
    expect(typeof preset.storyboardInstructions).toBe('string');
    expect(preset.storyboardInstructions.length).toBeGreaterThan(0);
  });

  it('keys slot unik di dalam satu niche', () => {
    for (const id of ALL_NICHE_IDS) {
      const keys = NICHE_PRESETS[id].slotsConfig.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('getSlotFacePolicy — default strict, data-driven per slot', () => {
  it('preset null / slotsConfig bukan array => strict', () => {
    expect(getSlotFacePolicy(null, 'clip1')).toBe('strict');
    expect(getSlotFacePolicy({}, 'clip1')).toBe('strict');
  });

  it('slot tanpa facePolicy => strict', () => {
    expect(getSlotFacePolicy(NICHE_PRESETS.kitchen_tools, 'clip1_full_product')).toBe('strict');
    expect(getSlotFacePolicy(NICHE_PRESETS.kitchen_tools, 'key-tak-dikenal')).toBe('strict');
  });

  it('gadget slot clip5_action_demo => presenter_only', () => {
    expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, 'clip5_action_demo')).toBe('presenter_only');
  });

  it('kitchen_tools: SEMUA slot strict (tidak ada facePolicy non-strict)', () => {
    for (const slot of NICHE_PRESETS.kitchen_tools.slotsConfig) {
      expect(getSlotFacePolicy(NICHE_PRESETS.kitchen_tools, slot.key)).toBe('strict');
    }
  });
});

describe('resolveNicheFacePolicy — ringkasan kebijakan wajah niche', () => {
  it('kitchen => strict', () => {
    expect(resolveNicheFacePolicy('kitchen_tools')).toBe('strict');
    expect(resolveNicheFacePolicy('dapur')).toBe('strict');
  });

  it('gadget_smartphone => presenter_only (slot 5 longgar)', () => {
    expect(resolveNicheFacePolicy('gadget_smartphone')).toBe('presenter_only');
    expect(resolveNicheFacePolicy('hp')).toBe('presenter_only');
  });

  it('niche tak dikenal => fallback default (strict)', () => {
    expect(resolveNicheFacePolicy('niche_hantu')).toBe('strict');
  });
});

describe('getAllNiches — bentuk ringkas untuk UI', () => {
  it('memetakan semua preset ke field tampilan', () => {
    const list = getAllNiches();
    expect(list.length).toBe(ALL_NICHE_IDS.length);
    for (const n of list) {
      expect(n).toHaveProperty('id');
      expect(n).toHaveProperty('name');
      expect(n).toHaveProperty('totalKeywords');
      expect(typeof n.totalKeywords).toBe('number');
    }
  });
});

describe('generateCombinatorialGadgetKeywords — deterministik & unik', () => {
  it('mengembalikan tepat `count` kata kunci bila pool cukup', () => {
    const kws = generateCombinatorialGadgetKeywords(10);
    expect(kws.length).toBe(10);
    expect(kws.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
  });

  it('tidak menghasilkan duplikat', () => {
    const kws = generateCombinatorialGadgetKeywords(30);
    expect(new Set(kws.map((k) => k.toLowerCase())).size).toBe(kws.length);
  });

  it('deterministik: dua panggilan berurutan memberi hasil identik', () => {
    expect(generateCombinatorialGadgetKeywords(8)).toEqual(generateCombinatorialGadgetKeywords(8));
  });

  it('menghormati excludedSet (melewati kata yang sudah dipakai)', () => {
    const first = generateCombinatorialGadgetKeywords(5);
    const excluded = new Set(first.map((k) => k.toLowerCase()));
    const second = generateCombinatorialGadgetKeywords(5, excluded);
    expect(second.every((k) => !excluded.has(k.toLowerCase()))).toBe(true);
  });
});
