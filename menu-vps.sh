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
  pm2 list | grep -E "clipper|tunnel" || pm2 list
  # Tunnel publik = syarat Oracle Kaggle bisa mengetuk API kita. Tampilkan URL aktifnya.
  TUNNEL_URL=$(grep -E '^CLOUDFLARE_TUNNEL_URL=' server/.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
  echo "  Tunnel publik : ${TUNNEL_URL:-(belum ada - Oracle Kaggle tidak akan dapat vonis)}"
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
  echo "  [5] 🌐 TUNNEL PUBLIK (ngrok URL tetap / cloudflared)"
  echo "      - Dibutuhkan Oracle Kaggle: notebook yang memanggil API kita"
  echo "      - URL aktif otomatis ditulis ke server/.env (dipakai kaggle/deploy.ps1 -FromTermux)"
  echo ""
  echo "  [6] 🛡️ DAFTARKAN PENGAWASAN PM2 (clipper + tunnel)"
  echo "      - Sembuhkan 'job mati di tengah render tanpa pesan error': proses yang"
  echo "        hanya hidup di terminal ikut mati saat terminal/proot ditutup"
  echo ""
  echo "  [0] ❌ KELUAR KE SHELL BIASA"
  echo ""
  echo "====================================================================="
  read -p "Pilih menu [1-6, 0]: " opt

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
      echo "🔄 Merestart service clipper..."
      git fetch origin main && git pull origin main
      pm2 delete gatekeeper >/dev/null 2>&1 || true
      pm2 restart clipper
      pm2 save
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
    5)
      clear
      echo "====================================================================="
      echo "🌐 TUNNEL PUBLIK"
      echo "====================================================================="
      echo "  [a] start otomatis (ngrok bila NGROK_DOMAIN terisi, selain itu cloudflared)"
      echo "  [b] status + uji /api/health lewat URL publik"
      echo "  [c] stop"
      read -p "  Pilih [a/b/c]: " topt
      case $topt in
        a) bash "$DIR/start-tunnel.sh" auto ;;
        b) bash "$DIR/start-tunnel.sh" status ;;
        c) bash "$DIR/start-tunnel.sh" stop ;;
        *) echo "Pilihan tidak dikenal." ;;
      esac
      echo ""
      echo "Tutorial ngrok (install agent, authtoken, dev domain): lihat ngrok.md."
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    6)
      clear
      echo "====================================================================="
      echo "🛡️ PENGAWASAN PM2"
      echo "====================================================================="
      # Daemon PM2 yang baru lahir kosong: simpanan terakhir harus dibangkitkan dulu,
      # kalau tidak menu ini malah mendaftarkan aplikasi baru dengan setting seadanya.
      if ! pm2 list 2>/dev/null | grep -qE "clipper|tunnel"; then
        echo "(daemon PM2 kosong - mencoba resurrect dari simpanan terakhir...)"
        pm2 resurrect >/dev/null 2>&1 || true
      fi
      if ! pm2 describe clipper >/dev/null 2>&1; then
        echo "▶️ Mendaftarkan clipper (dev-runner) dengan auto-restart + batas memori..."
        pm2 start dev-runner.js --name clipper --max-memory-restart 900M
      else
        echo "✓ clipper sudah terdaftar di PM2."
      fi
      pm2 delete gatekeeper >/dev/null 2>&1 || true
      bash "$DIR/start-tunnel.sh" auto
      pm2 save
      echo ""
      echo "✅ Selesai. Job tidak lagi hilang diam-diam saat terminal/proot ditutup."
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
