@echo off
title Bring your Dauntless Revived character into Dauntless Forever 1.6.2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\import-revived.ps1" %*
echo.
pause
