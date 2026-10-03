#!/usr/bin/env bash
# Jembatan publik untuk Oracle Kaggle: ngrok (URL TETAP) atau cloudflared (URL acak).
#
# MENGAPA SKRIP INI ADA
# Pipeline lokal tidak pernah memanggil Kaggle - notebook-lah yang mengetuk API kita
# (/api/vlm-oracle/claim, /vlm-oracle/frames/.., /vlm-oracle/result). Jadi perangkat yang
# menjalankan server harus punya URL publik. Selama ini cloudflared quick tunnel dijalankan
# manual dari riwayat shell dan namanya berganti setiap restart, sehingga
# kaggle/deploy.ps1 -FromTermux wajib dijalankan ulang tiap hari. ngrok plan gratis memberi
# satu dev domain yang tidak berubah -> URL didaftarkan sekali.
#
# Pemakaian (jalankan DI DALAM proot Ubuntu, tempat node/cloudflared berada):
#   bash start-tunnel.sh              # auto: ngrok bila NGROK_DOMAIN terisi, else cloudflared
#   bash start-tunnel.sh ngrok        # paksa ngrok
#   bash start-tunnel.sh cloudflared  # paksa quick tunnel (URL baru ditemukan dari log)
#   bash start-tunnel.sh status
#   bash start-tunnel.sh stop
#
# Variabel di .env (dibaca dari server/.env lalu root .env - urutan yang sama dengan
# server/utils/paths.js envCandidates + envLoader.js, yang berarti root .env MENIMPA
# server/.env untuk key yang sama):
#   NGROK_URL / NGROK_DOMAIN (input)  keduanya diterima; NGROK_URL yang penuh
#                    (https://xxx.ngrok-free.dev) maupun domain polos (xxx.ngrok-free.dev).
#                    Authtoken ngrok TIDAK ditaruh di sini - simpan di config agent ngrok
#                    (`ngrok config add-authtoken ...`), lihat ngrok.md.
#   TUNNEL_PORT      (input)  default 5000 = port API
#   CLOUDFLARE_TUNNEL_URL  (output, ditulis ke server/.env) URL aktif. Nama key-nya SENGAJA
#                    dipertahankan karena kaggle/deploy.ps1 -FromTermux membaca key ini.
#   PUBLIC_BASE_URL  (output) izin CORS - tokenAuth.getExplicitCorsOrigins()
#   VLM_ORACLE_BASE_URL (output) tampil di /api/vlm-oracle/status (informasi saja)
#
# Token TIDAK pernah dibaca/dicetak skrip ini. Authtoken ngrok disimpan di berkas
# konfigurasi agent (~/.config/ngrok/ngrok.yml), bukan di server/.env.

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVF="$DIR/server/.env"
ROOT_ENVF="$DIR/.env"

if [ ! -f "$ENVF" ]; then
  echo "server/.env tidak ditemukan di: $ENVF"
  exit 1
fi

# Urutan loop = urutan menang: berkas terakhir yang punya key itu menjadi nilai aktif.
# Ini SENGAJA meniru envLoader.js (server/.env lalu ../.env) supaya skrip shell dan proses
# Node tidak pernah melihat dua nilai berbeda untuk satu key.
read_env() {
  local k="$1" f line v=""
  for f in "$ENVF" "$ROOT_ENVF"; do
    [ -f "$f" ] || continue
    line="$(grep -E "^${k}=" "$f" | tail -1 || true)"
    [ -n "$line" ] || continue
    line="${line#*=}"
    line="${line%\"}"; line="${line#\"}"
    v="${line%%$'\r'*}"
  done
  printf '%s' "$v"
}

write_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENVF"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENVF"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENVF"
  fi
}

PORT_RAW="$(read_env TUNNEL_PORT)"
PORT="${PORT_RAW:-5000}"

have() { command -v "$1" >/dev/null 2>&1; }

# helper tampilan "ada/tidak" untuk show_status
have_str() { if have "$1"; then echo "ada"; else echo "TIDAK"; fi; }

need_pm2() {
  if ! have pm2; then
    echo "pm2 tidak ada. Tunnel tanpa pengawas akan mati bersama terminalnya"
    echo "(proot-distro berjalan dengan --kill-on-exit). Pasang: npm i -g pm2"
    return 1
  fi
  return 0
}

# Tulis URL aktif ke .env lalu buktikan bahwa dunia luar benar-benar bisa memanggil kita.
# Probe diulang karena agent ngrok/cloudflared butuh 1-5 detik untuk tersambung; ngrok bahkan
# MENJAWAB 404 dari edge-nya selama tunnel belum nyambung, jadi sekali cek tanpa pengulangan
# akan membaca keadaan sehat sebagai kegagalan.
# Tafsir kode: 200 sehat | 404 edge menjawab, tunnel/backend belum tersambung |
# 401/403 tunnel hidup tapi path salah kunci token | 000 DNS/koneksi keluar mati.
publish_url() {
  local url="$1" label="$2" code="" i
  for i in 1 2 3 4 5 6 7 8; do
    # curl TETAK mencetak %{http_code} saat koneksi gagal ("000") dan mengembalikan kode
    # non-zero; kalau diikuti `|| echo 000` hasilnya jadi "000000". Biarkan satu sumber.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$url/api/health" || true)"
    code="${code:-000}"
    [ "$code" = "200" ] && break
    sleep 2
  done
  write_env CLOUDFLARE_TUNNEL_URL "$url"
  write_env PUBLIC_BASE_URL "$url"
  write_env VLM_ORACLE_BASE_URL "$url"
  echo "Tunnel   : $label -> $url"
  case "$code" in
    200)
      echo "Publik   : LULUS (200 /api/health lewat tunnel)"
      ;;
    404)
      echo "Publik   : HTTP 404 - edge menjawab tetapi tunnel belum tersambung ke port $PORT."
      echo "           Kalau server API-nya memang belum jalan, nyalakan dulu (menu [2]/[3])."
      ;;
    401|403)
      echo "Publik   : HTTP $code - tunnel hidup, padahal /api/health semestinya bebas token."
      ;;
    *)
      echo "Publik   : HTTP $code - server API di port $PORT kemungkinan belum jalan, atau perangkat"
      echo "           tidak bisa akses keluar (DNS/kuota). Coba: bash start-tunnel.sh status"
      ;;
  esac
  echo "Next     : dari PC -> powershell -ExecutionPolicy Bypass -File kaggle/deploy.ps1 -FromTermux -NoModel -RunTimeoutSec 300 -Logs"
}

# Carikan URL ngrok dari key yang sudah biasa dipakai operator: NGROK_URL (URL penuh)
# lebih dulu, lalu NGROK_DOMAIN (domain polos). Keduanya boleh berada di server/.env
# atau root .env. Sufiks SENGAJA tidak divalidasi: domain plan gratis ngrok sekarang
# berakhiran .ngrok-free.dev (terukur 2026-10-03 pada akun user ini), jadi memaksa
# pola .ngrok-free.app akan menolak URL yang justru benar.
resolve_ngrok_url() {
  local raw dom src=""
  raw="$(read_env NGROK_URL)"; src="NGROK_URL"
  if [ -z "$raw" ]; then raw="$(read_env NGROK_DOMAIN)"; src="NGROK_DOMAIN"; fi
  if [ -z "$raw" ]; then
    echo "Belum ada NGROK_URL / NGROK_DOMAIN di server/.env maupun root .env."
    echo "Contoh bentuk: NGROK_URL=https://abc1234.ngrok-free.dev"
    echo "(domain diambil dari dashboard ngrok > Domains; tutorial: ngrok.md)"
    return 1
  fi
  dom="${raw#https://}"; dom="${dom#http://}"; dom="${dom%%/*}"
  NGROK_URL_RESOLVED="https://$dom"
  NGROK_SRC="$src"
  return 0
}

start_ngrok() {
  resolve_ngrok_url || return 1
  if ! have ngrok; then
    echo "Biner ngrok tidak ada di PATH. Pasang dulu - lihat ngrok.md bagian 1."
    return 1
  fi
  need_pm2 || return 1
  pm2 delete tunnel >/dev/null 2>&1 || true
  # --url memakai dev domain account => alamatnya tidak berubah walau agent direstart.
  pm2 start ngrok --name tunnel -- http "$PORT" --url "$NGROK_URL_RESOLVED" >/dev/null 2>&1 || {
    echo "pm2 gagal men-start ngrok. Cek: pm2 logs tunnel"
    return 1
  }
  pm2 save >/dev/null 2>&1 || true
  publish_url "$NGROK_URL_RESOLVED" "ngrok (URL tetap, dari key $NGROK_SRC)"
}

start_cloudflared() {
  local logf url="" i
  if ! have cloudflared; then
    echo "cloudflared tidak ada di PATH (di perangkat ini biasanya /usr/local/bin/cloudflared)."
    return 1
  fi
  need_pm2 || return 1
  pm2 delete tunnel >/dev/null 2>&1 || true
  pm2 start cloudflared --name tunnel -- tunnel --url "http://localhost:$PORT" >/dev/null 2>&1 || {
    echo "pm2 gagal men-start cloudflared. Cek: pm2 logs tunnel"
    return 1
  }
  pm2 save >/dev/null 2>&1 || true
  logf="${HOME}/.pm2/logs/tunnel-out.log"
  # Quick tunnel mencetak URL-nya sendiri; tanpa menunggu, kita tidak tahu namanya.
  for i in $(seq 1 30); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$logf" 2>/dev/null | tail -1)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "$url" ]; then
    echo "URL tunnel belum muncul di log setelah 30 detik. Lihat: pm2 logs tunnel --lines 40"
    return 1
  fi
  publish_url "$url" "cloudflared quick tunnel (URL berubah tiap restart)"
}

show_status() {
  local url resolved="(NGROK_URL/NGROK_DOMAIN belum diisi)" p=""
  url="$(read_env CLOUDFLARE_TUNNEL_URL)"
  if resolve_ngrok_url 2>/dev/null; then resolved="$NGROK_URL_RESOLVED [key: $NGROK_SRC]"; fi
  echo "Port API      : $PORT"
  echo "Biner         : ngrok=$(have_str ngrok) cloudflared=$(have_str cloudflared) pm2=$(have_str pm2)"
  echo "Ngrok target  : $resolved"
  echo "URL aktif .env: ${url:-(kosong)}"
  # PENTING: `pm2 list` pada daemon yang mati akan MEMUNCULKAN daemon kosong (pernah
  # membuat operator salah menyimpulkan "clipper hilang"). Status tidak boleh punya efek
  # samping itu - cek socket RPC dulu.
  if have pm2 && [ -S "${HOME}/.pm2/rpc.sock" ]; then
    echo "Status PM2    : $(pm2 list 2>/dev/null | grep -E 'tunnel|clipper|gatekeeper' | tr -s ' ' || echo '(daemon kosong / belum ada aplikasi terdaftar)')"
  else
    echo "Status PM2    : (daemon PM2 tidak berjalan - jalankan menu [6] untuk mendaftarkannya)"
  fi
  if [ -n "$url" ]; then
    p="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url/api/health" || true)"
    echo "Uji publik    : ${p:-000} /api/health"
  fi
}

stop_tunnel() {
  if ! have pm2; then
    echo "pm2 tidak ada; tidak ada yang bisa dihentikan lewat PM2."
    return 1
  fi
  pm2 delete tunnel >/dev/null 2>&1 && echo "Tunnel dihapus dari PM2." || echo "Tidak ada app 'tunnel' di PM2."
  pm2 save >/dev/null 2>&1 || true
}

case "${1:-auto}" in
  ngrok) start_ngrok ;;
  cloudflared) start_cloudflared ;;
  auto)
    if resolve_ngrok_url 2>/dev/null && have ngrok; then
      start_ngrok
    else
      if resolve_ngrok_url 2>/dev/null; then
        echo "URL ngrok terkonfigurasi ($NGROK_URL_RESOLVED) tapi biner ngrok belum ada -> memakai cloudflared."
      fi
      start_cloudflared
    fi
    ;;
  status) show_status ;;
  stop) stop_tunnel ;;
  *)
    echo "Pemakaian: bash start-tunnel.sh [auto|ngrok|cloudflared|status|stop]"
    exit 2
    ;;
esac
