// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  countUsableFrames,
  shouldPreferEvidence,
  pickEvidenceFrames,
  sourceKeyOf,
  formatCleanWindowsBySource,
  mapFramesToBudgeted,
  shouldAllowRescue,
  buildVisionProvenance,
  isFrameVerdictMode,
  summarizeVisionRuns,
} from '../services/visionEvidenceService.js';
import {
  buildConfigSnapshot,
  configSnapshotToEnvPatch,
  isGeminiEvidenceEnabled,
} from '../config/runtimeFlags.js';

// EVIDENCE MODE: kunci perilaku murni (pure) dispatch Gemini hemat token.
// stage1Render/aiService hanya boleh memakai hasil fungsi-fungsi ini.

const mk = (ts) => ({ timestamp: ts, filePath: `/frames/f_${ts}.jpg` });

describe('countUsableFrames', () => {
  it('menghitung hanya frame dengan base64 atau filePath', () => {
    expect(countUsableFrames([mk(1), { timestamp: 2 }, null, { base64: 'AAA' }])).toBe(2);
  });
  it('ramah input kosong/undefined', () => {
    expect(countUsableFrames()).toBe(0);
    expect(countUsableFrames([])).toBe(0);
  });
});

describe('shouldPreferEvidence — gerbang fallback stream', () => {
  it('evidence hanya bila flag aktif DAN jumlah bukti memenuhi floor', () => {
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 6 })).toBe(true);
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 5 })).toBe(false);
    expect(shouldPreferEvidence({ evidenceEnabled: false, usableFrames: 100 })).toBe(false);
  });
  it('minFrames eksplisit mengalahkan env; floor global 2', () => {
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 3, minFrames: 3 })).toBe(true);
    expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 1, minFrames: 0 })).toBe(false);
  });
  it('memakai EVIDENCE_MIN_FRAMES dari env saat tidak diberikan', () => {
    const prev = process.env.EVIDENCE_MIN_FRAMES;
    process.env.EVIDENCE_MIN_FRAMES = '10';
    try {
      expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 9 })).toBe(false);
      expect(shouldPreferEvidence({ evidenceEnabled: true, usableFrames: 10 })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EVIDENCE_MIN_FRAMES;
      else process.env.EVIDENCE_MIN_FRAMES = prev;
    }
  });
});

describe('pickEvidenceFrames — budget cluster-aware', () => {
  it('tidak mengubah daftar kecil (<= max)', () => {
    const frames = [mk(0), mk(2), mk(4)];
    expect(pickEvidenceFrames(frames, { max: 30 })).toEqual(frames);
  });
  it('memotong ke budget max dan tetap kronologis + unik', () => {
    const frames = Array.from({ length: 100 }, (_, i) => mk(i * 2));
    const picked = pickEvidenceFrames(frames, { max: 30 });
    expect(picked.length).toBeLessThanOrEqual(30);
    const ts = picked.map((f) => f.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(picked.map((f) => f.filePath)).size).toBe(picked.length);
  });
  it('menjamin boundary pertama & terakhir tiap kluster adegan ikut terkirim', () => {
    // 3 kluster terpisah jauh (gap > clusterGapSec=8): window adegan berbeda.
    const cluster = (base) => Array.from({ length: 20 }, (_, i) => mk(base + i));
    const frames = [...cluster(0), ...cluster(100), ...cluster(200)];
    const picked = pickEvidenceFrames(frames, { max: 12 });
    const tsSet = new Set(picked.map((f) => f.timestamp));
    for (const base of [0, 100, 200]) {
      expect(tsSet.has(base)).toBe(true);      // awal kluster
      expect(tsSet.has(base + 19)).toBe(true); // akhir kluster
    }
  });
  it('mengabaikan frame tanpa bukti visual (tanpa base64/filePath)', () => {
    const frames = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? { timestamp: i } : mk(i * 10)));
    const picked = pickEvidenceFrames(frames, { max: 20 });
    expect(picked.every((f) => f.filePath)).toBe(true);
  });
  it('mende-duplikat frame identik (filePath sama)', () => {
    const dup = Array.from({ length: 60 }, () => mk(5));
    const picked = pickEvidenceFrames(dup, { max: 10 });
    expect(picked.length).toBe(1);
  });
  it('elemen hasil adalah OBJEK IDENTIK dengan input (prasyarat pemetaan indeks)', () => {
    const frames = Array.from({ length: 80 }, (_, i) => mk(i * 3));
    const picked = pickEvidenceFrames(frames, { max: 10 });
    expect(picked.every((f) => frames.includes(f))).toBe(true);
  });
});

const mkSrc = (candidateIndex, ts, n) => ({
  timestamp: ts,
  filePath: `/src${candidateIndex}/f_${n}.jpg`,
  candidateIndex,
  candidateTitle: `Video sumber ${candidateIndex + 1}`,
  videoId: `vid${candidateIndex}`,
});

describe('pickEvidenceFrames — jaminan variasi SUMBER video (regresi Reels 1 sumber)', () => {
  const buildPool = (counts) => {
    const pool = [];
    counts.forEach((count, ci) => {
      for (let i = 0; i < count; i++) pool.push(mkSrc(ci, i * 1.5, i));
    });
    return pool;
  };

  it('sumber kecil tetap terwakili walau sumber besar mendominasi pool', () => {
    // 100 frame vs 5 frame. Versi lama (sort timestamp global -> potong 30) tetap
    // menyisakan sumber kecil, TAPI kluster awal yang sama-sama mulai detik 0 membuat
    // alokasi didominasi sumber 0. Sekarang jatah minimum per sumber dijamin.
    const pool = buildPool([100, 5]);
    const picked = pickEvidenceFrames(pool, { max: 30 });
    const perSource = new Map();
    picked.forEach((f) => perSource.set(f.candidateIndex, (perSource.get(f.candidateIndex) || 0) + 1));
    expect(picked.length).toBeLessThanOrEqual(30);
    expect(perSource.get(1)).toBe(5); // sumber kecil diambil SEMUA, tidak dipangkas
    expect(perSource.get(0)).toBeGreaterThanOrEqual(2);
  });

  it('tiga sumber semuanya masuk bukti dan hasilnya di-interleave', () => {
    const pool = buildPool([40, 40, 40]);
    const picked = pickEvidenceFrames(pool, { max: 30 });
    const sourcesSeen = new Set(picked.map((f) => f.candidateIndex));
    expect(sourcesSeen.size).toBe(3);
    expect(picked.length).toBeLessThanOrEqual(30);
    // Tiga entri pertama harus dari sumber berbeda (round-robin), bukan blok satu video.
    expect(new Set(picked.slice(0, 3).map((f) => f.candidateIndex)).size).toBe(3);
  });

  it('objek hasil identik dengan input agar mapFramesToBudgeted tetap valid', () => {
    const pool = buildPool([25, 25]);
    const picked = pickEvidenceFrames(pool, { max: 12 });
    picked.forEach((f) => expect(pool.indexOf(f)).toBeGreaterThanOrEqual(0));
  });

  it('satu sumber: perilaku lama dipertahankan (cluster-aware, <= max, kronologis)', () => {
    const pool = buildPool([60]);
    const picked = pickEvidenceFrames(pool, { max: 20 });
    expect(picked.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < picked.length; i++) {
      expect(Number(picked[i].timestamp)).toBeGreaterThanOrEqual(Number(picked[i - 1].timestamp));
    }
  });

  it('max kecil tidak membuat satu sumber kehilangan seluruh jatah (floor >= 1)', () => {
    const pool = buildPool([30, 30, 30]);
    const picked = pickEvidenceFrames(pool, { max: 5 });
    const sourcesSeen = new Set(picked.map((f) => f.candidateIndex));
    expect(picked.length).toBeLessThanOrEqual(5);
    expect(sourcesSeen.size).toBe(3);
  });

  it('minPerSource dapat dinaikkan lewat opsi/env', () => {
    const pool = buildPool([40, 40]);
    const picked = pickEvidenceFrames(pool, { max: 30, minPerSource: 10 });
    const perSource = new Map();
    picked.forEach((f) => perSource.set(f.candidateIndex, (perSource.get(f.candidateIndex) || 0) + 1));
    expect(perSource.get(0)).toBeGreaterThanOrEqual(10);
    expect(perSource.get(1)).toBeGreaterThanOrEqual(10);
  });
});

describe('sourceKeyOf — identifikasi video sumber frame', () => {
  it('memakai candidateIndex bila ada (indeks kanonik pool)', () => {
    expect(sourceKeyOf({ candidateIndex: 2, videoId: 'abc' })).toBe('cand:2');
    expect(sourceKeyOf({ candidateIndex: 0 })).toBe('cand:0');
  });

  it('fallback ke videoId/URL bila indeks tidak disertakan', () => {
    expect(sourceKeyOf({ videoId: 'abc' })).toBe('src:abc');
    expect(sourceKeyOf({ candidate: { url: 'https://youtu.be/xyz' } })).toBe('src:https://youtu.be/xyz');
    expect(sourceKeyOf(null)).toBe('src:unknown');
    expect(sourceKeyOf({})).toBe('src:unknown');
  });
});

describe('mapFramesToBudgeted — terjemah indeks subset -> pool asli', () => {
  it('subset == asli (tanpa potong) tetap memetakan via identitas objek', () => {
    const a = mk(0); const b = mk(5);
    expect(mapFramesToBudgeted([1, 2], [a, b], [a, b])).toEqual([1, 2]);
  });
  it('indeks ruang subset dipetakan ke posisi array asli yang benar', () => {
    const original = Array.from({ length: 10 }, (_, i) => mk(i * 10));
    // subset acak-orde: asli[7] lalu asli[2] -> subset #1 => indeks asli 8, #2 => 3
    const subset = [original[7], original[2]];
    expect(mapFramesToBudgeted([1, 2], subset, original)).toEqual([8, 3]);
  });
  it('buang indeks di luar rentang subset dan hasil unik', () => {
    const original = [mk(0), mk(10), mk(20)];
    const subset = [original[2]];
    expect(mapFramesToBudgeted([1, 1, 5], subset, original)).toEqual([3]);
  });
  it('frame asing (tidak ada di pool) fallback ke indeks itu sendiri', () => {
    const original = [mk(0), mk(10)];
    const alien = mk(99);
    expect(mapFramesToBudgeted([1], [alien], original)).toEqual([1]);
  });
  it('end-to-end dengan pickEvidenceFrames: nomor yang dilihat AI menunjuk frame yang sama', () => {
    const pool = Array.from({ length: 90 }, (_, i) => ({ timestamp: i * 2, filePath: `/f/pool_${i}.jpg` }));
    const subset = pickEvidenceFrames(pool, { max: 12 });
    const aiPicks = [1, 4, 7, 12]; // indeks 1-based ruang subset (respons AI)
    const mapped = mapFramesToBudgeted(aiPicks, subset, pool);
    expect(mapped.map((i) => pool[i - 1].filePath)).toEqual(aiPicks.map((i) => subset[i - 1].filePath));
  });
});

describe('formatCleanWindowsBySource — fix P0 sumber window', () => {
  it('kosong -> string kosong', () => {
    expect(formatCleanWindowsBySource([])).toBe('');
    expect(formatCleanWindowsBySource(undefined)).toBe('');
  });
  it('tanpa sourceVideoIndex -> directive flatlegacy', () => {
    const out = formatCleanWindowsBySource([{ start: 10, end: 25 }, { start: 40, end: 60 }]);
    expect(out).toContain('10s-25s, 40s-60s');
    expect(out).toContain('CRITICAL MANDATE');
    expect(out).not.toContain('VIDEO #2');
  });
  it('dengan sourceVideoIndex -> kelompok per VIDEO dengan label', () => {
    const out = formatCleanWindowsBySource(
      [
        { start: 5, end: 20, sourceVideoIndex: 0 },
        { start: 10, end: 30, sourceVideoIndex: 1 },
        { start: 100, end: 120, sourceVideoIndex: 1 },
      ],
      ['youtube.com/watch?v=AAA', 'youtube.com/watch?v=BBB'],
    );
    expect(out).toContain('VIDEO #1');
    expect(out).toContain('VIDEO #2');
    expect(out).toContain('5s-20s');
    expect(out).toMatch(/VIDEO #2.*10s-30s.*100s-120s/s);
    expect(out).toContain('SOURCE-SCOPED');
  });
  it('window dengan koordinat tidak valid dibuang', () => {
    const out = formatCleanWindowsBySource([{ start: 'x', end: 5 }, { start: 1, end: 2 }]);
    expect(out).toContain('1s-2s');
    expect(out).not.toContain('xs-5s');
  });
});

describe('runtimeFlags — GEMINI_INPUT_MODE & budget beku per-job (retry)', () => {
  it('default evidence; hanya "stream" (kasar-abai-spasi) yang kembali ke mode lama', () => {
    expect(buildConfigSnapshot({}).GEMINI_INPUT_MODE).toBe('evidence');
    expect(buildConfigSnapshot({ GEMINI_INPUT_MODE: ' STREAM ' }).GEMINI_INPUT_MODE).toBe('stream');
    expect(buildConfigSnapshot({ GEMINI_INPUT_MODE: 'nonsense' }).GEMINI_INPUT_MODE).toBe('evidence');
  });
  it('budget evidence memakai floor yang sama dengan konsumen', () => {
    expect(buildConfigSnapshot({}).EVIDENCE_MIN_FRAMES).toBe(6);
    expect(buildConfigSnapshot({ EVIDENCE_MIN_FRAMES: '1' }).EVIDENCE_MIN_FRAMES).toBe(2);
    expect(buildConfigSnapshot({ EVIDENCE_MAX_FRAMES: '40' }).EVIDENCE_MAX_FRAMES).toBe(40);
    expect(buildConfigSnapshot({ EVIDENCE_MAX_FRAMES: 'abc' }).EVIDENCE_MAX_FRAMES).toBe(30);
  });
  it('isGeminiEvidenceEnabled membaca env secara toleran', () => {
    expect(isGeminiEvidenceEnabled({})).toBe(true);
    expect(isGeminiEvidenceEnabled({ GEMINI_INPUT_MODE: 'Evidence' })).toBe(true);
    expect(isGeminiEvidenceEnabled({ GEMINI_INPUT_MODE: 'Stream' })).toBe(false);
  });
  it('round-trip retry: env drift tidak mengubah mode/budget job yang beku', () => {
    const snap = buildConfigSnapshot({ GEMINI_INPUT_MODE: 'stream', EVIDENCE_MAX_FRAMES: '20' });
    const drifted = { GEMINI_INPUT_MODE: 'evidence', EVIDENCE_MAX_FRAMES: '50' };
    const applied = { ...drifted, ...configSnapshotToEnvPatch(snap) };
    const resnap = buildConfigSnapshot(applied);
    expect(resnap.GEMINI_INPUT_MODE).toBe('stream');
    expect(resnap.EVIDENCE_MAX_FRAMES).toBe(20);
    // snapshot default pun tetap menulis patch explisit (kunci anti-drift)
    expect(configSnapshotToEnvPatch(buildConfigSnapshot({})).GEMINI_INPUT_MODE).toBe('evidence');
  });
  it('membekukan flag hemat-kuota render (RENDER_MAX_HEIGHT / RENDER_VIDEO_ONLY) per job', () => {
    expect(buildConfigSnapshot({}).RENDER_MAX_HEIGHT).toBe(1080);
    expect(buildConfigSnapshot({ RENDER_MAX_HEIGHT: '720' }).RENDER_MAX_HEIGHT).toBe(720);
    expect(buildConfigSnapshot({ RENDER_MAX_HEIGHT: 'nonsense' }).RENDER_MAX_HEIGHT).toBe(1080);
    // default ON (buang audio) persis seperti cara downloader.js membacanya
    expect(buildConfigSnapshot({}).RENDER_VIDEO_ONLY).toBe(true);
    expect(buildConfigSnapshot({ RENDER_VIDEO_ONLY: '0' }).RENDER_VIDEO_ONLY).toBe(false);
    const patch = configSnapshotToEnvPatch(buildConfigSnapshot({ RENDER_VIDEO_ONLY: '0', RENDER_MAX_HEIGHT: '720' }));
    expect(patch.RENDER_VIDEO_ONLY).toBe('0');
    expect(patch.RENDER_MAX_HEIGHT).toBe('720');
  });
});

describe('shouldAllowRescue — vonis AI menolak seluruh bukti', () => {
  it('tanpa vonis AI (crash/parse gagal) rescue tetap diizinkan', () => {
    expect(shouldAllowRescue({ aiGaveVerdict: false, acceptedCount: 0, rejectedCount: 30 })).toBe(true);
    expect(shouldAllowRescue()).toBe(true);
  });
  it('ada frame yang disetujui AI -> boleh merakit dari frame itu saja', () => {
    expect(shouldAllowRescue({ aiGaveVerdict: true, acceptedCount: 4, rejectedCount: 26 })).toBe(true);
  });
  it('vonis "0 diterima, >0 ditolak" (kasus auto_3dd085b354) -> DILARANG memaksa', () => {
    expect(shouldAllowRescue({ aiGaveVerdict: true, acceptedCount: 0, rejectedCount: 30 })).toBe(false);
    expect(shouldAllowRescue({ aiGaveVerdict: true, acceptedCount: '0', rejectedCount: '30' })).toBe(false);
  });
  it('vonis kosong total (0 dikirim) bukan penolakan -> tidak memblokir', () => {
    expect(shouldAllowRescue({ aiGaveVerdict: true, acceptedCount: 0, rejectedCount: 0 })).toBe(true);
  });
});

describe('buildVisionProvenance + summarizeVisionRuns — penanda durabel jalur visual', () => {
  it('hanya mode yang dikenal yang lolos (mencegah label palsu di riwayat)', () => {
    expect(buildVisionProvenance({ mode: 'evidence' }).mode).toBe('evidence');
    expect(buildVisionProvenance({ mode: 'gemini_stream_multi' }).mode).toBe('gemini_stream_multi');
    expect(buildVisionProvenance({ mode: 'stream' }).mode).toBe('unknown');
    expect(buildVisionProvenance({}).mode).toBe('unknown');
  });
  // Terukur di Termux 3 Okt 2026 (job auto_dbc4b00594): trace melaporkan
  // "Jalur visual unknown: 0 frame dikirim" padahal product_verify mengirim 5 frame bersih
  // ke Gemini, karena panggilan itu tidak membawa label mode sama sekali.
  it('mode pelaporan baru dikenal, tetapi TIDAK menyalakan gerbang vonis frame', () => {
    expect(buildVisionProvenance({ mode: 'product_verify', framesSent: 5 }).mode).toBe('product_verify');
    expect(buildVisionProvenance({ mode: 'vlm_local', framesSent: 30 }).mode).toBe('vlm_local');
    // Invarian inti: gerbang vonis hanya untuk bukti yang benar-benar divonis Gemini per-frame.
    // Kalau ini berubah, keputusan Rescue Pipeline (shouldAllowRescue) ikut berubah.
    expect(isFrameVerdictMode('evidence')).toBe(true);
    expect(isFrameVerdictMode('frames_stride')).toBe(true);
    for (const m of ['product_verify', 'vlm_local', 'gemini_stream', 'gemini_stream_multi', 'unknown']) {
      expect(isFrameVerdictMode(m), `mode ${m} tidak boleh dianggap vonis frame`).toBe(false);
    }
  });

  it('angka dinegatifkan/di-bulatkan dan nilai sampah jadi 0', () => {
    const p = buildVisionProvenance({ mode: 'evidence', usableFrames: '12.7', framesSent: -5, acceptedCount: NaN, rejectedCount: null });
    expect(p).toEqual({ mode: 'evidence', usableFrames: 13, framesSent: 0, acceptedCount: 0, rejectedCount: 0, sourceCount: 0 });
  });
  it('ramah input tanpa argumen', () => {
    expect(buildVisionProvenance().mode).toBe('unknown');
  });
  it('ringkasan menjumlahkan seluruh panggilan dan menyimpan panggilan terakhir', () => {
    expect(summarizeVisionRuns([])).toBe(null);
    expect(summarizeVisionRuns()).toBe(null);
    const runs = [
      buildVisionProvenance({ mode: 'evidence', framesSent: 30, acceptedCount: 0, rejectedCount: 30 }),
      buildVisionProvenance({ mode: 'gemini_stream', framesSent: 0, acceptedCount: 2, rejectedCount: 1 }),
    ];
    const s = summarizeVisionRuns(runs);
    expect(s.runs).toBe(2);
    expect(s.modes).toEqual(['evidence', 'gemini_stream']);
    expect(s.acceptedTotal).toBe(2);
    expect(s.rejectedTotal).toBe(31);
    expect(s.last.mode).toBe('gemini_stream');
  });
});
