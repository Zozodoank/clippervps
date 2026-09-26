import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_PATH = path.join(__dirname, '..', 'bandwidth_stats.json');

const CATEGORY_LABELS = {
  videoDownload: 'Unduhan Video Full HD (1080p)',
  streamSampling: 'Stream Sampling (30 Frame Visual)',
  metadata: 'Metadata & Filter Kasar (0 Download)',
  voiceoverTTS: 'Voiceover Audio (Edge-TTS)',
  aiRequests: 'AI Vision & API Prompts',
  discovery: 'Pencarian Video Discovery',
  other: 'Lainnya'
};

const DEFAULT_STATS = {
  totalBytes: 0,
  savedBytes: 0,
  breakdown: {
    videoDownload: { bytes: 0, count: 0 },
    streamSampling: { bytes: 0, count: 0 },
    metadata: { bytes: 0, count: 0 },
    voiceoverTTS: { bytes: 0, count: 0 },
    aiRequests: { bytes: 0, count: 0 },
    discovery: { bytes: 0, count: 0 },
    other: { bytes: 0, count: 0 },
  },
  recentLogs: []
};

// In-memory stats cache initialized from file
let stats = loadPersistedStats();
let sessionBytes = 0;
let saveDebounceTimer = null;

function loadPersistedStats() {
  try {
    if (fs.existsSync(STATS_PATH)) {
      const raw = fs.readFileSync(STATS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        totalBytes: Number(parsed.totalBytes) || 0,
        savedBytes: Number(parsed.savedBytes) || 0,
        breakdown: {
          ...DEFAULT_STATS.breakdown,
          ...(parsed.breakdown || {})
        },
        recentLogs: Array.isArray(parsed.recentLogs) ? parsed.recentLogs.slice(0, 30) : []
      };
    }
  } catch (err) {
    console.warn('[BandwidthTracker] Failed to read bandwidth_stats.json, resetting defaults:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATS));
}

function persistStats() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[BandwidthTracker] Could not save bandwidth_stats.json:', err.message);
    }
  }, 400);
}

/**
 * Format bytes into human readable string (KB, MB, GB)
 */
export function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b === 0) return '0.00 MB';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Convert bytes to decimal MB number
 */
export function bytesToMB(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  return Number((b / (1024 * 1024)).toFixed(2));
}

/**
 * Track an internet data usage event
 * @param {'videoDownload'|'streamSampling'|'metadata'|'voiceoverTTS'|'aiRequests'|'discovery'|'other'} category
 * @param {number} bytes - Number of bytes transferred
 * @param {string} details - Human description
 */
export function trackBandwidth(category = 'other', bytes = 0, details = '') {
  const numBytes = Math.max(0, Math.round(Number(bytes) || 0));
  if (numBytes <= 0) return;

  const validCategory = stats.breakdown[category] ? category : 'other';

  sessionBytes += numBytes;
  stats.totalBytes += numBytes;

  stats.breakdown[validCategory].bytes += numBytes;
  stats.breakdown[validCategory].count += 1;

  const now = new Date();
  const timeFormatted = now.toLocaleTimeString('id-ID', { hour12: false });

  const logEntry = {
    id: `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: now.toISOString(),
    timeFormatted,
    category: validCategory,
    categoryLabel: CATEGORY_LABELS[validCategory] || validCategory,
    bytes: numBytes,
    formattedSize: formatBytes(numBytes),
    details: details || CATEGORY_LABELS[validCategory]
  };

  stats.recentLogs.unshift(logEntry);
  if (stats.recentLogs.length > 30) {
    stats.recentLogs = stats.recentLogs.slice(0, 30);
  }

  persistStats();
}

/**
 * Track bandwidth saved by zero-download stream sampling & pre-filters
 * @param {number} bytes - Estimated bytes saved
 * @param {string} details - Explanation
 */
export function trackSavedBandwidth(bytes = 0, details = '') {
  const numBytes = Math.max(0, Math.round(Number(bytes) || 0));
  if (numBytes <= 0) return;

  stats.savedBytes += numBytes;
  persistStats();
}

/**
 * Get comprehensive bandwidth statistics for API / UI
 */
export function getBandwidthStats() {
  const total = stats.totalBytes;
  const session = sessionBytes;
  const saved = stats.savedBytes;

  const breakdownList = Object.entries(stats.breakdown).map(([catKey, val]) => {
    const b = val.bytes || 0;
    const percentage = total > 0 ? Number(((b / total) * 100).toFixed(1)) : 0;
    return {
      key: catKey,
      label: CATEGORY_LABELS[catKey] || catKey,
      bytes: b,
      mb: bytesToMB(b),
      formatted: formatBytes(b),
      count: val.count || 0,
      percentage
    };
  });

  return {
    totalBytes: total,
    totalMB: bytesToMB(total),
    totalFormatted: formatBytes(total),

    sessionBytes: session,
    sessionMB: bytesToMB(session),
    sessionFormatted: formatBytes(session),

    savedBytes: saved,
    savedMB: bytesToMB(saved),
    savedFormatted: formatBytes(saved),

    breakdown: breakdownList,
    recentLogs: stats.recentLogs.slice(0, 15),
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Reset bandwidth statistics
 * @param {'session'|'all'} scope
 */
export function resetBandwidthStats(scope = 'session') {
  if (scope === 'session') {
    sessionBytes = 0;
  } else {
    sessionBytes = 0;
    stats = JSON.parse(JSON.stringify(DEFAULT_STATS));
    if (fs.existsSync(STATS_PATH)) {
      try {
        fs.unlinkSync(STATS_PATH);
      } catch {}
    }
  }
  persistStats();
  return getBandwidthStats();
}
