import os
f = 'server/store/jobStore.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    'let oracleHeartbeatTs = 0;\nexport function touchOracleHeartbeat(workerId) {\n  oracleHeartbeatTs = Date.now();\n}',
    'let oracleHeartbeat = { ts: 0, workerId: "", protocolVersion: "", sourceHash: "" };\nexport function touchOracleHeartbeat(workerId, protocolVersion = "", sourceHash = "") {\n  oracleHeartbeat = { ts: Date.now(), workerId, protocolVersion, sourceHash };\n}'
)
c = c.replace(
    'export function oracleLastSeenMs() {\n  return oracleHeartbeatTs;\n}',
    'export function oracleLastSeenMs() {\n  return oracleHeartbeat.ts;\n}\nexport function oracleHeartbeatInfo() {\n  return oracleHeartbeat;\n}'
)
open(f, 'w', encoding='utf-8').write(c)
print('Patched heartbeat state')
