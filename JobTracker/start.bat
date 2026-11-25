@echo off
title JobTracker3000
cd /d "%~dp0"
echo Starting JobTracker3000...
echo.
start "" "http://localhost:3000"
node server.js
pause
