@echo off
title Dauntless Forever 1.6.2 - remove duplicate items
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fix-duplicates.ps1" %*
echo.
pause
