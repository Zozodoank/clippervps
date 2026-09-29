/**
 * Lightweight security helpers for the ClipperVPS API (no external dependencies).
 *
 * - recordAuditEvent(): append-only JSONL trail for system-level operations
 *   (restart, open-folder, cookie upload, dictionary writes, finder helpers). These endpoints
 *   can change the machine or hold credentials, so "who did what" must survive a log scroll.
 * - createRateLimiter(): in-process fixed-window limiter to stop a runaway script (or a
 *   public visitor) from hammering expensive/system endpoints. Single-process app, so a Map
 *   is enough; no Redis, no express-rate-limit.
 */
import fs from 'fs';
import path from 'path';
import { logsDir } from './paths.js';

export const AUDIT_LOG_PATH = path.join(logsDir, 'audit.log');

function ensureLogsDir(targetDir) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    // Never let logging break a request.
  }
}

/** Rotate once the audit trail grows past ~2 MB so it cannot eat a small phone disk. */
function rotateAuditLogIfNeeded(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    if (stat.size > 2 * 1024 * 1024) {
      fs.renameSync(targetPath, `${targetPath}.1`);
    }
  } catch {
    // File may not exist yet; nothing to rotate.
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.req] Express request used to capture path/method/ip/token-mode.
 * @param {string} options.action Short verb, e.g. 'restart', 'upload-cookies'.
 * @param {string} [options.detail] Free-form context (NEVER put secrets/tokens in here).
 * @param {string} [options.logPath] Override the trail file (used by tests).
 */
export function recordAuditEvent({ req = null, action = 'unknown', detail = '', logPath = AUDIT_LOG_PATH } = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    method: req?.method || '',
    path: req?.path || req?.url || '',
    // cloudflared forwards to 127.0.0.1, so this is informational only — the token is the trust signal.
    remote: req?.ip || '',
    authMode: req?.authMode || (req ? 'unmarked' : 'n/a'),
    userAgent: req?.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 120) : '',
    detail: String(detail || '').slice(0, 300),
  };
  try {
    ensureLogsDir(path.dirname(logPath));
    rotateAuditLogIfNeeded(logPath);
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[Audit] Gagal menulis jejak audit: ${err.message}`);
  }
  return entry;
}

/**
 * Fixed-window limiter. Buckets are keyed per client + endpoint name and pruned lazily so
 * long-running servers do not accumulate memory.
 */
export function createRateLimiter({ windowMs = 60000, max = 20, name = 'general' } = {}) {
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    for (const [key, bucket] of hits.entries()) {
      if (now - bucket.start > windowMs) hits.delete(key);
    }
    lastSweep = now;
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    sweep(now);
    // A token holder shares one bucket; anonymous callers are tracked per IP.
    const key = `${name}:${req?.authMode === 'verified' ? 'auth' : (req?.ip || 'unknown')}`;
    const bucket = hits.get(key) || { start: now, count: 0 };
    if (now - bucket.start > windowMs) {
      bucket.start = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    hits.set(key, bucket);

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - bucket.start)) / 1000));
      // Saat vitest berjalan, jangan tulis ke jejak produksi (tes memakai logPath sendiri).
      if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
        recordAuditEvent({ req, action: `ratelimit:${name}`, detail: `blocked after ${bucket.count} hits` });
      }
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        error: `Terlalu banyak permintaan ke ${name}. Tunggu ${retryAfterSec}s lalu coba lagi.`,
      });
    }
    return next();
  };
}
