# Perbandingan Kalibrasi Gatekeeper vs Kaggle

Status: Run A dan audit Oracle Run B selesai untuk kandidat `m-unxJ6icHc`. Run A strict berakhir tanpa output karena semua kandidat ditolak Gatekeeper. Run B telah difinalisasi dengan Gemini TTS; video akhir 23,383 detik lolos QC pipeline dan job berstatus `completed`.

## Baseline benchmark Gatekeeper (sebelum Run A/B)

- Perangkat: Android Termux, Ubuntu proot; health melaporkan SCRFD + DBNet ONNX.
- Kandidat: `m-unxJ6icHc`, durasi 348 detik; sumber 240p sekitar 3,46 MiB.
- Sampling: 273 frame (`fps=1/1.2`, crop 10 detik awal/akhir), chunk 24.
- Waktu filter dinding-ke-dinding: 528,7 detik = 1,94 detik/frame.
- Proyeksi 250 frame: 8,1 menit; proyeksi 500 frame: 16,1 menit.
- `benchmarks.stageMs`: DBNet 174.613 ms (640 ms/frame), `yunet_crop` 172.073 ms (630 ms/frame), `yunet_full` 171.339 ms (628 ms/frame), MobileNet 5.739 ms (21 ms/frame), decode 2.218 ms (8 ms/frame), Sobel sentinel 211 ms (1 ms/frame).
- Kriteria ≤5 menit/250 frame: **belum lulus**. Nama stage wajah masih `yunet_*` pada timing API walaupun `/health` melaporkan SCRFD; verifikasi label benchmark sebelum membandingkan backend.

## Run A — Gatekeeper lokal strict, Kaggle dilewati

- Job ID: `calA-strict-m-unxJ6icHc-20261006`
- Tanggal: 2026-10-06
- Video kandidat: `m-unxJ6icHc`; durasi sumber 349 detik (YouTube probe)
- Gatekeeper detector / text backend: SCRFD / DBNet ONNX
- Jumlah frame pemeriksaan visual awal: 5; 3 ditolak karena teks/watermark
- Waktu pemeriksaan awal: sekitar 12,2 detik jumlah stage Gatekeeper
- Stage timings (`benchmarks.stageMs`): decode 134 ms; face crop 3.739 ms; face full 3.832 ms; DBNet 4.297 ms; Sobel 31 ms; MobileNet 141 ms.
- Output video: tidak dibuat; semua kandidat berhenti pada gerbang visual strict.
- Metadata: `oracleCalibration.enabled=true`, `gatekeeperBackend=local-strict`, `productionEligible=false`.
- Catatan kualitas: Gatekeeper menolak footage karena teks/watermark muncul pada 3/5 frame. Tidak ada hasil produksi yang dapat dinilai.

## Run B — Gatekeeper advisory + Oracle Kaggle

- Job ID: `runB-kaggle-m-unxJ6icHc-20261006`
- Tanggal: 2026-10-06
- Video kandidat: `m-unxJ6icHc`, sumber 349 detik
- Mode: `VISION_VERIFY_MODE=oracle`, `GK_LOCAL_VETO=advisory`, kalibrasi mati, `VLM_ORACLE_GRID=0`
- Protocol Kaggle: `2026-10-06-grid-v1` (worker diperbarui sebelum job)
- Model Kaggle: `qwen2.5-vl-3b-instruct`, Tesla T4 / float16
- Frame/grid divisit: 15 frame, 2 batch per-image (8 + 7); tidak memakai grid
- Waktu inferensi Oracle dari batch: 21.105 ms + 13.044 ms = 34,1 detik
- Vonis batch: 2/2 `safe=true`; kandidat diteruskan ke render. Petunjuk Gatekeeper ikut masuk ke prompt: 2/5 frame dicurigai watermark/logo dan 1/5 subtitle/teks; Qwen diminta memeriksa sendiri, bukan mengikuti veto lokal.
- Hasil Stage 1: 4 scenes, voiceover Gemini 15,92 detik, video silent 6 detik (2.493.337 byte).
- Salinan preview untuk review di PC: `scratch/runB-silent-preview.mp4` (file lokal, tidak dimasukkan Git).
- Render final: ditahan karena durasi gabungan 18,0 detik di bawah minimum 20 detik; status `awaiting_voiceover`, `hasFinalVideo=false`.
- Catatan kualitas: satu still pada detik ke-1 menampilkan produk sedang didemokan dan tidak memperlihatkan subtitle/wajah. Ini bukan review seluruh klip atau sampel 200 frame.

## Perbedaan dan review manual

| Kandidat yang sama (cakupan frame tidak identik) | Strict Run A menolak: teks/watermark 3/5 frame | Gatekeeper mengirim kecurigaan 2 watermark + 1 teks; Qwen menerima 2/2 batch `safe=true` | Satu still memperlihatkan demonstrasi produk; overlap frame penuh belum diverifikasi | Perbedaan gerbang; belum cukup bukti untuk menyebut false positive/negative |

False positive lokal: belum terkonfirmasi.

False negative lokal (wajah/subtitle yang lolos lokal tetapi ditolak Kaggle): belum terkonfirmasi.

## Kriteria sebelum mengaktifkan grid/classifier baru

- [ ] Analisis lokal ≤ 5 menit untuk video 5 menit.
- [ ] Tidak ada wajah/subtitle yang lolos lokal tetapi ditolak Kaggle.
- [ ] Sedikitnya 200 sampel zona teks ditinjau manual sebelum training zonemob.
- [ ] Output grid dan mapping `perFrame[].index` cocok untuk seluruh sel yang dikirim.

## Follow-up audit (2026-10-06)

- The old baseline recorded `yunet_*` stage labels while Gatekeeper health reported SCRFD. The benchmark label now follows `face_gate.backend`; a fresh Termux run should report `scrfd_crop` and `scrfd_full`. Historical timing values above are unchanged and have not been remeasured.
- Grid remains disabled because the acceptance checklist above is incomplete. The Windows workspace has no DBNet model and the local dataset contains datasheet JSON rather than source image frames, so zonemob distillation/training cannot be completed from the current local inputs.

## Post-fix Termux sample benchmark (2026-10-07)

- Gatekeeper was updated to commit `97dbffd` and verified online at `/health` with SCRFD + DBNet ONNX + MobileNetV3.
- A 24-frame subset sampled across the existing 273-frame benchmark set completed in 48.94 seconds (2.039 seconds/frame), with 8 clean frames. Projection: about 8.5 minutes per 250 frames; the 5-minute target remains unmet.
- Gatekeeper regression checks passed on Termux: `test_phase1_efficiency.py`, `test_face_policy.py` (29 passed), and `test_zone_text_backend.py` (2 passed).
- This is a performance subset only; it does not establish false-negative parity against Kaggle. Keep grid disabled until the full acceptance checklist is verified.

## Live advisory sample + tunnel recovery (2026-10-07)

- The Termux Gatekeeper rechecked the same 24 spread-out images (`f0001.jpg` through `f0254.jpg`, every 11th frame) using `gatekeeperMode=advisory`, strict face policy, SCRFD crop-only, and DBNet advisory target 480.
- Result: 24 frames in 24.17 s (1.007 s/frame; projected 4.20 min/250). Five frames were locally rejected: three letterbox/orientation, one bottom-left text badge, and one dominant-text frame. The other 19 were locally clean.
- A live Oracle grid submission reached Kaggle, but its image request returned HTTP 403 because the one-off PRoot runner stored temporary frames outside the API process's allowed frame root. This is a harness/runtime-path failure, not a model verdict; it provides no Gatekeeper-vs-Kaggle parity evidence. Do not count it as either a false positive or a false negative.
- The same 24-frame Oracle comparison must be rerun through the API process's own runtime/root so the staged images pass the route allowlist. The 2x2 unit tests pass, but keep `VLM_ORACLE_GRID=0` until a live full-cell mapping run succeeds.
- Tunnel recovery: ngrok rejected a second session with `ERR_NGROK_334`; the Cloudflare quick tunnel fallback connected. `start-tunnel.sh` previously searched only PM2 stdout even though cloudflared wrote the URL to stderr. Commit `ac06c55` fixes URL discovery using only new lines from both streams. The replacement tunnel returned HTTP 200 for `/api/health`, and the Kaggle worker loaded the updated private config and heartbeated.
- Grid tests: `npm test -- --run tests/vlmOracleGrid.test.js tests/vlmOracle.test.js` passed 109/109. These cover software mapping behavior, not the blocked live image-fetch path.

## Grid run through live API runtime (2026-10-07)

- Termux was reachable again. The previous manually started API process had exited while PM2/tunnel remained online; I restarted the stack in the existing device-local tmux session and verified `/api/health` 200, Gatekeeper `/health` online (SCRFD + DBNet ONNX + MobileNetV3), and the public tunnel `/api/health` 200.
- Re-ran the exact 24-frame Gatekeeper sample in the API host environment: 25.44 s, 19 local clean, 5 locally rejected; stage counts remain 21 SCRFD crop, 21 DBNet, 19 MobileNet.
- Restarted Kaggle, observed fresh heartbeat from protocol `2026-10-06-grid-v1`, then submitted the 24 source frames as six 2x2 grids through the API runtime, so the notebook fetched API-allowlisted files successfully. Kaggle claimed and completed the batch.
- This exposed the grid verdict issue: Qwen returned no usable `perFrame` entries for the grid, so strict server mapping rejected all 24 cells as unverified. This is a model-output coverage gap, not a clean decision, and no parity result can be counted.
- Fixed the Kaggle worker in commit `17a373b`: it now individually crops and asks Qwen about every missing cell. Failed individual crops remain `verified=false`, preserving strict server behavior. Added offline mapping/refinement contract tests: 3/3 pass; Python syntax compilation and `git diff --check` pass.
- At the time of this entry, live revalidation remained outstanding and grid stayed disabled. This was superseded by the completed live acceptance recorded below.

## Live 2x2 advisory-to-Oracle acceptance (2026-10-07)

- Used the same 24 spread-out source frames from `grid-advisory-audit-20261007-live_reviewframes` that Gatekeeper had already analyzed in advisory mode (17 locally clean, 7 advisory findings).
- Submitted them through `sanitizePoolWithOracle` in the Termux API runtime with `VLM_ORACLE_GRID=2`; the complete Gatekeeper `discardedFrames` report was passed as advisory `localHints` for Kaggle/Qwen to inspect independently.
- Kaggle worker heartbeat identified protocol `2026-10-06-grid-v1` and source hash `bf1da02600ed94f9a134097cbe4fd817`.
- All 3 grid batches completed; server returned `checked=24`, `timedOut=0`, `rejected=0`, and no blacklisted frames in 44.2 seconds. This proves complete live grid cell mapping and confirms Kaggle remained final decision maker even for Gatekeeper findings.
- Set Windows `server/.env` to `VLM_ORACLE_GRID=2` after this full live acceptance. `VISION_VERIFY_MODE=oracle` and `ORACLE_OFFLINE_CALIBRATION=0` remain in force. Termux runtime leaves the grid variable unset, which resolves to the same grid default (`2`).
- Interpretation: Gatekeeper's 7 flags were advisory signals; Qwen accepted all 24 after inspection. This comparison is not ground-truth proof that the 7 flags are false positives. ZoneText's separate 200-frame manual review is now recorded in `server/gatekeeper/ZONE_TEXT_DISTILLATION_AUDIT.md`; that review found additional TL pseudo-label misses, so it does not clear the training quality gate.

## ZoneText distillation audit (2026-10-07)

- The Windows checkout had only 38 datasheet JSONs and no source image assets, but the live Termux runtime retained 4,202 raw candidate frames across 10 jobs. A deterministic 400-frame subset was staged outside the repository (`/tmp/zone-source`) with job-level train/validation isolation (300/100) and distilled by the existing DBNet script to `/tmp/zone-distilled`.
- Manually reviewed a random 200-frame visual contact sheet against the six DBNet zone labels. Repeated top-left creator/account overlays were visibly present while the `TL` label was `0`; many of those examples were all-zero labels. This confirms a material pseudo-label false-negative risk.
- Training was not run. The review gate failed, and PyTorch is not installed on either Windows or the Termux Ubuntu runtime. ZoneMob stays experimental and `GK_TEXT_BACKEND` remains DBNet.
- Full record and label limitations are documented in `server/gatekeeper/ZONE_TEXT_DISTILLATION_AUDIT.md`. Contact sheets were kept under the Windows temp directory, not committed, because they contain user runtime video frames.

## Run-state recheck (2026-10-07)

- The Termux SSH endpoint `172.17.4.194:8022` is reachable; live API health is `ok`, and Gatekeeper health is online with SCRFD, DBNet ONNX, and MobileNetV3.
- Authenticated `/api/jobs` inspection confirms `runB-kaggle-m-unxJ6icHc-20261006` is still `awaiting_voiceover`: `hasSilentVideo=true`, `hasFinalVideo=false`, and `voiceoverAudioUrl=null`. The matching calibration Run A jobs are `error` after all candidate frames were rejected; no final Run A video exists.
- The Run B record has four scenes and a silent video. Producing its final video requires either the app's explicit Gemini TTS regeneration action (which sends the script to Gemini and may use account quota) or a user-provided voiceover file. I left the job untouched and did not spend TTS quota.
- The Kaggle kernel is currently idle/offline after its configured idle shutdown; Termux keeps `ORACLE_AUTO_LAUNCH=1`. The completed 24-frame cooperative grid run remains the current live acceptance evidence.

## Run B Gemini TTS finalization (2026-10-07)

- The user explicitly selected Gemini TTS. The first request generated 16.27s of audio, then failed because `conformClipsToVoiceover()` stopped at 18s while auto-mode render validation requires at least 20s; the failed request cleaned its temporary audio and created no final video.
- Fixed that implementation mismatch by raising the conform floor to 20s and persisting a custom finalization script back to `voiceoverScript`. The TTS retry used only `gemini-3.1-flash-tts-preview` / `gemini_tts`; the script adds a factual line about grinding spices, matching the product title.
- Gemini returned 23.38s of audio. Conform rendered a 23.38s silent edit, generated 11 synchronized ASS subtitle entries, and completed the final render plus pipeline QC.
- Authenticated `/api/jobs` reports `stage=completed`, `hasFinalVideo=true`, and `ttsProvider=gemini_tts`. `ffprobe` confirms a 23.383008s 1080x1920 H.264 video stream plus AAC audio; file size is 17,860,074 bytes.
- Termux LAN URL: `http://172.17.4.194:5000/api/video/final_clip_runB-kaggle-m-unxJ6icHc-20261006.mp4`. The local API remains available and the temporary ngrok tunnel is stopped.
- The Termux Gatekeeper was restarted after the API runner restart and `/health` again reports SCRFD + DBNet ONNX + MobileNetV3. Kaggle remains the configured final Oracle; the previously completed live 24-frame grid acceptance remains the Gatekeeper-to-Kaggle evidence.

## Windows Gatekeeper runtime setup audit (2026-10-07)

- Added `server/gatekeeper/requirements-runtime.txt` and `setup-windows.ps1`; `dev-runner.js` now prefers the Gatekeeper virtual environment when present. `download_models.py` uses the certifi trust bundle when installed, preserving TLS verification.
- Created `server/gatekeeper/.venv`, installed OpenCV/NumPy/ONNX Runtime/certifi, and downloaded SCRFD, DBNet, and MobileNetV3 model assets (ignored by Git).
- Initial Windows startup used `yunet`, `gradient_fallback`, and `entropy_variance` because Python 3.8+ did not search the venv's app-local MSVC DLL directory when loading ONNX Runtime. The required runtime DLLs were already present in `.venv/Scripts`; system-wide installation was unnecessary.
- `service.py` now registers the venv `Scripts` directory with `os.add_dll_directory()` before importing native packages, and `setup-windows.ps1` performs the same app-local runtime check. A Windows smoke startup on port 5051 loaded SCRFD, DBNet PP-OCRv4 ONNX, and MobileNetV3; `/health` returned `online` with `scrfd`, `dbnet_onnx`, and `mobilenetv3_imagenet`. The temporary process was stopped after the health check.
- This proves the Windows Gatekeeper can use the intended local models. It is a startup/health check, not a full Windows frame-quality or performance benchmark; the live advisory-to-Kaggle acceptance remains the production decision-path evidence.

## Full advisory benchmark of retained 273-frame sample (2026-10-07)

- Ran the retained `/tmp/bench_gk/frames` sample through the live Termux Gatekeeper in `gatekeeperMode=advisory`, strict face policy, 24-frame batches.
- All 273/273 frames returned valid `status=success` responses. Wall time was 285.94 seconds total (1.047 s/frame; linear projection 4.36 minutes/250 frames). The performance target of <=5 minutes/250 frames is met for this retained sample.
- The first 24 frames completed in 0.405 seconds because all 24 were consistently rejected at the orientation stage; response reported `totalFrames=24`, `cleanFramesCount=0`, `discardedFramesCount=24`, `stageCounts.frames_in=24`, and `rejectsByStage.orientation=24`. They were valid fast-path decisions, not a failed request.
- Aggregate results: 199 clean and 74 discarded. Summed stage timing: SCRFD crop 180.4 s (661 ms/frame), DBNet 84.9 s (311 ms/frame), MobileNet 14.0 s (51 ms/frame), decode 4.9 s (18 ms/frame), Sobel sentinel 0.22 s (0.8 ms/frame).
- Advisory pipeline skips the SCRFD full-frame pass and lowers DBNet input size. This measures Gatekeeper's advisory cost only; it does not establish false-negative parity or quality against Kaggle. Full strict mode remains slower.

## Phase 2 runtime configuration audit (2026-10-07)

The live Windows `server/.env` matches the intended cooperative Oracle setup and sampling budget:

- `VISION_VERIFY_MODE=oracle`, `ORACLE_OFFLINE_CALIBRATION=0`, `VLM_ORACLE_GRID=2`, and `GATEKEEPER_AUTO_START=1`.
- `RENDER_SAMPLE_INTERVAL_SEC=1.2`, `VLM_ORACLE_FRAME_HEIGHT=240`, `VLM_ORACLE_MAX_FRAMES=500`, `VLM_ORACLE_AUDIT_MAX_FRAMES=240`, `SAMPLE_MAX_FRAMES=500`, `VLM_ORACLE_TOTAL_TIMEOUT_SEC=1800`, and `VLM_ORACLE_TIMEOUT_SEC=300`.
- `GK_MAX_BATCH_FRAMES=240` is retained based on measured advisory CPU cost and the documented recommendation in this plan to cap local Gatekeeper work; Kaggle retains the 500-frame Oracle ceiling. Advisory execution uses crop-only SCRFD and a lighter DBNet size, while strict/calibration retains full-frame face and 736px DBNet passes.

## Cooperative runtime recheck (2026-10-07)

- After the Termux SSH service returned, pulled commit `9605e18` and the follow-up validation record to `/root/clippervps`, preserving the two pre-existing local edits in `server/services/downloader.js` and `server/worker/stage1Render.js`.
- Started the local Termux API + Vite UI with `DEV_RUNNER_AUTO_TUNNEL=0`; LAN probes returned HTTP 200 on ports 5000 and 3000. Gatekeeper `/health` returned online with SCRFD, DBNet ONNX, and MobileNetV3.
- Restarted the configured ngrok tunnel via `start-tunnel.sh auto`; its public `/api/health` probe passed with HTTP 200. Authenticated `/api/vlm-oracle/status` then reported `enabled=true`, `mode=oracle`, `connected=true`, protocol `2026-10-06-grid-v1`, and zero pending/claimed batches.
- Pushed the Kaggle worker/config from Termux using the existing `oracle-launch.sh`, with a five-minute self-stop cap. Kaggle booted Qwen2.5-VL-3B on Tesla T4 and loaded the mounted model, but no job arrived during this recheck (`vonis=0`, `gagal=0`); the worker ended at its five-minute cap and Kaggle reports `KernelWorkerStatus.COMPLETE`. This verifies tunnel, API, authentication and worker startup together, but is not a new frame-verdict acceptance run. The earlier 24-frame live advisory-to-grid acceptance remains the frame-level proof.
- A later runtime check confirmed the Kaggle heartbeat had expired, as expected after its capped session. The API/UI and Gatekeeper remained online on Termux. No new video frames were submitted in this runtime recheck.
