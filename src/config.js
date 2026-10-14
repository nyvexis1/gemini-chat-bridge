import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;

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

    profileDir: env.BRIDGE_PROFILE_DIR || path.join(os.homedir(), '.gemini-chat-bridge', 'profile'),
    // Connect to a Chrome you already run with --remote-debugging-port instead of launching one.
    cdpUrl: env.BRIDGE_CDP_URL || '',
    // "chrome" uses your installed Google Chrome; empty uses Playwright's Chromium.
    browserChannel: env.BRIDGE_BROWSER_CHANNEL ?? 'chrome',
    executablePath: env.BRIDGE_EXECUTABLE_PATH || '',
    headless: bool('BRIDGE_HEADLESS', false),

    // Rate limiting. These protect your account and your quota; defaults are deliberately conservative.
    maxConcurrency: int('BRIDGE_MAX_CONCURRENCY', 1),
    minIntervalMs: int('BRIDGE_MIN_INTERVAL_MS', 3000),
    maxRequestsPerMinute: int('BRIDGE_MAX_RPM', 10),
    maxQueue: int('BRIDGE_MAX_QUEUE', 20),

    responseTimeoutMs: int('BRIDGE_RESPONSE_TIMEOUT_MS', 10 * 60 * 1000),
    // Continue an existing Gemini chat when a request extends a conversation the bridge already answered.
    reuseChats: bool('BRIDGE_REUSE_CHATS', true),
    maxPromptChars: int('BRIDGE_MAX_PROMPT_CHARS', 200_000),

    selectorsFile: env.BRIDGE_SELECTORS_FILE || 'selectors.local.json',
    debug: bool('BRIDGE_DEBUG', false),
    ...overrides,
  };
  return config;
}

export function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
