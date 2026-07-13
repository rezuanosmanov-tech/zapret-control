@echo off
title Zapret Control - Build portable exe
cd /d "%~dp0"

REM electron-builder unpacks winCodeSign, and that archive carries macOS symlinks
REM (libcrypto.dylib / libssl.dylib). Windows refuses to create symlinks without
REM elevation, so the build dies with "Cannot create symbolic link".
REM Therefore: elevate first, then build.
net session >nul 2>&1
if not errorlevel 1 goto admin

echo.
echo  Asking for administrator rights (electron-builder needs them
echo  to unpack winCodeSign)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 0

:admin
echo.
echo  ============================================
echo    BUILD PORTABLE EXE  (administrator)
echo  ============================================
echo.

call "%~dp0tools\ensure-node.bat"
if errorlevel 1 goto fail

set "NODE=%~dp0runtime\node.exe"
set "NPM=%~dp0runtime\node_modules\npm\bin\npm-cli.js"

cd /d "%~dp0core"
echo  [1/2] Installing dependencies...
"%NODE%" "%NPM%" install --no-fund --no-audit
if errorlevel 1 goto fail

echo.
echo  [2/2] Running electron-builder...
"%NODE%" "%NPM%" run dist
if errorlevel 1 goto fail

echo.
echo  Done: core\dist\ZapretControl-portable.exe
echo.
pause
exit /b 0

:fail
echo.
echo  [ERROR] Build failed - see the messages above.
echo.
echo  If it still complains about symbolic links, turn on Developer Mode:
echo  Settings - System - For developers - Developer Mode = On.
echo.
pause
exit /b 1
