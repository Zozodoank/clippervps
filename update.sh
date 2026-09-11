#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "======================================================"
echo "🔄 [Update] Memeriksa update terbaru dari GitHub..."
echo "======================================================"

# Reset file tracking runtime yang mungkin berubah otomatis
git checkout -- server/bandwidth_stats.json 2>/dev/null || true

OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "old")

echo "⬇️ [Update] Mengambil commit terbaru dari origin main..."
git fetch origin main
git pull origin main

NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "new")

echo "📦 [Update] Memeriksa perubahan dependency..."
if [ "$OLD_COMMIT" != "$NEW_COMMIT" ] && git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" 2>/dev/null | grep -E "package.json|package-lock.json"; then
  echo "📦 [Update] Perubahan package.json terdeteksi. Menginstall dependensi..."
  if [ -d "server" ]; then
    (cd server && npm install --ignore-scripts)
  fi
  if [ -d "client" ]; then
    (cd client && npm install)
  fi
else
  echo "✅ [Update] Dependensi package.json sudah up-to-date."
fi

echo "======================================================"
echo "✅ [Update] Update selesai! Commit saat ini: $(git log -1 --oneline)"
echo "======================================================"
