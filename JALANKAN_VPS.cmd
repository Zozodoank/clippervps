@echo off
chcp 65001 >nul
title CLIPPER VPS CONTROL PANEL & MONITOR
color 0B

:MENU
cls
echo =====================================================================
echo           🎬 LOCAL AI AFFILIATE CLIPPER - VPS CONTROL PANEL
echo =====================================================================
echo   IP Server : 208.76.40.194
echo   SSH Port  : 14115
echo   User      : ubuntu
echo   Password  : @Zozo06070786  (Sudah auto-login via SSH Key)
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
echo 🚀 MENJALANKAN DEV-RUNNER LIVE DI VPS...
echo =====================================================================
echo Tips:
echo 1. Port 3000 dan 5000 di-forward otomatis ke PC Anda!
echo 2. Buka browser Anda di: http://localhost:3000
echo 3. Tekan Ctrl+C untuk berhenti dan kembali ke menu.
echo =====================================================================
echo.
start "" "http://localhost:3000"
ssh -t -L 3000:localhost:3000 -L 5000:localhost:5000 -p 14115 ubuntu@208.76.40.194 "pm2 stop clipper >/dev/null 2>&1; cd ~/clipperVPS && node dev-runner.js; pm2 start clipper >/dev/null 2>&1"
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
ssh -t -p 14115 ubuntu@208.76.40.194 "pm2 logs"
pause
goto MENU

:GET_TUNNEL_URL
cls
echo =====================================================================
echo 🌐 MENGAMBIL LINK AKSES CLOUDFLARE TUNNEL DARI VPS...
echo =====================================================================
echo.
ssh -p 14115 ubuntu@208.76.40.194 "pm2 logs tunnel --lines 50 --nostream | grep -o 'https://.*\.trycloudflare\.com' | tail -n 1" > "%TEMP%\vps_tunnel_url.txt"
set /p TUNNEL_URL=<"%TEMP%\vps_tunnel_url.txt"
if "%TUNNEL_URL%"=="" (
  echo Belum menemukan URL aktif. Menjalankan refresh tunnel...
  ssh -p 14115 ubuntu@208.76.40.194 "pm2 restart tunnel && sleep 4 && pm2 logs tunnel --lines 40 --nostream | grep -o 'https://.*\.trycloudflare\.com' | tail -n 1" > "%TEMP%\vps_tunnel_url.txt"
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
echo 💻 MASUK KE SHELL VPS UBUNTU...
echo Ketik 'exit' untuk kembali ke menu.
echo =====================================================================
echo.
ssh -p 14115 ubuntu@208.76.40.194
pause
goto MENU

:RESTART_SERVICE
cls
echo =====================================================================
echo 🔄 MERESTART SERVICE CLIPPER DI VPS...
echo =====================================================================
echo.
ssh -p 14115 ubuntu@208.76.40.194 "pm2 restart all && pm2 list"
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
ssh -p 14115 ubuntu@208.76.40.194 "echo '=== RAM USAGE ==='; free -h; echo ''; echo '=== DISK USAGE ==='; df -h /; echo ''; echo '=== PM2 PROCESSES ==='; pm2 list"
echo.
pause
goto MENU

:EXIT
exit /b
