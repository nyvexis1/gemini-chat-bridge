import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseReply } from '../src/prompt.js';

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

test('buildPrompt includes system, tools and transcript', () => {
  const p = buildPrompt({
    tools,
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
    ],
  });
  assert.match(p, /## System\nBe terse\./);
  assert.match(p, /"name":"get_weather"/);
  assert.match(p, /```tool_calls/);
  assert.match(p, /## User\nWeather in Paris\?/);
  assert.ok(p.trimEnd().endsWith('## Assistant'));
});

test('buildPrompt renders assistant tool calls and tool results', () => {
  const p = buildPrompt({
    tools,
    messages: [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '18C sunny' },
    ],
  });
  assert.match(p, /\{"tool_calls":\[\{"name":"get_weather","arguments":\{"city":"Paris"\}\}\]\}/);
  assert.match(p, /## Tool result \(get_weather\)\n18C sunny/);
});

test('buildPrompt continuing a chat sends only new messages', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ];
  const p = buildPrompt({ messages }, { startIndex: 2 });
  assert.ok(!p.includes('first'));
  assert.match(p, /## User\nsecond/);
});

test('tool_choice none omits tools', () => {
  const p = buildPrompt({ tools, tool_choice: 'none', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!p.includes('get_weather'));
});

test('parseReply extracts fenced tool_calls block', () => {
  const r = parseReply('Checking.\n\n```tool_calls\n{"tool_calls": [{"name": "get_weather", "arguments": {"city": "Paris"}}]}\n```', { tools });
  assert.equal(r.content, 'Checking.');
  assert.equal(r.tool_calls.length, 1);
  assert.equal(r.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(r.tool_calls[0].function.arguments), { city: 'Paris' });
  assert.match(r.tool_calls[0].id, /^call_/);
});

test('parseReply accepts json fence, bare JSON and string arguments', () => {
  const a = parseReply('```json\n{"tool_calls":[{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}]}\n```', { tools });
  assert.deepEqual(JSON.parse(a.tool_calls[0].function.arguments), { city: 'Rome' });
  assert.equal(a.content, null);

  const b = parseReply('Sure {"tool_calls":[{"name":"get_weather","arguments":{"city":"Oslo"}}]}', { tools });
  assert.equal(b.tool_calls.length, 1);
  assert.equal(b.content, 'Sure');
});

test('parseReply ignores unknown tools and ordinary code', () => {
  const unknown = parseReply('```tool_calls\n{"tool_calls":[{"name":"rm_rf","arguments":{}}]}\n```', { tools });
  assert.equal(unknown.tool_calls.length, 0);
  const code = parseReply('Here:\n```js\nconsole.log(1)\n```', { tools });
  assert.equal(code.tool_calls.length, 0);
  assert.match(code.content, /console\.log/);
});

test('parseReply respects parallel_tool_calls=false and no tools', () => {
  const two = '```tool_calls\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"A"}},{"name":"get_weather","arguments":{"city":"B"}}]}\n```';
  assert.equal(parseReply(two, { tools }).tool_calls.length, 2);
  assert.equal(parseReply(two, { tools, parallel_tool_calls: false }).tool_calls.length, 1);
  assert.equal(parseReply(two, {}).tool_calls.length, 0);
});

test('parseReply strips json fence for json response_format', () => {
  const r = parseReply('```json\n{"a":1}\n```', { response_format: { type: 'json_object' } });
  assert.equal(r.content, '{"a":1}');
});
