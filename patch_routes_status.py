import os
f = 'server/api/routes/vlmOracleRoutes.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    "const workerId = String((req.body && req.body.workerId) || req.headers['x-oracle-worker'] || 'kaggle').slice(0, 120);\n  // HEARTBEAT:",
    "const workerId = String((req.body && req.body.workerId) || req.headers['x-oracle-worker'] || 'kaggle').slice(0, 120);\n  const protocolVersion = String((req.body && req.body.protocolVersion) || '');\n  const sourceHash = String((req.body && req.body.sourceHash) || '');\n  // HEARTBEAT:"
)
c = c.replace(
    "touchOracleHeartbeat(workerId);",
    "touchOracleHeartbeat(workerId, protocolVersion, sourceHash);"
)

c = c.replace(
    'import {',
    'import {\n  oracleHeartbeatInfo,'
)

c = c.replace(
    "lastSeenAgeMs: lastSeenAt ? Date.now() - lastSeenAt : null,",
    "lastSeenAgeMs: lastSeenAt ? Date.now() - lastSeenAt : null,\n      workerInfo: oracleHeartbeatInfo(),"
)

open(f, 'w', encoding='utf-8').write(c)
print('Patched routes status')
