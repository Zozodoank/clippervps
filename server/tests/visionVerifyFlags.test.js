import { describe, it, expect } from 'vitest';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  isVlmOracleEnabled,
  SNAPSHOT_FLAG_KEYS,
} from '../config/runtimeFlags.js';

// Kunci perilaku flag gerbang verifikasi visual.
// PRINSIP UTAMA (mandate 2026-10): VISION_VERIFY_MODE default = 'oracle', yaitu
// Oracle lokal Qwen (VPS) sebagai satu-satunya pemutus visual (dijaga gerbang
// stage1Render). Era SmolVLM2 + scene-discovery Gemini lokal sudah DIHAPUS dari
// runtime: helper isSmolvlmVerifyEnabled / isGeminiSceneDiscoveryEnabled dan flag
// GEMINI_SCENE_DISCOVERY tidak ada lagi di production, jadi tes ini tidak boleh
// berpura-pura mereka masih ada (lihat it() warisan di bawah).

describe('VISION_VERIFY_MODE — default oracle (Oracle lokal Qwen VPS, mandate 2026-10)', () => {
  it('env kosong / nilai apa pun selain legacy/smolvlm -> oracle', () => {
    expect(buildConfigSnapshot({}).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'SmolVLM ' }).VISION_VERIFY_MODE).toBe('smolvlm'); // trim+lowercase
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'onnx' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: '1' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'legacy' }).VISION_VERIFY_MODE).toBe('legacy'); // dikenali, ditolak gerbang pipeline
  });

  it('warisan era SmolVLM: hanya isVlmOracleEnabled yang tersisa, mode lama ditolak gerbang', () => {
    // Gerbang pipeline menolak mode lama lewat normalizer VISION_VERIFY_MODE + helper
    // isVlmOracleEnabled (runtimeFlags.js:291-294), bukan lewat helper khusus smolvlm.
    expect(isVlmOracleEnabled({})).toBe(true);                                 // default oracle
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'legacy' })).toBe(false);  // dikenali, ditolak
    expect(isVlmOracleEnabled({ VISION_VERIFY_MODE: 'smolvlm' })).toBe(false); // dikenali, ditolak
    // Flag scene-discovery era lama tidak boleh diam-diam kembali ke snapshot: tidak ada
    // satu pun konsumen produksi yang membacanya.
    expect(SNAPSHOT_FLAG_KEYS).not.toContain('GEMINI_SCENE_DISCOVERY');
  });
});

describe('SCENE_CLIP_DURATION_SEC — clamp 2..5, default 4', () => {
  it('default 4 utk kosong/NaN/<=0', () => {
    expect(buildConfigSnapshot({}).SCENE_CLIP_DURATION_SEC).toBe(4);
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: 'abc' }).SCENE_CLIP_DURATION_SEC).toBe(4);
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: '0' }).SCENE_CLIP_DURATION_SEC).toBe(4);
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: '-3' }).SCENE_CLIP_DURATION_SEC).toBe(4);
  });

  it('clamp ke rentang aman 2-5', () => {
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: '1' }).SCENE_CLIP_DURATION_SEC).toBe(2);
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: '3' }).SCENE_CLIP_DURATION_SEC).toBe(3);
    expect(buildConfigSnapshot({ SCENE_CLIP_DURATION_SEC: '9' }).SCENE_CLIP_DURATION_SEC).toBe(5);
  });
});

describe('SCENE_SAMPLE_FPS & GK_VLM_TIMEOUT_SEC_PER_FRAME — floor', () => {
  it('SCENE_SAMPLE_FPS default 1, floor 0.5', () => {
    expect(buildConfigSnapshot({}).SCENE_SAMPLE_FPS).toBe(1);
    expect(buildConfigSnapshot({ SCENE_SAMPLE_FPS: '0.2' }).SCENE_SAMPLE_FPS).toBe(0.5);
    expect(buildConfigSnapshot({ SCENE_SAMPLE_FPS: '2' }).SCENE_SAMPLE_FPS).toBe(2);
  });

  it('GK_VLM_TIMEOUT_SEC_PER_FRAME default 10; "0" dianggap unset (falsy) -> 10', () => {
    expect(buildConfigSnapshot({}).GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(10);
    // pola `Number(x) || 10`: '0' -> 0 (falsy) -> default 10, BUKAN floor. Konsisten
    // dgn normalizer frame-budget lain (SAMPLE_MAX_FRAMES dll).
    expect(buildConfigSnapshot({ GK_VLM_TIMEOUT_SEC_PER_FRAME: '0' }).GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(10);
    expect(buildConfigSnapshot({ GK_VLM_TIMEOUT_SEC_PER_FRAME: '25' }).GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(25);
    // floor 1 hanya utk pecahan 0<v<1
    expect(buildConfigSnapshot({ GK_VLM_TIMEOUT_SEC_PER_FRAME: '0.5' }).GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(1);
  });
});

describe('Snapshot mode verifikasi visual round-trip — retry mengunci mode yang sama', () => {
  it('mode beku + anggaran scene bertahan setelah env operator berubah', () => {
    const createEnv = {
      VISION_VERIFY_MODE: 'smolvlm',
      SCENE_CLIP_DURATION_SEC: '5',
      SCENE_SAMPLE_FPS: '2',
      GK_VLM_TIMEOUT_SEC_PER_FRAME: '15',
    };
    const snap = buildConfigSnapshot(createEnv);
    // Operator mengembalikan .env ke legacy sebelum retry.
    const driftedEnv = { VISION_VERIFY_MODE: 'legacy' };
    const applied = { ...driftedEnv, ...configSnapshotToEnvPatch(snap) };
    const resnap = buildConfigSnapshot(applied);
    expect(resnap.VISION_VERIFY_MODE).toBe('smolvlm');
    expect(resnap.SCENE_CLIP_DURATION_SEC).toBe(5);
    expect(resnap.SCENE_SAMPLE_FPS).toBe(2);
    expect(resnap.GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(15);
    // Konsumen membaca dari env hasil-patch -> tetap mode lama yang ditolak gerbang,
    // BUKAN senyap-senyap kembali ke oracle.
    expect(isVlmOracleEnabled(applied)).toBe(false);
  });

  it('patch default (oracle) menulis oracle, bukan string kosong', () => {
    const patch = configSnapshotToEnvPatch(buildConfigSnapshot({}));
    expect(patch.VISION_VERIFY_MODE).toBe('oracle');
    expect(patch.SCENE_CLIP_DURATION_SEC).toBe('4');
    expect(patch.SCENE_SAMPLE_FPS).toBe('1');
    expect(patch.GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe('10');
  });
});
