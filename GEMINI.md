# ClipperVPS - Project Identity & Architecture Guidelines

> **Catatan untuk Antigravity IDE / AI Agent:**
> Project ini adalah **ClipperVPS** yang telah dideploy dan berjalan di **Server VPS Ubuntu 22.04**.
> Repository utama: `https://github.com/Zozodoank/clippervps.git`

---

## 🖥️ Identitas & Lingkungan VPS

* **Public IP Server:** `208.76.40.194`
* **SSH Port:** `14115` (Diteruskan ke port internal `22`)
* **Arsitektur Jaringan:** NAT VPS (IP Lokal: `192.168.14.115`)
* **Username:** `ubuntu`
* **Password:** Dikelola di `.env` (`VPS_PASSWORD`)
* **Autentikasi SSH:** Menggunakan SSH Key lokal (`~/.ssh/id_rsa.pub` terpasang di VPS `~/.ssh/authorized_keys`), sehingga koneksi SSH tidak memerlukan input password interaktif.
* **Direktori Project di VPS:** `/home/ubuntu/clipperVPS`

---

## ⚙️ Manajemen Proses & Service di VPS

Aplikasi di server VPS dikelola menggunakan **PM2**:
1. **`clipper`**:
   * Menjalankan `dev-runner.js` (Express Backend port 5000 + Vite Frontend port 3000).
   * Menjalankan FFmpeg 4.4.2, yt-dlp, dan integrasi Google Gemini / OpenRouter AI.
2. **`tunnel`**:
   * Menjalankan Cloudflare Tunnel (`cloudflared`) yang meneruskan `http://localhost:3000` ke URL publik HTTPS gratis.
   * Nilai URL aktif otomatis diperbarui di file `.env` (`CLOUDFLARE_TUNNEL_URL`).
3. **`gatekeeper`**:
   * Menjalankan `server/gatekeeper/service.py` (AI Local Frame Gatekeeper port 5050).
   * Real-time CPU vision pipeline: MediaPipe BlazeFace (faceless), DBNet PP-OCRv4 ONNX (deteksi subtitle terbakar & promo overlay), dan MobileNetV3 (klasifikasi adegan natural vs kartun/bumper).

---

## 🔄 Alur Kerja Sinkronisasi Kode (Deployment)

1. Semua perubahan kode di folder lokal ini harus di-commit dan di-push ke:
   ```bash
   git push origin main
   ```
2. Untuk menerapkan perubahan di server VPS:
   * Script [JALANKAN_VPS.cmd](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/JALANKAN_VPS.cmd) otomatis menjalankan `git pull origin main` setiap kali aplikasi dijalankan.
   * Atau jalankan manual via SSH:
     ```bash
     ssh -p 14115 ubuntu@208.76.40.194 "cd ~/clipperVPS && git pull && pm2 restart all"
     ```

---

## 🌐 Cara Akses Aplikasi

1. **Dari PC / Laptop (SSH Tunnel):**
   * Jalankan [JALANKAN_VPS.cmd](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/JALANKAN_VPS.cmd) lalu pilih menu `[1]`.
   * Akses melalui browser di: `http://localhost:3000`.
2. **Dari HP Android / Termux:**
   * Ikuti petunjuk di [CARA_JALANKAN_TERMUX.md](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/CARA_JALANKAN_TERMUX.md).
3. **Akses Publik Langsung:**
   * Menggunakan URL aktif di variabel `CLOUDFLARE_TUNNEL_URL` pada file `.env`.
