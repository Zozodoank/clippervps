#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "======================================================"
echo "🔄 [Update] Sinkronisasi bersih dari GitHub (Clean Reset)..."
echo "======================================================"

# 1. Hentikan proses zombie/stuck ffmpeg atau yt-dlp jika ada
echo "🧹 [Clean] Menghentikan proses ffmpeg/yt-dlp yang tersisa..."
pkill -9 -f ffmpeg 2>/dev/null || true
pkill -9 -f yt-dlp 2>/dev/null || true

# 2. Bersihkan file cache & temp yang bisa membuat stuck
echo "🧹 [Clean] Membersihkan cache Vite & direktori temp..."
rm -rf client/node_modules/.vite 2>/dev/null || true
rm -rf server/temp/* 2>/dev/null || true
rm -rf temp/* 2>/dev/null || true

# 3. Bersihkan job gagal dari database jobs.json
if [ -f "server/clean-failed-jobs.js" ]; then
  echo "🧹 [Clean] Membersihkan job gagal / pending yang menggantung..."
  (cd server && node clean-failed-jobs.js 2>/dev/null || true)
fi

# 4. Ambil commit terbaru dari origin main dengan hard reset agar 100% sinkron tanpa konflik
echo "⬇️ [Update] Mengambil commit terbaru dari origin main..."
git fetch origin main
git reset --hard origin/main

echo "📦 [Update] Memeriksa dependensi package.json..."
if [ -d "server" ]; then
  (cd server && npm install --no-audit --no-fund 2>/dev/null || true)
fi
if [ -d "client" ]; then
  (cd client && npm install --no-audit --no-fund 2>/dev/null || true)
fi

echo "======================================================"
echo "✅ [Update] Selesai! Versi aktif saat ini: $(git log -1 --oneline)"
echo "======================================================"
