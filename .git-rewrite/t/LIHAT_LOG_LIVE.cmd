@echo off
chcp 65001 >nul
title LIVE MONITOR - CLIPPER VPS LOGS
color 0A

set "VPS_HOST=REDACTED_IP"
set "VPS_PORT=REDACTED_PORT"
set "VPS_USER=ubuntu"

if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="VPS_HOST" set "VPS_HOST=%%B"
    if "%%A"=="VPS_PORT" set "VPS_PORT=%%B"
    if "%%A"=="VPS_USER" set "VPS_USER=%%B"
  )
) else if exist "server\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("server\.env") do (
    if "%%A"=="VPS_HOST" set "VPS_HOST=%%B"
    if "%%A"=="VPS_PORT" set "VPS_PORT=%%B"
    if "%%A"=="VPS_USER" set "VPS_USER=%%B"
  )
)

echo =====================================================================
echo 📋 MENAMPILKAN LOG REAL-TIME DARI SERVER VPS (%VPS_HOST%:%VPS_PORT%)
echo Tekan Ctrl+C untuk berhenti melihat log.
echo =====================================================================
echo.
ssh -t -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "pm2 logs clipper"
pause
