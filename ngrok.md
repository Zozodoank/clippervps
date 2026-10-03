# Ngrok untuk ClipperVPS (URL publik permanen untuk Oracle Kaggle)

Dokumen ini menggantikan kebiasaan "salin URL trycloudflare setiap restart". Ngrok plan gratis
memberi **satu dev domain tetap** yang tidak berubah, jadi `VLM_ORACLE_BASE_URL` cukup diisi
sekali. Semua langkah di bawah terverifikasi pada perangkat ini (Termux + proot Ubuntu 26.04,
`aarch64`, API lokal di port **5000**).

Fakta plan gratis (dari dokumentasi ngrok, diakses 2026-10-03):

| Sumber daya | Batas gratis |
|---|---|
| Dev domain | 1, otomatis diberikan, **tidak bisa diganti** (dan karena itu tidak berubah) |
| Data keluar | 1 GB / bulan |
| Request HTTP | 20.000 / bulan |
| Endpoint online / agent | 3 |
| Timeout endpoint | **tidak ada** — endpoint gratis boleh hidup terus |
| Halaman interstitial | hanya untuk trafik browser HTML, **tidak** untuk panggilan API/skrip |

---

## 0. Ringkas (kalau agent ngrok sudah terpasang)

```bash
# di dalam proot Ubuntu (prompt #), dari root repo
bash start-tunnel.sh            # auto: ngrok bila NGROK_URL/NGROK_DOMAIN terisi
bash start-tunnel.sh status     # hanya melihat; tidak membangunkan daemon PM2 kosong
```
```powershell
# dari PC: kirim URL + token ke Kaggle, lalu push kernel
cd "c:\Users\SEMOGA AWET\Documents\clipperVPS"
powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -FromTermux -RunTimeoutSec 420
```

## 1. Pasang agent ngrok (WAJIB di proot Ubuntu, bukan Termux native)

**Kesalahan yang paling sering terjadi (terjadi juga pada user ini, 2026-10-03):** perintah
di halaman ini dijalankan di dalam proot Ubuntu. Dari prompt Termux (`~ $`) semuanya akan gagal
dengan wajah bingung:
`tar: /usr/local/bin: Cannot open: No such file or directory`, lalu
`curl: (23) Failure writing output` (itu hanya efek samping SIGPIPE karena tar mati - bukan
masalah jaringan), lalu `cd: /root/clippervps: No such file or directory`.

Bukti kenapa bukan cuma soal direktori (terukur 2026-10-03 pada perangkat ini):
Termux native memakai libc **bionic** (`PREFIX=/data/data/com.termux/files/usr`, dan
`/lib/ld-linux-aarch64.so.1` TIDAK ADA), sedangkan ngrok `linux-arm64` adalah ELF **glibc**.
Jadi menaruhnya di `$PREFIX/bin` pun akan menghasilkan `CANNOT LINK EXECUTABLE`. proot Ubuntu
memang tempatnya: `aarch64`, `ldd (Ubuntu GLIBC 2.43-2ubuntu2.4)`, `/usr/local/bin` ada,
`curl`/`tar`/`gzip` ada - dan di situlah `cloudflared` Anda tinggal selama ini.

Cara paling aman: jalankan dari prompt Termux TANPA perlu login interaktif (satu baris,
tinggal tempel):

```bash
proot-distro run ubuntu -- bash -c 'curl -sSL -o /tmp/ngrok.tgz https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz && tar xzf /tmp/ngrok.tgz -C /usr/local/bin && ngrok version'
```

(URL di atas terverifikasi mengembalikan `HTTP/1.1 200 OK`, panjang 10.994.396 byte.
Kalau berubah, ambil tautan terbaru dari https://ngrok.com/download dengan platform
**Linux / arm64** - jangan tebak angka versinya.)

Atau masuk dulu, baru jalankan langkah satu per satu:

```bash
proot-distro login ubuntu        # prompt berubah menjadi root@localhost:...:/root#
cd /tmp
curl -sSL -o ngrok.tgz https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
tar xzf ngrok.tgz
mv -f ngrok /usr/local/bin/ngrok
ngrok version
```

Konvensi placeholder di dokumen ini: `TOKEN_ANDA` ditulis apa adanya untuk diganti, sedangkan
`<...>` **jangan sampai ikut tertempel** - `<` adalah operator redirect di bash, sehingga
`ngrok config add-authtoken <TEMPEL>` menghasilkan `syntax error near unexpected token newline`.

Alternatif lewat repo resmi ngrok (satu kali, lalu dapat update lewat `apt`):

```bash
curl -sSL https://apt.ngrok.com/ngrok-archive-keyring.gpg -o /usr/share/keyrings/ngrok-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/ngrok-archive-keyring.gpg] https://apt.ngrok.com stable main" > /etc/apt/sources.list.d/ngrok.list
apt update && apt install -y ngrok
```

## 2. Authtoken

Ambil dari dashboard ngrok (**Your Authtoken**), lalu:

```bash
ngrok config add-authtoken TOKEN_ANDA
```

Tempel **isi token saja**, tanpa apa pun di sekelilingnya. Kalau yang tertempel masih
`<TEMPEL-DARI-DASHBOARD>`, bash menafsirkan `<` sebagai redirect dan keluar dengan
`` syntax error near unexpected token `newline' `` - dan karena perintahnya mati di baris
pertama, token tidak pernah tersimpan tanpa Anda sadari.

Perintah ini menulis ke berkas konfigurasi agent (`/root/.config/ngrok/ngrok.yml` di proot),
sehingga token tersimpan permanen dan **tidak perlu** di-export setiap sesi. Jangan taruh token
di `server/.env` dan jangan pernah commit berkas `ngrok.yml`.

Cara memastikan tersimpan tanpa membuka isinya (yang dicetak hanya keberadaan berkas dan
jumlah baris kuncinya):

```bash
ls -l /root/.config/ngrok/ngrok.yml && grep -c authtoken /root/.config/ngrok/ngrok.yml
```

Kalau langkah ini dilewatkan, **setiap** percobaan tunnel akan ditolak lebih dulu dengan
`ERR_NGROK_4018 - This ngrok session is not authenticated` (terukur di perangkat ini, dan
itu pula yang membuat `start-tunnel.sh` sekarang menolak mendaftarkan tunnel ke PM2: ia
mencoba satu sesi 8 detik tanpa PM2, dan kalau ditolak, skrip mencetak perintah isian token
lalu berhenti - bukan membiarkan PM2 mengulang proses yang gagal di HP ber-RAM ketat).

## 3. Dapatkan URL tetap Anda

Buka dashboard ngrok → menu **Domains**. Di plan gratis tercantum satu **dev domain**, bentuknya
misal `a1b2c3d4.ngrok-free.app`. Domain itu sudah jadi milik akun Anda dan tidak berubah,
tapi **belum di-klaim ke endpoint** sampai Anda memakainya sekali.

Catat persis seperti yang ditampilkan (sufiks bisa `.ngrok-free.app` atau `.ngrok-free.dev`
pada akun lama — pakai yang tertulis di dashboard Anda, jangan tebak). Terukur pada akun user
ini (2026-10-03): domain gratis yang diberikan berakhiran **`.ngrok-free.dev`**, jadi contoh
berakhiran `.app` di halaman ini jangan ditelan mentah-mentah.

## 4. Jalankan tunnel (uji manual dulu)

```bash
ngrok http 5000 --url https://DOMAIN_ANDA
```

Yang harus Anda lihat di baris **Forwarding**:

```
Forwarding   https://DOMAIN_ANDA -> http://localhost:5000
```

Kalau ngrok menolak `--url` (mis. domain belum siap/typo), jalankan `ngrok http 5000` tanpa
`--url` dan baca URL yang muncul — plan gratis memakai dev domain Anda sebagai default untuk
endpoint pertama. **Uji ketetapan URL**: `Ctrl+C`, jalankan ulang perintah yang sama, dan
yakini URL-nya identik. Kalau berubah, berarti yang aktif bukan dev domain (acak) — periksa
kembali langkah 3.

## 5. Uji dari PC (ini bagian yang menentukan)

```powershell
$ng = "https://DOMAIN_ANDA"
curl.exe -s "$ng/api/health"
# harapan: {"status":"ok","service":"clipper-api",...}

$t = (Select-String -Path server\.env -Pattern '^API_ACCESS_TOKEN=').Line.Split('=',2)[1]
curl.exe -s -H "x-api-token: $t" "$ng/api/vlm-oracle/status"
```

`/api/health` memang boleh tanpa token. `/api/vlm-oracle/status` **wajib** membawa
`x-api-token`. Dua kemungkinan jawaban yang bukan sukses, dan artinya:

| Jawaban | Arti | Tindakan |
|---|---|---|
| `503` dari `/vlm-oracle/*` | `API_ACCESS_TOKEN` di perangkat kosong — oracle **sengaja** menolak melayani | isi token di `server/.env` (perangkat yang menjalankan server), restart |
| `401` padahal token benar | yang diuji adalah URL lama/acak, atau ngrok belum forward ke 5000 | cek baris Forwarding, ulangi langkah 4 |
| `404` + body `ERR_NGROK_3200 "endpoint is offline"` | domain Anda **sudah benar dan terdaftar**, hanya agent-nya belum jalan (terukur 2026-10-03: edge menjawab dalam 0,6 s) | jalankan `bash start-tunnel.sh` (atau `ngrok http` langkah 4) di mesin yang sama dengan server API |

## 6. Autostart - pakai `start-tunnel.sh` (disarankan)

```bash
# di dalam proot Ubuntu, dari root repo
bash start-tunnel.sh              # auto: ngrok bila NGROK_URL/NGROK_DOMAIN terisi
bash start-tunnel.sh ngrok        # paksa ngrok
bash start-tunnel.sh cloudflared  # kembali ke quick tunnel
bash start-tunnel.sh status       # hanya melihat; sengaja TIDAK membangunkan daemon PM2
bash start-tunnel.sh stop
```

Satu panggilan melakukan empat hal: `pm2 delete tunnel` (idempotent) → `pm2 start ngrok --name
tunnel -- http 5000 --url <URL>` → `pm2 save` → uji `GET <URL>/api/health` dengan pengulangan
8 x 2 detik (agent ngrok butuh 1-5 detik; sekali cek saja membaca keadaan sehat sebagai
kegagalan), lalu menulis URL aktif ke `server/.env`.

Lewat menu Termux: `bash menu-vps.sh` → **[5] TUNNEL PUBLIK** (start/status/stop) dan
**[6] DAFTARKAN PENGAWASAN PM2** yang sekaligus mendaftarkan `clipper` (dev-runner) dengan
`--max-memory-restart 900M`, mencoba `pm2 resurrect` bila daemonnya kosong, lalu tunnel.

Penting dan sudah terbukti di perangkat ini: **proses yang hanya hidup di dalam terminal akan
mati bersama terminalnya** (`proot-distro` berjalan dengan `--kill-on-exit`). PM2 mengawasi
`clipper` (dev-runner), `gatekeeper`, dan tunnel — tanpa itu job render mati di tengah jalan
tanpa pesan error, seperti yang terjadi pada `auto_f6bc7736ef`.

Setara manual (inilah perintah yang dijalankan skrip):

```bash
pm2 start ngrok --name tunnel -- http 5000 --url https://DOMAIN_ANDA
pm2 save
pm2 logs tunnel --lines 20
```

Nama app sengaja `tunnel` (bukan `tunnel-ngrok`) untuk kedua jalur, supaya `menu-vps.sh` dan
perintah lain tidak perlu tahu ngrok atau cloudflared yang sedang aktif.

## 7. Sambungkan ke ClipperVPS

Cukup satu baris - boleh di **root `.env`** (file ini memang dibaca `envLoader`) atau
`server/.env`:

```bash
NGROK_URL=https://DOMAIN_ANDA
```

`start-tunnel.sh` juga menerima `NGROK_DOMAIN=xxx.ngrok-free.dev` (domain polos); `NGROK_URL`
yang menang. Sufiks sengaja tidak divalidasi - domain plan gratis sekarang berakhiran
`.ngrok-free.dev`, dan memaksa pola `.ngrok-free.app` akan menolak URL yang justru benar.

Sisanya dikerjakan skrip: `CLOUDFLARE_TUNNEL_URL`, `PUBLIC_BASE_URL`, dan
`VLM_ORACLE_BASE_URL` ditulis otomatis ke `server/.env` (key lama ditimpa, key lain utuh).
Yang masih Anda nyalakan sendiri:

```bash
VISION_VERIFY_MODE=oracle
API_ACCESS_TOKEN=TOKEN_ANDA   # wajib; tanpa ini /vlm-oracle/* menjawab 503 dengan sengaja
```

Jebakan konfigurasi (terbaca dari kode, bukan dugaan): `server/utils/paths.js` menyusun
`envCandidates` = `server/.env` → `.env.txt` → **root `.env`** → `process.cwd()/.env`, dan
`envLoader.reloadEnvironment()` menugaskan `process.env[key]` tanpa mengecek apakah key sudah
terisi - artinya **root `.env` MENIMPA `server/.env`** untuk key yang sama. Jangan menaruh URL
yang berbeda di dua file itu. `start-tunnel.sh` meniru urutan yang sama supaya shell dan Node
tidak pernah melihat dua nilai berbeda - bahkan ia **menulis key URL ke kedua file** bila key itu
sudah ada di keduanya (terukur: root .env perangkat masih menyimpan quick tunnel
trycloudflare yang mati di baris 44; kalau hanya `server/.env` yang ditulis, `deploy.ps1
-FromTermux` mengirim URL baru ke Kaggle sementara proses Node tetap memakai URL mati).
Skrip mencetak baris `(key ... juga diperbarui di root .env)` saat melakukan itu.

`CLOUDFLARE_TUNNEL_URL` / `PUBLIC_BASE_URL` dipakai untuk dua hal: izin CORS
(`getExplicitCorsOrigins`) dan peringatan postur keamanan saat boot. **Nama variabelnya masih
berawalan `CLOUDFLARE_`, tapi isinya URL ngrok** — `kaggle/deploy.ps1 -FromTermux` memang
mengambil URL dari variabel bernama itu. Ini disengaja agar tidak ada kode yang berubah; kalau
membingungkan, suatu saat bisa diberi alias `NGROK_TUNNEL_URL`.

## 8. Sambungkan ke Kaggle (satu kali)

Metadata kernel Kaggle tidak mendukung env var, jadi URL + token dikirim sebagai **dataset privat
kecil** (`oracle_config.json`) oleh `deploy.ps1`. Dari PC:

```powershell
cd "c:\Users\SEMOGA AWET\Documents\clipperVPS"

# (a) otomatis ambil URL+token dari Termux lewat SSH, lalu push kernel
powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -FromTermux -RunTimeoutSec 420

# (b) atau sebut manual (dipakai kalau SSH sedang tidak bisa dipakai)
powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 `
  -TunnelUrl https://DOMAIN_ANDA -WithToken -RunTimeoutSec 420
```

Karena URL ngrok tetap, **langkah ini hanya perlu sekali** — tidak seperti quick tunnel yang
memaksa Anda mengirim ulang URL setiap server restart. (Env var mengalahkan isi dataset, jadi
penimpaan cepat tetap bisa lewat Kaggle > Account > Environment Variables:
`VLM_ORACLE_BASE_URL` dan `API_ACCESS_TOKEN`.)

## 9. Uji sambungan tanpa membakar kuota GPU

```powershell
powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -FromTermux -NoModel -RunTimeoutSec 300 -Logs
```

`-NoModel` menjalankan kernel dalam mode dry-run: ia **claim batch, mengunduh frame lewat
tunnel, lalu berhenti** tanpa memuat Qwen2.5-VL. Baris log-nya (prefiks `[  detik]` adalah
waktu berjalan kernel):

```
[   41.8s] claim b-7f3a (8 frame, job=auto_xxxx scene=2)
[   46.2s]   dry-run: 8/8 frame diunduh, total 210 KB (rata-rata 26 KB/frame)
```

Kalau gagal, bentuknya begini — dan itu masalah token/tunnel, bukan model:

```
[   44.0s]   dry-run GAGAL unduh frame: /api/vlm-oracle/frames/b-7f3a/0 -> HTTP 401
```

## 10. Hemat kuota request (baca ini sebelum menyalakan kernel 24 jam)

Satu batch oracle = 1 `claim` + N unduhan frame + 1 `result` ≈ **10 request**. Kuota gratis
20.000 request/bulan, jadi kerja nyata ≈ 2.000 batch/bulan — cukup.

Yang mengikat justru **polling saat antrean kosong**: kernel mengulang `claim` tiap
`ORACLE_POLL_SEC` dengan backoff ke `ORACLE_IDLE_SLEEP_MAX` (default 30 s). Idle 30 s ≈
120 request/jam ≈ **1.400 request per sesi 11,5 jam** ≈ 42.000/bulan kalau dinyalakan tiap hari
→ kuota jebol dalam seminggu, padahal tidak ada vonis yang dihasilkan.

Tambahkan di `oracle_config.json` (ditulis oleh `deploy.ps1`, key extra diterima kernel):

```json
{ "ORACLE_IDLE_SLEEP_MAX": "180", "ORACLE_POLL_SEC": "5", "ORACLE_MAX_MINUTES": "240" }
```

Idle 180 s menurunkan biaya polling kira-kira 6x, dan `ORACLE_MAX_MINUTES` membatasi durasi
sesi. Aturan praktis: **nyalakan kernel hanya saat Anda mengirim job**, bukan sebagai layanan
harian. Data keluar 1 GB/bulan ≈ 5.000 batch pada 26 KB/frame — request akan habis lebih dulu.

## 11. Keamanan: apa yang berubah karena URL permanen

- Endpoint `/api/vlm-oracle/*` tetap terkunci: jawab **503** bila `API_ACCESS_TOKEN` kosong,
  **401** bila token salah, path frame divalidasi terhadap direktori yang dikenal, dan ada
  rate-limiter per endpoint. Notebook memakai `x-api-token` untuk claim, frame, dan result.
- Yang **tidak** berkacamata adalah allowlist publik di `server/api/middleware/tokenAuth.js`:
  `/api/video/`, `/api/audio/`, `/api/download/`, `/api/video-player-file`,
  `/api/rejected-frames`, `/api/health`, `/api/niches`, `/api/daily-limit`. Dengan URL acak
  (quick tunnel) paparan ini praktis nol; dengan **URL permanen**, berkas-berkas itu bisa dibaca
  siapa pun yang tahu alamatnya. Kalau klip Anda sensitif sebelum rilis, cabut prefix media dari
  allowlist (atau batasi hanya saat `authMode != 'open'`) — itu perubahan kecil, tinggal bilang.
- Token yang dipakai notebook adalah token API utama (bukan token khusus oracle), jadi kebocoran
  `oracle_config.json` = akses penuh API. Dataset itu privat; jangan pernah menempelkannya ke
  kernel publik, dan jangan mencetaknya ke log.

## 12. Troubleshooting

| Gejala | Penyebab paling mungkin | Cek |
|---|---|---|
| `ngrok: command not found` di Termux | agent dipasang di proot, bukan Termux | `proot-distro login ubuntu` dulu |
| Tunnel hidup tapi `502/504` dari ngrok | server lokal belum jalan di 5000 | `curl -s localhost:5000/api/health` di proot |
| `401` padahal token benar | URL yang dipakai adalah URL lama/acak | cocokkan dengan baris Forwarding PM2 |
| Browser menampilkan halaman "You are about to visit" | interstitial plan gratis (hanya HTML) | untuk API tidak berpengaruh; skrip bisa kirim header `ngrok-skip-browser-warning: 1` |
| Kaggle `claim` sukses tapi frame `410` | frame job sudah dibersihkan dari disk sebelum divonis | naikkan `VLM_ORACLE_TIMEOUT_SEC`/perkecil batch, atau jalankan oracle lebih dekat ke tahap render |
| Kuota request habis di tengah bulan | polling idle terlalu rapat | lihat langkah 10 |
| Tunnel mati saat HP tidur | Android mematikan radio/aplikasi latar | nyalakan "battery optimization off" untuk Termux, dan biarkan PM2 me-restart (`pm2 save`) |

## 13. Kalau ingin kembali ke cloudflared

Tidak ada yang perlu di-rollback: cukup jalankan tunnel lama dan kirim URL-nya sekali lagi.

```bash
pm2 start "cloudflared tunnel --url http://localhost:5000" --name tunnel
pm2 save
```

Perbedaan yang Anda rasakan: URL quick tunnel **berubah setiap restart**, sehingga
`deploy.ps1 -FromTermux` harus dijalankan ulang setiap hari, dan `VISION_VERIFY_MODE=oracle`
tidak akan menghasilkan apa-apa sebelum itu (gagal-diam/open, vonis tidak pernah datang).
