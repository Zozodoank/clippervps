import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Kontrak API client <-> server.
//
// Mengapa berbasis teks, bukan impor rute: client/ tidak punya perkakas tes
// React (dan memasangnya berarti menambah dependensi dev yang ikut ter-install
// di VPS/Termux). Yang ingin dijaga di sini sempit tapi nyata: tidak ada
// panggilan /api/... dari UI yang menunjuk ke rute yang tidak ada.
//
// Pemindaian TIDAK menempel pada `fetch(`. `client/src/utils/auth.js` hanya
// membajak window.fetch untuk menyisipkan header token (setupGlobalFetchAuth),
// jadi situs panggilan tetap `fetch('/api/...')` polos - tetapi pola
// `const url = '/api/x'; fetch(url)` dan `new EventSource('/api/...')` akan
// bocor jika pindainya menunggu `fetch(` di sebelah literal. Maka: (1) ambil
// SEMUA string/template literal yang berawalan /api/, (2) pindai call `fetch(`
// terpisah untuk metode HTTP ketika terbaca.
// ============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientSrcDir = path.join(repoRoot, 'client', 'src');
const routesDir = path.join(repoRoot, 'server', 'api', 'routes');
const serverJs = path.join(repoRoot, 'server', 'server.js');

// Prefix per-router DIDEKLARASIKAN EKSPLISIT. Menebak dari isi file akan
// memasang seluruh kontrak draftsRoutes dengan salah, karena file itu digantung
// di /api/drafts, bukan /api (lihat server.js: app.use('/api/drafts', draftsRoutes)).
const ROUTER_PREFIXES = {
  jobsRoutes: '/api',
  autoRoutes: '/api',
  voiceoverRoutes: '/api',
  mediaRoutes: '/api',
  generateRoutes: '/api',
  systemRoutes: '/api',
  vlmOracleRoutes: '/api',
  aiUsageRoutes: '/api',
  draftsRoutes: '/api/drafts',
};

// Pengecualian HARUS disertai alasan tertulis. kosong = tidak ada.
const PATH_EXCEPTIONS = new Set();
const METHOD_EXCEPTIONS = new Set();

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Semua segmen variatif jadi wildcard satu segmen agar sisi client dan sisi
// Express bisa dibandingkan: `${jobId}`, `:id`, `*` semuanya berarti ":param".
function normalizeApiPath(raw) {
  return raw
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/:[A-Za-z0-9_]+/g, ':param')
    .replace(/\*/g, ':param')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

const API_LITERAL_RE = /(['"`])(\/api\/[^'"`\s]*)\1/g;
const ROUTER_DEF_RE = /router\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g;
const APP_DEF_RE = /app\.(get|post|put|patch|delete)\(\s*(['"`])(\/api\/[^'"`]+)\2/g;

function collectClientCalls(files) {
  const paths = new Map(); // normalizedPath -> [file, ...]
  const calls = []; // { path, method, file }
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');

    for (const match of src.matchAll(API_LITERAL_RE)) {
      const p = normalizeApiPath(match[2]);
      if (!paths.has(p)) paths.set(p, []);
      if (!paths.get(p).includes(rel)) paths.get(p).push(rel);
    }

    // Metode HTTP hanya diambil bila literal path berada DI DALAM call fetch(...)
    // yang sama - jendela tetap = satu pemanggilan, bukan "berapa karakter ke depan".
    for (const open of indicesOf(src, 'fetch(')) {
      const callText = balancedText(src, open + 'fetch('.length - 1);
      // matchAll (bukan String.match + /g) karena yang dibutuhkan grup tangkapan.
      const pathMatch = callText.matchAll(API_LITERAL_RE).next();
      if (pathMatch.done) continue;
      const methodMatch = callText.match(/method:\s*(['"])([A-Za-z]+)\1/);
      calls.push({
        path: normalizeApiPath(pathMatch.value[2]),
        method: methodMatch ? methodMatch[2].toUpperCase() : null,
        file: rel,
      });
    }
  }
  return { paths, calls };
}

function indicesOf(haystack, needle) {
  const out = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

// Potongan seimbang-paren dari indeks pembuka '('; batas 4000 karakter cukup
// untuk satu panggilan fetch dan mencegah pembacaan menyeret panggilan lain.
function balancedText(src, openIndex) {
  let depth = 0;
  const limit = Math.min(src.length, openIndex + 4000);
  for (let i = openIndex; i < limit; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return src.slice(openIndex, limit);
}

function collectServerRoutes() {
  const routes = []; // { path, methods:Set }
  for (const [name, prefix] of Object.entries(ROUTER_PREFIXES)) {
    const file = path.join(routesDir, `${name}.js`);
    if (!fs.existsSync(file)) throw new Error(`Berkas rute hilang: ${name}.js (didaftarkan di ROUTER_PREFIXES)`);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(ROUTER_DEF_RE)) {
      const sub = normalizeApiPath(match[3]).replace(/^\/+/, '');
      const full = normalizeApiPath(`${prefix}${sub ? '/' + sub : ''}`);
      addRoute(routes, full, match[1]);
    }
  }
  if (fs.existsSync(serverJs)) {
    for (const match of fs.readFileSync(serverJs, 'utf8').matchAll(APP_DEF_RE)) {
      addRoute(routes, normalizeApiPath(match[2]), match[1]);
    }
  }
  return routes;
}

function addRoute(routes, fullPath, method) {
  let entry = routes.find((r) => r.path === fullPath);
  if (!entry) {
    entry = { path: fullPath, methods: new Set() };
    routes.push(entry);
  }
  entry.methods.add(method.toUpperCase());
}

// Wildcard = SATU segmen (`:param` di sisi server, atau segmen client yang
// mengandung bagian dinamis seperti `final_clip_:param.mp4`).
function findRoute(routes, clientPath) {
  const cs = clientPath.split('/').filter(Boolean);
  return routes.find((r) => {
    const ss = r.path.split('/').filter(Boolean);
    if (ss.length !== cs.length) return false;
    return ss.every((seg, i) => seg === ':param' || seg === cs[i] || cs[i] === ':param');
  });
}

const clientFiles = walkJs(clientSrcDir);
const clientMissing = clientFiles.length === 0;
if (clientMissing) {
  console.warn('[apiContract] client/src tidak ditemukan (checkout hanya berisi server/?) - tes dilewat.');
}

const describeGuard = clientMissing ? describe.skip : describe;

describeGuard('Kontrak API client <-> server', () => {
  const { paths, calls } = collectClientCalls(clientFiles);
  const routes = collectServerRoutes();

  it('menemukan rute server untuk setiap path /api/ yang dipanggil client', () => {
    const orphan = [...paths.keys()].filter(
      (p) => !findRoute(routes, p) && !PATH_EXCEPTIONS.has(p),
    );
    expect(
      orphan,
      `Endpoint client tanpa rute server:\n${orphan.map((p) => `  ${p}  <- ${paths.get(p).join(', ')}`).join('\n')}`,
    ).toEqual([]);
  });

  it('setidaknya memetakan seluruh rute server yang dikenal (sanity parser)', () => {
    // Penegas bahwa pemindai benar-benar membaca, bukan diam-diam menghasilkan
    // set kosong yang membuat tes pertama selalu "lulus".
    expect(routes.length).toBeGreaterThan(40);
    expect([...paths.keys()].length).toBeGreaterThan(10);
    expect(routes.some((r) => r.path.startsWith('/api/drafts'))).toBe(true);
  });

  it('memakai metode HTTP yang benar-benar terdaftar (hanya bila terbaca pada call yang sama)', () => {
    const wrong = [];
    for (const call of calls) {
      if (!call.method || PATH_EXCEPTIONS.has(call.path) || METHOD_EXCEPTIONS.has(`${call.method} ${call.path}`)) continue;
      const route = findRoute(routes, call.path);
      if (!route) continue; // sudah dilaporkan tes pertama
      if (route.methods.has('ALL') || route.methods.has(call.method)) continue;
      wrong.push(`  ${call.method} ${call.path}  <- ${call.file} (server: ${[...route.methods].join('/')})`);
    }
    expect(wrong, `Metode HTTP tidak terdaftar di server:\n${[...new Set(wrong)].join('\n')}`).toEqual([]);
  });
});
