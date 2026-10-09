# Panduan Setup Oracle Lokal (Qwen2.5-VL-3B) di VPS Ubuntu 22.04

Dokumen ini adalah runbook lengkap untuk menyiapkan dan menjalankan **ClipperVPS** secara penuh di VPS Ubuntu 22.04, memindahkan beban kerja visual (VLM) yang sebelumnya di Kaggle ke VPS itu sendiri menggunakan `llama.cpp` dan `worker.py`.

## 1. Persiapan VPS (Otomatis)

Jalankan skrip setup untuk menginstal semua dependensi, Node.js, yt-dlp, whisper.cpp, dan llama.cpp:

```bash
chmod +x setup-vps.sh
./setup-vps.sh
```

**Model VLM:**
Unduh model Qwen2.5-VL-3B-Instruct berformat GGUF ke dalam direktori `server/bin/llama/models/`:
- `qwen2.5-vl-3b-instruct-q4_k_m.gguf`
- `mmproj-qwen2.5-vl-3b-instruct-f16.gguf`

## 2. Reverse Tunnel untuk yt-dlp (Termux)

Karena VPS biasanya diblokir oleh YouTube (HTTP 429), yt-dlp harus merutekan traffic-nya melalui HP Android Anda menggunakan Termux.

1. Di HP Anda (Termux), jalankan:
   ```bash
   ./scripts/phone-proxy-connect.sh
   ```
2. Skrip ini akan menjalankan `microsocks` di HP dan melakukan SSH Reverse Tunnel ke VPS (mem-forward port 10808 VPS ke port microsocks di HP).
3. Di VPS, pastikan `.env` memiliki konfigurasi ini:
   ```env
   PROXY_URL=socks5h://127.0.0.1:10808
   YTDLP_PROXY_REQUIRED=1
   ```

## 3. Menjalankan Layanan menggunakan PM2

Kita menggunakan PM2 untuk menjalankan 3 komponen utama secara berbarengan:
1. Backend Node.js (ClipperVPS)
2. `llama-server` (Inference API lokal)
3. `worker.py` (Oracle worker)

### A. Start `llama-server`

```bash
pm2 start ./server/bin/llama/llama-server \
  --name "llama-server" \
  -- \
  -m ./server/bin/llama/models/qwen2.5-vl-3b-instruct-q4_k_m.gguf \
  --mmproj ./server/bin/llama/models/mmproj-qwen2.5-vl-3b-instruct-f16.gguf \
  -c 4096 -cb -port 8080
```

Verifikasi `llama-server`:
```bash
curl http://127.0.0.1:8080/health
```

### B. Start `worker.py` (Oracle Lokal)

Pastikan virtual environment python aktif jika ada, lalu:

```bash
pm2 start server/oracle_local/worker.py \
  --name "oracle-worker" \
  --interpreter python3
```

### C. Start Backend ClipperVPS

```bash
pm2 start server/server.js \
  --name "clippervps-backend"
```

## 4. Benchmark & Log

Untuk melihat log semua proses:
```bash
pm2 logs
```

Untuk me-restart semua proses:
```bash
pm2 restart all
```

Simpan konfigurasi PM2 agar otomatis berjalan saat VPS reboot (Systemd):
```bash
pm2 save
pm2 startup systemd
```

### D. Hardening & Ops (Log & Disk)

**Rotasi Log (Wajib untuk VPS):**
Gunakan `pm2-logrotate` agar log PM2 tidak memenuhi disk VPS.
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
**Catatan:** Pastikan `VLM_ORACLE_BASE_URL=http://127.0.0.1:5000` ada di `server/.env` agar `worker.py` dapat mengambil job dari backend lokal.
