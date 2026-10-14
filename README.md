# gemini-chat-bridge

A local, OpenAI-compatible API that drives **your own** logged-in Gemini web chat, so you can point coding tools and harnesses at the model you already pay for in the Gemini app (e.g. Gemini 4 Argon on a plan that only offers it in chat).

```
your harness ──OpenAI API──▶ gemini-chat-bridge (localhost) ──▶ your browser, signed in to gemini.google.com
```

- **Bring your own plan.** Every request runs in your browser session, on your account, and counts against your plan's normal chat limits. The bridge never shares, pools, or resells access.
- **OpenAI-compatible:** `GET /v1/models`, `POST /v1/chat/completions`, streaming (SSE), **tool / function calling**, **images**, `response_format` JSON modes.
- **Keep chats or use Temporary chats:** your choice whether requests show up in your Gemini history.
- **No evasion.** No fingerprint spoofing, no hiding automation flags, no captcha solving, no account or IP rotation. If Google shows a challenge or blocks the session, the bridge stops and tells you.

> [!NOTE]
> **Early release.** Everything is tested against a local mock of the Gemini page, but Google's real markup changes often, so the first run on the live site may need a selector tweak (see [When Gemini's UI changes](#when-geminis-ui-changes)). Please [open an issue](https://github.com/nyvexis1/gemini-chat-bridge/issues) with what broke.

> [!WARNING]
> **Unofficial, and very likely against Google's terms.** The Gemini web app isn't an API. Automating it probably violates the [Google Terms of Service](https://policies.google.com/terms), and Google has suspended access for people who wired subscriptions into third-party tools. **Your account's Gemini access could be restricted. Use at your own risk.** This project is not affiliated with or endorsed by Google.

## Requirements

- Node.js 20+
- A Google account with a Gemini plan that includes the model you want
- Google Chrome (recommended), or Playwright's Chromium (`npx playwright install chromium`)

## Quick start

### Windows

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. Download the code: **Code → Download ZIP** on GitHub (then unzip it), or `git clone https://github.com/nyvexis1/gemini-chat-bridge`.
3. Double-click **`setup.bat`**. It installs dependencies, asks how to handle chat history (keep chats or temporary chats), the model name and the port, saves your answers to `bridge.env`, and opens a browser so you can sign in.
4. Double-click **`start.bat`** whenever you want the API running.

Run `setup.bat` again to change settings, or edit `bridge.env` directly.

### macOS / Linux

```bash
git clone https://github.com/nyvexis1/gemini-chat-bridge
cd gemini-chat-bridge
npm install

# 1. Sign in once. A browser window opens. Log in to Google, open Gemini, then press Enter in the terminal.
npm run login

# 2. Start the API.
npm start
# [bridge] listening on http://127.0.0.1:8787/v1  (model id: gemini-4-argon)
```

Test it:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-4-argon","messages":[{"role":"user","content":"Say hi in five words."}]}'
```

Settings can go in a `bridge.env` file in the project folder (one `KEY=value` per line, same names as the environment variables below); real environment variables override it.

Your login lives in a dedicated browser profile (`~/.gemini-chat-bridge/profile` by default). The bridge never sees or stores your password.

### Use your already-running Chrome instead

If Google won't let you sign in from an automated window, start your normal Chrome with remote debugging and let the bridge attach to it. It opens its own tab and leaves your other tabs alone:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.gemini-chat-bridge/chrome"
# sign in to gemini.google.com in that window, then:
BRIDGE_CDP_URL=http://127.0.0.1:9222 npm start
```

## Connecting tools

Anything that talks to an OpenAI-compatible endpoint works. Use:

| Setting  | Value |
| -------- | ----- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key  | anything, or the value of `BRIDGE_API_KEY` if you set one |
| Model    | `gemini-4-argon` (or whatever `BRIDGE_MODEL_ID` is) |

Examples:

- **Cline / Roo Code / Kilo:** provider "OpenAI Compatible", fill in the three values above.
- **Continue:** a model with `provider: openai`, `apiBase: http://127.0.0.1:8787/v1`.
- **Aider:** `OPENAI_API_BASE=http://127.0.0.1:8787/v1 OPENAI_API_KEY=x aider --model openai/gemini-4-argon`
- **opencode / Zed / others:** add a custom OpenAI-compatible provider.
- **OpenAI SDK:**

  ```python
  from openai import OpenAI
  client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="x")
  print(client.chat.completions.create(model="gemini-4-argon", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
  ```

Only the Chat Completions API is implemented (no Responses API and no Anthropic Messages API yet).

### Which tools work best

How a tool asks for actions matters more than anything else here:

| Works best | Works, less reliably |
| --- | --- |
| Tools that describe their own actions in the prompt and read them back from the reply as plain text: **Aider** (edit blocks), **Cline / Roo Code** in their default mode (XML tool tags). The bridge just passes text through, so these behave as they do with any model. | Tools that rely on native **function calling** (`tools` / `tool_calls`): opencode, Continue agent mode, Zed's agent, OpenAI SDK agents. These go through the bridge's prompted tool protocol (below), which a strong model follows most of the time but not always. |

Keep in mind that **every tool call is a full chat message.** An agent that reads ten files makes about ten Gemini messages, and each one waits for the page to render, so expect a few seconds per step, and agent sessions eat into your plan's usage limits much faster than chatting does.

## How it works

1. **Prompt building.** The request's messages (system, user, assistant, tool results) are flattened into one transcript and typed into a new Gemini chat. The model picker is switched to `GEMINI_MODEL_LABEL` first. If that model isn't available, the request fails rather than silently using another model (set `GEMINI_STRICT_MODEL=false` to allow fallback).
2. **Streaming.** The bridge watches the reply as Gemini renders it, converts the HTML back to markdown, and streams the new text as SSE chunks.
3. **Tool calling.** The web chat has no native function calling, so tool definitions (with their JSON Schemas) go into the prompt. The model is told to answer with a fenced block when it wants to call tools:

   ````
   ```tool_calls
   {"tool_calls": [{"name": "read_file", "arguments": {"path": "src/main.rs"}}]}
   ```
   ````

   The bridge parses that block (it also accepts a `json` fence or bare JSON) and returns standard `tool_calls` with `finish_reason: "tool_calls"`. Calls to tool names you didn't define are ignored. `tool_choice` (`auto` / `none` / `required` / a specific function) and `parallel_tool_calls` are passed on as instructions. While streaming a request that has tools, text that could be the start of a tool block is held back, so the raw JSON never leaks into `content`.
4. **Images.** Image parts in messages (`{"type": "image_url", "image_url": {"url": ...}}`, as `data:` URLs or `http(s)` links) are downloaded and attached to the chat through Gemini's upload button, and the text marks where each one goes (`[Image 1 (attached)]`). When a chat is continued, only images in the new messages are uploaded. If the upload can't be confirmed, the request fails instead of silently dropping the images.
5. **Chat reuse.** When the next request extends a conversation the bridge just answered (for example, your harness sends back the tool results), the bridge reopens that Gemini chat and sends **only the new messages**. That keeps prompts short and keeps context in one place. If the prefix doesn't match (edited history, different tools), it starts a fresh chat with the full transcript. Disable with `BRIDGE_REUSE_CHATS=false`.

### Chat history: keep vs. temporary

`BRIDGE_CHAT_MODE` (asked by `setup.bat`):

- **`keep`** (default): normal chats. They show up in your Gemini history, and follow-up requests reopen the same chat by its URL, even after a restart of your harness.
- **`temporary`**: every new conversation turns on Gemini's **Temporary chat** first, so it isn't saved to your history. Temporary chats have no URL, so a conversation can only be continued while the bridge's tab is still showing it. As soon as another conversation starts (or the bridge restarts), the next follow-up opens a new temporary chat with the full history re-sent. If the bridge can't find or confirm the Temporary chat toggle, it refuses the request rather than risk saving the chat. Google's own retention rules for temporary chats still apply.

### Limitations

- Prompted tool calling is **less reliable than a native API**. Typical failures: the model describes what it would do instead of emitting the block, invents a tool result instead of stopping, or produces malformed JSON (the reply then comes back as plain text). Strong models do best.
- Gemini's own system prompt and app features (like web search) still apply underneath, so behaviour isn't identical to the API.
- Token `usage` numbers are rough estimates (characters ÷ 4); the web UI doesn't report real counts.
- Images are supported; other file types (PDFs, audio) aren't yet.
- `temperature`, `max_tokens`, `stop` and similar sampling parameters are ignored (the web UI has no such controls).
- In `keep` mode every request becomes, or continues, a chat in your Gemini history (use `temporary` mode to avoid that).
- Requests are processed one at a time, since the bridge drives a single browser tab.

## Configuration

All settings are environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Address to listen on. Keep it local unless you set `BRIDGE_API_KEY`. |
| `BRIDGE_PORT` | `8787` | Port. |
| `BRIDGE_API_KEY` | *(none)* | If set, clients must send `Authorization: Bearer <key>`. |
| `BRIDGE_MODEL_ID` | `gemini-4-argon` | Model id shown on `/v1/models`. |
| `GEMINI_MODEL_LABEL` | `Argon` | Text to look for in Gemini's model picker (case-insensitive substring). |
| `GEMINI_STRICT_MODEL` | `true` | Fail if that model can't be selected. |
| `BRIDGE_CHAT_MODE` | `keep` | `keep` (saved chats, continued by URL) or `temporary` (Gemini Temporary chats). |
| `GEMINI_URL` | `https://gemini.google.com/app` | Gemini app URL. |
| `BRIDGE_PROFILE_DIR` | `~/.gemini-chat-bridge/profile` | Browser profile holding your login. |
| `BRIDGE_CDP_URL` | *(none)* | Attach to an existing Chrome (e.g. `http://127.0.0.1:9222`). |
| `BRIDGE_BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or empty for Playwright's Chromium. |
| `BRIDGE_EXECUTABLE_PATH` | *(none)* | Explicit browser binary. |
| `BRIDGE_HEADLESS` | `false` | Run the browser without a window. Off by default so you can see what it's doing and spot challenges. |
| `BRIDGE_MIN_INTERVAL_MS` | `3000` | Minimum gap between requests. |
| `BRIDGE_MAX_RPM` | `10` | Maximum requests per minute. |
| `BRIDGE_MAX_QUEUE` | `20` | Queued requests before returning 429. |
| `BRIDGE_RESPONSE_TIMEOUT_MS` | `600000` | Maximum time to wait for one reply. |
| `BRIDGE_REUSE_CHATS` | `true` | Continue existing chats for follow-up requests. |
| `BRIDGE_MAX_PROMPT_CHARS` | `200000` | Reject prompts longer than this. See [Context size](#context-size). |
| `BRIDGE_MAX_IMAGES` | `10` | Maximum images per request. |
| `BRIDGE_MAX_IMAGE_MB` | `20` | Maximum size per image. |
| `BRIDGE_SELECTORS_FILE` | `selectors.local.json` in the project folder | DOM selector overrides (see below). |
| `BRIDGE_ENV_FILE` | `bridge.env` in the project folder | Settings file to load. |
| `BRIDGE_DEBUG` | `false` | Log every request. |

The rate limits are deliberately conservative. Agentic harnesses can fire many requests in a row, and both your quota and your account are on the line.

## Context size

On **Google AI Pro**, third-party guides put the Gemini app's context window at **1M tokens**, the same as on Ultra (Plus is reported at about 128K and the free tier at about 32K). The Gemini 4 Argon model itself supports 1,048,576 tokens through the API. Google doesn't clearly document a per-model limit for the app, so treat 1M as the ceiling, not a guarantee.

In practice the limit you'll hit first is how much text the prompt box accepts in one message. That's why `BRIDGE_MAX_PROMPT_CHARS` defaults to 200,000 characters (about 50K tokens). With chat reuse, follow-up turns only send the new messages, so long agent sessions keep building up context inside one chat rather than re-pasting everything. Raise the limit if your messages go through fine.

## When Gemini's UI changes

The bridge finds the prompt box, buttons, model picker, upload menu, Temporary chat toggle and replies with CSS selectors, all in [`src/selectors.js`](src/selectors.js). Google changes the page often, so these will break from time to time. You can fix them without editing code by creating `selectors.local.json`:

```json
{
  "input": ["div.new-editor-class[contenteditable=\"true\"]"],
  "responseContainer": ["model-response"]
}
```

Each key takes a list of selectors that are tried in order. Run with the browser visible (the default), open DevTools on the Gemini tab, and inspect the element that broke. PRs updating the defaults are very welcome.

## Roadmap

Ideas, roughly in order. PRs welcome.

- [ ] Selector fixes from real-world use, plus a `doctor` command that checks every selector against your live session
- [ ] PDF and other file attachments
- [ ] Anthropic Messages API (`/v1/messages`) and OpenAI Responses API endpoints
- [ ] Retry once with a format reminder when a reply looks like a botched tool call
- [ ] Multiple accounts you choose explicitly per request (e.g. `gemini-4-argon@work`), each in its own browser profile
- [ ] Optional cleanup that deletes the bridge's chats from your history after a conversation ends
- [ ] `setup.sh` for macOS / Linux

## Security notes

- The server listens on `127.0.0.1` only by default. Without an API key it rejects requests whose `Host` isn't localhost, which blocks DNS-rebinding attacks from websites you visit. It requires `Content-Type: application/json` and never sends CORS headers, so browsers can't call it cross-origin.
- Anyone who can reach the port can use your Gemini account. If you expose it on a network, set `BRIDGE_API_KEY`.
- The browser profile directory contains your Google session cookies. Treat it like a password.

## Development

```bash
npm test
```

Tests cover prompt building, tool-call parsing, image loading, the HTTP layer (streaming, tool calls, images, chat reuse, auth), the HTML→markdown converter, and end-to-end runs (keep and temporary modes, image upload) of the real browser driver against a local mock of the Gemini page (`test/fixtures/mock-gemini.html`). The browser tests need a Playwright Chromium and are skipped if none is installed.

## License

MIT
