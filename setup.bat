@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title gemini-chat-bridge

rem Note: avoid "!" in values typed here; batch files can't store it reliably.

:menu
call :load
if exist node_modules\playwright (set "DEPS=installed") else (set "DEPS=not installed")
if "!API_KEY!"=="" (set "KEYSHOW=none") else (set "KEYSHOW=set")
if /i "!HEADLESS!"=="true" (set "WINSHOW=hidden") else (set "WINSHOW=visible")
set "ACCSHOW=default"
if not "!ACCOUNTS!"=="" set "ACCSHOW=default,!ACCOUNTS!"
cls
echo.
echo   gemini-chat-bridge
echo   ==================
echo.
echo   1  Install / update        [!DEPS!]
echo   2  Sign in to Gemini
echo   3  Start the bridge
echo.
echo   4  Chat history            [!CHAT_MODE!]
echo   5  Model                   [!MODEL_LABEL!]
echo   6  Port                    [!PORT!]
echo   7  API key                 [!KEYSHOW!]
echo   8  Browser window          [!WINSHOW!]
echo   9  Accounts                [!ACCSHOW!]
echo.
echo   0  Exit
echo.
choice /c 1234567890 /n /m "  Press a number: "
set "PICK=!errorlevel!"
if "!PICK!"=="10" exit /b 0
goto :opt!PICK!

rem ------------------------------------------------------------ 1 install
:opt1
cls
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Get version 20 or newer from https://nodejs.org
  pause
  goto :menu
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! LSS 20 (
  echo   Node.js 20 or newer is needed. You have version !NODE_MAJOR!.
  pause
  goto :menu
)
echo   Installing...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo   Install failed, see the error above.
  pause
  goto :menu
)
call :save
echo.
call :check_chrome
if errorlevel 1 (
  pause
  goto :menu
)
echo   Done. Next: press 2 to sign in.
pause
goto :menu

rem ------------------------------------------------------------ 2 sign in
:opt2
if not exist node_modules\playwright (
  echo.
  echo   Press 1 to install first.
  pause
  goto :menu
)
cls
call :check_chrome
if errorlevel 1 (
  pause
  goto :menu
)
call :pick_account "Sign in to which account"
if "!PICKED!"=="" goto :menu
echo.
node bin\cli.js login !PICKED!
pause
goto :menu

rem ------------------------------------------------------------ 3 start
:opt3
if not exist node_modules\playwright (
  echo.
  echo   Press 1 to install first.
  pause
  goto :menu
)
cls
echo.
echo   Starting. Close this window or press Ctrl+C to stop.
echo.
node bin\cli.js serve
pause
goto :menu

rem ------------------------------------------------------------ 4 chat history
:opt4
cls
echo.
echo   Chat history
echo.
echo   1  Keep chats        Saved in your Gemini history. Follow-ups continue the same chat.
echo   2  Temporary chats   Not saved to your history.
echo.
echo   0  Back
echo.
choice /c 120 /n /m "  Press a number: "
if errorlevel 3 goto :menu
if errorlevel 2 (set "CHAT_MODE=temporary") else (set "CHAT_MODE=keep")
call :save
goto :menu

rem ------------------------------------------------------------ 5 model
:opt5
cls
echo.
echo   Model
echo   Current: !MODEL_LABEL!
echo.
echo   1  Pick from your Gemini   Opens Gemini and lists the exact model names.
echo   2  Type the name myself
echo.
echo   0  Back
echo.
choice /c 120 /n /m "  Press a number: "
if errorlevel 3 goto :menu
if errorlevel 2 goto :model_type
if not exist node_modules\playwright (
  echo   Press 1 in the main menu to install first.
  pause
  goto :menu
)
call :check_chrome
if errorlevel 1 (
  pause
  goto :menu
)
call :pick_account "Read the models from which account"
if "!PICKED!"=="" goto :menu
echo.
echo   Opening Gemini...
node bin\cli.js models !PICKED! --save
pause
goto :menu
:model_type
echo.
echo   Type it exactly as it appears in Gemini's model picker.
set "NEWVAL="
set /p "NEWVAL=  Model name, or Enter to keep: "
if not "!NEWVAL!"=="" (
  set "MODEL_LABEL=!NEWVAL!"
  call :save
)
goto :menu

rem ------------------------------------------------------------ 6 port
:opt6
cls
echo.
echo   Port for the local API. Current: !PORT!
echo.
set "NEWVAL="
set /p "NEWVAL=  New port, or Enter to keep: "
if "!NEWVAL!"=="" goto :menu
for /f "delims=0123456789" %%x in ("!NEWVAL!") do goto :bad_port
if !NEWVAL! LSS 1 goto :bad_port
if !NEWVAL! GTR 65535 goto :bad_port
set "PORT=!NEWVAL!"
call :save
goto :menu
:bad_port
echo   That is not a valid port. Use a number from 1 to 65535.
pause
goto :opt6

rem ------------------------------------------------------------ 7 api key
:opt7
cls
echo.
echo   API key: tools must send this key to use the bridge.
echo   Optional when the bridge only listens on this computer.
if "!API_KEY!"=="" (echo   Current: none) else (echo   Current: !API_KEY!)
echo.
echo   1  Generate a random key
echo   2  Type my own
echo   3  Remove the key
echo.
echo   0  Back
echo.
choice /c 1230 /n /m "  Press a number: "
set "PICK=!errorlevel!"
if "!PICK!"=="4" goto :menu
if "!PICK!"=="3" set "API_KEY="
if "!PICK!"=="2" (
  set "NEWVAL="
  set /p "NEWVAL=  Key: "
  if not "!NEWVAL!"=="" set "API_KEY=!NEWVAL!"
)
if "!PICK!"=="1" (
  for /f %%k in ('node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"') do set "API_KEY=%%k"
)
call :save
goto :opt7

rem ------------------------------------------------------------ 8 browser window
:opt8
cls
echo.
echo   Browser window
echo.
echo   1  Visible   Recommended. You can see what it does and spot sign-in prompts.
echo   2  Hidden    Runs in the background.
echo.
echo   0  Back
echo.
choice /c 120 /n /m "  Press a number: "
if errorlevel 3 goto :menu
if errorlevel 2 (set "HEADLESS=true") else (set "HEADLESS=false")
call :save
goto :menu

rem ------------------------------------------------------------ 9 accounts
:opt9
cls
echo.
echo   Accounts
echo.
echo   Each Google account gets its own browser profile. Pick one per request
echo   with the model name: gemini-4-argon is the default account,
echo   gemini-4-argon@NAME uses account NAME.
echo.
echo     default
for %%n in (!ACCOUNTS:,= !) do echo     %%n
echo.
echo   1  Add an account
echo   2  Remove an account
echo.
echo   0  Back
echo.
choice /c 120 /n /m "  Press a number: "
if errorlevel 3 goto :menu
if errorlevel 2 goto :acc_remove

:acc_add
set /a COUNT=0
for %%n in (!ACCOUNTS:,= !) do set /a COUNT+=1
if !COUNT! GEQ 8 (
  echo   You can add up to 8 extra accounts.
  pause
  goto :opt9
)
echo.
set "NEWVAL="
set /p "NEWVAL=  Name for the account, e.g. second: "
if "!NEWVAL!"=="" goto :opt9
for /f "delims=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" %%x in ("!NEWVAL!") do goto :bad_name
for %%n in (default !ACCOUNTS:,= !) do if /i "%%n"=="!NEWVAL!" goto :dup_name
if "!ACCOUNTS!"=="" (set "ACCOUNTS=!NEWVAL!") else (set "ACCOUNTS=!ACCOUNTS!,!NEWVAL!")
call :save
echo.
choice /c YN /m "  Sign in to !NEWVAL! now"
if errorlevel 2 goto :opt9
node bin\cli.js login !NEWVAL!
pause
goto :opt9
:bad_name
echo   Use only letters, numbers, - and _.
pause
goto :opt9
:dup_name
echo   There is already an account called !NEWVAL!.
pause
goto :opt9

:acc_remove
if "!ACCOUNTS!"=="" (
  echo   There are no extra accounts to remove.
  pause
  goto :opt9
)
call :pick_account "Remove which account"
if "!PICKED!"=="" goto :opt9
if /i "!PICKED!"=="default" (
  echo   The default account can't be removed.
  pause
  goto :opt9
)
set "NEWLIST="
for %%n in (!ACCOUNTS:,= !) do (
  if /i not "%%n"=="!PICKED!" (
    if "!NEWLIST!"=="" (set "NEWLIST=%%n") else (set "NEWLIST=!NEWLIST!,%%n")
  )
)
set "ACCOUNTS=!NEWLIST!"
call :save
echo   Removed !PICKED!. Its saved sign-in stays in your user folder under .gemini-chat-bridge\profiles\!PICKED!
pause
goto :opt9

rem ------------------------------------------------------------ helpers

rem Google sign-in only works in a normal Google Chrome, so require it.
:check_chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" exit /b 0
echo   Google Chrome is not installed. It is needed to sign in to Google.
echo   Install it from https://www.google.com/chrome and try again.
exit /b 1

rem Sets PICKED to the chosen account name, or empty for Back.
:pick_account
set "PICKED=default"
if "!ACCOUNTS!"=="" exit /b 0
echo.
echo   %~1
echo.
set /a N=1
set "ACC1=default"
set "CHOICES=1"
echo   1  default
for %%n in (!ACCOUNTS:,= !) do (
  set /a N+=1
  set "ACC!N!=%%n"
  echo   !N!  %%n
  set "CHOICES=!CHOICES!!N!"
)
echo.
echo   0  Back
echo.
choice /c !CHOICES!0 /n /m "  Press a number: "
set "P=!errorlevel!"
set "PICKED="
if !P! LEQ !N! for %%i in (!P!) do set "PICKED=!ACC%%i!"
exit /b 0

:load
set "CHAT_MODE=keep"
set "MODEL_LABEL=Argon"
set "PORT=8787"
set "API_KEY="
set "HEADLESS=false"
set "ACCOUNTS="
if not exist bridge.env exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("bridge.env") do (
  if /i "%%a"=="BRIDGE_CHAT_MODE" set "CHAT_MODE=%%b"
  if /i "%%a"=="GEMINI_MODEL_LABEL" set "MODEL_LABEL=%%b"
  if /i "%%a"=="BRIDGE_PORT" set "PORT=%%b"
  if /i "%%a"=="BRIDGE_API_KEY" set "API_KEY=%%b"
  if /i "%%a"=="BRIDGE_HEADLESS" set "HEADLESS=%%b"
  if /i "%%a"=="BRIDGE_ACCOUNTS" set "ACCOUNTS=%%b"
)
exit /b 0

rem Writes the settings above to bridge.env, keeping any other lines you added.
:save
> bridge.env.tmp (
  echo # Written by setup.bat. You can edit this file by hand too.
  echo BRIDGE_CHAT_MODE=!CHAT_MODE!
  echo GEMINI_MODEL_LABEL=!MODEL_LABEL!
  echo BRIDGE_PORT=!PORT!
  echo BRIDGE_HEADLESS=!HEADLESS!
  echo BRIDGE_ACCOUNTS=!ACCOUNTS!
  if not "!API_KEY!"=="" echo BRIDGE_API_KEY=!API_KEY!
)
if exist bridge.env findstr /v /b /i /c:"#" /c:"BRIDGE_CHAT_MODE=" /c:"GEMINI_MODEL_LABEL=" /c:"BRIDGE_PORT=" /c:"BRIDGE_HEADLESS=" /c:"BRIDGE_ACCOUNTS=" /c:"BRIDGE_BROWSER_CHANNEL=" /c:"BRIDGE_API_KEY=" bridge.env >> bridge.env.tmp
move /y bridge.env.tmp bridge.env >nul
exit /b 0
