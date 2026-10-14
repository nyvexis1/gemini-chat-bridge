#!/usr/bin/env bash
# gemini-chat-bridge setup for macOS / Linux. Run: ./setup.sh
set -u
cd "$(dirname "$0")"

ENV_FILE=bridge.env
KEYS="BRIDGE_CHAT_MODE GEMINI_MODEL_LABEL BRIDGE_PORT BRIDGE_API_KEY BRIDGE_HEADLESS BRIDGE_ACCOUNTS BRIDGE_BROWSER_CHANNEL"

# Exit cleanly if input is closed (e.g. the terminal went away) instead of looping.
pause() { read -rsn1 -p "  Press any key to continue..." _ || exit 0; echo; }

# Read one key press (1-9 / 0) into REPLY.
pick() { read -rsn1 -p "  Press a number: " REPLY || exit 0; echo; }

load() {
  CHAT_MODE=keep MODEL_LABEL=Argon PORT=8787 API_KEY="" HEADLESS=false ACCOUNTS=""
  [ -f "$ENV_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      BRIDGE_CHAT_MODE) CHAT_MODE=$value ;;
      GEMINI_MODEL_LABEL) MODEL_LABEL=$value ;;
      BRIDGE_PORT) PORT=$value ;;
      BRIDGE_API_KEY) API_KEY=$value ;;
      BRIDGE_HEADLESS) HEADLESS=$value ;;
      BRIDGE_ACCOUNTS) ACCOUNTS=$value ;;
    esac
  done < <(grep -v '^#' "$ENV_FILE" | tr -d '\r')
}

# Write the settings above to bridge.env, keeping any other lines you added.
save() {
  local tmp="$ENV_FILE.tmp"
  {
    echo "# Written by setup.sh. You can edit this file by hand too."
    echo "BRIDGE_CHAT_MODE=$CHAT_MODE"
    echo "GEMINI_MODEL_LABEL=$MODEL_LABEL"
    echo "BRIDGE_PORT=$PORT"
    echo "BRIDGE_HEADLESS=$HEADLESS"
    echo "BRIDGE_ACCOUNTS=$ACCOUNTS"
    [ -n "$API_KEY" ] && echo "BRIDGE_API_KEY=$API_KEY"
    if [ -f "$ENV_FILE" ]; then
      local pattern="^(#"
      for k in $KEYS; do pattern="$pattern|$k="; done
      grep -Ev "$pattern)" "$ENV_FILE" | tr -d '\r'
    fi
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

installed() { [ -d node_modules/playwright ]; }

# Google sign-in only works in a normal Google Chrome, so require it.
check_chrome() {
  if [ "$(uname)" = "Darwin" ]; then
    [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && return 0
    [ -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && return 0
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser; do
      command -v "$c" >/dev/null 2>&1 && return 0
    done
  fi
  echo "  Google Chrome is not installed. It is needed to sign in to Google."
  echo "  Install it from https://www.google.com/chrome and try again."
  return 1
}

need_install() {
  if ! installed; then
    echo
    echo "  Press 1 to install first."
    pause
    return 1
  fi
}

# Sets PICKED to the chosen account, or empty for Back.
pick_account() {
  PICKED=default
  [ -z "$ACCOUNTS" ] && return 0
  local names=(default ${ACCOUNTS//,/ }) i
  echo
  echo "  $1"
  echo
  for i in "${!names[@]}"; do echo "  $((i + 1))  ${names[$i]}"; done
  echo
  echo "  0  Back"
  echo
  pick
  PICKED=""
  if [[ "$REPLY" =~ ^[1-9]$ ]] && [ "$REPLY" -le "${#names[@]}" ]; then PICKED=${names[$((REPLY - 1))]}; fi
}

opt_install() {
  clear; echo
  if ! command -v node >/dev/null 2>&1; then
    echo "  Node.js is not installed. Get version 20 or newer from https://nodejs.org"; pause; return
  fi
  local major; major=$(node -p "process.versions.node.split('.')[0]")
  if [ "$major" -lt 20 ]; then
    echo "  Node.js 20 or newer is needed. You have version $major."; pause; return
  fi
  echo "  Installing..."
  if ! npm install --no-fund --no-audit; then
    echo "  Install failed, see the error above."; pause; return
  fi
  save
  echo
  check_chrome || { pause; return; }
  echo "  Done. Next: press 2 to sign in."
  pause
}

opt_login() {
  need_install || return
  clear
  check_chrome || { pause; return; }
  pick_account "Sign in to which account"
  [ -z "$PICKED" ] && return
  echo
  node bin/cli.js login "$PICKED"
  pause
}

opt_start() {
  need_install || return
  clear; echo
  echo "  Starting. Press Ctrl+C to stop."
  echo
  node bin/cli.js serve
  pause
}

opt_chat() {
  clear; echo
  echo "  Chat history"; echo
  echo "  1  Keep chats        Saved in your Gemini history. Follow-ups continue the same chat."
  echo "  2  Temporary chats   Not saved to your history."
  echo; echo "  0  Back"; echo
  pick
  case "$REPLY" in 1) CHAT_MODE=keep; save ;; 2) CHAT_MODE=temporary; save ;; esac
}

opt_model() {
  clear; echo
  echo "  Model name, as it appears in Gemini's model picker. Part of the name is enough."
  echo "  Current: $MODEL_LABEL"; echo
  read -rp "  New name, or Enter to keep: " v || exit 0
  [ -n "$v" ] && { MODEL_LABEL=$v; save; }
}

opt_port() {
  while true; do
    clear; echo
    echo "  Port for the local API. Current: $PORT"; echo
    read -rp "  New port, or Enter to keep: " v || exit 0
    [ -z "$v" ] && return
    if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 65535 ]; then PORT=$v; save; return; fi
    echo "  That is not a valid port. Use a number from 1 to 65535."; pause
  done
}

opt_key() {
  while true; do
    clear; echo
    echo "  API key: tools must send this key to use the bridge."
    echo "  Optional when the bridge only listens on this computer."
    echo "  Current: ${API_KEY:-none}"; echo
    echo "  1  Generate a random key"
    echo "  2  Type my own"
    echo "  3  Remove the key"
    echo; echo "  0  Back"; echo
    pick
    case "$REPLY" in
      1) API_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"); save ;;
      2) read -rp "  Key: " v || exit 0; [ -n "$v" ] && { API_KEY=$v; save; } ;;
      3) API_KEY=""; save ;;
      0) return ;;
    esac
  done
}

opt_window() {
  clear; echo
  echo "  Browser window"; echo
  echo "  1  Visible   Recommended. You can see what it does and spot sign-in prompts."
  echo "  2  Hidden    Runs in the background."
  echo; echo "  0  Back"; echo
  pick
  case "$REPLY" in 1) HEADLESS=false; save ;; 2) HEADLESS=true; save ;; esac
}

opt_accounts() {
  while true; do
    clear; echo
    echo "  Accounts"; echo
    echo "  Each Google account gets its own browser profile. Pick one per request"
    echo "  with the model name: gemini-4-argon is the default account,"
    echo "  gemini-4-argon@NAME uses account NAME."
    echo
    echo "    default"
    for n in ${ACCOUNTS//,/ }; do echo "    $n"; done
    echo
    echo "  1  Add an account"
    echo "  2  Remove an account"
    echo; echo "  0  Back"; echo
    pick
    case "$REPLY" in
      1)
        local count; count=$(echo "${ACCOUNTS//,/ }" | wc -w)
        if [ "$count" -ge 8 ]; then echo "  You can add up to 8 extra accounts."; pause; continue; fi
        echo
        read -rp "  Name for the account, e.g. second: " v || exit 0
        [ -z "$v" ] && continue
        if ! [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]]; then echo "  Use only letters, numbers, - and _."; pause; continue; fi
        if [[ ",default,$ACCOUNTS," == *",$v,"* ]]; then echo "  There is already an account called $v."; pause; continue; fi
        ACCOUNTS=${ACCOUNTS:+$ACCOUNTS,}$v
        save
        echo
        read -rsn1 -p "  Sign in to $v now? [y/n] " yn || exit 0; echo
        if [[ "$yn" =~ ^[Yy]$ ]] && installed && check_chrome; then node bin/cli.js login "$v"; pause; fi
        ;;
      2)
        if [ -z "$ACCOUNTS" ]; then echo "  There are no extra accounts to remove."; pause; continue; fi
        pick_account "Remove which account"
        [ -z "$PICKED" ] && continue
        if [ "$PICKED" = default ]; then echo "  The default account can't be removed."; pause; continue; fi
        local out="" n
        for n in ${ACCOUNTS//,/ }; do [ "$n" != "$PICKED" ] && out=${out:+$out,}$n; done
        ACCOUNTS=$out
        save
        echo "  Removed $PICKED. Its saved sign-in stays in ~/.gemini-chat-bridge/profiles/$PICKED"
        pause
        ;;
      0) return ;;
    esac
  done
}

while true; do
  load
  installed && deps=installed || deps="not installed"
  [ -n "$API_KEY" ] && keyshow=set || keyshow=none
  [ "$HEADLESS" = true ] && winshow=hidden || winshow=visible
  accshow=default${ACCOUNTS:+,$ACCOUNTS}
  clear
  echo
  echo "  gemini-chat-bridge"
  echo "  =================="
  echo
  echo "  1  Install / update        [$deps]"
  echo "  2  Sign in to Gemini"
  echo "  3  Start the bridge"
  echo
  echo "  4  Chat history            [$CHAT_MODE]"
  echo "  5  Model name              [$MODEL_LABEL]"
  echo "  6  Port                    [$PORT]"
  echo "  7  API key                 [$keyshow]"
  echo "  8  Browser window          [$winshow]"
  echo "  9  Accounts                [$accshow]"
  echo
  echo "  0  Exit"
  echo
  pick
  case "$REPLY" in
    1) opt_install ;;
    2) opt_login ;;
    3) opt_start ;;
    4) opt_chat ;;
    5) opt_model ;;
    6) opt_port ;;
    7) opt_key ;;
    8) opt_window ;;
    9) opt_accounts ;;
    0) echo; exit 0 ;;
  esac
done
