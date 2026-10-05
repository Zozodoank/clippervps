import os
f = 'server/api/routes/vlmOracleRoutes.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    'batchId: batch.id,',
    'batchId: batch.id,\n    attempt: batch.attempts,'
)

old_res = "const { batchId, verdict, error } = req.body || {};"
new_res = """const { batchId, attempt, workerId, protocolVersion, verdict, error } = req.body || {};
  const expectedProtocol = '2026-10-05-v1';
  
  if (protocolVersion !== expectedProtocol) {
    recordAuditEvent({ req, action: 'vlm-oracle-result-rejected', detail: atch= reason=protocol_mismatch expected= got= });
    return res.status(426).json({ success: false, error: 'Protocol version mismatch. Kaggle worker obsolete.' });
  }

  // Observability Log Server
  const vType = typeof verdict;
  const vKeys = verdict && vType === 'object' && !Array.isArray(verdict) ? Object.keys(verdict).join(',') : '';
  logger.log([Oracle Result] batchId= workerId= attempt= protocolVersion= verdictType= verdictKeys= httpStatus=200);
"""
c = c.replace(old_res, new_res)

# We also need to check attempt/workerId matching. Wait, submitOracleResult doesn't take workerId/attempt!
# Let's pass it to submitOracleResult.
c = c.replace(
    "const out = submitOracleResult({ batchId: batchId.slice(0, 120), verdict, lastError: error || '' });",
    "const out = submitOracleResult({ batchId: batchId.slice(0, 120), verdict, lastError: error || '', attempt, workerId });"
)
open(f, 'w', encoding='utf-8').write(c)
print('Patched routes')
