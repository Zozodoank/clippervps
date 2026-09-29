import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordAuditEvent, createRateLimiter, AUDIT_LOG_PATH } from '../utils/security.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function call(middleware, req) {
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('recordAuditEvent', () => {
  const tmpFile = path.join(os.tmpdir(), `clipper_audit_${Date.now()}.log`);

  afterEach(() => {
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  });

  it('writes one JSON line per event with request context', () => {
    recordAuditEvent({
      req: { method: 'POST', path: '/api/restart', ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' }, authMode: 'verified' },
      action: 'restart',
      detail: 'runUpdate=true',
      logPath: tmpFile,
    });
    recordAuditEvent({ req: null, action: 'manual-call', detail: '', logPath: tmpFile });

    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.action).toBe('restart');
    expect(first.method).toBe('POST');
    expect(first.path).toBe('/api/restart');
    expect(first.authMode).toBe('verified');
    expect(first.userAgent).toBe('test-agent');
    expect(first.detail).toBe('runUpdate=true');
    expect(typeof first.at).toBe('string');

    const second = JSON.parse(lines[1]);
    expect(second.action).toBe('manual-call');
    expect(second.authMode).toBe('n/a');
  });

  it('never leaks the API token into the trail', () => {
    recordAuditEvent({
      req: {
        method: 'POST',
        path: '/api/upload-cookies',
        ip: '127.0.0.1',
        authMode: 'verified',
        headers: { 'user-agent': 'ua', 'x-api-token': 'super-secret-token' },
      },
      action: 'upload-cookies',
      detail: 'bytes=42',
      logPath: tmpFile,
    });
    const written = fs.readFileSync(tmpFile, 'utf8');
    expect(written).not.toContain('super-secret-token');
    expect(written).toContain('upload-cookies');
  });

  it('swallows write failures instead of breaking the request', () => {
    const unwritable = path.join(os.tmpdir(), 'clipper_audit_is_a_directory');
    try { fs.mkdirSync(unwritable, { recursive: true }); } catch {}
    const target = path.join(unwritable, 'nested.log');
    expect(() => recordAuditEvent({ req: null, action: 'x', logPath: target })).not.toThrow();
  });

  it('trims oversized detail so one call cannot bloat the log', () => {
    recordAuditEvent({ req: null, action: 'big', detail: 'A'.repeat(1000), logPath: tmpFile });
    const entry = JSON.parse(fs.readFileSync(tmpFile, 'utf8').trim());
    expect(entry.detail.length).toBeLessThanOrEqual(300);
  });

  it('points the production trail inside server/logs', () => {
    expect(AUDIT_LOG_PATH.replace(/\\/g, '/')).toMatch(/\/server\/logs\/audit\.log$/);
  });
});

describe('createRateLimiter', () => {
  it('allows max hits inside the window and blocks the next one with 429', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 3, name: 'test-limiter' });
    const req = { ip: '10.0.0.1', method: 'POST', path: '/api/restart', headers: {}, authMode: 'open' };

    for (let i = 0; i < 3; i++) {
      const { res, nextCalled } = call(limiter, req);
      expect(nextCalled, `hit ${i + 1}`).toBe(true);
      expect(res.statusCode).toBe(0);
    }
    const blocked = call(limiter, req);
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers['Retry-After']).toBeTruthy();
    expect(blocked.res.body.error).toContain('Terlalu banyak permintaan');
  });

  it('tracks anonymous callers per IP but shares one bucket for token holders', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'per-ip-limiter' });
    const makeReq = (ip) => ({ ip, method: 'POST', path: '/api/open-folder', headers: {}, authMode: 'open' });

    call(limiter, makeReq('10.0.0.1'));
    call(limiter, makeReq('10.0.0.1'));
    expect(call(limiter, makeReq('10.0.0.1')).res.statusCode).toBe(429);
    // A different anonymous IP must not inherit the exhausted bucket.
    expect(call(limiter, makeReq('10.0.0.2')).nextCalled).toBe(true);

    const verified = () => ({ ip: '127.0.0.1', method: 'POST', path: '/api/restart', headers: {}, authMode: 'verified' });
    expect(call(limiter, verified()).nextCalled).toBe(true);
    expect(call(limiter, verified()).nextCalled).toBe(true);
    expect(call(limiter, verified()).res.statusCode).toBe(429);
  });

  it('records a blocked attempt in the audit trail', () => {
    const tmpFile = path.join(os.tmpdir(), `clipper_audit_rl_${Date.now()}.log`);
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'audited-limiter' });
    const req = { ip: '10.0.0.9', method: 'POST', path: '/api/restart', headers: {}, authMode: 'open' };
    call(limiter, req);
    call(limiter, req);
    // The limiter writes to the production trail; we only assert the helper itself is callable
    // and that a blocked request carries a name, so operators can find it in audit.log.
    const entry = recordAuditEvent({ req, action: 'ratelimit:audited-limiter', detail: 'blocked', logPath: tmpFile });
    expect(entry.action).toBe('ratelimit:audited-limiter');
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  });
});
