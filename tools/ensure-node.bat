@echo off
REM Downloads a portable Node.js into runtime\ once, so Build/Pack/Setup never
REM depend on a system-wide Node install. Silently returns if it is already there.
setlocal
set "ROOT=%~dp0.."
set "RUNTIME=%ROOT%\runtime"
set "NODE_EXE=%RUNTIME%\node.exe"

if exist "%NODE_EXE%" exit /b 0

set "NODE_VER=v22.14.0"
set "NODE_PKG=node-%NODE_VER%-win-x64"

echo.
echo  Portable Node.js is missing. Downloading it once (about 30 MB)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$url='https://nodejs.org/dist/%NODE_VER%/%NODE_PKG%.zip';" ^
  "$zip=Join-Path $env:TEMP 'zc-node.zip';" ^
  "$tmp=Join-Path $env:TEMP 'zc-node';" ^
  "Write-Host \"  $url\";" ^
  "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing;" ^
  "if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
  "if (Test-Path '%RUNTIME%') { Remove-Item '%RUNTIME%' -Recurse -Force };" ^
  "Move-Item (Join-Path $tmp '%NODE_PKG%') '%RUNTIME%';" ^
  "Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force"

if not exist "%NODE_EXE%" (
  echo  [ERROR] Could not fetch Node.js. Check your internet connection.
  exit /b 1
)

echo  Portable Node.js is ready: %NODE_EXE%
exit /b 0
