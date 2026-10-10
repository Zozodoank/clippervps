#!/usr/bin/env bash
# Script Control Panel & Live Monitor untuk VPS Ubuntu 22.04 (Linux Shell)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Baca token API dari .env tanpa pernah menampilkannya (dipakai untuk /api/vlm-oracle/status).
read_env_key() {
  local k="$1" f line
  for f in "$DIR/server/.env" "$DIR/.env"; do
    [ -f "$f" ] || continue
    line="$(grep -E "^${k}=" "$f" | tail -1 || true)"
    [ -n "$line" ] && { printf '%s' "${line#*=}" | tr -d '\r'; return 0; }
  done
  printf ''
}

while true; do
  clear
  echo "====================================================================="
  echo "       🎬 CLIPPER - CONTROL PANEL (VPS)"
  echo "====================================================================="
  echo "  Status Service Background:"
  pm2 list | grep -E "clipper|llama-server|oracle-worker|tunnel" || pm2 list
  # Tunnel kini OPSIONAL: hanya untuk akses UI jarak jauh. Alur kerja job memakai
  # Oracle lokal Qwen (VPS) yang mengklaim antrean via loopback 127.0.0.1:5000.
  TUNNEL_URL=$(read_env_key CLOUDFLARE_TUNNEL_URL)
  echo "  Tunnel (opsional, UI saja) : ${TUNNEL_URL:-(tidak aktif - job tetap jalan, vonis via oracle lokal)}"
  echo "====================================================================="
  echo ""
  echo "  [1] 📋 LIHAT LOG REAL-TIME BACKGROUND (PM2 LOGS)"
  echo "      - Memantau proses download, AI Gemini, & render video secara live"
  echo ""
  echo "  [2] 🚀 JALANKAN DEV-RUNNER INTERAKTIF (FOREGROUND)"
  echo "      - Menjalankan node dev-runner.js langsung di layar terminal"
  echo ""
  echo "  [3] 🔄 RESTART SERVICE (PM2 Restart)"
  echo ""
  echo "  [4] 📊 CEK PENGGUNAAN RESOURCE (RAM, CPU, Disk)"
  echo ""
  echo "  [5] 🌐 TUNNEL PUBLIK (ngrok URL tetap / cloudflared)"
  echo "      - OPSIONAL - hanya untuk membuka UI dari jarak jauh"
  echo "      - Alur kerja job TIDAK bergantung tunnel (oracle lokal = loopback)"
  echo ""
  echo "  [6] 🛡️ DAFTARKAN PENGAWASAN PM2 (ecosystem.config.cjs)"
  echo "      - Mendaftarkan clipper + llama-server + oracle-worker sekaligus"
  echo "      - Tunnel hanya bila operator memilih menu [5]"
  echo ""
  echo "  [7] 🧠 ORACLE LOKAL (Qwen2.5-VL via llama-server)"
  echo "      - Cek health llama-server + status koneksi worker oracle"
  echo ""
  echo "  [0] ❌ KELUAR KE SHELL BIASA"
  echo ""
  echo "====================================================================="
  read -p "Pilih menu [1-7, 0]: " opt

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
      pm2 restart clipper
      pm2 save
      echo "✅ Selesai!"
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    4)
      clear
      echo "====================================================================="
      echo "📊 PENGGUNAAN RESOURCE (VPS)"
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
      echo "🌐 TUNNEL PUBLIK (OPSIONAL - UI SAJA)"
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
      echo "🛡️ PENGAWASAN PM2 (ecosystem.config.cjs)"
      echo "====================================================================="
      # Daemon PM2 yang baru lahir kosong: simpanan terakhir harus dibangkitkan dulu,
      # kalau tidak menu ini malah mendaftarkan aplikasi baru dengan setting seadanya.
      if ! pm2 list 2>/dev/null | grep -qE "clipper|llama-server|oracle-worker"; then
        echo "(daemon PM2 kosong - mencoba resurrect dari simpanan terakhir...)"
        pm2 resurrect >/dev/null 2>&1 || true
      fi
      if ! pm2 list | grep -qE "llama-server|oracle-worker"; then
        echo "▶️ Mendaftarkan clipper + llama-server + oracle-worker dari ecosystem.config.cjs..."
        pm2 start "$DIR/ecosystem.config.cjs"
      else
        echo "✓ App oracle (llama-server/oracle-worker) sudah terdaftar di PM2."
      fi
      if ! pm2 describe clipper >/dev/null 2>&1; then
        # Fallback ecosystem lama (sebelum VPS-only) tanpa clipper: daftarkan manual.
        echo "▶️ clipper belum terdaftar - mendaftarkan dev-runner.js..."
        pm2 start dev-runner.js --name clipper --max-memory-restart 900M
      fi
      pm2 save
      echo ""
      echo "✅ Selesai. Tunnel tidak otomatis dinyalakan dari sini - pakai menu [5] bila perlu."
      read -p "Tekan Enter untuk kembali ke menu..."
      ;;
    7)
      clear
      echo "====================================================================="
      echo "🧠 ORACLE LOKAL (Qwen2.5-VL)"
      echo "====================================================================="
      echo "=== Health llama-server (127.0.0.1:8080) ==="
      curl -s --max-time 5 http://127.0.0.1:8080/health || echo "(llama-server tidak menjawab - cek: pm2 logs llama-server)"
      echo ""
      echo ""
      TOKEN="$(read_env_key API_ACCESS_TOKEN)"
      echo "=== Status worker oracle (/api/vlm-oracle/status) ==="
      if [ -n "$TOKEN" ]; then
        curl -s --max-time 5 -H "x-api-token: $TOKEN" http://127.0.0.1:5000/api/vlm-oracle/status || echo "(API server tidak menjawab - cek: pm2 logs clipper)"
        echo ""
      else
        echo "(API_ACCESS_TOKEN kosong di server/.env - oracle tidak akan melayani worker)"
      fi
      echo ""
      echo "  [r] restart oracle-worker   [l] restart llama-server   [g] restart keduanya"
      echo "  [o] log oracle-worker       [i] log llama-server       [Enter] kembali"
      read -p "  Pilih: " oopt
      case $oopt in
        r) pm2 restart oracle-worker ;;
        l) pm2 restart llama-server ;;
        g) pm2 restart llama-server oracle-worker ;;
        o) pm2 logs oracle-worker --lines 60 ;;
        i) pm2 logs llama-server --lines 60 ;;
        *) ;;
      esac
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
