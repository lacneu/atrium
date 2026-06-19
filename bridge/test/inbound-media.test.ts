// Phase 3 — shared-fs inbound staging. Each test FAILS if its guard regresses:
// path traversal, the mid-stream byte cap, partial-file cleanup, the block format.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOUND_TOO_LARGE,
  buildFilesReceivedBlock,
  inboundDiskName,
  safeBasename,
  stageInboundReference,
  stageInboundReferences,
  type InboundMediaConfig,
} from "../src/core/inbound-media.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atrium-inbound-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A fetch returning the given bytes as a streamable Response. */
function bytesFetch(bytes: Uint8Array, ok = true): typeof fetch {
  return (async () =>
    new Response(ok ? new Blob([bytes]) : null, {
      status: ok ? 200 : 502,
    })) as unknown as typeof fetch;
}

describe("safeBasename", () => {
  it("strips path traversal to a safe basename", () => {
    expect(safeBasename("../../etc/passwd")).toBe("passwd");
    expect(safeBasename("/abs/path/file.mp4")).toBe("file.mp4");
    expect(safeBasename("..")).toBe("file");
    expect(safeBasename("")).toBe("file");
    expect(safeBasename("clean.pdf")).toBe("clean.pdf");
  });
});

describe("inboundDiskName", () => {
  it("is unique per (prefix, index) and sanitizes both parts", () => {
    expect(inboundDiskName("cmid1", 0, "a.mp4")).toBe("cmid1-0-a.mp4");
    expect(inboundDiskName("cmid1", 1, "../evil")).toBe("cmid1-1-evil");
    expect(inboundDiskName("a/b", 0, "x")).toBe("b-0-x"); // prefix sanitized too
  });
});

describe("stageInboundReference", () => {
  it("streams the body to disk and returns the gateway-visible path + size", async () => {
    const dir = await tempDir();
    const data = new TextEncoder().encode("hello world");
    const config: InboundMediaConfig = {
      inboundDir: dir,
      agentMount: "/home/node/inbound",
      maxBytes: 1024,
      fetchImpl: bytesFetch(data),
    };
    const staged = await stageInboundReference(
      { url: "https://convex/getUrl", mimeType: "text/plain", fileName: "doc.txt" },
      "cmid-0-doc.txt",
      config,
    );
    expect(staged.agentPath).toBe("/home/node/inbound/cmid-0-doc.txt");
    expect(staged.size).toBe(data.length);
    expect(staged.mimeType).toBe("text/plain");
    // The bytes actually landed at inboundDir (the bridge wrote them, not the pipe).
    expect(await readFile(join(dir, "cmid-0-doc.txt"), "utf8")).toBe("hello world");
  });

  it("ABORTS + DELETES the partial file when the stream exceeds maxBytes", async () => {
    const dir = await tempDir();
    const data = new Uint8Array(5000); // > maxBytes
    const config: InboundMediaConfig = {
      inboundDir: dir,
      agentMount: "/m",
      maxBytes: 1024,
      fetchImpl: bytesFetch(data),
    };
    await expect(
      stageInboundReference(
        { url: "u", mimeType: "video/mp4", fileName: "big.mp4" },
        "big",
        config,
      ),
    ).rejects.toThrow(INBOUND_TOO_LARGE);
    // No partial file is left behind (a truncated path must never be injected).
    expect(await readdir(dir)).toEqual([]);
  });

  it("throws on a non-OK fetch (never writes a file)", async () => {
    const dir = await tempDir();
    const config: InboundMediaConfig = {
      inboundDir: dir,
      agentMount: "/m",
      maxBytes: 1024,
      fetchImpl: bytesFetch(new Uint8Array(1), false),
    };
    await expect(
      stageInboundReference({ url: "u", mimeType: "x", fileName: "f" }, "f", config),
    ).rejects.toThrow(/inbound fetch failed/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("stageInboundReferences (best-effort per file)", () => {
  it("drops only the failing file; the others still stage", async () => {
    const dir = await tempDir();
    // First fetch OK (small), second fetch fails (502).
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1
        ? new Response(new Blob([new Uint8Array(4)]), { status: 200 })
        : new Response(null, { status: 502 });
    }) as unknown as typeof fetch;
    const dropped: string[] = [];
    const staged = await stageInboundReferences(
      [
        { url: "u1", mimeType: "application/pdf", fileName: "ok.pdf" },
        { url: "u2", mimeType: "video/mp4", fileName: "bad.mp4" },
      ],
      "cmid",
      { inboundDir: dir, agentMount: "/m", maxBytes: 1024, fetchImpl },
      (name) => dropped.push(name),
    );
    expect(staged).toHaveLength(1);
    expect(staged[0]!.agentPath).toBe("/m/cmid-0-ok.pdf");
    expect(dropped).toEqual(["bad.mp4"]);
  });
});

describe("buildFilesReceivedBlock", () => {
  it("renders the [FICHIERS REÇUS] block with path + size + mime", () => {
    const block = buildFilesReceivedBlock([
      { agentPath: "/m/a.pdf", size: 12, mimeType: "application/pdf" },
    ]);
    expect(block).toBe("\n[FICHIERS REÇUS]\n- /m/a.pdf (12 o, application/pdf)");
  });
  it("is empty when nothing staged (no empty block)", () => {
    expect(buildFilesReceivedBlock([])).toBe("");
  });
});
