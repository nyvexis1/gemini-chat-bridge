#!/usr/bin/env node
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { loadSelectors } from '../src/selectors.js';
import { GeminiChat } from '../src/gemini.js';
import { createServer } from '../src/server.js';

const log = (msg) => console.error(`[bridge ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const HELP = `gemini-chat-bridge: local OpenAI-compatible API on top of your own Gemini web chat.

Usage:
  gemini-chat-bridge login    Open a browser window so you can sign in to Gemini (once).
  gemini-chat-bridge serve    Start the API server (default).

Configuration is via environment variables; see README.md.

This is an unofficial tool. Automating the Gemini web app is very likely against
Google's terms and may get your account's Gemini access restricted. Use at your own risk.`;

async function login(config, selectors) {
  const chat = await new GeminiChat(config, selectors, log).start({ headless: false });
  await chat.page.goto(config.geminiUrl, { waitUntil: 'domcontentloaded' });
  console.log(
    '\nA browser window is open. Sign in to your Google account there and make sure Gemini loads.\n' +
      'Press Enter here when you are done.',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('');
  rl.close();
  try {
    await chat.open(config.geminiUrl);
    log('logged in: OK');
    const model = await chat.selectModel();
    log(`model picker: "${model || 'unknown'}" selected`);
  } catch (err) {
    log(`check failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await chat.close();
  }
}

async function serve(config, selectors) {
  const chat = await new GeminiChat(config, selectors, log).start();
  try {
    await chat.open(config.geminiUrl);
    log('Gemini session OK');
  } catch (err) {
    log(`warning: ${err.message}`);
  }
  const server = createServer({ config, backend: chat, log });
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}/v1  (model id: ${config.modelId})`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.apiKey) {
      log('WARNING: bound to a non-local address without BRIDGE_API_KEY; anyone who can reach this port can use your account.');
    }
  });
  const shutdown = async () => {
    log('shutting down');
    server.close();
    await chat.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const cmd = process.argv[2] || 'serve';
if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(HELP);
} else {
  const config = loadConfig();
  const selectors = loadSelectors(config.selectorsFile);
  if (cmd === 'login') await login(config, selectors);
  else if (cmd === 'serve') await serve(config, selectors);
  else {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(2);
  }
}
