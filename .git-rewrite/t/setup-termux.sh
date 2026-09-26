#!/usr/bin/env bash
set -e

echo "======================================================"
echo "🎬 Setting up Local AI Affiliate Clipper on Termux"
echo "======================================================"

echo "📦 [1/4] Installing Termux packages..."
pkg update -y
pkg install -y nodejs git ffmpeg python

echo "⬇️ [2/4] Installing latest yt-dlp..."
python -m pip install -U yt-dlp

echo "📦 [3/4] Installing Node.js server dependencies..."
if [ -f server/package-lock.json ]; then
  (cd server && npm ci --ignore-scripts)
else
  (cd server && npm install --ignore-scripts)
fi

echo "📦 [4/4] Installing Node.js client dependencies..."
if [ -f client/package-lock.json ]; then
  (cd client && npm ci)
else
  (cd client && npm install)
fi

if [ ! -f "server/.env" ]; then
  echo "🔑 Creating server/.env..."
  cat << 'EOF' > server/.env
PORT=5000
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
AIVENE_API_KEY=your_aivene_api_key_here
AIVENE_MODEL=qwen3.8-flash
LOW_DATA_MODE=true
EOF
  echo "✅ Created server/.env. Edit GEMINI_API_KEY before running the app."
fi

echo "======================================================"
echo "✅ Setup completed."
echo "🚀 Start the app with: npm run dev"
echo "======================================================"
