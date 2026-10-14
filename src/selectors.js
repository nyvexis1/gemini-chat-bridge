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
  // If none of these match, the bridge also looks for a visible button labelled
  // like a model ("Flash", "Pro", "Argon", ...) and marks it data-gcb-picker.
  modelPickerButton: [
    '[data-test-id="bard-mode-menu-button"]',
    'button[data-test-id*="mode-switch" i]',
    'button[data-test-id*="model" i]',
    'button[aria-label*="model" i]',
    'button[aria-label*="mode picker" i]',
    'button.input-area-switch',
    '[data-gcb-picker="1"]',
  ],
  // Only visible matches count, so hidden menus elsewhere on the page are ignored.
  modelPickerItem: [
    '[role="menuitemradio"]',
    '[role="menu"] [role="menuitem"]',
    '[role="menuitem"]',
    '[role="listbox"] [role="option"]',
    '.mat-mdc-menu-item',
    'mat-option',
    '.cdk-overlay-container button',
  ],
  // Text of the currently selected model, used to verify selection.
  currentModelLabel: [
    '[data-test-id="bard-mode-menu-button"]',
    'button[data-test-id*="mode-switch" i]',
    'button[data-test-id*="model" i]',
    'button.input-area-switch',
    '[data-gcb-picker="1"]',
  ],
  // ---- image uploads
  // A file input that is already in the page (used directly if present).
  fileInput: [
    'input[type="file"]',
  ],
  // The "+" / attach button next to the prompt box that opens the upload menu.
  uploadMenuButton: [
    'button[aria-label*="upload file menu" i]',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="upload" i]',
  ],
  // The "Upload files" entry in that menu, which opens a file chooser.
  uploadFilesItem: [
    '[data-test-id="local-images-files-uploader-button"]',
    'button[aria-label*="Upload files" i]',
    '[role="menuitem"][aria-label*="upload" i]',
  ],
  // One element per attached file in the prompt box.
  attachmentPreview: [
    'uploader-file-preview',
    'img[data-test-id="uploaded-img"]',
    '.file-preview-container',
  ],
  // Visible while an attachment is still uploading.
  uploadInProgress: [
    'uploader-file-preview [role="progressbar"]',
    'uploader-file-preview mat-progress-spinner',
    '.file-preview-container [role="progressbar"]',
  ],

  // ---- temporary chat
  temporaryChatButton: [
    'button[aria-label*="Temporary chat" i]',
    '[data-test-id="temp-chat-button"]',
  ],
  // Present only while a temporary chat is active.
  temporaryChatActive: [
    'button[aria-label*="Temporary chat" i][aria-pressed="true"]',
    '[data-test-id="temp-chat-button"][aria-pressed="true"]',
    '.temp-chat-on',
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
