import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:5000';

  // HMR DINONAKTIFKAN secara default.
  // Alasannya: di Android/Termux, saat browser berpindah ke aplikasi lain tab di-freeze dan
  // WebSocket HMR ikut terputus. Ketika kembali, @vite/client melakukan ping ulang dan,
  // bila koneksi sempat hilang, MEMAKSA location.reload() - menghapus judul/deskripsi yang
  // sedang diketik di mode manual. Matikan HMR => tidak ada auto-reload saat kembali ke tab.
  // Butuh hot-reload saat develop di PC? Set env VITE_HMR=1 (atau nyalakan ulang di bawah).
  const hmrEnabled = env.VITE_HMR === '1';

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0', // Listen on all network interfaces (LAN / Wi-Fi)
      port: 3000,
      cors: true,
      allowedHosts: true,
      hmr: hmrEnabled,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
