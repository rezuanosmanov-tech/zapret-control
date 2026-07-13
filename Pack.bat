@echo off
title Zapret Control - Pack release zip
cd /d "%~dp0"

echo.
echo  ============================================
echo    PACK RELEASE ZIP (app + node_modules)
echo  ============================================
echo.

call "%~dp0tools\ensure-node.bat"
if errorlevel 1 goto fail

"%~dp0runtime\node.exe" "%~dp0core\tools\pack-zip.js"
if errorlevel 1 goto fail

echo.
echo  The zip in release\ is what you share in Discord.
echo.
pause
exit /b 0

:fail
echo.
echo  [ERROR] Packing failed - see the messages above.
echo.
pause
exit /b 1
