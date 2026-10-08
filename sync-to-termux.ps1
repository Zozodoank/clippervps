#requires -Version 5
<#
  sync-to-termux.ps1  —  PUSH riwayat job + video dari PC ke Termux (arah: PC -> Termux).

  Prasyarat:
    - Di Termux sudah dijalankan:  bash syn.sh   (menyalakan sshd port 8022 + stop pm2).
    - 'sync.config.json' sudah diisi (termuxIp + termuxUser dari syn.sh).
      Jika belum ada, skrip ini otomatis menyalin dari 'sync.config.example.json'.
    - Windows punya OpenSSH client (ssh + scp). Cek:  Get-Command ssh, scp

  Alur: checkpoint WAL -> stop server PC -> stop pm2 Termux -> scp jobs.db + output/ -> restart pm2 Termux.
#>
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition

# --- Muat / siapkan konfigurasi ---
$cfgPath   = Join-Path $RepoRoot 'sync.config.json'
$example   = Join-Path $RepoRoot 'sync.config.example.json'
if (-not (Test-Path $cfgPath)) {
  if (Test-Path $example) {
    Copy-Item $example $cfgPath
    Write-Host "⚠️  'sync.config.json' belum ada -> dibuat dari contoh. ISI termuxIp & termuxUser lalu jalankan ulang." -ForegroundColor Yellow
  } else {
    Write-Host "❌ Tidak menemukan sync.config.json maupun sync.config.example.json." -ForegroundColor Red
    exit 1
  }
}
$Config = Get-Content $cfgPath -Raw | ConvertFrom-Json

$ip    = "$($Config.termuxIp)".Trim()
$user  = "$($Config.termuxUser)".Trim()
$port  = if ($Config.termuxPort) { "$($Config.termuxPort)" } else { '8022' }
$rel   = "$($Config.remoteProjectRelPath)".Trim().Trim('/')
if (-not $rel) { $rel = 'clipperVPS/server' }
$dest  = "$user@$ip"

if ([string]::IsNullOrWhiteSpace($ip) -or $ip -eq '192.168.0.0') {
  Write-Host "❌ Isi 'termuxIp' (dan 'termuxUser') di sync.config.json. Nilainya dicetak oleh 'syn.sh' di Termux." -ForegroundColor Red
  exit 1
}
if ([string]::IsNullOrWhiteSpace($user) -or $user -eq 'u0_a000') {
  Write-Host "❌ Isi 'termuxUser' di sync.config.json (hasil 'whoami' di Termux, biasanya 'u0_aNNN')." -ForegroundColor Red
  exit 1
}

# Bangun argumen ssh/scp (opsional kunci privat).
$sshArgs = @('-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-p',$port)
$scpArgs = @('-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-P',$port)
if ($Config.sshKeyPath) { $sshArgs += @('-i',"$Config.sshKeyPath"); $scpArgs += @('-i',"$Config.sshKeyPath") }

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "🔄 Sinkron riwayat job:  PC  ->  Termux ($dest : $port)" -ForegroundColor Cyan
Write-Host "   Remote project: $rel" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor Cyan

try {
  # [1/6] Stop server ClipperVPS lokal (dev-runner/server.js) supaya tidak ada write baru saat menyalin.
  Write-Host "`n[1/6] Menghentikan server lokal (node dev-runner/server.js)..." -ForegroundColor Yellow
  $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'dev-runner\.js' -or $_.CommandLine -match 'server[\\/]+server\.js'
  }
  if ($nodeProcs) {
    foreach ($p in $nodeProcs) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "   stopped PID $($p.ProcessId)" -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 2
  } else {
    Write-Host "   (tidak ada proses server node yang berjalan - lanjut)" -ForegroundColor DarkGray
  }

  # [2/6] Checkpoint WAL jobs.db agar file db self-contained & aman disalin (protokol keamanan DB).
  Write-Host "[2/6] Meng-flush WAL jobs.db (PRAGMA wal_checkpoint TRUNCATE)..." -ForegroundColor Yellow
  Push-Location (Join-Path $RepoRoot 'server')
  try {
    & node -e "const D=require('better-sqlite3');const db=new D('./jobs.db');db.pragma('journal_mode = WAL');db.pragma('wal_checkpoint(TRUNCATE)');db.close();console.log('   checkpoint OK');"
    if ($LASTEXITCODE -ne 0) { throw "checkpoint node gagal (exit $LASTEXITCODE). Pastikan better-sqlite3 terinstall di server/node_modules." }
  } finally { Pop-Location }

  # [3/6] Pastikan pm2 Termux distop (jaga-jaga bila syn.sh belum dijalankan).
  Write-Host "[3/6] Memastikan service Termux distop (pm2 stop clipper, delete old Gatekeeper, save PM2)..." -ForegroundColor Yellow
  & ssh @sshArgs $dest "bash -lc 'if command -v pm2 >/dev/null; then pm2 stop clipper >/dev/null 2>&1 || true; pm2 delete gatekeeper >/dev/null 2>&1 || true; pm2 save >/dev/null 2>&1 || true; fi'"

  # [4/6] Salin jobs.db + folder output (video hasil) ke Termux.
  Write-Host "[4/6] Menyalin jobs.db + video output ke Termux..." -ForegroundColor Yellow
  $jobsDb = Join-Path $RepoRoot 'server\jobs.db'
  if (-not (Test-Path $jobsDb)) { throw "jobs.db tidak ditemukan di $jobsDb" }
  & scp @scpArgs $jobsDb "${dest}:${rel}/jobs.db"
  if ($LASTEXITCODE -ne 0) { throw "scp jobs.db gagal (periksa koneksi/IP/password)." }
  Write-Host "   ✅ jobs.db terkirim" -ForegroundColor DarkGray

  $outDir = Join-Path $RepoRoot 'server\output'
  if (Test-Path $outDir) {
    $mp4s = @(Get-ChildItem $outDir -Filter *.mp4 -File -ErrorAction SilentlyContinue)
    if ($mp4s.Count -gt 0) {
      Write-Host "   mengirim $($mp4s.Count) video output..." -ForegroundColor DarkGray
      & scp @scpArgs -r $outDir "${dest}:${rel}/"
      if ($LASTEXITCODE -ne 0) { throw "scp folder output gagal." }
      Write-Host "   ✅ folder output terkirim (merge)" -ForegroundColor DarkGray
    } else {
      Write-Host "   (tidak ada .mp4 di server/output - dilewati)" -ForegroundColor DarkGray
    }
  }

  # [5/6] Hapus proses Gatekeeper lama dan restart hanya Clipper.
  Write-Host "[5/6] Menghapus proses Gatekeeper lama dan merestart Clipper..." -ForegroundColor Yellow
  & ssh @sshArgs $dest "bash -lc 'if command -v pm2 >/dev/null; then pm2 delete gatekeeper >/dev/null 2>&1 || true; pm2 restart clipper >/dev/null 2>&1 || true; pm2 save >/dev/null 2>&1 || true; fi'"


  Write-Host "`n======================================================" -ForegroundColor Green
  Write-Host "✅ SELESAI. Riwayat job + video PC sekarang sama di Termux." -ForegroundColor Green
  Write-Host "======================================================" -ForegroundColor Green

  # Opsional: nyalakan kembali server lokal.
  if ($Config.restartLocalServerAfterSync) {
    Write-Host "`n🔁 Menyalakan kembali server lokal (npm run dev) di jendela baru..." -ForegroundColor Yellow
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','npm run dev' -WorkingDirectory $RepoRoot
  } else {
    Write-Host "`nℹ️  Server lokal masih distop. Jalankan 'npm run dev' bila ingin lanjut di PC." -ForegroundColor DarkGray
  }
}
catch {
  Write-Host "`n❌ GAGAL: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "   Cek: (a) Termux 'syn.sh' sudah jalan? (b) IP/user di sync.config.json benar? (c) sshd port $port aktif?" -ForegroundColor Yellow
  exit 1
}
