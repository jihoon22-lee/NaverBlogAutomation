@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. Review the message above, then try again.
  pause
  exit /b 1
)
endlocal
