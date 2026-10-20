import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Gerbang kebersihan repo: mencegah sampah yang sudah dibuang (Langkah hygiene
// 2026-10) kembali masuk lewat commit berikutnya.
//
// Semua aturan digeneralisasi (pola nama, bukan daftar nama) supaya varian baru
// seperti patch_routes_final2.py atau server/fix_baru.cjs ikut tertolak, bukan
// hanya persis file yang pernah ada.
//
// Atasan: tes ini membaca daftar file dari Git. Di checkout tanpa Git (salinan
// server/ saja, mis. harness parity WSL) atau mesin tanpa biner git, hasilnya
// SKIP dengan peringatan - bukan gagal, karena kegagalan di sana bukan bukti
// adanya sampah.
// ============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

let gitReady = false;
try {
  gitReady = git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
} catch {
  gitReady = false;
}
if (!gitReady) {
  console.warn('[repoHygiene] git tidak tersedia / bukan work tree - tes kebersihan dilewat, BUKAN lulus.');
}

const TRACKED_JUNK = [
  { re: /(^|\/)\.git-rewrite\//, why: 'sisa git filter-branch; berisi salinan penuh proyek lama (pernah 481 file ter-lacak)' },
  { re: /\.sqlite(-shm|-wal)?$/i, why: 'basis data runtime; DB produksi aktif adalah server/jobs.db (pola *.db) dan tidak boleh ikut paket' },
  { re: /\.migrated$/i, why: 'penanda migrasi sekali-pakai (jobs.json.migrated)' },
  { re: /(^|\/)patch[^/]*\.(js|cjs|mjs|py)$/i, why: 'skrip penambal string sekali-pakai; menjalankan ulang = merusak kode produksi' },
  { re: /(^|\/)fix_[^/]*\.(js|cjs|mjs|py)$/i, why: 'hotfix penulang kode produksi dengan indeks baris hardcoded (kelas bug server/fix_master.cjs)' },
  { re: /(^|\/)track\d*\.(js|cjs|mjs|py)$/i, why: 'skrip pelacak sementara era patching' },
  { re: /(^|\/)(trigger|evaluate_temp|temp_imports|replace_loop|query_jobs)\.(js|cjs|mjs|py)$/i, why: 'skrip sekali-pakai tanpa rujukan produksi' },
  { re: /_old\.(js|cjs|mjs|py)$/i, why: 'cadangan *_old.js; cadangan hidup di riwayat Git, bukan di working tree' },
  { re: /^[^/]+\.py$/, why: 'skrip Python di root repo; alat operasional menempati archive/ops/ atau server/gatekeeper/' },
];

const IGNORED_DIRS = ['scratch/', '.qoder/'];

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

describeGuardHygiene();

function describeGuardHygiene() {
  const d = gitReady ? describe : describe.skip;
  d('Kebersihan repo (anti-regresi artefak)', () => {
    it('tidak melacak artefak Git, basis data runtime, atau skrip sekali-pakai', () => {
      const hits = [];
      for (const file of trackedFiles()) {
        for (const rule of TRACKED_JUNK) {
          if (rule.re.test(file)) hits.push(`  ${file}  <- ${rule.why}`);
        }
      }
      expect(hits, `Artefak sampah kembali ter-lacak:\n${hits.join('\n')}`).toEqual([]);
    });

    it('membiarkan scratch/ dan .qoder/ tidak ter-lacak', () => {
      const tracked = trackedFiles();
      const hits = tracked.filter((f) => IGNORED_DIRS.some((dir) => f.startsWith(dir)));
      expect(
        hits,
        `Direktori kerja lokal ikut ter-lacak (padahal .gitignore sudah menutupnya):\n${hits.map((h) => `  ${h}`).join('\n')}`,
      ).toEqual([]);
    });

    it('menyimpan skrip shell dengan LF di working tree (skrip Linux tidak boleh ber-CRLF)', () => {
      // git ls-files --eol -> "i/lf    w/crlf  attr/text eol=lf\t<path>".
      // worktree CRLF pada .sh berarti baris shebang/cd ber-\r dan bash di VPS/Termux mati.
      const out = git(['ls-files', '--eol', '-z', '--', '*.sh']);
      const bad = out
        .split('\0')
        .filter(Boolean)
        .filter((rec) => /\bw\/(crlf|mixed)\b/.test(rec))
        .map((rec) => `  ${rec.split('\t').pop()}  <- ${rec.trim().split(/\s+/).slice(0, 2).join(' ')}`);
      expect(bad, `Skrip .sh punya line ending CRLF/mixed di working tree:\n${bad.join('\n')}`).toEqual([]);
    });

    it('menyimpan skrip Python yang dijalankan di VPS/Termux dengan LF di index', () => {
      // git ls-files --eol -> "i/<index>  w/<worktree>  attr/<rule>\t<path>".
      // worktree Windows boleh ber-CRLF selama index = lf (saat push/checkout
      // Linux tetap LF). Yang mematikan Termux/VPS hanyalah index yang CRLF.
      const out = git(['ls-files', '--eol', '-z', '--', '*.py']);
      const badIndex = out
        .split('\0')
        .filter(Boolean)
        .filter((rec) => /\bi\/(crlf|mixed)\b/.test(rec))
        .map((rec) => `  ${rec.split('\t').pop()}  <- ${rec.trim().split(/\s+/)[0]}`);
      expect(badIndex, `Berkas .py tersimpan dengan CRLF di index Git:\n${badIndex.join('\n')}`).toEqual([]);
    });
  });
}
