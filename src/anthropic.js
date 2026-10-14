// Translates Anthropic Messages API requests/responses to and from the
// OpenAI-shaped requests the rest of the bridge works with.

function imagePart(source) {
  if (!source) return null;
  if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url } };
  return null;
}

// Anthropic content (string or blocks) -> OpenAI content parts. Non-text,
// non-image blocks (documents, thinking, ...) are dropped or noted.
function toParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts = [];
  for (const block of content || []) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'image') {
      const p = imagePart(block.source);
      if (p) parts.push(p);
    } else if (block.type === 'document') parts.push({ type: 'text', text: '[document omitted: not supported by this bridge]' });
  }
  return parts;
}

function simplify(parts) {
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

function toolChoice(choice) {
  if (!choice) return {};
  const out = {};
  if (choice.type === 'auto') out.tool_choice = 'auto';
  else if (choice.type === 'any') out.tool_choice = 'required';
  else if (choice.type === 'none') out.tool_choice = 'none';
  else if (choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } };
  if (choice.disable_parallel_tool_use) out.parallel_tool_calls = false;
  return out;
}

/** Anthropic /v1/messages body -> OpenAI chat.completions body. */
export function toOpenAIRequest(body) {
  const messages = [];
  const sys = systemText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of body.messages || []) {
    if (msg.role === 'assistant') {
      const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const out = { role: 'assistant', content: text || null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }
    // user: tool_result blocks become separate tool messages, the rest stays a user message.
    if (typeof msg.content === 'string') {
      messages.push({ role: 'user', content: msg.content });
      continue;
    }
    const rest = [];
    for (const block of msg.content || []) {
      if (block.type === 'tool_result') {
        let parts = toParts(block.content ?? '');
        if (block.is_error) parts = [{ type: 'text', text: '(tool returned an error)' }, ...parts];
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: simplify(parts) });
      } else {
        rest.push(block);
      }
    }
    const parts = toParts(rest);
    if (parts.length) messages.push({ role: 'user', content: simplify(parts) });
  }

  const req = { model: body.model, messages, stream: Boolean(body.stream), ...toolChoice(body.tool_choice) };
  if (Array.isArray(body.tools) && body.tools.length) {
    // Server tools (web_search, bash_20250124, ...) have no input_schema and can't run here.
    req.tools = body.tools
      .filter((t) => t.input_schema)
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } }));
  }
  return req;
}

/** OpenAI-style tool call id -> Anthropic-style. Ids we didn't generate pass through. */
export function toolUseId(id) {
  return id.startsWith('call_') ? 'toolu_' + id.slice(5) : id;
}

/** Parsed reply -> Anthropic content blocks. */
export function toAnthropicContent(parsed) {
  const content = [];
  if (parsed.content) content.push({ type: 'text', text: parsed.content });
  for (const tc of parsed.tool_calls) {
    let input;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: 'tool_use', id: toolUseId(tc.id), name: tc.function.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}

export function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}
