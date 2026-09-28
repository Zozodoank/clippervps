# ============================================================================
# setup-whisper.ps1  —  Pasang whisper.cpp (prebuilt) + model ggml di PC Windows.
# Dipakai oleh fitur AUDIO_DRIVEN_SCENES (server/services/audioBeatService.js).
#
# Cara pakai (PowerShell, dari root repo):
#   powershell -ExecutionPolicy Bypass -File .\setup-whisper.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-whisper.ps1 -Model tiny
#
# Hasil diarahkan ke server/bin/whisper/ (sudah di-.gitignore, tak ikut commit).
# ============================================================================
param(
  # tiny | base | small | medium | large-v3  (base = keseimbangan akurasi ID vs kecepatan)
  [string]$Model = "base",
  # Tag rilis ggml-org/whisper.cpp yang punya asset binary x64 (v1.9.4 tak kirim binary).
  [string]$Tag = "b5130"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root "server\bin\whisper"
$models = Join-Path $dest "models"
$zipUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$Tag/whisper-bin-x64.zip"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path $models | Out-Null

# --- 1) Unduh & ekstrak binary prebuilt -----------------------------------
$exe = Get-ChildItem -Path $dest -Recurse -Include "whisper-cli.exe","main.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
  Write-Host "Mengunduh whisper.cpp prebuilt (x64)..." -ForegroundColor Cyan
  $tmpZip = Join-Path $env:TEMP "whisper-bin-x64.zip"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
  Write-Host "Mengekstrak ke $dest ..." -ForegroundColor Cyan
  $extractDir = Join-Path $env:TEMP "whisper_extract_$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force
  Copy-Item -Path (Join-Path $extractDir "*") -Destination $dest -Recurse -Force
  Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
  Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
  $exe = Get-ChildItem -Path $dest -Recurse -Include "whisper-cli.exe","main.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $exe) { throw "Gagal menemukan whisper-cli.exe setelah ekstraksi." }
Write-Host "OK: whisper binary  -> $($exe.FullName)" -ForegroundColor Green

# --- 2) Unduh model ggml --------------------------------------------------
$modelFile = Join-Path $models "ggml-$Model.bin"
if (-not (Test-Path $modelFile)) {
  $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
  Write-Host "Mengunduh model ggml-$Model.bin (bisa ratusan MB)..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $modelUrl -OutFile $modelFile -UseBasicParsing
}
$sizeMB = [math]::Round((Get-Item $modelFile).Length / 1MB, 1)
Write-Host "OK: model ($sizeMB MB) -> $modelFile" -ForegroundColor Green

# --- 3) Smoketest singkat -------------------------------------------------
Write-Host "Menjalankan versi cek..." -ForegroundColor Cyan
& $exe.FullName -h 2>&1 | Select-Object -First 1

Write-Host ""
Write-Host "====================================================================" -ForegroundColor Green
Write-Host " whisper.cpp siap. Set nilai ini di server/.env :" -ForegroundColor Yellow
Write-Host "   AUDIO_DRIVEN_SCENES=true"
Write-Host "   WHISPER_CPP_BIN=$($exe.FullName)"
Write-Host "   WHISPER_MODEL=$modelFile"
Write-Host "====================================================================" -ForegroundColor Green
