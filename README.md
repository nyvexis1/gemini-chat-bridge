# gemini-chat-bridge

A local, OpenAI-compatible API that drives **your own** logged-in Gemini web chat, so you can point coding tools and harnesses at the model you already pay for in the Gemini app (e.g. Gemini 4 Argon on a plan that only offers it in chat).

```
your harness ──OpenAI API──▶ gemini-chat-bridge (localhost) ──▶ your browser, signed in to gemini.google.com
```

- **Bring your own plan.** Every request runs in your browser session, on your account, and counts against your plan's normal chat limits. The bridge never shares, pools, or resells access.
- **OpenAI-compatible:** `GET /v1/models`, `POST /v1/chat/completions`, streaming (SSE), **tool / function calling**, `response_format` JSON modes.
- **No evasion.** No fingerprint spoofing, no hiding automation flags, no captcha solving, no account or IP rotation. If Google shows a challenge or blocks the session, the bridge stops and tells you.

> [!WARNING]
> **Unofficial, and very likely against Google's terms.** The Gemini web app isn't an API. Automating it probably violates the [Google Terms of Service](https://policies.google.com/terms), and Google has suspended access for people who wired subscriptions into third-party tools. **Your account's Gemini access could be restricted. Use at your own risk.** This project is not affiliated with or endorsed by Google.

## Requirements

- Node.js 20+
- A Google account with a Gemini plan that includes the model you want
- Google Chrome (recommended), or Playwright's Chromium (`npx playwright install chromium`)

## Quick start

```bash
git clone <this repo> && cd <this repo>
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
4. **Chat reuse.** When the next request extends a conversation the bridge just answered (for example, your harness sends back the tool results), the bridge reopens that Gemini chat and sends **only the new messages**. That keeps prompts short and keeps context in one place. If the prefix doesn't match (edited history, different tools), it starts a fresh chat with the full transcript. Disable with `BRIDGE_REUSE_CHATS=false`.

### Limitations

- Prompted tool calling is **less reliable than a native API**. The model usually follows the format, but occasionally it won't. Strong models do best.
- Token `usage` numbers are rough estimates (characters ÷ 4); the web UI doesn't report real counts.
- Images and file attachments in requests aren't supported yet; they're replaced with a placeholder.
- `temperature`, `max_tokens`, `stop` and similar sampling parameters are ignored (the web UI has no such controls).
- Every request becomes, or continues, a chat in your Gemini history.
- Requests are processed one at a time by default.

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
| `GEMINI_URL` | `https://gemini.google.com/app` | Gemini app URL. |
| `BRIDGE_PROFILE_DIR` | `~/.gemini-chat-bridge/profile` | Browser profile holding your login. |
| `BRIDGE_CDP_URL` | *(none)* | Attach to an existing Chrome (e.g. `http://127.0.0.1:9222`). |
| `BRIDGE_BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or empty for Playwright's Chromium. |
| `BRIDGE_EXECUTABLE_PATH` | *(none)* | Explicit browser binary. |
| `BRIDGE_HEADLESS` | `false` | Run the browser without a window. Off by default so you can see what it's doing and spot challenges. |
| `BRIDGE_MAX_CONCURRENCY` | `1` | Requests driven at the same time. |
| `BRIDGE_MIN_INTERVAL_MS` | `3000` | Minimum gap between requests. |
| `BRIDGE_MAX_RPM` | `10` | Maximum requests per minute. |
| `BRIDGE_MAX_QUEUE` | `20` | Queued requests before returning 429. |
| `BRIDGE_RESPONSE_TIMEOUT_MS` | `600000` | Maximum time to wait for one reply. |
| `BRIDGE_REUSE_CHATS` | `true` | Continue existing chats for follow-up requests. |
| `BRIDGE_MAX_PROMPT_CHARS` | `200000` | Reject prompts longer than this. |
| `BRIDGE_SELECTORS_FILE` | `selectors.local.json` | DOM selector overrides (see below). |
| `BRIDGE_DEBUG` | `false` | Log every request. |

The rate limits are deliberately conservative. Agentic harnesses can fire many requests in a row, and both your quota and your account are on the line.

## When Gemini's UI changes

The bridge finds the prompt box, buttons, model picker and replies with CSS selectors, all in [`src/selectors.js`](src/selectors.js). Google changes the page often, so these will break from time to time. You can fix them without editing code by creating `selectors.local.json`:

```json
{
  "input": ["div.new-editor-class[contenteditable=\"true\"]"],
  "responseContainer": ["model-response"]
}
```

Each key takes a list of selectors that are tried in order. Run with the browser visible (the default), open DevTools on the Gemini tab, and inspect the element that broke. PRs updating the defaults are very welcome.

## Security notes

- The server listens on `127.0.0.1` only by default. Without an API key it rejects requests whose `Host` isn't localhost, which blocks DNS-rebinding attacks from websites you visit. It requires `Content-Type: application/json` and never sends CORS headers, so browsers can't call it cross-origin.
- Anyone who can reach the port can use your Gemini account. If you expose it on a network, set `BRIDGE_API_KEY`.
- The browser profile directory contains your Google session cookies. Treat it like a password.

## Development

```bash
npm test
```

Tests cover prompt building, tool-call parsing, the HTTP layer (streaming, tool calls, chat reuse, auth), the HTML→markdown converter, and an end-to-end run of the real browser driver against a local mock of the Gemini page (`test/fixtures/mock-gemini.html`). The browser tests need a Playwright Chromium and are skipped if none is installed.

## License

MIT
