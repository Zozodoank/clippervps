import os
f = 'server/api/routes/vlmOracleRoutes.js'
c = open(f, encoding='utf-8').read()

old1 = "recordAuditEvent({ req, action: 'vlm-oracle-result-rejected', detail:  atch= reason=protocol_mismatch expected= got= });"
new1 = "recordAuditEvent({ req, action: 'vlm-oracle-result-rejected', detail: `batch=${batchId} reason=protocol_mismatch expected=${expectedProtocol} got=${protocolVersion}` });"
c = c.replace(old1, new1)

old2 = "logger.log(`[Oracle Result] batchId= workerId= attempt= protocolVersion= verdictType= verdictKeys= httpStatus=200`);"
new2 = "logger.log(`[Oracle Result] batchId=${batchId} workerId=${workerId} attempt=${attempt} protocolVersion=${protocolVersion} verdictType=${vType} verdictKeys=${vKeys} httpStatus=200`);"
c = c.replace(old2, new2)

open(f, 'w', encoding='utf-8').write(c)
print('Fixed powershell interpolation bugs')
