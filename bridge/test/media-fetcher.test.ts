// Proves the outbound-media byte path END TO END without any gateway access:
// drop a file in a temp dir, point the fetcher at it, assert the streamed bytes
// + mime. The same code reads the `:ro` mount in prod and an SSHFS/synced dir
// in dev, and streams (no base64, no full buffer) into a Convex upload URL.

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { LocalDirMediaFetcher } from "../src/core/media-fetcher.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oc-media-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("LocalDirMediaFetcher", () => {
  it("streams bytes + infers mime + reports size for a file in the media dir", async () => {
    await withTempDir(async (dir) => {
      const content = "# fruits\n- pomme\n- poire\n";
      await writeFile(join(dir, "fruits---abc.md"), content);
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      const got = await fetcher.open(
        "/home/node/.openclaw/media/outbound/fruits---abc.md",
      );
      expect(got).not.toBeNull();
      expect(got!.mimeType).toBe("text/markdown");
      expect(got!.size).toBe(Buffer.byteLength(content));
      expect((await drain(got!.stream)).toString("utf-8")).toContain("# fruits");
    });
  });

  it("REJECTS a symlink — never follows it out of the media dir (path-escape exfil)", async () => {
    await withTempDir(async (dir) => {
      // A secret file OUTSIDE the media dir (the symlink target).
      const outside = await mkdtemp(join(tmpdir(), "oc-secret-"));
      try {
        const secret = join(outside, "secret.txt");
        await writeFile(secret, "TOP SECRET — outside the media dir");
        // A tool/agent with write access to the mounted media/outbound dir drops
        // `report.pdf -> <secret>` and emits that filename. The fetcher must NOT
        // stat/stream the link target.
        await symlink(secret, join(dir, "report.pdf"));
        const skips: string[] = [];
        const fetcher = new LocalDirMediaFetcher({
          baseDir: dir,
          maxBytes: 1024,
          onSkip: (reason) => skips.push(reason),
        });
        const got = await fetcher.open(
          "/home/node/.openclaw/media/outbound/report.pdf",
        );
        expect(got).toBeNull(); // the link target is never streamed
        expect(skips.some((s) => s.includes("symlink"))).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("returns null (never throws) for a missing file", async () => {
    await withTempDir(async (dir) => {
      const skips: string[] = [];
      const fetcher = new LocalDirMediaFetcher({
        baseDir: dir,
        maxBytes: 1024,
        onSkip: (reason) => skips.push(reason),
      });
      expect(
        await fetcher.open("/home/node/.openclaw/media/outbound/nope.md"),
      ).toBeNull();
      expect(skips).toContain("not found");
    });
  });

  it("rejects a file above the size cap", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "big.bin"), Buffer.alloc(2048));
      const skips: string[] = [];
      const fetcher = new LocalDirMediaFetcher({
        baseDir: dir,
        maxBytes: 1024,
        onSkip: (reason) => skips.push(reason),
      });
      expect(
        await fetcher.open("/home/node/.openclaw/media/outbound/big.bin"),
      ).toBeNull();
      expect(skips.some((s) => s.startsWith("too large"))).toBe(true);
    });
  });

  it("infers mimeType per extension (the outbound file-type matrix)", async () => {
    await withTempDir(async (dir) => {
      const cases: Array<[string, string]> = [
        ["a.md", "text/markdown"],
        ["a.txt", "text/plain"],
        ["a.csv", "text/csv"],
        ["a.json", "application/json"],
        ["a.pdf", "application/pdf"],
        ["a.png", "image/png"],
        ["a.jpg", "image/jpeg"],
        ["a.jpeg", "image/jpeg"],
        ["a.gif", "image/gif"],
        ["a.webp", "image/webp"],
        ["a.svg", "image/svg+xml"],
        ["a.mp3", "audio/mpeg"],
        ["a.wav", "audio/wav"],
        ["a.mp4", "video/mp4"],
        ["a.webm", "video/webm"],
        ["a.mov", "video/quicktime"],
        ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        ["a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        ["a.zip", "application/zip"],
        ["a.unknownext", "application/octet-stream"],
      ];
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      for (const [name, mime] of cases) {
        await writeFile(join(dir, name), "x");
        const got = await fetcher.open(
          `/home/node/.openclaw/media/outbound/${name}`,
        );
        expect(got, name).not.toBeNull();
        expect(got!.mimeType, name).toBe(mime);
      }
    });
  });

  it("maps the gateway path onto baseDir by BASENAME (mount point decoupled)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "r.pdf"), "%PDF-1.4 ...");
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      // A different absolute layout still resolves by basename into baseDir.
      const got = await fetcher.open("/srv/openclaw/media/outbound/r.pdf");
      expect(got).not.toBeNull();
      expect(got!.mimeType).toBe("application/pdf");
    });
  });
});
