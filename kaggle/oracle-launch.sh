#!/usr/bin/env bash
# ============================================================================
# oracle-launch.sh — menyalakan SESI ORACLE Kaggle langsung dari perangkat yang
# menjalankan server (Termux proot), tanpa PC / PowerShell / browser.
#
# Padanan bash minimal dari:  deploy.ps1 -FromTermux -Logs
#   - URL tunnel + token dibaca dari server/.env LOKAL (deploy.ps1 harus SSH
#     ke Termux untuk itu; di sini kita MEMANG di Termux);
#   - oracle_config.json di-upload ke dataset konfigurasi privat (aman untuk
#     ngrok domain tetap maupun yang berganti);
#   - 'kaggle kernels push' => Kaggle LANGSUNG menjalankan versi baru
#     (tidak perlu tekan Run di browser — fakta terverifikasi di deploy.ps1 L5).
#
# Kredensial (salah satu): ~/.kaggle/kaggle.json, env KAGGLE_API_TOKEN (KGAT_..),
# atau KAGGLE_USERNAME+KAGGLE_KEY. User untuk id kernel/dataset bisa diisi lewat
# env KAGGLE_USER bila hanya token API yang ada.
#
# Pemakaian:
#   bash kaggle/oracle-launch.sh              # push penuh -> sesi GPU baru
#   bash kaggle/oracle-launch.sh --dry-run    # stage + dataset config, TANPA push
#   bash kaggle/oracle-launch.sh --logs       # juga tarik log sesi terakhir
# Skip otomatis: bila heartbeat notebook masih segar (< VLM_ORACLE_STALE_SEC,
# default 300 dtk) berarti sesi sudah hidup -> tidak ada sesi ganda yang
# membakar kuota. Diag + override: ORACLE_LAUNCH_SKIP_LIVE=0, --force.
# Keluaran selalu ke stdout DAN logs/oracle-launch.log. Exit 0 = OK.
# ============================================================================
set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
root_dir="$(dirname "$script_dir")"
stage_dir="$script_dir/.deploy"
cfg_dir="$script_dir/.deploy-config"
log_file="$root_dir/logs/oracle-launch.log"
mkdir -p "$root_dir/logs" "$stage_dir" "$cfg_dir"

DRY_RUN=0; WANT_LOGS=0; FORCE=0; SKIP_LIVE=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --logs) WANT_LOGS=1 ;;
    --force) FORCE=1 ;;
    *) echo "argumen tak dikenal: $a" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date '+%F %T')] $*" | tee -a "$log_file"; }

# Baca KEY=value: server/.env dulu (authoritative), lalu .env root.
envget() {
  local v=''
  for f in "$root_dir/server/.env" "$root_dir/.env"; do
    [ -f "$f" ] || continue
    v="$(grep -m1 "^$1=" "$f" 2>/dev/null | cut -d= -f2- | tr -d '\r"')"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  printf ''
}

fail() { log "GAGAL: $*"; exit 1; }

# --- 1. Kaggle CLI ----------------------------------------------------------
KBIN="${KAGGLE_BIN:-}"
if [ -z "$KBIN" ]; then
  for c in /root/kaggle-venv/bin/kaggle "$(command -v kaggle 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { KBIN="$c"; break; }
  done
fi
[ -n "$KBIN" ] || fail "kaggle CLI tidak ditemukan (pasang: python3 -m venv /root/kaggle-venv && /root/kaggle-venv/bin/pip install kaggle; atau set KAGGLE_BIN)"

# --- 2. Kredensial + user ---------------------------------------------------
KAGGLE_JSON="$HOME/.kaggle/kaggle.json"
API_TOK="${KAGGLE_API_TOKEN:-}"; [ -z "$API_TOK" ] && API_TOK="$(envget KAGGLE_API_TOKEN)"
if [ -n "$API_TOK" ]; then export KAGGLE_API_TOKEN="$API_TOK"; fi
if [ ! -f "$KAGGLE_JSON" ] && [ -f "$root_dir/kaggle.json" ]; then
  mkdir -p "$HOME/.kaggle" && cp "$root_dir/kaggle.json" "$KAGGLE_JSON" && chmod 600 "$KAGGLE_JSON"
  log "kaggle.json disalin dari repo ke ~/.kaggle (chmod 600)."
fi
[ -n "$API_TOK" ] || [ -f "$KAGGLE_JSON" ] || fail "tidak ada kredensial Kaggle (~/.kaggle/kaggle.json atau KAGGLE_API_TOKEN di .env)"

KUSER="${KAGGLE_USER:-${KAGGLE_USERNAME:-}}"
[ -z "$KUSER" ] && [ -f "$KAGGLE_JSON" ] && KUSER="$(sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$KAGGLE_JSON" | head -1)"
[ -n "$KUSER" ] || fail "user Kaggle tidak diketahui — isi KAGGLE_USER di server/.env (contoh: xxxjho)"
log "user=$KUSER kbin=$KBIN"

# --- 3. Sumber kebenaran URL + token (lokal, tanpa SSH) ---------------------
BASE_URL="$(envget VLM_ORACLE_BASE_URL)"; [ -z "$BASE_URL" ] && BASE_URL="$(envget CLOUDFLARE_TUNNEL_URL)"
[ -z "$BASE_URL" ] && BASE_URL="$(envget PUBLIC_BASE_URL)"
SERVER_TOKEN="$(envget API_ACCESS_TOKEN)"
[ -n "$BASE_URL" ] || fail "URL tunnel kosong — isi CLOUDFLARE_TUNNEL_URL/VLM_ORACLE_BASE_URL di server/.env (jalankan start-tunnel.sh dulu)"
[ -n "$SERVER_TOKEN" ] || fail "API_ACCESS_TOKEN kosong di server/.env"
BASE_URL="${BASE_URL%/}"

# Skip bila sesi sudah hidup: heartbeat = kapan terakhir notebook memanggil API.
SKIP_LIVE="${ORACLE_LAUNCH_SKIP_LIVE:-$SKIP_LIVE}"
STALE_SEC="${VLM_ORACLE_STALE_SEC:-300}"
if [ "$FORCE" != 1 ] && [ "$SKIP_LIVE" = 1 ]; then
  seen="$(curl -s -m 10 -H "x-api-token: $SERVER_TOKEN" "$BASE_URL/api/vlm-oracle/status" 2>/dev/null \
          | sed -n 's/.*"lastSeenAt":\([0-9]*\).*/\1/p')"
  if [ -n "$seen" ]; then
    age=$(( ( $(date +%s) * 1000 - seen ) / 1000 ))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$STALE_SEC" ]; then
      log "notebook HIDUP (heartbeat ${age} dtk lalu < batas ${STALE_SEC}) — tidak ada sesi baru, tidak ada kuota terbuang."
      exit 0
    fi
  fi
fi

# --- 4. Dataset konfigurasi (URL + token + batas diri) ----------------------
MAX_MIN="${ORACLE_SESSION_MAX_MINUTES:-$(envget ORACLE_SESSION_MAX_MINUTES)}"; [ -z "$MAX_MIN" ] && MAX_MIN=240
HF_TOK="${HF_TOKEN:-$(envget HF_TOKEN)}"
{
  printf '{\n'
  printf '  "base_url": "%s",\n' "$BASE_URL"
  printf '  "api_access_token": "%s",\n' "$SERVER_TOKEN"
  printf '  "ORACLE_MAX_MINUTES": "%s"\n' "$MAX_MIN"
  [ -n "$HF_TOK" ] && printf '  ,\n  "HF_TOKEN": "%s"\n' "$HF_TOK"
  printf '}\n'
} > "$cfg_dir/oracle_config.json"
cat > "$cfg_dir/dataset-metadata.json" <<EOF
{
  "title": "ClipperVPS Oracle Config",
  "id": "$KUSER/clippervps-oracle-config",
  "isPrivate": true,
  "description": "URL tunnel + token untuk worker VLM oracle. Berisi rahasia - jangan di-share.",
  "keywords": ["clippervps", "oracle", "config"],
  "licenses": [{ "name": "other" }]
}
EOF
log "dataset config -> $BASE_URL (token ${#SERVER_TOKEN} char, tidak ditampilkan), MAX_MINUTES=$MAX_MIN"
if ! "$KBIN" datasets version -p "$cfg_dir" -q -m "auto-launch $(date '+%F %T')" >>"$log_file" 2>&1; then
  "$KBIN" datasets create -p "$cfg_dir" -q >>"$log_file" 2>&1 || fail "upload dataset konfigurasi gagal (lihat $log_file)"
fi
echo "$KUSER/clippervps-oracle-config" > "$stage_dir/.config-dataset-ref"

# --- 5. Staging kernel + push -----------------------------------------------
[ -f "$script_dir/vlm_oracle_qwen.py" ] || fail "worker tidak ada: $script_dir/vlm_oracle_qwen.py"
cp "$script_dir/vlm_oracle_qwen.py" "$stage_dir/"
MODEL_SRC="${ORACLE_MODEL_SOURCE:-$(envget ORACLE_MODEL_SOURCE)}"
[ -z "$MODEL_SRC" ] && [ -f "$stage_dir/.model-source" ] && MODEL_SRC="$(tr -d '\r\n' < "$stage_dir/.model-source")"
export MODEL_SRC
KID="$KUSER" python3 - "$script_dir/kernel-metadata.example.json" "$stage_dir/kernel-metadata.json" <<'PY'
import json, os, sys
meta = json.load(open(sys.argv[1]))
user = os.environ['KID']
meta['id'] = f"{user}/clippervps-vlm-oracle"
meta['dataset_sources'] = [f"{user}/clippervps-oracle-config"]
ms = os.environ.get('MODEL_SRC', '').strip()
meta['model_sources'] = [ms] if ms else []
json.dump(meta, open(sys.argv[2], 'w'), indent=2)
PY
if [ "$DRY_RUN" = 1 ]; then
  log "DRY-RUN: staging siap di $stage_dir — kernel TIDAK di-push (tidak ada sesi GPU baru)."
  exit 0
fi
"$KBIN" kernels push -p "$stage_dir" >>"$log_file" 2>&1 || fail "kernels push gagal (lihat $log_file)"
[ -n "$MODEL_SRC" ] && printf '%s' "$MODEL_SRC" > "$stage_dir/.model-source"
log "PUSH OK — Kaggle menjalankan sesi baru: $KUSER/clippervps-vlm-oracle (GPU T4, self-stop ${MAX_MIN} mnt + idle-exit)."

if [ "$WANT_LOGS" = 1 ]; then
  sleep 10
  "$KBIN" kernels status "$KUSER/clippervps-vlm-oracle" 2>&1 | tee -a "$log_file"
fi
exit 0
