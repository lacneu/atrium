// A ZIP writer and reader, in STORE mode only.
//
// Why write one rather than take a dependency: the archive has to be assembled
// where the bytes already are — in the browser — because a folder of image
// attachments is far larger than any single Convex read. Store mode makes that
// tractable in a hundred lines: no compression state to carry, so an entry is a
// header, its bytes, and a checksum.
//
// WHAT IT DOES NOT DO. It holds the whole archive in memory, so it is bounded by
// what the tab can allocate; the caller enforces a size ceiling and says so
// rather than failing on an allocation. It reads only what it writes — store
// mode, no encryption, no ZIP64 — and REFUSES anything else instead of guessing,
// because a half-understood archive is worse than one that would not open.

/** Signature of a local file header. */
const LOCAL_HEADER = 0x04034b50;
/** Signature of a central directory entry. */
const CENTRAL_HEADER = 0x02014b50;
/** Signature of the end-of-central-directory record. */
const END_OF_DIRECTORY = 0x06054b50;
/** Stored, i.e. not compressed. The only method this reads or writes. */
const METHOD_STORED = 0;
/** Flag bit 11: the name is UTF-8. Set on write, required on read — a name in
 *  some other encoding would silently become the wrong file. */
const FLAG_UTF8 = 0x800;

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** Entries one archive may hold. The end record counts them in 16 bits, and
 *  ZIP64 — which lifts that — is deliberately not implemented. */
export const MAX_ENTRIES = 0xffff;

export class ZipError extends Error {
  constructor(
    readonly reason:
      | "too_many_entries"
      | "not_a_zip"
      | "unsupported_method"
      | "unsupported_encoding"
      | "corrupt"
      | "checksum_mismatch",
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = "ZipError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC-32, the checksum a ZIP carries for every entry. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assemble one archive. Entry order is preserved. */
export function writeZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    // `setUint16` would wrap silently: the archive would be written whole and
    // read back short, losing entries with nothing to show it happened.
    throw new ZipError("too_many_entries", String(entries.length));
  }
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, METHOD_STORED, true);
    // No timestamp: a fixed one keeps the same input producing the same bytes,
    // which is what makes an archive comparable at all.
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true); // 1980-01-01
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, FLAG_UTF8, true);
    centralView.setUint16(10, METHOD_STORED, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, entry.bytes);
    centrals.push(central);
    offset += local.length + entry.bytes.length;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_DIRECTORY, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const total =
    locals.reduce((sum, part) => sum + part.length, 0) + directorySize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Read one archive.
 *
 * Walks the CENTRAL DIRECTORY rather than scanning for local headers: the
 * directory is what a ZIP is authoritative about, and scanning would happily
 * find a header inside an entry's own bytes.
 */
export function readZip(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.length);
  const decoder = new TextDecoder();

  let endAt = -1;
  // The record is last, but a comment may follow it, so it is searched backwards.
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === END_OF_DIRECTORY) {
      endAt = i;
      break;
    }
  }
  if (endAt === -1) throw new ZipError("not_a_zip");

  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > archive.length || view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ZipError("corrupt", "central directory");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const checksum = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));

    if (method !== METHOD_STORED) {
      throw new ZipError("unsupported_method", name);
    }
    if ((flags & FLAG_UTF8) === 0) {
      // A name in some other encoding would silently become a different file.
      throw new ZipError("unsupported_encoding", name);
    }
    if (
      localAt + 30 > archive.length ||
      view.getUint32(localAt, true) !== LOCAL_HEADER
    ) {
      throw new ZipError("corrupt", name);
    }
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLength + localExtraLength;
    if (start + size > archive.length) throw new ZipError("corrupt", name);
    const bytes = archive.slice(start, start + size);
    if (crc32(bytes) !== checksum) {
      // The archive says these bytes are not the ones it recorded. Reading them
      // anyway would import content nobody wrote.
      throw new ZipError("checksum_mismatch", name);
    }
    entries.push({ name, bytes });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
