# gemini-chat-bridge

Use the Gemini model from your Gemini app subscription (e.g. **Gemini 4 Argon**) in coding tools, through a local OpenAI- and Anthropic-compatible API.

```
your tool ──API──▶ gemini-chat-bridge (your PC) ──▶ your browser, signed in to gemini.google.com
```

It runs on your own account and uses your plan's normal chat limits. Supports streaming, tool calling, images, multiple accounts and temporary chats.

> [!NOTE]
> **Early release.** Google changes the Gemini page often, so things may break. Please [open an issue](https://github.com/nyvexis1/gemini-chat-bridge/issues) if something doesn't work.

> [!WARNING]
> Unofficial and not affiliated with Google. Automating the Gemini app is likely against Google's terms and could get your account's Gemini access restricted. Use at your own risk.

## Setup

You need [Node.js](https://nodejs.org) (version 20 or newer) and [Google Chrome](https://www.google.com/chrome). The bridge opens your normal Chrome with its own profile, so Google sign-in works like usual.

### Windows

1. Download this repo (**Code → Download ZIP**) and unzip it.
2. Double-click **`setup.bat`** and press the numbers:
   - **1** to install
   - **2** to sign in to Gemini
   - **3** to start

The same menu changes settings. Use **5 Model → Pick from your Gemini** to choose the exact model name from your own Gemini, e.g. `4 Argon`. After setup you can also just double-click **`start.bat`**.

### macOS / Linux

```bash
git clone https://github.com/nyvexis1/gemini-chat-bridge
cd gemini-chat-bridge
./setup.sh
```

Same menu: **1** install, **2** sign in, **3** start.

## Connect your tool

| Setting  | Value |
| -------- | ----- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key  | anything (or your key, if you set one) |
| Model    | `gemini-4-argon` |

- **Cline / Roo Code / Kilo:** provider "OpenAI Compatible".
- **Aider:** `OPENAI_API_BASE=http://127.0.0.1:8787/v1 OPENAI_API_KEY=x aider --model openai/gemini-4-argon`
- **Continue, opencode, Zed, OpenAI SDK:** add a custom OpenAI-compatible provider with the values above.
- **Claude Code and other Anthropic-API tools:**

  ```bash
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=x \
  ANTHROPIC_MODEL=gemini-4-argon ANTHROPIC_SMALL_FAST_MODEL=gemini-4-argon claude
  ```

  Claude Code sends very large prompts. If you get a "Prompt is … characters" error, raise `BRIDGE_MAX_PROMPT_CHARS`.

**Which tools work best?** Aider and Cline / Roo (default mode) work best, because they handle tool use as plain text. Tools that use native function calling (opencode, Continue agent mode, Claude Code) work through prompted tool calls. If a reply looks like a broken tool call, the bridge asks the model once more, but it's still less reliable than a real API. Every tool call is a full chat message, so agents use up your plan's limits faster than chatting.

## Multiple accounts

Have more than one Google account with a plan? Add them in `setup.bat` → **9 Accounts**, sign in to each, then choose one per request with the model name:

| Model | Account |
| --- | --- |
| `gemini-4-argon` | default |
| `gemini-4-argon@second` | the account named `second` |

Each account has its own browser and its own rate limit. The bridge never switches accounts on its own.

## Chat history

- **Keep chats** (default): chats show up in your Gemini history, and follow-ups continue the same chat.
- **Temporary chats:** uses Gemini's Temporary chat, so nothing is saved to your history.

## Settings

`setup.bat` saves your settings to `bridge.env`. You can also edit that file, or set environment variables.

| Setting | Default | What it does |
| --- | --- | --- |
| `BRIDGE_PORT` | `8787` | Port |
| `BRIDGE_API_KEY` | none | Key tools must send |
| `BRIDGE_CHAT_MODE` | `keep` | `keep` or `temporary` |
| `GEMINI_MODEL_LABEL` | `Argon` | Model name in Gemini's picker. An exact name wins; otherwise the first name containing it is used. |
| `BRIDGE_MODEL_ID` | `gemini-4-argon` | Model name tools use |
| `BRIDGE_ACCOUNTS` | none | Extra accounts, e.g. `second,work` |
| `BRIDGE_HEADLESS` | `false` | Hide the browser window |
| `BRIDGE_TOOL_RETRY` | `true` | Retry once when a tool call comes back broken |
| `BRIDGE_MIN_INTERVAL_MS` | `3000` | Minimum time between requests |
| `BRIDGE_MAX_RPM` | `10` | Maximum requests per minute, per account |
| `BRIDGE_MAX_PROMPT_CHARS` | `200000` | Longest message it will send |

<details>
<summary>All settings</summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Address to listen on. Set `BRIDGE_API_KEY` before using anything else. |
| `GEMINI_STRICT_MODEL` | `true` | Fail if the model can't be selected, instead of using another one |
| `GEMINI_URL` | `https://gemini.google.com/app` | Gemini app URL |
| `BRIDGE_PROFILE_DIR` | `~/.gemini-chat-bridge/profile` | Browser profile of the default account |
| `BRIDGE_PROFILES_ROOT` | `~/.gemini-chat-bridge/profiles` | Where extra accounts' profiles live |
| `BRIDGE_EXECUTABLE_PATH` | found automatically | Path to Chrome |
| `BRIDGE_DEBUG_PORT` | `9333` | Local port the bridge uses to talk to Chrome (extra accounts use the next ports) |
| `BRIDGE_CHROME_ARGS` | none | Extra Chrome flags, e.g. `--no-sandbox` when running as root on Linux |
| `BRIDGE_CDP_URL` | none | Use a Chrome you started yourself with `--remote-debugging-port` |
| `BRIDGE_BROWSER` | `chrome` | `playwright` lets Playwright launch the browser instead (Google sign-in doesn't work there) |
| `BRIDGE_MAX_QUEUE` | `20` | Waiting requests before returning "busy" |
| `BRIDGE_RESPONSE_TIMEOUT_MS` | `600000` | Longest wait for one reply |
| `BRIDGE_REUSE_CHATS` | `true` | Continue the same chat for follow-ups |
| `BRIDGE_MAX_IMAGES` | `10` | Images per request |
| `BRIDGE_MAX_IMAGE_MB` | `20` | Size per image |
| `BRIDGE_SELECTORS_FILE` | `selectors.local.json` | Page selector overrides |
| `BRIDGE_ENV_FILE` | `bridge.env` | Settings file |
| `BRIDGE_DEBUG` | `false` | Log every request |

</details>

## Good to know

- **Context:** Google AI Pro is reported to give about 1M tokens of context in the Gemini app. Follow-ups only send new messages, so long sessions build up context in one chat.
- **Not supported:** PDFs and audio, sampling settings like `temperature`, exact token counts (usage numbers are estimates).
- **Security:** the bridge only listens on your own PC by default. The browser profile folders contain your Google sign-in, so keep them private. While it runs, programs on your PC can control the bridge's Chrome window through its local debugging port.

## When something breaks

Gemini's page changes from time to time. The bridge finds buttons and text boxes with CSS selectors listed in [`src/selectors.js`](src/selectors.js). You can override any of them without touching the code by creating `selectors.local.json`:

```json
{ "input": ["div.new-editor-class[contenteditable=\"true\"]"] }
```

Open DevTools on the Gemini tab to find the new selector, and please send a PR with the fix.

## Roadmap

- [ ] A `doctor` command that checks every selector against your live session
- [ ] PDF and other file attachments
- [ ] OpenAI Responses API endpoint
- [ ] Optional cleanup that deletes the bridge's chats afterwards

## Development

```bash
npm test
```

## License

MIT
