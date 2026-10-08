import { describe, it, expect } from 'vitest';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  isSmolvlmVerifyEnabled,
  isGeminiSceneDiscoveryEnabled,
} from '../config/runtimeFlags.js';

// Tahap 8: kunci perilaku flag arsitektur Gemini-first + SmolVLM2.
// PRINSIP UTAMA (berubah mandate 2026-10): VISION_VERIFY_MODE default = 'oracle'
// (Kaggle-only, dijaga gerbang stage1Render); flag turunan smolvlm lainnya tetap
// OFF sampai operator mengaktifkan mode smolvlm secara eksplisit.

describe('VISION_VERIFY_MODE — default oracle (Kaggle-only, mandate 2026-10)', () => {
  it('env kosong / nilai apa pun selain legacy/smolvlm -> oracle', () => {
    expect(buildConfigSnapshot({}).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'SmolVLM ' }).VISION_VERIFY_MODE).toBe('smolvlm'); // trim+lowercase
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'onnx' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: '1' }).VISION_VERIFY_MODE).toBe('oracle');
    expect(buildConfigSnapshot({ VISION_VERIFY_MODE: 'legacy' }).VISION_VERIFY_MODE).toBe('legacy'); // dikenali, ditolak gerbang pipeline
  });

  it('helper isSmolvlmVerifyEnabled hanya true utk smolvlm', () => {
    expect(isSmolvlmVerifyEnabled({})).toBe(false);
    expect(isSmolvlmVerifyEnabled({ VISION_VERIFY_MODE: 'legacy' })).toBe(false);
    expect(isSmolvlmVerifyEnabled({ VISION_VERIFY_MODE: 'smolvlm' })).toBe(true);
  });
});

describe('GEMINI_SCENE_DISCOVERY — default OFF', () => {
  it('aktif hanya utk "1"/true', () => {
    expect(buildConfigSnapshot({}).GEMINI_SCENE_DISCOVERY).toBe(false);
    expect(buildConfigSnapshot({ GEMINI_SCENE_DISCOVERY: '1' }).GEMINI_SCENE_DISCOVERY).toBe(true);
    expect(buildConfigSnapshot({ GEMINI_SCENE_DISCOVERY: 'TRUE ' }).GEMINI_SCENE_DISCOVERY).toBe(true);
    expect(buildConfigSnapshot({ GEMINI_SCENE_DISCOVERY: 'yes' }).GEMINI_SCENE_DISCOVERY).toBe(false);
  });

  it('helper isGeminiSceneDiscoveryEnabled konsisten dgn normalizer', () => {
    for (const v of ['1', 'true', 'TRUE', '0', 'yes', undefined]) {
      const env = { GEMINI_SCENE_DISCOVERY: v };
      expect(isGeminiSceneDiscoveryEnabled(env)).toBe(buildConfigSnapshot(env).GEMINI_SCENE_DISCOVERY);
    }
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

describe('Snapshot SmolVLM round-trip — retry mengunci mode yang sama', () => {
  it('mode smolvlm beku bertahan setelah env operator berubah', () => {
    const createEnv = {
      VISION_VERIFY_MODE: 'smolvlm',
      GEMINI_SCENE_DISCOVERY: '1',
      SCENE_CLIP_DURATION_SEC: '5',
      SCENE_SAMPLE_FPS: '2',
      GK_VLM_TIMEOUT_SEC_PER_FRAME: '15',
    };
    const snap = buildConfigSnapshot(createEnv);
    // Operator mengembalikan .env ke legacy sebelum retry.
    const driftedEnv = { VISION_VERIFY_MODE: 'legacy', GEMINI_SCENE_DISCOVERY: '0' };
    const applied = { ...driftedEnv, ...configSnapshotToEnvPatch(snap) };
    const resnap = buildConfigSnapshot(applied);
    expect(resnap.VISION_VERIFY_MODE).toBe('smolvlm');
    expect(resnap.GEMINI_SCENE_DISCOVERY).toBe(true);
    expect(resnap.SCENE_CLIP_DURATION_SEC).toBe(5);
    expect(resnap.SCENE_SAMPLE_FPS).toBe(2);
    expect(resnap.GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe(15);
    // konsumen helper membaca dari env hasil-patch -> tetap mode baru
    expect(isSmolvlmVerifyEnabled(applied)).toBe(true);
  });

  it('patch default (oracle) menulis oracle + bypass=false, bukan string kosong', () => {
    const patch = configSnapshotToEnvPatch(buildConfigSnapshot({}));
    expect(patch.VISION_VERIFY_MODE).toBe('oracle');
    expect(patch.GEMINI_SCENE_DISCOVERY).toBe('0');
    expect(patch.SCENE_CLIP_DURATION_SEC).toBe('4');
    expect(patch.SCENE_SAMPLE_FPS).toBe('1');
    expect(patch.GK_VLM_TIMEOUT_SEC_PER_FRAME).toBe('10');
  });
});
