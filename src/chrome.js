// Starts your normal installed Google Chrome as a regular process (its own
// profile folder, plus a local debugging port the bridge connects to).
// Google's sign-in refuses browsers launched in automation mode, so this is
// what makes signing in work.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BridgeError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

export function findChrome(executablePath) {
  if (executablePath) {
    if (!fs.existsSync(executablePath)) throw new BridgeError(`BRIDGE_EXECUTABLE_PATH does not exist: ${executablePath}`, 500, 'chrome_not_found');
    return executablePath;
  }
  const found = candidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new BridgeError(
      'Google Chrome was not found. Install it from https://www.google.com/chrome, or set BRIDGE_EXECUTABLE_PATH to your Chrome.',
      500,
      'chrome_not_found',
    );
  }
  return found;
}

export async function debugEndpointUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start Chrome with this profile and debugging port, or reuse one that is
 * already running on that port (e.g. a login window left open).
 * @returns {Promise<{endpoint: string, proc: import('node:child_process').ChildProcess | null}>}
 */
export async function launchChrome({ executablePath, profileDir, port, headless = false, url = 'about:blank', extraArgs = [], log = () => {} }) {
  const endpoint = `http://127.0.0.1:${port}`;
  if (await debugEndpointUp(port)) {
    log(`using the Chrome already running on port ${port}`);
    return { endpoint, proc: null };
  }

  const exe = findChrome(executablePath);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) args.push('--headless=new');
  args.push(...extraArgs, url);

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // Keep the end of Chrome's error output for the error message.
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });
  proc.on('error', () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await debugEndpointUp(port)) {
      log(`started Chrome (${exe}) with profile ${profileDir}`);
      return { endpoint, proc };
    }
    if (exited) break;
    await sleep(300);
  }
  proc.kill();
  const detail = stderr.trim().split('\n').filter((l) => /error|fatal/i.test(l)).slice(-2).join(' | ');
  throw new BridgeError(
    (exited
      ? `Chrome closed right away. If a Chrome window using the profile ${profileDir} is already open, close it and try again.`
      : `Chrome did not open its debugging port ${port} in time. Another program may be using that port (change BRIDGE_DEBUG_PORT).`) +
      (detail ? ` Chrome said: ${detail}` : ''),
    500,
    'chrome_launch_failed',
  );
}
