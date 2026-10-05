import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const SERVER_PORT_START = 5000;
const CLIENT_PORT = 3000;

function getNetworkIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal) {
        addresses.push(alias.address);
      }
    }
  }
  return addresses;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Tidak menemukan port backend kosong mulai dari ${startPort}.`);
}

console.log('\n======================================================');
console.log('🚀 Starting Local AI Affiliate Clipper Server...');
console.log('======================================================');

const serverPort = await findFreePort(SERVER_PORT_START);
const networkIps = getNetworkIpAddresses();

console.log(`\n📱 Local:   http://localhost:${CLIENT_PORT}`);
if (networkIps.length > 0) {
  networkIps.forEach((ip) => {
    console.log(`💻 Network: http://${ip}:${CLIENT_PORT} (Akses dari PC / HP lain di Wi-Fi yang sama)`);
  });
}
console.log(`🌐 Backend: http://0.0.0.0:${serverPort}\n`);

let isShuttingDown = false;
let serverProcess = null;

function startServerProcess() {
  const cmd = `${npmCmd} run dev`;
  serverProcess = spawn(cmd, {
    cwd: path.join(__dirname, 'server'),
    env: {
      ...process.env,
      PORT: String(serverPort),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --no-deprecation`.trim(),
    },
    stdio: 'inherit',
    shell: true,
  });

  serverProcess.on('exit', (code) => {
    if (!isShuttingDown) {
      console.log(`\n🔄 [dev-runner] Server process exited with code ${code}. Restarting backend in 1 second...`);
      setTimeout(startServerProcess, 1000);
    }
  });
}

const GATEKEEPER_PORT = 5050;
let gatekeeperProcess = null;

// Baca KEY dari environment proses, lalu fallback ke file .env proyek
// (server/.env lebih dulu, baru .env root). dev-runner TIDAK memuat dotenv, jadi
// flag pengendali harus dibaca manual supaya bisa diset dari .env di PC/Termux.
function readEnvFlagRaw(key) {
  const fromProcess = String(process.env[key] || '').trim();
  if (fromProcess) return fromProcess;
  for (const f of [path.join(__dirname, 'server', '.env'), path.join(__dirname, '.env')]) {
    try {
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$'));
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* abaikan file yang tak terbaca */ }
  }
  return '';
}

// MANDEL user 2026-10: "saya tidak membutuhkan AI lokal lagi; filter frame
// seluruhnya ditangani Qwen di Kaggle." Gatekeeper (:5050) kini TIDAK auto-start
// kecuali flag GATEKEEPER_AUTO_START dinyalakan eksplisit ('1'/'true'). Aman karena
// pipeline berjalan mode ADVISORY (videoFilterService meneruskan SEMUA frame ke
// Oracle meski gatekeeper absent). Nyalakan lagi kapan pun: GATEKEEPER_AUTO_START=1.
function gatekeeperAutoStartEnabled() {
  const v = readEnvFlagRaw('GATEKEEPER_AUTO_START').toLowerCase();
  return v === '1' || v === 'true';
}

async function startGatekeeperProcess() {
  const gatekeeperScript = path.join(__dirname, 'server', 'gatekeeper', 'service.py');
  if (!fs.existsSync(gatekeeperScript)) return;

  const portFree = await isPortFree(GATEKEEPER_PORT);
  if (!portFree) {
    console.log(`🤖 AI Local Gatekeeper is already running on port ${GATEKEEPER_PORT}.`);
    return;
  }

  const pyCmd = isWindows ? 'python' : 'python3';
  console.log(`🤖 Starting AI Local Gatekeeper on port ${GATEKEEPER_PORT}...`);
  gatekeeperProcess = spawn(pyCmd, [gatekeeperScript, '--port', String(GATEKEEPER_PORT)], {
    cwd: path.join(__dirname, 'server', 'gatekeeper'),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      ORT_LOGGING_LEVEL: '3',
      ONNXRUNTIME_LOG_LEVEL: '3',
      CUDA_VISIBLE_DEVICES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatekeeperProcess.stdout.on('data', (d) => {
    const text = d.toString().trim();
    if (text) {
      console.log(`[Gatekeeper] ${text}`);
    }
  });

  gatekeeperProcess.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (!text) return;
    // Suppress harmless GPU device discovery warnings on Android/Termux where /sys/class/drm is permission-denied
    if (text.includes('device_discovery.cc') || text.includes('GPU device discovery failed') || text.includes('/sys/class/drm')) {
      return;
    }
    console.error(`[Gatekeeper ERR] ${text}`);
  });

  gatekeeperProcess.on('exit', (code) => {
    if (!isShuttingDown) {
      console.log(`[dev-runner] Gatekeeper exited with code ${code}.`);
    }
  });
}

let ngrokProcess = null;

function startNgrokProcess(port) {
  const ngrokUrl = 'unalleged-alysia-filar.ngrok-free.dev';
  const ngrokCmd = `ngrok http ${port} --url ${ngrokUrl}`;
  console.log(`\n🌐 Membuka Ngrok Tunnel: https://${ngrokUrl} (mengarah ke port ${port})`);
  
  ngrokProcess = spawn(ngrokCmd, {
    stdio: 'ignore', // Abaikan log visual/UI ngrok agar tidak merusak console dev-runner
    shell: true,
  });

  ngrokProcess.on('exit', (code) => {
    if (!isShuttingDown) {
      console.log(`[dev-runner] Ngrok berhenti dengan kode ${code}.`);
    }
  });
}

if (gatekeeperAutoStartEnabled()) {
  await startGatekeeperProcess();
} else {
  console.log('🚫 AI Local Gatekeeper TIDAK dinyalakan (GATEKEEPER_AUTO_START!=1). Seluruh filter frame ditangani Qwen/Oracle Kaggle (mode advisory). Set GATEKEEPER_AUTO_START=1 untuk memakai AI lokal lagi.');
}

// Tunnel dikelola terpisah oleh start-tunnel.sh/PM2 di Termux. Menyalakan ngrok
// kedua dari dev-runner merebut domain yang sama; Oracle pun melihat tunnel lama
// atau tidak tersambung. Jalur standalone (npm run dev) tetap auto-tunnel secara
// default. Override eksplisit tersedia untuk operator.
const runnerIsManaged = process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined;
const autoTunnel = process.env.DEV_RUNNER_AUTO_TUNNEL === '1' ||
  (process.env.DEV_RUNNER_AUTO_TUNNEL !== '0' && !runnerIsManaged);
if (autoTunnel) {
  startNgrokProcess(serverPort);
} else {
  console.log('[dev-runner] Tunnel tidak dimulai di dalam PM2; gunakan start-tunnel.sh untuk mengelola satu tunnel.');
}
startServerProcess();

const clientCmd = `${npmCmd} run dev -- --host 0.0.0.0 --port ${CLIENT_PORT}`;
const clientProcess = spawn(clientCmd, {
  cwd: path.join(__dirname, 'client'),
  env: {
    ...process.env,
    VITE_API_TARGET: `http://localhost:${serverPort}`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --no-deprecation`.trim(),
  },
  stdio: 'inherit',
  shell: true,
});

const cleanup = () => {
  isShuttingDown = true;
  console.log('\n🛑 Shutting down services...');
  if (serverProcess) serverProcess.kill();
  if (gatekeeperProcess) {
    try { gatekeeperProcess.kill(); } catch {}
  }
  if (ngrokProcess) {
    try { ngrokProcess.kill(); } catch {}
  }
  clientProcess.kill();
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

