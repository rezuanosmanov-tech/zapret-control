@echo off
REM DEV ONLY. This file is not shipped to users - the release zip already
REM contains node_modules, so nothing has to be installed on their side.
title Zapret Control - Dev setup
cd /d "%~dp0"

echo.
echo  ============================================
echo    ZAPRET CONTROL - DEV SETUP
echo  ============================================
echo.
echo  Folder: %~dp0
echo.

if not exist "core\package.json" goto no_core

call "%~dp0tools\ensure-node.bat"
if errorlevel 1 goto fail

set "NODE=%~dp0runtime\node.exe"
set "NPM=%~dp0runtime\node_modules\npm\bin\npm-cli.js"

echo.
echo  [1/2] Installing dependencies (Electron is about 100 MB on first run)...
echo.
cd /d "%~dp0core"
"%NODE%" "%NPM%" install --no-fund --no-audit
if errorlevel 1 goto fail
cd /d "%~dp0"

if not exist "core\node_modules\electron\dist\electron.exe" goto no_electron

echo.
echo  [2/2] Creating the desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\tools\make-shortcut.ps1"

echo.
echo  ============================================
echo    DONE
echo    Run:   Start Zapret Control.bat
echo    Pack:  Pack.bat   (release zip for Discord)
echo  ============================================
echo.
pause
exit /b 0

:no_core
echo  [ERROR] core\package.json not found.
echo  Setup.bat must sit next to the "core" folder, and the archive must be unpacked.
echo.
pause
exit /b 1

:no_electron
echo.
echo  [ERROR] Electron binary is missing after install.
echo  Run again, or inside core: ..\runtime\node.exe ..\runtime\node_modules\npm\bin\npm-cli.js install electron --force
echo.
pause
exit /b 1

:fail
echo.
echo  [ERROR] Setup failed - see the messages above.
echo.
pause
exit /b 1
