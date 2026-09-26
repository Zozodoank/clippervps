@echo off
REM  sync-to-termux.bat  -  Double-click to PUSH job history + videos from PC to Termux.
REM  Make sure you already ran on Termux:  bash syn.sh
chcp 65001 >nul
title Sinkron Job PC ke Termux
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-to-termux.ps1"
echo.
pause
