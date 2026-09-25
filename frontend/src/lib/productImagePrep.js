// Client-side preparation of a menu photo, before it is PUT as a data URL.
//
// The server takes a base64 data URL on ordinary JSON rather than a multipart
// upload, and everything here exists to keep that honest.
//
// Why no upload library: this app ships no image dependency on either side —
// no multer, no sharp, no browser resize package. The resize is done with the
// canvas the browser already has, which is also why the POS can accept a 6 MB
// phone photo at all: it is re-encoded to a few tens of KB BEFORE it is sent,
// so the wire, the JSON body limit and the disk all see a thumbnail.
//
// Deliberately free of React and of any DOM the page owns, so the browser
// harness can import THIS module and exercise the code that actually ships,
// rather than a copy of it that drifts.
//
// The ceiling here must stay at or under the server's own MAX_IMAGE_BYTES.
// Downscaling client-side is a convenience, never the enforcement — the server
// re-sniffs the magic bytes, re-reads the dimensions and re-checks the size on
// every request, because anything this file computes is attacker-controlled.
export const MAX_UPLOAD_BYTES = 512 * 1024;

// Tiles render at roughly 190–250 CSS px on a till, so 800 px still has room
// for a 2x display and costs far less than shipping the original. The server
// would accept up to 2000; there is no reason to spend it.
export const TARGET_MAX_EDGE = 800;

export const dataUrlBytes = (dataUrl) => {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
};

// Decode a chosen file into something drawable.
//
// createImageBitmap is preferred specifically for `imageOrientation`. A photo
// taken on a phone usually carries an EXIF rotation flag, and drawing it to a
// canvas applies the raw pixels while DISCARDING that flag — so a portrait
// photo silently lands on the menu on its side. 'from-image' bakes the
// rotation into the pixels instead.
export const decodeImage = async (file) => {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari rejects the options argument rather than ignoring it.
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to the <img> path */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      // Worded for the person at the till, because this is the message the
      // picker surfaces verbatim. The harness caught it reading "decode
      // failed", which tells a cashier nothing about what to do next. A file
      // that reaches here is usually a HEIC straight off an iPhone or a
      // renamed non-image.
      img.onerror = () =>
        reject(new Error('That file could not be read as an image. Try a JPEG, PNG or WebP.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

// Re-encode to something small enough to send, and report what came back.
//
// The type is read off the returned data URL rather than assumed: a browser
// asked for a format it cannot ENCODE silently hands back PNG instead, and a
// PNG of a photograph is enormous. Reading the prefix means the size loop below
// reacts to what actually happened. It also keeps the declared mime and the
// real bytes in agreement, which is exactly what the server cross-checks.
const encode = (canvas, type, quality) => {
  const dataUrl = canvas.toDataURL(type, quality);
  const actual = dataUrl.slice(5, dataUrl.indexOf(';'));
  return { dataUrl, actual, bytes: dataUrlBytes(dataUrl) };
};

export const prepareImage = async (file) => {
  const source = await decodeImage(file);
  const srcW = source.width;
  const srcH = source.height;
  if (!srcW || !srcH) throw new Error('That file could not be read as an image.');

  let scale = Math.min(1, TARGET_MAX_EDGE / Math.max(srcW, srcH));
  let best = null;
  const close = () => {
    if (typeof source.close === 'function') source.close();
  };

  // Quality first, then dimensions. Dropping quality is nearly free for a
  // photograph; halving the edge length is what actually makes it look cheap,
  // so it is the last resort rather than the first.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      close();
      throw new Error('This browser could not prepare the image.');
    }
    // Menu photos are photographs, so a white matte is closer to right than
    // black for anything with transparency, and JPEG has no alpha at all.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);

    for (const quality of [0.82, 0.7, 0.58]) {
      // WebP first: materially smaller than JPEG at the same quality. Browsers
      // that cannot encode it return PNG, which `encode` reports honestly and
      // the JPEG attempt below then supersedes.
      for (const type of ['image/webp', 'image/jpeg']) {
        const out = encode(canvas, type, quality);
        if (out.actual !== type) continue; // unsupported encoder; try the next
        if (!best || out.bytes < best.bytes) best = { ...out, width: w, height: h };
        if (out.bytes <= MAX_UPLOAD_BYTES) {
          close();
          return { ...out, width: w, height: h };
        }
      }
    }
    scale *= 0.75;
  }

  close();
  if (best && best.bytes <= MAX_UPLOAD_BYTES) return best;
  throw new Error('That image could not be reduced to under 512 KB. Try a smaller photo.');
};
