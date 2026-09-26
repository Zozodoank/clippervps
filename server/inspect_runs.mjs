// Baca auto_runs terbaru dari jobs.db untuk melihat alasan skip/gagal yang SEBENARNYA.
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = ['jobs.db', 'data/jobs.db', 'server/jobs.db'].map((p) => path.join(__dirname, p));
let dbPath = candidates.find((p) => fs.existsSync(p));
if (!dbPath) {
  console.log('DB tidak ditemukan. Cari file .db:');
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.db')) console.log('  ', full);
    }
  };
  walk(path.join(__dirname), 0);
  process.exit(0);
}
console.log('DB =', dbPath);
const db = new Database(dbPath, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log('tables =', tables.join(', '));
const tbl = tables.find((t) => /auto_run/i.test(t));
if (!tbl) process.exit(0);
const rows = db.prepare(`SELECT * FROM ${tbl} ORDER BY rowid DESC LIMIT 3`).all();
for (const r of rows) {
  const d = r.data ? JSON.parse(r.data) : r;
  console.log('==================================================');
  console.log('runId =', d.runId, '| niche =', d.niche, '| status =', d.status);
  console.log('sukses =', d.successfulJobs, '| gagal =', d.failedJobs, '| skipProduk =', d.skippedProducts);
  console.log('message =', d.message);
  const hist = d.messages || d.history || [];
  for (const h of hist.slice(-40)) console.log('  -', typeof h === 'string' ? h : `${h.time || ''} ${h.message || ''}`);
}
