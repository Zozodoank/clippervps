/**
 * P1 observability tests.
 *
 * Two kinds of specs live here on purpose:
 * 1. PURE aggregator specs (no filesystem, no timers) — they lock the maths of
 *    buildJobTraceSummary, which is what /api/job-trace/:jobId actually returns.
 * 2. A few I/O round-trips against a temp tracePath, plus source locks that fail the moment
 *    somebody un-taps the progress sinks (the whole design depends on those taps).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyStep,
  isTerminalStep,
  recordStageEvent,
  trackProgressEvent,
  closeJobTrace,
  resetTraceStateForTests,
  buildJobTraceSummary,
  buildFailureRollup,
  readJobTrace,
  getJobTraceSummary,
  JOB_TRACE_PATH,
} from '../services/observabilityService.js';
import { isPublicApiPath, tokenAuthMiddleware } from '../api/middleware/tokenAuth.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDir, '..');

let tmpDir = '';
let tracePath = '';

function newTracePath(name) {
  const target = path.join(tmpDir, `${name}.jsonl`);
  for (const suffix of ['', '.1']) {
    try { if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix); } catch {}
  }
  return target;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(() => {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippervps-trace-'));
  }
  resetTraceStateForTests();
});

afterEach(() => {
  resetTraceStateForTests();
});

describe('classifyStep / isTerminalStep', () => {
  it('groups raw pipeline steps into canonical stage buckets', () => {
    expect(classifyStep('start')).toBe('prepare');
    expect(classifyStep('auto_youtube_search')).toBe('discovery');
    expect(classifyStep('product_verification')).toBe('discovery');
    expect(classifyStep('metadata_qc')).toBe('metadata');
    expect(classifyStep('stream_sampling_dense')).toBe('sampling');
    expect(classifyStep('frames_raw')).toBe('sampling');
    expect(classifyStep('gemini_vision')).toBe('ai_vision');
    expect(classifyStep('gpt_scripting')).toBe('script');
    expect(classifyStep('download_hd')).toBe('download');
    expect(classifyStep('render_silent')).toBe('render');
    expect(classifyStep('merge_final')).toBe('render');
    expect(classifyStep('tts_generating')).toBe('tts');
    expect(classifyStep('final_master_qc')).toBe('qc');
  });

  it('keeps unknown steps in their own sanitized bucket instead of dumping into "other"', () => {
    expect(classifyStep('brand_new_step')).toBe('brand_new_step');
    expect(classifyStep('Weird Step!')).toBe('weird_step_');
    expect(classifyStep('')).toBe('unknown');
    expect(classifyStep(undefined)).toBe('unknown');
    expect(classifyStep('x'.repeat(90)).length).toBeLessThanOrEqual(40);
  });

  it('recognizes the steps that end a job', () => {
    expect(isTerminalStep('completed')).toBe(true);
    expect(isTerminalStep('error')).toBe(true);
    expect(isTerminalStep('rejected_bulky')).toBe(true);
    expect(isTerminalStep('awaiting_voiceover')).toBe(true);
    expect(isTerminalStep('download')).toBe(false);
    expect(isTerminalStep('')).toBe(false);
  });
});

describe('buildJobTraceSummary (pure)', () => {
  it('returns an inert skeleton for an empty trace', () => {
    const summary = buildJobTraceSummary([]);
    expect(summary.eventCount).toBe(0);
    expect(summary.status).toBe('unknown');
    expect(summary.stages).toEqual([]);
    expect(summary.slowestStage).toBeNull();
    expect(summary.failingStage).toBeNull();
    expect(summary.totals.downloadBytes).toBe(0);
  });

  it('ignores junk entries and non-arrays without throwing', () => {
    expect(() => buildJobTraceSummary(null)).not.toThrow();
    const summary = buildJobTraceSummary([null, undefined, 'nope', { jobId: 'j' }]);
    expect(summary.eventCount).toBe(1);
  });

  it('sums durations and counts per stage and finds the slowest stage', () => {
    const events = [
      { at: '2026-09-29T00:00:00.000Z', kind: 'stage', jobId: 'jobA', stage: 'download', durationMs: 3500, bytes: 12000000, message: 'downloading' },
      { at: '2026-09-29T00:00:05.000Z', kind: 'stage', jobId: 'jobA', stage: 'sampling', durationMs: 900, rejected: 40, accepted: 8, candidates: 48 },
      { at: '2026-09-29T00:00:06.000Z', kind: 'metric', jobId: 'jobA', stage: 'gatekeeper', durationMs: 2500, accepted: 6, rejected: 42, candidates: 48, provider: 'yunet' },
      { at: '2026-09-29T00:00:10.000Z', kind: 'stage', jobId: 'jobA', stage: 'gatekeeper', durationMs: 1500, accepted: 3, rejected: 45 },
      { at: '2026-09-29T00:00:12.000Z', kind: 'terminal', jobId: 'jobA', stage: 'error', meta: { status: 'error' }, failureReason: 'Frame bersih terlalu sedikit' },
    ];
    const summary = buildJobTraceSummary(events);

    expect(summary.jobId).toBe('jobA');
    expect(summary.eventCount).toBe(5);
    expect(summary.status).toBe('error');
    expect(summary.failureReason).toBe('Frame bersih terlalu sedikit');
    expect(summary.failingStage).toBe('gatekeeper');
    expect(summary.lastStage).toBe('error');
    expect(summary.wallClockMs).toBe(12000);

    const gatekeeper = summary.stages.find((s) => s.stage === 'gatekeeper');
    expect(gatekeeper.totalMs).toBe(4000); // 2500 metric + 1500 stage, two separate visits
    expect(gatekeeper.events).toBe(2);
    expect(gatekeeper.acceptedCount).toBe(9);
    expect(gatekeeper.rejectedCount).toBe(87);
    expect(gatekeeper.providers).toEqual(['yunet']);

    expect(summary.slowestStage).toEqual({ stage: 'gatekeeper', totalMs: 4000 });
    expect(summary.totals.downloadBytes).toBe(12000000);
    expect(summary.totals.acceptedCount).toBe(17); // 8 sampling + 6 + 3 gatekeeper
    expect(summary.totals.durationMs).toBe(3500 + 900 + 2500 + 1500);
  });

  it('sorts events by timestamp even when the file arrives out of order', () => {
    const summary = buildJobTraceSummary([
      { at: '2026-01-01T00:00:02.000Z', jobId: 'j', stage: 'render', durationMs: 10 },
      { at: '2026-01-01T00:00:00.000Z', jobId: 'j', stage: 'prepare', durationMs: 10 },
      { at: '2026-01-01T00:00:01.000Z', jobId: 'j', stage: 'download', durationMs: 10 },
    ]);
    expect(summary.stages.map((s) => s.stage)).toEqual(['prepare', 'download', 'render']);
    expect(summary.firstAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.lastAt).toBe('2026-01-01T00:00:02.000Z');
  });

  it('treats a job with no terminal event as still running', () => {
    const summary = buildJobTraceSummary([
      { at: '2026-01-01T00:00:00.000Z', jobId: 'j', stage: 'prepare', durationMs: 5 },
    ]);
    expect(summary.status).toBe('running');
    expect(summary.failingStage).toBeNull();
  });
});

describe('recordStageEvent / readJobTrace (temp file round-trip)', () => {
  it('refuses to touch the production trace while vitest runs', () => {
    const before = fs.existsSync(JOB_TRACE_PATH);
    const written = recordStageEvent({ jobId: 'prod_guard', stage: 'prepare' });
    expect(written).toBeNull();
    expect(fs.existsSync(JOB_TRACE_PATH)).toBe(before);
  });

  it('drops events without a jobId instead of writing an orphan line', () => {
    tracePath = newTracePath('no_job');
    expect(recordStageEvent({ stage: 'download' }, { tracePath })).toBeNull();
    expect(readLines(tracePath)).toHaveLength(0);
  });

  it('writes short count keys and can be read back per job', () => {
    tracePath = newTracePath('roundtrip');
    recordStageEvent({
      jobId: 'jobRT',
      stage: 'download',
      durationMs: 1500,
      downloadBytes: 4096,
      provider: 'yt-dlp:mweb',
      model: '',
      meta: { attempts: 2 },
    }, { tracePath });
    recordStageEvent({ jobId: 'other', stage: 'sampling' }, { tracePath });

    const events = readJobTrace('jobRT', { tracePath });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: 'jobRT', stage: 'download', bytes: 4096, provider: 'yt-dlp:mweb' });
    expect(events[0].model).toBeUndefined();
    expect(events[0].meta).toEqual({ attempts: 2 });

    const summary = getJobTraceSummary('jobRT', { tracePath });
    expect(summary.totals.downloadBytes).toBe(4096);
    expect(summary.status).toBe('running');
  });

  it('merges the rotated .1 file (oldest first) and honours the limit', () => {
    tracePath = newTracePath('rotated');
    fs.writeFileSync(`${tracePath}.1`, `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', jobId: 'jobR', stage: 'prepare', durationMs: 1 })}\n`, 'utf8');
    fs.appendFileSync(tracePath, `${JSON.stringify({ at: '2026-01-01T00:00:01.000Z', jobId: 'jobR', stage: 'download', durationMs: 2 })}\n`, 'utf8');
    fs.appendFileSync(tracePath, 'baris-rusak-yang-tidak-valid-json\n', 'utf8');

    const events = readJobTrace('jobR', { tracePath });
    expect(events.map((e) => e.stage)).toEqual(['prepare', 'download']);

    const truncated = readJobTrace('jobR', { tracePath, limit: 1 });
    expect(truncated).toHaveLength(1);
    expect(truncated[0].stage).toBe('download');
  });

  it('buildFailureRollup groups by job and ranks the stage that kills jobs', () => {
    tracePath = newTracePath('rollup');
    const emit = (event) => recordStageEvent(event, { tracePath });
    emit({ jobId: 'good1', stage: 'download', durationMs: 10 });
    emit({ jobId: 'good1', kind: 'terminal', stage: 'terminal', meta: { status: 'completed' } });
    emit({ jobId: 'bad1', stage: 'gatekeeper', durationMs: 20, failureReason: 'Wajah terdeteksi' });
    emit({ jobId: 'bad1', kind: 'terminal', stage: 'terminal', failureReason: 'Wajah terdeteksi', meta: { status: 'error' } });
    emit({ jobId: 'bad2', stage: 'gatekeeper', durationMs: 30, failureReason: 'Subtitle terbakar' });
    emit({ jobId: 'bad2', kind: 'terminal', stage: 'terminal', failureReason: 'Subtitle terbakar', meta: { status: 'error' } });

    const rollup = buildFailureRollup({ tracePath });
    expect(rollup.jobCount).toBe(3);
    expect(rollup.failureByStage[0]).toEqual({ stage: 'gatekeeper', count: 2 });
    expect(rollup.jobs.find((j) => j.jobId === 'good1').status).toBe('completed');
    expect(rollup.jobs.find((j) => j.jobId === 'bad2').failingStage).toBe('gatekeeper');
    expect(rollup.avgStageMs[0].avgMs).toBeGreaterThan(0);
  });
});

describe('trackProgressEvent (the progress sink tap)', () => {
  beforeEach(() => {
    tracePath = newTracePath('tap');
  });

  const tap = (jobId, payload, runId) => trackProgressEvent(jobId, payload, { tracePath, runId });

  it('writes nothing while a stage keeps repeating, then one line per transition', () => {
    tap('jobT', { step: 'start', message: 'Menyiapkan...', progress: 5 });
    tap('jobT', { step: 'download', message: 'Downloading 10%', progress: 12 });
    tap('jobT', { step: 'download', message: 'Downloading 25%', progress: 25 });
    tap('jobT', { step: 'download', message: 'Downloading 80%', progress: 33 });
    expect(readLines(tracePath)).toHaveLength(1); // prepare closed when download opened
    expect(readLines(tracePath)[0]).toMatchObject({ jobId: 'jobT', stage: 'prepare', kind: 'stage' });

    tap('jobT', { step: 'gemini_vision', message: 'AI menganalisa...', progress: 48 });
    const lines = readLines(tracePath);
    expect(lines).toHaveLength(2);
    expect(lines[1].stage).toBe('download');
    expect(lines[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('terminal step closes the open stage and records status + failure reason', () => {
    tap('jobT', { step: 'stream_sampling', message: 'sampling...' });
    tap('jobT', { step: 'error', message: 'Gatekeeper menolak', status: 'error', error: 'Wajah terdeteksi' }, 'run-1');

    const lines = readLines(tracePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ stage: 'sampling', kind: 'stage', runId: 'run-1' });
    expect(lines[1]).toMatchObject({
      kind: 'terminal',
      stage: 'error',
      failureReason: 'Wajah terdeteksi',
      meta: { status: 'error', step: 'error' },
    });
  });

  it('a completed job writes a clean terminal event with no failure reason', () => {
    tap('jobT', { step: 'render_final', message: 'merender...' });
    tap('jobT', { step: 'completed', message: 'Selesai', status: 'completed', progress: 100 });
    const lines = readLines(tracePath);
    const terminal = lines[lines.length - 1];
    expect(terminal.kind).toBe('terminal');
    expect(terminal.meta.status).toBe('completed');
    expect(terminal.failureReason).toBeUndefined();
  });

  it('reopens a fresh stage after a terminal step (retry on the same job id)', () => {
    tap('jobT', { step: 'start', message: 'attempt 1' });
    tap('jobT', { step: 'error', message: 'gagal', status: 'error' });
    const afterError = readLines(tracePath).length;
    tap('jobT', { step: 'retry_start', message: 'attempt 2' });
    tap('jobT', { step: 'completed', message: 'beres', status: 'completed' });
    const lines = readLines(tracePath);
    expect(lines.length).toBeGreaterThan(afterError);
    expect(lines.filter((l) => l.kind === 'terminal')).toHaveLength(2);
  });

  it('stays silent on malformed payloads instead of throwing', () => {
    expect(() => tap('jobT', null)).not.toThrow();
    expect(() => tap('', { step: 'start' })).not.toThrow();
    expect(() => tap('jobT', 'string payload')).not.toThrow();
    expect(readLines(tracePath)).toHaveLength(0);
  });

  it('closeJobTrace flushes an in-flight stage for workers that die outside the sink', () => {
    tap('jobC', { step: 'tts_generating', message: 'TTS...' });
    const terminal = closeJobTrace('jobC', { status: 'stopped', failureReason: 'server restart', tracePath });
    const lines = readLines(tracePath);
    expect(lines[0].stage).toBe('tts');
    expect(terminal).toMatchObject({ kind: 'terminal', meta: { status: 'stopped' } });
    expect(lines[lines.length - 1].failureReason).toBe('server restart');
    // Timer must be gone, otherwise the next unrelated step would invent a bogus duration.
    tap('jobC', { step: 'download', message: 'mulai lagi' });
    expect(readLines(tracePath)).toHaveLength(2);
  });

  it('readJobTrace finds the sequence the tap just wrote', () => {
    tap('jobQ', { step: 'start', message: 'start' });
    tap('jobQ', { step: 'download', message: 'dl' });
    tap('jobQ', { step: 'gemini_vision', message: 'ai' });
    tap('jobQ', { step: 'completed', message: 'done', status: 'completed' });
    const events = readJobTrace('jobQ', { tracePath });
    const summary = buildJobTraceSummary(events);
    expect(summary.stages.map((s) => s.stage)).toEqual(['prepare', 'download', 'ai_vision', 'completed']);
    expect(summary.status).toBe('completed');
    expect(summary.failingStage).toBeNull();
  });
});

describe('P1 wiring source locks', () => {
  const read = (rel) => fs.readFileSync(path.join(serverRoot, rel), 'utf8');

  it('jobProgress is a trace-tapping Map (single choke point for every worker)', () => {
    const src = read('store/jobStore.js');
    expect(src).toMatch(/class TraceAwareProgressMap extends Map/);
    expect(src).toMatch(/trackProgressEvent\(key, value\)/);
    expect(src).toMatch(/export const jobProgress = new TraceAwareProgressMap\(\)/);
    expect(src).not.toMatch(/export const jobProgress = new Map\(\)/);
  });

  it('stage1Render taps the auto-mode progress callback too (it never touches jobProgress)', () => {
    const src = read('worker/stage1Render.js');
    expect(src).toMatch(/trackProgressEvent\(jobId, payload, \{ runId: extraJobMeta\?\.autoRunId \}\)/);
    expect(src).toMatch(/const sinkProgress = onProgress \|\|/);
  });

  it('downloader, tts, gatekeeper and final QC all emit metric events', () => {
    expect(read('services/downloader.js')).toMatch(/provider: `yt-dlp:\$\{clientType\}`/);
    expect(read('services/downloader.js')).toMatch(/provider: 'cobalt'/);
    expect(read('services/ttsService.js')).toMatch(/stage: 'tts'/);
    expect(read('worker/finalizationService.js')).toMatch(/stage: 'qc'/);
    const stage1 = read('worker/stage1Render.js');
    expect(stage1.split("stage: 'gatekeeper'").length - 1).toBe(3);
    expect(stage1).toMatch(/stage: 'context'/);
  });

  it('jobStore tap must not crash a job when observability throws', () => {
    expect(read('store/jobStore.js')).toMatch(/try \{\n\s*trackProgressEvent\(key, value\);\n\s*\} catch/);
  });
});

describe('job-trace endpoints sit behind the token gate', () => {
  const ORIGINAL_TOKEN = process.env.API_ACCESS_TOKEN;

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.API_ACCESS_TOKEN;
    else process.env.API_ACCESS_TOKEN = ORIGINAL_TOKEN;
  });

  it('are NOT part of the public allowlist', () => {
    expect(isPublicApiPath('/api/job-trace/job123')).toBe(false);
    expect(isPublicApiPath('/api/job-trace-failures')).toBe(false);
    expect(isPublicApiPath('/api/health')).toBe(true);
  });

  it('return 401 without a token once API_ACCESS_TOKEN is configured', () => {
    process.env.API_ACCESS_TOKEN = 'trace-secret';
    for (const apiPath of ['/api/job-trace/job123', '/api/job-trace-failures']) {
      const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
      let nextCalled = false;
      tokenAuthMiddleware({ path: apiPath, headers: {}, query: {} }, res, () => { nextCalled = true; });
      expect(nextCalled, apiPath).toBe(false);
      expect(res.statusCode, apiPath).toBe(401);
    }
  });

  it('let a verified token through, and mark authMode so the handler can trust it', () => {
    process.env.API_ACCESS_TOKEN = 'trace-secret';
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
    const req = { path: '/api/job-trace/job123', headers: { 'x-api-token': 'trace-secret' }, query: {} };
    let nextCalled = false;
    tokenAuthMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.authMode).toBe('verified');
  });

  it('routes are registered in jobsRoutes with a rate limiter', () => {
    const src = fs.readFileSync(path.join(serverRoot, 'api/routes/jobsRoutes.js'), 'utf8');
    expect(src).toMatch(/router\.get\('\/job-trace\/:jobId', traceLimiter/);
    expect(src).toMatch(/router\.get\('\/job-trace-failures', traceLimiter/);
    expect(src).toMatch(/createRateLimiter\(\{ name: 'job-trace'/);
  });
});
