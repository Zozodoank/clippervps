#!/usr/bin/env bash
# Script Control Panel & Live Monitor untuk Termux / Linux Shell

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

while true; do
  clear
  echo "====================================================================="
  echo "       🎬 CLIPPER VPS - CONTROL PANEL & MONITOR (TERMUX)"
  echo "====================================================================="
  echo "  Status Service Background:"
  pm2 list | grep -E "clipper|tunnel" || pm2 list
  echo "====================================================================="
  echo ""
  echo "  [1] 📋 LIHAT LOG REAL-TIME BACKGROUND (PM2 LOGS)"
  echo "      - Memantau proses download, AI Gemini, & render video secara live"
  echo ""
  echo "  [2] 🚀 JALANKAN DEV-RUNNER INTERAKTIF (FOREGROUND)"
  echo "      - Menjalankan node dev-runner.js langsung di layar Termux"
  echo ""
  echo "  [3] 🌐 LIHAT LINK AKSES PUBLIK (Cloudflare Tunnel)"
  echo "      - Mendapatkan link HTTPS untuk dibuka langsung di browser HP"
  echo ""
  echo "  [4] 🔄 RESTART SERVICE DI VPS (PM2 Restart)"
  echo ""
  echo "  [5] 📊 CEK PENGGUNAAN RESOURCE (RAM, CPU, Disk)"
  echo ""
  echo "  [0] ❌ KELUAR KE SHELL BIASA"
  echo ""
  echo "====================================================================="
  read -p "Pilih menu [1-5, 0]: " opt

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
      echo "====================================================================="
      echo "🌐 URL AKSES PUBLIK CLOUDFLARE TUNNEL"
      echo "====================================================================="
      URL=$(grep 'CLOUDFLARE_TUNNEL_URL' "$DIR/.env" | cut -d '=' -f2)
      if [ -z "$URL" ]; then
        URL=$(pm2 logs tunnel --lines 40 --nostream | grep -o 'https://.*\.trycloudflare\.com' | tail -n 1)
      fi
      echo ""
      echo "Link HTTPS Aktif:"
      echo "👉 $URL"
      echo ""
      echo "Salin link di atas dan buka di browser HP Anda."
      echo "====================================================================="
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    4)
      clear
      echo "🔄 Merestart service clipper & tunnel..."
      git fetch origin main && git pull origin main
      pm2 restart all
      echo "✅ Selesai!"
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    5)
      clear
      echo "====================================================================="
      echo "📊 PENGGUNAAN RESOURCE VPS"
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
      echo "Keluar ke shell. Untuk membuka menu lagi, ketik: ~/clipperVPS/menu-vps.sh"
      break
      ;;
    *)
      ;;
  esac
done
