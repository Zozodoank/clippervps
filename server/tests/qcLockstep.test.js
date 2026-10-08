import { describe, it, expect } from 'vitest';
import { auditSceneVoLockstep } from '../services/finalMasterQcService.js';

function seg(over = {}) {
  return {
    slot: 1,
    slotKey: 'clip1_full_product',
    facePolicy: 'strict',
    timeStart: 0,
    duration: 3,
    voLine: 'VO pendek',
    visualClaim: 'Klaim visual jelas',
    ...over,
  };
}

describe('Face Policy (Fase 6) - auditSceneVoLockstep di Final QC', () => {
  it('kitchen / niche tanpa strictSceneVoSync selalu PASS walau segments kosong', () => {
    expect(auditSceneVoLockstep({ niche: 'kitchen_tools' })).toMatchObject({ passed: true, skipped: true });
    expect(auditSceneVoLockstep({ niche: 'kitchen_tools', segments: [], alignment: { ok: false, errors: ['x'] } }).passed).toBe(true);
    expect(auditSceneVoLockstep({ niche: 'niche_gaada', segments: null }).passed).toBe(true);
  });

  it('gadget strict tanpa segment plan sama sekali menjadi FAIL (fail-closed)', () => {
    const res = auditSceneVoLockstep({ niche: 'gadget_smartphone' });
    expect(res.passed).toBe(false);
    expect(res.issues).toContain('scene_vo_segments_kosong');
  });

  it('gadget strict dengan plan lengkap termasuk slot presenter_only menjadi PASS', () => {
    const segments = [
      seg({ slot: 1, timeStart: 0, slotKey: 'clip1_screen_review' }),
      seg({ slot: 2, timeStart: 6, slotKey: 'clip2_screen_detail' }),
      seg({ slot: 3, timeStart: 12, slotKey: 'clip3_feature_review' }),
      seg({ slot: 4, timeStart: 18, slotKey: 'clip4_feature_detail' }),
      seg({ slot: 5, timeStart: 24, slotKey: 'clip5_memory_capacity' }),
      seg({ slot: 6, timeStart: 30, slotKey: 'clip6_memory_detail' }),
      seg({ slot: 7, timeStart: 36, slotKey: 'clip7_camera_sample', facePolicy: 'presenter_only' }),
      seg({ slot: 8, timeStart: 42, slotKey: 'clip8_camera_detail', facePolicy: 'presenter_only' }),
    ];
    const res = auditSceneVoLockstep({ niche: 'gadget_smartphone', segments, alignment: { ok: true, errors: [] } });
    expect(res.passed).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('slot strict tanpa visualClaim menjadi FAIL (adegan tak bisa diverifikasi vs VO)', () => {
    const segments = [
      seg(),
      seg({ slot: 7, slotKey: 'clip7_camera_sample', facePolicy: 'presenter_only', visualClaim: '' }),
    ];
    const res = auditSceneVoLockstep({ niche: 'gadget_smartphone', segments });
    expect(res.passed).toBe(false);
    expect(res.issues).toContain('segment_tanpa_visual_claim');
  });

  it('slot presenter_only tanpa visualClaim juga FAIL (semua adegan wajib terverifikasi)', () => {
    const segments = [
      seg({ slot: 4, slotKey: 'clip4_action_demo_diff' }),
      seg({ slot: 7, slotKey: 'clip7_camera_sample', facePolicy: 'presenter_only', visualClaim: '   ' }),
    ];
    const res = auditSceneVoLockstep({ niche: 'gadget_smartphone', segments });
    expect(res.passed).toBe(false);
    expect(res.issues).toContain('segment_tanpa_visual_claim');
  });

  it('alignment report ok=false diterjemahkan jadi issue QC', () => {
    const segments = [seg(), seg({ slot: 7, slotKey: 'clip7_camera_sample', facePolicy: 'presenter_only' })];
    const res = auditSceneVoLockstep({
      niche: 'gadget_smartphone',
      segments,
      alignment: { ok: false, errors: ['Klip slot #2 bersumber dari frame camera-eligible padahal policy strict.'] },
    });
    expect(res.passed).toBe(false);
    expect(res.issues.some(i => i.startsWith('alignment_error:') && i.includes('camera-eligible'))).toBe(true);
  });

  it('segment plan tanpa slot kamera presenter_only menjadi FAIL', () => {
    const segments = [seg(), seg({ slot: 2 })];
    const res = auditSceneVoLockstep({ niche: 'gadget_smartphone', segments });
    expect(res.passed).toBe(false);
    expect(res.issues).toContain('slot_presenter_only_hilang_dari_segment_plan');
  });
});
