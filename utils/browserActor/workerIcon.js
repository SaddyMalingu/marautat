/**
 * PNG → ICO, so the worker shortcut can carry the Alphadome logo (2026-11-07)
 *
 * A Windows shortcut needs a real `.ico`. Converting an image properly means re-encoding it at
 * six sizes, which needs an image library — and this repo has no dependency for that on purpose
 * (the worker bundle ships with no `node_modules` at all).
 *
 * It does not need one. Since Vista, an ICO may contain a **PNG file as-is**: the directory entry
 * describes it and the payload is the PNG bytes. So "conversion" is a 6-byte header, one 16-byte
 * entry, and the original file appended — no decoding, no re-encoding, no colour artefacts, and it
 * works in Explorer, the taskbar and the Start menu.
 *
 * Verified against the real logo in `scripts/make_worker_icon.mjs`, which asserts the header the
 * shell will read.
 */

/** Width/height from a PNG's IHDR chunk. Throws if this is not a PNG. */
export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) throw new Error('not a PNG: too short');
  // 8-byte signature, then the IHDR length (4) and type (4), then width and height.
  const signature = buffer.subarray(0, 8);
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!signature.equals(expected)) throw new Error('not a PNG: bad signature');
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('not a PNG: no IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Wrap PNG bytes in an ICO container.
 *
 * A dimension of 256 is written as 0 — the format has one byte per dimension, so 256 is the
 * documented overflow value. Anything larger keeps its true size in the PNG and is scaled by the
 * shell, which is what every icon set does for oversized source art.
 */
export function pngToIco(pngBuffer) {
  const { width, height } = pngSize(pngBuffer);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(1, 4); // one image in this file

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width >= 256 ? 0 : width, 0);
  entry.writeUInt8(height >= 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2);  // palette size: 0 for true colour
  entry.writeUInt8(0, 3);  // reserved
  entry.writeUInt16LE(1, 4);   // colour planes
  entry.writeUInt16LE(32, 6);  // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12); // payload starts after the directory

  return Buffer.concat([header, entry, pngBuffer]);
}

/** Read the ICO header back — used by the test so the assertion is about the bytes, not a promise. */
export function icoSummary(icoBuffer) {
  if (!icoBuffer || icoBuffer.length < 22) throw new Error('not an ICO: too short');
  const type = icoBuffer.readUInt16LE(2);
  const count = icoBuffer.readUInt16LE(4);
  const width = icoBuffer.readUInt8(6) || 256;
  const height = icoBuffer.readUInt8(7) || 256;
  const bytes = icoBuffer.readUInt32LE(14);
  const offset = icoBuffer.readUInt32LE(18);
  const isPng = icoBuffer.subarray(offset, offset + 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { type, count, width, height, bytes, offset, payloadIsPng: isPng, total: icoBuffer.length };
}
