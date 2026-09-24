import path from 'path';
import os from 'os';
import fs from 'fs';
import { beforeAll, afterAll } from 'vitest';

const dbPath = path.join(os.tmpdir(), `jobs-test-${process.pid}.db`);

beforeAll(() => {
  process.env.JOBS_DB_PATH = dbPath;
});

afterAll(() => {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
  } catch (e) {
    // Ignore cleanup errors
  }
});
