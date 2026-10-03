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
#   # HANYA KAGGLE_API_TOKEN (tanpa kaggle.json): wajib isi -KaggleUser agar kernel id terbentuk:
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -KaggleUser nama_user_kaggle -TunnelUrl ... -WithToken
#
#   # VALIDASI SAMBUNGAN TANPA MEMBAKAR KUOTA MODEL (dry-run + sesi dipotong 5 menit):
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -FromTermux -NoModel -RunTimeoutSec 300 -Logs
#
#   # JALANKAN DARI BOBOT YANG SUDAH ADA DI KAGGLE (tanpa unduh Hugging Face tiap sesi):
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -FromTermux -RunTimeoutSec 900 `
#     -ModelSource qwen-lm/qwen2.5-vl/transformers/3b-instruct/2
#
#   # hanya menarik log sesi Kaggle yang terakhir:
#   powershell -ExecutionPolicy Bypass -File kaggle\deploy.ps1 -Logs -NoPush
#
# -NoModel menulis ORACLE_NO_MODEL=1 ke oracle_config.json (worker membacanya lewat
# kanal dataset, karena env var Kaggle hanya bisa diisi dari UI). Sesi NO_MODEL tetap
# memegang GPU sambil looping, jadi SELALU pakai -RunTimeoutSec saat dry-run.
#
# Nilai rahasia tidak pernah dicetak ke terminal maupun masuk git (staging di
# kaggle/.deploy* yang sudah di-gitignore).
# ============================================================================
param(
    [switch]$Logs,
    [switch]$NoPush,
    [switch]$WithToken,
    [switch]$FromTermux,
    [switch]$NoModel,
    [switch]$AllowCpu,
    [int]$RunTimeoutSec = 0,
    [string]$TunnelUrl = '',
    [string]$ModelSource = '',
    [string]$ModelMount = '',
    [string]$KernelSlug = 'clippervps-vlm-oracle',
    [string]$ConfigSlug = 'clippervps-oracle-config',
    [string]$LogDir = 'scratch/kaggle_out',
    # Opsional: isi bila hanya KAGGLE_API_TOKEN dipakai tanpa kaggle.json.
    # Tanpa ini, $user diambil dari kaggle.json atau `kaggle config view`.
    # Bila keduanya kosong dan -KaggleUser tidak diisi, script berhenti dengan error.
    [string]$KaggleUser = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot            # kaggle/ -> root repo
$stageDir = Join-Path $PSScriptRoot '.deploy'           # kernel staging (gitignored)
$cfgDir = Join-Path $PSScriptRoot '.deploy-config'      # dataset staging (gitignored)
$scriptFile = Join-Path $PSScriptRoot 'vlm_oracle_qwen.py'
$metaTemplate = Join-Path $PSScriptRoot 'kernel-metadata.example.json'
$credFile = Join-Path $repoRoot 'kaggle.json'
$dotenv = Join-Path $repoRoot 'server\.env'
$srcMarker = Join-Path $PSScriptRoot '.deploy\.model-source'   # agar -ModelSource cukup diisi sekali

function Read-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return '' }
    $line = Select-String -Path $Path -Pattern ("^{0}=(.+)$" -f $Key) | Select-Object -First 1
    if (-not $line) { return '' }
    return $line.Matches[0].Groups[1].Value.Trim()
}

function Split-ModelSource([string]$s) {
    # Bentuk resmi Kaggle: <owner>/<model>/<framework>/<instance>[/<versi>], sama dengan
    # URL model di situs Kaggle. Versi default 1; menyebutkan angka eksplisit lebih baik
    # karena "versi terbaru" membuat bobot yang divonis bisa berubah tanpa Anda sadari.
    $parts = @($s.Trim('/').Split('/') | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 4) {
        throw "ModelSource harus '<owner>/<model>/<framework>/<instance>[/<versi>]', contoh: qwen-lm/qwen2.5-vl/transformers/3b-instruct/2"
    }
    $rev = if ($parts.Count -ge 5) { $parts[4] } else { '1' }
    return [pscustomobject]@{ model = "$($parts[0])/$($parts[1])"; framework = $parts[2]; instance = $parts[3]; revision = $rev }
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
if (-not $user -and $KaggleUser) {
    # Fallback eksplisit: pengguna yang hanya mengisi KAGGLE_API_TOKEN di server/.env
    # (tanpa kaggle.json) bisa menyediakan username lewat -KaggleUser agar kernel id
    # terbentuk dengan benar ('<user>/clippervps-vlm-oracle'). Tanpa ini, script gagal
    # dengan error samar karena $meta.id = '/clippervps-vlm-oracle' (tanpa prefix).
    $user = $KaggleUser
    Write-Host "Username dari -KaggleUser: $user"
}
if (-not $user) {
    # Nama user dibutuhkan untuk ref kernel/dataset. Ambil dari config CLI bila ada.
    Write-Host 'Username tidak ada di kaggle.json; mencoba membaca dari konfigurasi CLI...'
    $cfgView = & python -m kaggle config view 2>&1 | Out-String
    $m = [regex]::Match($cfgView, 'username:\s*(\S+)')
    if ($m.Success) { $user = $m.Groups[1].Value }
}
if (-not $user) { throw 'Username Kaggle tidak bisa ditentukan. Opsi: (1) sediakan kaggle.json dengan field username, (2) isi ~/.kaggle/kaggle.json, atau (3) pakai parameter -KaggleUser <nama_user>.' }
Write-Host "User Kaggle : $user"

# --- 2. Deteksi CLI + python -------------------------------------------------
$Py = $null
foreach ($cand in @('python', 'py', 'python3')) {
    try {
        if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
        & $cand --version 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $Py = $cand; break }
    } catch { }
}
function Invoke-Kaggle([array]$KaggleArgs) {
    # PENTING: $ErrorActionPreference='Stop' membuat stderr dari perintah NATIVE (python -m kaggle
    # menulis progress/error ke stderr) berubah jadi terminating error, sehingga fallback
    # "datasets version gagal -> datasets create" tidak pernah jalan. Turunkan preferensi lokal,
    # stringify keluaran, dan simpan exit code sendiri supaya pemanggil punya nilai yang akurat.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $script:KaggleExit = 1
    $lines = @()
    try {
        if ($script:Py) { $raw = & $script:Py -m kaggle @KaggleArgs 2>&1 }
        else { $raw = & kaggle @KaggleArgs 2>&1 }
        $script:KaggleExit = $LASTEXITCODE
        # stderr datang sebagai ErrorRecord; stdout sebagai string. Normalisasi keduanya.
        $lines = @($raw | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        } | Where-Object { $_ -and $_.Trim() -ne '' })
    } catch {
        # CLI tidak ditemukan sama sekali -> biarkan caller mencetak pesan pemasangan,
        # bukan CommandNotFoundException yang membingungkan.
        $script:KaggleExit = 127
        $lines = @("Invoke-Kaggle: $($_.Exception.Message)")
    } finally {
        $ErrorActionPreference = $prev
    }
    return $lines
}
function Save-KaggleLog([string]$KernelId, [string]$DestDir) {
    # 'kernels logs' = log sesi TERAKHIR dan tersedia bahkan saat sesi masih berjalan;
    # 'kernels output' baru berisi sesuatu setelah sesi selesai. Jadi logs dulu, output
    # hanya sebagai cadangan.
    $abs = if ([System.IO.Path]::IsPathRooted($DestDir)) { $DestDir } else { Join-Path $repoRoot $DestDir }
    New-Item -ItemType Directory -Force -Path $abs | Out-Null
    $raw = Invoke-Kaggle @('kernels', 'logs', $KernelId)
    if ($script:KaggleExit -eq 0 -and $raw) {
        $txt = ($raw -join "`n")
        $parsed = $null
        try { $parsed = ($txt | ConvertFrom-Json) } catch { $parsed = $null }
        if ($parsed) {
            ($parsed | ForEach-Object { $_.data -replace "`r?`n", '' }) -join "`n" |
                Set-Content -Path (Join-Path $abs 'session.log') -Encoding utf8
        } else {
            $txt | Set-Content -Path (Join-Path $abs 'session.log') -Encoding utf8
        }
        Write-Host "Log sesi terakhir tersimpan di: $(Join-Path $abs 'session.log')"
        return
    }
    Write-Host "'kernels logs' belum memberi hasil (exit $script:KaggleExit); mencoba 'kernels output'..."
    Invoke-Kaggle @('kernels', 'output', $KernelId, '-p', $abs) | ForEach-Object { Write-Host $_ }
    Write-Host "Log/hasil eksekusi di: $abs"
}
$ver = Invoke-Kaggle @('kernels', '--help')
if ($script:KaggleExit -ne 0 -or -not $ver) {
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
    if ($NoModel) {
        # Dry-run: worker memuat tanpa bobot model. Ini TIDAK bisa dikirim lewat env var
        # Kaggle tanpa UI, jadi kanal dataset yang dipakai.
        $cfgObj['ORACLE_NO_MODEL'] = '1'
        Write-Host 'Mode DRY-RUN: ORACLE_NO_MODEL=1 ditulis ke konfigurasi (model tidak dimuat).'
        if ($RunTimeoutSec -le 0) {
            Write-Warning '-NoModel tanpa -RunTimeoutSec: sesi dry-run akan looping sampai 690 menit sambil memegang GPU. Tambahkan -RunTimeoutSec 300.'
        }
    }
    if ($RunTimeoutSec -gt 0) {
        # Kaggle punya --timeout sendiri, tapi sesi tetap bisa bertahan jauh melampaui
        # angka itu (teramati: sesi dry-run -t 1200 masih RUNNING setelah 25 menit) - dan
        # setiap menit di atas GPU dipotong dari kuota mingguan Anda. Jadi batas waktu
        # juga ditulis ke konfigurasi supaya worker berhenti sendiri (ORACLE_MAX_MINUTES).
        $maxMinutes = [Math]::Max(5, [Math]::Floor($RunTimeoutSec / 60) - 2)
        $cfgObj['ORACLE_MAX_MINUTES'] = [string]$maxMinutes
        Write-Host "Batas diri worker: ORACLE_MAX_MINUTES=$maxMinutes (berhenti sebelum Kaggle memotong)."
    }
    # Path bobot lokal di dalam sesi (mount model/dataset). Worker juga mengenali mount
    # otomatis, jadi ini hanya untuk kasus path-nya tidak biasa.
    if ($ModelMount) {
        $cfgObj['ORACLE_MODEL_MOUNT'] = $ModelMount
        Write-Host "ORACLE_MODEL_MOUNT=$ModelMount (bobot dibaca dari disk sesi, tanpa unduh HF)."
    }
    if ($AllowCpu) {
        # Buka-bukaan: default worker MENOLAK jalan tanpa CUDA. Ini menyalakannya untuk debug.
        $cfgObj['ORACLE_REQUIRE_GPU'] = '0'
        Write-Warning 'ORACLE_REQUIRE_GPU=0: sesi boleh berjalan di CPU. Itu belasan kali lebih lambat dan tetap memotong kuota GPU - jangan dibiarkan menyala.'
    }
    # HF_TOKEN hanya mempercepat unduhan (beberapa sesi kena rate limit/429 dari jaringan
    # Kaggle). Diambil dari server/.env, ikut ke dataset PRIVAT yang sama dengan token API,
    # dan tidak pernah dicetak.
    $hfToken = Read-EnvValue $dotenv 'HF_TOKEN'
    if ($hfToken) {
        $cfgObj['HF_TOKEN'] = $hfToken
        Write-Host "HF_TOKEN disertakan ke konfigurasi (panjang $($hfToken.Length), nilai tidak ditampilkan)."
    }
    ($cfgObj | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $cfgDir 'oracle_config.json') -Encoding ascii
    Write-Host "base_url   : $($cfgObj.base_url)"

    $cfgDatasetId = "$user/$ConfigSlug"
    # Bentuk metadata dataset CLI v2: `keywords` dipetakan ke category_ids dan HARUS list
    # (string tunggal -> TypeError: category_ids must be of type list), dan `create`
    # menolak tanpa `licenses` ("Key licenses not found in data").
    $dsMeta = [ordered]@{
        title        = 'ClipperVPS Oracle Config'
        id           = $cfgDatasetId
        isPrivate    = $true
        description  = 'URL tunnel + token untuk worker VLM oracle. Berisi rahasia - jangan di-share.'
        keywords     = @('clippervps', 'oracle', 'config')
        licenses     = @(@{ name = 'other' })
    }
    ($dsMeta | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $cfgDir 'dataset-metadata.json') -Encoding ascii

    Write-Host 'Meng-upload dataset konfigurasi...'
    Invoke-Kaggle @('datasets', 'version', '-p', $cfgDir, '-q', '-m', 'perbarui URL tunnel/token') | ForEach-Object { Write-Host $_ }
    if ($script:KaggleExit -ne 0) {
        # Dataset belum pernah ada -> create dulu (version gagal untuk ref asing).
        Write-Host 'Dataset belum ada; membuat baru...'
        Invoke-Kaggle @('datasets', 'create', '-p', $cfgDir, '-q') | ForEach-Object { Write-Host $_ }
        if ($script:KaggleExit -ne 0) { throw 'Upload dataset konfigurasi gagal (lihat pesan di atas).' }
    }
    $configRef = $cfgDatasetId
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Set-Content -Path $refMarker -Value $configRef -Encoding ascii
    Write-Host "Dataset konfigurasi siap: $configRef"
} elseif ($configRef) {
    Write-Host "Dataset konfigurasi yang sudah ada akan dipakai: $configRef"
    # Dataset TIDAK ditulis ulang bila -TunnelUrl tidak diberikan -> ORACLE_NO_MODEL dari
    # dry-run kemarin bisa ikut terpakai di sesi sungguhan tanpa Anda sadari.
    $cfgLocal = Join-Path $cfgDir 'oracle_config.json'
    if ((Test-Path $cfgLocal) -and ((Get-Content $cfgLocal -Raw) -match 'ORACLE_NO_MODEL')) {
        Write-Warning "oracle_config.json masih memuat ORACLE_NO_MODEL. Jalankan lagi dengan -TunnelUrl ... (tanpa -NoModel) untuk menimpanya sebelum uji model sungguhan."
    }
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
# model_sources: bobot yang sudah di-host Kaggle di-mount read-only ke sesi. Ini yang
# memangkas biaya terukur 2026-10-03 (22 s pip + 21 s unduh HF + 47 s muat = 86,7 s) jadi
# hampir nol. Disimpan di marker supaya push berikutnya tidak kembali ke jalur unduh HF.
if (-not $ModelSource -and (Test-Path $srcMarker)) {
    $ModelSource = (Get-Content $srcMarker -Raw).Trim()
    Write-Host "ModelSource dari push terakhir dipakai: $ModelSource"
}
if ($ModelSource) {
    $ms = Split-ModelSource $ModelSource
    # Kaggle CLI v2 menolak objek di sini: validate_model_instance_version_string() expecting
    # STRING dengan tepat 4 slash, yaitu <owner>/<model>/<framework>/<instance>/<versi>.
    # Bentuk dict ({'model':..,'instance':..}) hanya dipakai di UI - mengirimnya ke CLI memberi
    # AttributeError 'dict' object has no attribute 'count', bukan pesan yang bisa dibaca.
    $srcString = "$($ms.model)/$($ms.framework)/$($ms.instance)/$($ms.revision)"
    $meta.model_sources = @($srcString)
    Write-Host "Model source: $srcString"
} elseif (@($meta.model_sources).Count -gt 0) {
    Write-Host "Model source dari template: $(($meta.model_sources | ForEach-Object { $_ }) -join ', ')"
} else {
    Write-Host 'Model source: tidak ada -> bobot diunduh dari Hugging Face tiap sesi baru.'
}
($meta | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $stageDir 'kernel-metadata.json') -Encoding ascii
Write-Host "Kernel      : $($meta.id) | GPU=$($meta.enable_gpu) shape=$($meta.machine_shape) internet=$($meta.enable_internet)"
Write-Host "Staging     : $stageDir"

if ($Logs) { Save-KaggleLog $meta.id $LogDir }
if ($NoPush) { Write-Host 'NoPush: staging selesai, kernel tidak dikirim (tidak ada sesi GPU baru).'; return }
if ($ModelSource) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $srcMarker) | Out-Null
    Set-Content -Path $srcMarker -Value $ModelSource -Encoding ascii
}

# --- 5. Push (Kaggle langsung menjalankan versi baru) ------------------------
# Catatan: `kernels push` TIDAK menerima -q (unrecognized arguments -> exit 2), tidak
# seperti datasets/kernels output.
$pushArgs = @('kernels', 'push', '-p', $stageDir)
if ($RunTimeoutSec -gt 0) {
    # Kaggle punya --timeout sendiri, tapi TIDAK selalu ditegakkan (sesi dry-run -t 1200
    # teramati masih RUNNING setelah 25 menit). Batas yang benar-benar bekerja ditulis ke
    # dataset konfigurasi sebagai ORACLE_MAX_MINUTES (lihat langkah 3) - worker berhenti sendiri.
    $pushArgs += @('-t', [string]$RunTimeoutSec)
    Write-Host "Batas sesi kernel (Kaggle -t): $RunTimeoutSec detik - batas diri worker ada di ORACLE_MAX_MINUTES."
}
$push = Invoke-Kaggle $pushArgs
$push | ForEach-Object { Write-Host $_ }
if ($script:KaggleExit -ne 0) {
    throw "kaggle kernels push gagal (exit $script:KaggleExit). Penyebab umum: enable_internet butuh akun terverifikasi, dataset source tidak ada, atau id kernel dipakai orang lain."
}
Write-Host ''
Write-Host "Kernel dijalankan Kaggle. Cek progres: python -m kaggle kernels status $($meta.id)"

# --- 6. Status + log ---------------------------------------------------------
Start-Sleep -Seconds 10
Invoke-Kaggle @('kernels', 'status', $meta.id) | ForEach-Object { Write-Host $_ }

if ($Logs) {
    Save-KaggleLog $meta.id $LogDir
}
