// P2 JARING PENGAMAN — Kontrak NICHE (config/nichePresets.js + resolveNicheFacePolicy).
// (Niche dapur DIHAPUS) Sekarang hanya gadget_smartphone yang aktif; semua input lain
// (kitchen_tools/kitchen/dapur/alias/tak dikenal/'') dikoersi ke gadget_smartphone
// lewat chokepoint normalizeNicheId.
import { describe, it, expect } from 'vitest';
import {
  NICHE_PRESETS,
  DEFAULT_NICHE_ID,
  normalizeNicheId,
  getNichePreset,
  getAllNiches,
  getSlotFacePolicy,
  generateCombinatorialGadgetKeywords,
} from '../config/nichePresets.js';
import { resolveNicheFacePolicy } from '../services/videoFilterService.js';

const ALL_NICHE_IDS = Object.keys(NICHE_PRESETS);

describe('normalizeNicheId — chokepoint koersi niche', () => {
  it('selalu mengembalikan DEFAULT_NICHE_ID untuk semua masukan', () => {
    for (const v of [
      'kitchen_tools', 'kitchen', 'dapur', 'alat_dapur',
      'gadget', 'hp', 'smartphone', 'gadget_smartphone', 'ytcliper',
      '', '   ', undefined, null, 'bukan_niche', '  Kitchen_Tools ',
    ]) {
      expect(normalizeNicheId(v)).toBe(DEFAULT_NICHE_ID);
    }
  });

  it('DEFAULT_NICHE_ID === gadget_smartphone (niche dapur dihapus)', () => {
    expect(DEFAULT_NICHE_ID).toBe('gadget_smartphone');
  });

  it('NICHE_PRESETS hanya berisi gadget_smartphone', () => {
    expect(ALL_NICHE_IDS).toEqual(['gadget_smartphone']);
    expect(NICHE_PRESETS.kitchen_tools).toBeUndefined();
  });
});

describe('getNichePreset — selalu preset gadget (koersi total)', () => {
  it('id kanonik gadget kembali ke preset gadget', () => {
    expect(getNichePreset('gadget_smartphone').id).toBe('gadget_smartphone');
  });

  it('alias gadget/hp/smartphone/ytcliper => gadget_smartphone', () => {
    for (const alias of ['gadget', 'hp', 'smartphone', 'ytcliper']) {
      expect(getNichePreset(alias).id).toBe('gadget_smartphone');
    }
  });

  it('alias kitchen/dapur/alat_dapur DIKOERSI ke gadget_smartphone', () => {
    for (const alias of ['kitchen', 'dapur', 'alat_dapur', 'kitchen_tools']) {
      expect(getNichePreset(alias).id).toBe('gadget_smartphone');
    }
  });

  it('case-insensitive & toleran spasi', () => {
    expect(getNichePreset('  Gadget_SmartPhone ').id).toBe('gadget_smartphone');
    expect(getNichePreset('SMARTPHONE').id).toBe('gadget_smartphone');
    expect(getNichePreset('  Kitchen_Tools ').id).toBe('gadget_smartphone');
  });

  it('kosong / tidak dikenal => DEFAULT_NICHE_ID', () => {
    for (const v of ['', '   ', undefined, null, 'bukan_niche']) {
      expect(getNichePreset(v).id).toBe(DEFAULT_NICHE_ID);
    }
  });
});

describe('Kontrak struktur preset gadget_smartphone (satu-satunya niche)', () => {
  it.each(ALL_NICHE_IDS)('%s punya 5 slot berurut dengan field wajib', (id) => {
    const preset = NICHE_PRESETS[id];
    expect(preset.id).toBe(id);
    expect(Array.isArray(preset.slotsConfig)).toBe(true);
    expect(preset.slotsConfig.length).toBe(5);
    preset.slotsConfig.forEach((slot, idx) => {
      expect(slot.slot).toBe(idx + 1);
      expect(typeof slot.key).toBe('string');
      expect(slot.key.length).toBeGreaterThan(0);
      expect(typeof slot.role).toBe('string');
    });
  });

  it.each(ALL_NICHE_IDS)('%s punya hook/keyword/storyboard terisi', (id) => {
    const preset = NICHE_PRESETS[id];
    expect(Array.isArray(preset.curatedHooks)).toBe(true);
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

  it('slot tak dikenal => strict', () => {
    expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, 'key-tak-dikenal')).toBe('strict');
  });

  it('hanya slot sampel kamera gadget (slot 4) yang presenter_only', () => {
    expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, 'clip4_camera')).toBe('presenter_only');
    // Slot kamera lama (clip7/clip8) tidak lagi ada di preset 5-slot.
    expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, 'clip7_camera_sample')).toBe('strict');
    expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, 'clip8_camera_detail')).toBe('strict');
  });

  it('slot non-kamera gadget => strict', () => {
    for (const slot of NICHE_PRESETS.gadget_smartphone.slotsConfig) {
      if (slot.key === 'clip4_camera') continue;
      expect(getSlotFacePolicy(NICHE_PRESETS.gadget_smartphone, slot.key)).toBe('strict');
    }
  });
});

describe('resolveNicheFacePolicy — ringkasan kebijakan wajah niche', () => {
  it('gadget_smartphone & semua alias (termasuk dapur) => presenter_only', () => {
    // Karena niche dapur dihapus, input apa pun yang dulunya strict kini
    // dikoersi ke gadget -> face policy default adalah presenter_only
    // (slot 4 kamera = satu-satunya non-strict).
    expect(resolveNicheFacePolicy('gadget_smartphone')).toBe('presenter_only');
    expect(resolveNicheFacePolicy('hp')).toBe('presenter_only');
    expect(resolveNicheFacePolicy('kitchen_tools')).toBe('presenter_only');
    expect(resolveNicheFacePolicy('dapur')).toBe('presenter_only');
  });

  it('niche tak dikenal => fallback DEFAULT (presenter_only, karena preset = gadget)', () => {
    expect(resolveNicheFacePolicy('niche_hantu')).toBe('presenter_only');
  });
});

describe('getAllNiches — bentuk ringkas untuk UI', () => {
  it('hanya satu entri: gadget_smartphone', () => {
    const list = getAllNiches();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('gadget_smartphone');
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
