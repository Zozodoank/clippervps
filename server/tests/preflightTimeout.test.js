import { describe, it, expect } from 'vitest';
import { resolvePreflightTimeoutMs } from '../services/videoFilterService.js';

// FIX 0/20 (B2): timeout ekstraksi frame pre-flight tidak lagi dipatok keras 90_000 yang
// sering jebol di Termux/ARM + googlevideo lambat. Kini default 120_000 dan configurable
// lewat env VLM_ORACLE_PREFLIGHT_TIMEOUT_MS, dengan clamp 30k..240k agar tidak pernah
// melewati deadline total job (clamp diverifikasi di pemanggil via env yang sama).
describe('resolvePreflightTimeoutMs (B2 - configurable preflight timeout)', () => {
  it('default 120000 ketika env tidak diset', () => {
    expect(resolvePreflightTimeoutMs({})).toBe(120_000);
    expect(resolvePreflightTimeoutMs()).toBe(120_000);
  });

  it('memakai nilai env ketika valid dan dalam rentang', () => {
    expect(resolvePreflightTimeoutMs({ VLM_ORACLE_PREFLIGHT_TIMEOUT_MS: '150000' })).toBe(150_000);
  });

  it('clamp ke bawah 30000 (mis. nilai terlalu kecil / 5000)', () => {
    expect(resolvePreflightTimeoutMs({ VLM_ORACLE_PREFLIGHT_TIMEOUT_MS: '5000' })).toBe(30_000);
    expect(resolvePreflightTimeoutMs({ VLM_ORACLE_PREFLIGHT_TIMEOUT_MS: '0' })).toBe(120_000);
  });

  it('clamp ke atas 240000 (nilai absurd tidak melewati deadline job)', () => {
    expect(resolvePreflightTimeoutMs({ VLM_ORACLE_PREFLIGHT_TIMEOUT_MS: '999999' })).toBe(240_000);
  });

  it('abaikan nilai non-numerik -> fallback default', () => {
    expect(resolvePreflightTimeoutMs({ VLM_ORACLE_PREFLIGHT_TIMEOUT_MS: 'abc' })).toBe(120_000);
  });
});
