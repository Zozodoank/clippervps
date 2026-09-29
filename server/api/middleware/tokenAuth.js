/**
 * Token authentication + CORS gate for the ClipperVPS API surface.
 *
 * WHY THIS FILE EXISTS
 * The auth middleware used to be declared inline in server.js and registered AFTER the
 * /api routers were mounted, so Express never reached it for any endpoint handled by those
 * routers (POST /restart, /open-folder, /upload-cookies, /generate, /jobs/:id/retry, ...).
 * Keeping it here makes it importable, testable, and mounted before every route on purpose.
 *
 * SECURITY POSTURE NOTE
 * Never exempt a request because it came from loopback. cloudflared runs on this same host
 * and forwards public visitors to 127.0.0.1, so "remote address is local" proves nothing.
 * The token is the only trust signal. When API_ACCESS_TOKEN is empty the API stays fully open
 * (backward-compatible local use on PC / Termux), and server.js prints a loud warning.
 */
import crypto from 'crypto';
import { recordAuditEvent } from '../../utils/security.js';

/** Paths that must stay reachable without a token (health probes, media the UI streams). */
const PUBLIC_EXACT_PATHS = new Set([
  '/api/health',
  '/api/daily-limit',
  '/api/niches',
]);

const PUBLIC_PATH_PREFIXES = [
  '/api/video/',
  '/api/audio/',
  '/api/download/',
  '/api/video-player-file',
  '/api/rejected-frames',
];

export function getApiAccessToken() {
  return (process.env.API_ACCESS_TOKEN || '').trim();
}

export function isPublicApiPath(reqPath = '') {
  if (PUBLIC_EXACT_PATHS.has(reqPath)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => reqPath.startsWith(prefix));
}

/** Accepts x-api-token, "Authorization: Bearer <token>", or ?api_token= (used by EventSource). */
export function extractRequestToken(req) {
  const headers = req?.headers || {};
  let reqToken = headers['x-api-token'];
  if (!reqToken && headers['authorization']) {
    const authHeader = String(headers['authorization']);
    if (authHeader.startsWith('Bearer ')) reqToken = authHeader.slice(7).trim();
  }
  if (!reqToken && req?.query && req.query.api_token) {
    reqToken = String(req.query.api_token).trim();
  }
  return typeof reqToken === 'string' ? reqToken.trim() : '';
}

function tokensMatch(expected, provided) {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(String(provided));
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/** Percobaan auth gagal dicatat, kecuali saat vitest berjalan (agar log produksi tidak kotor). */
function noteRejectedAttempt(req, reqPath, reason) {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  recordAuditEvent({ req, action: 'auth-rejected', detail: `${reason} path=${reqPath}` });
}

export function tokenAuthMiddleware(req, res, next) {
  const token = getApiAccessToken();
  // No token configured => behave exactly as before this middleware was ever enforced.
  if (!token) {
    req.authMode = 'open';
    return next();
  }

  const reqPath = req.path || '';

  // Static frontend files and non-API paths are served by later handlers.
  if (!reqPath.startsWith('/api/')) {
    req.authMode = 'non-api';
    return next();
  }

  if (isPublicApiPath(reqPath)) {
    req.authMode = 'public';
    return next();
  }

  const provided = extractRequestToken(req);
  if (!provided) {
    req.authMode = 'rejected';
    noteRejectedAttempt(req, reqPath, 'missing-token');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing API access token. Provide x-api-token header or ?api_token query param.',
    });
  }
  if (!tokensMatch(token, provided)) {
    req.authMode = 'rejected';
    noteRejectedAttempt(req, reqPath, 'invalid-token');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid API access token.',
    });
  }
  // 'verified' = a valid token presented. Endpoints may reveal config details only in this mode.
  req.authMode = 'verified';
  return next();
}

/** Private/LAN hosts are allowed so a phone on the same network can still drive the UI. */
function isPrivateHostOrigin(origin) {
  try {
    const { protocol, hostname } = new URL(origin);
    if (!['http:', 'https:'].includes(protocol)) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function getExplicitCorsOrigins() {
  const fromEnv = [
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.PUBLIC_BASE_URL,
    ...(String(process.env.CORS_EXTRA_ORIGINS || '').split(',')),
  ];
  const origins = new Set();
  for (const raw of fromEnv) {
    const value = String(raw || '').trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore malformed entries but keep the app booting.
      console.warn(`[Auth] Ignoring malformed CORS origin: "${value}"`);
    }
  }
  return origins;
}

let warnedBlockedOrigin = false;

/**
 * Requests without an Origin header (curl, scripts, same-origin navigation) are always
 * permitted — CORS only constrains browsers, and internal tooling must keep working.
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (isPrivateHostOrigin(origin)) return true;
  if (getExplicitCorsOrigins().has(origin)) return true;
  // Until a token is configured we do not want to silently break an existing workflow.
  if (!getApiAccessToken()) return true;
  if (!warnedBlockedOrigin) {
    warnedBlockedOrigin = true;
    console.warn(`[Auth] 🚫 CORS blocked unknown origin: ${origin} (add it to CORS_EXTRA_ORIGINS if legitimate)`);
  }
  return false;
}

export function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  };
}

/** Boot-time description of the effective security posture (used by server.js logging). */
export function describeAuthPosture() {
  const tokenConfigured = Boolean(getApiAccessToken());
  const tunnelConfigured = Boolean(
    String(process.env.CLOUDFLARE_TUNNEL_URL || '').trim() || String(process.env.PUBLIC_BASE_URL || '').trim()
  );
  return {
    tokenConfigured,
    tunnelConfigured,
    // A publicly reachable app without a token is the exact case this middleware must flag.
    isExposedWithoutAuth: !tokenConfigured && tunnelConfigured,
  };
}
