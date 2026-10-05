import os
f = 'server/store/jobStore.js'
c = open(f, encoding='utf-8').read()

old = '''  if (attempt !== undefined && b.attempts !== undefined && attempt !== b.attempts) {
    return { ok: false, status: 'attempt_mismatch', error: 'Result dari attempt yang sudah kadaluarsa.' };
  }

  const b = getOracleBatch(batchId);
  if (!b) return { ok: false, status: 'unknown' };'''
new_str = '''  if (attempt !== undefined && b.attempts !== undefined && attempt !== b.attempts) {
    return { ok: false, status: 'attempt_mismatch', error: 'Result dari attempt yang sudah kadaluarsa.' };
  }'''

c = c.replace(old, new_str)
open(f, 'w', encoding='utf-8').write(c)
print('Fixed syntax error')
