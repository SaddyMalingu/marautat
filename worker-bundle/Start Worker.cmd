@echo off
setlocal
title Alphadome Worker
cd /d "%~dp0"

echo.
echo   Alphadome Worker
echo   ----------------
echo   This window must stay open while you want captures to run.
echo.

rem Running a .cmd straight from the zip window is the single most common mistake:
rem Windows extracts ONLY that file to %TEMP%\..._alphadome-worker.zip.xxxx\, so the
rem scripts folder is missing and node fails with MODULE_NOT_FOUND. Say that plainly
rem instead of letting Node explain it in a stack trace.
if not exist "scripts\browser_actor_worker.mjs" goto notextracted

rem Node: prefer the copy the installer downloaded (runtime\node.exe) so the tenant never has
rem to install anything. If it is absent, fall back to whatever is on PATH — the behaviour this
rem file has always had — so an existing working install is untouched.
set "NODE_EXE=node"
if exist "runtime\node.exe" set "NODE_EXE=runtime\node.exe"

%NODE_EXE% --version >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed yet, and this worker needs it.
  echo.
  echo   EASIEST: double-click  "Install Worker.cmd"  once - it fetches Node into
  echo   this folder and puts an Alphadome icon on your Desktop. Then use that icon.
  echo.
  echo   Or do it by hand:
  echo   1. Go to https://nodejs.org  and download the big "LTS" button
  echo   2. Run the installer and click Next through it
  echo   3. Double-click this file again
  echo.
  pause
  exit /b 1
)

%NODE_EXE% -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   This worker needs Node.js 22 or newer.
  echo   You have:
  %NODE_EXE% --version
  echo.
  echo   Install the LTS version from https://nodejs.org and run this file again,
  echo   or double-click "Install Worker.cmd" to fetch a current one into this folder.
  echo.
  pause
  exit /b 1
)

if exist "worker-token.txt" goto run

echo   Paste ONLY the worker token here, then press Enter.
echo   It starts with wkr_ and is shown once, on the "Your own browser" panel.
echo   Do not paste the whole node command - just the wkr_ part.
echo.
set /p TOKEN=  Token: 
if "%TOKEN%"=="" (
  echo.
  echo   No token entered, so nothing was started.
  pause
  exit /b 1
)
echo %TOKEN%> "worker-token.txt"
echo.
echo   Saved in this folder as worker-token.txt. Keep this folder to yourself:
echo   anyone with that file can use your MoreLogin browsing.
echo.

:run
%NODE_EXE% scripts\browser_actor_worker.mjs --token-file worker-token.txt --config worker-config.json
echo.
echo   The worker stopped. If that was not on purpose, run this file again.
pause
exit /b 0

:notextracted
echo   This file is running straight out of the zip, where the rest of the worker
echo   is missing - so nothing can start from here.
echo.
echo   Fix it like this:
echo.
echo   1. Close this window.
echo   2. Find the file you downloaded:  alphadome-worker.zip
echo   3. Right-click it and choose  "Extract All..."  then  Extract.
echo   4. Open the new folder that appears.
echo   5. Double-click  "Start Worker.cmd"  in THAT folder.
echo.
echo   (Dragging the .cmd out on its own does not work either - the folder matters.)
echo.
pause
exit /b 1
