// Menu photos for the Sell grid: decode, validate, store, remove.
//
// WHY THERE IS NO UPLOAD LIBRARY HERE. The obvious build is multer for the
// multipart parse and sharp for the resize. Neither can be installed: every
// lane's node_modules is a tree of SYMLINKS into ~/vexo-connect-dev, and the
// lane runner refuses to set up at all if backend/package.json differs from
// that clone's (`cmp -s`, vcxmi setup). A new dependency would resolve to
// nothing. So the browser downscales with a canvas and posts a base64 data URL
// as ordinary JSON, which express.json already parses, and this module does
// the validation that the client cannot be trusted to have done.
//
// That trust boundary is the whole point of the checks below: a data URL
// carries a MIME type in its own header, chosen by the caller. We never
// believe it. The bytes are sniffed, and a payload whose real content
// disagrees with its declared type is refused as a lie rather than quietly
// corrected, because the honest cases (a PNG saved with a .jpg name) and the
// dishonest ones (an HTML or SVG payload labelled image/png, hoping to be
// served back and executed) are indistinguishable from here.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { badRequest } from './errors.js';

// 512 KB is generous for a 512 px menu photo (the client targets ~60 KB) and
// small enough that a full catalogue of them stays a reasonable page weight.
// It also sits under the 1 MB express.json limit once base64 inflates it by a
// third, so an oversized body is refused HERE, with a POS error shape and a
// reason, rather than by the body parser with a bare 413.
export const MAX_IMAGE_BYTES = 512 * 1024;

// A till is a fixed-function machine that must not be wedged by a menu edit.
// Bytes alone do not bound the damage: a 2 KB PNG can declare 30000x30000 and
// cost ~3.6 GB to rasterise, so the browser that renders the grid — and the
// customer display, which is often the weakest device in the shop — would
// stall or be killed. We never decode the pixels server-side, so this is not
// protecting THIS process; it is protecting every client that will later be
// told to render the file.
export const MAX_IMAGE_DIMENSION = 2000;

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Anchored, and the base64 body is restricted to the standard alphabet with at
// most the two legal padding characters. URL-safe base64 ( - and _ ) is
// deliberately NOT accepted: Buffer.from would decode it to different bytes
// than the strict re-encode check below expects, so it would be rejected a
// moment later anyway, with a less useful message.
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const startsWith = (buf, bytes) =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

// Identify by content. Returns the real MIME type, or null when the bytes are
// not one of the three formats we accept.
export const sniffImageType = (buf) => {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // Not the full 4-byte SOI+APPn check: the third byte is 0xFF for every JPEG
  // variant (JFIF, Exif, raw) and the fourth is the marker, which varies.
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
};

const pngSize = (buf) => {
  // IHDR is mandatory and must be the first chunk, so width/height sit at a
  // fixed offset — no chunk walk needed.
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const jpegSize = (buf) => {
  // Walk the marker segments looking for a Start Of Frame. SOF0/1/2 are the
  // common ones (baseline, extended, progressive) but any SOFn carries the
  // dimensions, so accept the whole 0xC0-0xCF range minus the three markers in
  // it that are NOT frame headers: DHT (C4), JPG (C8) and DAC (CC).
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    // Fill bytes: any number of 0xFF may pad the gap before a marker.
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    // Standalone markers carry no length word: RST0-7 (D0-D7), SOI (D8),
    // EOI (D9) and TEM (01).
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOF payload: precision(1), height(2), width(2).
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
};

const webpSize = (buf) => {
  // Three container shapes, each storing the size differently.
  const fourcc = buf.length >= 16 ? buf.toString('ascii', 12, 16) : '';
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    // Lossy: 14 bytes of frame tag, then two 16-bit LE fields whose top two
    // bits are the scaling hint, not size.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    // Lossless: one 32-bit LE word holds width-1 in 14 bits then height-1 in
    // the next 14.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X' && buf.length >= 30) {
    // Extended (animation/alpha/ICC): canvas size as two 24-bit LE values,
    // each stored minus one.
    const u24 = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
};

export const imageDimensions = (buf, type) => {
  if (type === 'image/png') return pngSize(buf);
  if (type === 'image/jpeg') return jpegSize(buf);
  if (type === 'image/webp') return webpSize(buf);
  return null;
};

// Parse and vet a client-supplied data URL. Throws a POS_BAD_REQUEST naming
// the specific reason — callers surface these to the person choosing the file,
// and "that file is not a JPEG/PNG/WebP" is actionable where "invalid image"
// is not.
export const decodeProductImage = (dataUrl) => {
  const match = DATA_URL.exec(dataUrl);
  if (!match) {
    throw badRequest(
      'Image must be a base64 data URL of a JPEG, PNG or WebP',
      'dataUrl',
    );
  }
  const [, declaredType, b64] = match;

  const buffer = Buffer.from(b64, 'base64');
  // Node's base64 decoder silently drops characters it cannot use, so a
  // truncated or corrupted body would otherwise be written to disk as a short,
  // broken file. Re-encoding and comparing is the cheap way to insist the
  // payload survived the trip intact.
  if (buffer.toString('base64') !== b64) {
    throw badRequest('Image data is not valid base64', 'dataUrl');
  }
  if (buffer.length === 0) throw badRequest('Image is empty', 'dataUrl');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw badRequest(
      `Image is ${Math.ceil(buffer.length / 1024)} KB; the limit is ${MAX_IMAGE_BYTES / 1024} KB`,
      'dataUrl',
    );
  }

  const actualType = sniffImageType(buffer);
  if (!actualType) {
    throw badRequest('That file is not a JPEG, PNG or WebP image', 'dataUrl');
  }
  if (actualType !== declaredType) {
    throw badRequest(
      `Image claims to be ${declaredType} but the file is ${actualType}`,
      'dataUrl',
    );
  }

  const size = imageDimensions(buffer, actualType);
  if (!size || !size.width || !size.height) {
    throw badRequest('Image header is unreadable or corrupt', 'dataUrl');
  }
  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION) {
    throw badRequest(
      `Image is ${size.width}x${size.height}; the limit is ${MAX_IMAGE_DIMENSION}px on either side`,
      'dataUrl',
    );
  }

  return { buffer, type: actualType, ext: TYPES[actualType], ...size };
};

// Absolute root of the on-disk store. Resolved per call rather than at module
// load so tests can point it at a temp directory without a module reset.
export const productImageRoot = () =>
  path.resolve(env.POS_PRODUCT_IMAGE_DIR || path.join(process.cwd(), 'var', 'product-images'));

// Under /api on purpose, even though nothing here is an API call.
//
// /api is the ONLY prefix both hops already forward to this service: Vite
// proxies it in dev, and the frontend container's nginx has `location ^~ /api/`
// in prod. Everything else falls through to the SPA fallback, which answers
// `try_files ... /index.html` — so a photo at /media/products/x.webp would come
// back as index.html with a 200, and every <img> would render broken while
// looking perfectly healthy to curl. The vite config already carries a comment
// about that exact failure for /pos/api; this avoids re-earning it.
//
// The alternative — a new location block plus a new Vite proxy rule — is two
// more things a deployment can forget, to buy a prettier URL.
export const PRODUCT_IMAGE_URL_PREFIX = '/api/media/products';

export const storeProductImage = async ({ companyId, productId, buffer, ext }) => {
  // Content hash in the name, so a replacement is a NEW url. Without it the
  // path would be stable and every till, and the customer display, would keep
  // showing the previous photo out of cache until someone hard-reloaded it.
  // Truncated to 16 hex chars: this names a file, it is not a security claim.
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const filename = `${productId}-${digest}.${ext}`;
  const dir = path.join(productImageRoot(), companyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buffer);
  return `${PRODUCT_IMAGE_URL_PREFIX}/${companyId}/${filename}`;
};

// Delete the backing file for a stored url. Never throws for an absent file:
// the row is the record of truth, and a photo already gone from disk must not
// block the person trying to clear it from the menu.
export const removeProductImage = async (imageUrl) => {
  if (!imageUrl || !imageUrl.startsWith(`${PRODUCT_IMAGE_URL_PREFIX}/`)) return false;
  const root = productImageRoot();
  const target = path.resolve(root, imageUrl.slice(PRODUCT_IMAGE_URL_PREFIX.length + 1));
  // These urls are server-generated, so this cannot currently escape. It is
  // asserted anyway because the value makes a round trip through a database
  // column, and an unlink driven by stored text should never be able to reach
  // outside its own directory whatever put it there.
  if (target !== root && !target.startsWith(root + path.sep)) return false;
  try {
    await fs.unlink(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
};
