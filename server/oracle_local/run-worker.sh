#!/usr/bin/env bash
# run-worker.sh - Wrapper PM2 untuk worker oracle lokal (Qwen2.5-VL via llama-server).
# Muat server/.env lalu root .env (urutan menang sama dengan envLoader.js: berkas
# terakhir yang memuat sebuah key menjadi nilai aktif) supaya ORACLE_TOKEN tidak
# perlu diduplikasi ke konfigurasi PM2. Regenerasi: edit file ini, bukan ecosystem.
set -a
[ -f "$(dirname "$0")/../.env" ] && . "$(dirname "$0")/../.env"
[ -f "$(dirname "$0")/../../.env" ] && . "$(dirname "$0")/../../.env"
set +a
# Default loopback: worker = KLIEN yang memanggil API server via 127.0.0.1,
# bukan pihak yang mengetuk tunnel publik.
export ORACLE_BASE_URL="${ORACLE_BASE_URL:-http://127.0.0.1:5000}"
export LLAMA_SERVER_URL="${LLAMA_SERVER_URL:-http://127.0.0.1:8080/v1}"
# Token worker = token API server (dibaca dari .env yang sama, tidak pernah hardcode).
export ORACLE_TOKEN="${ORACLE_TOKEN:-$API_ACCESS_TOKEN}"
# venv dibuat setup-vps.sh [7/7]; fallback python3 sistem bila venv belum ada.
PYTHON_BIN="/opt/clippervps-oracle-venv/bin/python3"
[ -x "$PYTHON_BIN" ] || PYTHON_BIN="python3"
exec "$PYTHON_BIN" "$(dirname "$0")/worker.py"
