        try {
          const evalRes = await evaluateCandidate(candidate.url, candLabel, candidate);
          
          candidateResults.push({
            candidateIndex: currentCandIdx,
            candidate: { ...candidate, duration: evalRes.videoMeta.duration, title: evalRes.videoMeta.title },
            videoMeta: evalRes.videoMeta,
            cleanFrames: evalRes.probe.cleanFrames,
            cameraResultEligibleFrames: evalRes.probe.cameraResultEligibleFrames || [],
            discardedFaceTimestamps: evalRes.probe.discardedFaceTimestamps || [],
            discardedViolationTimestamps: evalRes.probe.discardedViolationTimestamps || [],
            cleanTimeWindows: (evalRes.probe.verifiedSegments || []).map(s => ({ start: s.startSec, end: s.endSec })),
            productVerification: { verified: true, confidence: 1, reason: 'Lolos evaluateCandidate' },
            highlight: evalRes.highlight,
            previewVideoPath: evalRes.previewVideoPath
          });
          streamedCount++;
        } catch (err) {
          lastRejectionError = err;
          streamedCount++; // Tetap hitung stream count
          continue;
        }
