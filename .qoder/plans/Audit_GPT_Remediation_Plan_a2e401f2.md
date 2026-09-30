# Rencana Eksekusi Hasil Audit GPT (Dimulai Besok)

Semua temuan audit **sudah diverifikasi against kode live hari ini** — bukan asumsi. Catatan adaptasi: project ini jalan **penuh lokal di PC Windows & Termux (tanpa VPS remote)**, jadi beberapa temuan ber-satu "VPS multi-user/UTC" prioritasnya diturunkan. Semua perubahan perilaku **dibungkus env flag** (konvensi `runtimeFlags.js`) agar bisa dimatikan saat regresi di Termux.

## Verifikasi Audit → Kode Nyata

| # | Temuan audit | Status verifikasi | Lokasi |
|---|---|---|---|
| 1 | `cleanTimeWindows` kehilangan source video | ✅ NYATA | [stage1Render.js L577, L1252, L1303-1308, L1331](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/worker/stage1Render.js) → prompt di [aiService.js L148-149, L647-648](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/services/aiService.js) |
| 2 | Stopping logic berbasis jumlah clip/source | ✅ NYATA | `maxStreamVideos = 8` (L945), `shouldKeepHarvesting` (L1270), `isSatisfactory` (L1391) |
| 3 | Target durasi 18-22s, tidak konsisten | ✅ NYATA | L1755, L1983, L2032 (`targetMinSec = 18.0`); [aiService.js L2447](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/services/aiService.js) `Math.max(18, Math.min(45, ...))` |
| 4-5 | Gemini baca video penuh via `fileUri` | ✅ NYATA | aiService.js L316-324 (single), L760-763 (multi, sudah `MEDIA_RESOLUTION_LOW` + `fps: 0.5`) |
| 6-7 | Daftar model tersebar & fallback panjang | ✅ NYATA | aiService.js L287-295 & L731-739 (7 model), L1114+ (list lain), [aiClient.js L127-133](file:///c:/Users/SEMOGA AWET/Documents/clipperVPS/server/services/ai/aiClient.js) (5 model), discoveryService.js L2629+ (list lain lagi) |
| 8 | File API tanpa `mediaResolution` | ✅ NYATA | `analyzeVideoWithGeminiFileApi` L902+ |
| 10 | checkSyntax tidak rekursif | ✅ NYATA | [checkSyntax.mjs L9-18](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/scripts/checkSyntax.mjs) — `api/middleware`, `tests`, subfolder tak tercakup |
| 11 | Artefak di root | ✅ NYATA | `temp_imports.js` (UTF-16, gagal `node --check`), `fix_imports.cjs`, `fix_cross_imports.mjs`, `temp_m3u8.*.mp4`, `temp_test.mp4.f399.mp4` |
| 12 | Quota ikut timezone OS | ✅ NYATA | [quotaService.js L21](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/services/quotaService.js) |
| 13 | Token SSE via query string | ✅ NYATA | [tokenAuth.js L51-53](file:///c:/Users/SEMOGA AWET/Documents/clipperVPS/server/api/middleware/tokenAuth.js) |
| 14 | `cookies.txt` tanpa mode 0600 | ✅ NYATA | [systemRoutes.js L544](file:///c:/Users/SEMOGA AWET/Documents/clipperVPS/server/api/routes/systemRoutes.js) |
| 15 | `uncaughtException` hanya log | ✅ NYATA | [server.js L117-119](file:///c:/Users/SEMOGA%20AWET/Documents/clipperVPS/server/server.js) |

---

## Batch 1 — P0: Kontrak Durasi & Source-Scoped Windows (perbaikan terbesar)

**File baru: `server/config/clipTargets.js`** (satu sumber kebenaran, override env):
```
FINAL_VIDEO_MIN_SEC = 30   (env FINAL_VIDEO_MIN_SEC)
FINAL_VIDEO_MAX_SEC = 35   (env FINAL_VIDEO_MAX_SEC)
USABLE_STOP_SEC     = 60   (cukup → STOP cari source; env USABLE_FOOTAGE_STOP_SEC)
USABLE_MIN_SEC      = 45   (kurang dari ini → cari source tambahan)
MAX_SOURCES         = 2    (pengganti logika "kejar sumber ke-2"; env MAX_SOURCES)
CLIP_SEC_MIN = 3.2, CLIP_SEC_MAX = 6.0  (tetap seperti sekarang)
```
Batas ini **hanya floor target**, bukan hard-cap — durasi akhir tetap bisa lebih pendek kalau footage bersih memang segitu, supaya tidak memicu pencarian tak berujung (justru ini yang mau kita hilangkan).

**1a. Source-scoped clean windows:**
- Di `stage1Render.js` L577 & L1252: tambahkan `sourceIndex` (dan `sourceTitle` singkat) ke tiap window: `{ start, end, sourceIndex }`.
- L1303-1308: merge tetap, tapi group per source saat build payload L1331.
- Di `aiService.js` (KEDUA jalur, single L148 & multi L647): format directive menjadi `VIDEO 1 (url): clean 10-25s, 40-55s | VIDEO 2 (url): clean 20-35s` — dan instruksi "timestamp hanya valid untuk video sumbernya masing-masing".
- Update validasi post-Gemini di `stage1Render.js`: clip yang `startSec`-nya jatuh ke window sumber LAIN diabaikan/dikoreksi (gerbang keras, bukan cuma minta tolong ke AI).
- Test: unit test grouping + simulasi Gemini pilih window salah sumber.

**1b. Usable-footage seconds sebagai stopping metric:**
- Helper `computeUsableSeconds(windows)` = Σ`(end-start)` windows per source (sudah dipotong intro cutoff & blacklist).
- `shouldKeepHarvesting` (L1270): ubah dari `verifiedCandidatesCount < targetMultiSources` menjadi `usableSeconds < USABLE_MIN_SEC && streamedCount < MAX_SOURCES && hasRemainingPool`.
- Gate STOP di loop `while (streamedCount < maxStreamVideos)` (L1035): kalau `usableSeconds >= USABLE_STOP_SEC` → hentikan stream video berikutnya, langsung ke storyboard. `maxStreamVideos` 8 → di-bound oleh `MAX_SOURCES` (bukan dihapus, supaya manual mode lama tetap bisa jalan via env).
- `isSatisfactory` (L1391): tetap sbg safety-net, tapi tidak lagi memicu pencarian source baru.

**1c. Samakan target 30-35s:**
- Ganti hardcoded `18.0/18.5/19.5/22.0` (L1755), `targetMinSec = 18.0` (L1983, L2032), dan `Math.max(18, Math.min(45, …))` di aiService.js L2447 dengan import dari `clipTargets.js`.
- Update prompt storyboard/script generation agar minta "total 30-35 detik, 5-8 klip × 3.2-6 detik" dari angka konfigurasi yang sama.
- QC voiceover conform: fallback durasi (jika klip < `FINAL_VIDEO_MIN_SEC` dan tidak bisa diperpanjang) → log peringatan, bukan gagal hard.

**Verifikasi Batch 1:** characterization test dulu (snapshots perilaku lama), `npm run test` di `server/` (vitest, isolated DB), 1 job E2E kitchen + 1 smartphone di PC, bandingkan log: stop-search harus terjadi saat usable ≥ 60s.

## Batch 2 — P1: Single Gemini Model Registry

- **File baru `server/config/aiModels.js`**: `visionPrimary` (default `gemini-flash-latest`), `visionFallbacks` (maks 2), `liteFallback` (1), override via env `GEMINI_MODEL_VISION_PRIMARY` / `GEMINI_MODEL_FALLBACKS`.
- Ganti SEMUA `candidateModels` inline: aiService.js L287, L731, L1114; aiClient.js `defaultGeminiDirectModels` L127; discoveryService.js L2629.
- **Ranting baru (pengganti 7-8 retry):** primary → retry 1× jika 429/transient (backoff 5s) → 1 fallback → 1 lite → STOP. Vision payload besar tidak boleh diproses ulang 7×.
- List TTS di `ttsService.js` (2 model) sudah rapi — tidak diubah.

## Batch 3 — P1: Hemat Input Gemini (adaptasi lokal)

⚠️ **Perbedaan penting dari saran audit:** `fileUri` YouTube dibaca **sisi Google** — TIDAK menyedot kuota download PC/Termux. Men-trim segment secara lokal justru MENAMBAH bandwidth (yt-dlp partial download) yang selama ini kita hemat. Karena itu:

- **Mode default baru `GEMINI_INPUT_MODE=scoped` (flag, default ON):** tetap stream URL penuh, TAPI prompt hanya mengizinkan pilih dari `cleanTimeWindows` per source (sudah dibangun di Batch 1a) + `fps` turunkan 0.5 → 0.25 untuk multi-video. Hem token/latensi Gemini tanpa biaya bandwidth lokal.
- **Mode opsional `GEMINI_INPUT_MODE=segments`:** reusing `RENDER_DOWNLOAD_SECTIONS` yang sudah ada — download hanya window bersih (cap total 90s/source), concat, upload via File API. Hanya aktifkan di PC (kuota WiFi besar); **default OFF di Termux** lewat device profile.
- File API path (`analyzeVideoWithGeminiFileApi`): tambahkan `mediaResolution: 'MEDIA_RESOLUTION_LOW'` + `videoMetadata: { fps: 0.5 }` agar konsisten dengan native stream.
- Ukur sebelum/sesudah via `bandwidth_stats.json` + log token Gemini (`trackBandwidth`) untuk bukti empiris (persyaratan validasi project ini).

## Batch 4 — P2: Housekeeping Repo

- **`checkSyntax.mjs` → rekursif** `server/**` (js/mjs/cjs), exclude `node_modules`, `temp`, `dataset`, `models`, `rejected_frames`, `output`, `logs`.
- **Hapus artefak root:** `temp_imports.js` (UTF-16 rusak), `temp_m3u8.f234.mp4`, `temp_m3u8.f312.mp4`, `temp_test.mp4.f399.mp4`, `cookies.txt.bak`.
- **Pindahkan ke `scratch/`** (sudah ada folder eksperimennya): `fix_imports.cjs`, `fix_cross_imports.mjs`, `temp_test.mp4` dll. **Sebelum pindah, grep import/reference** — `debug_shopee.mjs`, `extract_prompts2.mjs`, `inspect_runs.mjs`, `rxbench_pc.mjs` dipindah hanya jika tidak direferensikan package.json/menu script.
- Tambah pola `temp_*`, `*.bak`, `scratch/` ke `.gitignore` agar tidak kekakar lagi.

## Batch 5 — P2/P3: Keamanan & Ketahanan (dosis ringan, konteks lokal)

- **Quota timezone:** `APP_TIMEZONE=Asia/Jakarta` (env, default mengikuti OS agar Termux tetap benar) via `Intl.DateTimeFormat` di `quotaService.js`.
- **Cookie perms:** tulis via `fs.openSync(..., 'w', 0o600)` + `chmodSync` best-effort (no-op di Windows, efektif di Termux).
- **Token SSE:** karena aplikasi hanya localhost/LAN + token sudah support header — **turunkan ke "known tradeoff"**, catat di `.env.example`; ganti ke `fetch+ReadableStream` HANYA jika nanti deploy via Cloudflare tunnel aktif dipakai publik (ada memori pitfall "Auth via Tunnel").
- **`uncaughtException`:** ubah ke log → graceful shutdown → `process.exit(1)`; pastikan `dev-runner.js` auto-restart backend setelah crash (cek loop restartnya dulu; kalau belum ada, tambah max-3-restart dengan backoff supaya tidak boot-loop).
- **Gatekeeper one-click (dari audit #9):** cek apakah `setup-gatekeeper.sh`/`dev-runner.js` sudah memanggil `download_models.py` saat model `*.onnx` hilang; jika belum, tambah auto-download + cek ukuran file sebelum start.

## Di Luar Scope (ditunda, dicatat)

- Pelonggaran filter wajah/watermark/subtitle → **TIDAK** (audit sendiri bilang filter kualitas sudah benar).
- Optimasi prompt/cache, dataset Gatekeeper lanjutan, modernisasi dependency → setelah Batch 1-3 stabil 1 minggu pemakaian.

## Aturan Eksekusi (konvensi project)

1. Eksekusi **bertahap per batch** — Batch 1 harus lolos 1 job E2E dulu sebelum lanjut Batch 2 (memori: phased implementation & verification).
2. Setiap batch: update `server/.env.example` untuk flag baru, tambah/perbarui test vitest, `npm run test` + `check:syntax` hijau.
3. Test pakai isolated DB, jangan sentuh `jobs.db` produksi.
4. Commit per batch, push `origin main`, lalu `git pull` + restart di Termux untuk paritas.
5. Flag baru default: `scoped` ON, `segments` OFF — supaya bisa rollback tanpa rekode.

**Estimasi:** Batch 1 = pekerjaan terbesar (paling berdampak pada keluhan "proses terlalu lama/boros"); Batch 2-4 relatif cepat; Batch 5 kecil.