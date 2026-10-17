@echo off
title Dauntless Forever 1.6.2 - fix imported gear levels
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0tools\fix-gear-levels.ps1" %*
echo.
pause
