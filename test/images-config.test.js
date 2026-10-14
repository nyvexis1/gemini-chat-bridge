import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile } from '../src/config.js';
import { loadImage, loadImages } from '../src/images.js';
import { collectImages, buildPrompt } from '../src/prompt.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('parseEnvFile reads the file setup.bat writes', () => {
  const env = parseEnvFile('# comment\r\nBRIDGE_CHAT_MODE=temporary\r\nGEMINI_MODEL_LABEL="4 Argon"\r\n\r\nBRIDGE_API_KEY=a&b=c\r\n');
  assert.deepEqual(env, { BRIDGE_CHAT_MODE: 'temporary', GEMINI_MODEL_LABEL: '4 Argon', BRIDGE_API_KEY: 'a&b=c' });
});

test('loadImage decodes data URLs and rejects non-images', async () => {
  const img = await loadImage(PNG, 0);
  assert.equal(img.mimeType, 'image/png');
  assert.equal(img.name, 'image-1.png');
  assert.equal(img.buffer.subarray(1, 4).toString(), 'PNG');
  await assert.rejects(loadImage('data:text/plain;base64,aGk=', 0), /not an image/);
  await assert.rejects(loadImage('file:///etc/passwd', 0), /only data: and http/);
  await assert.rejects(loadImage(PNG, 0, { maxBytes: 10 }), /larger than/);
});

test('loadImage downloads http images', async () => {
  const fetchImpl = async () => new Response(Buffer.from('fakejpeg'), { headers: { 'content-type': 'image/jpeg' } });
  const img = await loadImage('https://example.com/cat.jpg', 2, { fetchImpl });
  assert.equal(img.name, 'image-3.jpg');
  assert.equal(img.buffer.toString(), 'fakejpeg');
});

test('loadImages enforces the count limit', async () => {
  await assert.rejects(loadImages([PNG, PNG], { maxImages: 1 }), /limit is 1/);
});

test('collectImages matches prompt placeholders and respects startIndex', () => {
  const req = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'image_url', image_url: 'https://x/1.png' }, { type: 'text', text: 'b' }] },
    ],
  };
  assert.deepEqual(collectImages(req), ['data:image/png;base64,AA', 'https://x/1.png']);
  assert.deepEqual(collectImages(req, { startIndex: 2 }), ['https://x/1.png']);
  assert.match(buildPrompt(req), /\[Image 1 \(attached\)\][\s\S]*\[Image 2 \(attached\)\]/);
  assert.match(buildPrompt(req, { startIndex: 2 }), /## User\n\[Image 1 \(attached\)\]\nb/);
});
