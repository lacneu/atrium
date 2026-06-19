// Shared-fs path validation (the "Valider" button, bridge-side). A leg not in
// shared-fs is skipped; a writable inbound dir round-trips OK; a missing/unwritable
// dir reports the error; a readable outbound dir passes.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReadableDir,
  checkWritableDir,
  validateSharedFs,
} from "../src/core/media-validate.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atrium-mv-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("checkWritableDir", () => {
  it("round-trips a marker and leaves NO file behind", async () => {
    const dir = await tempDir();
    const r = await checkWritableDir(dir, 123);
    expect(r).toEqual({ checked: true, ok: true, detail: dir });
    expect(await readdir(dir)).toEqual([]); // marker cleaned up
  });

  it("reports an error for an unwritable path (a file as the dir)", async () => {
    // A path under a non-existent, non-creatable parent (NUL on a file) → mkdir fails.
    const r = await checkWritableDir("/proc/atrium-cannot-write", 1);
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe("checkReadableDir", () => {
  it("ok for an existing dir, error for a missing one", async () => {
    const dir = await tempDir();
    expect((await checkReadableDir(dir)).ok).toBe(true);
    const miss = await checkReadableDir("/no/such/atrium/mv/dir");
    expect(miss.ok).toBe(false);
  });
});

describe("validateSharedFs", () => {
  it("skips legs that are not shared-fs", async () => {
    const dir = await tempDir();
    const r = await validateSharedFs({
      inboundDir: dir,
      outboundDir: dir,
      inboundSharedFs: false,
      outboundSharedFs: false,
      now: 1,
    });
    expect(r.inbound.checked).toBe(false);
    expect(r.outbound.checked).toBe(false);
  });

  it("checks both legs when both are shared-fs", async () => {
    const dir = await tempDir();
    const r = await validateSharedFs({
      inboundDir: dir,
      outboundDir: dir,
      inboundSharedFs: true,
      outboundSharedFs: true,
      now: 2,
    });
    expect(r.inbound).toEqual({ checked: true, ok: true, detail: dir });
    expect(r.outbound).toEqual({ checked: true, ok: true, detail: dir });
  });
});
