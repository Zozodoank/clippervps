// ============================================================================
// AI USAGE ROUTES — jendela baca untuk Lapis 1 "hemat token Gemini".
//
// FUNGSI: menjawab satu pertanyaan yang selama ini tidak bisa dijawab project ini:
// "panggilan AI mana yang sebenarnya membakar token/biaya, dan seberapa sering ia
//  gagal?" Jawabannya ada di tabel ai_usage_events (ditulis oleh
// services/aiUsageService.js). Tanpa rute ini, angka itu cuma bisa dibaca lewat
// sqlite CLI dan tidak bisa dibandingkan antar job.
//
// PENTING: rute ini HANYA membaca. Tidak ada satu pun perilaku pipeline yang
// berubah karena ia dipanggil.
//
// KEAMANAN: sengaja TIDAK masuk allowlist publik tokenAuth (lihat
// api/middleware/tokenAuth.js), jadi butuh API_ACCESS_TOKEN sama seperti endpoint
// kerja lainnya. Yang dibocorkan lewat respons ini bukan isi media, tapi pola
// pemakaian (nama model, jumlah token, error). Cukup sensitif untuk tidak dibuka
// anonim: angka-angka ini adalah tagihan AI Anda.
// ============================================================================
import express from 'express';
import {
  summarizeAiUsage,
  listAiUsage,
  topAiUsageSitesForJob,
  pruneAiUsageEvents,
} from '../../store/jobStore.js';
import { isRecordingEnabled } from '../../services/aiUsageService.js';
import { createRateLimiter, recordAuditEvent } from '../../utils/security.js';

const router = express.Router();

const usageLimiter = createRateLimiter({ name: 'ai-usage', windowMs: 60_000, max: 60 });
const pruneLimiter = createRateLimiter({ name: 'ai-usage-prune', windowMs: 60_000, max: 5 });

const MAX_WINDOW_HOURS = 24 * 90; // 90 hari, sama batasnya dengan retensi tabel

/** `hours` -> rentang ms; clamp agar tidak pernah memaksa scan seluruh tabel. */
function windowFromHours(raw) {
  const hours = Number(raw);
  const h = Number.isFinite(hours) && hours > 0 ? Math.min(MAX_WINDOW_HOURS, hours) : 24;
  return { hours: h, sinceMs: Math.round(h * 3600_000) };
}

/**
 * GET /api/ai-usage
 *   ?jobId=...      batasi ke satu job
 *   ?hours=24       lebar jendela waktu (default 24, maks 2160)
 *   ?detail=1       sertakan 50 panggilan mentah terbaru
 *   ?topForJob=1    ganti keluaran jadi ringkasan per situs untuk SATU job (butuh jobId)
 */
router.get('/ai-usage', usageLimiter, (req, res) => {
  try {
    const jobId = String(req.query.jobId || '').slice(0, 120);
    const { hours, sinceMs } = windowFromHours(req.query.hours);

    // Mode khusus: "kenapa job ini lama/mahal?" -> ringkas per situs, tanpa window.
    if (String(req.query.topForJob || '') === '1') {
      if (!jobId) return res.status(400).json({ ok: false, error: 'topForJob=1 membutuhkan jobId' });
      return res.json({ ok: true, jobId, recordingEnabled: isRecordingEnabled(), bySite: topAiUsageSitesForJob(jobId, 10) });
    }

    const summary = summarizeAiUsage({ jobId, sinceMs });
    const payload = {
      ok: true,
      recordingEnabled: isRecordingEnabled(),
      jobId: jobId || null,
      window: { hours, since: summary.windowSince },
      totals: summary.totals,
      bySite: summary.bySite,
      // Situs paling sering gagal — inilah bukti "fallback karena kuota", bukan karena produk.
      failingSites: summary.bySite
        .filter((s) => s.failedCalls > 0)
        .sort((a, b) => b.failedCalls - a.failedCalls)
        .slice(0, 5)
        .map((s) => ({ site: s.site, model: s.model, failedCalls: s.failedCalls, calls: s.calls })),
    };
    if (String(req.query.detail || '') === '1') {
      payload.events = listAiUsage({ jobId, limit: 50 });
    }
    if (!payload.recordingEnabled) {
      payload.notice = 'Pencatatan mati (AI_USAGE_RECORD=0) — angka di bawah adalah sisa data lama.';
    }
    return res.json(payload);
  } catch (err) {
    // Tabel belum terbentuk pada DB lama bukan alasan untuk 500 tanpa penjelasan.
    return res.status(500).json({ ok: false, error: String(err?.message || err).slice(0, 200) });
  }
});

/**
 * POST /api/ai-usage/prune
 * Pemeliharaan eksplisit: buang kejadian lebih tua dari `keepDays` (default 30).
 * Dipisah dari GET karena membaca statistik tidak boleh mengubah apa pun.
 */
router.post('/ai-usage/prune', pruneLimiter, (req, res) => {
  try {
    const keepDays = Math.max(1, Math.min(365, Number(req.body?.keepDays) || 30));
    const removed = pruneAiUsageEvents({ keepMs: keepDays * 24 * 3600_000 });
    recordAuditEvent({ req, action: 'ai-usage-prune', detail: `keepDays=${keepDays} removed=${removed}` });
    return res.json({ ok: true, keepDays, removed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err).slice(0, 200) });
  }
});

export default router;
