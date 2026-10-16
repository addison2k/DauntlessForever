@echo off
title Dauntless Forever 1.6.2 - fix tutorial, missions and weapon levels after a Revived import
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\import-revived.ps1" -TutorialOnly %*
echo.
pause
