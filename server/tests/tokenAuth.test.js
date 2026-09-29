import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  tokenAuthMiddleware,
  isAllowedOrigin,
  isPublicApiPath,
  extractRequestToken,
  describeAuthPosture,
  buildCorsOptions,
} from '../api/middleware/tokenAuth.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverJsPath = path.resolve(testDir, '..', 'server.js');

// Assigning undefined to process.env turns it into the literal string "undefined" (truthy!),
// so every restore must delete the key instead.
const ORIGINAL_ENV = {
  API_ACCESS_TOKEN: process.env.API_ACCESS_TOKEN,
  CLOUDFLARE_TUNNEL_URL: process.env.CLOUDFLARE_TUNNEL_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  CORS_EXTRA_ORIGINS: process.env.CORS_EXTRA_ORIGINS,
};

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function runMiddleware(req) {
  const res = makeRes();
  let nextCalled = false;
  tokenAuthMiddleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('Auth middleware registration order (server.js)', () => {
  const source = fs.readFileSync(serverJsPath, 'utf8');

  it('mounts tokenAuthMiddleware BEFORE every /api router', () => {
    const authIndex = source.indexOf('app.use(tokenAuthMiddleware)');
    expect(authIndex).toBeGreaterThan(-1);

    // Anchored to line start so prose inside comments (which also mentions app.use('/api'...))
    // is not mistaken for a real route registration.
    const mountRegex = /^app\.use\('\/api[^']*'/gm;
    const mountIndices = [...source.matchAll(mountRegex)].map((m) => m.index);
    expect(mountIndices.length).toBeGreaterThan(0);

    for (const index of mountIndices) {
      expect(index).toBeGreaterThan(authIndex);
    }
  });

  it('is registered exactly once (no leftover late app.use after the routers)', () => {
    const occurrences = source.split('app.use(tokenAuthMiddleware)').length - 1;
    expect(occurrences).toBe(1);
  });

  it('no longer redeclares the middleware inline', () => {
    expect(source).not.toMatch(/function tokenAuthMiddleware\s*\(/);
  });
});

describe('tokenAuthMiddleware behaviour', () => {
  beforeEach(() => {
    setEnv({
      API_ACCESS_TOKEN: 'super-secret-token',
      CLOUDFLARE_TUNNEL_URL: '',
      PUBLIC_BASE_URL: '',
      CORS_EXTRA_ORIGINS: '',
    });
  });
  afterEach(() => setEnv(ORIGINAL_ENV));

  it('lets everything through when no token is configured (local backward-compat)', () => {
    process.env.API_ACCESS_TOKEN = '';
    const { res, nextCalled } = runMiddleware({ path: '/api/jobs', headers: {}, query: {} });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('rejects a protected endpoint without a token', () => {
    for (const apiPath of ['/api/jobs', '/api/restart', '/api/upload-cookies', '/api/generate']) {
      const { res, nextCalled } = runMiddleware({ path: apiPath, headers: {}, query: {} });
      expect(nextCalled, apiPath).toBe(false);
      expect(res.statusCode, apiPath).toBe(401);
      expect(res.body.error, apiPath).toContain('Missing API access token');
    }
  });

  it('accepts x-api-token, Bearer header, and ?api_token (EventSource path)', () => {
    const cases = [
      { path: '/api/jobs', headers: { 'x-api-token': 'super-secret-token' }, query: {} },
      { path: '/api/jobs', headers: { authorization: 'Bearer super-secret-token' }, query: {} },
      { path: '/api/progress/job123', headers: {}, query: { api_token: 'super-secret-token' } },
    ];
    for (const req of cases) {
      const { res, nextCalled } = runMiddleware(req);
      expect(nextCalled, req.path).toBe(true);
      expect(res.statusCode, req.path).toBe(0);
    }
  });

  it('rejects a wrong token without leaking the expected value', () => {
    const { res, nextCalled } = runMiddleware({
      path: '/api/restart',
      headers: { 'x-api-token': 'wrong-token-value' },
      query: {},
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token');
  });

  it('keeps the public allowlist reachable without a token', () => {
    const openPaths = [
      '/api/health',
      '/api/daily-limit',
      '/api/niches',
      '/api/video/final_clip_1.mp4',
      '/api/audio/voiceover_1.mp3',
      '/api/download/final_clip_1.mp4',
      '/api/rejected-frames/yunet/a.jpg',
    ];
    for (const apiPath of openPaths) {
      const { nextCalled } = runMiddleware({ path: apiPath, headers: {}, query: {} });
      expect(nextCalled, apiPath).toBe(true);
    }
  });

  it('does not gate non-API paths (static frontend)', () => {
    for (const reqPath of ['/', '/index.html', '/assets/app.js']) {
      const { nextCalled } = runMiddleware({ path: reqPath, headers: {}, query: {} });
      expect(nextCalled, reqPath).toBe(true);
    }
  });

  it('extractRequestToken tolerates missing headers/query objects', () => {
    expect(extractRequestToken({})).toBe('');
    expect(extractRequestToken({ headers: {}, query: {} })).toBe('');
    expect(extractRequestToken({ headers: { 'x-api-token': '  abc ' }, query: {} })).toBe('abc');
  });

  it('isPublicApiPath only opens the intended surface', () => {
    expect(isPublicApiPath('/api/health')).toBe(true);
    expect(isPublicApiPath('/api/jobs')).toBe(false);
    expect(isPublicApiPath('/api/restart')).toBe(false);
  });
});

describe('CORS origin gate', () => {
  beforeEach(() => {
    setEnv({
      API_ACCESS_TOKEN: 'super-secret-token',
      CLOUDFLARE_TUNNEL_URL: '',
      PUBLIC_BASE_URL: '',
      CORS_EXTRA_ORIGINS: '',
    });
  });
  afterEach(() => setEnv(ORIGINAL_ENV));

  it('always allows requests carrying no Origin (curl, scripts, same-origin)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('allows localhost and private LAN hosts on any port', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:5000',
      'http://192.168.1.20:3000',
      'http://10.139.186.110:5000',
      'http://172.16.0.5:3000',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(true);
    }
  });

  it('allows the configured tunnel/public origin and CORS_EXTRA_ORIGINS entries', () => {
    process.env.CLOUDFLARE_TUNNEL_URL = 'https://demo-tunnel.trycloudflare.com/';
    process.env.PUBLIC_BASE_URL = 'https://clipper.example.org';
    process.env.CORS_EXTRA_ORIGINS = 'http://123.123.123.123:3000, not-a-url ';
    expect(isAllowedOrigin('https://demo-tunnel.trycloudflare.com')).toBe(true);
    expect(isAllowedOrigin('https://clipper.example.org')).toBe(true);
    expect(isAllowedOrigin('http://123.123.123.123:3000')).toBe(true);
  });

  it('blocks an unknown public origin once a token is configured', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    const options = buildCorsOptions();
    let allowed;
    options.origin('https://evil.example.com', (err, ok) => { allowed = ok; });
    expect(allowed).toBe(false);
  });

  it('stays permissive while no token is configured (no silent breakage mid-migration)', () => {
    process.env.API_ACCESS_TOKEN = '';
    expect(isAllowedOrigin('https://evil.example.com')).toBe(true);
  });
});

describe('describeAuthPosture', () => {
  afterEach(() => setEnv(ORIGINAL_ENV));

  it('flags the dangerous combination: public tunnel without a token', () => {
    setEnv({ API_ACCESS_TOKEN: '', CLOUDFLARE_TUNNEL_URL: 'https://demo-tunnel.trycloudflare.com', PUBLIC_BASE_URL: '' });
    const posture = describeAuthPosture();
    expect(posture.tokenConfigured).toBe(false);
    expect(posture.tunnelConfigured).toBe(true);
    expect(posture.isExposedWithoutAuth).toBe(true);
  });

  it('is calm when the app is local-only and tokenless', () => {
    setEnv({ API_ACCESS_TOKEN: '', CLOUDFLARE_TUNNEL_URL: '', PUBLIC_BASE_URL: '' });
    expect(describeAuthPosture().isExposedWithoutAuth).toBe(false);
  });
});

describe('req.authMode marking (used by /health redaction and the audit trail)', () => {
  afterEach(() => setEnv(ORIGINAL_ENV));

  it("is 'open' when no token is configured", () => {
    setEnv({ API_ACCESS_TOKEN: '' });
    const req = { path: '/api/jobs', headers: {}, query: {} };
    tokenAuthMiddleware(req, makeRes(), () => {});
    expect(req.authMode).toBe('open');
  });

  it("is 'verified' for a valid token and 'public' for allowlisted paths", () => {
    setEnv({ API_ACCESS_TOKEN: 'super-secret-token' });
    const verified = { path: '/api/jobs', headers: { 'x-api-token': 'super-secret-token' }, query: {} };
    tokenAuthMiddleware(verified, makeRes(), () => {});
    expect(verified.authMode).toBe('verified');

    const publicReq = { path: '/api/health', headers: {}, query: {} };
    tokenAuthMiddleware(publicReq, makeRes(), () => {});
    expect(publicReq.authMode).toBe('public');

    const staticReq = { path: '/index.html', headers: {}, query: {} };
    tokenAuthMiddleware(staticReq, makeRes(), () => {});
    expect(staticReq.authMode).toBe('non-api');
  });

  it("is 'rejected' when the token is missing or wrong", () => {
    setEnv({ API_ACCESS_TOKEN: 'super-secret-token' });
    const missing = { path: '/api/restart', headers: {}, query: {} };
    tokenAuthMiddleware(missing, makeRes(), () => {});
    expect(missing.authMode).toBe('rejected');

    const wrong = { path: '/api/restart', headers: { 'x-api-token': 'nope' }, query: {} };
    tokenAuthMiddleware(wrong, makeRes(), () => {});
    expect(wrong.authMode).toBe('rejected');
  });
});
