import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Holder bersama untuk hasil execFile yang di-mock (di-hoist agar tersedia saat vi.mock dieksekusi).
const h = vi.hoisted(() => ({ stdout: '', err: null, calls: [] }));

vi.mock('child_process', () => ({
  // verifyScene memakai promisify(execFile). Mock mengembalikan gaya callback (err, {stdout}).
  execFile: (...allArgs) => {
    const cb = allArgs[allArgs.length - 1];
    h.calls.push(allArgs);
    setImmediate(() => {
      if (h.err) return cb(h.err);
      cb(null, { stdout: h.stdout, stderr: '' });
    });
  },
}));

import {
  parseVlmJson,
  buildVlmPrompt,
  buildArgs,
  resolveVlmConfig,
  isVlmAvailable,
  verifyScene,
} from '../services/vlmGateService.js';

// Frame & biner/model palsu yang ADA di disk agar fs.existsSync lolos.
function makeFakeVlmEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-test-'));
  const bin = path.join(dir, 'llama-mtmd-cli');
  const model = path.join(dir, 'model.gguf');
  const mmproj = path.join(dir, 'mmproj.gguf');
  const frame = path.join(dir, 'f1.jpg');
  for (const p of [bin, model, mmproj, frame]) fs.writeFileSync(p, 'x');
  return { dir, bin, model, mmproj, frame, env: { GK_VLM_BIN: bin, GK_VLM_MODEL: model, GK_VLM_MMPROJ: mmproj, GK_VLM_TIMEOUT_SEC_PER_FRAME: '10' } };
}

beforeEach(() => { h.stdout = ''; h.err = null; h.calls = []; });

describe('vlmGateService - fungsi murni', () => {
  it('parseVlmJson mengekstrak objek JSON pertama walau ada teks pengantar', () => {
    const out = 'loading...\n{"safe":true,"face":false,"text":false,"watermark":false,"graphic":false}\nbye';
    expect(parseVlmJson(out)).toMatchObject({ safe: true, face: false });
  });

  it('parseVlmJson mengembalikan null bila tidak ada JSON', () => {
    expect(parseVlmJson('tidak ada json')).toBeNull();
  });

  it('buildVlmPrompt: presenter_only melonggarkan wajah demo, strict memblokir', () => {
    expect(buildVlmPrompt('kitchen_tools', 'strict')).toMatch(/REJECT if any human face/);
    expect(buildVlmPrompt('gadget_smartphone', 'presenter_only')).toMatch(/demo\/activity are acceptable/);
  });

  it('buildArgs memakai -m/--mmproj/--image (berulang)/--temp 0 (tanpa -i/--no-stream)', () => {
    const cfg = { model: 'M.gguf', mmproj: 'P.gguf' };
    const args = buildArgs(cfg, ['a.jpg', 'b.jpg'], 'PROMPT');
    expect(args).toContain('-m');
    expect(args).toContain('M.gguf');
    expect(args).toContain('--mmproj');
    expect(args).toContain('P.gguf');
    // Flag lama yang TIDAK diterima llama-mtmd-cli pra-build harus hilang.
    expect(args).not.toContain('-i');
    expect(args).not.toContain('--no-stream');
    expect(args.filter((a) => a === '--image')).toHaveLength(2);
    expect(args).toContain('--temp');
    expect(args).toContain('0');
  });

  it('resolveVlmConfig menormalkan timeout & maxFrames dengan default aman', () => {
    const cfg = resolveVlmConfig({});
    expect(cfg.perFrameSec).toBe(10);
    expect(cfg.maxFrames).toBeGreaterThanOrEqual(1);
  });
});

describe('vlmGateService - availability', () => {
  it('isVlmAvailable false bila biner/model belum ada (config default)', () => {
    expect(isVlmAvailable({ GK_VLM_BIN: '__tidakada__', GK_VLM_MODEL: '__tidakada__', GK_VLM_MMPROJ: '__tidakada__' })).toBe(false);
  });

  it('isVlmAvailable true saat biner/model/mmproj tersedia', () => {
    const { env } = makeFakeVlmEnv();
    expect(isVlmAvailable(env)).toBe(true);
  });

  it('verifyScene mengembalikan available:false tanpa memanggil biner saat config belum lengkap', async () => {
    const res = await verifyScene(['x.jpg'], { env: { GK_VLM_BIN: '__none__', GK_VLM_MODEL: '__none__', GK_VLM_MMPROJ: '__none__' } });
    expect(res).toMatchObject({ ok: false, available: false });
    expect(h.calls.length).toBe(0); // biner tidak dipanggil
  });
});

describe('vlmGateService - verifyScene (execFile di-mock)', () => {
  let fakes;
  beforeEach(() => { fakes = makeFakeVlmEnv(); });

  it('safe:true saat VLM mengembalikan JSON aman', async () => {
    h.stdout = '{"safe":true,"face":false,"text":false,"watermark":false,"graphic":false}';
    const res = await verifyScene([fakes.frame], { env: fakes.env });
    expect(res).toMatchObject({ ok: true, available: true, safe: true, face: false });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('safe:false -> vonis konten REJECT (bukan infra)', async () => {
    h.stdout = '{"safe":false,"face":true,"text":true,"watermark":false,"graphic":false}';
    const res = await verifyScene([fakes.frame], { env: fakes.env });
    expect(res).toMatchObject({ ok: true, safe: false, face: true, text: true });
    expect(res.infraError).toBeUndefined();
  });

  it('crash execFile -> infraError:true (transien, bukan vonis)', async () => {
    h.err = new Error('segfault');
    const res = await verifyScene([fakes.frame], { env: fakes.env });
    expect(res).toMatchObject({ ok: false, available: true, infraError: true });
  });

  it('JSON tak terparse -> infraError:true', async () => {
    h.stdout = 'model busy, no json';
    const res = await verifyScene([fakes.frame], { env: fakes.env });
    expect(res).toMatchObject({ ok: false, infraError: true });
  });

  it('frame tidak ada di disk -> infraError tanpa spawn', async () => {
    const res = await verifyScene(['/nope/absent.jpg'], { env: fakes.env });
    expect(res).toMatchObject({ ok: false, infraError: true });
    expect(h.calls.length).toBe(0);
  });
});

afterEach(() => { vi.restoreAllMocks(); });
