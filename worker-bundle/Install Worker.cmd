@echo off
setlocal EnableDelayedExpansion
title Alphadome Worker - Setup
cd /d "%~dp0"

echo.
echo   Alphadome Worker - one-time setup
echo   ---------------------------------
echo   This gets a private copy of Node.js into this folder and puts an
echo   Alphadome icon on your Desktop. Run it once. It needs internet.
echo.

rem ---- 1. Node.js -----------------------------------------------------------------
rem Downloading node.exe alone is enough because the worker is dependency-free: every
rem module it uses is plain Node and ships inside this folder. No npm, no node_modules,
rem nothing installed system-wide, nothing added to PATH. Constants below are the only
rem place a version appears.
set "NODE_VERSION=v22.16.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/win-x64/node.exe"

if exist "runtime\node.exe" (
  for /f "delims=" %%v in ('runtime\node.exe --version 2^>nul') do set "HAVE=%%v"
  echo   Node.js already here: !HAVE! - using runtime\node.exe
  echo.
  goto shortcut
)

echo   Downloading Node.js %NODE_VERSION% ...
if not exist "runtime" mkdir "runtime"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile 'runtime\node.exe' -UseBasicParsing } catch { Write-Host ('download failed: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto nonode

for /f "delims=" %%v in ('runtime\node.exe --version 2^>nul') do set "HAVE=%%v"
if not defined HAVE goto nonode
echo   Node.js ready: !HAVE!
echo.

:shortcut
rem ---- 2. Desktop shortcut with the Alphadome icon ---------------------------------
rem Created here, on the machine that has the folder, because a .lnk stores an absolute
rem path. Shipping a prebuilt .lnk in the zip would point at whoever built it.
echo   Creating the Desktop shortcut ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Alphadome Worker.lnk';" ^
  "$s = $w.CreateShortcut($p);" ^
  "$s.TargetPath = Join-Path (Get-Location) 'Start Worker.cmd';" ^
  "$s.WorkingDirectory = (Get-Location).Path;" ^
  "$s.WindowStyle = 1;" ^
  "$s.Description = 'Alphadome Worker - keep this window open to run captures';" ^
  "$ico = Join-Path (Get-Location) 'Alphadome.ico';" ^
  "if (Test-Path $ico) { $s.IconLocation = $ico };" ^
  "$s.Save(); if (Test-Path $p) { Write-Host ('  shortcut: ' + $p) } else { Write-Host '  shortcut not created'; exit 1 }"
if errorlevel 1 (
  echo   The shortcut could not be created. That is not fatal: use "Start Worker.cmd".
  echo.
)

rem ---- 3. MoreLogin CLI is optional -------------------------------------------------
rem The worker can find your MoreLogin profile by itself only if MoreLogin's command-line
rem tool (ml-cli) is installed. It is a SEPARATE download from the MoreLogin app, and we do
rem not bundle it: it is MoreLogin's binary, not ours.
rem
rem You do not have to install it. Start the worker once; if it says it cannot read the
rem profiles, it prints the profile ids it would accept in ONE line - paste that into the
rem portal ("Your own browser") and it is done. That is the path most tenants take.
rem
rem Note on style: these messages live in labels, not in an `if (...)` block, because a
rem parenthesis inside a parenthesised block ends the block early and cmd reports the next
rem word as "unexpected". That is a real bug this file had on its first run.
where ml-cli >nul 2>nul
if errorlevel 1 goto nomlcli
echo   ml-cli found: the worker will discover your MoreLogin profile itself.
echo.
goto finish

:nomlcli
echo   Optional: ml-cli - MoreLogin's command-line tool - is not installed.
echo     With it, the worker finds your MoreLogin profile automatically.
echo     Without it, start the worker and copy the profile id it prints into
echo     the portal: same result, one extra paste.
echo     Install guide: https://guide.morelogin.com/cli
echo.

:finish
echo   Done. Use the "Alphadome Worker" icon on your Desktop.
echo.
echo   First start asks for your worker token: portal ^> Your own browser ^> Create token.
echo.
pause
exit /b 0

:nonode
echo.
echo   Could not download Node.js. Two ways forward:
echo     1. Check the internet connection and run this file again.
echo     2. Install Node.js by hand from https://nodejs.org (LTS), then run
echo        "Start Worker.cmd" - it uses the installed copy.
echo.
pause
exit /b 1
