@echo off
chcp 65001 >nul
title Texas Holdem - Stop
node "%~dp0tools\stop.js" %PORT%
echo.
pause >nul
