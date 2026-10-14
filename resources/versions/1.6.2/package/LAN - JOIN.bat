@echo off
title Dauntless 1.6.2 - join a LAN game
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\lan-join.ps1"
echo.
pause
