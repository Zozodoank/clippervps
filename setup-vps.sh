#!/bin/bash
# setup-vps.sh - Persiapan VPS Ubuntu 22.04 untuk ClipperVPS
# Script ini bersifat idempoten (bisa dijalankan berulang kali).
set -e

echo "==================================================="
echo "  Mulai Setup VPS Ubuntu 22.04 untuk ClipperVPS"
echo "==================================================="

echo "[1/6] Update APT & Install Dependencies..."
sudo apt-get update
sudo apt-get install -y git curl wget ffmpeg python3 python3-venv python3-pip build-essential cmake pkg-config ca-certificates

echo "[2/6] Install Node.js 20 LTS & PM2..."
if ! command -v node > /dev/null || [ "$(node -v | cut -d. -f1)" != "v20" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js 20 sudah terinstal: $(node -v)"
fi
sudo npm install -g pm2

echo "[3/6] Install yt-dlp (Binary Release)..."
if ! command -v yt-dlp > /dev/null; then
    sudo wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
    sudo chmod a+rx /usr/local/bin/yt-dlp
else
    echo "yt-dlp sudah terinstal: $(yt-dlp --version)"
fi

echo "[4/6] Setup Repository ClipperVPS..."
REPO_DIR="/root/clippervps"
if [ ! -d "$REPO_DIR" ]; then
    echo "Clone repository ke $REPO_DIR..."
    git clone https://github.com/Zozodoank/clippervps.git "$REPO_DIR"
else
    echo "Repository sudah ada di $REPO_DIR. Melakukan git pull..."
    cd "$REPO_DIR"
    git pull origin main
fi

cd "$REPO_DIR"
echo "Install npm dependencies untuk server & client..."
cd server && npm install
cd ../client && npm install
cd "$REPO_DIR"

echo "[5/6] Setup whisper.cpp..."
WHISPER_DIR="$REPO_DIR/server/bin/whisper"
if [ ! -f "$WHISPER_DIR/whisper-cli" ] && [ ! -f "$WHISPER_DIR/main" ]; then
    echo "Clone & Build whisper.cpp..."
    # Hapus folder lama jika ada sisa
    rm -rf "$WHISPER_DIR"
    git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
    cd "$WHISPER_DIR"
    make
    echo "Unduh model ggml-base.bin..."
    bash ./models/download-ggml-model.sh base
else
    echo "whisper.cpp sudah ter-build."
fi

cd "$REPO_DIR"

echo "[6/6] Setup llama.cpp..."
LLAMA_DIR="/opt/clippervps-llama"
if [ ! -f "$LLAMA_DIR/build/bin/llama-server" ]; then
    echo "Clone & Build llama.cpp..."
    sudo mkdir -p "$LLAMA_DIR"
    sudo chown "$USER:$USER" "$LLAMA_DIR"
    git clone https://github.com/ggerganov/llama.cpp.git "$LLAMA_DIR"
    cd "$LLAMA_DIR"
    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build --config Release -j$(nproc)
else
    echo "llama-server sudah ter-build di $LLAMA_DIR/build/bin/llama-server"
fi

echo "==================================================="
echo "  Mengunduh Model (Qwen2.5-VL-3B-Instruct GGUF)"
echo "==================================================="
MODEL_DIR="/opt/clippervps-models"
sudo mkdir -p "$MODEL_DIR"
sudo chown "$USER:$USER" "$MODEL_DIR"
cd "$MODEL_DIR"

if [ ! -f "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf" ]; then
    echo "Mengunduh Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf..."
    wget -c https://huggingface.co/bartowski/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf
else
    echo "Model Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf sudah ada."
fi

if [ ! -f "mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf" ]; then
    echo "Mengunduh mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf..."
    wget -c https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf
else
    echo "Model mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf sudah ada."
fi

echo "==================================================="
echo "  Verifikasi Instalasi Dasar"
echo "==================================================="
ffmpeg -version | head -n 1
yt-dlp --version
node -v
python3 --version
if [ -f "$WHISPER_DIR/whisper-cli" ]; then
    "$WHISPER_DIR/whisper-cli" -h | head -n 5
elif [ -f "$WHISPER_DIR/main" ]; then
    "$WHISPER_DIR/main" -h | head -n 5
fi
"$LLAMA_DIR/build/bin/llama-server" --version

echo "Setup VPS Selesai!"
