// Serialises work against the browser and enforces conservative pacing, so a
// coding agent firing requests in a loop can't hammer the chat UI.

export class QueueFullError extends Error {
  constructor() {
    super('Bridge queue is full; try again later.');
    this.status = 429;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Limiter {
  constructor({ maxConcurrency = 1, minIntervalMs = 0, maxRequestsPerMinute = 0, maxQueue = 20 } = {}) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.minIntervalMs = minIntervalMs;
    this.maxRpm = maxRequestsPerMinute;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiting = [];
    this.lastStart = 0;
    this.starts = [];
  }

  get pending() {
    return this.waiting.length;
  }

  async run(fn, signal) {
    if (this.waiting.length >= this.maxQueue) throw new QueueFullError();
    await this.#acquire(signal);
    try {
      await this.#pace(signal);
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  #acquire(signal) {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i !== -1) this.waiting.splice(i, 1);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  async #pace(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      let wait = this.lastStart + this.minIntervalMs - now;
      if (this.maxRpm > 0) {
        this.starts = this.starts.filter((t) => now - t < 60_000);
        if (this.starts.length >= this.maxRpm) wait = Math.max(wait, this.starts[0] + 60_000 - now);
      }
      if (wait <= 0) break;
      await sleep(Math.min(wait, 1000));
    }
    this.lastStart = Date.now();
    this.starts.push(this.lastStart);
  }
}
