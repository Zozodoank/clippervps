/**
 * Sampling titik audit klip (2,5 fps) — fungsi murni, terkunci unit test
 * clamping terhadap durasi NYATA file dilakukan di satu tempat yang bisa dites.
 *
 * Kenapa perlu: file hasil --download-sections kadang TERPOTONG (yt-dlp +
 * --force-keyframes-at-cuts menghasilkan file ~2 detik untuk rentang 22 detik yang
 * diminta — gejala Termux 2026-10-05: rentetan FFmpeg "code 234 / Could not open
 * encoder before EOF" di semua timestamp setelah akhir file nyata). Tanpa clamp ke
 * durasi file, audit tetap memakai offset dari durasi RENCANA dan tiap seek membaca
 * melewati EOF.
 */

/**
 * Hitung timestamp sampling audit (relatif terhadap AWAL FILE) untuk satu klip.
 * @param {object} p
 * @param {number} p.plannedDur - durasi klip terencana (detik; floor 1.5 seperti perilaku lama)
 * @param {number} [p.fileDur] - durasi NYATA file hasil probe (0/null = probe gagal -> perilaku lama)
 * @param {number} [p.startSeconds] - posisi klip pada timeline sumber global
 * @param {number} [p.sourceOffsetSec] - awal timeline file section (0 untuk video penuh)
 * @returns {number[]} timestamp untuk ffmpeg '-ss' (sudah dikurangi sourceOffsetSec, clamp bawah 0)
 */
export function buildAuditSampleTimestamps({ plannedDur, fileDur = 0, startSeconds = 0, sourceOffsetSec = 0 } = {}) {
  const dur = Math.max(1.5, Number(plannedDur) || 3.3);
  // Clamp ke durasi NYATA file (sisakan 0,1s margin agar '-ss' tidak mendarat tepat di EOF).
  // PENTING (mode --download-sections): satu file cluster bisa memuat beberapa klip, jadi
  // yang relevan adalah sisa file DI SETELAH posisi klip (fileDur - filePos), bukan fileDur
  // penuh. Tanpa koreksi ini, klip di tengah/akhir cluster menghasilkan timestamp melewati
  // EOF (gejala lama: FFmpeg "code 234 / Could not open encoder before EOF").
  const filePosSec = Math.max(0, (Number(startSeconds) || 0) - (Number(sourceOffsetSec) || 0));
  const effDur = fileDur > 0 ? Math.min(dur, Math.max(0.4, fileDur - filePosSec - 0.1)) : dur;
  const sampleStepSec = 0.40; // Every 400ms (2.5 fps) — eliminasi blind spot watermark/wajah.
  const sampleOffsets = [];
  for (let offset = 0.20; offset <= Math.max(0.20, effDur - 0.20); offset += sampleStepSec) {
    sampleOffsets.push(Math.round(offset * 100) / 100);
  }
  // Always include near the end of the clip to catch closing subtitles or logos.
  const endOffset = Math.round(Math.max(0.20, effDur - 0.20) * 100) / 100;
  if (!sampleOffsets.includes(endOffset)) {
    sampleOffsets.push(endOffset);
  }
  return sampleOffsets.map((offset) =>
    Math.max(0, Math.round(((Number(startSeconds) || 0) + offset - (Number(sourceOffsetSec) || 0)) * 100) / 100)
  );
}
