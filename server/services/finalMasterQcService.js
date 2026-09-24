import { spawn } from 'child_process';
import fs from 'fs';
import { getFFmpegPath } from './binaryChecker.js';
import { getNichePreset } from '../config/nichePresets.js';

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const proc = spawn(getFFmpegPath(), args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + '\nTIMEOUT' });
    }, timeoutMs);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

export function parseDuration(text = '') {
  const m = String(text).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseResolution(text = '') {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!/Video:/i.test(line)) continue;
    const m = line.match(/\b(\d{2,5})x(\d{2,5})\b/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

function parseNumber(text, regex) {
  const m = String(text).match(regex);
  return m ? Number(m[1]) : null;
}

export function auditSubtitleSafeZone(assPath = '') {
  if (!assPath || !fs.existsSync(assPath)) {
    return { passed: false, issues: ['subtitle_file_missing'] };
  }
  const raw = fs.readFileSync(assPath, 'utf8');
  const playResX = parseNumber(raw, /PlayResX:\s*(\d+)/i);
  const playResY = parseNumber(raw, /PlayResY:\s*(\d+)/i);
  const styleLine = raw.split(/\r?\n/).find(line => /^Style:\s*Default,/i.test(line)) || '';
  const cols = styleLine.split(',');
  const fontSize = cols.length > 2 ? Number(cols[2]) : null;
  const marginV = cols.length > 21 ? Number(cols[21]) : null;

  const issues = [];
  if (playResX !== 1080 || playResY !== 1920) issues.push('subtitle_canvas_not_1080x1920');
  if (!Number.isFinite(fontSize) || fontSize < 28 || fontSize > 64) issues.push('subtitle_font_size_unsafe');
  if (!Number.isFinite(marginV) || marginV < 240 || marginV > 700) issues.push('subtitle_vertical_safe_zone_invalid');

  return { passed: issues.length === 0, issues, playResX, playResY, fontSize, marginV };
}

/**
 * Gate deterministik Scene<->VO lockstep (Fase 6) — 0 panggilan AI.
 * Hanya berlaku untuk niche strictSceneVoSync; niche lain selalu PASS (perilaku lama).
 * Memakai hasil validateScriptSlotAlignment + buildSceneVoSegments dari worker.
 */
export function auditSceneVoLockstep({ niche = '', segments = null, alignment = null } = {}) {
  // Data-driven: strict hanya bila preset niche mendeklarasikan strictSceneVoSync
  const strict = Boolean(getNichePreset(niche)?.strictSceneVoSync);
  if (!strict) return { passed: true, skipped: true, issues: [], reason: 'lockstep tidak wajib untuk niche ini' };

  const issues = [];
  if (Array.isArray(segments) && segments.length > 0) {
    const presenterSlots = segments.filter(s => s.facePolicy === 'presenter_only');
    // SEMUA adegan (strict maupun presenter_only) wajib punya visualClaim agar bisa
    // diverifikasi vs voiceover oleh QC (normalizeShortScenes selalu mengisi visualDescription).
    const noClaim = segments.filter(s => !String(s.visualClaim || '').trim());
    if (noClaim.length > 0) issues.push('segment_tanpa_visual_claim');
    if (presenterSlots.length === 0) issues.push('slot_presenter_only_hilang_dari_segment_plan');
  } else {
    // Niche strict WAJIB punya segment plan terkunci di job mana pun (termasuk manual conform).
    issues.push('scene_vo_segments_kosong');
  }

  if (alignment && alignment.ok === false && Array.isArray(alignment.errors) && alignment.errors.length > 0) {
    issues.push('alignment_error: ' + alignment.errors[0]);
  }

  return { passed: issues.length === 0, skipped: false, issues };
}

export async function runFinalMasterQc({
  videoPath,
  expectedDurationSec = null,
  subtitlePath = '',
} = {}) {
  const issues = [];
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { passed: false, issues: ['final_video_missing'] };
  }

  const stat = fs.statSync(videoPath);
  if (stat.size < 500 * 1024) issues.push('final_file_too_small');

  const result = await runFfmpeg([
    '-hide_banner',
    '-i', videoPath,
    '-vf', 'blackdetect=d=0.30:pix_th=0.05,freezedetect=n=-55dB:d=1.20',
    '-af', 'volumedetect',
    '-f', 'null',
    '-'
  ], 120000);

  const text = result.stderr || '';
  const duration = parseDuration(text);
  const resolution = parseResolution(text);
  const hasAudio = /Audio:/i.test(text);
  const meanVolume = parseNumber(text, /mean_volume:\s*(-?[0-9.]+)\s*dB/i);
  const maxVolume = parseNumber(text, /max_volume:\s*(-?[0-9.]+)\s*dB/i);
  const blackDurations = [...text.matchAll(/black_duration:([0-9.]+)/g)].map(m => Number(m[1]));
  const freezeDurations = [...text.matchAll(/freeze_duration:\s*([0-9.]+)/g)].map(m => Number(m[1]));

  if (!resolution || resolution.width !== 1080 || resolution.height !== 1920) {
    issues.push('final_resolution_not_1080x1920');
  }
  if (!hasAudio) issues.push('final_audio_missing');
  if (blackDurations.some(v => v >= 0.45)) issues.push('black_frame_segment_detected');
  if (freezeDurations.some(v => v >= 1.60)) issues.push('long_freeze_detected');
  if (Number.isFinite(meanVolume) && (meanVolume < -24 || meanVolume > -10)) issues.push('voice_loudness_out_of_range');
  if (Number.isFinite(maxVolume) && (maxVolume > -0.1 || maxVolume < -8)) issues.push('audio_peak_out_of_range');

  const expected = Number(expectedDurationSec);
  if (Number.isFinite(expected) && expected > 0 && Number.isFinite(duration)) {
    if (Math.abs(duration - expected) > 1.0) issues.push('final_duration_mismatch');
  }

  const subtitleAudit = subtitlePath ? auditSubtitleSafeZone(subtitlePath) : null;
  if (subtitleAudit && !subtitleAudit.passed) {
    issues.push(...subtitleAudit.issues);
  }

  return {
    passed: issues.length === 0,
    issues: Array.from(new Set(issues)),
    duration,
    resolution,
    hasAudio,
    meanVolume,
    maxVolume,
    blackDurations,
    freezeDurations,
    subtitleAudit,
    ffmpegExitCode: result.code,
  };
}
