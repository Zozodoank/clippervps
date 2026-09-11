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

# 2. Bersihkan file cache Vite & file transient
echo "🧹 [Clean] Membersihkan cache Vite..."
rm -rf client/node_modules/.vite 2>/dev/null || true

# CATATAN: jobs.json dan folder server/output/ TETAP AMAN & TIDAK DIHAPUS agar history job tidak hilang!


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
