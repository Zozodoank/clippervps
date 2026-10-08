/**
 * Per-stage observability for the render pipeline (P1).
 *
 * WHY THIS FILE EXISTS
 * Before this, answering "job ini gagal di stage apa dan berapa lama?" meant scrolling ten
 * different console logs. Every worker already emits progress payloads with a `step` field, so
 * those payloads are a free source of a stage timeline. This service turns them into an
 * append-only JSONL trace plus a pure aggregator that answers the question in one API call.
 *
 * DESIGN RULES
 * - Logging must NEVER break a job: every write is wrapped in try/catch and only warns.
 * - Only STAGE TRANSITIONS are written (plus explicit metric/terminal events). A stage that
 *   reports progress 200 times still produces one line, so a phone-sized disk stays safe.
 * - The aggregator (buildJobTraceSummary) is pure: no fs, no Date.now() on its hot path, so it
 *   is unit-testable without touching the filesystem (locked by tests/observability.test.js).
 * - During vitest the real trace file is never written; tests pass an explicit tracePath.
 */
import fs from 'fs';
import path from 'path';
import { logsDir } from '../utils/paths.js';

export const JOB_TRACE_PATH = path.join(logsDir, 'job-trace.jsonl');
const TRACE_MAX_BYTES = 2 * 1024 * 1024;

/** Canonical stage buckets. Raw `step` values are grouped here so the timeline stays readable. */
const STEP_TO_STAGE = {
  // prepare
  start: 'prepare',
  init: 'prepare',
  processing: 'prepare',
  retry_start: 'prepare',
  retry_source: 'prepare',
  // discovery (product + source hunting)
  auto_shopee_search: 'discovery',
  auto_video_search: 'discovery',
  auto_youtube_search: 'discovery',
  auto_search_fallback: 'discovery',
  auto_retry_start: 'discovery',
  auto_retry_next: 'discovery',
  auto_retry_wait: 'discovery',
  product_verification: 'discovery',
  visual_ai_keywords: 'discovery',
  visual_multi_search: 'discovery',
  visual_search_bing: 'discovery',
  visual_video_search: 'discovery',
  // metadata gate
  metadata_fetch: 'metadata',
  metadata_qc: 'metadata',
  // frame sampling / local inspection
  stream_sampling: 'sampling',
  stream_sampling_dense: 'sampling',
  stream_sampling_done: 'sampling',
  stream_url_fetch: 'sampling',
  frames: 'sampling',
  frames_raw: 'sampling',
  frames_trimmed: 'sampling',
  clip_audit: 'sampling',
  // AI calls
  gemini_vision: 'ai_vision',
  gpt_scripting: 'script',
  ai_lexicon_detection: 'script',
  tts_lexicon: 'script',
  audio_analysis: 'audio',
  audio_paraphrase: 'audio',
  // downloads
  download: 'download',
  download_hd: 'download',
  youtube_ip_rate_limited: 'download',
  // rendering
  render_silent: 'render',
  render_final: 'render',
  edit_conform: 'render',
  merge_start: 'render',
  merge_final: 'render',
  subtitles: 'render',
  subtitle_retry: 'render',
  // voiceover
  tts_generating: 'tts',
  // quality control
  final_master_qc: 'qc',
  final_visual_qc: 'qc',
  final_auto_repair: 'qc',
};

/** Steps that end a job (success, failure, or a deliberate pause at the voiceover stage). */
const TERMINAL_STEPS = new Set([
  'completed',
  'error',
  'rejected_bulky',
  'awaiting_voiceover',
  'auto_retry_stopped',
]);

const FAILURE_STEPS = new Set(['error', 'rejected_bulky', 'youtube_ip_rate_limited', 'auto_retry_stopped']);

/** Unknown steps keep their own bucket (snake_case, truncated) instead of collapsing into 'other'. */
export function classifyStep(step) {
  const raw = String(step || '').trim();
  if (!raw) return 'unknown';
  if (STEP_TO_STAGE[raw]) return STEP_TO_STAGE[raw];
  return raw.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 40);
}

export function isTerminalStep(step) {
  return TERMINAL_STEPS.has(String(step || '').trim());
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function writeTraceLine(line, tracePath) {
  // During vitest the production trace stays clean; specs that really want I/O pass tracePath.
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !tracePath) return false;
  const target = tracePath || JOB_TRACE_PATH;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (fs.statSync(target).size > TRACE_MAX_BYTES) fs.renameSync(target, `${target}.1`);
    } catch {
      // File does not exist yet; nothing to rotate.
    }
    fs.appendFileSync(target, `${line}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[Trace] Gagal menulis job trace: ${err.message}`);
    return false;
  }
}

/** Trims free-form text so one noisy message cannot dominate the trace file. */
function clipText(value, max = 180) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Drops count fields that were never supplied so the JSONL stays small and honest. */
function normalizeCounts(event) {
  const counts = {};
  const mapping = {
    downloadBytes: 'bytes',
    candidateCount: 'candidates',
    acceptedCount: 'accepted',
    rejectedCount: 'rejected',
  };
  for (const [field, shortKey] of Object.entries(mapping)) {
    const num = toFiniteNumber(event[field] ?? event[shortKey]);
    if (num !== null) counts[shortKey] = num;
  }
  return counts;
}

/**
 * Write one explicit metric event (download bytes, Oracle frame counts, AI call, QC verdict).
 * @param {object} event
 * @param {string} event.jobId
 * @param {string} event.stage Canonical stage (see classifyStep) or a free bucket name.
 * @param {number} [event.durationMs]
 * @param {string} [event.provider]
 * @param {string} [event.model]
 * @param {number} [event.downloadBytes]
 * @param {number} [event.candidateCount]
 * @param {number} [event.acceptedCount]
 * @param {number} [event.rejectedCount]
 * @param {string} [event.failureReason]
 * @param {object} [event.meta] Small extra payload (never put secrets here).
 * @param {string} [options.tracePath] Override file (tests).
 */
export function recordStageEvent(event = {}, options = {}) {
  try {
    return writeStageEvent(event, options);
  } catch (err) {
    // Observability must never take a render job down.
    console.warn(`[Trace] recordStageEvent gagal: ${err.message}`);
    return null;
  }
}

function writeStageEvent(event = {}, options = {}) {
  const jobId = String(event.jobId || '').trim();
  if (!jobId) return null;
  const now = event.at instanceof Date ? event.at : new Date();
  const entry = {
    at: now.toISOString(),
    kind: event.kind || 'metric',
    jobId,
    stage: event.stage || 'unknown',
    runId: event.runId ? String(event.runId) : undefined,
    durationMs: toFiniteNumber(event.durationMs) ?? undefined,
    provider: event.provider ? clipText(event.provider, 40) : undefined,
    model: event.model ? clipText(event.model, 60) : undefined,
    message: event.message ? clipText(event.message) : undefined,
    failureReason: event.failureReason ? clipText(event.failureReason, 220) : undefined,
    meta: event.meta && typeof event.meta === 'object' ? event.meta : undefined,
    ...normalizeCounts(event),
  };
  // Remove undefined keys (JSON.stringify already drops them, but tests compare objects).
  for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
  const written = writeTraceLine(`${JSON.stringify(entry)}\n`.trimEnd(), options.tracePath);
  return written ? entry : null;
}

/** jobId -> { stage, step, startedAt, lastAt, progress, message, status } */
const openStages = new Map();
const MAX_TRACKED_JOBS = 200;

function pruneOpenStages() {
  if (openStages.size <= MAX_TRACKED_JOBS) return;
  // Oldest-first eviction: Map preserves insertion order, and abandoned jobs (server restart,
  // killed worker) must not leak memory forever.
  for (const key of openStages.keys()) {
    if (openStages.size <= MAX_TRACKED_JOBS) break;
    openStages.delete(key);
  }
}

/**
 * The single sink every progress payload flows through (jobProgress.set and the auto-mode
 * onProgress callback both call this). Writes only when the stage CHANGES, so a chatty
 * streaming progress bar produces no I/O at all.
 */
export function trackProgressEvent(jobId, payload = {}, options = {}) {
  const id = String(jobId || payload?.jobId || '').trim();
  if (!id || !payload || typeof payload !== 'object') return null;

  const step = String(payload.step || '').trim();
  const stage = classifyStep(step);
  const now = Date.now();
  const state = openStages.get(id);
  const isTerminal = isTerminalStep(step);

  let emitted = null;
  if (!state || state.stage !== stage) {
    if (state) {
      emitted = recordStageEvent({
        jobId: id,
        kind: 'stage',
        stage: state.stage,
        runId: options.runId || state.runId,
        durationMs: Math.max(0, now - state.startedAt),
        message: state.message,
        meta: { firstStep: state.step, lastStep: step || undefined, progress: state.progress },
      }, options);
    }
    if (isTerminal) {
      openStages.delete(id);
    } else {
      openStages.set(id, {
        stage,
        step,
        runId: options.runId,
        startedAt: now,
        lastAt: now,
        progress: toFiniteNumber(payload.progress),
        message: clipText(payload.message),
      });
      pruneOpenStages();
    }
  } else if (!isTerminal) {
    state.lastAt = now;
    state.step = step || state.step;
    const progress = toFiniteNumber(payload.progress);
    if (progress !== null) state.progress = progress;
    const message = clipText(payload.message);
    if (message) state.message = message;
  }

  if (isTerminal) {
    recordStageEvent({
      jobId: id,
      kind: 'terminal',
      stage,
      runId: options.runId,
      message: payload.message,
      failureReason: FAILURE_STEPS.has(step)
        ? clipText(payload.error || payload.message || payload.sourceStatus || step, 220)
        : undefined,
      meta: { status: payload.status || step, step, progress: toFiniteNumber(payload.progress) },
    }, options);
  }
  return emitted;
}

/** Close any open stage for a job (used by workers that finish outside the progress sink). */
export function closeJobTrace(jobId, { status = 'stopped', failureReason = '', runId, tracePath } = {}) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const state = openStages.get(id);
  openStages.delete(id);
  const now = Date.now();
  if (state) {
    recordStageEvent({
      jobId: id,
      kind: 'stage',
      stage: state.stage,
      runId: runId || state.runId,
      durationMs: Math.max(0, now - state.startedAt),
      message: state.message,
      meta: { firstStep: state.step, closedBy: 'closeJobTrace' },
    }, { tracePath });
  }
  return recordStageEvent({
    jobId: id,
    kind: 'terminal',
    stage: 'terminal',
    runId: runId || state?.runId,
    failureReason: failureReason ? clipText(failureReason, 220) : undefined,
    meta: { status, closedBy: 'closeJobTrace' },
  }, { tracePath });
}

/** Test helper: forget in-flight stage timers so specs start from a clean slate. */
export function resetTraceStateForTests() {
  openStages.clear();
}

/**
 * PURE aggregator: turn a list of trace events into a stage timeline + totals.
 * Answers "gagal di stage apa", "stage mana paling lama", and "berapa byte yang turun".
 * @param {object[]} events Trace lines for ONE job, any order (sorted internally).
 */
export function buildJobTraceSummary(events = []) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  if (list.length === 0) {
    return {
      jobId: '', eventCount: 0, status: 'unknown', failureReason: '',
      firstAt: null, lastAt: null, wallClockMs: 0,
      stages: [], totals: { durationMs: 0, downloadBytes: 0, candidateCount: 0, acceptedCount: 0, rejectedCount: 0 },
      slowestStage: null, lastStage: null, failingStage: null,
    };
  }

  const sorted = [...list].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  const buckets = new Map();

  for (const ev of sorted) {
    const name = String(ev.stage || 'unknown');
    const bucket = buckets.get(name) || {
      stage: name,
      events: 0,
      totalMs: 0,
      firstAt: ev.at || null,
      lastAt: ev.at || null,
      downloadBytes: 0,
      candidateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      failures: [],
      providers: new Set(),
      models: new Set(),
      lastMessage: '',
    };
    bucket.events += 1;
    bucket.totalMs += Math.max(0, toFiniteNumber(ev.durationMs) || 0);
    bucket.downloadBytes += toFiniteNumber(ev.bytes ?? ev.downloadBytes) || 0;
    bucket.candidateCount += toFiniteNumber(ev.candidates ?? ev.candidateCount) || 0;
    bucket.acceptedCount += toFiniteNumber(ev.accepted ?? ev.acceptedCount) || 0;
    bucket.rejectedCount += toFiniteNumber(ev.rejected ?? ev.rejectedCount) || 0;
    if (ev.failureReason) bucket.failures.push(String(ev.failureReason));
    if (ev.provider) bucket.providers.add(String(ev.provider));
    if (ev.model) bucket.models.add(String(ev.model));
    if (ev.message) bucket.lastMessage = String(ev.message);
    bucket.lastAt = ev.at || bucket.lastAt;
    buckets.set(name, bucket);
  }

  const stages = [...buckets.values()].map((b) => ({
    stage: b.stage,
    events: b.events,
    totalMs: Math.round(b.totalMs),
    firstAt: b.firstAt,
    lastAt: b.lastAt,
    downloadBytes: b.downloadBytes,
    candidateCount: b.candidateCount,
    acceptedCount: b.acceptedCount,
    rejectedCount: b.rejectedCount,
    failures: b.failures,
    providers: [...b.providers],
    models: [...b.models],
    lastMessage: b.lastMessage,
  }));

  const terminalEvents = sorted.filter((e) => e.kind === 'terminal');
  const lastTerminal = terminalEvents.length ? terminalEvents[terminalEvents.length - 1] : null;
  const failureEvents = sorted.filter((e) => e.failureReason);
  const failingEvent = failureEvents.length ? failureEvents[failureEvents.length - 1] : null;
  const status = lastTerminal?.meta?.status || (failingEvent ? 'error' : 'running');
  const isFailureStatus = ['error', 'rejected', 'stopped'].includes(String(status));

  // ROOT stage of a failure: the last NON-terminal event that carries a reason wins. When the
  // worker only reported the reason on the terminal line, fall back to the last substantive
  // stage, because "gagal di stage apa" must name real work (Oracle/QC/download), never the
  // synthetic 'terminal' bucket.
  const substantiveEvents = sorted.filter((e) => e.kind !== 'terminal');
  const lastSubstantive = substantiveEvents.length ? substantiveEvents[substantiveEvents.length - 1] : null;
  const rootFailureEvent = [...failureEvents].reverse().find((e) => e.kind !== 'terminal')
    || (isFailureStatus ? lastSubstantive : null);
  const slowest = [...stages].sort((a, b) => b.totalMs - a.totalMs)[0] || null;
  const wallStart = new Date(sorted[0].at || 0).getTime();
  const wallEnd = new Date(sorted[sorted.length - 1].at || 0).getTime();

  return {
    jobId: String(sorted[0].jobId || ''),
    eventCount: sorted.length,
    status,
    failureReason: failingEvent ? String(failingEvent.failureReason) : '',
    firstAt: sorted[0].at || null,
    lastAt: sorted[sorted.length - 1].at || null,
    wallClockMs: Number.isFinite(wallStart) && Number.isFinite(wallEnd) ? Math.max(0, wallEnd - wallStart) : 0,
    stages,
    totals: {
      durationMs: stages.reduce((sum, s) => sum + s.totalMs, 0),
      downloadBytes: stages.reduce((sum, s) => sum + s.downloadBytes, 0),
      candidateCount: stages.reduce((sum, s) => sum + s.candidateCount, 0),
      acceptedCount: stages.reduce((sum, s) => sum + s.acceptedCount, 0),
      rejectedCount: stages.reduce((sum, s) => sum + s.rejectedCount, 0),
    },
    slowestStage: slowest && slowest.totalMs > 0 ? { stage: slowest.stage, totalMs: slowest.totalMs } : null,
    lastStage: stages.length ? stages[stages.length - 1].stage : null,
    failingStage: rootFailureEvent ? String(rootFailureEvent.stage || 'unknown') : null,
  };
}

function parseJsonLines(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // A partially written line (rotation racing an append) is skipped, never fatal.
    }
  }
  return out;
}

/**
 * Read trace events for one job (current file + rotated file, oldest first).
 * @param {string} jobId
 * @param {object} [options]
 * @param {number} [options.limit] Max events returned (most recent kept).
 * @param {string} [options.tracePath] Override the trace file (tests).
 * @param {boolean} [options.includeRotated] Also scan job-trace.jsonl.1 (default true).
 */
export function readJobTrace(jobId, options = {}) {
  const id = String(jobId || '').trim();
  if (!id) return [];
  const primary = options.tracePath || JOB_TRACE_PATH;
  const files = [primary];
  if (options.includeRotated !== false) files.unshift(`${primary}.1`);

  const events = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const ev of parseJsonLines(raw)) {
        if (String(ev.jobId || '') === id) events.push(ev);
      }
    } catch {
      // Missing log file simply means "no trace yet".
    }
  }
  const limit = toFiniteNumber(options.limit);
  if (limit && events.length > limit) return events.slice(-Math.abs(Math.trunc(limit)));
  return events;
}

export function getJobTraceSummary(jobId, options = {}) {
  return buildJobTraceSummary(readJobTrace(jobId, options));
}

/**
 * Cross-job failure rollup: which stage kills jobs most often. Reads the whole trace file once
 * and groups by jobId, so "semua job gagal di Oracle" is one call instead of ten log reads.
 * @param {object} [options]
 * @param {number} [options.maxJobs] Look at the N most recent jobs (default 50).
 * @param {string} [options.tracePath] Override the trace file (tests).
 */
export function buildFailureRollup(options = {}) {
  const primary = options.tracePath || JOB_TRACE_PATH;
  const files = [`${primary}.1`, primary];
  const all = [];
  for (const file of files) {
    try {
      all.push(...parseJsonLines(fs.readFileSync(file, 'utf8')));
    } catch {
      // ignore missing file
    }
  }

  const byJob = new Map();
  for (const ev of all) {
    const id = String(ev.jobId || '');
    if (!id) continue;
    if (!byJob.has(id)) byJob.set(id, []);
    byJob.get(id).push(ev);
  }

  const jobs = [...byJob.entries()]
    .map(([id, events]) => buildJobTraceSummary(events))
    .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0))
    .slice(0, toFiniteNumber(options.maxJobs) || 50);

  const stageFailures = new Map();
  const stageDurations = new Map();
  for (const job of jobs) {
    if (job.failingStage) {
      stageFailures.set(job.failingStage, (stageFailures.get(job.failingStage) || 0) + 1);
    }
    for (const st of job.stages) {
      const acc = stageDurations.get(st.stage) || { totalMs: 0, samples: 0 };
      acc.totalMs += st.totalMs;
      acc.samples += 1;
      stageDurations.set(st.stage, acc);
    }
  }

  return {
    jobCount: jobs.length,
    failureByStage: [...stageFailures.entries()]
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => b.count - a.count),
    avgStageMs: [...stageDurations.entries()]
      .map(([stage, acc]) => ({ stage, avgMs: acc.samples ? Math.round(acc.totalMs / acc.samples) : 0 }))
      .sort((a, b) => b.avgMs - a.avgMs),
    jobs: jobs.map((job) => ({
      jobId: job.jobId,
      status: job.status,
      failureReason: job.failureReason,
      failingStage: job.failingStage,
      lastStage: job.lastStage,
      wallClockMs: job.wallClockMs,
      downloadBytes: job.totals.downloadBytes,
      firstAt: job.firstAt,
      lastAt: job.lastAt,
    })),
  };
}
