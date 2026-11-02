@echo off
setlocal
title Alphadome Worker
cd /d "%~dp0"

echo.
echo   Alphadome Worker
echo   ----------------
echo   This window must stay open while you want captures to run.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed yet, and this worker needs it.
  echo.
  echo   1. Go to https://nodejs.org  and download the big "LTS" button
  echo   2. Run the installer and click Next through it
  echo   3. Double-click this file again
  echo.
  pause
  exit /b 1
)

if exist "worker-token.txt" goto run

echo   Paste the worker token from your Alphadome portal, then press Enter.
echo   It starts with wkr_ and is shown once, on the "Your own browser" panel.
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
echo   anyone with that file can use your LinkedIn/Micro1 browsing.
echo.

:run
node scripts\browser_actor_worker.mjs --token-file worker-token.txt --config worker-config.json
echo.
echo   The worker stopped. If that was not on purpose, run this file again.
pause
