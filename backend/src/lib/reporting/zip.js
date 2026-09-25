// A minimal ZIP writer, because an .xlsx is a ZIP archive.
//
// Written here rather than pulled in as a dependency: the whole requirement is
// "put these seven small XML parts in a container Excel will open", and Node
// already ships both halves of the job — zlib.deflateRawSync for the DEFLATE
// stream and zlib.crc32 for the checksum each entry must carry. A spreadsheet
// library would be several megabytes and a supply-chain surface for forty lines.
//
// Deliberately limited: no directories, no zip64, no encryption, no streaming.
// A report with more rows than fits in 4 GB is not a report.

import { deflateRawSync, crc32 } from 'node:zlib';

const DOS_EPOCH_YEAR = 1980;

// ZIP stores mtime as two 16-bit DOS fields with two-second resolution. Excel
// does not care what the timestamps say, but an entry dated 1601 makes archive
// tools complain, so the real time is written properly.
const dosDateTime = (date) => {
  const year = Math.max(date.getFullYear(), DOS_EPOCH_YEAR);
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
};

/**
 * Build a ZIP archive from `[{ name, data }]`.
 *
 * Entries are deflated unless deflating makes them bigger, which happens with
 * very short XML parts; those are stored. Both cases are ordinary ZIP and every
 * reader handles them.
 */
export const zipSync = (entries, at = new Date()) => {
  const { time, day } = dosDateTime(at);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
};
