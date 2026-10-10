#!/bin/bash
# setup-vps.sh - Persiapan VPS Ubuntu 22.04 untuk ClipperVPS
# Script ini bersifat idempoten (bisa dijalankan berulang kali).
set -e

echo "==================================================="
echo "  Mulai Setup VPS Ubuntu 22.04 untuk ClipperVPS"
echo "==================================================="

echo "[1/7] Update APT & Install Dependencies..."
sudo apt-get update
sudo apt-get install -y git curl wget ffmpeg python3 python3-venv python3-pip build-essential cmake pkg-config ca-certificates

echo "[2/7] Install Node.js 20 LTS & PM2..."
if ! command -v node > /dev/null || [ "$(node -v | cut -d. -f1)" != "v20" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js 20 sudah terinstal: $(node -v)"
fi
sudo npm install -g pm2

echo "[3/7] Install yt-dlp (Binary Release)..."
if ! command -v yt-dlp > /dev/null; then
    sudo wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
    sudo chmod a+rx /usr/local/bin/yt-dlp
else
    echo "yt-dlp sudah terinstal: $(yt-dlp --version)"
fi

echo "[4/7] Setup Repository ClipperVPS..."
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

echo "[5/7] Setup whisper.cpp..."
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

echo "[6/7] Setup llama.cpp..."
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
echo "  [7/7] Oracle lokal worker (venv Python + PM2)"
echo "==================================================="
# worker.py butuh requests + Pillow. Install ke venv khusus agar tidak menabrak
# python3 sistem (PEP 668 di Ubuntu 22.04 menolak pip install global).
ORACLE_VENV="/opt/clippervps-oracle-venv"
if [ ! -x "$ORACLE_VENV/bin/python3" ]; then
    echo "Buat virtual environment oracle di $ORACLE_VENV..."
    python3 -m venv "$ORACLE_VENV"
fi
"$ORACLE_VENV/bin/pip" install -q requests pillow
echo "Deps oracle worker siap: $ORACLE_VENV"

# Eksekusi wrapper worker.py ditanggung run-worker.sh (muat .env + exec venv python).
chmod +x "$REPO_DIR/server/oracle_local/run-worker.sh" || true

# Rotasi log wajib di VPS - tanpa ini partisi root penuh oleh pm2 logs dalam hitungan minggu.
if pm2 list >/dev/null 2>&1; then
    if ! pm2 multinfo 2>/dev/null | grep -q pm2-logrotate; then
        echo "Install pm2-logrotate..."
        pm2 install pm2-logrotate || true
    fi
    # Registrasi PM2 idempoten: hanya start ecosystem bila app oracle belum terdaftar.
    if ! pm2 list | grep -qE "llama-server|oracle-worker"; then
        echo "Mendaftarkan PM2 apps dari ecosystem.config.cjs (clipper + llama-server + oracle-worker)..."
        cd "$REPO_DIR" && pm2 start ecosystem.config.cjs
    else
        echo "PM2 apps (llama-server/oracle-worker) sudah terdaftar - skip start."
    fi
    pm2 save || true
else
    echo "(pm2 daemon belum aktif - lewati registrasi ecosystem; jalankan menu-vps.sh [6] setelah login pertama)"
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
