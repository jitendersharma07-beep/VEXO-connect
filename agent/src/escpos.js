// ESC/POS byte formation.
//
// This module is the only code in the product that turns an intent into printer
// bytes. That is deliberate and it is enforced upstream: `PrintJob` carries a
// structured `document` and `PrintTarget` carries a pin number and two
// millisecond counts, and neither table has a raw-command column anywhere. A
// caller can ask for a drawer pulse on pin 2 for 50 ms; a caller cannot ask for
// arbitrary escapes to be sent to the printer, because there is no field in
// which to put them.

import { fold } from './text.js';

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const EOT = 0x04;

export const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  LF: Buffer.from([0x0a]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 1]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 2]),
  BOLD_ON: Buffer.from([ESC, 0x45, 1]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0]),
  FONT_A: Buffer.from([ESC, 0x4d, 0]),
  FONT_B: Buffer.from([ESC, 0x4d, 1]),
  SIZE_NORMAL: Buffer.from([GS, 0x21, 0x00]),
  SIZE_DOUBLE: Buffer.from([GS, 0x21, 0x11]),
  SIZE_DOUBLE_H: Buffer.from([GS, 0x21, 0x01]),
  // DLE EOT 1 — real-time printer status. Bit 2 (0x04) is the level on the
  // drawer kick-out connector's pin 3. Real time means the printer answers even
  // with a full buffer, which is the only reason this is usable for a sensor
  // read at all.
  STATUS_PRINTER: Buffer.from([DLE, EOT, 1]),
};

const clampByte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));

// ESC p m t1 t2 — the generalised drawer pulse. m selects the connector pin
// (0/48 = pin 2, 1/49 = pin 5); t1 and t2 are the on and off times in units of
// 2 ms. The server validates pin and duration ranges before a command is ever
// queued; the clamp here is the second half of that, because a byte is a byte
// and a 300 ms request must not wrap round to 22 ms.
export const drawerPulse = ({ drawerPin = 2, drawerOnMs = 50, drawerOffMs = 200 } = {}) => {
  const m = Number(drawerPin) === 5 ? 1 : 0;
  return Buffer.from([ESC, 0x70, m, clampByte(drawerOnMs / 2), clampByte(drawerOffMs / 2)]);
};

// GS V 66 n — partial cut after feeding n lines. `GS V 1` alone cuts at the
// head, which on most units leaves the last two or three printed lines still
// inside the mechanism; the feed is what puts the tear in the right place.
export const cut = (feedLines = 4) => Buffer.from([GS, 0x56, 66, clampByte(feedLines)]);

export const feed = (lines = 1) => Buffer.from([ESC, 0x64, clampByte(lines)]);

export class Builder {
  #chunks = [];

  raw(buf) { this.#chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return this; }

  // Text is folded to 7-bit ASCII first — see text.js for why a byte above 0x7F
  // is not a character here.
  text(s) { return this.raw(Buffer.from(fold(s), 'ascii')); }

  line(s = '') { return this.text(s).raw(CMD.LF); }

  lines(arr) { for (const l of arr) this.line(l); return this; }

  init() { return this.raw(CMD.INIT).raw(CMD.FONT_A).raw(CMD.ALIGN_LEFT); }

  bold(on) { return this.raw(on ? CMD.BOLD_ON : CMD.BOLD_OFF); }

  align(which) {
    return this.raw(which === 'center' ? CMD.ALIGN_CENTER
      : which === 'right' ? CMD.ALIGN_RIGHT : CMD.ALIGN_LEFT);
  }

  size(which) {
    return this.raw(which === 'double' ? CMD.SIZE_DOUBLE
      : which === 'tall' ? CMD.SIZE_DOUBLE_H : CMD.SIZE_NORMAL);
  }

  feed(n) { return this.raw(feed(n)); }

  cut(feedLines) { return this.raw(cut(feedLines)); }

  drawer(opts) { return this.raw(drawerPulse(opts)); }

  build() { return Buffer.concat(this.#chunks); }
}

// Decode a DLE EOT 1 status byte. Returns null when the byte is not a valid
// status response — bit 4 is fixed high and bits 0 and 1 are fixed 0 and 1, so
// a reply that fails those is noise on the socket and not an answer.
export const decodePrinterStatus = (byte) => {
  if (typeof byte !== 'number') return null;
  if ((byte & 0b0001_0011) !== 0b0001_0010) return null;
  return {
    raw: byte,
    // The LEVEL on pin 3, not the word "open". Which level means open depends
    // on how the drawer is wired, so the caller applies the polarity.
    drawerPinHigh: Boolean(byte & 0b0000_0100),
    offline: Boolean(byte & 0b0000_1000),
  };
};
