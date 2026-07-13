@echo off
title Zapret Control - Desktop shortcut
cd /d "%~dp0"

if not exist "core\node_modules\electron\dist\electron.exe" (
  echo  [ERROR] core\node_modules is missing.
  echo  Unpack the whole folder from the archive - do not run this from inside the zip.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\tools\make-shortcut.ps1"
echo.
pause
