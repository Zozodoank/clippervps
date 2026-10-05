import os
f = 'server/tests/vlmOracle.test.js'
c = open(f, encoding='utf-8').read()

new_test = '''
  it('verdict string JSON valid dapat dinormalisasi (compatibility parser)', () => {
    const v = normalizeOracleVerdict('{"safe":false,"perFrame":[{"index":0,"safe":false}]}', { expectedFrames: 1 });
    expect(v.ok).toBe(true);
    expect(v.vetoTriggered).toBe(true);
    expect(v.dirtyFrameIndexes).toEqual([0]);
  });

  it('verdict string prosa ditolak (jangan jadi verdict valid)', () => {
    const v = normalizeOracleVerdict('klip terlihat bersih', { expectedFrames: 1 });
    expect(v.ok).toBe(false);
    expect(v.infraError).toBe(true);
  });
'''
if 'verdict string JSON valid dapat dinormalisasi' not in c:
    c = c.replace(
        "it('mengerti bentuk agregat dan bentuk per-frame', () => {",
        new_test + "\n  it('mengerti bentuk agregat dan bentuk per-frame', () => {"
    )

open(f, 'w', encoding='utf-8').write(c)
print('Patched compat test')
