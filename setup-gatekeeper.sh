#!/bin/bash
# ==============================================================================
# Setup & Starter Skrip AI Local Frame Gatekeeper untuk ClipperVPS (Ubuntu 22.04)
# Memasang MediaPipe, DBNet, MobileNetV3 & OpenCV di CPU VPS
# ==============================================================================

set -e

echo "🚀 [Setup Gatekeeper] Memeriksa & Menginstal Dependensi Python..."
pip3 install --user --upgrade opencv-python-headless onnxruntime mediapipe numpy pillow

GATEKEEPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/server/gatekeeper" && pwd)"
cd "$GATEKEEPER_DIR"

echo "📦 [Setup Gatekeeper] Mengunduh Model ONNX Lokal Skala Nano..."
python3 download_models.py

echo "🧪 [Setup Gatekeeper] Menjalankan Pengujian Benchmark..."
python3 test_gatekeeper.py

echo "⚙️ [Setup Gatekeeper] Memeriksa status proses PM2..."
if command -v pm2 &> /dev/null; then
    if pm2 describe gatekeeper &> /dev/null; then
        echo "🔄 Me-restart service gatekeeper di PM2..."
        pm2 restart gatekeeper
    else
        echo "▶️ Mendaftarkan service gatekeeper di PM2..."
        pm2 start service.py --name "gatekeeper" --interpreter python3 -- --port 5050
        pm2 save
    fi
    echo "✅ AI Local Gatekeeper berjalan di background (PM2 ID: gatekeeper, Port: 5050)"
else
    echo "ℹ️ PM2 tidak terdeteksi. Anda dapat menjalankan manual: python3 service.py --port 5050"
fi

echo "🎉 Setup AI Local Gatekeeper Berhasil!"
