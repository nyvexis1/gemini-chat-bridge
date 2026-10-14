import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal KEY=VALUE parser for bridge.env (written by setup.bat). Real environment variables win.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const file = process.env.BRIDGE_ENV_FILE || path.join(PROJECT_ROOT, 'bridge.env');
  const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = loadEnv();

function int(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

function accountList(value) {
  const names = (value || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!ACCOUNT_NAME_RE.test(n)) throw new Error(`Invalid account name "${n}" in BRIDGE_ACCOUNTS (use letters, digits, - and _).`);
  }
  return [...new Set(names.filter((n) => n.toLowerCase() !== 'default'))];
}

/** Browser profile directory for an account. */
export function profileDirFor(config, account) {
  if (!account || account === 'default') return config.profileDir;
  return path.join(config.profilesRoot, account);
}

/** Debugging port for an account's Chrome. */
export function debugPortFor(config, account) {
  if (!account || account === 'default') return config.debugPort;
  return config.debugPort + 1 + config.accounts.indexOf(account);
}

/** Config for one account: its own profile folder and debugging port. */
export function accountConfig(config, account) {
  return {
    ...config,
    profileDir: profileDirFor(config, account),
    debugPort: debugPortFor(config, account),
    cdpUrl: !account || account === 'default' ? config.cdpUrl : '',
  };
}

function browserMode(value) {
  const v = (value || 'chrome').toLowerCase();
  if (v === 'chrome' || v === 'playwright') return v;
  throw new Error(`BRIDGE_BROWSER must be "chrome" or "playwright", got "${value}"`);
}

function chatMode(value) {
  const v = (value || 'keep').toLowerCase();
  if (v === 'keep' || v === 'temporary') return v;
  throw new Error(`BRIDGE_CHAT_MODE must be "keep" or "temporary", got "${value}"`);
}

export function loadConfig(overrides = {}) {
  const config = {
    host: env.BRIDGE_HOST || '127.0.0.1',
    port: int('BRIDGE_PORT', 8787),
    // Optional bearer token clients must send. Strongly recommended if you bind to anything but localhost.
    apiKey: env.BRIDGE_API_KEY || '',

    geminiUrl: env.GEMINI_URL || 'https://gemini.google.com/app',
    // Text shown in Gemini's model picker for the model you want. Matched case-insensitively as a substring.
    modelLabel: env.GEMINI_MODEL_LABEL || 'Argon',
    // Model id advertised on /v1/models and accepted in requests.
    modelId: env.BRIDGE_MODEL_ID || 'gemini-4-argon',
    // Fail requests if the requested model can't be selected, instead of using whatever is active.
    strictModel: bool('GEMINI_STRICT_MODEL', true),

    // Browser profile of the "default" account.
    profileDir: env.BRIDGE_PROFILE_DIR || path.join(os.homedir(), '.gemini-chat-bridge', 'profile'),
    // Extra accounts, each with its own browser profile under profilesRoot/<name>.
    // Pick one per request with model "<model id>@<name>".
    accounts: accountList(env.BRIDGE_ACCOUNTS),
    profilesRoot: env.BRIDGE_PROFILES_ROOT || path.join(os.homedir(), '.gemini-chat-bridge', 'profiles'),
    // Connect to a Chrome you already run with --remote-debugging-port instead of launching one.
    cdpUrl: env.BRIDGE_CDP_URL || '',
    // "chrome": start your normal installed Chrome and connect to it (needed for Google sign-in).
    // "playwright": let Playwright launch the browser in automation mode (Google sign-in won't work there).
    browser: browserMode(env.BRIDGE_BROWSER),
    // Local debugging port for the default account's Chrome; extra accounts use the next ports up.
    debugPort: int('BRIDGE_DEBUG_PORT', 9333),
    // Only for BRIDGE_BROWSER=playwright: "chrome", "msedge", or empty for Playwright's Chromium.
    browserChannel: env.BRIDGE_BROWSER_CHANNEL ?? 'chrome',
    executablePath: env.BRIDGE_EXECUTABLE_PATH || '',
    // Extra command-line flags for Chrome, separated by spaces (e.g. "--no-sandbox" when running as root on Linux).
    chromeArgs: (env.BRIDGE_CHROME_ARGS || '').split(/\s+/).filter(Boolean),
    headless: bool('BRIDGE_HEADLESS', false),

    // "keep": chats are saved to your Gemini history and follow-ups continue the same chat.
    // "temporary": each new conversation opens a Gemini Temporary chat that isn't saved to history.
    chatMode: chatMode(env.BRIDGE_CHAT_MODE),

    // Rate limiting. These protect your account and your quota; defaults are deliberately conservative.
    // Requests are always handled one at a time: the bridge drives a single browser tab.
    maxConcurrency: 1,
    minIntervalMs: int('BRIDGE_MIN_INTERVAL_MS', 3000),
    maxRequestsPerMinute: int('BRIDGE_MAX_RPM', 10),
    maxQueue: int('BRIDGE_MAX_QUEUE', 20),

    responseTimeoutMs: int('BRIDGE_RESPONSE_TIMEOUT_MS', 10 * 60 * 1000),
    // Continue an existing Gemini chat when a request extends a conversation the bridge already answered.
    reuseChats: bool('BRIDGE_REUSE_CHATS', true),
    // Ask the model once more, in the same chat, when a reply looks like a botched tool call.
    toolRetry: bool('BRIDGE_TOOL_RETRY', true),
    maxPromptChars: int('BRIDGE_MAX_PROMPT_CHARS', 200_000),
    maxImages: int('BRIDGE_MAX_IMAGES', 10),
    maxImageBytes: int('BRIDGE_MAX_IMAGE_MB', 20) * 1024 * 1024,

    selectorsFile: env.BRIDGE_SELECTORS_FILE || path.join(PROJECT_ROOT, 'selectors.local.json'),
    debug: bool('BRIDGE_DEBUG', false),
    ...overrides,
  };
  return config;
}

export function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
