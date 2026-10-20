@echo off
rem RGB Changer: opens the site through a small local web server that is built into Windows (PowerShell).
rem Nothing is installed. Close the window that opens to stop the server.
title RGB Changer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\server.ps1" %*
if errorlevel 1 pause
