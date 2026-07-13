# Creates a desktop shortcut for Zapret Control.
# ASCII only on purpose: Cyrillic in .ps1/.bat gets mangled by the console codepage.
$ErrorActionPreference = 'Stop'

$core     = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $core 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $core 'assets\icon.ico'

if (-not (Test-Path $electron)) {
    throw "electron.exe not found. Run Setup.bat first."
}

# GetFolderPath handles a Desktop redirected into OneDrive - never build the
# path by hand as "%USERPROFILE%\Desktop", it is wrong on redirected profiles.
$desktop = [Environment]::GetFolderPath('Desktop')
$link    = Join-Path $desktop 'Zapret Control.lnk'

# Point straight at electron.exe: shortcuts launched from Explorer do not get
# Node.js on PATH, so "npm start" / node-based launchers fail silently.
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($link)
$sc.TargetPath       = $electron
$sc.Arguments        = '.'
$sc.WorkingDirectory = $core
$sc.WindowStyle      = 1
$sc.Description      = 'Zapret Control'
if (Test-Path $icon) { $sc.IconLocation = $icon }
$sc.Save()

# Flip the "Run as administrator" bit inside the .lnk (byte 21, flag 0x20).
# The app installs a Windows service, so it needs elevation from the start.
$bytes = [System.IO.File]::ReadAllBytes($link)
$bytes[21] = $bytes[21] -bor 0x20
[System.IO.File]::WriteAllBytes($link, $bytes)

Write-Host "Shortcut created: $link"
