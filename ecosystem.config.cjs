// ecosystem.config.cjs - Registrasi PM2 untuk alur VPS-only (Oracle lokal Qwen, tanpa Kaggle).
// Ekstensi .cjs WAJIB: root package.json bertuliskan "type": "module" sehingga file .js
// akan di-parse sebagai ESM dan module.exports PM2 baca sebagai undefined.
// Pakai: pm2 start ecosystem.config.cjs && pm2 save  (dipanggil setup-vps.sh / menu-vps.sh).
// Catatan:
// - llama-server & model GGUF dibangun/diunduh oleh setup-vps.sh ke /opt/clippervps-llama
//   dan /opt/clippervps-models. JANGAN menaruh path lain - ORACLE_VPS.md merujuk sini.
// - oracle-worker dijalankan lewat run-worker.sh (bash) karena harus memuat server/.env
//   dulu untuk ORACLE_TOKEN (= API_ACCESS_TOKEN); worker.py klaim antrean via loopback
//   127.0.0.1:5000, jadi TIDAK butuh tunnel publik.
// - clipper = dev-runner.js; tunnel di OFF-kan via DEV_RUNNER_AUTO_TUNNEL=0 karena tunnel
//   kini opsional dan dikelola terpisah (start-tunnel.sh / menu [5]).
module.exports = {
  apps: [
    {
      name: 'llama-server',
      script: '/opt/clippervps-llama/build/bin/llama-server',
      args: '-m /opt/clippervps-models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf '
        + '--mmproj /opt/clippervps-models/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf '
        + '-c 4096 -cb --host 127.0.0.1 --port 8080',
      // Qwen2.5-VL-3B Q4_K_M + mmproj f16 butuh ±2-3 GB; restart sebelum OOM menjatuhkan SSH.
      max_memory_restart: '2500M',
      autorestart: true,
      time: true,
    },
    {
      name: 'oracle-worker',
      script: 'server/oracle_local/run-worker.sh',
      interpreter: '/bin/bash',
      autorestart: true,
      time: true,
      // Batas memori oracle-worker. 1200M = nilai PROVISIONAL yang sengaja longgar
      // (belum diukur di VPS). Aturan penerimaan: cap = >= 2x RSS tertinggi teramati,
      // lantai 400M - lihat prosedur "Perubahan PM2" di ORACLE_VPS.md. Anggaran 8 GB:
      // llama-server 2500M + clipper 900M + oracle-worker 1200M = 4600M, sisa ~3,5 GB
      // untuk OS & page cache.
      // Cap ini EFEKTIF karena run-worker.sh L19 memakai `exec "$PYTHON_BIN" worker.py`
      // -> PID yang dipantau PM2 adalah python itu sendiri. Kalau `exec` hilang (mis.
      // dibungkus wrapper lagi), PM2 hanya membunuh shell sementara worker.py tetap
      // hidup: cek ulang dengan `pm2 describe oracle-worker`.
      // Worker yang mati di tengah batch TIDAK menghilangkan vonis: batch dilepas lewat
      // mekanisme staleMs (claimOracleBatch, VLM_ORACLE_STALE_SEC default 300 dtk) lalu
      // di-claim ulang, maksimal VLM_ORACLE_MAX_ATTEMPTS (default 2) percobaan. Karena
      // itu cap harus longgar: restart paksa yang memakan salah satu dari 2 jatah
      // percobaan akan membuat batch 'expired' dan waktu oracle terbuang.
      max_memory_restart: '1200M',
      min_uptime: '10s',
      // Kunci yang benar: exp_backoff_restart_delay (ms). `exp_backoff: true` TIDAK ada
      // di skema PM2 dan akan diabaikan diam-diam. Jangan digabung dengan restart_delay
      // (pilih salah satu); bila `pm2 describe oracle-worker` tidak menunjukkan backoff
      // pada PM2 versi lama, mundurlah ke restart_delay: 3000.
      exp_backoff_restart_delay: 1000,
    },
    {
      name: 'clipper',
      script: 'dev-runner.js',
      max_memory_restart: '900M',
      autorestart: true,
      time: true,
      env: {
        DEV_RUNNER_AUTO_TUNNEL: '0',
      },
    },
  ],
};
