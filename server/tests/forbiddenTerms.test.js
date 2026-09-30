import { describe, it, expect } from 'vitest';
import {
  REPAIR_TERMS,
  TUTORIAL_TERMS,
  REPAIR_JARGON_TERMS,
  hasRepairIntent,
  hasStrongRepairIntent,
  hasTutorialIntent,
  isForbiddenSearchQuery,
  stripForbiddenTerms,
  forbiddenTitlePattern,
  forbiddenNegativeOperators,
  coreNegativeOperators,
} from '../config/forbiddenTerms.js';

// Regresi lapangan 30 Sep 2026 (job auto_3dd085b354, niche kitchen_tools):
// listing "Servis Megicom Matot" lolos sebagai produk karena larangan servis
// dulu hanya aktif di dalam blok niche gadget. Semua test di bawah mengunci bahwa
// satu daftar kanonik kini berlaku untuk SEMUA jalur pencarian.
describe('forbiddenTerms - satu sumber kebenaran kata terlarang', () => {
  it('mengenali jasa servis / barang rusak di semua niche', () => {
    expect(hasRepairIntent('Servis Megicom Matot')).toBe(true);
    expect(hasRepairIntent('jasa reparasi dispenser')).toBe(true);
    expect(hasRepairIntent('megaicom rusak tidak bisa masak')).toBe(true);
    expect(hasRepairIntent('chopper manual tarik serbaguna viral')).toBe(false);
    expect(hasRepairIntent('Olike rice cooker 1.8L')).toBe(false);
  });

  it('tidak salah tolak garansi "after-sales service"', () => {
    expect(hasRepairIntent('garansi after sales service 1 tahun')).toBe(false);
    expect(hasRepairIntent('layanan purna jual service resmi')).toBe(false);
  });

  it('jargon reparasi lanjutan hanya aktif untuk niche gadget', () => {
    expect(hasRepairIntent('solder listrik 60w')).toBe(false);
    expect(hasRepairIntent('solder listrik 60w', { includeGadgetJargon: true })).toBe(true);
    expect(REPAIR_JARGON_TERMS).toContain('skematik');
  });

  it('mengenali tutorial / DIY', () => {
    expect(hasTutorialIntent('cara pakai air fryer')).toBe(true);
    expect(hasTutorialIntent('diy dari barang bekas')).toBe(true);
    expect(hasTutorialIntent('review Olike rice cooker indonesia')).toBe(false);
  });

  it('query pencarian dilarang memuat kedua kelas kata', () => {
    expect(isForbiddenSearchQuery('olike rice cooker cara pakai')).toBe(true);
    expect(isForbiddenSearchQuery('servis megicom matot review')).toBe(true);
    expect(isForbiddenSearchQuery('olike rice cooker unboxing review')).toBe(false);
  });

  it('daftar kanonik tidak boleh kosong sebagian', () => {
    for (const term of ['servis', 'reparasi', 'perbaikan', 'rusak', 'bongkar', 'mati total', 'matot']) {
      expect(REPAIR_TERMS).toContain(term);
    }
    for (const term of ['cara', 'tutorial', 'diy', 'how to']) {
      expect(TUTORIAL_TERMS).toContain(term);
    }
  });
});

describe('stripForbiddenTerms - membersihkan query tanpa merusak operator', () => {
  it('membuang SEMUA kemunculan, bukan hanya yang pertama', () => {
    expect(stripForbiddenTerms('servis dispenser servis karbitan')).toBe('dispenser karbitan');
  });

  it('operator negatif yang sudah benar tetap utuh', () => {
    const kept = stripForbiddenTerms('air fryer review -servis -cara');
    expect(kept).toContain('-servis');
    expect(kept).toContain('-cara');
  });

  it('syntax pencarian lanjutan (kurung + kutip) tidak dirusak', () => {
    const q = stripForbiddenTerms('"olike" (review OR demo) -matot');
    expect(q).toContain('"olike"');
    expect(q).toContain('(review OR demo)');
  });

  it('frasa multi-kata dibuang utuh', () => {
    expect(stripForbiddenTerms('megicom mati total 1.8L')).toBe('megicom 1.8L');
  });
});

describe('forbiddenTitlePattern - dipakai filter judul mesin telusur', () => {
  it('menolak judul servis dan tutorial', () => {
    const re = forbiddenTitlePattern();
    expect(re.test('servis megicom OLike matot dan tidak bisa masak')).toBe(true);
    expect(re.test('cara membuat rice cooker dari kaleng')).toBe(true);
    expect(re.test('Olike Rice Cooker 1.8L Unboxing Review')).toBe(false);
  });

  it('tetap konsisten saat dipanggil berulang (tidak pakai flag global)', () => {
    const re = forbiddenTitlePattern();
    const titles = ['servis ac rumah', 'simplus air fryer review', 'cara ganti ban', 'wajan anti lengket demo'];
    const firstPass = titles.map((t) => re.test(t));
    const secondPass = titles.map((t) => re.test(t));
    expect(secondPass).toEqual(firstPass);
    expect(firstPass).toEqual([true, false, true, false]);
  });

  it('deskripsi panjang hanya ditolak oleh indikasi kuat', () => {
    expect(hasStrongRepairIntent('kami melayani jasa servis dan perbaikan rutin')).toBe(true);
    expect(hasStrongRepairIntent('dilengkapi baterai yang mudah ganti bila habis')).toBe(false);
  });
});

describe('operator negatif kanonik untuk mesin telusur', () => {
  it('memuat istilah Indonesia (bukan hanya -repair bahasa Inggris)', () => {
    const ops = coreNegativeOperators();
    expect(ops).toContain('-servis');
    expect(ops).toContain('-cara');
    expect(ops).toContain('-tutorial');
    expect(ops).toContain('-diy');
    expect(ops).toContain('-matot');
  });

  it('frasa multi-kata diberi kutip agar tidak terpotong', () => {
    expect(forbiddenNegativeOperators()).toContain('-"mati total"');
  });
});
