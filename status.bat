@echo off
chcp 65001 >nul
title Texas Holdem - Status
node "%~dp0tools\status.js" %PORT%
echo.
pause >nul
