#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# setup-whisper-termux.sh — Bangun whisper.cpp dari SOURCE + unduh model di
# Termux (nubia V80 Max, Unisoc T7250 ARM, 8GB). Dipakai AUDIO_DRIVEN_SCENES.
#
# Cara pakai (di Termux, dari root repo ~/clipperVPS):
#   bash setup-whisper-termux.sh          # model base (default)
#   MODEL=tiny bash setup-whisper-termux.sh   # tiny = paling ringan utk ARM
#
# Binary besar disimpan di server/bin/whisper/ (sudah .gitignore).
# Setelah selesai, salin 2 baris WHISPER_* yang dicetak ke server/.env Termux.
# ============================================================================
set -euo pipefail

MODEL="${MODEL:-base}"   # tiny | base | small (hindari medium/large di 8GB ARM)
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$ROOT/server/bin/whisper"
MODELS="$DEST/models"
SRC="$DEST/_build/whisper.cpp"

mkdir -p "$DEST" "$MODELS" "$DEST/_build"

echo "==> [1/4] Pasang dependensi build (git, cmake, clang, curl)..."
pkg update -y
pkg install -y git cmake clang curl cpu-features make

echo "==> [2/4] Clone + build whisper.cpp (ARM, tanpa GPU)..."
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$SRC"
fi
cd "$SRC"
cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_OPENCL=OFF \
  -DLLAMA_CPU_FEATURES=ON 2>/dev/null || \
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_OPENCL=OFF
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
