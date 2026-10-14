@echo off
cd /d "%~dp0"
title gemini-chat-bridge
if not exist node_modules (
  echo Dependencies are missing. Run setup.bat first.
  pause
  exit /b 1
)
node bin\cli.js serve
pause
