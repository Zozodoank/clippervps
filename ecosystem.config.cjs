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
