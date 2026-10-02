#!/usr/bin/env bash
# ============================================================================
# setup-vlm-termux.sh — Bangun llama.cpp (dengan dukungan vision/mtmd) dari SOURCE.
# TAHAN LINGKUNGAN: jalan di proot-distro Ubuntu/Debian (apt, root wajar).
#
# PENTING: skrip ini HANYA membangun BINER. Model GGUF SmolVLM2 TIDAK diunduh di
# sini - cukup SALIN file hasil unduhan PC ke server/gatekeeper/models/ via scp
# (lihat sync-to-termux.ps1). Ini menghemat kuota & menghindari masalah jaringan
# HuggingFace di Termux.
#
# Cara pakai (dari root repo ~/clipperVPS):
#   proot-distro login ubuntu -- bash server/gatekeeper/setup-vlm-termux.sh
#
# Biner disimpan di server/bin/llama/ (sudah .gitignore lewat 'server/bin/').
# Setelah selesai, salin baris GK_VLM_* yang dicetak ke server/.env.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"     # server/gatekeeper
# Akar repo = dua tingkat di atas server/gatekeeper
REPO="$(cd "$ROOT/../.." && pwd)"
DEST="$REPO/server/bin/llama"
SRC="$DEST/_build/llama.cpp"

echo "==> [1/3] Deteksi lingkungan & pasang dependensi build..."
if [ -f /etc/debian_version ] && command -v apt-get >/dev/null 2>&1; then
  # proot-distro Ubuntu/Debian (root itu NORMAL). JANGAN pakai 'pkg' Termux.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git cmake make build-essential curl libcurl4-openssl-dev
elif command -v pkg >/dev/null 2>&1; then
  # Termux NATIF: 'pkg' menolak root.
  if [ "$(id -u)" = "0" ]; then
    echo "ERROR: jalan sebagai ROOT di Termux native (pkg menolaknya)."
    echo "Solusi: bangun di proot: proot-distro login ubuntu -- bash $0"
    exit 1
  fi
  pkg update -y || true
  pkg install -y git cmake clang make curl
else
  echo "ERROR: tak menemukan 'apt-get' (proot) maupun 'pkg' (Termux native)."
  exit 1
fi

echo "==> [2/3] Clone + build llama.cpp (ARM CPU, dukungan mtmd/vision)..."
mkdir -p "$DEST" "$DEST/_build"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$SRC"
fi
cd "$SRC"
# -DLLAMA_CURL=ON agar mtmd bisa memuat gambar; mtmd dibangun sebagai bagian examples.
cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=ON -DGGML_OPENMP=OFF
cmake --build build --config Release -j"$(nproc)" -- llama-mtmd-cli

# Temukan binary hasil build (nama dapat berubah antar versi llama.cpp).
BIN=""
for cand in "$SRC/build/bin/llama-mtmd-cli" "$SRC/build/tools/mtmd/llama-mtmd-cli" "$SRC/build/bin/llama-mtmd-debug"; do
  [ -x "$cand" ] && BIN="$cand" && break
done
if [ -z "$BIN" ]; then
  # Fallback: cari di seluruh build tree.
  BIN="$(find "$SRC/build" -type f -name 'llama-mtmd-cli' 2>/dev/null | head -n1 || true)"
fi
[ -z "$BIN" ] && { echo "ERROR: llama-mtmd-cli tidak ditemukan pasca-build (cek dukungan mtmd di versi llama.cpp ini)."; exit 1; }
cp -f "$BIN" "$DEST/llama-mtmd-cli"
echo "==> OK binary: $DEST/llama-mtmd-cli"

echo "==> [3/3] Cek versi ..."
"$DEST/llama-mtmd-cli" --help 2>&1 | head -n 3 || true

cat <<EOF

====================================================================
 llama.cpp (mtmd/vision) siap di Termux.

 1) PASTIKAN model GGUF SUDAH ADA di server/gatekeeper/models/
    (unduh sekali di PC, lalu: bash sync-to-termux.ps1 / scp).
    Nama file yang diharapkan (sesuaikan dengan repo HF):
      - smolvlm2-500m.Q4_K_M.gguf     (model LLM)
      - smolvlm2-500m-mmproj.gguf     (projector vision/mmproj)

 2) Set nilai ini di server/.env :
      VISION_VERIFY_MODE=smolvlm
      GK_VLM_BIN=$DEST/llama-mtmd-cli
      GK_VLM_MODEL=$ROOT/models/smolvlm2-500m.Q4_K_M.gguf
      GK_VLM_MMPROJ=$ROOT/models/smolvlm2-500m-mmproj.gguf

 Catatan: bila flag argumen llama-mtmd-cli pada versi build Anda berbeda
 (mis. '--model' bukan '-m', atau tidak ada '--mmproj'), sesuaikan argumen
 di server/services/vlmGateService.js (fungsi buildArgs).
====================================================================
EOF
