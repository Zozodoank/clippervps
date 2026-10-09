# ClipperVPS - Project Identity & Architecture Guidelines

> **Catatan untuk AI Agent:**
> Project ini adalah **ClipperVPS** — aplikasi web AI Affiliate Clipper yang berjalan di **VPS Ubuntu 22.04**.
> Target lingkungan runtime: **VPS Ubuntu 22.04** (sebagai server backend + worker AI) dan **HP Android via Termux** (sebagai proxy yt-dlp).
> Repository: `https://github.com/Zozodoank/clippervps.git`

---

## 🖥️ Lingkungan Runtime

Aplikasi dijalankan di VPS dan diakses secara remote/lokal:

* **VPS Ubuntu 22.04:** Target utama. Jalankan backend, `llama-server`, dan `worker.py` (Oracle Lokal) via **PM2**.
* **HP Android / Termux:** Digunakan sebagai reverse tunnel (microsocks) untuk mem-bypass pemblokiran IP YouTube (HTTP 429). Ikuti skrip `scripts/phone-proxy-connect.sh`.

---

## ⚙️ Proses & Service (Semua Lokal)

1. **Backend + Frontend:** Express (port `5000`) + Vite (port `3000`).
2. **Oracle Lokal Qwen (VPS):** Satu-satunya pemutus visual. Menggunakan `worker.py` dan `llama-server` yang berjalan secara lokal di VPS (mem-bypass Kaggle). Semua frame yang dikirim harus berupa JPEG 9:16.
3. **Termux Proxy:** Berjalan di HP, merutekan lalu lintas `yt-dlp` ke HP untuk menghindari 429 dari VPS.

### Verifikasi visual dan voice-over

* Gatekeeper lokal telah dihapus dari jalur runtime. Mode produksi wajib menggunakan Oracle lokal Qwen (VPS); kegagalan, timeout, atau vonis tidak sah menghentikan job.
* Frame langsung dan setiap grid/montage yang diunggah ke Oracle harus tepat 9:16.
* Voice-over hanya memakai Gemini TTS. Jangan menambahkan atau mengaktifkan provider TTS lain.

## ?? Alur Kerja Sinkronisasi Kode

Semua perubahan kode di-commit dan di-push ke repo, lalu ditarik di masing-masing perangkat:

```bash
git push origin main          # dari PC setelah perubahan
git pull origin main          # di perangkat tujuan (PC / Termux)
npm run dev                   # jalankan ulang secara lokal
```

## ?? Cara Akses Aplikasi

1. Di perangkat yang menjalankan: `http://localhost:3000`.
2. Dari perangkat lain di Wi-Fi yang sama: `http://<IP-LAN>:3000`.
