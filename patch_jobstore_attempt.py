import os
f = 'server/store/jobStore.js'
c = open(f, encoding='utf-8').read()

old_submit = 'export function submitOracleResult({ batchId, verdict, lastError = \'\', now = Date.now() } = {}) {'
new_submit = '''export function submitOracleResult({ batchId, verdict, lastError = '', attempt, workerId, now = Date.now() } = {}) {
  const b = getOracleBatch(batchId);
  if (!b) return { ok: false, status: 'unknown' };
  
  if (workerId && b.workerId && b.workerId !== workerId) {
    return { ok: false, status: 'worker_mismatch', error: 'Result dari worker yang berbeda.' };
  }
  if (attempt !== undefined && b.attempts !== undefined && attempt !== b.attempts) {
    return { ok: false, status: 'attempt_mismatch', error: 'Result dari attempt yang sudah kadaluarsa.' };
  }
'''
c = c.replace(old_submit, new_submit)
c = c.replace('if (!out.ok && out.status === \'unknown\') {', 'if (!out.ok && (out.status === \'worker_mismatch\' || out.status === \'attempt_mismatch\')) { return res.status(409).json({ success: false, status: out.status, error: out.error }); }\n  if (!out.ok && out.status === \'unknown\') {')
open(f, 'w', encoding='utf-8').write(c)

# We also need to patch routes again for the error handling above
routes_f = 'server/api/routes/vlmOracleRoutes.js'
r = open(routes_f, encoding='utf-8').read()
if 'worker_mismatch' not in r:
    r = r.replace("if (!out.ok && out.status === 'unknown') {", "if (!out.ok && (out.status === 'worker_mismatch' || out.status === 'attempt_mismatch')) { return res.status(409).json({ success: false, status: out.status, error: out.error }); }\n  if (!out.ok && out.status === 'unknown') {")
open(routes_f, 'w', encoding='utf-8').write(r)
print('Patched jobStore & routes for attempt mismatch')
