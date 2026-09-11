@echo off
chcp 65001 >nul
title LIVE MONITOR - CLIPPER VPS LOGS
color 0A
echo =====================================================================
echo 📋 MENAMPILKAN LOG REAL-TIME DARI SERVER VPS (208.76.40.194)
echo Tekan Ctrl+C untuk berhenti melihat log.
echo =====================================================================
echo.
ssh -t -p 14115 ubuntu@208.76.40.194 "pm2 logs clipper"
pause
