#!/usr/bin/env bash
# Script Control Panel & Live Monitor untuk Termux / Linux Shell (Lokal)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

while true; do
  clear
  echo "====================================================================="
  echo "       🎬 CLIPPER - CONTROL PANEL & MONITOR (TERMUX)"
  echo "====================================================================="
  echo "  Status Service Background:"
  pm2 list | grep -E "clipper|gatekeeper" || pm2 list
  echo "====================================================================="
  echo ""
  echo "  [1] 📋 LIHAT LOG REAL-TIME BACKGROUND (PM2 LOGS)"
  echo "      - Memantau proses download, AI Gemini, & render video secara live"
  echo ""
  echo "  [2] 🚀 JALANKAN DEV-RUNNER INTERAKTIF (FOREGROUND)"
  echo "      - Menjalankan node dev-runner.js langsung di layar Termux"
  echo ""
  echo "  [3] 🔄 RESTART SERVICE (PM2 Restart)"
  echo ""
  echo "  [4] 📊 CEK PENGGUNAAN RESOURCE (RAM, CPU, Disk)"
  echo ""
  echo "  [0] ❌ KELUAR KE SHELL BIASA"
  echo ""
  echo "====================================================================="
  read -p "Pilih menu [1-4, 0]: " opt

  case $opt in
    1)
      clear
      echo "====================================================================="
      echo "📋 MENAMPILKAN LOG REAL-TIME (PM2)..."
      echo "Tekan Ctrl+C untuk berhenti dan kembali ke menu."
      echo "====================================================================="
      echo ""
      pm2 logs clipper --lines 40
      ;;
    2)
      clear
      echo "====================================================================="
      echo "🔄 [1/2] Memeriksa update dari repository GitHub..."
      echo "====================================================================="
      git fetch origin main && git pull origin main
      echo ""
      echo "====================================================================="
      echo "🚀 [2/2] Menjalankan dev-runner.js live di layar..."
      echo "Tekan Ctrl+C untuk berhenti dan mengaktifkan kembali background service."
      echo "====================================================================="
      pm2 stop clipper >/dev/null 2>&1
      node dev-runner.js
      pm2 start clipper >/dev/null 2>&1
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    3)
      clear
      echo "🔄 Merestart service clipper & gatekeeper..."
      git fetch origin main && git pull origin main
      pm2 restart all
      echo "✅ Selesai!"
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    4)
      clear
      echo "====================================================================="
      echo "📊 PENGGUNAAN RESOURCE (LOKAL)"
      echo "====================================================================="
      echo "=== RAM ==="
      free -h
      echo ""
      echo "=== DISK ==="
      df -h /
      echo ""
      echo "=== PM2 STATUS ==="
      pm2 list
      echo "====================================================================="
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    0)
      clear
      echo "Keluar ke shell. Untuk membuka menu lagi, ketik: $DIR/menu-vps.sh"
      break
      ;;
    *)
      ;;
  esac
done
