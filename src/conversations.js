// Maps conversation prefixes the bridge has already answered to the Gemini chat
// URL holding them, so a follow-up request only needs to send the new messages
// instead of re-pasting the whole history into a fresh chat.

import crypto from 'node:crypto';
import { contentToText } from './prompt.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

function normText(s) {
  return contentToText(s).replace(/\s+/g, ' ').trim();
}

function messageSignature(m) {
  const sig = { role: m.role, content: normText(m.content) };
  if (m.tool_calls?.length) {
    sig.tool_calls = m.tool_calls.map((tc) => {
      let args = tc.function?.arguments ?? '';
      try {
        args = canonical(JSON.parse(args));
      } catch {
        // keep raw string
      }
      return { name: tc.function?.name, args };
    });
  }
  if (m.role === 'tool') sig.tool_call_id = m.tool_call_id;
  return JSON.stringify(sig);
}

function seedFor(req) {
  const tools = req.tool_choice === 'none' ? [] : (req.tools || []).map((t) => t.function?.name).sort();
  return JSON.stringify({ model: req.model || '', tools });
}

/** Rolling hashes: hashes[i] identifies messages[0..i) under this request's settings. */
export function prefixHashes(req, messages = req.messages || []) {
  const hashes = [];
  let h = crypto.createHash('sha256').update(seedFor(req)).digest('hex');
  hashes.push(h);
  for (const m of messages) {
    h = crypto.createHash('sha256').update(h).update(messageSignature(m)).digest('hex');
    hashes.push(h);
  }
  return hashes;
}

export class ConversationCache {
  constructor(limit = 200) {
    this.limit = limit;
    this.map = new Map();
  }

  /**
   * Find the longest already-answered prefix of this request.
   * @returns {{chatUrl: string, startIndex: number} | null}
   */
  lookup(req) {
    const messages = req.messages || [];
    const hashes = prefixHashes(req, messages);
    // Need at least one new message after the matched prefix, and the prefix must end with our reply.
    for (let k = messages.length - 1; k >= 1; k--) {
      if (messages[k - 1].role !== 'assistant') continue;
      const hit = this.map.get(hashes[k]);
      if (hit) {
        // refresh LRU position
        this.map.delete(hashes[k]);
        this.map.set(hashes[k], hit);
        return { chatUrl: hit.chatUrl, startIndex: k };
      }
    }
    return null;
  }

  /** Remember that `req.messages + reply` lives in chatUrl. */
  remember(req, replyMessage, chatUrl) {
    if (!chatUrl) return;
    const all = [...(req.messages || []), replyMessage];
    const hashes = prefixHashes(req, all);
    this.map.set(hashes[hashes.length - 1], { chatUrl });
    while (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}
