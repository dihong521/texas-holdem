@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Texas Holdem - Server
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
