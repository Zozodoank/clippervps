import { fetchVideoMetadataAndStream, sampleFramesFromStream } from './services/videoFilterService.js';
import { downloadYouTubeVideo } from './services/downloader.js';
import fs from 'fs';
import path from 'path';

async function main() {
  const testUrl = 'https://www.youtube.com/watch?v=AQrfDmNuy3o';
  console.log('=== BENCHMARK SPEED TEST ===');
  console.log('Target Video:', testUrl);

  const t0 = Date.now();
  console.log('\n[1/3] Mengambil Metadata & Stream URL...');
  const { metadata, streamUrl } = await fetchVideoMetadataAndStream(testUrl, {
    onProgress: (p) => console.log(`  [Progress] ${p.progress}%: ${p.message}`)
  });
  const tMeta = Date.now() - t0;
  console.log(`✅ Metadata & Stream selesai dalam ${tMeta} ms (${(tMeta / 1000).toFixed(2)}s).`);
  console.log(`   Judul: ${metadata.title}`);
  console.log(`   Durasi: ${metadata.duration}s`);
  console.log(`   Stream URL: ${streamUrl ? streamUrl.slice(0, 70) + '...' : 'NONE'}`);

  const t1 = Date.now();
  console.log('\n[2/3] Sampling 12 Keyframe dari Stream (Parallel 4x)...');
  const tempFramesDir = path.resolve('temp_bench_frames');
  const sampleRes = await sampleFramesFromStream(streamUrl, tempFramesDir, {
    duration: metadata.duration,
    maxSampleFrames: 12,
    onProgress: (p) => console.log(`  [Progress] ${p.progress}%: ${p.message}`)
  });
  const tSample = Date.now() - t1;
  console.log(`✅ Sampling selesai dalam ${tSample} ms (${(tSample / 1000).toFixed(2)}s)! Frame didapat: ${sampleRes.frames.length}`);

  const t2 = Date.now();
  console.log('\n[3/3] Mengunduh Video 1080p (Capped HD, 25M rate limit, no sleep)...');
  const tempDlDir = path.resolve('temp_bench_dl');
  const dlRes = await downloadYouTubeVideo(testUrl, tempDlDir, 'bench_test', (p) => {
    console.log(`  [Download] ${p.progress}%: ${p.message}`);
  }, { quality: '1080p' });
  const tDl = Date.now() - t2;
  const stat = fs.statSync(dlRes.filePath);
  console.log(`✅ Download 1080p selesai dalam ${tDl} ms (${(tDl / 1000).toFixed(2)}s)!`);
  console.log(`   Ukuran file: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`   Kecepatan efektif: ${((stat.size / (1024 * 1024)) / (tDl / 1000)).toFixed(2)} MB/s`);

  // Cleanup temp files
  try { fs.rmSync(tempFramesDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tempDlDir, { recursive: true, force: true }); } catch {}

  console.log('\n=== TOTAL WAKTU PIPELINE HARVESTING ===');
  console.log(`Total: ${((Date.now() - t0) / 1000).toFixed(2)}s (Sebelumnya: 120s - 180s)`);
}

main().catch(err => {
  console.error('Benchmark Error:', err);
  process.exit(1);
});
