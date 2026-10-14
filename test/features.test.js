import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { brokenToolCallReason, parseReply } from '../src/prompt.js';
import { toOpenAIRequest } from '../src/anthropic.js';

const oaTools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
const anTools = [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
const CALL = '```tool_calls\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```';

class FakeBackend {
  constructor(replies, name = 'default') {
    this.replies = replies;
    this.name = name;
    this.calls = [];
  }
  async complete({ prompt, chatUrl, images, onDelta }) {
    this.calls.push({ prompt, chatUrl, images });
    const text = this.replies.shift() ?? 'ok';
    if (onDelta) for (const part of text.match(/[\s\S]{1,5}/g) || []) onDelta(part);
    return { text, chatUrl: chatUrl || `https://gemini.example/${this.name}/c${this.calls.length}` };
  }
}

async function start(opts, overrides = {}) {
  const config = loadConfig({ minIntervalMs: 0, maxRequestsPerMinute: 0, ...overrides });
  const server = createServer({ config, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, close: () => new Promise((r) => server.close(r)) };
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event: ev, data: data && data !== '[DONE]' ? JSON.parse(data) : data };
    });
}

// ------------------------------------------------------------------ retry

test('brokenToolCallReason detects botched calls and leaves normal answers alone', () => {
  const req = { tools: oaTools };
  const check = (text, r = req) => brokenToolCallReason(text, r, parseReply(text, r));
  assert.equal(check('It is sunny.'), null);
  assert.equal(check(CALL), null);
  assert.match(check('```tool_calls\n{"tool_calls": [{"name": "get_weather", "arguments": {city: Paris}}]}\n```'), /not valid JSON/);
  assert.match(check('Calling now.\n## Tool result (get_weather)\n20C'), /tool result itself/);
  assert.match(check('I will use {"name": "get_weather"} for this'), /not in the tool_calls format/);
  assert.match(check('It is sunny.', { tools: oaTools, tool_choice: 'required' }), /required/);
  assert.equal(check('```tool_calls\n{bad}\n```', {}), null, 'no tools -> never a broken tool call');
});

test('a broken tool call is retried once in the same chat', async () => {
  const backend = new FakeBackend(['```tool_calls\n{"tool_calls": [{"name": "get_weather", arguments: {}}]}\n```', CALL]);
  const s = await start({ backend });
  try {
    const json = await (await s.post('/v1/chat/completions', { tools: oaTools, messages: [{ role: 'user', content: 'Paris?' }] })).json();
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(backend.calls.length, 2);
    assert.equal(backend.calls[1].chatUrl, 'https://gemini.example/default/c1');
    assert.match(backend.calls[1].prompt, /could not be used/);
  } finally {
    await s.close();
  }
});

test('retry can be turned off, and plain answers are not retried', async () => {
  const off = new FakeBackend(['```tool_calls\n{broken\n```']);
  const s1 = await start({ backend: off }, { toolRetry: false });
  try {
    await (await s1.post('/v1/chat/completions', { tools: oaTools, messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(off.calls.length, 1);
  } finally {
    await s1.close();
  }
  const plain = new FakeBackend(['Just text.']);
  const s2 = await start({ backend: plain });
  try {
    await (await s2.post('/v1/chat/completions', { tools: oaTools, messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(plain.calls.length, 1);
  } finally {
    await s2.close();
  }
});

// ------------------------------------------------------------------ accounts

test('model@account routes to that account; unknown accounts are 404', async () => {
  const backends = {};
  const createBackend = (name) => (backends[name] = new FakeBackend([`from ${name}`], name));
  const s = await start({ createBackend }, { accounts: ['second'] });
  try {
    const models = await (await fetch(`${s.base}/v1/models`)).json();
    assert.deepEqual(models.data.map((m) => m.id), ['gemini-4-argon', 'gemini-4-argon@second']);

    const a = await (await s.post('/v1/chat/completions', { model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }] })).json();
    const b = await (await s.post('/v1/chat/completions', { model: 'gemini-4-argon@second', messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(a.choices[0].message.content, 'from default');
    assert.equal(b.choices[0].message.content, 'from second');
    assert.equal(b.model, 'gemini-4-argon@second');

    const missing = await s.post('/v1/chat/completions', { model: 'gemini-4-argon@nope', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /Unknown account "nope"/);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ Anthropic

test('toOpenAIRequest converts system, images, tool_use and tool_result', () => {
  const req = toOpenAIRequest({
    model: 'gemini-4-argon',
    system: [{ type: 'text', text: 'Be brief.' }],
    tools: [...anTools, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '18C' }] }, { type: 'text', text: 'thanks' }] },
    ],
  });
  assert.deepEqual(req.messages[0], { role: 'system', content: 'Be brief.' });
  assert.deepEqual(req.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.equal(req.messages[2].tool_calls[0].function.arguments, '{"city":"Paris"}');
  assert.deepEqual(req.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '18C' });
  assert.deepEqual(req.messages[4], { role: 'user', content: 'thanks' });
  assert.equal(req.tools.length, 1, 'server tools without input_schema are dropped');
  assert.equal(req.tool_choice, 'required');
  assert.equal(req.parallel_tool_calls, false);
});

test('/v1/messages: text, tool_use, then tool_result continues the same chat', async () => {
  const backend = new FakeBackend(['Let me check.\n' + CALL, 'It is 18C.']);
  const s = await start({ backend });
  try {
    const messages = [{ role: 'user', content: 'Weather in Paris?' }];
    const res = await s.post('/v1/messages', { model: 'gemini-4-argon', max_tokens: 1024, tools: anTools, messages }, { 'anthropic-version': '2023-06-01' });
    const first = await res.json();
    assert.equal(res.status, 200);
    assert.equal(first.type, 'message');
    assert.equal(first.stop_reason, 'tool_use');
    assert.deepEqual(first.content[0], { type: 'text', text: 'Let me check.' });
    const use = first.content[1];
    assert.equal(use.type, 'tool_use');
    assert.match(use.id, /^toolu_/);
    assert.deepEqual(use.input, { city: 'Paris' });

    messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '18C' }] });
    const second = await (await s.post('/v1/messages', { model: 'gemini-4-argon', max_tokens: 1024, tools: anTools, messages })).json();
    assert.equal(second.stop_reason, 'end_turn');
    assert.deepEqual(second.content, [{ type: 'text', text: 'It is 18C.' }]);
    assert.equal(backend.calls[1].chatUrl, 'https://gemini.example/default/c1', 'should continue the same chat');
    assert.ok(!backend.calls[1].prompt.includes('Weather in Paris?'));
  } finally {
    await s.close();
  }
});

test('/v1/messages streaming emits the Anthropic event sequence', async () => {
  const s = await start({ backend: new FakeBackend(['On it.\n\n' + CALL]) });
  try {
    const res = await s.post('/v1/messages', { model: 'gemini-4-argon', max_tokens: 100, stream: true, tools: anTools, messages: [{ role: 'user', content: 'Paris?' }] });
    const events = sseEvents(await res.text());
    const names = events.map((e) => e.event);
    assert.equal(names[0], 'message_start');
    assert.equal(names.at(-1), 'message_stop');
    const text = events.filter((e) => e.data?.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
    assert.equal(text.trim(), 'On it.');
    assert.ok(!text.includes('tool_calls'));
    const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.equal(toolStart.data.content_block.name, 'get_weather');
    const json = events.find((e) => e.data?.delta?.type === 'input_json_delta').data.delta.partial_json;
    assert.deepEqual(JSON.parse(json), { city: 'Paris' });
    assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  } finally {
    await s.close();
  }
});

test('/v1/messages count_tokens, errors and auth use Anthropic shapes', async () => {
  const s = await start({ backend: new FakeBackend([]) }, { apiKey: 'k' });
  try {
    const unauth = await s.post('/v1/messages', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).error.type, 'authentication_error');

    const count = await (await s.post('/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'hello there' }] }, { 'x-api-key': 'k' })).json();
    assert.ok(count.input_tokens > 0);

    const bad = await s.post('/v1/messages', { messages: [] }, { 'x-api-key': 'k' });
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.equal(err.type, 'error');
    assert.equal(err.error.type, 'invalid_request_error');
  } finally {
    await s.close();
  }
});
