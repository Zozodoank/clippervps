import os
import hashlib

f = 'kaggle/oracle-launch.sh'
c = open(f, encoding='utf-8').read()

old_check = '''  seen="$(curl -s -m 10 -H "x-api-token: $SERVER_TOKEN" "$BASE_URL/api/vlm-oracle/status" 2>/dev/null \\
          | sed -n 's/.*"lastSeenAt":\\([0-9]*\\).*/\\1/p')"
  if [ -n "$seen" ]; then
    age=$(( ( $(date +%s) * 1000 - seen ) / 1000 ))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$STALE_SEC" ]; then
      log "notebook HIDUP (heartbeat ${age} dtk lalu < batas ${STALE_SEC}) — tidak ada sesi baru, tidak ada kuota terbuang."
      exit 0
    fi
  fi'''

new_check = '''  status_json="$(curl -s -m 10 -H "x-api-token: $SERVER_TOKEN" "$BASE_URL/api/vlm-oracle/status" 2>/dev/null)"
  seen="$(echo "$status_json" | sed -n 's/.*"lastSeenAt":\\([0-9]*\\).*/\\1/p')"
  remote_hash="$(echo "$status_json" | sed -n 's/.*"sourceHash":"\\([^"]*\\)".*/\\1/p')"
  remote_proto="$(echo "$status_json" | sed -n 's/.*"protocolVersion":"\\([^"]*\\)".*/\\1/p')"
  
  # Compute local hash
  local_hash=""
  if [ -f "$script_dir/vlm_oracle_qwen.py" ]; then
    # Works in Termux (md5sum) and standard linux.
    local_hash="$(md5sum "$script_dir/vlm_oracle_qwen.py" 2>/dev/null | awk '{print $1}')"
    # Fallback to python if md5sum is missing
    [ -z "$local_hash" ] && local_hash="$(python3 -c 'import hashlib,sys; print(hashlib.md5(open(sys.argv[1],"rb").read()).hexdigest())' "$script_dir/vlm_oracle_qwen.py" 2>/dev/null)"
  fi
  expected_proto="2026-10-05-v1"

  if [ -n "$seen" ] && [ -n "$local_hash" ]; then
    age=$(( ( $(date +%s) * 1000 - seen ) / 1000 ))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$STALE_SEC" ]; then
      if [ "$remote_hash" = "$local_hash" ] && [ "$remote_proto" = "$expected_proto" ]; then
        log "notebook HIDUP (heartbeat ${age} dtk lalu, hash cocok) — tidak ada sesi baru."
        exit 0
      else
        log "notebook HIDUP tapi OBSOLETE (remote_hash=$remote_hash vs local=$local_hash, proto=$remote_proto) — Mendorong versi baru..."
      fi
    fi
  fi'''

c = c.replace(old_check, new_check)
open(f, 'w', encoding='utf-8').write(c)
print('Patched oracle-launch.sh')
