const fs = require('fs');
let c = fs.readFileSync('server/api/routes/vlmOracleRoutes.js', 'utf8');
c = c.replace(
  "logger.log([Oracle Result] batchId= workerId= attempt= protocolVersion= verdictType= verdictKeys= httpStatus=200);",
  "logger.log(\[Oracle Result] batchId=\ workerId=\ attempt=\ protocolVersion=\ verdictType=\ verdictKeys=\ httpStatus=200\);"
);
fs.writeFileSync('server/api/routes/vlmOracleRoutes.js', c);
