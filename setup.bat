@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title gemini-chat-bridge setup

echo ============================================================
echo  gemini-chat-bridge setup
echo ============================================================
echo.
echo  Unofficial tool. Automating the Gemini web app is very likely
echo  against Google's terms and could get your account's Gemini
echo  access restricted. Use at your own risk.
echo.

rem ---- Node.js check
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 20 (
  echo Node.js 20 or newer is required. You have version !NODE_MAJOR!.
  pause
  exit /b 1
)

rem ---- dependencies
echo Installing dependencies...
call npm install --no-fund --no-audit
if errorlevel 1 goto :fail

rem ---- browser: use installed Chrome if present, otherwise download Playwright's Chromium
set CHANNEL=chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" goto :have_chrome
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" goto :have_chrome
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" goto :have_chrome
echo Google Chrome not found; downloading Playwright's Chromium instead...
call npx playwright install chromium
if errorlevel 1 goto :fail
set CHANNEL=
:have_chrome

rem ---- chat history mode
echo.
echo How should the bridge handle your Gemini chat history?
echo.
echo   1] Keep chats       Conversations are saved in your Gemini history, and
echo                       follow-up requests continue the same chat. [default]
echo   2] Temporary chats  Every new conversation opens a Gemini Temporary chat,
echo                       which is not saved to your history. A conversation can
echo                       only be continued while the bridge stays on that chat.
echo.
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 (set CHAT_MODE=temporary) else (set CHAT_MODE=keep)

rem ---- other settings
echo.
set "MODEL_LABEL="
set /p "MODEL_LABEL=Model name as shown in Gemini's model picker [Argon]: "
if "!MODEL_LABEL!"=="" set "MODEL_LABEL=Argon"

set "PORT="
set /p "PORT=Port for the local API [8787]: "
if "!PORT!"=="" set "PORT=8787"

set "API_KEY="
set /p "API_KEY=Optional API key clients must send (leave empty for none): "

rem ---- write bridge.env
> bridge.env (
  echo # Written by setup.bat. Edit freely, or run setup.bat again.
  echo BRIDGE_CHAT_MODE=!CHAT_MODE!
  echo GEMINI_MODEL_LABEL=!MODEL_LABEL!
  echo BRIDGE_PORT=!PORT!
  echo BRIDGE_BROWSER_CHANNEL=!CHANNEL!
  if not "!API_KEY!"=="" echo BRIDGE_API_KEY=!API_KEY!
)
echo.
echo Saved settings to bridge.env

rem ---- login
echo.
choice /c YN /m "Open the browser now to sign in to Gemini"
if errorlevel 2 goto :done
call npm run login

:done
echo.
echo Setup complete. Run start.bat to start the API on http://127.0.0.1:!PORT!/v1
pause
exit /b 0

:fail
echo.
echo Setup failed; see the error above.
pause
exit /b 1
