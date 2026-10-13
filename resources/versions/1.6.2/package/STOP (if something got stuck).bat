@echo off
title Dauntless 1.6.2 offline - stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop.ps1"
echo.
pause
