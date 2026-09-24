# ClipperVPS - Project Identity & Architecture Guidelines

> **Catatan untuk AI Agent:**
> Project ini adalah **ClipperVPS** — aplikasi web AI Affiliate Clipper yang berjalan **sepenuhnya lokal** di mesin developer.
> Target lingkungan runtime: **PC Windows** dan **HP Android via Termux**. Tidak ada server/cloud remote.
> Repository: `https://github.com/Zozodoank/clippervps.git` (hanya sebagai sumber kode untuk `git pull` lokal).

---

## 🖥️ Lingkungan Runtime

Aplikasi dijalankan langsung di perangkat user (bukan di-hosting remote):

* **PC Windows:** jalankan lewat [dev-runner.js](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/dev-runner.js) (`npm run dev`). Backend Express + Frontend Vite + Gatekeeper Python aktif satu perintah.
* **HP Android / Termux:** ikuti [CARA_JALANKAN_TERMUX.md](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/CARA_JALANKAN_TERMUX.md). Setup sekali jalan via [setup-termux.sh](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/setup-termux.sh). Panel kontrol lokal tersedia di [menu-vps.sh](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/menu-vps.sh).

---

## ⚙️ Proses & Service (Semua Lokal)

1. **Backend + Frontend (dev-runner.js):**
   * Express Backend (default port `5000`) + Vite Frontend (port `3000`).
   * FFmpeg, yt-dlp, dan integrasi Google Gemini / OpenRouter AI.
2. **Gatekeeper (`server/gatekeeper/service.py`, port `5050`):**
   * AI Local Frame Gatekeeper. Dip-auto-start-kan oleh `dev-runner.js`.
   * Pipeline CPU vision: MediaPipe BlazeFace (faceless), DBNet PP-OCRv4 ONNX (deteksi subtitle terbakar & promo overlay), dan MobileNetV3 (klasifikasi adegan natural vs kartun/bumper).
3. **Termux (opsional):** bisa dijalankan via **PM2** lewat `menu-vps.sh` untuk mode background + log real-time. Ini murni PM2 **di perangkat Termux itu sendiri**, bukan remote.

---

## 🔄 Alur Kerja Sinkronisasi Kode

Semua perubahan kode di-commit dan di-push ke repo, lalu ditarik di masing-masing perangkat:

```bash
git push origin main          # dari PC setelah perubahan
git pull origin main          # di perangkat tujuan (PC / Termux)
npm run dev                   # jalankan ulang secara lokal
```

---

## 🌐 Cara Akses Aplikasi

1. **Di perangkat yang menjalankan:** `http://localhost:3000`.
2. **Dari perangkat lain di Wi-Fi yang sama:** buka alamat `http://<IP-LAN>:3000` yang dicetak `dev-runner.js` di terminal.
