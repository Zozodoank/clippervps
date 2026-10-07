$ErrorActionPreference = 'Stop'

$gatekeeperDir = $PSScriptRoot
$venvPython = Join-Path $gatekeeperDir '.venv\Scripts\python.exe'
$requirements = Join-Path $gatekeeperDir 'requirements-runtime.txt'
$downloader = Join-Path $gatekeeperDir 'download_models.py'

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host '[Gatekeeper] Creating isolated Python environment...'
    & py -3 -m venv (Join-Path $gatekeeperDir '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Gatekeeper Python environment.' }
}

$env:PYTHONIOENCODING = 'utf-8'
Write-Host '[Gatekeeper] Installing Windows runtime packages...'
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not update pip in the Gatekeeper environment.' }
& $venvPython -m pip install --only-binary=:all: -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Gatekeeper runtime packages.' }

Write-Host '[Gatekeeper] Downloading detector and classifier models...'
& $venvPython $downloader
if ($LASTEXITCODE -ne 0) { throw 'Could not download all required Gatekeeper models.' }

$vcRuntimeMissing = @('msvcp140_1.dll', 'vcruntime140_1.dll') | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path (Join-Path $env:WINDIR 'System32') $_))
}
if ($vcRuntimeMissing) {
    Write-Host ('ONNX Runtime needs the Microsoft Visual C++ 2019 runtime. Missing: ' + ($vcRuntimeMissing -join ', ') + '. Install the latest supported x64 Redistributable from https://aka.ms/vc14/vc_redist.x64.exe, then rerun this script.') -ForegroundColor Red
    exit 1
}

& $venvPython -c "import cv2, numpy, onnxruntime; print('Gatekeeper runtime ready:', cv2.__version__, numpy.__version__, onnxruntime.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'Gatekeeper Python runtime import check failed.' }

Write-Host 'Gatekeeper setup is ready. dev-runner.js will use this environment.'
