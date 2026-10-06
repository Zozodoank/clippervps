import { describe, it, expect } from 'vitest';
import { buildConfigSnapshot, configSnapshotToEnvPatch, buildOracleCalibrationMeta, isOracleOfflineCalibration, localGatekeeperVetoMode } from '../config/runtimeFlags.js';
import { assertOracleConnected, resolveOracleConfig } from '../services/vlmOracleService.js';

describe('mode kalibrasi oracle offline', () => {
  it('default mati dan gate normal tetap membutuhkan Kaggle', () => {
    expect(isOracleOfflineCalibration({})).toBe(false);
    expect(resolveOracleConfig({}).enabled).toBe(true);
    expect(assertOracleConnected({ logger: {}, env: { VISION_VERIFY_MODE: 'oracle' } }).ok).toBe(false);
  });

  it('melewati pemeriksaan Kaggle hanya dengan sakelar eksplisit dan memaksa strict lokal', () => {
    const env = { ORACLE_OFFLINE_CALIBRATION: '1', GK_LOCAL_VETO: 'advisory' };
    expect(resolveOracleConfig(env).enabled).toBe(false);
    expect(assertOracleConnected({ logger: {}, env })).toMatchObject({ ok: true, detail: 'offline_calibration' });
    expect(localGatekeeperVetoMode(env)).toBe('strict');
    expect(buildOracleCalibrationMeta(env, new Date('2026-10-06T00:00:00.000Z'))).toMatchObject({
      enabled: true, gatekeeperBackend: 'local-strict', productionEligible: false,
    });
  });

  it('membekukan sakelar dan pilihan grid pada snapshot job untuk retry', () => {
    const snapshot = buildConfigSnapshot({ ORACLE_OFFLINE_CALIBRATION: '1', VLM_ORACLE_GRID: '0' });
    const patch = configSnapshotToEnvPatch(snapshot);
    expect(snapshot.ORACLE_OFFLINE_CALIBRATION).toBe(true);
    expect(snapshot.VLM_ORACLE_GRID).toBe(0);
    expect(patch.ORACLE_OFFLINE_CALIBRATION).toBe('1');
    expect(patch.VLM_ORACLE_GRID).toBe('0');
  });
});
