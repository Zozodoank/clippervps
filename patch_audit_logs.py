import os
f = 'server/services/vlmOracleService.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    'logger.log([Oracle] ?  ditolak model besar',
    'logger.log([Oracle] ? batchId=  ditolak model besar'
)
c = c.replace(
    'logger.log([Oracle] ?  bersih',
    'logger.log([Oracle] ? batchId=  bersih'
)

# And also for invalid verdict (thrown or warned)
c = c.replace(
    'logger.warn([Oracle] Vonis  tidak sah ()',
    'logger.warn([Oracle] batchId= Vonis  tidak sah ()'
)
open(f, 'w', encoding='utf-8').write(c)
print('Patched audit logs in vlmOracleService.js')
