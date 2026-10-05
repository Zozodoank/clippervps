import os
f = 'kaggle/vlm_oracle_qwen.py'
c = open(f, encoding='utf-8').read()

c = c.replace('def post_result(batch_id, verdict=None, error=""):', 'def post_result(batch_id, attempt=0, verdict=None, error=""):')
c = c.replace('body = {"batchId": batch_id, "workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION}', 'body = {"batchId": batch_id, "attempt": attempt, "workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION}')

# Now replace post_result calls in main()
c = c.replace('post_result(bid, {"safe": True, "model": "dry-run"})', 'post_result(bid, attempt=data.get("attempt", 0), verdict={"safe": True, "model": "dry-run"})')
c = c.replace('post_result(bid, None, error=str(dl_err))', 'post_result(bid, attempt=data.get("attempt", 0), verdict=None, error=str(dl_err))')
c = c.replace('post_result(bid, v)', 'post_result(bid, attempt=data.get("attempt", 0), verdict=v)')
c = c.replace('post_result(bid, None, error=str(err))', 'post_result(bid, attempt=data.get("attempt", 0), verdict=None, error=str(err))')

open(f, 'w', encoding='utf-8').write(c)
print('Patched attempt')
