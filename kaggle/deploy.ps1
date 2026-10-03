# ============================================================================
# Deploy worker oracle ke Kaggle lewat CLI (cara termudah yang kami pilih).
#
# Kenapa CLI dan bukan copy-paste di UI:
#   - push = Kaggle langsung menjalankan versi baru (tidak perlu tekan Run);
#   - bisa diulang tiap kali kaggle/vlm_oracle_qwen.py berubah;
#   - log eksekusi bisa ditarik ke PC dengan -Logs (UI hanya menampilkan di browser);
#   - kredensial dibaca dari repo (server/.env / kaggle.json), tidak ada file rahasia
#     yang perlu ditaruh manual di ~/.kaggle.
#
# Masalah yang diselesaikan -TunnelUrl: metadata kernel Kaggle TIDAK bisa memuat
# env var, padahal URL quick-cloudflare Anda berganti setiap server restart. Kalau
# harus lewat UI, oracle mati tiap hari. Solusi: URL + token di-upload sebagai
# DATASET PRIVAT kecil (bisa lewat CLI), dan kernel meng-attach dataset itu.
# Script worker membaca oracle_config.json dari /kaggle/input/... (env var tetap
# menang bila Anda mengisinya, jadi kedua jalur tersedia).
#
# Pakai:
#   # sekali jalan (cek kredensial + staging, tidak mengirim apa pun):
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -NoPush
#
#   # upload URL tunnel + token ke dataset konfigurasi, lalu push kernel:
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -TunnelUrl https://abc-123.trycloudflare.com -WithToken
#
#   # hanya menarik log sesi Kaggle yang terakhir:
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -Logs -NoPush
#
# Nilai rahasia tidak pernah dicetak ke terminal maupun masuk git (staging di
# kaggle/.deploy* yang sudah di-gitignore).
# ============================================================================
param(
    [switch]$Logs,
    [switch]$NoPush,
    [switch]$WithToken,
    [switch]$FromTermux,
    [string]$TunnelUrl = '',
    [string]$KernelSlug = 'clippervps-vlm-oracle',
    [string]$ConfigSlug = 'clippervps-oracle-config',
    [string]$LogDir = 'scratch/kaggle_out'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot            # kaggle/ -> root repo
$stageDir = Join-Path $PSScriptRoot '.deploy'           # kernel staging (gitignored)
$cfgDir = Join-Path $PSScriptRoot '.deploy-config'      # dataset staging (gitignored)
$scriptFile = Join-Path $PSScriptRoot 'vlm_oracle_qwen.py'
$metaTemplate = Join-Path $PSScriptRoot 'kernel-metadata.example.json'
$credFile = Join-Path $repoRoot 'kaggle.json'
$dotenv = Join-Path $repoRoot 'server\.env'

function Read-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return '' }
    $line = Select-String -Path $Path -Pattern ("^{0}=(.+)$" -f $Key) | Select-Object -First 1
    if (-not $line) { return '' }
    return $line.Matches[0].Groups[1].Value.Trim()
}

# --- 1. Kredensial Kaggle ----------------------------------------------------
# Prioritas: KAGGLE_API_TOKEN (personal access token 'KGAT_...') lalu username+key
# dari kaggle.json. CLI v2 menerima keduanya sebagai env var.
$apiToken = Read-EnvValue $dotenv 'KAGGLE_API_TOKEN'
$user = ''
$key = ''
if (Test-Path $credFile) {
    $cred = (Get-Content $credFile -Raw | ConvertFrom-Json)
    $user = [string]$cred.username
    $key = [string]$cred.key
}
if ($apiToken) {
    $env:KAGGLE_API_TOKEN = $apiToken
    Write-Host "Kredensial: KAGGLE_API_TOKEN dari server/.env (token tidak ditampilkan)."
}
if ($user -and $key) {
    $env:KAGGLE_USERNAME = $user
    $env:KAGGLE_KEY = $key
    if (-not $apiToken) { Write-Host "Kredensial: kaggle.json user '$user' (key tidak ditampilkan)." }
}
if (-not $apiToken -and -not ($user -and $key)) {
    throw "Tidak ada kredensial Kaggle. Isi KAGGLE_API_TOKEN di server/.env atau taruh kaggle.json (username+key) di $repoRoot (Kaggle > Account > Create API Token; file ini sudah di-gitignore)."
}
if (-not $user -and (Test-Path $credFile)) { $user = $cred.username }
if (-not $user) {
    # Nama user dibutuhkan untuk ref kernel/dataset. Ambil dari config CLI bila ada.
    Write-Host 'Username tidak ada di kaggle.json; mencoba membaca dari konfigurasi CLI...'
    $cfgView = & python -m kaggle config view 2>&1 | Out-String
    $m = [regex]::Match($cfgView, 'username:\s*(\S+)')
    if ($m.Success) { $user = $m.Groups[1].Value }
}
if (-not $user) { throw 'Username Kaggle tidak bisa ditentukan; perbaiki kaggle.json (field username).' }
Write-Host "User Kaggle : $user"

# --- 2. Deteksi CLI + python -------------------------------------------------
$Py = $null
foreach ($cand in @('python', 'py', 'python3')) {
    try {
        & $cand --version 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $Py = $cand; break }
    } catch { }
}
function Invoke-Kaggle([array]$KaggleArgs) {
    if ($script:Py) { return & $script:Py -m kaggle @KaggleArgs 2>&1 }
    return & kaggle @KaggleArgs 2>&1
}
$ver = Invoke-Kaggle @('kernels', '--help')
if ($LASTEXITCODE -ne 0 -or -not $ver) {
    $hint = if ($Py) { "$Py -m pip install --user --upgrade kaggle" } else { 'pip install --user --upgrade kaggle' }
    throw "Kaggle CLI belum terpasang. Pasang dengan: $hint"
}
Write-Host "Kaggle CLI  : tersedia ($([string](($ver | Select-Object -First 1) -replace '\s+', ' ')))"

# --- 3. Dataset konfigurasi (URL tunnel + token), kalau diminta --------------
$configRef = ''
$refMarker = Join-Path $stageDir '.config-dataset-ref'
if (Test-Path $refMarker) { $configRef = (Get-Content $refMarker -Raw).Trim() }

# -FromTermux: ambil URL tunnel + token LANGSUNG dari .env perangkat yang menjalankan
# server. Yang authoritative ada di sana (Termux-lah yang menyalakan cloudflared),
# dan quick-tunnel berganti nama tiap restart -> menyalin manual adalah sumber bug.
$remoteToken = ''
$remoteUrl = ''
if ($FromTermux) {
    $syncCfg = Join-Path $repoRoot 'sync.config.json'
    if (-not (Test-Path $syncCfg)) { throw '-FromTermux butuh sync.config.json (termuxIp/termuxUser/termuxPort) seperti yang dipakai sync-to-termux.ps1.' }
    $tc = Get-Content $syncCfg -Raw | ConvertFrom-Json
    if (-not $tc.termuxIp -or -not $tc.termuxUser) { throw 'Isi termuxIp + termuxUser di sync.config.json (keduanya dicetak oleh syn.sh di Termux).' }
    $sshArgs = @('-p', [string]$tc.termuxPort, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new')
    if ($tc.sshKeyPath -and (Test-Path [string]$tc.sshKeyPath)) { $sshArgs += @('-i', [string]$tc.sshKeyPath) }
    $remoteEnv = "/root/clippervps/server/.env"
    $sshArgs += @("$($tc.termuxUser)@$($tc.termuxIp)", "proot-distro run ubuntu -- grep -E '^(API_ACCESS_TOKEN|CLOUDFLARE_TUNNEL_URL)=' $remoteEnv")
    Write-Host "Mengambil URL tunnel + token dari Termux ($($tc.termuxUser)@$($tc.termuxIp):$($tc.termuxPort))..."
    $remoteOut = (& ssh @sshArgs 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $remoteOut) {
        throw "SSH ke Termux gagal (exit $LASTEXITCODE). Jalankan 'bash syn.sh' di Termux lalu ulangi; atau pakai -TunnelUrl ... -WithToken manual."
    }
    if ($remoteOut -match '(?m)^CLOUDFLARE_TUNNEL_URL=(.+)$') { $remoteUrl = $Matches[1].Trim() }
    if ($remoteOut -match '(?m)^API_ACCESS_TOKEN=(.+)$') { $remoteToken = $Matches[1].Trim() }
    if (-not $TunnelUrl -and $remoteUrl) { $TunnelUrl = $remoteUrl }
    if ($remoteUrl) { Write-Host "URL tunnel Termux : $remoteUrl" }
    Write-Host "Token Termux      : $(if ($remoteToken) { "ditemukan ($($remoteToken.Length) karakter, tidak ditampilkan)" } else { 'KOSONG - oracle akan menolak melayani (503)' })"
    if (-not $WithToken -and $remoteToken) { $WithToken = $true }
}

if ($TunnelUrl) {
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $cfgObj = [ordered]@{ base_url = $TunnelUrl.TrimEnd('/') }
    if ($WithToken) {
        $srvToken = if ($remoteToken) { $remoteToken } else { Read-EnvValue $dotenv 'API_ACCESS_TOKEN' }
        if (-not $srvToken) {
            throw "-WithToken diminta tapi API_ACCESS_TOKEN tidak ada di server/.env maupun Termux. Set token di perangkat yang menjalankan server (Termux sudah punya), lalu ulangi."
        }
        $cfgObj['api_access_token'] = $srvToken
        Write-Host "Token server disertakan ke konfigurasi (panjang $($srvToken.Length), nilai tidak ditampilkan)."
    } else {
        Write-Host 'CATATAN: token tidak disertakan -> notebook harus mendapat API_ACCESS_TOKEN dari env var Kaggle.'
    }
    ($cfgObj | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $cfgDir 'oracle_config.json') -Encoding ascii
    Write-Host "base_url   : $($cfgObj.base_url)"

    $cfgDatasetId = "$user/$ConfigSlug"
    $dsMeta = [ordered]@{
        title        = 'ClipperVPS Oracle Config'
        id           = $cfgDatasetId
        isPrivate    = $true
        description  = 'URL tunnel + token untuk worker VLM oracle. Berisi rahasia - jangan di-share.'
        keywords     = 'clippervps, oracle, config'
    }
    ($dsMeta | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $cfgDir 'dataset-metadata.json') -Encoding ascii

    Write-Host 'Meng-upload dataset konfigurasi...'
    Invoke-Kaggle @('datasets', 'version', '-p', $cfgDir, '-q', '-m', 'perbarui URL tunnel/token') | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        # Dataset belum pernah ada -> create dulu (version gagal untuk ref asing).
        Write-Host 'Dataset belum ada; membuat baru...'
        Invoke-Kaggle @('datasets', 'create', '-p', $cfgDir, '-q') | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw 'Upload dataset konfigurasi gagal (lihat pesan di atas).' }
    }
    $configRef = $cfgDatasetId
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Set-Content -Path $refMarker -Value $configRef -Encoding ascii
    Write-Host "Dataset konfigurasi siap: $configRef"
} elseif ($configRef) {
    Write-Host "Dataset konfigurasi yang sudah ada akan dipakai: $configRef"
}

# --- 4. Staging kernel + metadata dengan id asli -----------------------------
if (-not (Test-Path $scriptFile)) { throw "Script worker tidak ditemukan: $scriptFile" }
if (-not (Test-Path $metaTemplate)) { throw "Template metadata tidak ditemukan: $metaTemplate" }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
Copy-Item $scriptFile $stageDir -Force

$meta = Get-Content $metaTemplate -Raw | ConvertFrom-Json
$meta.id = "$user/$KernelSlug"
if ($configRef) {
    $meta.dataset_sources = @($configRef)
} else {
    $meta.dataset_sources = @()
}
($meta | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $stageDir 'kernel-metadata.json') -Encoding ascii
Write-Host "Kernel      : $($meta.id) | GPU=$($meta.enable_gpu) shape=$($meta.machine_shape) internet=$($meta.enable_internet)"
Write-Host "Staging     : $stageDir"

if ($NoPush) { Write-Host 'NoPush: staging selesai, kernel tidak dikirim (tidak ada sesi GPU baru).'; return }

# --- 5. Push (Kaggle langsung menjalankan versi baru) ------------------------
$push = Invoke-Kaggle @('kernels', 'push', '-p', $stageDir, '-q')
$push | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
    throw "kaggle kernels push gagal (exit $LASTEXITCODE). Penyebab umum: enable_internet butuh akun terverifikasi, dataset source tidak ada, atau id kernel dipakai orang lain."
}
Write-Host ''
Write-Host "Kernel dijalankan Kaggle. Cek progres: python -m kaggle kernels status $($meta.id)"

# --- 6. Status + log ---------------------------------------------------------
Start-Sleep -Seconds 10
Invoke-Kaggle @('kernels', 'status', $meta.id, '-q') | ForEach-Object { Write-Host $_ }

if ($Logs) {
    $absLog = if ([System.IO.Path]::IsPathRooted($LogDir)) { $LogDir } else { Join-Path $repoRoot $LogDir }
    New-Item -ItemType Directory -Force -Path $absLog | Out-Null
    Invoke-Kaggle @('kernels', 'output', $meta.id, '-p', $absLog, '-q') | ForEach-Object { Write-Host $_ }
    Write-Host "Log/hasil eksekusi di: $absLog"
}
