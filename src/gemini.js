// Drives the Gemini web app in a real browser profile that *you* are logged
// into. No fingerprint spoofing, no automation-flag hiding, no captcha
// solving: if Google shows a challenge or blocks the session, the bridge stops
// and tells you.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { domToMarkdown } from './markdown.js';
import { BridgeError } from './errors.js';
import { launchChrome } from './chrome.js';
import { PROJECT_ROOT } from './config.js';

export { BridgeError };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Compare model names loosely: "gemini-4-argon", "Gemini 4 Argon" and "4 Argon" are the same.
export function modelKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '')
    .replace(/^gemini/, '');
}

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

  async start({ headless = this.config.headless, url } = {}) {
    const c = this.config;
    if (c.cdpUrl) {
      // A Chrome you started yourself: only ever touch our own tab.
      this.browser = await chromium.connectOverCDP(c.cdpUrl);
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
      this.page = await this.context.newPage();
      this.log(`connected to your Chrome at ${c.cdpUrl}`);
    } else if (c.browser === 'playwright') {
      fs.mkdirSync(c.profileDir, { recursive: true });
      const opts = { headless, viewport: null };
      if (c.executablePath) opts.executablePath = c.executablePath;
      else if (c.browserChannel) opts.channel = c.browserChannel;
      this.context = await chromium.launchPersistentContext(c.profileDir, opts);
      this.page = this.context.pages()[0] || (await this.context.newPage());
      this.log(`launched Playwright browser with profile ${c.profileDir}`);
    } else {
      // Normal Chrome, started as a regular process; we connect over its debugging port.
      const { endpoint, proc } = await launchChrome({
        executablePath: c.executablePath,
        profileDir: c.profileDir,
        port: c.debugPort,
        headless,
        url,
        extraArgs: c.chromeArgs,
        log: this.log,
      });
      this.chromeProc = proc;
      this.ownsChrome = true;
      this.browser = await chromium.connectOverCDP(endpoint);
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
      this.page = this.context.pages()[0] || (await this.context.newPage());
    }
    this.started = true;
    return this;
  }

  async close() {
    if (this.ownsChrome) {
      // Ask Chrome to quit normally so it saves your sign-in to the profile.
      try {
        const session = await this.browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {
        this.chromeProc?.kill();
      }
      await this.browser.close().catch(() => {});
      // Wait until Chrome has really exited, so its profile is free for the next start.
      const proc = this.chromeProc;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(10_000)]);
      }
      return;
    }
    if (this.browser) {
      // Your own Chrome (BRIDGE_CDP_URL): close our tab and disconnect, never quit it.
      await this.page?.close().catch(() => {});
      await this.browser.close().catch(() => {});
      return;
    }
    await this.context?.close().catch(() => {});
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
    return this.page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return '';
        // Visible text without icon ligatures like "arrow_drop_down".
        const clone = el.cloneNode(true);
        clone.querySelectorAll('mat-icon, .material-icons, .google-symbols, svg').forEach((e) => e.remove());
        const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
        // Fall back to the label, e.g. "Open mode picker, currently selected: Argon" (any language).
        const aria = el.getAttribute('aria-label') || '';
        return aria.includes(':') ? aria.slice(aria.lastIndexOf(':') + 1).trim() : '';
      }, s)
      .catch(() => '');
  }

  /**
   * Click something Gemini may re-render at any moment. Re-finds the element and
   * retries instead of waiting on one that was replaced.
   * @param {() => Promise<string|null>} find  returns a selector, or null if not there (yet)
   */
  async clickFresh(find, attempts = 5) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      const sel = await find();
      if (sel) {
        try {
          await this.page.locator(sel).first().click({ timeout: 3_000 });
          return true;
        } catch (err) {
          lastError = err;
        }
      }
      await sleep(600);
    }
    if (lastError) this.log(`click kept failing: ${lastError.message.split('\n')[0]}`);
    return false;
  }

  /**
   * Find the model picker button: the configured selectors first, then any
   * visible button labelled like a model, which gets marked data-gcb-picker.
   */
  async findPickerButton(timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await this.resolve('modelPickerButton');
      if (s && (await this.page.locator(s).first().isVisible().catch(() => false))) return s;
      const marked = await this.page.evaluate(() => {
        const MODEL = /\b(flash|pro|argon|ultra|thinking|fast|deep think|gemini)\b/i;
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        const inNav = (el) => el.closest('nav, [role="navigation"], side-navigation, bard-sidenav, mat-sidenav');
        const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
          (b) => visible(b) && !inNav(b) && MODEL.test(b.innerText || '') && (b.innerText || '').trim().length <= 40,
        );
        // Prefer buttons that open a menu.
        buttons.sort((a, b) => Number(b.hasAttribute('aria-haspopup')) - Number(a.hasAttribute('aria-haspopup')));
        if (!buttons.length) return false;
        document.querySelectorAll('[data-gcb-picker]').forEach((e) => e.removeAttribute('data-gcb-picker'));
        buttons[0].setAttribute('data-gcb-picker', '1');
        return true;
      });
      if (marked) return '[data-gcb-picker="1"]';
      await sleep(500);
    }
    return null;
  }

  /** Mark the visible menu items (data-gcb-item=i) and return their names. */
  async visibleMenuItems() {
    return this.page.evaluate((sels) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      document.querySelectorAll('[data-gcb-item]').forEach((e) => e.removeAttribute('data-gcb-item'));
      for (const sel of sels) {
        let found = [];
        try {
          found = [...document.querySelectorAll(sel)].filter(visible);
        } catch {
          continue;
        }
        if (!found.length) continue;
        return found.map((el, i) => {
          el.setAttribute('data-gcb-item', String(i));
          // First line is the model name; later lines are descriptions.
          return (el.innerText || '').trim().split('\n')[0].trim();
        });
      }
      return [];
    }, this.sel.modelPickerItem);
  }

  /** Open the model picker. Returns the menu items, or null if it can't be opened. */
  async openModelPicker() {
    let names = await this.visibleMenuItems();
    if (!names.length) {
      if (!(await this.findPickerButton())) return null;
      if (!(await this.clickFresh(() => this.findPickerButton(3_000)))) return null;
      const deadline = Date.now() + 5_000;
      while (!names.length && Date.now() < deadline) {
        await sleep(250);
        names = await this.visibleMenuItems();
      }
    }
    if (!names.length) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return null;
    }
    // Menu items can be re-rendered too: re-mark them and click the one with the same name.
    const click = (i) =>
      this.clickFresh(async () => {
        const fresh = await this.visibleMenuItems();
        const j = fresh.indexOf(names[i]);
        return j === -1 ? null : `[data-gcb-item="${j}"]`;
      });
    return { click, names };
  }

  /** The exact model names in Gemini's picker. */
  async listModels() {
    const menu = await this.openModelPicker();
    if (menu) await this.page.keyboard.press('Escape').catch(() => {});
    return menu ? menu.names.filter(Boolean) : [];
  }

  /** Make sure the configured model is selected. Returns its name. */
  async selectModel(label = this.config.modelLabel) {
    if (!label) return '';
    const want = modelKey(label);
    const current = await this.currentModelText();
    if (modelKey(current) === want) return current;
    if (this.lastModel?.label === want && this.lastModel.button === current) return this.lastModel.name;

    const menu = await this.openModelPicker();
    const names = menu?.names || [];
    // Exact name first; otherwise the first name containing the label.
    let index = names.findIndex((n) => modelKey(n) === want);
    if (index === -1) {
      const partial = names.map((n, i) => (modelKey(n).includes(want) ? i : -1)).filter((i) => i !== -1);
      if (partial.length > 1) {
        this.log(`note: "${label}" matches ${partial.map((i) => JSON.stringify(names[i])).join(', ')}; using the first. Set the exact name to choose.`);
      }
      index = partial.length ? partial[0] : -1;
    }
    if (index === -1) {
      // The other way round: "gemini-4-argon" when the picker just says "Argon".
      const contained = names
        .map((n, i) => ({ i, key: modelKey(n) }))
        .filter(({ key }) => key.length >= 3 && want.includes(key))
        .sort((a, b) => b.key.length - a.key.length);
      if (contained.length) index = contained[0].i;
    }
    if (index !== -1) {
      if (!(await menu.click(index))) throw new BridgeError(`Could not click "${names[index]}" in the Gemini model picker.`, 502, 'ui_changed');
      await sleep(500);
      this.lastModel = { label: want, name: names[index], button: await this.currentModelText() };
      return names[index];
    }
    if (menu) await this.page.keyboard.press('Escape').catch(() => {});

    const report = await this.writeDebugReport().catch(() => null);
    const msg =
      `Could not find a model called "${label}" in the Gemini picker. ` +
      (names.length ? `Models there: ${names.map((n) => JSON.stringify(n)).join(', ')}. ` : 'The picker could not be opened. ') +
      'Use setup option 5 to pick the exact name.' +
      (report && !names.length ? ` A report of the page's buttons was saved to ${report}; please send it in a GitHub issue so the picker can be fixed.` : '');
    if (this.config.strictModel) throw new BridgeError(msg, 503, 'model_unavailable');
    this.log(`warning: ${msg} Using "${current || 'default'}".`);
    return current;
  }

  /**
   * Save the labels of the page's buttons (and any open menu) to
   * gemini-debug.txt, to fix selectors when Gemini's layout changes.
   * Skips the sidebar (chat titles) and anything containing an email address.
   */
  async writeDebugReport(file = path.join(PROJECT_ROOT, 'gemini-debug.txt')) {
    const rows = await this.page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const clip = (v) => (v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const out = [];
      const sel = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [aria-haspopup]';
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || el.closest('nav, [role="navigation"], side-navigation, bard-sidenav, mat-sidenav')) continue;
        const row = {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          testId: el.getAttribute('data-test-id') || '',
          aria: clip(el.getAttribute('aria-label')),
          popup: el.getAttribute('aria-haspopup') || '',
          cls: clip([...el.classList].slice(0, 4).join(' ')),
          text: clip(el.innerText),
        };
        if (JSON.stringify(row).includes('@')) continue;
        out.push(row);
        if (out.length >= 200) break;
      }
      return out;
    });
    const lines = [
      'gemini-chat-bridge debug report',
      `time: ${new Date().toISOString()}`,
      `page: ${this.page.url().split('?')[0]}`,
      '',
      'Visible buttons (tag | role | data-test-id | aria-label | aria-haspopup | class | text):',
      ...rows.map((r) => [r.tag, r.role, r.testId, r.aria, r.popup, r.cls, r.text].join(' | ')),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
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
    if (!(await this.waitFor('input', 30_000)) || !(await this.clickFresh(() => this.resolve('input')))) {
      throw new BridgeError('Could not click the Gemini prompt box.', 502, 'ui_changed');
    }
    // Clear anything left over, then insert the whole prompt in one go (no per-key typing).
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await this.page.keyboard.press('Backspace');
    await this.page.keyboard.insertText(prompt);
  }

  async submit() {
    if (await this.clickFresh(() => this.resolve('sendButton'), 15)) return;
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
    await this.clickFresh(() => this.resolve('temporaryChatButton'));
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
