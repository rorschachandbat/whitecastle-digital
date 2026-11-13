@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bga-live.ps1" %*
set "BGA_EXIT_CODE=%ERRORLEVEL%"
if not "%BGA_EXIT_CODE%"=="0" pause
exit /b %BGA_EXIT_CODE%
