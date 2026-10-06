import { describe, it, expect } from 'vitest';
import { planGrids, mapGridVerdictToFrames } from '../utils/frameGrid.js';
import { normalizeGridVerdict } from '../services/vlmOracleService.js';

describe('Oracle 2x2 grid mapping', () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({ index: index + 10, timestampMs: index * 1000, filePath: `frame-${index}.jpg` }));

  it('groups in row-major fours and retains source identity/timestamps', () => {
    const grids = planGrids(frames, 4);
    expect(grids).toHaveLength(2);
    expect(grids[0].cells.map((cell) => cell.index)).toEqual([10, 11, 12, 13]);
    expect(grids[1].cells).toEqual([{ index: 14, sceneIdx: null, timestampMs: 4000, cell: 0 }]);
  });

  it('distributes verdicts by source index rather than response order', () => {
    const mapped = mapGridVerdictToFrames({ perFrame: [{ index: 11, safe: false }, { index: 10, safe: true }] }, frames.slice(0, 2));
    expect(mapped.perFrame.map((item) => item.index)).toEqual([0, 1]);
    expect(mapped.perFrame.map((item) => item.originalIndex)).toEqual([10, 11]);
  });

  it('treats missing cells and unknown indexes as invalid under strict semantics', () => {
    const missing = normalizeGridVerdict({ safe: true, perFrame: [{ index: 10, safe: true }] }, frames.slice(0, 2));
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/tidak mencakup seluruh sel/);
    const unknown = normalizeGridVerdict({ safe: true, perFrame: [{ index: 999, safe: true }] }, frames.slice(0, 1));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/index sel tak dikenal/);
  });

  it('maps clean and dirty cell verdicts to positional frame indexes', () => {
    const normalized = normalizeGridVerdict({ safe: false, perFrame: [
      { index: 10, safe: true }, { index: 11, safe: false, text: true },
    ] }, frames.slice(0, 2));
    expect(normalized.ok).toBe(true);
    expect(normalized.dirtyFrameIndexes).toEqual([1]);
  });
});
