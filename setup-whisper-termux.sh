#!/usr/bin/env bash
# ============================================================================
# setup-whisper-termux.sh — Bangun whisper.cpp dari SOURCE + unduh model.
# TAHAN LINGKUNGAN: jalan di Termux NATIF (pakai 'pkg', user non-root)
# maupun di dalam proot-distro Ubuntu/Debian (pakai 'apt', root wajar).
#
# Cara pakai (dari root repo ~/clipperVPS):
#   Termux native : bash setup-whisper-termux.sh
#   Model ringan   : MODEL=tiny bash setup-whisper-termux.sh
#
# Binary/model disimpan di server/bin/whisper/ (sudah .gitignore).
# Setelah selesai, salin baris WHISPER_* yang dicetak ke server/.env.
# ============================================================================
set -euo pipefail

MODEL="${MODEL:-base}"   # tiny | base | small (hindari medium/large di 8GB ARM)
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$ROOT/server/bin/whisper"
MODELS="$DEST/models"
SRC="$DEST/_build/whisper.cpp"
IS_ROOT="$(id -u)"

mkdir -p "$DEST" "$MODELS" "$DEST/_build"

echo "==> [1/4] Deteksi lingkungan & pasang dependensi build..."
if command -v pkg >/dev/null 2>&1; then
  # Termux native: 'pkg' MENOLAK jalan sebagai root.
  if [ "$IS_ROOT" = "0" ]; then
    echo "ERROR: sedang JALAN SEBAGAI ROOT di Termux (pkg menolaknya)."
    echo "Solusi: ketik 'exit' (mungkin 2x) sampai prompt Termux non-root,"
    echo "        lalu jalankan lagi:  bash setup-whisper-termux.sh"
    exit 1
  fi
  pkg update -y || true
  pkg install -y git cmake clang make curl cpu-features
elif command -v apt-get >/dev/null 2>&1; then
  # proot-distro / Debian-Ubuntu: root itu normal, pakai apt.
  # build-essential menyediakan gcc/g++/make (pengganti clang di Termux).
  apt-get update -y
  apt-get install -y git cmake build-essential curl
else
  echo "ERROR: tak menemukan 'pkg' (Termux) maupun 'apt-get' (proot/Linux)."
  exit 1
fi

echo "==> [2/4] Clone + build whisper.cpp (ARM, tanpa GPU)..."
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$SRC"
fi
cd "$SRC"
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j"$(nproc)"

# Temukan binary hasil build (whisper-cli terbaru / main lama).
BIN=""
for cand in "$SRC/build/bin/whisper-cli" "$SRC/build/bin/main" "$SRC/build/Release/bin/whisper-cli"; do
  [ -x "$cand" ] && BIN="$cand" && break
done
[ -z "$BIN" ] && { echo "ERROR: binary whisper tidak ditemukan pasca-build."; exit 1; }
cp -f "$BIN" "$DEST/whisper-cli"
echo "==> OK binary: $DEST/whisper-cli"

echo "==> [3/4] Unduh model ggml-$MODEL.bin ..."
MODEL_FILE="$MODELS/ggml-$MODEL.bin"
if [ ! -f "$MODEL_FILE" ]; then
  curl -L --fail -o "$MODEL_FILE" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
fi
ls -lh "$MODEL_FILE"

echo "==> [4/4] Cek versi ..."
"$DEST/whisper-cli" -h 2>&1 | head -n 1 || true

cat <<EOF

====================================================================
 whisper.cpp siap di Termux. Set nilai ini di server/.env :
   AUDIO_DRIVEN_SCENES=true
   WHISPER_CPP_BIN=$DEST/whisper-cli
   WHISPER_MODEL=$MODELS/ggml-$MODEL.bin
 (Bila $MODEL terlalu lambat di HP, ulangi: MODEL=tiny bash setup-whisper-termux.sh)
====================================================================
EOF
