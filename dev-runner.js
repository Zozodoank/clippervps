import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';
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

console.log('[dev-runner] Visual verdicts ditangani Oracle lokal Qwen (VPS) via llama-server + worker.py.');

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

// Tunnel dikelola terpisah oleh start-tunnel.sh/PM2 dan kini OPSIONAL (hanya untuk
// akses UI jarak jauh - alur kerja job memakai oracle lokal via loopback). Karena itu
// auto-tunnel menjadi opt-in eksplisit: hanya menyala bila DEV_RUNNER_AUTO_TUNNEL=1.
// Tidak ada lagi cabang "standalone auto-on" yang diam-diam merebut domain ngrok.
const autoTunnel = process.env.DEV_RUNNER_AUTO_TUNNEL === '1';
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
  if (ngrokProcess) {
    try { ngrokProcess.kill(); } catch {}
  }
  clientProcess.kill();
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

