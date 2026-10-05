@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
rem npm can be configured to skip install scripts; fetch the Electron binary directly in that case.
if not exist "node_modules\electron\dist\electron.exe" node "node_modules\electron\install.js"
start "" "node_modules\electron\dist\electron.exe" .
