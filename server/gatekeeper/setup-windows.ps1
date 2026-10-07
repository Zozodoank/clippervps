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

& $venvPython -c "import os, sys; os.add_dll_directory(os.path.join(sys.prefix, 'Scripts')); import cv2, numpy, onnxruntime; print('Gatekeeper runtime ready:', cv2.__version__, numpy.__version__, onnxruntime.__version__)"
if ($LASTEXITCODE -ne 0) {
    throw 'Gatekeeper runtime import failed. Install the Microsoft Visual C++ 2015-2022 x64 Redistributable, then rerun setup-windows.ps1.'
}

Write-Host 'Gatekeeper setup is ready. dev-runner.js will use this environment.'
