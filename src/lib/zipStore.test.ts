// The ZIP the archive travels as.
//
// What is pinned: it round-trips, a real unzip program can open it (the offsets
// and the checksums are the part that decides that), and anything it does NOT
// understand is refused rather than guessed at — a half-read archive imports
// content nobody wrote.

import { describe, expect, test } from "vitest";
import { MAX_ENTRIES, ZipError, crc32, readZip, writeZip } from "./zipStore";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("store-mode zip", () => {
  test("what goes in comes out, byte for byte", () => {
    const entries = [
      { name: "manifest.json", bytes: bytes('{"formatVersion":1}') },
      { name: "blobs/abc", bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) },
      // A name that needs UTF-8, which is why the flag is set on write.
      { name: "dossiers/été/résumé.txt", bytes: bytes("accentué") },
    ];

    const read = readZip(writeZip(entries));

    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i += 1) {
      expect(Array.from(read[i]!.bytes)).toEqual(Array.from(entries[i]!.bytes));
    }
  });

  test("an empty archive is still a readable archive", () => {
    expect(readZip(writeZip([]))).toEqual([]);
  });

  test("the checksum is the standard one", () => {
    // Pinned against the published CRC-32 of "123456789". A checksum that is
    // merely self-consistent would round-trip here and be rejected by every
    // other unzip program.
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
  });

  test("the offsets a real unzip reads are the ones written", () => {
    // The central directory is what an unzip program trusts. If its recorded
    // offset does not land on a local header, the archive opens nowhere else.
    const archive = writeZip([
      { name: "a.txt", bytes: bytes("premier") },
      { name: "b.txt", bytes: bytes("second") },
    ]);
    const view = new DataView(archive.buffer);

    let endAt = -1;
    for (let i = archive.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        endAt = i;
        break;
      }
    }
    expect(endAt).toBeGreaterThan(-1);
    expect(view.getUint16(endAt + 10, true)).toBe(2);
    let at = view.getUint32(endAt + 16, true);
    for (let i = 0; i < 2; i += 1) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const localAt = view.getUint32(at + 42, true);
      expect(view.getUint32(localAt, true)).toBe(0x04034b50);
      at +=
        46 +
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
  });

  test("bytes that do not match their checksum are REFUSED", () => {
    // The archive says these are not the bytes it recorded. Reading them anyway
    // would import content nobody wrote.
    const archive = writeZip([{ name: "a.txt", bytes: bytes("intact") }]);
    const tampered = archive.slice();
    // The payload sits right after the first local header + name.
    tampered[30 + "a.txt".length] ^= 0xff;

    expect(() => readZip(tampered)).toThrow(ZipError);
    expect(() => readZip(tampered)).toThrow(/checksum_mismatch/);
  });

  test("more entries than the end record can COUNT is refused", () => {
    // The count is a 16-bit field: writing more wraps silently, so the archive
    // is written whole and read back short — data lost with nothing to show it.
    const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_v, i) => ({
      name: `e${i}`,
      bytes: new Uint8Array(0),
    }));

    expect(() => writeZip(entries)).toThrow(/too_many_entries/);
  });

  test("something that is not an archive is refused, not read", () => {
    expect(() => readZip(bytes("bonjour"))).toThrow(/not_a_zip/);
  });

  test("a COMPRESSED entry is refused rather than mis-read", () => {
    // Store mode is all this reads. An entry compressed with deflate would
    // otherwise be handed back as its compressed bytes — silently wrong.
    const archive = writeZip([{ name: "a.txt", bytes: bytes("contenu") }]);
    const view = new DataView(archive.buffer);
    let at = archive.length - 22;
    while (view.getUint32(at, true) !== 0x06054b50) at -= 1;
    const centralAt = view.getUint32(at + 16, true);
    // Claim deflate in the central directory.
    new DataView(archive.buffer).setUint16(centralAt + 10, 8, true);

    expect(() => readZip(archive)).toThrow(/unsupported_method/);
  });

  test("a name in an unknown encoding is refused", () => {
    const archive = writeZip([{ name: "a.txt", bytes: bytes("x") }]);
    const view = new DataView(archive.buffer);
    let at = archive.length - 22;
    while (view.getUint32(at, true) !== 0x06054b50) at -= 1;
    const centralAt = view.getUint32(at + 16, true);
    // Clear the UTF-8 flag: the name may then be in any code page, and the wrong
    // one silently names a different file.
    view.setUint16(centralAt + 8, 0, true);

    expect(() => readZip(archive)).toThrow(/unsupported_encoding/);
  });

  test("a truncated archive is refused, not partially read", () => {
    const archive = writeZip([{ name: "a.txt", bytes: bytes("assez long") }]);
    const view = new DataView(archive.buffer);
    let at = archive.length - 22;
    while (view.getUint32(at, true) !== 0x06054b50) at -= 1;
    const centralAt = view.getUint32(at + 16, true);
    // Claim more bytes than the archive holds.
    view.setUint32(centralAt + 24, 10_000, true);

    expect(() => readZip(archive)).toThrow(/corrupt/);
  });
});
