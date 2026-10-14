#!/usr/bin/env node
import readline from 'node:readline/promises';
import { loadConfig, profileDirFor, accountConfig, setEnvValue, envFilePath } from '../src/config.js';
import { AccountPool } from '../src/accounts.js';
import { loadSelectors } from '../src/selectors.js';
import { GeminiChat } from '../src/gemini.js';
import { createServer } from '../src/server.js';

const log = (msg) => console.error(`[bridge ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const HELP = `gemini-chat-bridge: local OpenAI-compatible API on top of your own Gemini web chat.

Usage:
  gemini-chat-bridge login [account]   Open a browser window to sign in to Gemini (once per account).
  gemini-chat-bridge serve             Start the API server (default).
  gemini-chat-bridge models [account]  List the exact model names in your Gemini picker.
                     models --save     ...and pick the one the bridge should use.
  gemini-chat-bridge accounts          List configured accounts.

Configuration is via environment variables; see README.md.

This is an unofficial tool. Automating the Gemini web app is very likely against
Google's terms and may get your account's Gemini access restricted. Use at your own risk.`;

async function login(config, selectors, account = 'default') {
  if (account !== 'default' && !config.accounts.includes(account)) {
    console.error(`Unknown account "${account}". Add it to BRIDGE_ACCOUNTS first (setup does this for you).`);
    process.exit(2);
  }
  const cfg = accountConfig(config, account);
  let chat;
  try {
    chat = await new GeminiChat(cfg, selectors, log).start({ headless: false, url: config.geminiUrl });
    if (!/^https?:/.test(chat.page.url())) await chat.page.goto(config.geminiUrl, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    log(`could not open the browser: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nA Chrome window is open for account "${account}".\n` +
      '  1. Sign in to your Google account in that window.\n' +
      '  2. Make sure Gemini loads and the model you want is available.\n' +
      '  3. Come back here and press Enter (leave the Chrome window open).\n',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter when you are signed in... ');
  rl.close();
  try {
    await chat.open(config.geminiUrl);
    log('signed in: OK');
    const names = await chat.listModels();
    if (names.length) log(`models in your picker: ${names.map((n) => JSON.stringify(n)).join(', ')}`);
    const model = await chat.selectModel();
    log(`"${model || 'unknown'}" selected`);
  } catch (err) {
    log(`check failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await chat.close();
  }
}

async function models(config, selectors, account, save) {
  if (account !== 'default' && !config.accounts.includes(account)) {
    console.error(`Unknown account "${account}".`);
    process.exit(2);
  }
  let chat;
  try {
    chat = await new GeminiChat(accountConfig(config, account), selectors, log).start({ url: config.geminiUrl });
    await chat.open(config.geminiUrl);
    const names = await chat.listModels();
    if (!names.length) {
      const report = await chat.writeDebugReport().catch(() => null);
      log('could not read the model picker. Is the account signed in, and does the picker show on the Gemini page?');
      if (report) {
        log(`saved a report of the page's buttons to ${report}`);
        log('please send it in a GitHub issue so the picker can be fixed (it contains button labels only, no chats or emails).');
      }
      process.exitCode = 1;
      return;
    }
    console.log(`\nModels in Gemini's picker (currently using "${config.modelLabel}"):\n`);
    names.forEach((n, i) => console.log(`  ${i + 1}  ${n}`));
    console.log('');
    if (!save) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Pick a number (Enter to cancel): ')).trim();
    rl.close();
    const pick = Number.parseInt(answer, 10);
    if (!answer || !(pick >= 1 && pick <= names.length)) {
      console.log('Nothing changed.');
      return;
    }
    setEnvValue('GEMINI_MODEL_LABEL', names[pick - 1]);
    console.log(`Saved: the bridge will use "${names[pick - 1]}" (${envFilePath()}).`);
  } catch (err) {
    log(`error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await chat?.close();
  }
}

async function serve(config, selectors) {
  const pool = new AccountPool(config, (account, accountConfig) => new GeminiChat(accountConfig, selectors, (m) => log(`[${account}] ${m}`)), log);
  // Start the default account now so login problems show up immediately; others start on first use.
  try {
    const { backend } = await pool.get('default');
    await backend.open(config.geminiUrl);
    log('Gemini session OK');
  } catch (err) {
    log(`warning: ${err.message}`);
  }
  const server = createServer({ config, pool, log });
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}/v1  (chat mode: ${config.chatMode})`);
    for (const name of pool.names) log(`  model "${name === 'default' ? config.modelId : `${config.modelId}@${name}`}" -> account ${name}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.apiKey) {
      log('WARNING: bound to a non-local address without BRIDGE_API_KEY; anyone who can reach this port can use your account.');
    }
  });
  const shutdown = async () => {
    log('shutting down');
    server.close();
    await pool.closeAll();
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
  if (cmd === 'login') await login(config, selectors, process.argv[3] || 'default');
  else if (cmd === 'models') {
    const rest = process.argv.slice(3);
    await models(config, selectors, rest.find((a) => !a.startsWith('--')) || 'default', rest.includes('--save'));
  } else if (cmd === 'accounts') for (const name of ['default', ...config.accounts]) console.log(`${name}\t${profileDirFor(config, name)}`);
  else if (cmd === 'serve') await serve(config, selectors);
  else {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(2);
  }
}
