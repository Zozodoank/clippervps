import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.join(__dirname, '..', 'output');

export function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveOutputVideoPath(filename) {
  const safeName = String(filename || '').trim();
  if (!/^(silent|final)_clip_[a-zA-Z0-9_-]+\.mp4$/.test(safeName)) {
    return null;
  }
  const resolved = path.resolve(outputDir, safeName);
  const outputRoot = path.resolve(outputDir) + path.sep;
  return resolved.startsWith(outputRoot) ? resolved : null;
}

export function isVideoFilePath(p) {
  if (!p) return false;
  const lower = p.toLowerCase();
  return !['.m4a', '.mp3', '.aac', '.wav', '.opus'].some(ext => lower.endsWith(ext)) &&
    ['.mp4', '.webm', '.mkv', '.mov'].some(ext => lower.endsWith(ext));
}

export function isQuotaErrorMessage(msg = '') {
  const lower = String(msg).toLowerCase();
  return lower.includes('saldo') || lower.includes('insufficient') ||
    lower.includes('balance') || lower.includes('quota') || lower.includes('kuota') ||
    lower.includes('credit') || lower.includes('resource_exhausted') || lower.includes('429');
}

export function sanitizeCaptionText(caption = '', job = null) {
  return formatEnrichedCaption({
    caption,
    productTitle: job?.productTitle || job?.videoTitle || '',
    productDescription: job?.productDescription || '',
    sampleContext: job?.sampleContext || null,
    scenes: job?.scenes || [],
    platform: 'clipper',
  });
}

