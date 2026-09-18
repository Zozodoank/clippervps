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
  serverProcess = spawn(npmCmd, ['run', 'dev'], {
    cwd: path.join(__dirname, 'server'),
    env: {
      ...process.env,
      PORT: String(serverPort),
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
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatekeeperProcess.stdout.on('data', (d) => {
    const text = d.toString().trim();
    if (text.includes('Serving') || text.includes('ready') || text.includes('aktif') || text.includes('AKTIF') || text.includes('Gatekeeper')) {
      console.log(`[Gatekeeper] ${text}`);
    }
  });

  gatekeeperProcess.on('exit', (code) => {
    if (!isShuttingDown) {
      console.log(`[dev-runner] Gatekeeper exited with code ${code}.`);
    }
  });
}

await startGatekeeperProcess();
startServerProcess();

const clientProcess = spawn(npmCmd, ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(CLIENT_PORT)], {
  cwd: path.join(__dirname, 'client'),
  env: {
    ...process.env,
    VITE_API_TARGET: `http://localhost:${serverPort}`,
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
  clientProcess.kill();
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

