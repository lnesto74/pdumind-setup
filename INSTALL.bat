@echo off
:: PDUMind Windows Installer - Double-click to run
:: This will open PowerShell as Administrator and run the installer

echo.
echo  =====================================
echo    PDUMind Installer for Windows
echo  =====================================
echo.
echo  This will install Docker Desktop (if needed)
echo  and set up PDUMind on your PC.
echo.
echo  You may be prompted for Administrator access.
echo.
pause

powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \"%~dp0install-windows.ps1\"' -Verb RunAs"
