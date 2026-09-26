#!/data/data/com.termux/files/usr/bin/bash
# syn.sh — Siapkan Termux MENERIMA sinkron riwayat job dari PC (arah: PC -> Termux push).
#
# Cara pakai (di Termux):  bash syn.sh
# Lalu di PC: klik dua kali 'sync-to-termux.bat'.
#
# Yang dilakukan:
#   1) Menyalakan sshd (port 8022) supaya PC bisa scp ke HP ini.
#   2) Menghentikan service pm2 (clipper, gatekeeper) supaya jobs.db tidak terkunci
#      saat ditimpa (mencegah korupsi WAL) - sesuai protokol keamanan DB.
#   3) Mencetak IP & username Termux untuk diisi ke sync.config.json di PC.

set -e
echo "======================================================"
echo "🔧 [syn] Menyiapkan Termux menerima sinkron dari PC..."
echo "======================================================"

# 1. Pastikan sshd berjalan (port 8022).
if pgrep -x sshd >/dev/null 2>&1; then
  echo "✅ sshd sudah berjalan (port 8022)."
else
  if command -v sshd >/dev/null 2>&1; then
    sshd
    echo "✅ sshd baru dijalankan (port 8022)."
  else
    echo "❌ sshd tidak ditemukan. Install dulu:  pkg install openssh"
    exit 1
  fi
fi

# 2. Stop service ClipperVPS supaya jobs.db aman ditimpa.
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop clipper    >/dev/null 2>&1 || true
  pm2 stop gatekeeper >/dev/null 2>&1 || true
  echo "✅ PM2 (clipper, gatekeeper) distop sementara."
else
  echo "⚠️ pm2 tidak ditemukan. Jika server jalan manual (node dev-runner.js), STOP sendiri agar DB aman."
fi

# 3. Deteksi IP LAN (wlan0) untuk config PC.
IP="$(ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1)"
if [ -z "$IP" ]; then
  IP="$(ifconfig wlan0 2>/dev/null | awk '/inet addr/{print substr($2,6)}' | head -n1)"
fi
if [ -z "$IP" ]; then
  IP="$(ip -4 addr 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | grep -v '^127' | head -n1)"
fi

echo ""
echo "📡 IP Termux (WAN)  : ${IP:-<TIDAK TERDETEKSI - cek 'ifconfig' manual>}"
echo "👤 Username Termux : $(whoami)"
echo "📁 Project (relatif): ${HOME}/clipperVPS"
echo ""
echo "➡️  Isi nilai di atas ke 'sync.config.json' di PC (fields: termuxIp, termuxUser)."
echo "➡️  Lalu di PC klik dua kali:  sync-to-termux.bat"
echo "    (skrip PC akan push jobs.db + video, lalu otomatis merestart pm2 di Termux)"
