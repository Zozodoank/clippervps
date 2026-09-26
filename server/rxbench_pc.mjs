// rxbench_pc.mjs — UKUR RX NYATA NIC PC vs byte JPEG hasil dense sampling.
// Menutup loop empiris "amplop FFmpeg per-spawn". Jalankan dari folder server/.
// Pemakaian: node rxbench_pc.mjs [youtubeUrl]
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import 'dotenv/config';
import { fetchVideoMetadataAndStream, sampleFramesFromStream } from './services/videoFilterService.js';

// Matikan probe watermark agar bench murni mengukur envelope seek (probe bisa menolak kandidat).
process.env.GK_WATERMARK_PROBE = '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => Number(n) / 1e6;

function nicRxBytes() {
  // Primer: netstat -e (kumulatif sejak boot, tanpa admin). Baris "Bytes": kolom received pertama.
  try {
    const out = execSync('netstat -e', { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => /^\s*Bytes/i.test(l));
    if (line) {
      const m = line.match(/Bytes\s+([\d,]+)/i);
      if (m) return BigInt(m[1].replace(/,/g, ''));
    }
  } catch {}
  // Cadangan: Get-NetAdapterStatistics (hanya bila tersedia).
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum"',
      { encoding: 'utf8' },
    );
    const d = String(out).trim().replace(/\D/g, '');
    if (d) return BigInt(d);
  } catch {}
  return -1n;
}

const url = process.argv[2] || 'https://youtu.be/QQyKW9J1I3s';

(async () => {
  const rInit = nicRxBytes();
  if (rInit < 0n) {
    console.error('GAGAL membaca counter NIC (netstat -e & Get-NetAdapterStatistics mati).');
    process.exit(2);
  }

  // Baseline noise: amati NIC selama 4s TANPA sampling -> estimasi laju latar (tunnel/job lain).
  const b0 = nicRxBytes(); const bt0 = Date.now();
  await sleep(4000);
  const b1 = nicRxBytes(); const bt1 = Date.now();
  const bgBytes = b1 - b0; const bgMs = Math.max(1, bt1 - bt0);
  console.log(`[baseline] latar = ${MB(bgBytes).toFixed(2)} MB / ${(bgMs / 1000).toFixed(1)}s  (~${(MB(bgBytes) / (bgMs / 1000)).toFixed(2)} MB/s noise)`);

  console.log('[meta] fetchVideoMetadataAndStream...');
  const { metadata, streamUrl } = await fetchVideoMetadataAndStream(url, {});
  const dur = Number(metadata.duration) || 300;
  // Batasi bench <=150 frame (rasio bersifat per-frame, jadi tetap representatif & cepat).
  const maxFrames = Math.min(Math.max(20, Math.floor(dur / 1.5)), 150);
  console.log(`[meta] "${(metadata.title || '').slice(0, 40)}" dur=${dur}s  target_frame=${maxFrames}`);

  const dir = path.join(os.tmpdir(), `rxbench_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  const a0 = nicRxBytes(); const c0 = Date.now();
  const res = await sampleFramesFromStream(streamUrl, dir, {
    duration: dur, maxSampleFrames: maxFrames, onProgress: () => {},
  });
  const c1 = Date.now(); const a1 = nicRxBytes();
  const dtMs = Math.max(1, c1 - c0);
  const totalDelta = a1 - a0;

  let jpeg = 0; let nfiles = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/\.(jpg|png)$/i.test(f)) { jpeg += fs.statSync(path.join(dir, f)).size; nfiles++; }
  }

  const frames = res?.frames?.length || nfiles || 1;
  const bgDuring = BigInt(Math.round((Number(bgBytes) / bgMs) * dtMs));
  let myEnv = totalDelta - bgDuring; if (myEnv < 0n) myEnv = 0n;

  console.log('\n==================== RX PC BENCH ====================');
  console.log(`video            : ${url}`);
  console.log(`durasi           : ${dur}s`);
  console.log(`frame terekstrak : ${frames} (target ${maxFrames})`);
  console.log(`waktu sampling   : ${(dtMs / 1000).toFixed(1)}s`);
  console.log(`JPEG di disk     : ${(jpeg / 1e6).toFixed(3)} MB (${nfiles} file)`);
  console.log(`RX NIC total     : ${(Number(totalDelta) / 1e6).toFixed(3)} MB`);
  console.log(`RX noise latar    : ${(Number(bgDuring) / 1e6).toFixed(3)} MB (estimasi dari baseline)`);
  console.log(`RX khusus sampel : ${(Number(myEnv) / 1e6).toFixed(3)} MB`);
  console.log('-----------------------------------------------------');
  console.log(`RASIO (sampel/JPEG) = ${(Number(myEnv) / (jpeg || 1)).toFixed(1)}x`);
  console.log(`RASIO (total /JPEG) = ${(Number(totalDelta) / (jpeg || 1)).toFixed(1)}x`);
  console.log(`amplop per-frame    = ${(Number(myEnv) / frames / 1024).toFixed(0)} KB/frame`);
  console.log(`=> proyeksi job 200-frame ≈ ${(Number(myEnv) / frames * 200 / 1e6).toFixed(1)} MB RX untuk ~${(jpeg / frames * 200 / 1e6).toFixed(2)} MB JPEG`);
  console.log('=====================================================');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
