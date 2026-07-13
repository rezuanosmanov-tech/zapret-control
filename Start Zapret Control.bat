@echo off
setlocal
cd /d "%~dp0"

set "CORE=%~dp0core"
set "ELECTRON=%CORE%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo  Dependencies are missing. Run Setup.bat first.
  echo.
  pause
  exit /b 1
)

REM Launch electron.exe directly - Explorer does not put Node.js on PATH,
REM so "npm start" from a shortcut would die without a word.
REM RunAs: the app installs a Windows service and needs admin rights.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '%ELECTRON%' -ArgumentList '.' -WorkingDirectory '%CORE%' -Verb RunAs"
