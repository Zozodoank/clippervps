    const evaluateCandidate = async (targetUrl, candidateLabel = '', candidateExtra = {}) => {
      const isManualOem = candidateExtra?.source === 'manual_oem';
      const complianceContext = isManualOem ? 'oem' : 'auto';

      // 1. Bersihkan frame lama agar tidak tertumpuk
      if (fs.existsSync(rawFramesDir)) {
        try {
          const oldFiles = fs.readdirSync(rawFramesDir);
          for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(rawFramesDir, f)); } catch {}
          }
        } catch {}
      }

      // ── TAHAP 1: FILTER METADATA ──
      const metaMsg = candidateLabel
        ? `[${candidateLabel}] [Filter 1] Membaca durasi, judul & metadata video...`
        : '[Filter 1] Membaca durasi, judul & metadata video...';
      updateProgress({ step: 'metadata_qc', message: metaMsg, progress: 12, status: 'running' });

      const { metadata: meta, streamUrl } = await fetchVideoMetadataAndStream(targetUrl, {
        onProgress: updateProgress,
      });

      const isVisualMode = Boolean(
        options.isVisualSearch ||
        options.imageUrl ||
        options.productImage ||
        effectiveProductImage ||
        extraJobMeta?.isVisualSearch ||
        options.isVideoFirst ||
        candidateExtra?.isVisualSearch ||
        candidateExtra?.source === 'bing_visual_search' ||
        candidateExtra?.source === 'visual_ai_query'
      );

      const compliance = checkVideoMetadataCompliance(meta, productTitle, {
        ...options,
        isVisualSearch: isVisualMode,
        productImage: effectiveProductImage,
        imageUrl: effectiveProductImage,
      });
      
      if (!compliance.eligible && !isManualOem) {
        trackSavedBandwidth(35 * 1024 * 1024, `Hemat kuota (Filter 1 Metadata): ${compliance.reason}`);
        console.warn(`[Job ${jobId}] ⛔ [Filter 1 Ditolak] ${candidateLabel || targetUrl}: ${compliance.reason}`);
        const metaErr = new Error(`Metadata video ditolak: ${compliance.reason}`);
        metaErr.isAiRejection = true;
        metaErr.rejectionReason = compliance.reason;
        throw metaErr;
      }
      console.log(`[Job ${jobId}] ✅ [Filter 1 Lolos] Metadata valid (${meta.title}, ${meta.duration}s).`);

      // ── TAHAP 2: QUICK PREVIEW (10s) ──
      updateProgress({ step: 'quick_preview', message: `⚡ Download preview 10 detik dari ${candidateLabel || 'kandidat'}...`, progress: 15 });
      const preview10s = await downloadQuickPreview(targetUrl, tempDir, jobId, {
        onProgress: updateProgress,
        durationSec: Number(process.env.QUICK_PREVIEW_DURATION_SEC) || 10,
        sourceDurationSec: meta.duration
      });
      if (!preview10s?.filePath) throw Object.assign(new Error('Gagal download preview 10s'), { isAiRejection: true });

      // ── TAHAP 3: WHISPER GATE (EARLY SPEECH CHECK) ──
      updateProgress({ step: 'whisper_gate', message: '🎧 Whisper mengecek keberadaan narasi...', progress: 20 });
      const gateCheck = await analyzeNarrationAndSelectBestWindow(preview10s.filePath, {
        minCoverage: Number(process.env.WHISPER_NARRATION_MIN_COVERAGE) || 0.3,
        targetDurationSec: 10, // Not really used for window selection here since preview is 10s
        totalVideoDurationSec: preview10s.actualDurationSec,
        previewStartSec: preview10s.sourceStartSec,
      });
      if (!gateCheck.hasNarration) {
        const err = new Error(`Video tidak memiliki narasi yang cukup (gate 10s: ${gateCheck.reason}).`);
        err.isAiRejection = true;
        err.rejectionReason = 'Tidak ada narasi voice-over';
        throw err;
      }
      console.log(`[Job ${jobId}] ✅ [Whisper Gate Lolos] Ada narasi pada preview 10s.`);

      // ── TAHAP 4: FAST PROBE LOKAL (5 FRAME) ──
      updateProgress({ step: 'frame_probe', message: '🔎 Pemeriksaan visual cepat (5 frame)...', progress: 25 });
      const probe = await fastProbeLocal(preview10s.filePath, jobId, {
        onProgress: updateProgress,
        niche: options.niche || 'kitchen_tools',
        durationSec: preview10s.actualDurationSec,
        sourceId: targetUrl
      });
      if (!probe.eligible) {
        const err = new Error(`Frame kotor: ${probe.reason || `${probe.dirtyCount || '?'} dari 5 frame terdeteksi WM/wajah/logo`}`);
        err.isAiRejection = true;
        err.rejectionReason = probe.reason;
        throw err;
      }
      console.log(`[Job ${jobId}] ✅ [Fast Probe Lolos] 5 frame lokal bersih.`);

      // ── TAHAP 5: CONTEXT PREVIEW (35s) & WHISPER CONTEXT ──
      const contextDuration = Number(process.env.WHISPER_CONTEXT_DURATION_SEC) || 35;
      updateProgress({ step: 'context_preview', message: `⚡ Download konteks narasi ${contextDuration} detik...`, progress: 30 });
      
      const contextPreview = await downloadQuickPreview(targetUrl, tempDir, jobId + '_ctx', {
        onProgress: updateProgress,
        durationSec: contextDuration,
        sourceDurationSec: meta.duration
      });
      
      updateProgress({ step: 'window_select', message: '🎧 Whisper memilih window terbaik...', progress: 35 });
      const targetWindowSec = Number(process.env.BEST_WINDOW_DURATION_SEC) || 25;
      const contextCheck = await analyzeNarrationAndSelectBestWindow(contextPreview.filePath, {
        minCoverage: 0.1, // Minimal as it already passed gate
        targetDurationSec: targetWindowSec,
        totalVideoDurationSec: contextPreview.actualDurationSec,
        previewStartSec: contextPreview.sourceStartSec,
      });
      
      const bestWindow = contextCheck.bestWindow || {
        startSec: contextPreview.sourceStartSec,
        endSec: contextPreview.sourceStartSec + targetWindowSec,
        durationSec: targetWindowSec
      };
      
      console.log(`[Job ${jobId}] ✅ [Whisper Context] Terpilih window: ${bestWindow.startSec}s - ${bestWindow.endSec}s`);

      // ── TAHAP 6: GEMINI PRODUCT VERIFY ──
      // Gunakan frame bersih dari probe yang lulus
      let verifiedCleanFrames = probe.cleanFrames;
      
      updateProgress({ step: 'product_verify', message: '🤖 Gemini memverifikasi produk dan narasi...', progress: 40 });
      if (!isManualOem) {
        const verification = await verifyProductCandidateWithAI({
          frames: verifiedCleanFrames,
          productTitle,
          productDescription,
          productImage: effectiveProductImage,
          productFingerprint,
          niche: options.niche || 'kitchen_tools',
          apiKey,
          aiProvider,
        });
        if (!verification.verified) {
          const err = new Error(`Gemini menolak: ${verification.reason}`);
          err.isAiRejection = true;
          err.rejectionReason = verification.reason;
          throw err;
        }
      } else {
        console.log(`[Job ${jobId}] ⚠️ OEM Manual: Bypass AI product match.`);
      }

      // ── TAHAP 7: KEMBALIKAN EVALUATOR RESULT ──
      console.log(`[Job ${jobId}] 🎯 Kandidat Lolos Evaluasi!`);
      
      const hl = {
        clips: [{
          candidateUrl: targetUrl,
          sourceId: targetUrl,
          startSeconds: bestWindow.startSec,
          endSeconds: bestWindow.endSec,
          duration: bestWindow.durationSec,
          isClean: true
        }],
        bestWindow: {
          sourceId: targetUrl,
          startSec: bestWindow.startSec,
          endSec: bestWindow.endSec,
          durationSec: bestWindow.durationSec
        },
        whisperSegments: contextCheck.whisperSegments || [],
        narration: { hasNarration: true, coverage: contextCheck.coverage },
        pipelineVersion: 'whisper_first_v1',
        productHook: null 
      };

      noteVisionProvenance(hl, { usableFrames: verifiedCleanFrames.length, framesRef: verifiedCleanFrames, origin: 'candidate_frames' });
      return { 
        approved: true,
        highlight: hl, 
        videoMeta: meta, 
        previewVideoPath: contextPreview.filePath,
        probe: probe
      };
    };
