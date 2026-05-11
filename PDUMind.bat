@echo off
:: PDUMind Launcher - Double-click to start
:: Checks for updates automatically, then launches PDUMind

title PDUMind
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0start-pdumind.ps1"
