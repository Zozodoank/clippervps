// rxcookietest.mjs — buktikan: googlevideo 403 karena FFmpeg tak kirim Cookie?
// Jalankan di terminal biasa: node rxcookietest.mjs [youtubeUrl]
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import 'dotenv/config';
import { fetchVideoMetadataAndStream } from './services/videoFilterService.js';
import { getFFmpegPath } from './services/binaryChecker.js';

const url = process.argv[2] || 'https://youtu.be/QQyKW9J1I3s';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const BASE_HDRS = 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com/\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n';

// Parse cookies.txt (Netscape format) for youtube/google domains
function buildCookieHeader() {
  const cookiePaths = [
    path.join(os.getcwd(), 'cookies.txt'),
    path.resolve(os.getcwd(), '..', 'cookies.txt'),
  ];
  let cookieFile = cookiePaths.find(p => fs.existsSync(p));
  if (!cookieFile) { console.log('[WARN] cookies.txt tidak ditemukan'); return null; }
  const lines = fs.readFileSync(cookieFile, 'utf-8').split(/\r?\n/);
  const pairs = [];
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , , , , name, value] = parts;
    if (/youtube|google/i.test(domain)) {
      pairs.push(`${name}=${value}`);
    }
  }
  if (!pairs.length) return null;
  return `Cookie: ${pairs.join('; ')}\r\n`;
}

function trySeek(ffmpegPath, streamUrl, extraHeaders, label) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `cookietest_${label}.jpg`);
    const allHeaders = BASE_HDRS + (extraHeaders || '');
    const proc = spawn(ffmpegPath, [
      '-y',
      '-user_agent', UA,
      '-headers', allHeaders,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
      '-ss', '30', '-i', streamUrl,
      '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '3',
      out,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', (code) => {
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const err403 = /403|Forbidden/i.test(stderr);
      console.log(`[${label}] exit=${code} file=${size}b 403=${err403 ? 'YES' : 'no'}`);
      if (err403) {
        const m = stderr.match(/Server returned (\d+).*|(\d+ : Forbidden)/i);
        if (m) console.log(`  msg: ${m[0].slice(0, 120)}`);
      }
      try { fs.unlinkSync(out); } catch {}
      resolve({ code, size, err403 });
    });
    proc.on('error', (e) => { console.log(`[${label}] SPAWN ERROR: ${e.message}`); resolve({ code: -1, size: 0, err403: false }); });
  });
}

(async () => {
  const FFMPEG = await getFFmpegPath();
  console.log('1) Fetch metadata + streamUrl via yt-dlp (dengan cookies)...');
  const { metadata, streamUrl } = await fetchVideoMetadataAndStream(url, {});
  const dur = Number(metadata.duration) || 300;
  console.log(`   title="${metadata.title}" dur=${dur}s`);
  console.log(`   streamUrl prefix: ${streamUrl.slice(0, 90)}...`);

  console.log('\n2) Seek TANPA cookie (perilaku kode saat ini)...');
  const r1 = await trySeek(FFMPEG, streamUrl, '', 'no-cookie');

  console.log('\n3) Seek DENGAN cookie dari cookies.txt...');
  const cookieHdr = buildCookieHeader();
  if (!cookieHdr) { console.log('[SKIP] tidak bisa build cookie header'); process.exit(1); }
  console.log(`   cookie header panjang: ${cookieHdr.length} chars`);
  const r2 = await trySeek(FFMPEG, streamUrl, cookieHdr, 'with-cookie');

  console.log('\n===== KESIMPULAN =====');
  if (r1.err403 && !r2.err403 && r2.size > 0) {
    console.log('✓ TERBUKTI: FFmpeg butuh Cookie header. Fix = kirim cookies ke FFmpeg.');
  } else if (r1.err403 && r2.err403) {
    console.log('✗ KEDUANYA 403 — masalah bukan cookie. Mungkin URL expired / IP-block / format issue.');
  } else if (!r1.err403 && r1.size > 0) {
    console.log('?! Seek tanpa cookie SUKSES. Kemungkinan 403 sebelumnya intermittent / sudah pulih.');
  } else {
    console.log('? Hasil tidak jelas. Periksa manual.');
  }
})();
