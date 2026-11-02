/**
 * Store-only ZIP writer (2026-11-02)
 *
 * The tenant worker ships as a zip the portal hands out, and the repo's rule is no new
 * dependency for something this small. A zip is a container, not a compression format: with
 * method 0 (stored) the file is just headers and bytes, which every extractor — including
 * Windows Explorer — already reads.
 *
 * Deliberately **not** compressed: these are a few dozen kilobytes of JavaScript moving over
 * TLS, and store-only keeps the builder short enough to read in one sitting and vet.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** A zip timestamp is MS-DOS packed. Fixed by default so two builds are byte-identical. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

/**
 * @param {{name: string, data: Buffer|string}[]} entries paths use forward slashes
 * @param {{mtime?: Date}} [options]
 * @returns {Buffer}
 */
export function buildZipStore(entries = [], { mtime = new Date(0) } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('buildZipStore needs at least one entry');
  const stamp = dosDateTime(mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? mtime : new Date(0));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry?.name || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.includes('../')) {
      // A zip that can write outside its own folder when extracted is how "download the
      // worker" becomes "overwrite something in Program Files".
      throw new Error(`refusing to zip an unsafe path: ${name || '(empty)'}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** Read back the central directory. Used by the tests to prove what a tenant receives. */
export function listZipEntries(zip) {
  if (!Buffer.isBuffer(zip) || zip.length < 22) throw new Error('not a zip buffer');
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('no end-of-central-directory record');
  const count = zip.readUInt16LE(endAt + 10);
  let cursor = zip.readUInt32LE(endAt + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`bad central directory at ${cursor}`);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const size = zip.readUInt32LE(cursor + 24);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, size, data: zip.slice(dataAt, dataAt + size) });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
