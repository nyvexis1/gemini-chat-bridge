import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

class FakeBackend {
  constructor(replies) {
    this.replies = replies;
    this.calls = [];
  }
  async complete({ prompt, chatUrl, images, onDelta }) {
    this.calls.push({ prompt, chatUrl, images });
    const text = this.replies.shift() ?? 'ok';
    if (onDelta) for (const part of text.match(/[\s\S]{1,5}/g) || []) onDelta(part);
    return { text, chatUrl: chatUrl || `https://gemini.example/app/c${this.calls.length}`, model: 'Argon' };
  }
}

async function start(backend, overrides = {}) {
  const config = loadConfig({ minIntervalMs: 0, maxRequestsPerMinute: 0, port: 0, ...overrides });
  const server = createServer({ config, backend });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function readSse(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));
}

test('models endpoint and non-streaming completion', async () => {
  const backend = new FakeBackend(['Hello there']);
  const s = await start(backend);
  try {
    const models = await (await fetch(`${s.base}/v1/models`)).json();
    assert.equal(models.data[0].id, 'gemini-4-argon');
    const res = await post(s.base, { model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }] });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.choices[0].message.content, 'Hello there');
    assert.equal(json.choices[0].finish_reason, 'stop');
  } finally {
    await s.close();
  }
});

test('non-streaming tool call, then follow-up reuses the same chat', async () => {
  const backend = new FakeBackend([
    'Checking.\n```tool_calls\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```',
    'It is 18C in Paris.',
  ]);
  const s = await start(backend);
  try {
    const messages = [{ role: 'user', content: 'Weather in Paris?' }];
    const first = await (await post(s.base, { messages, tools })).json();
    const msg = first.choices[0].message;
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');

    messages.push(msg, { role: 'tool', tool_call_id: msg.tool_calls[0].id, content: '18C' });
    const second = await (await post(s.base, { messages, tools })).json();
    assert.equal(second.choices[0].message.content, 'It is 18C in Paris.');

    assert.equal(backend.calls[1].chatUrl, 'https://gemini.example/app/c1');
    assert.ok(!backend.calls[1].prompt.includes('Weather in Paris?'), 'follow-up should only send new messages');
    assert.match(backend.calls[1].prompt, /## Tool result \(get_weather\)\n18C/);
  } finally {
    await s.close();
  }
});

test('streaming text', async () => {
  const s = await start(new FakeBackend(['streamed reply text']));
  try {
    const res = await post(s.base, { stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const events = await readSse(res);
    const text = events.map((e) => e.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'streamed reply text');
    assert.equal(events.at(-1).choices[0].finish_reason, 'stop');
  } finally {
    await s.close();
  }
});

test('streaming tool call does not leak the tool block as content', async () => {
  const s = await start(new FakeBackend(['Let me look.\n\n```tool_calls\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Oslo"}}]}\n```']));
  try {
    const res = await post(s.base, { stream: true, tools, messages: [{ role: 'user', content: 'Oslo?' }] });
    const events = await readSse(res);
    const text = events.map((e) => e.choices[0]?.delta?.content || '').join('');
    assert.ok(!text.includes('tool_calls'), `content leaked: ${text}`);
    assert.match(text, /Let me look\./);
    const tc = events.flatMap((e) => e.choices[0]?.delta?.tool_calls || []);
    assert.equal(tc[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(tc[0].function.arguments), { city: 'Oslo' });
    assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
  } finally {
    await s.close();
  }
});

test('auth, host check and content-type', async () => {
  const s = await start(new FakeBackend([]), { apiKey: 'secret' });
  try {
    assert.equal((await post(s.base, { messages: [{ role: 'user', content: 'x' }] })).status, 401);
    assert.equal((await post(s.base, { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer secret' })).status, 200);
  } finally {
    await s.close();
  }
  const open = await start(new FakeBackend([]));
  try {
    const bad = await fetch(`${open.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(bad.status, 415);
    // fetch() won't let us spoof Host, so use a raw request (simulates DNS rebinding).
    const status = await new Promise((resolve, reject) => {
      const u = new URL(open.base);
      const req = http.request(
        { host: u.hostname, port: u.port, path: '/v1/models', headers: { host: 'evil.example' } },
        (res) => resolve(res.statusCode),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await open.close();
  }
});

test('images are loaded and passed to the backend; bad images give 400', async () => {
  const backend = new FakeBackend(['a cat']);
  const s = await start(backend);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  try {
    const ok = await post(s.base, { messages: [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: png } }] }] });
    assert.equal(ok.status, 200);
    assert.equal(backend.calls[0].images.length, 1);
    assert.equal(backend.calls[0].images[0].mimeType, 'image/png');
    const bad = await post(s.base, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }] });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});
