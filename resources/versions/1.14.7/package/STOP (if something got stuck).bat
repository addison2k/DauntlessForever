@echo off
title Dauntless 1.14.7 offline - stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\server-1147.ps1" -Stop
echo Also closing the local backend if it is running...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$f = Join-Path '%~dp0' 'data\recorder.pid'; if (Test-Path -LiteralPath $f) { $id = [int](Get-Content -LiteralPath $f -Raw).Trim(); $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force; 'Local backend closed.' } }"
echo.
pause
