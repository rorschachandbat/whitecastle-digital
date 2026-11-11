@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bga-live.ps1"
if errorlevel 1 pause
