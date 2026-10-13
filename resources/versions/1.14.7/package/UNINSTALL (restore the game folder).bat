@echo off
title Dauntless 1.14.7 offline - uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" -Uninstall
echo.
pause
