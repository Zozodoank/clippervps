import re
f = 'server/api/routes/vlmOracleRoutes.js'
c = open(f, encoding='utf-8').read()

c = re.sub(
    r'recordAuditEvent\(\{ req, action: \'vlm-oracle-result-rejected\', detail: .*?\}\);',
    'recordAuditEvent({ req, action: "vlm-oracle-result-rejected", detail: `batch=${batchId} reason=protocol_mismatch expected=${expectedProtocol} got=${protocolVersion}` });',
    c
)

c = re.sub(
    r'logger\.log\(`\[Oracle Result\] batchId=.*?`\);',
    'logger.log(`[Oracle Result] batchId=${batchId} workerId=${workerId} attempt=${attempt} protocolVersion=${protocolVersion} verdictType=${vType} verdictKeys=${vKeys} httpStatus=200`);',
    c
)

open(f, 'w', encoding='utf-8').write(c)
print('Fixed successfully')
