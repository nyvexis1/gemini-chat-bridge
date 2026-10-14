import { readJsonIfExists } from './config.js';

// Gemini's web UI is not a public API and its markup changes without notice.
// Every selector is a list tried in order; the first one that matches wins.
// Override any key by putting it in selectors.local.json (or BRIDGE_SELECTORS_FILE), e.g.
//   { "input": ["div.my-new-editor[contenteditable]"] }
export const DEFAULT_SELECTORS = {
  // Rich-text prompt box.
  input: [
    'rich-textarea div.ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  sendButton: [
    'button.send-button:not([disabled])',
    'button[aria-label*="Send" i]:not([disabled])',
  ],
  // Visible while a response is being generated.
  stopButton: [
    'button.send-button.stop',
    'button[aria-label*="Stop" i]',
  ],
  // One element per model turn; the last one is the reply we wait for.
  responseContainer: [
    'model-response',
    'div.model-response',
  ],
  // Rendered markdown inside a model turn.
  responseContent: [
    '.markdown',
    'message-content',
  ],
  newChatButton: [
    'a[aria-label*="New chat" i]',
    'button[aria-label*="New chat" i]',
    'side-nav-action-button[data-test-id="new-chat-button"] a',
  ],
  modelPickerButton: [
    '[data-test-id="bard-mode-menu-button"]',
    'button[aria-label*="model" i]',
    'button.input-area-switch',
  ],
  modelPickerItem: [
    '[role="menuitemradio"]',
    '[role="menuitem"]',
    'mat-option',
  ],
  // Text of the currently selected model, used to verify selection.
  currentModelLabel: [
    '[data-test-id="bard-mode-menu-button"]',
    'button.input-area-switch',
  ],
  // Signs that the session is logged out.
  signInLink: [
    'a[href*="accounts.google.com/ServiceLogin"]',
    'a[aria-label="Sign in"]',
  ],
  // Error banners / quota messages shown instead of a reply.
  errorBanner: [
    '.error-message',
    'message-content .error',
  ],
};

export function loadSelectors(file) {
  const overrides = readJsonIfExists(file) || {};
  const merged = { ...DEFAULT_SELECTORS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_SELECTORS)) throw new Error(`Unknown selector key "${key}" in ${file}`);
    merged[key] = Array.isArray(value) ? value : [value];
  }
  return merged;
}
