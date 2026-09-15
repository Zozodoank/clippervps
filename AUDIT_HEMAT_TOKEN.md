# 🔍 Audit Hemat Token AI & Akurasi AI Lokal — ClipperVPS

> Target lingkungan: Ubuntu 22.04 LTS, VPS 2 core / 4 GB RAM
> Tanggal audit: 15 September 2026

---

## RINGKASAN EKSEKUTIF

| # | Temuan | Dampak | Prioritas |
|---|--------|--------|-----------|
| 1 | Mode `fileUri` YouTube Stream mengirim **seluruh video** ke Gemini tanpa `mediaResolution: LOW` / batas durasi | ±300 token/detik → video 10 menit = **±180.000 token sekali panggil** | 🔴 KRITIS |
| 2 | Rantai fallback 8 model mengirim ulang **seluruh payload** (30 frame + prompt) di tiap percobaan | Kegagalan beruntun bisa 8× lipat token per job | 🔴 KRITIS |
| 3 | `gemini-1.5-flash` masih dipakai di jalur File API — model ini sudah pensiun | Selalu error → buang waktu + retry sia-sia | 🔴 KRITIS |
| 4 | Timeout Gatekeeper lokal hanya 4 detik untuk 25–30 frame di CPU 2 core | Gatekeeper sering "kalah cepat" → jatuh ke heuristik piksel → akurasi filter lokal turun drastis | 🔴 KRITIS |
| 5 | 25–30 frame per panggilan vision (min. 258 token/gambar di Gemini) | ±7.700 token gambar/panggilan; bisa dipangkas ±50% | 🟠 TINGGI |
| 6 | Prompt raksasa: 18 blok template ≥2.000 karakter, total ±70.000 karakter, banyak duplikat | ±2.500–3.000 token prompt per panggilan; aturan berulang justru menurunkan kepatuhan model | 🟠 TINGGI |
| 7 | Model custom `scene_filter_v2.onnx` belum dilatih → jatuh ke MobileNetV3 ImageNet generik (hanya 7 kelas "grafis") | Akurasi Tahap 3 gatekeeper rendah | 🟠 TINGGI |
| 8 | `spawnSync('curl')` memblokir event loop Node saat memanggil gatekeeper | Server "macet" beberapa detik per batch; UI progress ikut beku | 🟡 SEDANG |
| 9 | 5 worker FFmpeg paralel + ONNX `intra_op=2` + Node di CPU 2 core | Kontensi CPU → inferensi gatekeeper makin lambat → makin sering timeout (memperparah #4) | 🟡 SEDANG |
| 10 | Susunan prompt tidak cache-friendly (konten dinamis di awal) | Implicit caching Gemini tidak pernah hit → bayar prompt penuh terus | 🟡 SEDANG |

Estimasi kasar: perbaikan #1, #2, #5, #6 bisa memangkas **60–80% konsumsi token** per job tanpa menurunkan kualitas output.

---

## BAGIAN A — HEMAT TOKEN AI

### A1. 🔴 Mode YouTube `fileUri` tanpa kontrol resolusi/durasi
**Lokasi:** `server/services/aiService.js` — `analyzeYouTubeVideoWithGemini()` (±baris 617–629)

```js
const contentParts = [{ fileData: { fileUri: youtubeUrl, mimeType: 'video/mp4' } }];
```

Video dikirim utuh dengan resolusi media default (±258 token/frame @1fps + 32 token/detik audio ≈ **±300 token/detik**). Video sumber Anda 5–15 menit (filter di `discoveryService.js:1520` mengizinkan sampai 900 detik) → **90.000–270.000 token input sekali panggil**, dan itu diulang di tiap model fallback.

**Perbaikan:**
1. Tambahkan `mediaResolution: 'MEDIA_RESOLUTION_LOW'` di `generationConfig` → ±66 token/frame (hemat ±70% token video). Untuk deteksi produk/wajah/subtitle, resolusi LOW umumnya masih memadai.
2. Tambahkan `videoMetadata` dengan `startOffset`/`endOffset` — Anda hanya butuh menit 0–5 pertama untuk verifikasi produk, bukan 15 menit penuh. Atau `fps: 0.5` untuk video panjang.
3. Karena metadata durasi sudah ada dari yt-dlp, tolak video >600 detik **sebelum** dikirim ke Gemini (sekarang batasnya 900 detik).

Estimasi hemat: video 10 menit dari ±180K → ±20–40K token (**hemat 75–85%**).

### A2. 🔴 Fallback 8 model mengirim ulang payload penuh
**Lokasi:** `aiService.js` baris 133–141 (`defaultGeminiDirectModels`), 588–595, loop retry baris 1625, 2080, 2984.

Daftar fallback berisi 8 model. Saat kuota/overload, **setiap** percobaan mengirim ulang 25–30 gambar base64 + prompt 6–9K karakter. Skenario buruk: 8 × 10K token = 80K token untuk satu keputusan.

**Perbaikan:**
1. Pangkas rantai fallback jadi **3 model**: 1 utama + 1 cadangan setara + 1 lite. Contoh: `gemini-3.8-flash` → `gemini-3.5-flash` → `gemini-3.5-flash-lite`.
2. Bedakan jenis error: jika error **kuota harian (RPD)** pada satu API key, semua model keluarga sama besar kemungkinan gagal → langsung lompat ke model `-lite` atau hentikan job, jangan coba 8 model berurutan.
3. Untuk error 429 rate-limit sesaat, lakukan retry di **model yang sama** dengan backoff, bukan pindah model (pindah model = kehilangan potensi implicit cache hit).

### A3. 🔴 Model pensiun `gemini-1.5-flash` di jalur File API
**Lokasi:** `aiService.js:1054` — `const candidateModels = ['gemini-1.5-flash', 'gemini-flash-latest'];`

`gemini-1.5-flash` sudah dipensiunkan dari Gemini API. Percobaan pertama di jalur File API **selalu gagal**, membuang waktu upload + siklus retry. Ganti ke model yang masih hidup dan samakan dengan daftar utama (mis. `['gemini-3.5-flash-lite', 'gemini-flash-latest']`).

Juga di `discoveryService.js` (extractVisualKeywordsWithAI) — pastikan daftar `candidateModels` di sana tidak memuat model pensiun.

### A4. 🟠 Jumlah & ukuran frame per panggilan vision
**Lokasi:** `server.js:1211,1318,1391` (`maxSampleFrames: 30`), `server.js:1613` (25/kandidat), `poolMultiCandidateFrames` maks 30; `frameExtractor.js` (`scale=-2:360`, q:v 3).

Fakta penting tokenisasi Gemini: gambar apa pun ≤384px = **minimal 258 token**; memperkecil dari 360p ke 240p **tidak** menghemat token Gemini. Satu-satunya tuas nyata adalah **jumlah frame**.

**Perbaikan:**
1. Turunkan pool akhir dari 30 → **12–16 frame**. Gatekeeper lokal sudah menyaring wajah/teks/bumper; kirim hanya frame `clean` terbaik yang tersebar merata di timeline. 16 frame masih cukup untuk memilih klip 5 detik.
2. Frame dari kandidat yang **tidak** lolos ambang minimum (mis. <5 frame bersih) jangan ikut dipool — buang kandidatnya.
3. Untuk OpenRouter, `detail: 'low'` sudah benar (pertahankan).

Estimasi hemat: 30→15 frame = ±3.900 token/panggilan (**±50% komponen gambar**).

### A5. 🟠 Prompt 70.000 karakter, duplikat, dan "kebisingan aturan"
**Lokasi:** `aiService.js` — 18 blok template ≥2K karakter (terbesar 9.118 karakter). Blok aturan `BULKY FURNITURE BAN`, `UNBOXING DISCARD`, `WATERMARK 9:16` **terduplikasi hampir identik** di ≥3 fungsi (baris ±468, ±935, ±1391 dst).

Masalahnya ganda:
- **Token:** ±2.500–3.000 token prompt terkirim di tiap panggilan (dan tiap retry).
- **Akurasi:** riset prompt konsisten menunjukkan aturan berulang-ulang dengan huruf kapital + tanda seru justru menurunkan kepatuhan. Model flash/lite mudah "tenggelam" dalam 50+ aturan larangan dan mengabaikan sebagian.

**Perbaikan:**
1. Ekstrak aturan bersama ke **satu konstanta** (mis. `PROMPT_RULES_CORE`) yang direferensikan semua fungsi — hilangkan duplikasi 3–4 salinan.
2. Ringkas: satu aturan cukup ditulis **sekali**, tanpa pengulangan "REJECT IMMEDIATELY ... !!!". Target: pangkas 40–50% panjang prompt.
3. Ganti daftar larangan panjang dengan **rubrik terstruktur + 2–3 contoh output JSON** (few-shot). Ini lebih murah token dan lebih akurat daripada 30 kalimat larangan.
4. `max_tokens: 4096` untuk keputusan accept/reject JSON kecil → turunkan ke 1.024 untuk jalur vision (baris 1650); biarkan 4.000 hanya untuk scripting naskah.

### A6. 🟡 Susunan prompt tidak ramah implicit caching
Gemini 2.5+/3.x punya **implicit caching**: prefix prompt yang identik antar-request diberi diskon token otomatis. Syaratnya: bagian **statis harus di depan**, bagian dinamis di belakang. Saat ini `coreNoun`, judul produk, dan deskripsi disisipkan di awal/tengah prompt → prefix tidak pernah identik → cache tidak pernah hit.

**Perbaikan:** restrukturisasi jadi:
```
[SYSTEM/ATURAN STATIS — identik untuk semua job]  ← bagian ini kena diskon cache
[FORMAT OUTPUT JSON — statis]
[DATA DINAMIS: produk, judul, deskripsi, frame]   ← taruh paling akhir
```
Dengan volume 20 video/hari, ini diskon signifikan tanpa mengubah logika apa pun.

### A7. 🟡 Lain-lain hemat token
- **`analyzeYouTubeVideoWithGemini` vs `analyzeVideoWithGeminiFileApi`** memuat prompt hampir identik ±6K karakter masing-masing — satukan.
- Deskripsi produk (`effectiveDesc`) dimasukkan mentah ke prompt tanpa dipotong — deskripsi Shopee bisa ribuan karakter. Potong ke ±400 karakter pertama.
- Loop auto-retry (`run.attemptCount`) + 12 kandidat per job: pastikan penghitung "AI calls per job" dibatasi keras (mis. maks 6 panggilan vision/job) supaya job gagal tidak menguras kuota sepanjang malam. Limit 20 video/hari sudah ada — tambahkan juga limit panggilan AI harian.

---

## BAGIAN B — AKURASI AI LOKAL (GATEKEEPER)

### B1. 🔴 Timeout 4 detik membuat gatekeeper "tidak pernah dipakai"
**Lokasi:** `videoFilterService.js:472` (`timeoutSec = 5` default, dipanggil dengan `timeoutSec: 4` di baris 515) + `service.py` pipeline 3 tahap.

Di CPU 2 core, per frame: BlazeFace/YuNet (±10–30 ms) + DBNet 320px (±80–200 ms) + MobileNetV3 224px (±30–80 ms) ≈ **150–300 ms/frame**. Untuk 25–30 frame = **4–9 detik** — sering melewati timeout 4 detik, apalagi saat FFmpeg juga sedang jalan. Akibatnya `callAIGatekeeperMicroservice()` return `null` dan sistem diam-diam jatuh ke heuristik piksel 80×144 yang jauh lebih kasar → frame wajah/subtitle lolos ke Gemini → token terbuang + hasil AI utama lebih kotor.

**Perbaikan:**
1. Naikkan timeout ke **20–30 detik**. Gatekeeper lambat 10 detik masih jauh lebih murah daripada mengirim frame kotor ke Gemini.
2. Log eksplisit saat fallback heuristik terjadi (sekarang `catch` kosong, baris 508) supaya Anda tahu seberapa sering gatekeeper gagal.
3. Tambahkan cek `/health` sekali saat boot server Node; kalau gatekeeper offline, tampilkan peringatan di UI.

### B2. 🔴 Ganti `spawnSync('curl')` dengan HTTP async
**Lokasi:** `videoFilterService.js:482`.

`spawnSync` **memblokir seluruh event loop Node** selama gatekeeper bekerja (dengan perbaikan B1 = bisa 20 detik beku: SSE progress berhenti, endpoint lain tidak merespons). Ganti dengan `fetch('http://127.0.0.1:5050/filter-frames', ...)` + `AbortSignal.timeout(ms)` dan jadikan `inspectFramesLocally`/pemanggilnya `async`. Node 18+ sudah punya fetch bawaan.

### B3. 🟠 Latih model custom `scene_filter_v2.onnx` (paling berdampak untuk akurasi)
**Lokasi:** `gatekeeper/models/` hanya berisi `labels.json`; `service.py` jatuh ke MobileNetV3 ImageNet generik yang cuma memetakan **7 kelas ImageNet** (`{918, 919, 921, ...}`) sebagai "grafis". Kelas ImageNet tidak dirancang untuk membedakan "bumper intro slide" vs "demo produk dapur" → akurasi Tahap 3 rendah dan hampir semua frame diloloskan (`return True, 0.95` default).

**Perbaikan:**
1. Jalankan `collect_dataset.py` — Anda sudah punya sumber data sempurna: frame yang **ditolak Gemini** (beserta alasannya) tersimpan di alur job. Setiap penolakan Gemini = label training gratis.
2. Latih dengan `train_scene_filter.py` (target 1.000–2.000 frame per kelas), ekspor `scene_filter_v2.onnx`.
3. Efek berantai: makin akurat gatekeeper lokal → makin sedikit frame kotor dikirim ke Gemini → makin sedikit job ditolak AI utama → makin sedikit retry → **hemat token juga**.

### B4. 🟠 Pastikan model ONNX benar-benar terunduh di VPS
`models/` di repo kosong (hanya labels.json). Jika `download_models.py` belum pernah sukses di VPS, `service.py` berjalan dalam mode fallback murni (Sobel gradient untuk teks, entropy variance untuk scene) **tanpa error yang terlihat**. Verifikasi di VPS:
```bash
ls -la ~/clippervps/server/gatekeeper/models/   # harus ada 4 file model (~15 MB)
curl -s http://127.0.0.1:5050/health            # "face"/"text"/"scene" tidak boleh "none"/"fallback"
```
Tambahkan pengecekan ini ke `menu-vps.sh` atau health-check PM2.

### B5. 🟠 Deteksi wajah: BlazeFace *short-range* salah pakai
**Lokasi:** `service.py` FaceGatekeeper — `blaze_face_short_range.tflite`.

BlazeFace **short range** dioptimalkan untuk wajah selfie jarak dekat (<2 m). Frame YouTube review produk sering memuat wajah kecil/jauh (vlogger di sudut, orang di latar) — inilah yang paling sering lolos. Perbaikan:
1. Jalankan **YuNet sebagai verifikasi kedua** bahkan ketika MediaPipe tidak menemukan wajah (sekarang YuNet hanya dipakai jika MediaPipe tidak tersedia). YuNet jauh lebih baik untuk wajah kecil; biaya ±5–15 ms/frame saja.
2. Turunkan ambang ukuran minimum wajah dari `4%` dimensi frame ke `2.5%` untuk menangkap wajah kecil di crop 9:16.
3. Turunkan `min_confidence` khusus YuNet ke 0.4 (false positive wajah lebih murah daripada false negative — frame wajah yang lolos akan membuat Gemini menolak seluruh video).

### B6. 🟡 DBNet input 320px terlalu kecil untuk subtitle tipis
**Lokasi:** `service.py` TextGatekeeper (`target_size = 320`).

Frame sumber 640×360 di-resize ke ±320 → subtitle font kecil menyusut di bawah resolusi deteksi DBNet. Naikkan `target_size` ke **480** (masih ringan, +±60% waktu inferensi teks tapi jauh lebih sensitif), atau jalankan DBNet hanya pada **crop 40% area bawah** frame dengan resolusi penuh — lebih cepat DAN lebih akurat untuk kasus subtitle terbakar.

### B7. 🟡 Kontensi CPU di VPS 2 core
Saat job berjalan bersamaan: Node + FFmpeg (5 worker paralel di `sampleFramesFromStream`) + Python gatekeeper (`intra_op_num_threads=2` × ThreadingHTTPServer multi-request) + cloudflared. Di 2 core ini saling mencekik dan memperlambat gatekeeper (memperparah B1).

**Perbaikan:**
1. `videoFilterService.js:344` — turunkan `concurrency` FFmpeg dari 5 → **2**.
2. `service.py` — set `intra_op_num_threads = 1` dan env `OMP_NUM_THREADS=1` di PM2 (`pm2 start service.py --name gatekeeper --interpreter python3 --env OMP_NUM_THREADS=1`); throughput total di 2 core justru lebih stabil.
3. PM2: pasang `max_memory_restart 1200M` untuk proses `clipper` dan `400M` untuk `gatekeeper`.
4. Pastikan swap 2 GB aktif (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`) — mencegah OOM-kill saat render FFmpeg 1080p.

---

## ⚖️ REVISI v2 — REKONSILIASI SETELAH REVIEW KEDUA

> Bagian ini merevisi rekomendasi awal setelah kritik eksternal. Beberapa poin awal
> memang terlalu agresif; beberapa kritik juga overstated. Berikut versi final yang
> memisahkan risiko secara eksplisit.

### TIER 0 — Zero-risk, terapkan langsung (tidak mengubah kualitas output sama sekali)

| Poin | Aksi | Status |
|------|------|--------|
| A3 | Hapus `gemini-1.5-flash` (model pensiun) → `gemini-3.5-flash-lite` di jalur File API | ✅ **DITERAPKAN** (aiService.js:1054) |
| B1 | **Timeout gatekeeper 4s → 25s + log eksplisit** (timeout / offline / error dibedakan) | ✅ **DITERAPKAN** (videoFilterService.js) |
| B2 | `spawnSync('curl')` → `fetch` async + `AbortSignal.timeout`; seluruh rantai pemanggil dijadikan async/await | ✅ **DITERAPKAN** (4 call site di server.js ikut di-await) |
| B4 | Health check `/health` gatekeeper saat boot Node + peringatan jika model ONNX belum terunduh (backend fallback terdeteksi) | ✅ **DITERAPKAN** (server.js app.listen) |
| B5rev | Ambang ukuran wajah 4% → 3% (confidence tetap 0.5) untuk wajah vlogger kecil/jauh | ✅ **DITERAPKAN** (service.py, MediaPipe + YuNet) |
| B7 | `OMP_NUM_THREADS=1` + `cv2.setNumThreads(1)` di service.py, `intra_op=1`, FFmpeg concurrency 5→2 (env `FFMPEG_SAMPLING_CONCURRENCY`), `--max-memory-restart 400M` di setup-gatekeeper.sh | ✅ **DITERAPKAN** |
| A1rev | `mediaResolution: MEDIA_RESOLUTION_LOW` + `fps: 0.5` di jalur fileUri (SELURUH durasi — bukan endOffset, B-roll menit 4–8 tetap terlihat) | ✅ **DITERAPKAN** (aiService.js YouTube Stream) |
| A2a | Klasifikasi error kuota HARIAN (RPD): `isDailyQuotaExhaustedError()` menghentikan cascade fallback di 3 loop retry (vision, scripting, YouTube stream) — payload tidak dikirim ulang 8× | ✅ **DITERAPKAN** |
| A7 | `truncateProductDescription()`: 500 karakter untuk prompt vision, 900 untuk scripting (butuh konteks USP lebih banyak) | ✅ **DITERAPKAN** (4 lokasi) |
| A6 | Susun prompt: statis di depan, dinamis di akhir (implicit caching) | ⏳ Belum — perlu refactor hati-hati, jadwalkan bersama A5a |
| A5a | Deduplikasi prompt murni (aturan identik → satu konstanta, tanpa mengubah kata) | ⏳ Belum — blok aturan antar-fungsi TIDAK 100% identik (ada variasi kecil yang disengaja), perlu review manual per blok |

> **Catatan swap:** aktifkan manual di VPS: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` + tambahkan ke `/etc/fstab`.

### TIER 1 — Terapkan bertahap dengan pengaman & monitoring

| Poin | Versi awal (dibatalkan) | Versi revisi (aman) |
|------|------------------------|---------------------|
| A1 | `endOffset` kaku menit 0–5 | **`fps: 0.5` di seluruh durasi** — hemat ±50% token video tanpa kehilangan B-roll menit 4–8. `mediaResolution: LOW` hanya untuk panggilan **screening accept/reject awal**; verifikasi detail produk pakai resolusi default |
| A4 | Pool 30 → 12–16 frame langsung | Env var `POOL_MAX_FRAMES`, turunkan bertahap 30→24→20 sambil pantau success rate & rasio penolakan. *Catatan: pool saat ini SUDAH 6–10 frame/video (30 frame ÷ 3–5 video), jadi kekhawatiran "gap 30 detik" sebenarnya sudah kondisi existing* |
| B5 | Confidence 0.4 + ukuran 2.5% | **Pertahankan confidence 0.5**; cukup tambah YuNet sebagai second-pass verifikasi (saat ini YuNet hanya jalan jika MediaPipe absen); ukuran minimum 4% → 3% |
| A5b | Ringkas prompt 40–50% langsung | Peringkasan hanya lewat A/B test: jalankan 10–20 job dengan prompt lama vs baru, bandingkan reject rate sebelum permanen |
| A2b | Pangkas 8 → 3 model | Pangkas 8 → 5–6 model; jangan andalkan `-lite` untuk output JSON kompleks (kotak scene/koordinat crop), `-lite` hanya untuk keputusan accept/reject sederhana |

### TIER 2 — Riset / opsional (jangan dulu)

- **B3 (training scene_filter_v2.onnx):** tetap layak, tapi dengan mitigasi overfitting — target dataset lebih besar & beragam kategori (3–5K frame), augmentasi, ambang confidence tetap 0.55, dan ingat model lokal bersifat **advisory** (Gemini tetap verifikator akhir, jadi kesalahan model custom tidak fatal).
- **B6 (DBNet 480px):** DITUNDA — biaya CPU 2.2× tidak sepadan di 2 core, dan crop-bawah-saja melewatkan watermark tengah. Alternatif masa depan: dual-pass (320px full frame + pass kedua hanya jika skor borderline).

### Koreksi atas kritik eksternal (untuk kejelasan)

1. `mediaResolution` **tidak memengaruhi** jalur frame-pool — JPEG ≤384px selalu 258 token di Gemini berapapun resolusinya. Trade-off akurasi resolusi hanya relevan di jalur `fileUri`.
2. Skenario "gap antar-frame 20–40 detik" pada pengurangan pool sebenarnya **sudah terjadi hari ini** (30 frame ÷ 3–5 video).
3. Daftar "aman" kritik eksternal **melewatkan B1 (timeout gatekeeper)** — padahal itu perbaikan akurasi lokal paling berdampak dan sepenuhnya zero-risk.

---

## URUTAN EKSEKUSI YANG DISARANKAN (v1 — LIHAT REVISI v2 DI ATAS)

**Hari 1 (dampak terbesar, effort kecil):**
1. Hapus `gemini-1.5-flash` (A3), pangkas fallback ke 3 model (A2).
2. Tambah `mediaResolution: LOW` + `endOffset` di mode fileUri (A1).
3. Naikkan timeout gatekeeper 4s → 25s + log fallback (B1).
4. Turunkan concurrency FFmpeg 5 → 2, set OMP_NUM_THREADS=1 (B7).

**Minggu 1:**
5. Kurangi pool frame 30 → 16 (A4); `max_tokens` vision → 1024 (A5.4).
6. Ganti spawnSync curl → fetch async (B2).
7. Verifikasi model ONNX terunduh di VPS + health check saat boot (B4).
8. YuNet double-check wajah + ambang 2.5% (B5).

**Minggu 2–3:**
9. Refactor prompt: dedup, ringkas 40–50%, susun statis-di-depan untuk implicit caching (A5, A6).
10. Kumpulkan dataset dari penolakan Gemini → latih `scene_filter_v2.onnx` (B3).
11. DBNet 480px / crop area bawah (B6).

---

*Semua nomor baris merujuk commit `e475458` (branch `arena/01a0a3ab-clippervps`).*
