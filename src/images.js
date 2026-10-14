// Loads images referenced in OpenAI-style requests (data: URLs or http(s) URLs)
// so they can be attached to the Gemini chat.

import { BridgeError } from './errors.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };

function fileFor(buffer, mimeType, index) {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new BridgeError(`Image ${index + 1} is not an image (got ${type || 'unknown type'}).`, 400, 'invalid_image');
  return { name: `image-${index + 1}.${EXT[type] || type.slice(6) || 'png'}`, mimeType: type, buffer };
}

export async function loadImage(url, index, { maxBytes = 20 * 1024 * 1024, fetchImpl = fetch } = {}) {
  if (url.startsWith('data:')) {
    const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new BridgeError(`Image ${index + 1} has a malformed data URL.`, 400, 'invalid_image');
    const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (buffer.length > maxBytes) throw new BridgeError(`Image ${index + 1} is larger than the ${maxBytes >> 20} MB limit.`, 400, 'image_too_large');
    return fileFor(buffer, m[1] || 'image/png', index);
  }
  if (/^https?:\/\//i.test(url)) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    } catch (err) {
      throw new BridgeError(`Could not download image ${index + 1}: ${err.message}`, 400, 'invalid_image');
    }
    if (!res.ok) throw new BridgeError(`Could not download image ${index + 1}: HTTP ${res.status}.`, 400, 'invalid_image');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new BridgeError(`Image ${index + 1} is larger than the ${maxBytes >> 20} MB limit.`, 400, 'image_too_large');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new BridgeError(`Image ${index + 1} is larger than the ${maxBytes >> 20} MB limit.`, 400, 'image_too_large');
    return fileFor(buffer, res.headers.get('content-type') || '', index);
  }
  throw new BridgeError(`Image ${index + 1}: only data: and http(s): URLs are supported.`, 400, 'invalid_image');
}

export async function loadImages(urls, { maxImages = 10, maxBytes } = {}) {
  if (urls.length > maxImages) {
    throw new BridgeError(`Request has ${urls.length} images; the limit is ${maxImages} (BRIDGE_MAX_IMAGES).`, 400, 'too_many_images');
  }
  return Promise.all(urls.map((u, i) => loadImage(u, i, { maxBytes })));
}
