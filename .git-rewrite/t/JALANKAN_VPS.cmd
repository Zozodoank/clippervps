@echo off
chcp 65001 >nul
title CLIPPER VPS CONTROL PANEL & MONITOR
color 0B

set "VPS_HOST=REDACTED_IP"
set "VPS_PORT=REDACTED_PORT"
set "VPS_USER=ubuntu"
set "VPS_PASSWORD=REDACTED_PASSWORD"

rem Membaca nilai dari .env atau server/.env jika ada
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="VPS_HOST" set "VPS_HOST=%%B"
    if "%%A"=="VPS_PORT" set "VPS_PORT=%%B"
    if "%%A"=="VPS_USER" set "VPS_USER=%%B"
    if "%%A"=="VPS_PASSWORD" set "VPS_PASSWORD=%%B"
  )
) else if exist "server\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("server\.env") do (
    if "%%A"=="VPS_HOST" set "VPS_HOST=%%B"
    if "%%A"=="VPS_PORT" set "VPS_PORT=%%B"
    if "%%A"=="VPS_USER" set "VPS_USER=%%B"
    if "%%A"=="VPS_PASSWORD" set "VPS_PASSWORD=%%B"
  )
)

:MENU
cls
echo =====================================================================
echo           🎬 LOCAL AI AFFILIATE CLIPPER - VPS CONTROL PANEL
echo =====================================================================
echo   IP Server : %VPS_HOST%
echo   SSH Port  : %VPS_PORT%
echo   User      : %VPS_USER%
echo   Password  : %VPS_PASSWORD%  (Sudah auto-login via SSH Key)
echo =====================================================================
echo.
echo   [1] 🚀 JALANKAN PROJECT INTERAKTIF (Live Terminal / Dev-Runner)
echo       - Melihat proses pemotongan video, AI, FFmpeg secara langsung
echo       - Otomatis membuka akses http://localhost:3000 di browser PC Anda
echo.
echo   [2] 📋 LIHAT LOG REAL-TIME BACKGROUND (PM2 Logs)
echo       - Memantau log backend / frontend yang berjalan di background
echo.
echo   [3] 🌐 LIHAT LINK AKSES PUBLIK (Cloudflare Tunnel)
echo       - Mendapatkan URL HTTPS gratis untuk akses dari HP / browser luar
echo.
echo   [4] 💻 MASUK KE TERMINAL SSH VPS (BASH Console)
echo       - Langsung masuk ke command prompt VPS Ubuntu
echo.
echo   [5] 🔄 RESTART SERVICE DI VPS (PM2 Restart)
echo.
echo   [6] 📊 CEK STATUS RESOURCE VPS (RAM, CPU, Disk)
echo.
echo   [0] ❌ KELUAR
echo.
echo =====================================================================
set /p opt="Pilih menu [1-6, 0]: "

if "%opt%"=="1" goto RUN_INTERACTIVE
if "%opt%"=="2" goto VIEW_LOGS
if "%opt%"=="3" goto GET_TUNNEL_URL
if "%opt%"=="4" goto SSH_TERMINAL
if "%opt%"=="5" goto RESTART_SERVICE
if "%opt%"=="6" goto CHECK_STATUS
if "%opt%"=="0" goto EXIT
goto MENU

:RUN_INTERACTIVE
cls
echo =====================================================================
echo 🔄 [1/2] MEMERIKSA UPDATE DARI REPOSITORY GITHUB TERBARU...
echo =====================================================================
echo.
ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "cd ~/clipperVPS && git fetch origin main && git pull origin main"
echo.
echo =====================================================================
echo 🚀 [2/2] MENJALANKAN DEV-RUNNER LIVE DI VPS...
echo =====================================================================
echo Tips:
echo 1. Port 3000 dan 5000 di-forward otomatis ke PC Anda!
echo 2. Buka browser Anda di: http://localhost:3000
echo 3. Tekan Ctrl+C untuk berhenti dan kembali ke menu.
echo =====================================================================
echo.
start "" "http://localhost:3000"
ssh -t -R 10808 -L 3000:localhost:3000 -L 5000:localhost:5000 -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "pm2 stop clipper >/dev/null 2>&1; cd ~/clipperVPS && node dev-runner.js; pm2 start clipper >/dev/null 2>&1"
echo.
echo Dev-runner dihentikan. Background service otomatis diaktifkan kembali.
pause
goto MENU

:VIEW_LOGS
cls
echo =====================================================================
echo 📋 MENAMPILKAN LOG REAL-TIME (PM2 LOGS)...
echo Tekan Ctrl+C untuk keluar dari tampilan log.
echo =====================================================================
echo.
ssh -t -R 10808 -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "pm2 logs"
pause
goto MENU

:GET_TUNNEL_URL
cls
echo =====================================================================
echo 🌐 MENGAMBIL LINK AKSES CLOUDFLARE TUNNEL DARI VPS...
echo =====================================================================
echo.
ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "pm2 logs tunnel --lines 50 --nostream | grep -o 'https://.*\.trycloudflare\.com' | tail -n 1" > "%TEMP%\vps_tunnel_url.txt"
set /p TUNNEL_URL=<"%TEMP%\vps_tunnel_url.txt"
if "%TUNNEL_URL%"=="" (
  echo Belum menemukan URL aktif. Menjalankan refresh tunnel...
  ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "pm2 restart tunnel && sleep 4 && pm2 logs tunnel --lines 40 --nostream | grep -o 'https://.*\.trycloudflare\.com' | tail -n 1" > "%TEMP%\vps_tunnel_url.txt"
  set /p TUNNEL_URL=<"%TEMP%\vps_tunnel_url.txt"
)
echo.
echo URL Akses Publik Anda:
echo =====================================================================
echo   %TUNNEL_URL%
echo =====================================================================
echo.
set /p openurl="Buka link di browser sekarang? (Y/N): "
if /i "%openurl%"=="Y" start "" "%TUNNEL_URL%"
pause
goto MENU

:SSH_TERMINAL
cls
echo =====================================================================
echo 💻 MASUK KE SHELL VPS UBUNTU (Reverse SOCKS5 Aktif)...
echo Ketik 'exit' untuk kembali ke menu.
echo =====================================================================
echo.
ssh -R 10808 -p %VPS_PORT% %VPS_USER%@%VPS_HOST%
pause
goto MENU

:RESTART_SERVICE
cls
echo =====================================================================
echo 🔄 MEMERIKSA UPDATE REPO & MERESTART SERVICE DI VPS...
echo =====================================================================
echo.
ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "cd ~/clipperVPS && git fetch origin main && git pull origin main && pm2 restart all && pm2 list"
echo.
echo Selesai!
pause
goto MENU

:CHECK_STATUS
cls
echo =====================================================================
echo 📊 STATUS RESOURCE VPS
echo =====================================================================
echo.
ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "echo '=== RAM USAGE ==='; free -h; echo ''; echo '=== DISK USAGE ==='; df -h /; echo ''; echo '=== PM2 PROCESSES ==='; pm2 list"
echo.
pause
goto MENU

:EXIT
exit /b
