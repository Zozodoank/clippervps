# ⚠️ DEPRECATED — Folder ini TIDAK dipakai jalur produksi (sejak 2026-10)

Sejak migrasi **VPS-only**, seluruh vonis visual ditangani **Oracle lokal Qwen2.5-VL**
yang berjalan di VPS yang sama dengan backend:

- `llama-server` (GGUF, loopback `127.0.0.1:8080`) — dibangun `setup-vps.sh`
- `server/oracle_local/worker.py` via `server/oracle_local/run-worker.sh` (PM2 `oracle-worker`)
- Gerbang + auto-start: `server/services/oracleLocalSupervisor.js` (`pm2 restart llama-server oracle-worker`)

**Tidak ada satu pun file produksi** (`server/**`, `dev-runner.js`, skrip setup/menu) yang
memanggil kode di folder ini. Folder `kaggle/` dipertahankan HANYA sebagai:

1. **Arsip rollback** — bila suatu saat operator ingin menjalankan worker di GPU Kaggle lagi
   (di luar scope arsitektur saat ini).
2. **Referensi historis** — `oracle-launch.sh` & `deploy.ps1` mencatat protokol sesi notebook
   lama (`-FromTermux`, `CLOUDFLARE_TUNNEL_URL`) yang muncul di dokumen lama seperti `ngrok.md`.

## Isi folder

| File | Dulu dipakai untuk |
|---|---|
| `deploy.ps1` | Push kernel Kaggle dari PC/Termux + tulis URL tunnel ke secrets |
| `oracle-launch.sh` | Sisi notebook: pull kernel yang baru di-push |
| `vlm_oracle_qwen.py` | Worker oracle di dalam kernel Kaggle (protokol `2026-10-06-grid-v1`) |
| `test_grid_verdicts.py` | Tes unit parser vonis grid sisi notebook |
| `kernel-metadata.example.json` | Template metadata kernel Kaggle |

## Langkah re-enable (DI LUAR SCOPE — jangan dilakukan tanpa keputusan eksplisit)

1. Isi `KAGGLE_USER` / `KAGGLE_BIN` / `ORACLE_MODEL_SOURCE` aktif lagi di `server/.env`
   (saat ini dikomentari sebagai arsip).
2. Kembalikan gerbang lama: file `server/services/oracleLauncherService.js` ada di histori
   git (commit sebelum "vps-only: oracle lokal Qwen menggantikan Kaggle").
3. Jalankan `powershell -ExecutionPolicy Bypass -File kaggle/deploy.ps1 -FromTermux ...`
   dan nyalakan tunnel publik (lihat `ngrok.md`) karena arah panggilan balik menjadi
   notebook → API server.

Catatan: seluruh teks operasional di kode sudah dibersihkan dari referensi Kaggle;
menyalakan ulang jalur ini berarti menulis kembali gerbang launcher, bukan sekadar flip flag.
