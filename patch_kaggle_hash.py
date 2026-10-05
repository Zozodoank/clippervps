import os
import hashlib

f = 'kaggle/vlm_oracle_qwen.py'
c = open(f, encoding='utf-8').read()

hash_impl = '''
import hashlib
def get_source_hash():
    try:
        with open(__file__, "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()
    except Exception:
        return "unknown"
SOURCE_HASH = get_source_hash()
'''

if 'get_source_hash' not in c:
    c = c.replace('import json', 'import json' + hash_impl)

c = c.replace(
    'json={"workerId": "kaggle-notebook"},',
    'json={"workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION, "sourceHash": SOURCE_HASH},'
)

open(f, 'w', encoding='utf-8').write(c)
print('Patched kaggle claim payload')
