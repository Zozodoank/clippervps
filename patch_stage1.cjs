const fs = require('fs');

let content = fs.readFileSync('server/worker/stage1Render.js', 'utf8');

// 1. Wrap the logic in Master Loop
const target1 = `    // Jika belum disetujui atau masuk mode Multi-Video Harvesting: Jalankan Stream 3-5 Video & Frame Pooling!
    if (!approved) {`;
const replacement1 = `    // Jika belum disetujui atau masuk mode Multi-Video Harvesting: Jalankan Stream 3-5 Video & Frame Pooling!
    let masterRetryCount = 0;
    let finalCompletedJob = null;
    let forceManualFallback = false;
    let autoFinalError = null;
    const failedCandidateUrls = new Set();
    let maxStreamVideos = explicitOnly ? 10 : (preferMultiVideo ? 5 : 3);
    let streamedCount = 0;
    let candidateResults = [];
    let hl = null;

    while (!finalCompletedJob && masterRetryCount < 3 && !forceManualFallback) {
      masterRetryCount++;
      if (masterRetryCount > 1) {
        approved = false; // Paksa re-harvesting
        console.log(\`[Job \${jobId}] 🔄 [Master Loop] Memulai ulang pencarian kandidat video (Percobaan \${masterRetryCount}/3)...\`);
        maxStreamVideos += 1;
      }

      if (!approved) {`;
content = content.replace(target1, replacement1);

// 2. Filter targetCandidates
const target2 = `      let searchIteration = 0;
      let candidatePool = Array.isArray(targetCandidates) ? [...targetCandidates] : [];`;
const replacement2 = `      let searchIteration = 0;
      let candidatePool = Array.isArray(targetCandidates) ? [...targetCandidates] : [];
      candidatePool = candidatePool.filter(c => !failedCandidateUrls.has(c.url || c));`;
content = content.replace(target2, replacement2);

// 3. Filter search results
const target3 = `              if (vid && !seenVids.has(vid)) {
                seenVids.add(vid);
                candidatePool.push(item);
              }`;
const replacement3 = `              if (vid && !seenVids.has(vid) && !failedCandidateUrls.has(item.url)) {
                seenVids.add(vid);
                candidatePool.push(item);
              }`;
content = content.replace(target3, replacement3);

// 4. Remove inner declarations
const target4 = `      // --- Loop Pengambilan Kandidat (Sampai Kuota/Target) ---
      let streamedCount = 0;
      let candidateResults = [];
      let maxStreamVideos = explicitOnly ? 10 : (preferMultiVideo ? 5 : 3);
      const targetMultiSources = explicitOnly ? 99 : (preferMultiVideo ? 3 : 2);
      const downloadedCandidatesMap = new Map();
      let hl = null;`;
const replacement4 = `      // --- Loop Pengambilan Kandidat (Sampai Kuota/Target) ---
      // streamedCount, candidateResults, maxStreamVideos, hl diset di luar master loop
      const targetMultiSources = explicitOnly ? 99 : (preferMultiVideo ? 3 : 2);
      const downloadedCandidatesMap = new Map();`;
content = content.replace(target4, replacement4);

// 5. Add Master Loop End and Error Handling
const target5 = `        autoFinalError = mergeErr;
        console.warn(\`[Job \${jobId}] Tahap final gagal, lanjut menunggu voiceover manual:\`, mergeErr.message);
      }
    }

    // Fallback (MODE MANUAL SAJA): TTS atau tahap final gagal`;
const replacement5 = `        autoFinalError = mergeErr;
        forceManualFallback = true;
        console.warn(\`[Job \${jobId}] Tahap final gagal, lanjut menunggu voiceover manual:\`, mergeErr.message);
      }
    }
    } // Akhir Master Loop

    if (finalCompletedJob) return finalCompletedJob;

    if (isAutoModeFallback) {
      throw new Error(\`Gagal merender video setelah \${masterRetryCount} kali percobaan (kandidat habis atau selalu ditolak QC).\`);
    }

    // Fallback (MODE MANUAL SAJA): TTS atau tahap final gagal`;
content = content.replace(target5, replacement5);

// 6. Add Continue condition in Phase 2
const target6 = `        return completedJob;
      } catch (mergeErr) {
        if (isAutoModeFallback) {
          // MODE AUTO: video final adalah satu-satunya output. Kalau tahap final/QC gagal,`;
const replacement6 = `        finalCompletedJob = completedJob;
        break;
      } catch (mergeErr) {
        if (isAutoModeFallback) {
          if (mergeErr.isFinalQcFailure || mergeErr.isAiRejection) {
            console.warn(\`[Job \${jobId}] ⛔ QC Final (Tahap 2) menolak video 1080p: \${mergeErr.message}. Membatalkan sisa tahap ini dan mencari video lain...\`);
            if (candidateResults) {
              candidateResults.forEach(c => {
                if (c.candidate && c.candidate.url) failedCandidateUrls.add(c.candidate.url);
              });
              candidateResults = []; // Kosongkan agar mencari baru
            }
            continue; // Kembali ke awal master loop
          }
          // MODE AUTO: video final adalah satu-satunya output. Kalau tahap final/QC gagal,`;
content = content.replace(target6, replacement6);

// 7. Add Continue condition in AI Verification
const target7 = `      if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
        throw new Error(
          \`Semua kandidat video (telah di-stream \${streamedCount} video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "\${productTitle}": \${lastRejectionError?.rejectionReason || lastRejectionError?.message || 'frame tidak mencukupi / ditolak filter atau AI'}.\`
        );
      }`;
const replacement7 = `      if (!hl || !Array.isArray(hl.clips) || hl.clips.length === 0) {
        const fallbackMsg = \`Semua kandidat video (telah di-stream \${streamedCount} video) belum memiliki cukup cuplikan produk yang memenuhi syarat untuk "\${productTitle}": \${lastRejectionError?.rejectionReason || lastRejectionError?.message || 'frame tidak mencukupi / ditolak filter atau AI'}.\`;
        if (isAutoModeFallback && candidatePoolIndex < candidatePool.length) {
            console.warn(\`[Job \${jobId}] ⚠️ \${fallbackMsg}. Meneruskan ke iterasi Master Loop untuk mencari video lain...\`);
            continue; // Ulangi master loop
        }
        throw new Error(fallbackMsg);
      }`;
content = content.replace(target7, replacement7);

fs.writeFileSync('server/worker/stage1Render.js', content, 'utf8');
console.log("Patch applied successfully.");
