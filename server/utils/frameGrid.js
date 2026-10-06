/** Pure grouping for Oracle contact sheets. Frame identity stays with each cell. */
export function planGrids(frames = [], cellsPerGrid = 4) {
  const list = Array.isArray(frames) ? frames.filter(Boolean) : [];
  const capacity = Math.max(1, Math.floor(Number(cellsPerGrid) || 4));
  const grids = [];
  for (let offset = 0; offset < list.length; offset += capacity) {
    const group = list.slice(offset, offset + capacity);
    grids.push({
      index: grids.length,
      frames: group,
      cells: group.map((frame, cell) => ({
        index: Number.isInteger(Number(frame.index)) ? Number(frame.index) : offset + cell,
        sceneIdx: frame.sceneIdx ?? null,
        timestampMs: frame.timestampMs ?? null,
        cell,
      })),
    });
  }
  return grids;
}

/** Strictly bind per-cell verdicts to the expected source frame IDs. */
export function mapGridVerdictToFrames(verdict, frames = []) {
  const expected = Array.isArray(frames) ? frames : [];
  const ids = expected.map((frame, i) => Number.isInteger(Number(frame.index)) ? Number(frame.index) : i);
  const allowed = new Set(ids);
  const entries = Array.isArray(verdict?.perFrame) ? verdict.perFrame : [];
  const byId = new Map();
  for (const entry of entries) {
    const id = Number(entry?.index);
    if (Number.isInteger(id) && allowed.has(id) && !byId.has(id)) byId.set(id, entry);
  }
  return {
    ...verdict,
    perFrame: ids.map((id, position) => byId.has(id) ? { ...byId.get(id), originalIndex: id, index: position } : {
      originalIndex: id, index: position, verified: false, safe: true,
      reason: 'Sel grid tanpa vonis Oracle; belum terverifikasi.',
    }),
    unknownCellIndexes: entries.map((entry) => Number(entry?.index))
      .filter((id) => !Number.isInteger(id) || !allowed.has(id)),
  };
}
