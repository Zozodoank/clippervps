# Perbandingan Kalibrasi Gatekeeper vs Kaggle

Status: Run A dan audit Oracle Run B selesai untuk kandidat `m-unxJ6icHc`. Run B menghasilkan video silent 6 detik, tetapi render final 18 detik ditahan karena batas minimum 20 detik; job menunggu voiceover manual.

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
- Vonis batch: 2/2 `safe=true`; kandidat diteruskan ke render. Gatekeeper mencatat pemeriksaan awal 5 frame advisory dan tidak memveto.
- Hasil Stage 1: 4 scenes, voiceover Gemini 15,92 detik, video silent 6 detik (2.493.337 byte).
- Salinan preview untuk review di PC: `scratch/runB-silent-preview.mp4` (file lokal, tidak dimasukkan Git).
- Render final: ditahan karena durasi gabungan 18,0 detik di bawah minimum 20 detik; status `awaiting_voiceover`, `hasFinalVideo=false`.
- Catatan kualitas: satu still pada detik ke-1 menampilkan produk sedang didemokan dan tidak memperlihatkan subtitle/wajah. Ini bukan review seluruh klip atau sampel 200 frame.

## Perbedaan dan review manual

| Kandidat yang sama (cakupan frame tidak identik) | Strict Run A menolak: teks/watermark 3/5 frame | Advisory Run B tidak memveto; Qwen menerima 2/2 batch | Satu still memperlihatkan demonstrasi produk; overlap frame penuh belum diverifikasi | Perbedaan gerbang; belum cukup bukti untuk menyebut false positive/negative |

False positive lokal: belum terkonfirmasi.

False negative lokal (wajah/subtitle yang lolos lokal tetapi ditolak Kaggle): belum terkonfirmasi.

## Kriteria sebelum mengaktifkan grid/classifier baru

- [ ] Analisis lokal ≤ 5 menit untuk video 5 menit.
- [ ] Tidak ada wajah/subtitle yang lolos lokal tetapi ditolak Kaggle.
- [ ] Sedikitnya 200 sampel zona teks ditinjau manual sebelum training zonemob.
- [ ] Output grid dan mapping `perFrame[].index` cocok untuk seluruh sel yang dikirim.
