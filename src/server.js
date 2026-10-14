// OpenAI-compatible HTTP front end: /v1/models and /v1/chat/completions
// (streaming and non-streaming, with tool calls).

import http from 'node:http';
import crypto from 'node:crypto';
import { buildPrompt, collectImages, parseReply, TOOL_FENCE } from './prompt.js';
import { loadImages } from './images.js';
import { ConversationCache } from './conversations.js';
import { Limiter } from './limiter.js';
import { BridgeError } from './errors.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function estimateTokens(s) {
  return Math.ceil((s || '').length / 4);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extraHeaders });
  res.end(data);
}

function sendError(res, status, message, code = null, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BridgeError('Request body too large.', 413, 'body_too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Normalise legacy `functions` / `function_call` into `tools` / `tool_choice`.
function normaliseRequest(body) {
  const req = { ...body };
  if (!req.tools && Array.isArray(req.functions)) {
    req.tools = req.functions.map((f) => ({ type: 'function', function: f }));
    if (req.function_call === 'none' || req.function_call === 'auto') req.tool_choice = req.function_call;
    else if (req.function_call?.name) req.tool_choice = { type: 'function', function: { name: req.function_call.name } };
  }
  return req;
}

function hasTools(req) {
  return req.tool_choice !== 'none' && Array.isArray(req.tools) && req.tools.length > 0;
}

// While streaming a request that may end in a tool call, only release text that
// can't be the start of a tool_calls block.
function safeStreamPrefix(text) {
  let cut = text.length;
  const fence = text.indexOf('```');
  if (fence !== -1) cut = Math.min(cut, fence);
  const bare = text.indexOf('"' + TOOL_FENCE + '"');
  if (bare !== -1) {
    const brace = text.lastIndexOf('{', bare);
    cut = Math.min(cut, brace === -1 ? bare : brace);
  }
  // Hold back trailing backticks / an open brace that might grow into a block.
  const tail = /[`{]+\s*$/.exec(text.slice(0, cut));
  if (tail) cut = tail.index;
  return text.slice(0, cut);
}

export function createServer({ config, backend, log = () => {} }) {
  const limiter = new Limiter(config);
  const cache = new ConversationCache();

  function checkAuth(req) {
    if (!config.apiKey) return true;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'] || '';
    const a = Buffer.from(String(token));
    const b = Buffer.from(config.apiKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Without an API key, only accept requests addressed to localhost. This blocks
  // DNS-rebinding attacks where a website you visit tries to use your bridge.
  function checkHost(req) {
    if (config.apiKey) return true;
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return LOCAL_HOSTS.has(host);
  }

  async function runCompletion(body, { onDelta, signal }) {
    const hit = config.reuseChats ? cache.lookup(body) : null;
    const attempt = async (reuse) => {
      const startIndex = reuse ? reuse.startIndex : 0;
      const prompt = buildPrompt(body, { startIndex });
      if (prompt.length > config.maxPromptChars) {
        throw new BridgeError(
          `Prompt is ${prompt.length} characters, above BRIDGE_MAX_PROMPT_CHARS=${config.maxPromptChars}.`,
          400,
          'context_length_exceeded',
        );
      }
      const images = await loadImages(collectImages(body, { startIndex }), {
        maxImages: config.maxImages,
        maxBytes: config.maxImageBytes,
      });
      const result = await backend.complete({ prompt, chatUrl: reuse?.chatUrl, images, onDelta, signal });
      return { ...result, prompt };
    };
    return limiter.run(async () => {
      if (hit) {
        try {
          return await attempt(hit);
        } catch (err) {
          if (err.code !== 'chat_gone') throw err;
          log('previous chat unavailable; starting a new one with the full history');
        }
      }
      return attempt(null);
    }, signal);
  }

  async function handleChat(req, res) {
    const ctype = req.headers['content-type'] || '';
    // Requiring JSON forces browsers to send a CORS preflight, which we never approve.
    if (!ctype.includes('application/json')) return sendError(res, 415, 'Content-Type must be application/json.');

    let body;
    try {
      body = normaliseRequest(JSON.parse(await readBody(req)));
    } catch (err) {
      return sendError(res, err.status || 400, err.status ? err.message : 'Invalid JSON body.');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, '`messages` must be a non-empty array.');
    }
    if (body.n && body.n > 1) return sendError(res, 400, 'n > 1 is not supported by this bridge.');

    const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const model = config.modelId;
    const tools = hasTools(body);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client disconnected'));
    });

    if (!body.stream) {
      try {
        const result = await runCompletion(body, { signal: abort.signal });
        const parsed = parseReply(result.text, body);
        const message = { role: 'assistant', content: parsed.content };
        if (parsed.tool_calls.length) message.tool_calls = parsed.tool_calls;
        cache.remember(body, message, result.chatUrl);
        const completion = estimateTokens(result.text);
        const promptTokens = estimateTokens(result.prompt);
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, logprobs: null, finish_reason: parsed.tool_calls.length ? 'tool_calls' : 'stop' }],
          // The web UI exposes no token counts; these are rough character-based estimates.
          usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion },
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        log(`error: ${err.message}`);
        return sendError(res, err.status || 500, err.message, err.code || null, err.status === 429 ? 'rate_limit_error' : 'api_error');
      }
    }

    // ---- streaming
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null) =>
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });

    chunk({ role: 'assistant', content: '' });
    // Keep proxies and clients from timing out while we wait in the queue.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

    let streamed = '';
    const onDelta = (delta) => {
      if (!tools) {
        streamed += delta;
        chunk({ content: delta });
        return;
      }
      onDelta.full = (onDelta.full || '') + delta;
      const safe = safeStreamPrefix(onDelta.full);
      if (safe.length > streamed.length) {
        chunk({ content: safe.slice(streamed.length) });
        streamed = safe;
      }
    };

    try {
      const result = await runCompletion(body, { onDelta, signal: abort.signal });
      const parsed = parseReply(result.text, body);
      const message = { role: 'assistant', content: parsed.content };
      if (parsed.tool_calls.length) message.tool_calls = parsed.tool_calls;
      cache.remember(body, message, result.chatUrl);

      const finalContent = parsed.content || '';
      if (finalContent.startsWith(streamed) && finalContent.length > streamed.length) {
        chunk({ content: finalContent.slice(streamed.length) });
      } else if (!streamed && finalContent) {
        chunk({ content: finalContent });
      }
      parsed.tool_calls.forEach((tc, index) => {
        chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] });
      });
      chunk({}, parsed.tool_calls.length ? 'tool_calls' : 'stop');
      if (body.stream_options?.include_usage) {
        const promptTokens = estimateTokens(result.prompt);
        const completion = estimateTokens(result.text);
        send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion } });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        log(`error: ${err.message}`);
        send({ error: { message: err.message, type: 'api_error', code: err.code || null } });
      }
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    if (config.debug) log(`${req.method} ${path}`);

    if (!checkHost(req)) return sendError(res, 403, 'Host not allowed. Set BRIDGE_API_KEY to accept non-localhost hosts.');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (path === '/health') return sendJson(res, 200, { ok: true, queued: limiter.pending });
    if (!checkAuth(req)) return sendError(res, 401, 'Invalid or missing API key.', 'invalid_api_key');

    try {
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        return sendJson(res, 200, {
          object: 'list',
          data: [{ id: config.modelId, object: 'model', created: 0, owned_by: 'gemini-web' }],
        });
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        return await handleChat(req, res);
      }
      return sendError(res, 404, `No route for ${req.method} ${path}`);
    } catch (err) {
      log(`error: ${err.stack || err.message}`);
      if (!res.headersSent) sendError(res, err.status || 500, err.message, err.code || null, 'api_error');
      else res.end();
    }
  });

  return server;
}
