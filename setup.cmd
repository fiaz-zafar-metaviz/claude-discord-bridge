@echo off
REM Wrapper for setup.ps1 — bypasses PowerShell execution policy
REM Just double-click this file or run from cmd

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup.ps1"

echo.
echo Press any key to close...
pause >nul
