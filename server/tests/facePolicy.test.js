import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveNicheFacePolicy,
  callAIGatekeeperMicroservice,
  inspectFramesLocally,
  poolMultiCandidateFrames,
} from '../services/videoFilterService.js';

// Helper: buat file frame sungguhan di disk (microservice call memvalidasi fs.existsSync)
function makeTempFrameFiles(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-frames-'));
  return Array.from({ length: n }, (_, i) => {
    const filePath = path.join(dir, `frame_${i}.jpg`);
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // JPEG seadanya
    return { filePath, timestamp: i * 2.0, base64: 'data:image/jpeg;base64,AAAA' };
  });
}

function mockGatekeeperResponse(allFrames, extra = {}) {
  const impl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'success', allFrames, ...extra }),
  });
  global.fetch = impl;
  return impl;
}

afterEach(() => {
  delete global.fetch;
});

describe('Face Policy (Fase 3) - videoFilterService', () => {
  describe('resolveNicheFacePolicy (data-driven, tanpa if(niche))', () => {
    it('gadget_smartphone menjadi presenter_only (slot 5 review kamera memilikinya)', () => {
      expect(resolveNicheFacePolicy('gadget_smartphone')).toBe('presenter_only');
    });

    it('kitchen_tools tetap strict (perilaku lama, tidak pernah berubah)', () => {
      expect(resolveNicheFacePolicy('kitchen_tools')).toBe('strict');
    });

    it('niche tidak dikenal menjadi strict (fail-safe)', () => {
      expect(resolveNicheFacePolicy('niche_gaada')).toBe('strict');
      expect(resolveNicheFacePolicy(undefined)).toBe('strict');
    });
  });

  describe('callAIGatekeeperMicroservice payload', () => {
    it('mengirim facePolicy ke gatekeeper (default strict)', async () => {
      const frames = makeTempFrameFiles(6);
      const impl = mockGatekeeperResponse([]);
      await callAIGatekeeperMicroservice(frames, {});
      const body = JSON.parse(impl.mock.calls[0][1].body);
      expect(body.facePolicy).toBe('strict');
    });

    it('meneruskan facePolicy presenter_only bila diberikan caller', async () => {
      const frames = makeTempFrameFiles(6);
      const impl = mockGatekeeperResponse([]);
      await callAIGatekeeperMicroservice(frames, { niche: 'gadget_smartphone', facePolicy: 'presenter_only' });
      const body = JSON.parse(impl.mock.calls[0][1].body);
      expect(body.niche).toBe('gadget_smartphone');
      expect(body.facePolicy).toBe('presenter_only');
    });
  });

  describe('inspectFramesLocally - pemisahan pool', () => {
    it('gadget: niche menurunkan facePolicy presenter_only, flag tidak bocor ke cleanFrames', async () => {
      const frames = makeTempFrameFiles(6);
      const allFrames = [
        { filePath: frames[0].filePath, timestamp: 0.0, status: 'clean' },
        { filePath: frames[1].filePath, timestamp: 2.0, status: 'clean' },
        { filePath: frames[2].filePath, timestamp: 4.0, status: 'clean' },
        // Frame kamera dengan wajah konten (bukan presenter) - clean + flagged
        { filePath: frames[3].filePath, timestamp: 6.0, status: 'clean', cameraResultEligible: true, faces: [{ box: [10, 10, 30, 30], kind: 'content' }] },
        { filePath: frames[4].filePath, timestamp: 8.0, status: 'clean', cameraResultEligible: true, faces: [{ box: [10, 10, 30, 30], kind: 'content' }] },
        // Wajah kreator memegang kamera - WAJIB tetap dibuang stage face
        { filePath: frames[5].filePath, timestamp: 10.0, status: 'discarded', stage: 'face', reason: 'Wajah presenter terdeteksi' },
      ];
      const impl = mockGatekeeperResponse(allFrames, { verifiedSegments: [], cameraResultEligibleCount: 2 });

      const res = await inspectFramesLocally(frames, { niche: 'gadget_smartphone' });

      // Payload yang terkirim ke gatekeeper
      const body = JSON.parse(impl.mock.calls[0][1].body);
      expect(body.facePolicy).toBe('presenter_only');

      // Kontrak pool: tidak ada satu pun flagged frame di cleanFrames utama
      expect(res.facePolicy).toBe('presenter_only');
      expect(res.cleanFrames.length).toBe(3);
      expect(res.cleanFrames.every(f => !f.cameraResultEligible)).toBe(true);
      expect(res.cameraResultEligibleFrames.length).toBe(2);
      expect(res.cameraResultEligibleFrames.every(f => f.cameraResultEligible === true)).toBe(true);

      // Eligibilitas utama hanya dihitung dari cleanFrames strict (3 frame)
      expect(res.eligible).toBe(true);

      // Wajah presenter tetap tercermin di discardedFaceTimestamps
      expect(res.discardedFaceTimestamps).toContain(10.0);
    });

    it('kitchen: facePolicy selalu strict dan tidak ada pool eligible terbentuk', async () => {
      const frames = makeTempFrameFiles(6);
      const allFrames = frames.map((f, i) => ({ filePath: f.filePath, timestamp: i * 2.0, status: 'clean' }));
      const impl = mockGatekeeperResponse(allFrames, { verifiedSegments: [] });

      const res = await inspectFramesLocally(frames, { niche: 'kitchen_tools' });

      const body = JSON.parse(impl.mock.calls[0][1].body);
      expect(body.facePolicy).toBe('strict');
      expect(res.facePolicy).toBe('strict');
      expect(res.cleanFrames.length).toBe(6);
      expect(res.cameraResultEligibleFrames).toEqual([]);
    });

    it('flag cameraResultEligible cacat dari gatekeeper (string) tidak dianggap eligible', async () => {
      const frames = makeTempFrameFiles(6);
      const allFrames = frames.map((f, i) => ({
        filePath: f.filePath,
        timestamp: i * 2.0,
        status: 'clean',
        ...(i === 0 ? { cameraResultEligible: 'true' } : {}), // string, bukan boolean
      }));
      mockGatekeeperResponse(allFrames, { verifiedSegments: [] });

      const res = await inspectFramesLocally(frames, { niche: 'gadget_smartphone' });
      expect(res.cameraResultEligibleFrames).toEqual([]);
      expect(res.cleanFrames.length).toBe(6);
    });
  });

  describe('inspectFramesLocally - gatekeeper OFFLINE (:5050 dimatikan)', () => {
    // Regresi mandate 2026-10-04: user mematikan :5050 dengan sengaja. Di mode ADVISORY
    // (default saat Oracle aktif), gatekeeper mati = TIDAK ADA kecurigaan lokal, BUKAN
    // penolakan — semua frame WAJIB tetap diteruskan ke Oracle (Qwen pemutus akhir).
    // Kalau tidak, kandidat dibuang sebelum pool dan "AI lokal berhenti mengirim frame ke Kaggle".
    it('advisory: fetch gagal -> eligible true, SEMUA frame jadi cleanFrames (lanjut ke Oracle)', async () => {
      const prev = process.env.GK_LOCAL_VETO;
      process.env.GK_LOCAL_VETO = 'advisory';
      const frames = makeTempFrameFiles(6);
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5050'));
      try {
        const res = await inspectFramesLocally(frames, { niche: 'kitchen_tools' });
        expect(res.gatekeeperBackend).toBe('skipped_unavailable_advisory');
        expect(res.eligible).toBe(true);
        expect(res.cleanFrames.length).toBe(6);
        expect(res.discardedFrames).toEqual([]);
        expect(res.localSuspicion).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.GK_LOCAL_VETO; else process.env.GK_LOCAL_VETO = prev;
      }
    });

    it('strict: fetch gagal -> eligible false + sentinel gatekeeperBackend unavailable (pemanggil lempar infra)', async () => {
      const prevVeto = process.env.GK_LOCAL_VETO;
      const prevHeur = process.env.GK_ALLOW_HEURISTIC_FALLBACK;
      process.env.GK_LOCAL_VETO = 'strict';
      delete process.env.GK_ALLOW_HEURISTIC_FALLBACK;
      const frames = makeTempFrameFiles(6);
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5050'));
      try {
        const res = await inspectFramesLocally(frames, { niche: 'kitchen_tools' });
        expect(res.gatekeeperBackend).toBe('unavailable');
        expect(res.eligible).toBe(false);
        expect(res.cleanFrames).toEqual([]);
      } finally {
        if (prevVeto === undefined) delete process.env.GK_LOCAL_VETO; else process.env.GK_LOCAL_VETO = prevVeto;
        if (prevHeur !== undefined) process.env.GK_ALLOW_HEURISTIC_FALLBACK = prevHeur;
      }
    });

    it('frame <5 (ekstraksi FFmpeg gagal) -> sentinel unavailable + isInfra (fix 2026-10-05, bukan vonis konten)', async () => {
      // Regresi BUG 4: dulu early-return ini TANPA gatekeeperBackend, sehingga fastProbeLocal
      // tidak melempar isInfraError dan lanjut dengan 0-4 frame (sering file 0-byte) ke Oracle.
      const frames = makeTempFrameFiles(2);
      const res = await inspectFramesLocally(frames, { niche: 'kitchen_tools' });
      expect(res.eligible).toBe(false);
      expect(res.gatekeeperBackend).toBe('unavailable');
      expect(res.isInfra).toBe(true);
    });
  });

  describe('poolMultiCandidateFrames - includeEligible default false', () => {
    const buildCandidate = (idx) => ({
      candidateIndex: idx,
      candidate: { id: `vid${idx}`, title: `Video ${idx}`, url: `https://yt/watch?v=vid${idx}` },
      cleanFrames: Array.from({ length: 5 }, (_, j) => ({
        filePath: `/f/c${idx}_f${j}.jpg`, timestamp: j * 2.0, candidateIndex: idx,
      })),
      cameraResultEligibleFrames: [{
        filePath: `/f/c${idx}_elig.jpg`, timestamp: 90.0, candidateIndex: idx, isCameraResultEligible: true,
      }],
    });

    it('default: frame eligible tidak pernah masuk pool', () => {
      const pool = poolMultiCandidateFrames([buildCandidate(0), buildCandidate(1)], { maxTotalFrames: 8 });
      expect(pool.some(f => f.isCameraResultEligible)).toBe(false);
      expect(pool.length).toBe(8);
    });

    it('includeEligible=true: frame eligible ditambahkan setelah pool utama, ditandai isCameraResultEligible', () => {
      const pool = poolMultiCandidateFrames([buildCandidate(0), buildCandidate(1)], { maxTotalFrames: 8, includeEligible: true });
      const eligible = pool.filter(f => f.isCameraResultEligible);
      expect(eligible.length).toBe(2);
      // Selalu di belakang pool utama (tidak mengganggu distribusi round-robin frame bersih)
      const firstEligibleIdx = pool.findIndex(f => f.isCameraResultEligible);
      expect(firstEligibleIdx).toBeGreaterThanOrEqual(8);
      expect(pool.slice(0, 8).every(f => !f.isCameraResultEligible)).toBe(true);
      expect(eligible.every(f => f.displayLabel.includes('[camera-result]'))).toBe(true);
    });
  });
});
