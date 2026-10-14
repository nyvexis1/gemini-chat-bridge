// Drives the Gemini web app in a real browser profile that *you* are logged
// into. No fingerprint spoofing, no automation-flag hiding, no captcha
// solving: if Google shows a challenge or blocks the session, the bridge stops
// and tells you.

import fs from 'node:fs';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { domToMarkdown } from './markdown.js';
import { BridgeError } from './errors.js';

export { BridgeError };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GeminiChat {
  constructor(config, selectors, log = () => {}) {
    this.config = config;
    this.sel = selectors;
    this.log = log;
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  // ---------------------------------------------------------------- lifecycle

  async start({ headless = this.config.headless } = {}) {
    const c = this.config;
    if (c.cdpUrl) {
      this.browser = await chromium.connectOverCDP(c.cdpUrl);
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
      this.log(`connected to existing browser at ${c.cdpUrl}`);
    } else {
      fs.mkdirSync(c.profileDir, { recursive: true });
      const opts = { headless, viewport: null };
      if (c.executablePath) opts.executablePath = c.executablePath;
      else if (c.browserChannel) opts.channel = c.browserChannel;
      try {
        this.context = await chromium.launchPersistentContext(c.profileDir, opts);
      } catch (err) {
        if (opts.channel && /channel|executable|not found|install/i.test(err.message)) {
          this.log(`could not launch channel "${opts.channel}" (${err.message.split('\n')[0]}); falling back to bundled Chromium`);
          delete opts.channel;
          this.context = await chromium.launchPersistentContext(c.profileDir, opts);
        } else {
          throw err;
        }
      }
      this.log(`launched browser with profile ${c.profileDir}`);
    }
    // Use a dedicated tab so we never hijack one the user is working in (CDP mode).
    this.page = await this.context.newPage();
    return this;
  }

  async close() {
    try {
      await this.page?.close();
    } catch {
      // ignore
    }
    if (this.browser) await this.browser.close().catch(() => {});
    else await this.context?.close().catch(() => {});
  }

  // ---------------------------------------------------------------- helpers

  /** First selector from the list that currently matches something, or null. */
  async resolve(key) {
    const list = this.sel[key];
    return this.page.evaluate((sels) => {
      for (const s of sels) {
        try {
          if (document.querySelector(s)) return s;
        } catch {
          // invalid selector in override file; skip
        }
      }
      return null;
    }, list);
  }

  async waitFor(key, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await this.resolve(key);
      if (s) return s;
      await sleep(250);
    }
    return null;
  }

  async count(key) {
    return this.page.evaluate((sels) => {
      for (const s of sels) {
        const n = document.querySelectorAll(s).length;
        if (n) return n;
      }
      return 0;
    }, this.sel[key]);
  }

  async checkLoggedIn() {
    const url = this.page.url();
    if (/accounts\.google\.com/.test(url)) return false;
    return !(await this.resolve('signInLink'));
  }

  async open(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!(await this.checkLoggedIn())) {
      throw new BridgeError(
        'The browser profile is not logged in to Gemini. Run `npm run login` and sign in first.',
        401,
        'not_logged_in',
      );
    }
    const input = await this.waitFor('input', 45_000);
    if (!input) {
      throw new BridgeError(
        'Could not find the Gemini prompt box. The page layout may have changed (see selectors.local.json in the README), ' +
          'or Google is showing a challenge/consent page in the browser window.',
        502,
        'ui_changed',
      );
    }
  }

  // ---------------------------------------------------------------- model

  async currentModelText() {
    const s = await this.resolve('currentModelLabel');
    if (!s) return '';
    return (await this.page.locator(s).first().innerText().catch(() => '')).trim();
  }

  /** Make sure the configured model is selected. Returns the label seen. */
  async selectModel(label = this.config.modelLabel) {
    if (!label) return '';
    const want = label.toLowerCase();
    let current = await this.currentModelText();
    if (current.toLowerCase().includes(want)) return current;

    const picker = await this.resolve('modelPickerButton');
    const seen = [];
    if (picker) {
      await this.page.locator(picker).first().click();
      const itemSel = await this.waitFor('modelPickerItem', 5_000);
      if (itemSel) {
        const items = this.page.locator(itemSel);
        const n = await items.count();
        for (let i = 0; i < n; i++) {
          const text = (await items.nth(i).innerText().catch(() => '')).trim();
          seen.push(text.split('\n')[0]);
          if (text.toLowerCase().includes(want)) {
            await items.nth(i).click();
            await sleep(500);
            current = await this.currentModelText();
            return current || text;
          }
        }
      }
      await this.page.keyboard.press('Escape').catch(() => {});
    }

    const msg =
      `Could not select a model matching "${label}" in the Gemini picker. ` +
      (seen.length ? `Options seen: ${seen.map((s) => JSON.stringify(s)).join(', ')}. ` : 'No picker options found. ') +
      'Check that your plan includes it, or set GEMINI_MODEL_LABEL.';
    if (this.config.strictModel) throw new BridgeError(msg, 503, 'model_unavailable');
    this.log(`warning: ${msg} Using "${current || 'default'}".`);
    return current;
  }

  // ---------------------------------------------------------------- chat

  async lastResponseMarkdown() {
    // Passed as a string expression (evaluated over CDP) rather than using
    // new Function() in the page, which Google's Trusted Types CSP would block.
    const extract = ({ containers, contents }, toMd) => {
      let list = [];
      for (const s of containers) {
        list = document.querySelectorAll(s);
        if (list.length) break;
      }
      const last = list[list.length - 1];
      if (!last) return { text: '', count: 0 };
      let root = last;
      for (const s of contents) {
        const found = last.querySelector(s);
        if (found) {
          root = found;
          break;
        }
      }
      return { text: toMd(root), count: list.length };
    };
    const args = JSON.stringify({ containers: this.sel.responseContainer, contents: this.sel.responseContent });
    return this.page.evaluate(`(${extract.toString()})(${args}, ${domToMarkdown.toString()})`);
  }

  async isGenerating() {
    return Boolean(await this.resolve('stopButton'));
  }

  async errorText() {
    const s = await this.resolve('errorBanner');
    if (!s) return '';
    return (await this.page.locator(s).last().innerText().catch(() => '')).trim();
  }

  async typePrompt(prompt) {
    const inputSel = await this.waitFor('input', 30_000);
    const input = this.page.locator(inputSel).first();
    await input.click();
    // Clear anything left over, then insert the whole prompt in one go (no per-key typing).
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await this.page.keyboard.press('Backspace');
    await this.page.keyboard.insertText(prompt);
  }

  async submit() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const s = await this.resolve('sendButton');
      if (s) {
        await this.page.locator(s).first().click();
        return;
      }
      await sleep(200);
    }
    // Fall back to Enter, which submits in the Gemini editor.
    await this.page.keyboard.press('Enter');
  }

  // ---------------------------------------------------------------- images

  async waitForAttachments(expected, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await this.count('attachmentPreview')) >= expected) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * Attach images to the prompt box. Tries, in order: a file input already in
   * the page, the upload menu's file chooser, and pasting. Each attempt is
   * verified by the attachment previews appearing; if none works the request
   * fails rather than silently dropping images.
   * @param {{name: string, mimeType: string, buffer: Buffer}[]} files
   */
  async attachImages(files) {
    if (!files?.length) return;
    const before = await this.count('attachmentPreview');
    const expected = before + files.length;
    const attempts = [];

    const viaInput = async () => {
      const s = await this.resolve('fileInput');
      if (!s) return false;
      await this.page.locator(s).first().setInputFiles(files);
      return true;
    };
    const viaMenu = async () => {
      const menu = await this.resolve('uploadMenuButton');
      if (!menu) return false;
      await this.page.locator(menu).first().click();
      const item = await this.waitFor('uploadFilesItem', 5_000);
      if (!item) {
        await this.page.keyboard.press('Escape').catch(() => {});
        return false;
      }
      const chooserPromise = this.page.waitForEvent('filechooser', { timeout: 10_000 });
      await this.page.locator(item).first().click();
      const chooser = await chooserPromise.catch(() => null);
      if (!chooser) return false;
      await chooser.setFiles(files);
      return true;
    };
    const viaPaste = async () => {
      const inputSel = await this.resolve('input');
      if (!inputSel) return false;
      const payload = files.map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') }));
      await this.page.locator(inputSel).first().click();
      await this.page.evaluate(
        ({ sel, payload }) => {
          const dt = new DataTransfer();
          for (const f of payload) {
            const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
            dt.items.add(new File([bytes], f.name, { type: f.type }));
          }
          document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        },
        { sel: inputSel, payload },
      );
      return true;
    };

    for (const [name, fn] of [['file input', viaInput], ['upload menu', viaMenu], ['paste', viaPaste]]) {
      let ran = false;
      try {
        ran = await fn();
      } catch (err) {
        attempts.push(`${name}: ${err.message.split('\n')[0]}`);
        continue;
      }
      if (!ran) {
        attempts.push(`${name}: not available`);
        continue;
      }
      if (await this.waitForAttachments(expected, 15_000)) {
        // Let uploads finish before sending.
        const deadline = Date.now() + 60_000;
        while ((await this.resolve('uploadInProgress')) && Date.now() < deadline) await sleep(300);
        this.log(`attached ${files.length} image(s) via ${name}`);
        return;
      }
      attempts.push(`${name}: no attachment preview appeared`);
    }
    throw new BridgeError(
      `Could not attach ${files.length} image(s) to the Gemini prompt (${attempts.join('; ')}). ` +
        'The upload UI may have changed; see "When Gemini\'s UI changes" in the README.',
      502,
      'image_upload_failed',
    );
  }

  // ---------------------------------------------------------------- temporary chat

  async isTemporaryChatActive() {
    return Boolean(await this.resolve('temporaryChatActive'));
  }

  async enableTemporaryChat() {
    if (await this.isTemporaryChatActive()) return;
    const s = await this.waitFor('temporaryChatButton', 10_000);
    if (!s) {
      throw new BridgeError(
        'BRIDGE_CHAT_MODE=temporary, but no Temporary chat button was found. Your account or region may not offer it, ' +
          'or the UI changed (see selectors.local.json in the README). Refusing to continue so the chat is not saved by accident.',
        502,
        'temporary_chat_unavailable',
      );
    }
    await this.page.locator(s).first().click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.isTemporaryChatActive()) return;
      await sleep(200);
    }
    throw new BridgeError(
      'Clicked Temporary chat but could not confirm it is on. Refusing to continue so the chat is not saved by accident.',
      502,
      'temporary_chat_unavailable',
    );
  }

  /**
   * Get the page ready for this request. Returns the chat handle to report back.
   * Keep mode: handles are real chat URLs. Temporary mode: temporary chats have no
   * URL and vanish on navigation, so the handle is a token that is only valid while
   * this tab is still showing that chat.
   */
  async prepareChat(chatUrl) {
    if (this.config.chatMode === 'temporary') {
      if (chatUrl) {
        if (chatUrl === this.tempToken && (await this.isTemporaryChatActive())) return chatUrl;
        throw new BridgeError('Temporary chat is gone.', 409, 'chat_gone');
      }
      this.tempToken = null;
      await this.open(this.config.geminiUrl);
      await this.enableTemporaryChat();
      this.tempToken = 'temp:' + crypto.randomBytes(8).toString('hex');
      return this.tempToken;
    }
    this.tempToken = null;
    await this.open(chatUrl || this.config.geminiUrl);
    if (chatUrl && !this.page.url().startsWith(chatUrl.split('?')[0])) {
      throw new BridgeError('Previous chat could not be reopened.', 409, 'chat_gone');
    }
    return null;
  }

  async stopGenerating() {
    const s = await this.resolve('stopButton');
    if (s) await this.page.locator(s).first().click().catch(() => {});
  }

  /**
   * Send a prompt and wait for the reply.
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.chatUrl]   continue this chat instead of starting a new one
   * @param {{name: string, mimeType: string, buffer: Buffer}[]} [p.images]  files to attach
   * @param {(delta: string) => void} [p.onDelta]
   * @param {AbortSignal} [p.signal]
   * @returns {Promise<{text: string, chatUrl: string, model: string}>}
   */
  async complete({ prompt, chatUrl, images = [], onDelta, signal }) {
    const timeout = this.config.responseTimeoutMs;
    const tempHandle = await this.prepareChat(chatUrl);
    const model = await this.selectModel();
    // Selecting a model can reset the temporary-chat toggle on some layouts; re-check.
    if (tempHandle && !(await this.isTemporaryChatActive())) {
      throw new BridgeError('Temporary chat turned off after selecting the model. Refusing to continue.', 502, 'temporary_chat_unavailable');
    }

    const before = await this.count('responseContainer');
    await this.typePrompt(prompt);
    await this.attachImages(images);
    await this.submit();
    this.log(
      `prompt sent (${prompt.length} chars${images.length ? `, ${images.length} image(s)` : ''})` +
        `${chatUrl ? ' to existing chat' : ''}${tempHandle ? ' [temporary chat]' : ''}`,
    );

    // Wait for a new model turn to appear.
    const appearDeadline = Date.now() + 90_000;
    while ((await this.count('responseContainer')) <= before) {
      signal?.throwIfAborted();
      const err = await this.errorText();
      if (err) throw new BridgeError(`Gemini returned an error: ${err}`, 502, 'gemini_error');
      if (Date.now() > appearDeadline) {
        throw new BridgeError('Gemini did not start responding in time. Check the browser window.', 504, 'timeout');
      }
      await sleep(300);
    }

    let emitted = '';
    let last = '';
    let stableSince = Date.now();
    const deadline = Date.now() + timeout;
    const onAbort = () => this.stopGenerating();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { text } = await this.lastResponseMarkdown();
        if (text !== last) {
          last = text;
          stableSince = Date.now();
          if (onDelta && text.startsWith(emitted) && text.length > emitted.length) {
            onDelta(text.slice(emitted.length));
            emitted = text;
          }
        }
        const generating = await this.isGenerating();
        if (!generating && last && Date.now() - stableSince > 1200) break;
        if (!generating && !last && Date.now() - stableSince > 15_000) {
          const err = await this.errorText();
          throw new BridgeError(err ? `Gemini returned an error: ${err}` : 'Gemini returned an empty reply.', 502, 'empty_reply');
        }
        if (Date.now() > deadline) throw new BridgeError('Timed out waiting for Gemini to finish.', 504, 'timeout');
        await sleep(250);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (onDelta && last.length > emitted.length && last.startsWith(emitted)) onDelta(last.slice(emitted.length));
    else if (onDelta && !last.startsWith(emitted)) this.log('note: rendered reply changed after streaming; streamed text may differ slightly from final');

    return { text: last.trim(), chatUrl: tempHandle || this.page.url(), model };
  }
}
