@echo off
chcp 65001 >nul
title SINKRONISASI DATASET KE VPS
color 0A

set "VPS_HOST=REDACTED_IP"
set "VPS_PORT=REDACTED_PORT"
set "VPS_USER=ubuntu"

echo =====================================================================
echo           📦 SINKRONISASI DATASHEET & DATASET KE SERVER VPS
echo =====================================================================
echo   IP Server : %VPS_HOST%
echo   SSH Port  : %VPS_PORT%
echo   User      : %VPS_USER%
echo =====================================================================
echo.

echo [1/4] Memeriksa file dataset & model AI lokal...
if not exist "server\gatekeeper\dataset\curated_local_diverse_faces_datasheet.json" (
  echo ❌ Berkas curated_local_diverse_faces_datasheet.json tidak ditemukan!
  pause
  exit /b 1
)

echo [2/4] Mengunggah datasheet JSON ke folder gatekeeper VPS...
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
echo [3/4] Mengunggah model AI (Face, Text, Scene) ke folder models VPS...
scp -P %VPS_PORT% -o StrictHostKeyChecking=no server\gatekeeper\models\* %VPS_USER%@%VPS_HOST%:~/clipperVPS/server/gatekeeper/models/

echo.
echo [4/4] Mengunggah master dataset_v2.zip ke VPS...
scp -P %VPS_PORT% -o StrictHostKeyChecking=no server\gatekeeper\dataset_v2.zip %VPS_USER%@%VPS_HOST%:~/clipperVPS/server/gatekeeper/dataset_v2.zip

echo.
echo 🔄 Me-restart service AI Gatekeeper di VPS agar model wajah aktif...
ssh -p %VPS_PORT% -o StrictHostKeyChecking=no %VPS_USER%@%VPS_HOST% "pm2 restart gatekeeper"

echo.
echo =====================================================================
echo ✅ SINKRONISASI DATASET, DATASHEET & MODEL WAJAH KE VPS BERHASIL!
echo =====================================================================
pause
