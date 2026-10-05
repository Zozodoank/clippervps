import os
f = 'server/api/routes/vlmOracleRoutes.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    'logger.log([Oracle Result] batchId=',
    'logger.log([Oracle Result] status= batchId='
)
open(f, 'w', encoding='utf-8').write(c)
print('Patched routes log to include status')
