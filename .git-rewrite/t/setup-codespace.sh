#!/usr/bin/env bash
set -e

echo "======================================================"
echo "🎬 Setting up Local AI Affiliate Clipper on Linux / Codespace"
echo "======================================================"

# 1. Update system & install FFmpeg + Python Pip
echo "📦 [1/4] Installing system FFmpeg and Python tools..."
sudo apt-get update -y
sudo apt-get install -y ffmpeg python3-pip

# 2. Install latest yt-dlp
echo "⬇️ [2/4] Installing latest yt-dlp..."
pip install -U yt-dlp --break-system-packages 2>/dev/null || pip install -U yt-dlp || sudo apt-get install -y yt-dlp

# 3. Install Server Dependencies
echo "📦 [3/4] Installing Node.js Server dependencies..."
cd server
npm install
cd ..

# 4. Install Client Dependencies
echo "📦 [4/4] Installing Node.js Client dependencies..."
cd client
npm install
cd ..

# 5. Create default .env if not present
if [ ! -f "server/.env" ]; then
  echo "🔑 Setting up server/.env..."
  cat << 'EOF' > server/.env
PORT=5000
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
AIVENE_API_KEY=your_aivene_api_key_here
AIVENE_MODEL=qwen3.8-flash
EOF
  echo "✅ Created server/.env. Edit GEMINI_API_KEY before running the app."
fi

echo "======================================================"
echo "✅ Setup Completed Successfully!"
echo "🚀 To start the app, simply run: node dev-runner.js"
echo "======================================================"
