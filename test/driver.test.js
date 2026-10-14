// Runs the real browser driver against a local mock of the Gemini DOM.
// Requires a Playwright Chromium (`npx playwright install chromium`); skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { GeminiChat } from '../src/gemini.js';
import { DEFAULT_SELECTORS } from '../src/selectors.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import net from 'node:net';
import { chromium } from 'playwright';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/mock-gemini.html'));

const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function setup(t, overrides = {}, selectors = DEFAULT_SELECTORS) {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-test-'));
  const config = loadConfig({
    geminiUrl: `${siteUrl}/app`,
    profileDir,
    // Default mode: start Chrome as a normal process and connect over its debugging port.
    // Playwright's Chromium binary stands in for Google Chrome here.
    browser: 'chrome',
    executablePath: fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : '',
    debugPort: await freePort(),
    // Chromium refuses to run as root (e.g. in CI containers) without this.
    chromeArgs: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
    browserChannel: '',
    headless: true,
    cdpUrl: '',
    minIntervalMs: 0,
    maxRequestsPerMinute: 0,
    responseTimeoutMs: 30_000,
    chatMode: 'keep',
    ...overrides,
  });
  const chat = new GeminiChat(config, selectors);
  try {
    await chat.start();
  } catch (err) {
    site.close();
    t.skip(`no Playwright Chromium available: ${err.message.split('\n')[0]}`);
    return null;
  }
  const api = createServer({ config, backend: chat });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const post = (body) =>
    fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const prompts = () => chat.page.evaluate(() => window.prompts);
  const teardown = async () => {
    await new Promise((r) => api.close(r));
    await chat.close();
    site.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  };
  return { chat, post, prompts, teardown };
}

test('driver end-to-end against mock Gemini page', async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { chat, post, teardown } = env;

  try {
    await t.test('selects model and streams a markdown reply', async () => {
      const res = await post({ stream: true, messages: [{ role: 'user', content: 'Say hi.\nTwo lines.' }] });
      const events = (await res.text())
        .split('\n\n')
        .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
        .map((l) => JSON.parse(l.slice(6)));
      const deltas = events.map((e) => e.choices[0]?.delta?.content).filter(Boolean);
      const text = deltas.join('');
      assert.match(text, /^Echo: \d+ chars\. \*\*Done\*\*\.$/);
      assert.ok(deltas.length > 2, 'expected incremental deltas');
      const prompts = await chat.page.evaluate(() => window.prompts);
      assert.equal(prompts[0].model, '4 Argon');
      assert.match(prompts[0].prompt, /## User\nSay hi\.\nTwo lines\./);
    });

    await t.test('tool call round trip continues the same chat', async () => {
      const messages = [{ role: 'user', content: 'Weather in Paris?' }];
      const first = await (await post({ messages, tools })).json();
      const msg = first.choices[0].message;
      assert.equal(first.choices[0].finish_reason, 'tool_calls', JSON.stringify(first));
      assert.equal(msg.content, 'Let me check.');
      assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' });
      const chatPath = new URL(chat.page.url()).pathname;

      messages.push(msg, { role: 'tool', tool_call_id: msg.tool_calls[0].id, content: '18C' });
      const second = await (await post({ messages, tools })).json();
      assert.match(second.choices[0].message.content, /^Echo:/);
      assert.equal(new URL(chat.page.url()).pathname, chatPath, 'should reopen the same chat');
      const prompts = await chat.page.evaluate(() => window.prompts);
      assert.ok(!prompts.at(-1).prompt.includes('Weather in Paris?'));
    });

    await t.test('attaches images through the upload menu', async () => {
      const res = await post({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in these?' },
              { type: 'image_url', image_url: { url: PNG } },
              { type: 'image_url', image_url: PNG },
            ],
          },
        ],
      });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      const last = (await env.prompts()).at(-1);
      assert.equal(last.images.length, 2);
      assert.deepEqual(last.images.map((i) => i.type), ['image/png', 'image/png']);
      assert.match(last.prompt, /What is in these\?\n\[Image 1 \(attached\)\]\n\[Image 2 \(attached\)\]/);
      assert.equal(last.temporary, false);
    });
  } finally {
    await teardown();
  }
});

test('temporary chat mode', async (t) => {
  const env = await setup(t, { chatMode: 'temporary', browser: 'playwright', executablePath: '' });
  if (!env) return;
  const { chat, post, prompts, teardown } = env;
  try {
    const messages = [{ role: 'user', content: 'first' }];
    const first = await (await post({ messages })).json();
    assert.match(first.choices[0].message.content, /^Echo:/);
    messages.push(first.choices[0].message, { role: 'user', content: 'second' });
    const second = await (await post({ messages })).json();
    assert.match(second.choices[0].message.content, /^Echo:/);

    const sent = await prompts();
    // Both turns went to the same temporary chat (one page, no reload), with only new messages the second time.
    assert.equal(sent.length, 2);
    assert.ok(sent.every((p) => p.temporary));
    assert.ok(sent.every((p) => p.url === '/app'), 'temporary chats should not get a URL');
    assert.ok(!sent[1].prompt.includes('first'));

    // A brand-new conversation starts a fresh temporary chat.
    await (await post({ messages: [{ role: 'user', content: 'other' }] })).json();
    const after = await prompts();
    assert.equal(after.length, 1, 'page should have been reloaded for a new temporary chat');
    assert.ok(after[0].temporary);
    assert.ok(chat.tempToken.startsWith('temp:'));
  } finally {
    await teardown();
  }
});

test('model picker: lists exact names and prefers an exact match', async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { chat, teardown } = env;
  try {
    await chat.open(chat.config.geminiUrl);
    assert.deepEqual(await chat.listModels(), ['Flash', '4 Argon', '4 Argon Deep Think']);
    assert.equal(await chat.selectModel('4 Argon Deep Think'), '4 Argon Deep Think');
    assert.equal(await chat.selectModel('4 argon'), '4 Argon', 'exact name beats a longer partial match');
    assert.equal(await chat.selectModel('Argon'), '4 Argon', 'partial match picks the first');
    await assert.rejects(chat.selectModel('Nope'), /Models there: "Flash", "4 Argon", "4 Argon Deep Think"/);
  } finally {
    await teardown();
  }
});

test('cli: models --save writes the chosen exact name to bridge.env', async (t) => {
  if (!fs.existsSync(chromium.executablePath())) return t.skip('no Playwright Chromium available');
  const { spawn } = await import('node:child_process');
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-cli-'));
  const envFile = path.join(dir, 'bridge.env');
  fs.writeFileSync(envFile, 'BRIDGE_PORT=9000\nMY_LINE=1\n');
  try {
    const cli = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js'), 'models', '--save'], {
      env: {
        ...process.env,
        BRIDGE_ENV_FILE: envFile,
        GEMINI_URL: `http://127.0.0.1:${site.address().port}/app`,
        BRIDGE_PROFILE_DIR: path.join(dir, 'profile'),
        BRIDGE_EXECUTABLE_PATH: chromium.executablePath(),
        BRIDGE_DEBUG_PORT: String(await freePort()),
        BRIDGE_HEADLESS: 'true',
        BRIDGE_CHROME_ARGS: process.getuid?.() === 0 ? '--no-sandbox' : '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    cli.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Pick a number')) cli.stdin.end('3\n');
    });
    cli.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => cli.on('exit', r));
    assert.equal(code, 0, out);
    assert.match(out, /1 {2}Flash\n {2}2 {2}4 Argon\n {2}3 {2}4 Argon Deep Think/);
    const saved = fs.readFileSync(envFile, 'utf8');
    assert.match(saved, /^GEMINI_MODEL_LABEL=4 Argon Deep Think$/m);
    assert.match(saved, /^BRIDGE_PORT=9000$/m);
    assert.match(saved, /^MY_LINE=1$/m);
  } finally {
    site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model picker: falls back to finding the button by its label, and writes a debug report', async (t) => {
  const selectors = {
    ...DEFAULT_SELECTORS,
    modelPickerButton: ['#not-there', '[data-gcb-picker="1"]'],
    currentModelLabel: ['[data-gcb-picker="1"]'],
  };
  const env = await setup(t, {}, selectors);
  if (!env) return;
  const { chat, teardown } = env;
  const report = path.join(os.tmpdir(), `gcb-report-${process.pid}.txt`);
  try {
    await chat.open(chat.config.geminiUrl);
    assert.deepEqual(await chat.listModels(), ['Flash', '4 Argon', '4 Argon Deep Think']);
    assert.equal(await chat.selectModel('gemini-4-argon'), '4 Argon', 'model ids match picker names');
    await chat.writeDebugReport(report);
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /button \|  \| bard-mode-menu-button \|/);
    assert.match(text, /Send message/);
  } finally {
    fs.rmSync(report, { force: true });
    await teardown();
  }
});

test('model picker: German UI, icon in the button, button re-rendered while loading', async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { chat, post, prompts, teardown } = env;
  try {
    chat.config.geminiUrl += '?de=1';
    await chat.open(chat.config.geminiUrl);
    assert.equal(await chat.currentModelText(), 'Fast', 'icon text is not part of the name');
    assert.deepEqual(await chat.listModels(), ['Fast', 'Thinking', 'Argon']);
    // The model id tools use still finds "Argon".
    assert.equal(await chat.selectModel('gemini-4-argon'), 'Argon');
    assert.equal(await chat.currentModelText(), 'Argon');

    chat.config.modelLabel = 'gemini-4-argon';
    const res = await (await post({ messages: [{ role: 'user', content: 'hallo' }] })).json();
    assert.match(res.choices[0].message.content, /^Echo:/);
    assert.equal((await prompts()).at(-1).model, 'Argon');
  } finally {
    await teardown();
  }
});
