import { describe, it, expect } from 'vitest';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  describeConfigSnapshot,
  SNAPSHOT_FLAG_KEYS,
} from '../config/runtimeFlags.js';

// P5: snapshot config runtime dibekukan saat create & dapat direproduksi saat retry.
// buildConfigSnapshot meniru PERSIS cara tiap konsumen membaca flag — tes ini mengunci
// bahwa nilai efektifnya benar DAN tidak berubah meski env dimutasi setelah beku.

describe('buildConfigSnapshot — normalisasi meniru konsumen asli', () => {
  it('memberi default aman saat env kosong (tanpa flag)', () => {
    const s = buildConfigSnapshot({});
    expect(s.RENDER_DOWNLOAD_SECTIONS).toBe(false);   // === '1'
    expect(s.RENDER_NO_FULL_DOWNLOAD).toBe(false);
    expect(s.SAMPLE_MAX_FRAMES).toBe(500);            // Math.max(20, Number(undefined)||500)
    expect(s.GK_MAX_BATCH_FRAMES).toBe(240);
    expect(s.AUDIO_DRIVEN_SCENES).toBe(false);        // 'true' lowercase
    expect(s.FINAL_AI_QC).toBe(true);                 // !== 'false'
    expect(s.FINAL_AI_QC_STRICT).toBe(false);         // === 'true'
    expect(s.niche).toBe('kitchen_tools');
    expect(s.sourcePolicy).toBe('');
    expect(s._frozenAt).toBeTruthy();
  });

  it('RENDER flag hanya aktif saat persis "1"', () => {
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: '1' }).RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: 'true' }).RENDER_DOWNLOAD_SECTIONS).toBe(false);
    expect(buildConfigSnapshot({ RENDER_NO_FULL_DOWNLOAD: '1' }).RENDER_NO_FULL_DOWNLOAD).toBe(true);
  });

  it('frame budgets memakai floor 20 & parse number (bukan NaN)', () => {
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: '300' }).SAMPLE_MAX_FRAMES).toBe(300);
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: '5' }).SAMPLE_MAX_FRAMES).toBe(20); // floor
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: 'abc' }).SAMPLE_MAX_FRAMES).toBe(500); // NaN -> default
    expect(buildConfigSnapshot({ GK_MAX_BATCH_FRAMES: '480' }).GK_MAX_BATCH_FRAMES).toBe(480);
    expect(buildConfigSnapshot({ GK_MAX_BATCH_FRAMES: '10' }).GK_MAX_BATCH_FRAMES).toBe(20);
  });

  it('AUDIO_DRIVEN_SCENES toleransi spasi & kapital (trim+lowercase)', () => {
    expect(buildConfigSnapshot({ AUDIO_DRIVEN_SCENES: ' TRUE ' }).AUDIO_DRIVEN_SCENES).toBe(true);
    expect(buildConfigSnapshot({ AUDIO_DRIVEN_SCENES: 'yes' }).AUDIO_DRIVEN_SCENES).toBe(false);
  });

  it('FINAL_AI_QC aktif kecuali string persis "false"; STRICT hanya "true"', () => {
    expect(buildConfigSnapshot({ FINAL_AI_QC: 'off' }).FINAL_AI_QC).toBe(true); // 'off' !== 'false'
    expect(buildConfigSnapshot({ FINAL_AI_QC: 'false' }).FINAL_AI_QC).toBe(false);
    expect(buildConfigSnapshot({ FINAL_AI_QC_STRICT: 'true' }).FINAL_AI_QC_STRICT).toBe(true);
  });

  it('menyertakan niche & sourcePolicy dari opsi job', () => {
    const s = buildConfigSnapshot({}, { niche: 'gadget_smartphone', sourcePolicy: 'explicit_only' });
    expect(s.niche).toBe('gadget_smartphone');
    expect(s.sourcePolicy).toBe('explicit_only');
  });

  it('hasil hanya primitif (siap JSON.stringify ke DB)', () => {
    const s = buildConfigSnapshot({});
    for (const k of SNAPSHOT_FLAG_KEYS) {
      expect(['string', 'number', 'boolean']).toContain(typeof s[k]);
    }
  });

  it('BEKU: memutasi env setelah snapshot dibuat TIDAK mengubah nilai snapshot', () => {
    const env = { RENDER_DOWNLOAD_SECTIONS: '1', SAMPLE_MAX_FRAMES: '300' };
    const s = buildConfigSnapshot(env, { niche: 'kitchen_tools' });
    // operator mengubah .env setelahnya
    env.RENDER_DOWNLOAD_SECTIONS = '0';
    env.SAMPLE_MAX_FRAMES = '50';
    expect(s.RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(s.SAMPLE_MAX_FRAMES).toBe(300);
  });
});

describe('configSnapshotToEnvPatch — retry dapat mereproduksi setelan', () => {
  it('round-trip: patch env dari snapshot menghasilkan nilai efektif yang sama', () => {
    const originalEnv = {
      RENDER_DOWNLOAD_SECTIONS: '1',
      RENDER_NO_FULL_DOWNLOAD: '1',
      SAMPLE_MAX_FRAMES: '320',
      GK_MAX_BATCH_FRAMES: '300',
      AUDIO_DRIVEN_SCENES: 'true',
      FINAL_AI_QC: 'true',
      FINAL_AI_QC_STRICT: 'true',
    };
    const snap = buildConfigSnapshot(originalEnv);
    // lingkungan retry SEKARANG sudah berbeda (operator mengubah .env)
    const driftedEnv = { RENDER_DOWNLOAD_SECTIONS: '0', SAMPLE_MAX_FRAMES: '500' };
    const patch = configSnapshotToEnvPatch(snap);
    const applied = { ...driftedEnv, ...patch };
    const resnap = buildConfigSnapshot(applied);
    for (const k of SNAPSHOT_FLAG_KEYS) {
      expect(resnap[k]).toEqual(snap[k]);
    }
  });

  it('mengembalikan {} untuk snapshot tidak valid', () => {
    expect(configSnapshotToEnvPatch(null)).toEqual({});
    expect(configSnapshotToEnvPatch(undefined)).toEqual({});
    expect(configSnapshotToEnvPatch('bukan-objek')).toEqual({});
  });

  it('boolean false -> string "0"/"false" (bukan dihilangkan), supaya override deterministik', () => {
    const patch = configSnapshotToEnvPatch(buildConfigSnapshot({}));
    expect(patch.RENDER_DOWNLOAD_SECTIONS).toBe('0');
    expect(patch.AUDIO_DRIVEN_SCENES).toBe('false');
    expect(patch.FINAL_AI_QC).toBe('true'); // default aktif
  });
});

describe('describeConfigSnapshot', () => {
  it('menyebutkan seluruh flag beku + niche untuk log', () => {
    const line = describeConfigSnapshot(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: '320' }, { niche: 'gadget_smartphone' }));
    expect(line).toContain('SAMPLE_MAX_FRAMES=320');
    expect(line).toContain('niche=gadget_smartphone');
    for (const k of SNAPSHOT_FLAG_KEYS) expect(line).toContain(`${k}=`);
  });
  it('ramah untuk snapshot kosong', () => {
    expect(describeConfigSnapshot(null)).toBe('(tanpa snapshot)');
  });
});
