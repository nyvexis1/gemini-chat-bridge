// HTTP front end. Speaks two dialects over the same core:
//   OpenAI:    GET /v1/models, POST /v1/chat/completions
//   Anthropic: POST /v1/messages, POST /v1/messages/count_tokens

import http from 'node:http';
import crypto from 'node:crypto';
import { buildPrompt, collectImages, parseReply, brokenToolCallReason, toolRetryPrompt, TOOL_FENCE } from './prompt.js';
import { loadImages } from './images.js';
import { ConversationCache } from './conversations.js';
import { AccountPool, splitModel } from './accounts.js';
import { BridgeError } from './errors.js';
import { toOpenAIRequest, toAnthropicContent, anthropicError, toolUseId } from './anthropic.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function estimateTokens(s) {
  return Math.ceil((s || '').length / 4);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res, status, message, code = null, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

function errorType(status) {
  if (status === 429) return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'api_error';
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

async function readJson(req) {
  // Requiring JSON forces browsers to send a CORS preflight, which we never approve.
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new BridgeError('Content-Type must be application/json.', 415, 'unsupported_media_type');
  }
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    if (err.status) throw err;
    throw new BridgeError('Invalid JSON body.', 400, 'invalid_json');
  }
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
  const tail = /[`{]+\s*$/.exec(text.slice(0, cut));
  if (tail) cut = tail.index;
  return text.slice(0, cut);
}

/**
 * Streams text deltas to `emit`, holding back anything that might be a tool
 * block when the request has tools. Call finish() with the final content to
 * flush whatever is still owed.
 */
function textStreamer(withTools, emit) {
  let full = '';
  let streamed = '';
  return {
    onDelta(delta) {
      full += delta;
      const safe = withTools ? safeStreamPrefix(full) : full;
      if (safe.length > streamed.length && safe.startsWith(streamed)) {
        emit(safe.slice(streamed.length));
        streamed = safe;
      }
    },
    finish(finalContent) {
      const text = finalContent || '';
      if (text.startsWith(streamed) && text.length > streamed.length) emit(text.slice(streamed.length));
      else if (!streamed && text) emit(text);
    },
  };
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} [opts.backend]        single backend used for every account (tests)
 * @param {Function} [opts.createBackend] (account, accountConfig) => backend
 * @param {AccountPool} [opts.pool]
 */
export function createServer({ config, backend, createBackend, pool, log = () => {} }) {
  pool ??= new AccountPool(config, createBackend ?? (() => backend), log);
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

  /**
   * Run one chat request (OpenAI-shaped body) end to end.
   * @returns {Promise<{message: object, parsed: object, usage: {prompt: number, completion: number}}>}
   */
  async function complete(body, { onDelta, signal }) {
    const { account } = splitModel(body.model, config);
    const { backend: target, limiter } = await pool.get(account);
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
      const result = await target.complete({ prompt, chatUrl: reuse?.chatUrl, images, onDelta, signal });
      return { ...result, prompt };
    };

    return limiter.run(async () => {
      let result = null;
      if (hit) {
        try {
          result = await attempt(hit);
        } catch (err) {
          if (err.code !== 'chat_gone') throw err;
          log('previous chat unavailable; starting a new one with the full history');
        }
      }
      result ??= await attempt(null);
      let parsed = parseReply(result.text, body);
      let completionText = result.text;
      let chatUrl = result.chatUrl;

      const reason = config.toolRetry ? brokenToolCallReason(result.text, body, parsed) : null;
      if (reason) {
        log(`reply looked like a broken tool call (${reason}); asking once more`);
        const retry = await target.complete({ prompt: toolRetryPrompt(body, reason), chatUrl, images: [], signal });
        parsed = parseReply(retry.text, body);
        completionText += retry.text;
        chatUrl = retry.chatUrl || chatUrl;
      }

      const message = { role: 'assistant', content: parsed.content };
      if (parsed.tool_calls.length) message.tool_calls = parsed.tool_calls;
      cache.remember(body, message, chatUrl);
      return { message, parsed, usage: { prompt: estimateTokens(result.prompt), completion: estimateTokens(completionText) } };
    }, signal);
  }

  function abortOnClose(res) {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client disconnected'));
    });
    return abort;
  }

  // ------------------------------------------------------------------ OpenAI

  async function handleChat(req, res) {
    const body = normaliseRequest(await readJson(req));
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new BridgeError('`messages` must be a non-empty array.', 400, 'invalid_request');
    }
    if (body.n && body.n > 1) throw new BridgeError('n > 1 is not supported by this bridge.', 400, 'invalid_request');
    await pool.get(splitModel(body.model, config).account); // unknown account -> 404 before streaming starts

    const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || config.modelId;
    const abort = abortOnClose(res);

    if (!body.stream) {
      try {
        const { message, parsed, usage } = await complete(body, { signal: abort.signal });
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, logprobs: null, finish_reason: parsed.tool_calls.length ? 'tool_calls' : 'stop' }],
          // The web UI exposes no token counts; these are rough character-based estimates.
          usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        throw err;
      }
    }

    sseHeaders(res);
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null) =>
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    chunk({ role: 'assistant', content: '' });
    // Keep proxies and clients from timing out while we wait in the queue.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const streamer = textStreamer(hasTools(body), (text) => chunk({ content: text }));

    try {
      const { parsed, usage } = await complete(body, { onDelta: streamer.onDelta, signal: abort.signal });
      streamer.finish(parsed.content);
      parsed.tool_calls.forEach((tc, index) => {
        chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] });
      });
      chunk({}, parsed.tool_calls.length ? 'tool_calls' : 'stop');
      if (body.stream_options?.include_usage) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
        });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        log(`error: ${err.message}`);
        send({ error: { message: err.message, type: errorType(err.status || 500), code: err.code || null } });
      }
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }

  // ------------------------------------------------------------------ Anthropic

  async function handleMessages(req, res) {
    const raw = await readJson(req);
    const body = toOpenAIRequest(raw);
    if (!body.messages.length) throw new BridgeError('`messages` must be a non-empty array.', 400, 'invalid_request');
    await pool.get(splitModel(body.model, config).account); // validate account early

    const id = 'msg_' + crypto.randomBytes(12).toString('hex');
    const model = raw.model || config.modelId;
    const abort = abortOnClose(res);

    if (!raw.stream) {
      try {
        const { parsed, usage } = await complete(body, { signal: abort.signal });
        return sendJson(res, 200, {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: toAnthropicContent(parsed),
          stop_reason: parsed.tool_calls.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: usage.prompt, output_tokens: usage.completion },
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        throw err;
      }
    }

    sseHeaders(res);
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', {
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const keepAlive = setInterval(() => event('ping', {}), 15_000);

    let index = -1;
    let textOpen = false;
    const emitText = (text) => {
      if (!textOpen) {
        index++;
        textOpen = true;
        event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      }
      event('content_block_delta', { index, delta: { type: 'text_delta', text } });
    };
    const streamer = textStreamer(hasTools(body), emitText);

    try {
      const { parsed, usage } = await complete(body, { onDelta: streamer.onDelta, signal: abort.signal });
      streamer.finish(parsed.content);
      if (!textOpen && !parsed.tool_calls.length) emitText('');
      if (textOpen) event('content_block_stop', { index });
      for (const tc of parsed.tool_calls) {
        index++;
        event('content_block_start', { index, content_block: { type: 'tool_use', id: toolUseId(tc.id), name: tc.function.name, input: {} } });
        event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
        event('content_block_stop', { index });
      }
      event('message_delta', {
        delta: { stop_reason: parsed.tool_calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { input_tokens: usage.prompt, output_tokens: usage.completion },
      });
      event('message_stop', {});
    } catch (err) {
      if (!abort.signal.aborted) {
        log(`error: ${err.message}`);
        event('error', { error: { type: errorType(err.status || 500), message: err.message } });
      }
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
  }

  async function handleCountTokens(req, res) {
    const body = toOpenAIRequest(await readJson(req));
    sendJson(res, 200, { input_tokens: estimateTokens(buildPrompt(body)) });
  }

  // ------------------------------------------------------------------ routing

  function listModels() {
    const ids = pool.names.map((n) => (n === 'default' ? config.modelId : `${config.modelId}@${n}`));
    const data = ids.map((id) => ({
      id,
      object: 'model',
      type: 'model',
      created: 0,
      created_at: '1970-01-01T00:00:00Z',
      display_name: id,
      owned_by: 'gemini-web',
    }));
    return { object: 'list', data, has_more: false, first_id: ids[0], last_id: ids.at(-1) };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const anthropic = path.startsWith('/v1/messages');
    if (config.debug) log(`${req.method} ${path}`);

    const fail = (status, message, code) =>
      anthropic ? sendJson(res, status, anthropicError(errorType(status), message)) : sendError(res, status, message, code, errorType(status));

    if (!checkHost(req)) return fail(403, 'Host not allowed. Set BRIDGE_API_KEY to accept non-localhost hosts.', 'host_not_allowed');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (path === '/health') return sendJson(res, 200, { ok: true, accounts: pool.names });
    if (!checkAuth(req)) return fail(401, 'Invalid or missing API key.', 'invalid_api_key');

    try {
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return sendJson(res, 200, listModels());
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) return await handleChat(req, res);
      if (req.method === 'POST' && path === '/v1/messages') return await handleMessages(req, res);
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return await handleCountTokens(req, res);
      return fail(404, `No route for ${req.method} ${path}`, 'not_found');
    } catch (err) {
      if (!err.status) log(`error: ${err.stack || err.message}`);
      else log(`error: ${err.message}`);
      if (!res.headersSent) fail(err.status || 500, err.message, err.code || null);
      else res.end();
    }
  });

  server.pool = pool;
  return server;
}
