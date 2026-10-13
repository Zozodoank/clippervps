import { describe, it, expect } from 'vitest';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  describeConfigSnapshot,
  applyConfigSnapshot,
  isOraclePreflightEnabled,
  SNAPSHOT_FLAG_KEYS,
} from '../config/runtimeFlags.js';

// P5: snapshot config runtime dibekukan saat create & dapat direproduksi saat retry.
// buildConfigSnapshot meniru PERSIS cara tiap konsumen membaca flag — tes ini mengunci
// bahwa nilai efektifnya benar DAN tidak berubah meski env dimutasi setelah beku.

describe('buildConfigSnapshot — normalisasi meniru konsumen asli', () => {
  it('memberi default aman saat env kosong (tanpa flag)', () => {
    const s = buildConfigSnapshot({});
    expect(s.RENDER_DOWNLOAD_SECTIONS).toBe(true);     // !== '0' (DEFAULT ON — hemat kuota)
    expect(s.RENDER_NO_FULL_DOWNLOAD).toBe(false);     // === '1'
    expect(s.SAMPLE_MAX_FRAMES).toBe(500);            // Math.max(20, Number(undefined)||500)
    expect(s.GK_MAX_BATCH_FRAMES).toBe(240);
    expect(s.ORACLE_OFFLINE_CALIBRATION).toBe(false);
    expect(s.VLM_ORACLE_GRID).toBe(2);
    expect(s.FINAL_AI_QC).toBe(true);                 // !== 'false'
    expect(s.FINAL_AI_QC_STRICT).toBe(false);         // === 'true'
    expect(s.niche).toBe('kitchen_tools');
    expect(s.sourcePolicy).toBe('');
    expect(s._frozenAt).toBeTruthy();
  });

  it('RENDER_DOWNLOAD_SECTIONS default-ON: hanya "0" yang mematikan; RENDER_NO_FULL_DOWNLOAD hanya "1"', () => {
    // Unduh section kini DEFAULT ON (hanya '0' memaksa unduh penuh).
    expect(buildConfigSnapshot({}).RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: '1' }).RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: 'true' }).RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: '' }).RENDER_DOWNLOAD_SECTIONS).toBe(true);
    expect(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: '0' }).RENDER_DOWNLOAD_SECTIONS).toBe(false);
    // Mode tegas tetap opt-in: hanya persis '1'.
    expect(buildConfigSnapshot({ RENDER_NO_FULL_DOWNLOAD: '1' }).RENDER_NO_FULL_DOWNLOAD).toBe(true);
    expect(buildConfigSnapshot({ RENDER_NO_FULL_DOWNLOAD: '0' }).RENDER_NO_FULL_DOWNLOAD).toBe(false);
    // Round-trip patch<->normalizer stabil (patch true->'1', false->'0'; konsumen !== '0').
    for (const on of [true, false]) {
      const snap = buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: on ? '1' : '0' });
      const repatched = buildConfigSnapshot(configSnapshotToEnvPatch(snap));
      expect(repatched.RENDER_DOWNLOAD_SECTIONS).toBe(on);
    }
  });

  it('VLM_ORACLE_GRID mendukung grid 2x2 dan fallback frame tunggal, lalu ikut snapshot', () => {
    expect(buildConfigSnapshot({}).VLM_ORACLE_GRID).toBe(2);
    expect(buildConfigSnapshot({ VLM_ORACLE_GRID: '1' }).VLM_ORACLE_GRID).toBe(1);
    expect(buildConfigSnapshot({ VLM_ORACLE_GRID: '0' }).VLM_ORACLE_GRID).toBe(0);
    expect(buildConfigSnapshot({ VLM_ORACLE_GRID: '9' }).VLM_ORACLE_GRID).toBe(2);
    const snapshot = buildConfigSnapshot({ VLM_ORACLE_GRID: '0' });
    expect(configSnapshotToEnvPatch(snapshot).VLM_ORACLE_GRID).toBe('0');
  });

  it('frame budgets memakai floor 20 & parse number (bukan NaN)', () => {
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: '300' }).SAMPLE_MAX_FRAMES).toBe(300);
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: '5' }).SAMPLE_MAX_FRAMES).toBe(20); // floor
    expect(buildConfigSnapshot({ SAMPLE_MAX_FRAMES: 'abc' }).SAMPLE_MAX_FRAMES).toBe(500); // NaN -> default
    expect(buildConfigSnapshot({ GK_MAX_BATCH_FRAMES: '480' }).GK_MAX_BATCH_FRAMES).toBe(480);
    expect(buildConfigSnapshot({ GK_MAX_BATCH_FRAMES: '10' }).GK_MAX_BATCH_FRAMES).toBe(20);
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

  it('flag rute teks-lokal (Keputusan A) beku + round-trip; default MATI (regresi pitfall "true" literal)', () => {
    // Default produksi hari ini: seleksi/storyboard lokal MATI, timeout 120s,
    // model/base URL string kosong. (Eskalasi repair Gemini sudah DIHAPUS — Opsi B.)
    const off = buildConfigSnapshot({});
    expect(off.USE_LOCAL_SELECTION).toBe(false);
    expect(off.USE_LOCAL_STORYBOARD).toBe(false);
    expect(off.LOCAL_LLM_TIMEOUT_SEC).toBe(120);
    expect(off.LOCAL_TEXT_MODEL).toBe('');
    expect(off.LOCAL_LLM_BASE_URL).toBe('');
    // Helper konsumen menerima '1' DAN 'true' -> serialisasi kanonik safety-net ('1'/'0') aman.
    expect(buildConfigSnapshot({ USE_LOCAL_SELECTION: '1' }).USE_LOCAL_SELECTION).toBe(true);
    expect(buildConfigSnapshot({ USE_LOCAL_SELECTION: 'true' }).USE_LOCAL_SELECTION).toBe(true);
    expect(buildConfigSnapshot({ USE_LOCAL_STORYBOARD: 'TRUE' }).USE_LOCAL_STORYBOARD).toBe(true);
    expect(buildConfigSnapshot({ LOCAL_LLM_TIMEOUT_SEC: '2' }).LOCAL_LLM_TIMEOUT_SEC).toBe(5); // floor
    // Round-trip patch<->normalizer: retry wajib mereproduksi nilai efektif yang sama,
    // termasuk saat nilai TIDAK default (boolean beku ditulis '1'/'0', bukan 'true').
    const on = buildConfigSnapshot({
      USE_LOCAL_SELECTION: '1',
      USE_LOCAL_STORYBOARD: 'true',
      LOCAL_TEXT_MODEL: 'qwen2.5-vl-3b-q4',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
      LOCAL_LLM_TIMEOUT_SEC: '30',
    });
    const patch = configSnapshotToEnvPatch(on);
    expect(patch.USE_LOCAL_SELECTION).toBe('1');
    expect(patch.USE_LOCAL_STORYBOARD).toBe('1');
    expect(patch.LOCAL_TEXT_MODEL).toBe('qwen2.5-vl-3b-q4');
    const resnap = buildConfigSnapshot({ USE_LOCAL_SELECTION: '0', USE_LOCAL_STORYBOARD: '0', ...patch });
    for (const k of ['USE_LOCAL_SELECTION', 'USE_LOCAL_STORYBOARD', 'LOCAL_TEXT_MODEL', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_TIMEOUT_SEC']) {
      expect(resnap[k], `round-trip flag ${k}`).toEqual(on[k]);
    }
  });
});

describe('configSnapshotToEnvPatch — retry dapat mereproduksi setelan', () => {
  it('round-trip: patch env dari snapshot menghasilkan nilai efektif yang sama', () => {
    const originalEnv = {
      RENDER_DOWNLOAD_SECTIONS: '1',
      RENDER_NO_FULL_DOWNLOAD: '1',
      SAMPLE_MAX_FRAMES: '320',
      GK_MAX_BATCH_FRAMES: '300',
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
    // RENDER_DOWNLOAD_SECTIONS default-ON saat env kosong -> true -> patch '1'.
    expect(configSnapshotToEnvPatch(buildConfigSnapshot({})).RENDER_DOWNLOAD_SECTIONS).toBe('1');
    // Nilai false harus ditulis eksplisit ('0'), bukan dihilangkan, agar retry deterministik.
    const patch = configSnapshotToEnvPatch(buildConfigSnapshot({ RENDER_DOWNLOAD_SECTIONS: '0' }));
    expect(patch.RENDER_DOWNLOAD_SECTIONS).toBe('0');
    expect(patch.FINAL_AI_QC).toBe('true'); // default aktif
  });

  it('regresi review 2026-10-05: SETIAP flag beku masuk env patch (safety-net per tipe)', () => {
    // Dulu 5 flag (EVIDENCE_MIN_FRAMES_PER_SOURCE, RENDER_SAMPLE_INTERVAL_SEC,
    // ORACLE_AUTO_LAUNCH + WAIT_SEC + COOLDOWN_MIN) tidak punya aturan eksplisit dan
    // hilang diam-diam saat retry. Safety-net wajib menutupi semua FLAG_NORMALIZERS.
    const snap = buildConfigSnapshot({
      EVIDENCE_MIN_FRAMES_PER_SOURCE: '4',
      RENDER_SAMPLE_INTERVAL_SEC: '2.5',
      ORACLE_AUTO_LAUNCH: '1',
      ORACLE_AUTO_LAUNCH_WAIT_SEC: '120',
      ORACLE_AUTO_LAUNCH_COOLDOWN_MIN: '3',
    });
    const patch = configSnapshotToEnvPatch(snap);
    for (const k of SNAPSHOT_FLAG_KEYS) {
      if (typeof snap[k] === 'string' && snap[k] === '') continue; // string kosong emang tidak ditulis
      expect(k in patch, `snapshot key ${k} hilang dari env patch`).toBe(true);
    }
  });

  it('5 flag yang dulu hilang kini round-trip dengan nilai TIDAK default', () => {
    const snap = buildConfigSnapshot({
      EVIDENCE_MIN_FRAMES_PER_SOURCE: '4',
      RENDER_SAMPLE_INTERVAL_SEC: '2.5',
      ORACLE_AUTO_LAUNCH: '1',
      ORACLE_AUTO_LAUNCH_WAIT_SEC: '120',
      ORACLE_AUTO_LAUNCH_COOLDOWN_MIN: '3',
    });
    const patch = configSnapshotToEnvPatch(snap);
    expect(patch.EVIDENCE_MIN_FRAMES_PER_SOURCE).toBe('4');
    expect(patch.RENDER_SAMPLE_INTERVAL_SEC).toBe('2.5');
    expect(patch.ORACLE_AUTO_LAUNCH).toBe('1');
    expect(patch.ORACLE_AUTO_LAUNCH_WAIT_SEC).toBe('120');
    expect(patch.ORACLE_AUTO_LAUNCH_COOLDOWN_MIN).toBe('3');
    const resnap = buildConfigSnapshot({ ...patch });
    expect(resnap.EVIDENCE_MIN_FRAMES_PER_SOURCE).toBe(4);
    expect(resnap.RENDER_SAMPLE_INTERVAL_SEC).toBe(2.5);
    expect(resnap.ORACLE_AUTO_LAUNCH).toBe(true);
    expect(resnap.ORACLE_AUTO_LAUNCH_WAIT_SEC).toBe(120);
    expect(resnap.ORACLE_AUTO_LAUNCH_COOLDOWN_MIN).toBe(3);
  });
});

describe('applyConfigSnapshot — jalur retry auto (regresi fix 2026-10-05)', () => {
  // Dulu applyConfigSnapshot menulis String(boolean) -> 'true'/'false' yang justru
  // MEMBALIKKAN flag yang dibaca `=== '1'` / `!== '0'`. Tes ini memakai process.env
  // sungguhan (bukan objek sintetis) supaya bug serialisasi tidak bisa sembunyi lagi.
  const TOUCHED_KEYS = [...SNAPSHOT_FLAG_KEYS, 'niche', 'sourcePolicy', '_frozenAt'];
  const withSavedEnv = (fn) => {
    const saved = {};
    for (const k of TOUCHED_KEYS) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    try { return fn(); } finally {
      for (const k of TOUCHED_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it('boolean beku ditulis sebagai nilai kanonik konsumen (true -> "1", false -> "0")', () => {
    withSavedEnv(() => {
      const snap = buildConfigSnapshot({
        RENDER_DOWNLOAD_SECTIONS: '1',
        RENDER_NO_FULL_DOWNLOAD: '1',
        RENDER_VIDEO_ONLY: '0',
        PREFLIGHT_ORACLE: '0',
      }, { niche: 'gadget_smartphone' });
      // env saat ini "bergeser" — retry wajib mengembalikannya ke nilai beku.
      process.env.RENDER_DOWNLOAD_SECTIONS = '0';
      process.env.RENDER_VIDEO_ONLY = '1';
      process.env.PREFLIGHT_ORACLE = '1';
      applyConfigSnapshot(snap);
      expect(process.env.RENDER_DOWNLOAD_SECTIONS).toBe('1');   // BUKAN 'true'
      expect(process.env.RENDER_NO_FULL_DOWNLOAD).toBe('1');
      expect(process.env.RENDER_VIDEO_ONLY).toBe('0');           // 'false' akan berarti ON
      expect(isOraclePreflightEnabled(process.env)).toBe(false); // PREFLIGHT_ORACLE beku mati
    });
  });

  it('key non-flag (niche/sourcePolicy/_frozenAt) TIDAK bocor ke process.env', () => {
    withSavedEnv(() => {
      const snap = buildConfigSnapshot({}, { niche: 'gadget_smartphone', sourcePolicy: 'explicit_only' });
      applyConfigSnapshot(snap);
      expect(process.env.niche).toBeUndefined();
      expect(process.env.sourcePolicy).toBeUndefined();
      expect(process.env._frozenAt).toBeUndefined();
    });
  });

  it('round-trip terhadap process.env sungguhan: snapshot setelah apply == snapshot asal', () => {
    withSavedEnv(() => {
      const snap = buildConfigSnapshot({
        RENDER_DOWNLOAD_SECTIONS: '1',
          SAMPLE_MAX_FRAMES: '320',
        GK_MAX_BATCH_FRAMES: '300',
        FINAL_AI_QC: 'false',
        VLM_ORACLE_BATCH_SIZE: '8',
      });
      // Kosongkan dulu seperti mesin yang .env-nya sudah berubah total.
      for (const k of SNAPSHOT_FLAG_KEYS) delete process.env[k];
      applyConfigSnapshot(snap);
      const resnap = buildConfigSnapshot(process.env);
      for (const k of SNAPSHOT_FLAG_KEYS) {
        expect(resnap[k], `flag ${k} harus identik setelah apply`).toEqual(snap[k]);
      }
    });
  });

  it('auto-launch yang dibekukan OFF tetap OFF setelah apply — tidak ikut env operator (=1)', () => {
    // Regresi review 2026-10-05: ORACLE_AUTO_LAUNCH dulu hilang dari patch, sehingga
    // retry job lama bisa menyalakan GPU Kaggle yang sedang tidak diinginkan.
    withSavedEnv(() => {
      const snap = buildConfigSnapshot({ ORACLE_AUTO_LAUNCH: '0' });
      process.env.ORACLE_AUTO_LAUNCH = '1'; // operator menyalakan AFTER job dibuat
      applyConfigSnapshot(snap);
      expect(process.env.ORACLE_AUTO_LAUNCH).toBe('0');
    });
  });

  it('snapshot tidak valid -> tidak menulis apa pun (tidak melempar)', () => {
    withSavedEnv(() => {
      const before = process.env.RENDER_DOWNLOAD_SECTIONS;
      applyConfigSnapshot(null);
      applyConfigSnapshot(undefined);
      applyConfigSnapshot('bukan-objek');
      expect(process.env.RENDER_DOWNLOAD_SECTIONS).toBe(before);
    });
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
