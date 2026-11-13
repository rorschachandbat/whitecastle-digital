@echo off
setlocal
chcp 65001 >nul
node "%~dp0scripts\watch-ai.mjs" %*
set "AI_LOG_EXIT_CODE=%ERRORLEVEL%"
if not "%AI_LOG_EXIT_CODE%"=="0" pause
exit /b %AI_LOG_EXIT_CODE%
