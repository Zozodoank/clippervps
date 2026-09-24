import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobsJson = path.join(__dirname, 'jobs.json');
if (!fs.existsSync(jobsJson)) { 
  console.log('Tidak ada jobs.json, lewati.'); 
  process.exit(0); 
}

const db = new Database(path.join(__dirname, 'jobs.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');

const jobs = JSON.parse(fs.readFileSync(jobsJson, 'utf8'));
const stmt = db.prepare('INSERT OR IGNORE INTO jobs (id, data) VALUES (?, ?)');
let n = 0;
for (const [id, data] of Object.entries(jobs)) {
  const clone = { ...data };
  delete clone.geminiApiKey; 
  delete clone.apiKey; 
  delete clone.openRouterApiKey;
  stmt.run(id, JSON.stringify(clone));
  n++;
}
console.log(`Migrasi ${n} job selesai. Rename jobs.json -> jobs.json.migrated.`);
fs.renameSync(jobsJson, jobsJson + '.migrated');
