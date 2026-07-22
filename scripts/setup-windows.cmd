@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup failed. Review the message above, then try again.
  pause
  exit /b 1
)
echo.
pause
endlocal
