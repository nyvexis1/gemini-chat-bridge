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

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/mock-gemini.html'));

const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function setup(t, overrides = {}) {
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
    browserChannel: '',
    headless: true,
    cdpUrl: '',
    minIntervalMs: 0,
    maxRequestsPerMinute: 0,
    responseTimeoutMs: 30_000,
    chatMode: 'keep',
    ...overrides,
  });
  const chat = new GeminiChat(config, DEFAULT_SELECTORS);
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
  const env = await setup(t, { chatMode: 'temporary' });
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
