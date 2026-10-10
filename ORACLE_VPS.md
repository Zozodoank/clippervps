# Panduan Setup Oracle Lokal (Qwen2.5-VL-3B) di VPS Ubuntu 22.04

Dokumen ini adalah runbook lengkap untuk menyiapkan dan menjalankan **ClipperVPS** secara penuh di VPS Ubuntu 22.04. Semua vonis visual ditangani **Oracle lokal Qwen** (`llama-server` + `server/oracle_local/worker.py`) yang berjalan di VPS yang sama dengan backend. **Kaggle tidak ada di jalur produksi** (folder `kaggle/` hanya arsip, lihat `kaggle/DEPRECATED.md`).

## 1. Persiapan VPS (Otomatis)

Jalankan skrip setup untuk menginstal semua dependensi, Node.js, yt-dlp, whisper.cpp, llama.cpp, model GGUF, venv oracle worker, dan registrasi PM2:

```bash
chmod +x setup-vps.sh
./setup-vps.sh
```

Skrip bersifat idempoten (aman dijalankan berulang). Path resmi yang dipakai (jangan tulis path lain di dokumen/manuale — `ecosystem.config.cjs` adalah sumber kebenaran):

- `llama-server`: `/opt/clippervps-llama/build/bin/llama-server`
- Model: `/opt/clippervps-models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` + `mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf`
- Python worker: venv `/opt/clippervps-oracle-venv` (requests + Pillow)

Verifikasi cepat setelah setup:

```bash
curl http://127.0.0.1:8080/health   # → {"status":"ok"} setelah llama-server online
```

## 2. Reverse Tunnel yt-dlp dari Termux (OPSIONAL)

Hanya needed jika YouTube mulai menolak IP VPS (HTTP 429). Alur kerja normal mencoba download langsung dari IP VPS terlebih dahulu.

1. Di HP Anda (Termux), jalankan:
   ```bash
   ./scripts/phone-proxy-connect.sh
   ```
2. Skrip ini menjalankan `microsocks` di HP dan melakukan SSH Reverse Tunnel ke VPS (mem-forward port 10808 VPS ke microsocks di HP).
3. Di VPS, aktifkan proxy di `server/.env` **hanya saat 429 terjadi**:
   ```env
   # PROXY_URL=socks5h://127.0.0.1:10808   ← uncomment saat proxy aktif
   YTDLP_PROXY_REQUIRED=0                  # 0 = proxy opsional (default), 1 = wajib
   ```
   `downloader.js` (`getSmartProxyArgs`) hanya memakai `PROXY_URL` bila port 10808 benar-benar listening, jadi mengomentarinya saat tidak ada tunnel adalah aman.

## 2b. Routing SEMUA trafik YouTube ke HP (yt-dlp **dan** FFmpeg) — mode wajib-HP

Dipakai bila Anda ingin **setiap** permintaan ke YouTube (termasuk byte video yang diambil FFmpeg saat sampling frame) keluar dari IP HP, meski VPS sudah punya public IP.

Kenapa tidak cukup `PROXY_URL=socks5://...`: FFmpeg **tidak** mendukung SOCKS5 langsung (hanya HTTP proxy lewat `-http_proxy`). Selain itu, bila yt-dlp me-resolve stream URL lewat HP tetapi FFmpeg menariknya dari IP VPS, URL googlevideo (yang terikat IP pada signature) bisa **403**. Solusi: satu **bridge HTTP→SOCKS5** di VPS, dipakai bersama oleh yt-dlp & FFmpeg sehingga exit IP-nya identik.

1. **SOCKS5 HP harus bisa dijangkau VPS.** Aplikasi SOCKS5 di Android umumnya hanya bind ke `127.0.0.1` HP atau LAN Wi-Fi. Pastikan VPS dapat menyentuh `IP_HP:PORT_SOCKS5` (Wi-Fi satu jaringan dengan router yang reachable, HP di-hotspot, atau port-forward). Bila HP di belakang CGNAT seluler dan tak reachable, model ini tidak bisa — pakai tunnel SSH (`scripts/phone-proxy-connect.sh`) sebagai gantinya.
2. **Pasang & konfigurasi privoxy di VPS:**
   ```bash
   sudo apt-get install -y privoxy
   ```
   Tambahkan di `/etc/privoxy/config` (ganti `IP_HP:PORT` dengan endpoint SOCKS5 HP Anda):
   ```
   forward-socks5 /   IP_HP:PORT   .
   listen-address  127.0.0.1:8118
   ```
   ```bash
   sudo systemctl restart privoxy
   curl -s --proxy http://127.0.0.1:8118 https://www.youtube.com -o /dev/null -w '%{http_code}\n'   # → 200 = bridge OK
   ```
3. **Set di `server/.env`** (yt-dlp + FFmpeg sama-sama ke endpoint HTTP ini):
   ```env
   PROXY_URL=http://127.0.0.1:8118
   YTDLP_PROXY_REQUIRED=1   # fail-fast: job gagal bila privoxy/SOCKS5 HP mati
   ```
   `getFfmpegProxyArgs()` mendeteksi endpoint `http://` dan otomatis menyisipkan `-http_proxy` pada spawn FFmpeg di `videoFilterService` (unduh stream & remote-seek), sementara `getSmartProxyArgs()` memakai `--proxy http://127.0.0.1:8118` untuk yt-dlp (`downloader`, `videoFilterService`, `quickPreviewService`).
4. **Terapkan:** `pm2 restart clipper`. Semua jalur jaringan kini lewat HP.

> **Catatan cakupan jalur.** Yang ikut proxy setelah mode ini: download render utama (`downloader.js`), metadata + resolve stream (`videoFilterService` -j/-g), **byte stream FFmpeg** (`videoFilterService`), dan **quick preview** (`quickPreviewService`). Yang sengaja TIDAK: `networkDiagnosticService.checkYouTubeHealth()` (memang menguji IP telanjang) dan `ffprobe`/ffmpeg pada **file lokal** pasca-unduh (tanpa jaringan).

## 3. Menjalankan Layanan menggunakan PM2

Jangan men-start `llama-server`/`worker.py`/backend satu per satu dengan perintah `pm2 start` manual — semuanya sudah terdaftar di **`ecosystem.config.cjs`** (root repo; berekstensi `.cjs` karena root package.json bertipe ESM):

```bash
cd /root/clippervps
pm2 start ecosystem.config.cjs
pm2 save
```

Tiga app yang dikelola PM2:

| Nama app          | Isi                                                         |
|-------------------|-------------------------------------------------------------|
| `llama-server`    | Inferensi Qwen2.5-VL-3B GGUF, loopback `127.0.0.1:8080`     |
| `oracle-worker`   | `server/oracle_local/run-worker.sh` → venv python + `worker.py` |
| `clipper`         | `dev-runner.js` (backend Express + Vite), tunnel OFF        |

`run-worker.sh` memuat `server/.env` (lalu root `.env`) dan meng-export `ORACLE_TOKEN=$API_ACCESS_TOKEN`, sehingga token tidak diduplikasi di konfigurasi PM2. Worker adalah **klien** yang mengklaim antrean batch via loopback `http://127.0.0.1:5000/api/vlm-oracle/*` — **tidak butuh tunnel publik**.

Verifikasi terhubungnya oracle (heartbeat worker maju tiap kali claim, termasuk polling kosong):

```bash
curl -s -H "x-api-token: $API_ACCESS_TOKEN" http://127.0.0.1:5000/api/vlm-oracle/status
# → "connected": true dalam ≤ 30 detik setelah oracle-worker online
```

## 4. Tunnel Publik (OPSIONAL — hanya akses UI jarak jauh)

Job TIDAK bergantung tunnel. Nyalakan hanya jika ingin membuka dashboard dari luar jaringan lokal:

```bash
bash start-tunnel.sh auto     # ngrok URL tetap bila NGROK_DOMAIN terisi, else cloudflared
```

Detail instalasi ngrok/authtoken: lihat `ngrok.md`.

## 5. Benchmark & Log

Untuk melihat log semua proses:
```bash
pm2 logs
pm2 logs oracle-worker --lines 100   # vonis per batch + elapsedMs
```

Untuk me-restart oracle saja (mis. setelah ganti model):
```bash
pm2 restart llama-server oracle-worker
```

Simpan konfigurasi PM2 agar otomatis berjalan saat VPS reboot (Systemd):
```bash
pm2 save
pm2 startup systemd
```

### A. Hardening & Ops (Log & Disk)

**Rotasi Log (Wajib untuk VPS):**
`setup-vps.sh` sudah menginstall `pm2-logrotate`. Manual bila terlewat:
```bash
pm2 install pm2-logrotate
```

**Pembersihan Disk Berkala (Cron):**
Buat cron job mingguan untuk membersihkan folder temp dan job yang gagal agar storage tidak habis.
Buka konfigurasi cron dengan `crontab -e` lalu tambahkan:
```cron
# Bersihkan temp file lama setiap hari Minggu jam 02:00
0 2 * * 0 node /root/clippervps/server/clean-failed-jobs.js
0 2 * * 0 find /root/clippervps/server/temp -type f -mtime +3 -delete
```

---
**Catatan:** `VLM_ORACLE_BASE_URL=http://127.0.0.1:5000` dan `LLAMA_SERVER_URL=http://127.0.0.1:8080/v1` harus ada di `server/.env` agar `worker.py` mengambil job dari backend lokal dan memvonis lewat llama-server. `ORACLE_AUTO_LAUNCH=1` mengizinkan supervisor (`server/services/oracleLocalSupervisor.js`) me-restart `llama-server oracle-worker` via PM2 otomatis saat heartbeat oracle basi.
