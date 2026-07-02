// Proves the outbound-media byte path END TO END without any gateway access:
// drop a file in a temp dir, point the fetcher at it, assert the streamed bytes
// + mime. The same code reads the `:ro` mount in prod and an SSHFS/synced dir
// in dev, and streams (no base64, no full buffer) into a Convex upload URL.
//
// Also locks the STRUCTURAL reason codes open() returns on every failure path —
// these drive the SOC2-safe outbound-media diagnostic (each reason is a DIFFERENT
// operator fix; collapsing them to a bare "dropped" would make prod undebuggable).

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, symlink, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  LocalDirMediaFetcher,
  type OpenResult,
  type MediaSkipReason,
} from "../src/core/media-fetcher.js";

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

/** Narrow a success result or fail the test loudly. */
function opened(got: OpenResult): Extract<OpenResult, { ok: true }> {
  if (!got.ok) throw new Error(`expected bytes, got skip "${got.reason}"`);
  return got;
}

/** Narrow a skip result and return its structural reason code. */
function skipReason(got: OpenResult): MediaSkipReason {
  if (got.ok) throw new Error("expected a skip, got bytes");
  return got.reason;
}

describe("LocalDirMediaFetcher", () => {
  it("streams bytes + infers mime + reports size for a file in the media dir", async () => {
    await withTempDir(async (dir) => {
      const content = "# fruits\n- pomme\n- poire\n";
      await writeFile(join(dir, "fruits---abc.md"), content);
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      const got = opened(
        await fetcher.open("/home/node/.openclaw/media/outbound/fruits---abc.md"),
      );
      expect(got.mimeType).toBe("text/markdown");
      expect(got.size).toBe(Buffer.byteLength(content));
      expect((await drain(got.stream)).toString("utf-8")).toContain("# fruits");
    });
  });

  it("REJECTS a symlink (reason=symlink_rejected) — never follows it out of the media dir", async () => {
    await withTempDir(async (dir) => {
      const outside = await mkdtemp(join(tmpdir(), "oc-secret-"));
      try {
        const secret = join(outside, "secret.txt");
        await writeFile(secret, "TOP SECRET — outside the media dir");
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
        expect(skipReason(got)).toBe("symlink_rejected"); // link target never streamed
        expect(skips.some((s) => s.includes("symlink"))).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("reason=not_found (never throws) for a missing file", async () => {
    await withTempDir(async (dir) => {
      const skips: string[] = [];
      const fetcher = new LocalDirMediaFetcher({
        baseDir: dir,
        maxBytes: 1024,
        onSkip: (reason) => skips.push(reason),
      });
      const got = await fetcher.open(
        "/home/node/.openclaw/media/outbound/nope.md",
      );
      expect(skipReason(got)).toBe("not_found");
      expect(skips).toContain("not found");
    });
  });

  it("reason=too_large for a file above the size cap", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "big.bin"), Buffer.alloc(2048));
      const skips: string[] = [];
      const fetcher = new LocalDirMediaFetcher({
        baseDir: dir,
        maxBytes: 1024,
        onSkip: (reason) => skips.push(reason),
      });
      const got = await fetcher.open(
        "/home/node/.openclaw/media/outbound/big.bin",
      );
      expect(skipReason(got)).toBe("too_large");
      expect(skips.some((s) => s.startsWith("too large"))).toBe(true);
    });
  });

  it("reason=not_a_file when the path resolves to a directory", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "adir"));
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      const got = await fetcher.open(
        "/home/node/.openclaw/media/outbound/adir",
      );
      expect(skipReason(got)).toBe("not_a_file");
    });
  });

  it("reason=invalid_filename for a degenerate basename ('.')", async () => {
    await withTempDir(async (dir) => {
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      // basename("/.../.") === "." — must never reach a join.
      const got = await fetcher.open("/home/node/.openclaw/media/outbound/.");
      expect(skipReason(got)).toBe("invalid_filename");
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
        const got = opened(
          await fetcher.open(`/home/node/.openclaw/media/outbound/${name}`),
        );
        expect(got.mimeType, name).toBe(mime);
      }
    });
  });

  it("maps the gateway path onto baseDir by BASENAME (mount point decoupled)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "r.pdf"), "%PDF-1.4 ...");
      const fetcher = new LocalDirMediaFetcher({ baseDir: dir, maxBytes: 1024 });
      // A different absolute layout still resolves by basename into baseDir.
      const got = opened(await fetcher.open("/srv/openclaw/media/outbound/r.pdf"));
      expect(got.mimeType).toBe("application/pdf");
    });
  });
});

describe("LocalDirMediaFetcher — freshness guard (stale mentions)", () => {
  it("rejects a file OLDER than rejectOlderThanMs with reason stale_mention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-stale-"));
    const file = join(dir, "old-report.md");
    await writeFile(file, "old content");
    // Backdate the file a week (the memory-note case from the exports bug).
    const weekAgo = (Date.now() - 7 * 24 * 3600 * 1000) / 1000;
    await utimes(file, weekAgo, weekAgo);
    const fetcher = new LocalDirMediaFetcher({
      baseDir: dir,
      maxBytes: 1024,
      onSkip: () => {},
    });
    const res = await fetcher.open(
      "/home/node/.openclaw/media/outbound/old-report.md",
      { rejectOlderThanMs: Date.now() - 120_000 },
    );
    expect(res).toEqual({ ok: false, reason: "stale_mention" });
  });

  it("a FRESH file passes the same bound (the just-written exec case)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-fresh-"));
    const file = join(dir, "fresh-report.md");
    await writeFile(file, "fresh content");
    const fetcher = new LocalDirMediaFetcher({
      baseDir: dir,
      maxBytes: 1024,
      onSkip: () => {},
    });
    const res = await fetcher.open(
      "/home/node/.openclaw/media/outbound/fresh-report.md",
      { rejectOlderThanMs: Date.now() - 120_000 },
    );
    expect(res.ok).toBe(true);
  });

  it("NO bound (explicit delivery) opens an old file — re-sending on request stays legit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-explicit-"));
    const file = join(dir, "old-but-wanted.md");
    await writeFile(file, "old content");
    const weekAgo = (Date.now() - 7 * 24 * 3600 * 1000) / 1000;
    await utimes(file, weekAgo, weekAgo);
    const fetcher = new LocalDirMediaFetcher({
      baseDir: dir,
      maxBytes: 1024,
      onSkip: () => {},
    });
    const res = await fetcher.open(
      "/home/node/.openclaw/media/outbound/old-but-wanted.md",
    );
    expect(res.ok).toBe(true);
  });
});
