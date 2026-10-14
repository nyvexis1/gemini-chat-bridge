// One browser (and one request queue) per Google account. Requests pick an
// account with model "<model id>@<account>"; a plain model id uses "default".

import { accountConfig } from './config.js';
import { BridgeError } from './errors.js';
import { Limiter } from './limiter.js';

export function splitModel(model, config) {
  const value = String(model || '');
  const at = value.lastIndexOf('@');
  if (at === -1) return { account: 'default', model: value || config.modelId };
  return { account: value.slice(at + 1) || 'default', model: value.slice(0, at) || config.modelId };
}

export class AccountPool {
  /**
   * @param {object} config
   * @param {(account: string, config: object) => object} createBackend  returns an object with complete() (and optionally start()/close())
   */
  constructor(config, createBackend, log = () => {}) {
    this.config = config;
    this.createBackend = createBackend;
    this.log = log;
    this.entries = new Map();
  }

  get names() {
    return ['default', ...this.config.accounts];
  }

  has(name) {
    return this.names.includes(name);
  }

  /** @returns {Promise<{backend: object, limiter: Limiter}>} */
  async get(name) {
    if (!this.has(name)) {
      throw new BridgeError(
        `Unknown account "${name}". Configured accounts: ${this.names.join(', ')} (set BRIDGE_ACCOUNTS).`,
        404,
        'model_not_found',
      );
    }
    let entry = this.entries.get(name);
    if (!entry) {
      // Store the promise so concurrent first requests share one browser launch.
      entry = (async () => {
        const backend = this.createBackend(name, accountConfig(this.config, name));
        if (backend.start && !backend.started) await backend.start();
        return { backend, limiter: new Limiter(this.config) };
      })();
      this.entries.set(name, entry);
      entry.catch(() => this.entries.delete(name));
    }
    return entry;
  }

  async closeAll() {
    for (const entry of this.entries.values()) {
      const { backend } = await entry.catch(() => ({}));
      await backend?.close?.().catch(() => {});
    }
    this.entries.clear();
  }
}
