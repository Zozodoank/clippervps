import os

f = 'kaggle/vlm_oracle_qwen.py'
content = open(f, encoding='utf-8').read()

# 1. Add Protocol Version and Worker ID
protocol = 'ORACLE_PROTOCOL_VERSION = "2026-10-05-v1"\n'
worker = 'WORKER_ID = os.environ.get("KAGGLE_KERNEL_RUN_TYPE", "unknown") + "-" + str(os.getpid())\n'
if 'ORACLE_PROTOCOL_VERSION' not in content:
    content = content.replace("POLL_SEC = 2.0", protocol + worker + "\nPOLL_SEC = 2.0")

# 2. Add validation before POST
old_post = 'def post_result(batch_id, verdict=None, error=""):\\n    body = {"batchId": batch_id}'
new_post = '''def post_result(batch_id, verdict=None, error=""):
    if verdict is not None:
        if not isinstance(verdict, dict):
            error = "Vonis bukan dict/object: %s" % str(type(verdict))
            verdict = None
        elif "safe" not in verdict and "perFrame" not in verdict:
            error = "Vonis dict tidak memiliki safe/perFrame: %s" % list(verdict.keys())
            verdict = None
    body = {"batchId": batch_id, "workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION}'''
content = content.replace('def post_result(batch_id, verdict=None, error=""):\n    body = {"batchId": batch_id}', new_post)

# 3. Add Kaggle log observability
old_log_res = 'log("  -> safe=%s flags=%s %dms" % (v["safe"],'
new_log_res = 'log("[Oracle] rawOutputType=%s parseSuccess=%s verdictType=%s protocolVersion=%s -> safe=%s flags=%s %dms" % (type(raw_output).__name__, verdict_parsed, type(v).__name__, ORACLE_PROTOCOL_VERSION, v.get("safe"),'
# Wait, I need raw_output and verdict_parsed variables in main()
# Let's see verdict_batch return... it doesn't return raw_output.
# I'll just skip rawOutputType here and log it inside ask() or verdict_batch().
open(f, 'w', encoding='utf-8').write(content)
print('Patched vlm_oracle_qwen.py')
