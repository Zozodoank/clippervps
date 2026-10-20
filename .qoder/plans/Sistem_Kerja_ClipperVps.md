# Sistem Kerja ClipperVPS — Peta Alur Teknis End-to-End (untuk Koreksi)

Dokumen ini memetakan **apa yang benar-benar terjadi** di kode dari awal sampai akhir, per tahap, dengan acuan `file:baris` dan nama fungsi, lalu ditutup **Daftar Koreksi** berisi titik alur yang berpotensi tidak sesuai (mis. sisa Termux/10808, QC final dinonaktifkan, dll). Basis: VPS-only, Oracle lokal Qwen, tanpa Kaggle.

Istilah: **Oracle** = pemutus vonis visual lokal (Qwen2.5-VL via `llama-server` + `worker.py`), BUKAN Oracle Cloud.

---

## TAHAP 0 — Frontend memicu Auto Start
- UI mengirim `POST /api/auto/start` dengan body `{ niche, maxJobs, options, forceOverrideDailyLimit }`.
- Routing Express didaftarkan di `server/server.js:166-178`; **semua** `/api` lewat `tokenAuthMiddleware` lebih dulu (`server.js:164`). Token = `API_ACCESS_TOKEN`.
- Titik masuk backend: `server/api/routes/autoRoutes.js:171` `router.post('/auto/start')`.

## TAHAP 1 — Validasi & pembuatan "run" Auto Mode (`autoRoutes.js:171-244`)
1. `reloadEnvironment()` (baca ulang `.env`).
2. Cegah tabrakan niche: bila ada run `running/starting` dengan niche berbeda → 400 (`:175-181`).
3. **Kuota harian**: `getDailyOutputVideoStats()` (`services/quotaService.js`); batas default 20 (`server.js:296`). Lampaui → 429 kecuali `forceOverrideDailyLimit` (`:185-191`).
4. `maxJobs`: angka atau `'unlimited'` (`:196-199`).
5. **Resolusi niche**: alias (mis. `smartphone`/`hp`) dipetakan ke preset id lewat `getNichePreset(...).id`; default `kitchen_tools` (`:203-207`). Id gadget = `gadget_smartphone`.
6. Buat objek `run` (`runId=autorun_xxxx`, status `starting`), simpan ke Map `autoRuns` (`store/jobStore.js`), lalu **fire-and-forget** `runAutoStage1Worker(run).catch(...)` (`:235-242`) — TIDAK di-await. Response langsung berisi `run`.
7. Progres di-stream SSE: `GET /api/auto/progress/:runId` poll tiap 800 ms (`:255-283`).

## TAHAP 2 — Loop Worker Auto Mode (`worker/stage1Discovery.js:126` `runAutoStage1Worker`)
Loop `while (status !== stopping)` (`:142`). Tiap iterasi:
1. Cek ulang kuota harian → stop rapi (`:143-156`).
2. **Seed ledger produk-ditolak** dari riwayat job SQLite (`:108-124`, `services/productRejectLedger.js`) — anti membakar kuota untuk produk yang sudah divonis konten.
3. **Discovery produk bermerek Shopee** (BUKAN keyword OEM generik): `discoverBrandedShopeeProduct({ niche, seen })` (`services/discoveryService.js`; dipanggil `:169`). Gagal 3× → break (`:174-185`).
4. Gerbang identitas: wajib `brandedVerified` + `brand` + `productType` + `searchQueries` (`:206-218`).
5. **Gerbang produk konkret**: `isVagueOrAggregateProduct(...)` → skip judul agregat sebelum streaming, hemat kuota (`:223-230`).
6. Pilih query valid **pertama** yang memuat brand DAN (type ATAU model): `pickValidIdentitySearchQuery(...)` (`:237`). (Bug lama niche smartphone: productType selalu "Smartphone" → semua di-skip; sudah diperbaiki di sini.)
7. **Dedup harian** brand+type+model (`getAllUsedBrandProductPairsToday`, `:246-254`) dan **ledger cooldown** (`findProductRejection`, `:262-276`).
8. **SAME-PRODUCT RETENTION** (`:291-541`): maks 3 percobaan untuk merk+type SAMA; tiap percobaan cari video baru.
   - Cari video: `searchMultiEngineVideos(searchKeyword, { limit:16, strictIdentity:true, youtubeOnly:true, excludeVideoIds })` (`:308-315`).
   - Panggil pipeline: `runStage1Pipeline({...})` (`:347-384`) dengan `youtubeUrl:null` (multi-video harvesting), `options.niche`, `multiVideoHarvesting:true`, `isVideoFirst:true`, `sceneDuration:3.3`, `minDuration:30`.
   - Sukses → `successfulJobs++`, `markKeywordAsUsed(...)`, **autorun berhenti setelah 1 video** (`:387-402`, `:547-549`).
9. **Klasifikasi kegagalan** (`:428-457`): `ORACLE_UNAVAILABLE` → stop total (`:480-491`); YouTube 429/bot → stop (`:494-505`); auth/cookies → skip atau stop (`:507-525`); kuota Gemini/TTS → break (`:527-532`); API key 401 → throw (`:534-538`).
10. Vonis konten → `recordProductRejection(...)` ke ledger (`:557-574`).

## TAHAP 3 — Pipeline per job (`worker/stage1Render.js:190` `_runStage1Pipeline`, export `:2993` `runStage1Pipeline`)
Dibungkus `heavyTaskQueue` + `withAiUsageJob` (`:3296`) — antrean tugas berat agar hemat RAM/token.

### 3a. GERBANG ORACLE-ONLY (paling awal, sebelum kerja berat) — `:344-382`
- `assertOracleConnected()` (`services/vlmOracleService.js:111`): butuh `VISION_VERIFY_MODE=oracle` + `API_ACCESS_TOKEN` + **heartbeat** worker masih segar (`oracleLastSeenMs`, stale = `cfg.staleMs`).
- Bila `worker_offline` & `ORACLE_AUTO_LAUNCH=1`: `probeLlamaServerHealth()` (GET `/health`) → `maybeAutoStartLocalOracle()` (`pm2 restart llama-server oracle-worker`) → `waitForOracleOnline()` tunggu heartbeat MAJU (`services/oracleLocalSupervisor.js:40-168`).
- Gagal → `throw OracleUnavailableError` (`:379`). **Arti koreksi**: `API_ACCESS_TOKEN` kosong = SEMUA job mati.

### 3b. Cache & metadata — `:384-456`
Reuse video 1080p di `sessionTempDir` bila ada & ≥1080p (`:408-450`); terapkan paritas Filter-1 metadata (`checkVideoMetadataCompliance`) agar cache tak lolos senyap (`:420-436`).

### 3c. Jalur visual & provider — `:458-505`
`aiProvider` default gemini/openrouter; `canUseGeminiStream()` (`:471-475`); `sceneDuration`: smartphone 6.0s (×8=48s), lain 3.0–3.5s (`:476-481`).

### 3d. Akuisisi sumber (V2 blueprint) — `worker/sourceAcquisitionV2.js:156` (dipanggil via step `acquisition_v2_start` `stage1Render.js:1199`)
- `rankByMidDuration()` (durasi menengah dulu, `:40-51`).
- **Pre-screen metadata** `fetchVideoMetadataAndStream` + `checkVideoMetadataCompliance` (`:198-204`).
- **Analisa video penuh Gemini** `analyzeYouTubeVideoWithGemini` → menghasilkan **timestamp section** saja (bukan vonis sumber) (`:207-233`).
- **Preview 9:16** `downloadQuickPreview` (`services/quickPreviewService.js`) → `fastProbeLocal` ekstrak frame (`:262-290`). Tidak ada filter visual lokal; semua frame ke Oracle.
- `requireSources` (default 2) → kurang → `return` kosong (`:319-328`).
- **Window** dari clip Gemini (buang 10s awal/akhir) (`:343-348`), zigzag `buildAcquisitionPlan` (`:79-91`), jembatan ke struktur legacy `buildLegacyStructuresFromV2` (`:101-143`).

### 3e. Unduh section 1080p — `:1871-2156`
`downloadYouTubeVideo(...)` (`services/downloader.js`) per kandidat/section (prefix `sec`/`raw`/`alt`).

### 3f. Ekstraksi frame rapat + highlight — `:736-746`, `1595`
`extractFrames` (frame 9:16 interval rapat) → `selectHighlightWithAI` / `analyzeMultipleYouTubeVideosWithGemini` menentukan klip (`highlight.clips`).

### 3g. VONIS KLIP FINAL oleh Oracle — `[[ORACLE CLIP AUDIT]]` `:2256-2294`
- `auditClipsWithOracle(oracleClips, oracleFrameGroups, ...)` (`services/vlmOracleService.js:813`): frame 1080p dikirim (di-downscale `VLM_ORACLE_FRAME_HEIGHT`, grid 9:16), protokol `ORACLE_GRID_PROTOCOL='2026-10-06-grid-v1'` (`:23`).
- **Worker.py adalah KLIEN** antrean: klaim via loopback `POST /api/vlm-oracle/claim` → infer `llama-server` → `POST /api/vlm-oracle/result` (route di `api/routes/vlmOracleRoutes.js`; server hanya menyimpan/menjadaalkan).
- Klip divonis `dirty` → dibuang (`discardedDirtyClips`, `:2274-2282`). STRICT: timeout/diam/vonis tak sah → `OracleUnavailableError` → job berhenti (`:2284-2293`).

### 3h. Pemulihan klip & validasi rencana — `:2296-2417`
Slot-1 (hero) dipaksa ada (`:2299-2305`); pacing adaptif; <3 klip → **recovery** dari `pooledFrames` bersih video sama (`:2325-2387`); `normalizeRenderClips` + gerbang minimum (auto ≥3 klip/20 dtk; smartphone ≥8/45 dtk) `:2396-2417`.

### 3i. Render BISU 9:16 (deteksi-anti) — `:2438-2448`
`renderSilentAntiDetectionVideo` (`services/videoRenderer.js`): crop/reframe 9:16, hflip otomatis mati bila merek terdeteksi (`:2419-2426`), speed multiplier, segment clips.

### 3j. Naskah / storyboard AI — `:2453-2616`
`extractFrames` dari silent (interval 2.2s, maks 12) → `generateAdAdvisorScriptWithAI` (`services/aiService.js`) menghasilkan `scenes` + `voiceoverScript` + caption + lexicon. Smartphone gagal naskah = hentikan job (`:2477-2482`); selain itu fallback template naskah (`:2483-2615`).

### 3k. TTS (Gemini ONLY) — `:2637-2679`
`generateVoiceoverTTS` (`services/ttsService.js`), `activeTtsProvider='gemini_tts'` (Edge-TTS dihapus), retry 3×. Gagal total → silent tetap jalan.

### 3l. CONFORM clip ke durasi VO + Scene↔VO lockstep — `:2708-2794`
`conformClipsToVoiceover` (`services/professionalPipelineService.js`) menyamakan panjang klip ke waktu bicara nyata (`:2710-2717`); validasi alignment smartphone strict (`validateScriptSlotAlignment`) `:2740-2780`; render silent ulang dengan clips ter-conform (`:2782-2793`). Smartphone: VO wajib 45–60 dtk (`:2701-2706`).

### 3m. Subtitle + MERGE final — `:2799-2846`
`generateSrtSubtitles` (`services/subtitleService.js`, sinkron 1:1 pakai `wordBoundaries` TTS) → `mergeVoiceoverAndBurnSubtitles` (`videoRenderer.js`) membakar VO+subtitle (+BGM+SFX) ke `final_clip_<jobId>.mp4` (`:2819-2846`).

### 3n. QC FINAL — `:2848-2897`
- `RENDER_ON_APPROVAL` (flag) → **QC final DILEWATI**, hasil render langsung diterima (`:2851-2860`).
- Jika QC aktif: `runProfessionalFinalQcWithRepair` (`services/finalMasterQcService.js`) → gagal → hapus `finalOutputPath`, throw `FINAL_MASTER_QC_FAILED` (`:2886-2896`).

### 3o. Selesai & cleanup — `:2899-2977`, `3088-3151`
Bersihkan temp; susun `completedResult` (URL `/api/video/…`, `/api/download/…`, metadata highlight, finalQc, visionProvenance); `patchJob(jobId, ...)`; `updateProgress step:'completed' 100`. Manual tanpa VO → `awaiting_voiceover` (`:3088`).

### 3p. Penanganan error level pipeline — `:3152-3289`
`ORACLE_UNAVAILABLE` → status `error` (terminal, termasuk manual) `:3177-3201`. Media mentah/silent dipertahankan → `awaiting_voiceover` (`:3203-3258`). Auto tanpa final = GAGAL (throw), bukan sukses kosong (`:3245-3255`).

## TAHAP 4 — Mode Manual (alternatif dari Auto)
- `POST /api/generate` (`api/routes/generateRoutes.js:124`) → `runStage1Pipeline({ youtubeUrl, ... })` (`:256`) — satu URL/URL list, tanpa discovery Shopee.
- Riwayat/retry: `GET /api/jobs`, `POST /api/jobs/:id/retry`, `.../auto-retry/*`, `GET /api/progress/:jobId` (SSE), `GET /api/job-trace/:jobId` (`api/routes/jobsRoutes.js:131-539`).
- Lanjut VO manual untuk job `awaiting_voiceover`: `POST /api/regenerate-voiceover`, `/retry-job-tts`, `/upload-voiceover`, `/batch-tts/*` (`api/routes/voiceoverRoutes.js:140-493`) → `processJobVoiceover` (`worker/finalizationService.js`).

## TAHAP 5 — Simpan & Sajikan
- Job & status: `store/jobStore.js` (SQLite `jobs.db`, `better-sqlite3`). Media: `server/output/`, `server/temp/`.
- Unduh/tayang: `/api/video/:file`, `/api/download/:file` (`api/routes/mediaRoutes.js`).
- PM2 (VPS): `ecosystem.config.cjs` — `llama-server`, `oracle-worker`, `clipper` (`dev-runner.js`). Setup via `setup-vps.sh`; operasional via `menu-vps.sh`; runbook Oracle di `ORACLE_VPS.md`.

## TAHAP 6 — Proxy YouTube (menurut permintaan "semua lewat HP")
- `getSmartProxyArgs()` (`downloader.js:90`) → yt-dlp (`downloader`, `videoFilterService` metadata/`-g`, `quickPreviewService`).
- `getFfmpegProxyArgs()` (`downloader.js`, baru) → FFmpeg `-http_proxy` saat tarik byte stream (`videoFilterService.js` networkArgs + batch spawn). FFmpeg tidak dukung socks5 → butuh bridge privoxy HTTP→SOCKS5 (§2b `ORACLE_VPS.md`).

---

## DAFTAR KOREKSI — Titik Alur yang Kemungkinan Tidak Sesuai
1. **Sisa narasi Termux/SSH-10808** di `stage1Discovery.js:508-525` (pesan "Hubungkan SSH Reverse Proxy Termux (port 10808)", cek `isLocalPortListening(10808)`). Bertentangan dengan mandate VPS-only + model privoxy loopback 8118. Rekomendasi: ganti ke pemeriksaan endpoint `PROXY_URL`/privoxy & pesan "aktifkan bridge HP".
2. **QC final dinonaktifkan** bila `RENDER_ON_APPROVAL` aktif (`stage1Render.js:2851`). Jika alur seharusnya menolak video kotor pasca-render, ini "bocor". Konfirmasi nilai flag di `config/runtimeFlags.js`.
3. **`API_ACCESS_TOKEN` wajib** — kosong = gerbang Oracle menolak semua job (`vlmOracleService.js:111`, `oracleLocalSupervisor.js:93`). Pastikan terisi di VPS.
4. **Penamaan env basis-oracle**: worker pakai `ORACLE_BASE_URL` (default `127.0.0.1:5000`), `.env` menuliskan `VLM_ORACLE_BASE_URL`. Cek `resolveOracleConfig` (`vlmOracleService.js:46`) memakai variabel yang sama agar tidak dobel sumber.
5. **Auto berhenti setelah 1 video sukses** (`stage1Discovery.js:392,548`) meski `maxJobs>1`/`unlimited`. Bila harapan "berjalan terus sampai N", ini kontradiksi — verifikasi intended behavior.
6. **`checkYouTubeHealth()` pakai IP telanjang** (`networkDiagnosticService.js:254`) — sengaja; jangan disalahartikan sebagai jalur produksi.
7. **Gerbang "tanpa narasi"** (`stage1Render.js:439`) — VO tidak diwajibkan di cache path; pastikan konsisten dengan kebijakan "voice-over wajib".
8. **Niche smartphone 8 adegan/45–60 dtk** (`sceneDuration 6.0` `:479`; VO `:2701`; alignment strict `:2757`). Bila klien mengirim `sceneDuration` lain untuk smartphone, nilai di-override ke 6.0 — cek ekspektasi.
9. **TTS hanya Gemini** (`:2637`). Bila diharapkan fallback lain, ini by-design (mandate AGENTS.md: jangan tambah provider TTS).
10. **Kuota harian default 20** (`server.js:296`) & dihormati di `autoRoutes`/`stage1Discovery` — pastikan angka ini yang diinginkan di VPS.

## Asumsi
- Alur produksi = VPS Ubuntu + Oracle lokal Qwen (PM2), Kaggle diarsipkan.
- "Niche smartphone" = preset `gadget_smartphone`.
- Dokumen ini deskriptif (read-only); tidak mengubah kode. Tiap butir "Daftar Koreksi" adalah kandidat untuk didiskusikan/diperbaiki setelah Anda menandai mana yang tidak sesuai.