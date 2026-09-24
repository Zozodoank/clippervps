# 📱 Panduan Menjalankan ClipperVPS Native di Termux (Android)

ClipperVPS berjalan **langsung di HP** melalui Termux — tanpa server remote. Semua proses (download YouTube, ekstraksi frame, render FFmpeg, AI Gemini, dan Gatekeeper Python) dieksekusi lokal di perangkat.

---

## 🚀 Setup Sekali Saja

Buka Termux, lalu:

```bash
pkg update -y
pkg install -y git
git clone https://github.com/Zozodoank/clippervps.git
cd clipperVPS
bash setup-termux.sh
```

`setup-termux.sh` akan memasang Node.js, Git, FFmpeg, Python, yt-dlp, serta dependensi `server/` dan `client/`, lalu membuat `server/.env`. Buka `server/.env` dan isi `GEMINI_API_KEY` Anda sebelum menjalankan.

---

## ▶️ Menjalankan Aplikasi

### Mode Interaktif (Foreground)
```bash
cd ~/clipperVPS
npm run dev
```
`dev-runner.js` akan otomatis menyalakan Backend (`:5000`), Frontend (`:3000`), dan Gatekeeper (`:5050`). Setelah muncul pesan siap, buka browser HP di:
```text
http://localhost:3000
```
Tekan `Ctrl + C` untuk berhenti.

### Mode Background + Log Real-Time (PM2)
Opsional, agar aplikasi tetap hidup di background dan log bisa dipantau kapan saja. Gunakan panel kontrol lokal:
```bash
bash menu-vps.sh
```
Menu menyediakan: lihat log PM2, jalankan dev-runner foreground, restart service, dan cek penggunaan RAM/CPU — semuanya **di perangkat Termux ini sendiri**.

---

## 🔄 Mengambil Update Kode

```bash
cd ~/clipperVPS
git pull origin main
npm --prefix server install
npm --prefix client install   # bila perlu
```

---

## ❓ Tips

* Jika `pkg install` lambat, pastikan penyimpanan Termux berada di internal storage.
* Untuk akses dari perangkat lain di jaringan Wi-Fi yang sama, jalankan `npm run dev` lalu buka `http://<IP-HP>:3000` (IP dicetak `dev-runner.js` di terminal). Keduanya harus berada di jaringan yang sama.
