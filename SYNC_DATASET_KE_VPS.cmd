@echo off
chcp 65001 >nul
title SINKRONISASI DATASET KE VPS
color 0A

set "VPS_HOST=208.76.40.194"
set "VPS_PORT=14115"
set "VPS_USER=ubuntu"

echo =====================================================================
echo           📦 SINKRONISASI DATASHEET & DATASET KE SERVER VPS
echo =====================================================================
echo   IP Server : %VPS_HOST%
echo   SSH Port  : %VPS_PORT%
echo   User      : %VPS_USER%
echo =====================================================================
echo.

echo [1/3] Memeriksa file dataset lokal...
if not exist "server\gatekeeper\dataset\curated_local_6864ee_datasheet.json" (
  echo ❌ Berkas curated_local_6864ee_datasheet.json tidak ditemukan!
  pause
  exit /b 1
)

echo [2/3] Mengunggah datasheet JSON ke folder gatekeeper VPS...
scp -P %VPS_PORT% -o StrictHostKeyChecking=no server\gatekeeper\dataset\*.json %VPS_USER%@%VPS_HOST%:~/clipperVPS/server/gatekeeper/dataset/

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo ⚠️ Koneksi SCP langsung gagal (kemungkinan koneksi VPS sedang reset atau memerlukan Termux/VPN).
  echo    Alternatif: Anda dapat melakukan Git Push atau menyalin berkas saat koneksi SSH aktif.
  echo.
  pause
  exit /b %ERRORLEVEL%
)

echo.
echo [3/3] Mengunggah master dataset_v2.zip ke VPS...
scp -P %VPS_PORT% -o StrictHostKeyChecking=no server\gatekeeper\dataset_v2.zip %VPS_USER%@%VPS_HOST%:~/clipperVPS/server/gatekeeper/dataset_v2.zip

echo.
echo =====================================================================
echo ✅ SINKRONISASI DATASET KE VPS BERHASIL LENGKAP!
echo =====================================================================
pause
