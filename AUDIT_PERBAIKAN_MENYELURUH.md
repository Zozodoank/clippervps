# 🔍 Audit & Perbaikan Menyeluruh — ClipperVPS

> **Tanggal audit:** 17 September 2026
> **Cakupan:** Seluruh repo (`server/` 3988 baris + `services/` ±12.000 baris, `client/` React/Vite, script shell/.cmd, gatekeeper Python, hygiene repo)
> **Metode:** Inspeksi manual menyeluruh (keamanan, keandalan, performa, kebersihan kode) + pengujian runtime + build verifikasi
> **Dokumen pendahulu:** `AUDIT_HEMAT_TOKEN.md` (audit hemat token AI, sebagian rekomendasinya sudah diterapkan — lihat §5)

---

## 1. RINGKASAN EKSEKUTIF

| # | Temuan | Severity | Status |
|---|--------|----------|--------|
| 1 | **`isRetrying` tidak terdefinisi di `App.jsx`** → `ReferenceError` setiap kali tombol Generate/Retry ditekan, UI macet di loading selamanya | 🔴 KRITIS | ✅ Diperbaiki |
| 2 | **Nol autentikasi pada seluruh endpoint destruktif** yang terekspos via Cloudflare Tunnel publik (`/api/restart` menjalankan `update.sh` + `pm2 restart`, `/api/upload-cookies`, hapus job, auto mode, dll.) — siapa pun yang tahu URL = penuh kendali server | 🔴 KRITIS | ✅ Diperbaiki |
| 3 | **Server bisa crash total hanya karena health check**: auto-download yt-dlp melempar *unhandled `error` event* (mis. TLS/proxy bermasalah) → `uncaughtException` → proses mati | 🔴 KRITIS | ✅ Diperbaiki |
| 4 | **API key user tersimpan plaintext di `jobs.json`** (`job.geminiApiKey` ikut di-persist) | 🟠 TINGGI | ✅ Diperbaiki |
| 5 | **Bug `duration` di `frameExtractor.js`**: opsi `duration` dikirim caller tetapi tidak pernah didestrukturisasi → `ReferenceError` di jalur fallback interval | 🟠 TINGGI | ✅ Diperbaiki |
| 6 | **Event loop terblokir** oleh `execSync` di 3 lokasi (audit klip 2×3 detik/klip dengan biner `ffmpeg` *hardcoded*, mix TTS Edge, konversi TTS Gemini) — UI semua pengguna beku saat itu | 🟠 TINGGI | ✅ Diperbaiki |
| 7 | **`jobs.json` ditulis non-atomik** — crash/mati listrik di tengah write = seluruh riwayat job rusak | 🟠 TINGGI | ✅ Diperbaiki |
| 8 | **CORS terbuka untuk semua origin** (`app.use(cors())`) | 🟠 TINGGI | ✅ Diperbaiki |
| 9 | **Memory leak**: `jobProgress`, `autoRuns`, `autoRetryRuns` tidak pernah dibersihkan — tumbuh tanpa batas di proses PM2 berjalan berminggu-minggu | 🟡 SEDANG | ✅ Diperbaiki |
| 10 | **SSE tanpa heartbeat** → Cloudflare Tunnel/proxy memutus koneksi progress yang idle | 🟡 SEDANG | ✅ Diperbaiki |
| 11 | `cookies.txt` (sesi login YouTube) ditulis dengan permission default 0644 | 🟡 SEDANG | ✅ Diperbaiki (0600) |
| 12 | `/api/open-folder` memakai `exec()` string shell (tidak perlu, rawan) | 🟡 SEDANG | ✅ Diperbaiki (`execFile`) |
| 13 | Spam percobaan download yt-dlp di setiap pemanggilan saat jaringan gagal | 🟡 SEDANG | ✅ Diperbaiki (negative-cache 10 menit) |
| 14 | `temp_old_ai.js` — 91 KB file mati ber-encoding UTF-16 di repo | 🟢 RENDAH | ✅ Dihapus |
| 15 | README berisi link `file:///c:/Users/...` (path PC pribadi) & field `model: 'gpt-4o-mini'` usang di state form | 🟢 RENDAH | ✅ Diperbaiki |
| 16 | Guard SSRF untuk URL eksternal dari input user (`productImage`, `shopeeLink`) belum ada | 🟡 SEDANG | ✅ Diperbaiki (`isSafeExternalUrl`) |

**Statistik perbaikan:** 11 file dimodifikasi, 2 file baru (`server/middleware/security.js`, `client/src/utils/api.js`), 1 file dihapus. Semua perubahan **backward-compatible** — tanpa `API_ACCESS_TOKEN` di `.env`, aplikasi berjalan persis seperti sebelumnya.

---

## 2. TEMUAN & PERBAIKAN DETAIL

### 2.1 🔴 [KRITIS] Frontend macet total — `ReferenceError: isRetrying is not defined`

**Lokasi:** `client/src/App.jsx` baris 98 (fungsi `runGeneratePipeline`)

**Masalah:** Objek progress merujuk variabel `isRetrying` yang tidak pernah dideklarasikan di scope `App`. Akibatnya **setiap** klik "Generate" maupun "Retry" melempar `ReferenceError` *sebelum* fetch dikirim — `setIsLoading(true)` sudah terlanjur dipanggil sehingga UI menggantung di state loading tanpa pesan error. (Alur Auto Mode tidak terdampak karena tidak melewati fungsi ini; itulah sebabnya bug ini bisa lolos.)

**Perbaikan:**
```js
// Retry = menjalankan ulang pipeline pada jobId yang sudah ada
const isRetrying = Boolean(overrideJobId);
```

### 2.2 🔴 [KRITIS] API publik tanpa autentikasi sama sekali

**Lokasi:** `server/server.js` — seluruh route; terekspos via Cloudflare Tunnel (`CLOUDFLARE_TUNNEL_URL`).

**Masalah:** Siapa pun yang mengetahui URL tunnel dapat:
- `POST /api/restart` → menjalankan `update.sh` (`git reset --hard origin main`) + `pm2 restart all` → **DoS / sabotage deploy**
- `POST /api/upload-cookies` → menimpa sesi YouTube server (memakai kuota & reputasi IP Anda untuk kepentingan orang lain)
- `POST /api/generate` → menguras kuota Gemini harian Anda
- `DELETE /api/jobs/:id` → menghapus hasil kerja
- `POST /api/auto/start` → menjalankan auto-harvest massal
- `POST /api/open-folder` → mengeksekusi perintah file manager di server

**Perbaikan (3 lapis):**
1. **Server** — `server/middleware/security.js` (baru): middleware `requireApiToken`. Jika `API_ACCESS_TOKEN` diisi di `server/.env`, semua 26 endpoint sensitif wajib membawa token (header `x-api-token`, `Authorization: Bearer`, atau query `?api_token=` untuk SSE). Perbandingan token memakai `crypto.timingSafeEqual`. Jika token belum diisi → mode lama (kompatibel) + peringatan jelas di log setiap 30 menit.
2. **Client** — `client/src/utils/api.js` (baru): interceptor global `window.fetch` otomatis menyisipkan header token dari `localStorage`; helper `withApiToken()` untuk URL `EventSource` (SSE tidak bisa kirim header); event `clipper:unauthorized` saat server membalas 401.
3. **UI** — tombol **Kunci** (ikon kunci) di Navbar + modal input token; otomatis terbuka saat 401. Token disimpan di `localStorage`, halaman reload setelah simpan.

**Endpoint terlindungi (26):** `generate`, `jobs` (GET/DELETE), `retry`, `auto-retry/*`, `progress/:jobId` (SSE), `script.txt`, `auto/*`, `upload-voiceover`, `regenerate-voiceover`, `retry-job-tts`, `batch-tts/*`, `open-folder` (GET+POST), `restart`, `upload-cookies`, `english-dictionary` (POST), `bandwidth-stats/reset`.
**Endpoint terbuka (aman/tanpa state):** `health`, `daily-limit`, `niches`, `extract-product`, `cookies-status`, `english-dictionary` (GET), `bandwidth-stats` (GET), streaming media `audio|video|download/:filename` (nama file acak tak terduga, dipakai tag `<video>`).

### 2.3 🔴 [KRITIS] Satu health check bisa meruntuhkan seluruh server

**Lokasi:** `server/services/binaryChecker.js` — `getYtDlpPath()` → `YTDlpWrap.downloadFromGithub()`

**Masalah:** Saat `yt-dlp` tidak ditemukan, `/api/health` memicu auto-download. Kegagalan jaringan (TLS proxy, captive portal, GitHub down) melempar **event `error` yang tidak tertangani** pada HTTP client internal yt-dlp-wrap → `uncaughtException` → **proses Node mati**. Terjadi nyata saat pengujian: server crash hanya karena sertifikat sandbox. Di VPS produksi, cukup satu gangguan jaringan saat boot = aplikasi mati sampai di-restart manual.

**Perbaikan:**
- `downloadYtDlpSafely()` — *crash-guard* `uncaughtException` sementara + timeout 180 detik; kegagalan kini hanya menulis warning ("Server tetap berjalan. Install yt-dlp manual...") alih-alih mematikan proses.
- *Negative-cache* 10 menit: setelah gagal, tidak mencoba unduh ulang di setiap pemanggilan (sebelumnya: percobaan berulang di tiap job → banjir log + delay).

### 2.4 🟠 [TINGGI] API key bocor plaintext ke `jobs.json`

**Lokasi:** `server/server.js` — `persistJob()` / endpoint auto-retry (`job.geminiApiKey = ...`)

**Masalah:** API key Gemini yang dikirim client disimpan ke field job, lalu **seluruh** objek job ditulis ke `server/jobs.json` tanpa filter. File ini gampang ikut ter-backup/dibagikan saat debugging.

**Perbaikan:**
- `scrubJobSecrets()` menghapus `geminiApiKey`/`apiKey`/`openRouterApiKey` dari salinan sebelum ditulis (key tetap di memory untuk runtime job aktif).
- `loadJobsFromDisk()` juga **membersihkan secret warisan** dari jobs.json lama saat server start (terverifikasi saat pengujian).

### 2.5 🟠 [TINGGI] Opsi `duration` diabaikan `extractFrames` → ReferenceError laten

**Lokasi:** `server/services/frameExtractor.js`

**Masalah:** Signature hanya `{ sampleIntervalSec, maxSampleFrames }` tetapi badan fungsi merujuk `duration` (dikirim caller sebagai `duration: rawDur`). Begitu `sampleIntervalSec` bernilai NaN/undefined → `ReferenceError`. Juga duplikasi `@param` di JSDoc.

**Perbaikan:** `duration = 0` ditambahkan ke destrukturisasi + JSDoc dibersihkan.

### 2.6 🟠 [TINGGI] Event loop dibekukan `execSync` (3 lokasi)

**Lokasi & perbaikan:**

| Lokasi | Sebelum | Sesudah |
|---|---|---|
| `server.js` audit klip anti-wajah | `execSync("ffmpeg ...")` 2× per klip, biner hardcoded `'ffmpeg'` (rusak total bila hanya tersedia `ffmpeg-static`), blokir hingga 6 dtk/klip | `extractAuditFrameAsync()` — async `spawn`, `getFFmpegPath()`, timeout 5 dtk, 2 frame paralel |
| `ttsService.js` mix voiceover Edge-TTS | `execSync` string dengan tanda kutip manual | `runFfmpegAsync(args[])` — tanpa shell, tanpa risiko injection, tidak memblokir |
| `ttsService.js` konversi PCM→MP3 Gemini | `execSync` string | `runFfmpegAsync(args[])` |

### 2.7 🟠 [TINGGI] Penulisan `jobs.json` non-atomik

**Masalah:** `fs.writeFileSync` langsung ke file target. Crash di tengah write (atau `pm2 restart` saat job berjalan) = JSON terpotong = **seluruh riwayat job hilang**.

**Perbaikan:** `writeJobsFileAtomic()` — tulis ke `.tmp` lalu `renameSync` (atomik di POSIX). Dipakai di semua 4 jalur penulisan (`persistJob`, `deletePersistedJob`, `loadJobsFromDisk`, `/api/restart`).

### 2.8 🟠 [TINGGI] CORS terbuka penuh + tanpa guard SSRF

**Perbaikan:**
- `buildCorsOptions()` — hanya origin tepercaya: `localhost`/`127.0.0.1`, LAN private (10.x/192.168.x/172.16-31.x), `*.trycloudflare.com`, plus tambahan via `CORS_ALLOWED_ORIGINS`. Origin lain ditolak (ter-log). UI normal tidak terdampak karena akses `same-origin` lewat proxy Vite/tunnel.
- `isSafeExternalUrl()` — memblokir `shopeeLink` & `options.productImage` yang menunjuk ke localhost/IP private/link-local/`169.254.169.254` (metadata cloud)/`.internal` (cegah SSRF dari input publik).

### 2.9 🟡 [SEDANG] Lain-lain yang diperbaiki

1. **Memory sweeper** (interval 10 menit): `jobProgress` terminal >30 menit dihapus; `autoRuns`/`autoRetryRuns` dipangkas maks 20 entri terbaru (run aktif tidak disentuh).
2. **SSE heartbeat** `: ping` tiap 15 detik — koneksi progress tidak diputus proxy idle; interval heartbeat ikut dibersihkan saat client disconnect.
3. **`cookies.txt` mode 0600** (sebelumnya 0644 — bisa dibaca user lain di VPS).
4. **`/api/open-folder`** `exec` → `execFile` tanpa shell (POST & GET).
5. **Higiene repo:** `temp_old_ai.js` (91 KB, UTF-16, dead code) dihapus; link `file:///c:/Users/...` di README → link relatif; field usang `model: 'gpt-4o-mini'` dihapus dari state form; `.env.example` kini mendokumentasikan `API_ACCESS_TOKEN`, `CORS_ALLOWED_ORIGINS`, `DAILY_VIDEO_LIMIT`.

---

## 3. PENGUJIAN YANG DILAKUKAN

| Pengujian | Hasil |
|---|---|
| `node --check` seluruh file JS server yang diubah | ✅ Lolos |
| `vite build` client (1585 modul) | ✅ Lolos |
| Boot server + `/api/health` tanpa token | ✅ 200 |
| `/api/jobs` tanpa token / token salah | ✅ 401 |
| `/api/jobs` dengan `x-api-token` / `Bearer` benar | ✅ 200 |
| SSE `/api/progress` via `?api_token=` | ✅ Streaming data |
| SSE tanpa token | ✅ 401 |
| `POST /api/restart`, `/api/upload-cookies`, `/api/generate` tanpa token | ✅ 401 (tidak dieksekusi) |
| CORS origin asing (`evil.example.com`) | ✅ Tanpa header CORS + ter-log |
| CORS `localhost:3000` | ✅ Diizinkan |
| `POST /api/generate` (pipeline end-to-end di sandbox tanpa jaringan YouTube) | ✅ Gagal dengan graceful error + job persist bersih |
| `jobs.json` setelah job dengan `apiKey` di body | ✅ Tidak ada secret; tidak ada `.tmp` tersisa |
| Secret warisan di `jobs.json` + restart server | ✅ Ter-scrub otomatis saat load |
| Crash-guard download yt-dlp (TLS gagal) | ✅ Server tetap hidup (sebelumnya: mati) |

---

## 4. CARA MENGAKTIFKAN KUNCI AKSES (PENTING UNTUK VPS ANDA)

```bash
# 1. Generate token acak di VPS
openssl rand -hex 24

# 2. Isi di server/.env
echo "API_ACCESS_TOKEN=<token-anda>" >> server/.env

# 3. Restart
pm2 restart clipper --update-env
```

Lalu di aplikasi → klik tombol **Kunci** (ikon kunci, kanan atas) → tempel token yang sama → **Simpan & Muat Ulang**. Tanpa langkah ini, aplikasi tetap terbuka seperti sebelumnya (hanya muncul peringatan di log server).

---

## 5. REKOMENDASI LANJUTAN (BELUM DIIMPLEMENTASI — PRIORITAS BERIKUTNYA)

Dari audit ini dan menyandingkan dengan `AUDIT_HEMAT_TOKEN.md`:

1. **Latihan model gatekeeper `scene_filter_v2.onnx`** (temuan #7 audit lama, masih terbuka) — akurasi Tahap 3 gatekeeper masih memakai MobileNetV3 ImageNet generik. Dataset kurated (`server/gatekeeper/dataset/`, 34 datasheet) sudah siap untuk training.
2. **Pemangkasan rantai fallback 5 model Gemini** → 3 model, dan retry backoff di model yang sama untuk error 429 sesaat (audit lama A2, belum diterapkan penuh).
3. **Restrukturisasi prompt agar cache-friendly** (bagian statis di depan — audit lama A6).
4. **`jobs.json` tumbuh tanpa batas** — by design (riwayat dipertahankan), namun untuk jangka panjang pertimbangkan arsip terpisah per bulan setelah >500 job.
5. **DNS-rebinding**: `isSafeExternalUrl` memeriksa hostname, bukan IP hasil resolusi. Untuk permukaan serangan saat ini (input hanya diteruskan ke Bing/Gemini, tidak di-fetch server) risikonya rendah, tapi patut dicatat.
6. **Endpoint media** (`/api/video/:filename`, dll.) terlindung oleh nama file acak — bila ingin lebih ketat, tambahkan token di query untuk tag `<video>` juga.
7. **Dependensi**: `express@4.21`, `multer@1.4.5-lts.1` aman untuk CVE yang diketahui saat audit; jadwalkan `npm audit` berkala. `@google/generative-ai` sudah deprecated oleh Google (SDK baru `@google/genai`) — migrasi bisa dinegosiasikan saat update model berikutnya.
8. **`menu-vps.sh`/`update.sh`** menjalankan `git reset --hard origin main` — pastikan tidak ada file penting yang tidak ter-commit di VPS sebelum restart dari UI.
9. Pertimbangkan **HTTPS-only + rate limit** (mis. `express-rate-limit`) bila kelak API dipakai lintas perangkat publik.

---

## 6. FILE YANG BERUBAH

| File | Perubahan |
|---|---|
| `server/middleware/security.js` | **BARU** — token auth, CORS allowlist, SSRF guard |
| `client/src/utils/api.js` | **BARU** — token storage, fetch interceptor, SSE URL builder |
| `server/server.js` | Auth di 26 endpoint, atomic+scrub jobs.json, SSE heartbeat, sweeper, audit klip async, execFile open-folder, guard SSRF, cookies 0600 |
| `server/services/binaryChecker.js` | Crash-guard + timeout + negative-cache download yt-dlp |
| `server/services/ttsService.js` | 2× `execSync` → `runFfmpegAsync` (spawn tanpa shell) |
| `server/services/frameExtractor.js` | Fix `duration` + JSDoc |
| `client/src/App.jsx` | Fix `isRetrying` (bug fatal), hapus field usang, SSE + token |
| `client/src/components/Navbar.jsx` | UI Kunci Akses + modal token + listener 401 |
| `client/src/components/AutoModePanel.jsx` | SSE + token |
| `client/src/main.jsx` | Pasang fetch interceptor |
| `server/.env.example` | Dokumentasi `API_ACCESS_TOKEN` dkk. |
| `README.md` | Link relatif, seksi keamanan baru |
| `temp_old_ai.js` | **DIHAPUS** (dead code 91 KB) |
