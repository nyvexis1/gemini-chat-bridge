// Turns OpenAI-style chat requests into a single chat prompt, and parses the
// model's reply back into OpenAI-style content + tool_calls.
//
// The web chat has no native function calling, so tools are described in the
// prompt and the model is asked to answer with a fenced ```tool_calls block
// containing JSON. The parser is deliberately lenient about how that block
// comes back (with or without the language tag, bare JSON, etc.).

import crypto from 'node:crypto';

export const TOOL_FENCE = 'tool_calls';

export function imageUrlOf(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type !== 'image_url' && part.type !== 'input_image') return null;
  const v = part.image_url;
  return (typeof v === 'string' ? v : v?.url) || null;
}

/**
 * @param {*} content  string or array of content parts
 * @param {() => string} [onImage]  returns the placeholder text for the next image
 */
export function contentToText(content, onImage = () => '[image]') {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text ?? '';
        if (imageUrlOf(part)) return onImage();
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && (t.type === 'function' || t.function))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    }));
}

function toolChoiceInstruction(toolChoice, parallel) {
  const lines = [];
  if (toolChoice === 'required') {
    lines.push('You MUST call at least one tool in this reply.');
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    lines.push(`You MUST call the tool "${toolChoice.function.name}" in this reply.`);
  } else {
    lines.push('Call a tool only when it is needed to answer; otherwise answer normally in plain text.');
  }
  if (parallel === false) lines.push('Call at most ONE tool per reply.');
  else lines.push('You may call several tools in one reply if they are independent of each other.');
  return lines.join('\n');
}

export function toolProtocol(tools, toolChoice, parallel) {
  const defs = tools.map((t) => JSON.stringify(t)).join('\n');
  return [
    '# Tools',
    'You can call the following tools. Each is given as JSON with its name, description and JSON Schema parameters:',
    defs,
    '',
    '## How to call tools',
    'You cannot run tools yourself. To call tools, end your reply with exactly one fenced code block whose language is `tool_calls`, containing a JSON object like this:',
    '',
    '```' + TOOL_FENCE,
    '{"tool_calls": [{"name": "TOOL_NAME", "arguments": {"param": "value"}}]}',
    '```',
    '',
    'Rules:',
    '- "arguments" must be a JSON object that matches the tool\'s parameters schema.',
    '- Only use tool names from the list above.',
    '- After the tool_calls block, STOP. Do not write anything after it and do not invent tool results; they will be sent to you in the next message.',
    '- You may write a short sentence before the block, but it is optional.',
    '- Never use the tool_calls block format for anything other than calling tools.',
    toolChoiceInstruction(toolChoice, parallel),
  ].join('\n');
}

function formatToolCallsForTranscript(toolCalls) {
  const calls = toolCalls.map((tc) => {
    let args = tc.function?.arguments ?? '{}';
    try {
      args = JSON.parse(args);
    } catch {
      // leave as string
    }
    return { name: tc.function?.name, arguments: args };
  });
  return '```' + TOOL_FENCE + '\n' + JSON.stringify({ tool_calls: calls }) + '\n```';
}

function formatMessage(msg, toolNamesById, onImage) {
  const text = contentToText(msg.content, onImage);
  switch (msg.role) {
    case 'system':
    case 'developer':
      return `## System\n${text}`;
    case 'user':
      return `## User\n${text}`;
    case 'assistant': {
      const parts = [];
      if (text) parts.push(text);
      if (msg.tool_calls?.length) parts.push(formatToolCallsForTranscript(msg.tool_calls));
      return `## Assistant\n${parts.join('\n\n')}`;
    }
    case 'tool':
    case 'function': {
      const name = msg.name || toolNamesById.get(msg.tool_call_id) || 'unknown';
      return `## Tool result (${name})\n${text}`;
    }
    default:
      return `## ${msg.role}\n${text}`;
  }
}

function responseFormatInstruction(responseFormat) {
  if (!responseFormat || responseFormat.type === 'text') return '';
  if (responseFormat.type === 'json_object') {
    return 'Respond with a single valid JSON object and nothing else.';
  }
  if (responseFormat.type === 'json_schema') {
    const schema = responseFormat.json_schema?.schema;
    return `Respond with a single valid JSON value matching this JSON Schema and nothing else:\n${JSON.stringify(schema)}`;
  }
  return '';
}

/**
 * Build the text to type into the chat.
 * @param {object} req  OpenAI chat.completions request body
 * @param {object} [opts]
 * @param {number} [opts.startIndex] Only include messages from this index (continuing an existing chat).
 */
export function buildPrompt(req, { startIndex = 0 } = {}) {
  const messages = req.messages || [];
  const toolChoice = req.tool_choice;
  const tools = toolChoice === 'none' ? [] : normalizeTools(req.tools);
  const toolNamesById = new Map();
  for (const m of messages) {
    for (const tc of m.tool_calls || []) toolNamesById.set(tc.id, tc.function?.name);
  }

  const continuing = startIndex > 0;
  const sections = [];

  if (!continuing) {
    sections.push(
      'You are the assistant in the conversation below, which is being relayed to you by an API bridge. ' +
        'Reply ONLY with the next assistant message. Do not repeat the transcript, and do not prefix your reply with a role header.',
    );
    if (tools.length) sections.push(toolProtocol(tools, toolChoice, req.parallel_tool_calls));
    sections.push('# Conversation');
  } else if (tools.length) {
    // Short reminder; the full tool list is already earlier in this chat.
    sections.push(
      `(Reminder: to call tools, end with a \`\`\`${TOOL_FENCE} block as described earlier. ${toolChoiceInstruction(toolChoice, req.parallel_tool_calls)})`,
    );
  }

  // Images are uploaded as attachments in the order collectImages() returns them,
  // so number the placeholders the same way.
  let imageNo = 0;
  const onImage = () => `[Image ${++imageNo} (attached)]`;
  const slice = messages.slice(startIndex);
  sections.push(slice.map((m) => formatMessage(m, toolNamesById, onImage)).join('\n\n'));

  const fmt = responseFormatInstruction(req.response_format);
  if (fmt) sections.push(fmt);
  if (!continuing) sections.push('## Assistant');

  return sections.filter(Boolean).join('\n\n');
}

/** Image URLs (data: or http(s):) in the messages that buildPrompt() will send, in placeholder order. */
export function collectImages(req, { startIndex = 0 } = {}) {
  const urls = [];
  for (const m of (req.messages || []).slice(startIndex)) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const url = imageUrlOf(part);
      if (url) urls.push(url);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Parsing

const FENCE_RE = /```[ \t]*([\w-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

function tryJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

// Extract balanced {...} candidates that start at `"tool_calls"` objects in free text.
function findBareToolCallJson(text) {
  const out = [];
  let idx = text.indexOf('"tool_calls"');
  while (idx !== -1) {
    const start = text.lastIndexOf('{', idx);
    if (start !== -1) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            out.push({ start, end: i + 1, json: text.slice(start, i + 1) });
            break;
          }
        }
      }
    }
    idx = text.indexOf('"tool_calls"', idx + 1);
  }
  return out;
}

function callsFromValue(value) {
  if (!value) return null;
  let list = null;
  if (Array.isArray(value.tool_calls)) list = value.tool_calls;
  else if (Array.isArray(value) && value.every((v) => v && typeof v.name === 'string')) list = value;
  else if (typeof value.name === 'string' && 'arguments' in value) list = [value];
  if (!list) return null;
  return list
    .map((c) => {
      const fn = c.function && typeof c.function === 'object' ? c.function : c;
      const name = fn.name;
      let args = fn.arguments ?? fn.parameters ?? {};
      if (typeof args === 'string') {
        const parsed = tryJson(args);
        args = parsed === undefined ? args : parsed;
      }
      return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
    })
    .filter((c) => typeof c.name === 'string' && c.name);
}

export function newToolCallId() {
  return 'call_' + crypto.randomBytes(12).toString('hex');
}

/**
 * Parse a model reply (markdown) into { content, tool_calls }.
 * @param {string} text
 * @param {object} req  the original request (for tool names / tool_choice)
 */
export function parseReply(text, req = {}) {
  const toolChoice = req.tool_choice;
  const tools = toolChoice === 'none' ? [] : normalizeTools(req.tools);
  const known = new Set(tools.map((t) => t.name));

  if (!tools.length) return { content: cleanJsonReply(text, req.response_format), tool_calls: [] };

  const found = [];
  const removeRanges = [];

  for (const m of text.matchAll(FENCE_RE)) {
    const lang = m[1].toLowerCase();
    const value = tryJson(m[2]);
    const calls = callsFromValue(value);
    if (calls && (lang === TOOL_FENCE || lang === 'json' || lang === '' || Array.isArray(value?.tool_calls))) {
      found.push(...calls);
      removeRanges.push([m.index, m.index + m[0].length]);
    }
  }

  if (!found.length) {
    for (const cand of findBareToolCallJson(text)) {
      const calls = callsFromValue(tryJson(cand.json));
      if (calls?.length) {
        found.push(...calls);
        removeRanges.push([cand.start, cand.end]);
      }
    }
  }

  const valid = found.filter((c) => known.has(c.name));
  if (!valid.length) return { content: text.trim(), tool_calls: [] };

  let content = text;
  for (const [s, e] of removeRanges.sort((a, b) => b[0] - a[0])) {
    content = content.slice(0, s) + content.slice(e);
  }
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  let calls = valid;
  if (req.parallel_tool_calls === false) calls = calls.slice(0, 1);

  return {
    content: content || null,
    tool_calls: calls.map((c) => ({
      id: newToolCallId(),
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    })),
  };
}

// For JSON response formats, strip a surrounding ```json fence if the model added one.
function cleanJsonReply(text, responseFormat) {
  const trimmed = text.trim();
  if (!responseFormat || responseFormat.type === 'text') return trimmed;
  const m = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}
