# 📱 Panduan Menjalankan Project VPS & Memantau Log dari Termux (Android)

Karena project clipper sudah aktif dan berjalan 24/7 di VPS menggunakan **PM2**, log aplikasi tidak otomatis mengalir di terminal saat baru login, melainkan tersimpan di sistem logger background.

---

## 📋 Cara Melihat Log Real-Time di Termux

### Cara 1: Perintah Cepat Setelah Login SSH
Jika Anda sudah terhubung ke VPS (`ubuntu@ubuntu:~$`), cukup ketik salah satu perintah berikut:
```bash
logs
```
*(atau ketik `pm2 logs clipper`)*.
Layar Termux Anda akan langsung memunculkan log real-time aktivitas download video, ekstraksi frame, FFmpeg, dan analisa AI Gemini.
> **Untuk berhenti melihat log:** Tekan `Ctrl + C`.

---

### Cara 2: Membuka Menu Interaktif VPS di Termux
Kami telah menyediakan panel menu khusus Termux di VPS. Cukup ketik:
```bash
menu
```
*(atau `~/clipperVPS/menu-vps.sh`)*.
Menu ini menyediakan pilihan:
* **[1]** Lihat Log Real-Time (PM2)
* **[2]** Jalankan Dev-Runner Live Langsung di Layar (Foreground)
* **[3]** Cek URL Cloudflare Tunnel
* **[4]** Restart Service Clipper
* **[5]** Cek RAM & CPU Server

---

## 🚀 Cara Akses Web Clipper (`localhost:3000`) dari Termux

### Langkah 1: Install OpenSSH di Termux
Ketik perintah ini di Termux (cukup sekali di awal):
```bash
pkg update && pkg install openssh termux-tools -y
```

### Langkah 2: Hubungkan SSH Tunnel (Port Forwarding & Anti-Blokir IP)
Jalankan perintah ini di Termux (catatan: flag `-R 10808` membagikan koneksi internet HP Anda ke VPS sebagai SOCKS5 proxy agar tidak diblokir YouTube, dan `-t` agar log real-time tampil di HP):
```bash
ssh -t -R 10808 -L 3000:localhost:3000 -p REDACTED_PORT ubuntu@REDACTED_IP "pm2 logs clipper"
```
* Masukkan password VPS:
  ```text
  REDACTED_PASSWORD
  ```
* Layar Termux Anda akan langsung menampilkan **live streaming log** server!
* Koneksi internet seluler HP Anda otomatis menjadi tameng anti-blokir untuk unduhan YouTube di VPS!

### Langkah 3: Buka Browser di HP
Sambil Termux tetap terbuka di background:
1. Buka browser di HP Anda (Chrome / Brave).
2. Kunjungi alamat:
   ```text
   http://localhost:3000
   ```
3. Web clipper siap digunakan. Semua beban download YouTube 1080p, render FFmpeg, dan AI diproses di VPS.

---

## ⚡ Shortcut Otomatis 1 Perintah di Termux (`clipper.sh`)

Agar tidak perlu mengetik perintah panjang setiap kali ingin membuka clipper di Termux:

### Cara Pasang Shortcut:
Salin dan jalankan perintah ini di Termux (hanya perlu sekali saja):
```bash
cat << 'EOF' > ~/clipper.sh
#!/data/data/com.termux/files/usr/bin/bash
echo "=================================================="
echo "🎬 Menghubungkan ke Clipper VPS & Menampilkan Log..."
echo "=================================================="
echo "Buka browser HP Anda di: http://localhost:3000"
echo "Tekan Ctrl+C untuk keluar."
echo "=================================================="
termux-open-url http://localhost:3000 2>/dev/null || true
ssh -t -L 3000:localhost:3000 -p REDACTED_PORT ubuntu@REDACTED_IP "pm2 logs clipper"
EOF
chmod +x ~/clipper.sh
```

### Cara Pakai Selanjutnya:
Setiap kali ingin menggunakan clipper di Termux, cukup ketik:
```bash
./clipper.sh
```
Otomatis:
1. Membuka browser HP ke `http://localhost:3000`.
2. Menampilkan log aktivitas real-time di layar Termux.

---

## 🌐 Opsi Tanpa Termux (Cloudflare Tunnel HTTPS)

Jika Anda sedang di luar dan tidak ingin membuka Termux:
👉 **URL Aktif Saat Ini:**
```text
https://REDACTED_TUNNEL.example.com
```
Simpan / bookmark URL di atas di browser HP Anda.
