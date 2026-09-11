# 📱 Panduan Menjalankan Project VPS dari Termux (Android)

Karena project clipper sudah aktif dan berjalan 24/7 di VPS, Anda **tidak perlu menginstal Node.js / FFmpeg yang berat di HP**. HP Android Anda cukup bertindak sebagai remote kontrol dan penampil tampilan web.

---

## 🚀 Opsi 1: Menggunakan SSH Tunnel (Buka `localhost:3000` di HP) — *Paling Direkomendasikan*

Metode ini meneruskan port server VPS langsung ke HP Anda. Anda bisa membuka browser Chrome di HP dengan alamat `http://localhost:3000` secara privat dan stabil.

### Langkah 1: Install OpenSSH di Termux
Buka aplikasi Termux di HP, lalu ketik perintah berikut (cukup sekali):
```bash
pkg update && pkg install openssh termux-tools -y
```

### Langkah 2: Hubungkan ke VPS
Jalankan perintah ini di Termux:
```bash
ssh -L 3000:localhost:3000 -p 14115 ubuntu@208.76.40.194
```
* Saat diminta password, masukkan:
  ```text
  @Zozo06070786
  ```
  *(Catatan: Saat mengetik password di Linux/Termux, karakter memang tidak muncul di layar demi keamanan, langsung ketik dan tekan Enter).*

### Langkah 3: Buka Browser di HP
Setelah berhasil login ke VPS:
1. Buka browser di HP Anda (Chrome, Brave, atau browser bawaan).
2. Ketik alamat:
   ```text
   http://localhost:3000
   ```
3. Web clipper siap digunakan! Semua proses download video, AI Gemini, dan rendering FFmpeg dilakukan oleh VPS, sehingga HP tetap dingin dan hemat kuota.

---

## ⚡ Opsi 2: Script Otomatis 1 Perintah di Termux (`clipper.sh`)

Agar tidak perlu mengetik perintah panjang setiap kali ingin membuka clipper di Termux, Anda bisa membuat shortcut script otomatis:

### Cara Pasang Shortcut di Termux:
Ketik perintah ini sekali saja di Termux:
```bash
cat << 'EOF' > ~/clipper.sh
#!/data/data/com.termux/files/usr/bin/bash
echo "=================================================="
echo "🎬 Menghubungkan ke Clipper VPS..."
echo "=================================================="
echo "Buka browser HP Anda di: http://localhost:3000"
echo "Tekan Ctrl+C untuk keluar."
echo "=================================================="
termux-open-url http://localhost:3000 2>/dev/null || true
ssh -L 3000:localhost:3000 -p 14115 ubuntu@208.76.40.194 "pm2 logs clipper"
EOF
chmod +x ~/clipper.sh
```

### Cara Menjalankan Selanjutnya:
Kapanpun Anda ingin memakai clipper dari Termux, cukup ketik:
```bash
./clipper.sh
```
Script akan otomatis:
1. Membuka browser HP ke `http://localhost:3000`.
2. Menampilkan log aktivitas VPS secara real-time di layar Termux.

---

## 🌐 Opsi 3: Tanpa Termux Sama Sekali (Cloudflare Tunnel HTTPS)

Jika Anda sedang di luar dan tidak ingin membuka Termux, Anda bisa langsung membuka link HTTPS publik yang aktif:

👉 **URL Aktif Saat Ini:**
```text
https://dimensional-retirement-resolutions-festivals.trycloudflare.com
```

> **Tips:** Simpan / bookmark link di atas di browser HP Anda. Karena berjalan di background PM2 VPS, aplikasi tetap aktif meskipun aplikasi Termux atau PC Anda sedang mati.

---

## 🛠️ Perintah Berguna di VPS (Lewat Termux)

Setelah login SSH ke VPS, Anda bisa menjalankan perintah-perintah berikut:

| Perintah | Fungsi |
| :--- | :--- |
| `pm2 status` | Melihat status service clipper & tunnel |
| `pm2 logs clipper` | Melihat live log proses download, AI, dan render video |
| `pm2 restart all` | Me-restart service clipper dan tunnel |
| `grep CLOUDFLARE_TUNNEL_URL ~/clipperVPS/.env` | Melihat URL publik Cloudflare Tunnel terbaru |
| `exit` | Keluar dari sesi VPS |
