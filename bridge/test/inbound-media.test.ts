// Phase 3 — shared-fs inbound staging. Each test FAILS if its guard regresses:
// path traversal, the mid-stream byte cap, partial-file cleanup, the block format.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOUND_COLLISION,
  INBOUND_CLEANUP_FAILED,
  INBOUND_FETCH_FAILED,
  INBOUND_PATH_REFUSED,
  INBOUND_STAGE_FAILED,
  INBOUND_TOO_LARGE,
  buildFilesReceivedBlock,
  inboundDiskName,
  safeBasename,
  stageInboundReference,
  stageInboundReferences,
  type InboundMediaConfig,
} from "../src/core/inbound-media.js";

const dirs: string[] = [];
const stagingDirs = new Map<string, string>();
async function tempDir(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-inbound-")));
  const published = join(root, "published");
  const staging = join(root, ".staging");
  await mkdir(published, { mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  dirs.push(root);
  stagingDirs.set(published, staging);
  return published;
}
function stagingFor(published: string): string {
  const staging = stagingDirs.get(published);
  if (staging === undefined) throw new Error("missing test staging directory");
  return staging;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  stagingDirs.clear();
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
    expect(safeBasename("..\\other-cell\\secret")).toBe("secret");
    expect(safeBasename("..")).toBe("file");
    expect(safeBasename("")).toBe("file");
    expect(safeBasename("clean.pdf")).toBe("clean.pdf");
    expect(safeBasename("re\u0301sume\u0301.pdf")).toBe("résumé.pdf");
    expect(safeBasename("bad\nname.pdf")).toBe("file");
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
      stagingDir: stagingFor(dir),
      agentMount: "/home/node/inbound",
      maxBytes: 1024,
      fetchImpl: bytesFetch(data),
    };
    const staged = await stageInboundReference(
      {
        url: "https://convex/getUrl",
        mimeType: "text/plain",
        fileName: "doc.txt",
      },
      "cmid-0-doc.txt",
      config,
    );
    expect(staged.agentPath).toBe("/home/node/inbound/cmid-0-doc.txt");
    expect(staged.size).toBe(data.length);
    expect(staged.mimeType).toBe("text/plain");
    // The bytes actually landed at inboundDir (the bridge wrote them, not the pipe).
    expect(await readFile(join(dir, "cmid-0-doc.txt"), "utf8")).toBe(
      "hello world",
    );
    const metadata = await lstat(join(dir, "cmid-0-doc.txt"));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("preserves binary bytes and canonical Unicode names", async () => {
    const dir = await tempDir();
    const data = Uint8Array.from([0, 255, 1, 128, 10]);
    const diskName = "cmid-0-résumé-📄.bin";
    const staged = await stageInboundReference(
      { url: "u", mimeType: "application/octet-stream", fileName: diskName },
      diskName,
      {
        inboundDir: dir,
        stagingDir: stagingFor(dir),
        agentMount: "/home/node/inbound",
        maxBytes: data.length,
        fetchImpl: bytesFetch(data),
      },
    );
    expect(staged.agentPath).toBe(`/home/node/inbound/${diskName}`);
    expect(await readFile(join(dir, diskName))).toEqual(Buffer.from(data));
  });

  it("requires distinct private and published directories on one device", async () => {
    const published = await tempDir();
    const staging = stagingFor(published);
    expect((await lstat(published)).dev).toBe((await lstat(staging)).dev);
    const config = {
      inboundDir: published,
      stagingDir: published,
      agentMount: "/m",
      maxBytes: 1,
      fetchImpl: bytesFetch(new Uint8Array([1])),
    };
    await expect(
      stageInboundReference(
        { url: "u", mimeType: "x", fileName: "x" },
        "x",
        config,
      ),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);
    await expect(
      stageInboundReference({ url: "u", mimeType: "x", fileName: "x" }, "x", {
        ...config,
        stagingDir: join(published, "nested"),
      }),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);
  });

  it("requires canonical absolute directory paths before fetching", async () => {
    const published = await tempDir();
    const staging = stagingFor(published);
    const fetchImpl = vi.fn(bytesFetch(new Uint8Array([1])));

    await expect(
      stageInboundReference(
        { url: "sensitive-url", mimeType: "x", fileName: "x" },
        "x",
        {
          inboundDir: `${published}/../published`,
          stagingDir: `${staging}/../.staging`,
          agentMount: "/m",
          maxBytes: 1,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a simulated cross-device staging directory", async () => {
    const published = await tempDir();
    const staging = stagingFor(published);
    const stagingIdentity = await lstat(staging);
    const probe = await open(staging, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      stat: (this: FileHandle) => Promise<Stats>;
    };
    const originalStat = prototype.stat;
    await probe.close();
    let stagingStatCalls = 0;
    const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ) {
      const metadata = await originalStat.call(this);
      if (
        metadata.dev === stagingIdentity.dev &&
        metadata.ino === stagingIdentity.ino
      ) {
        stagingStatCalls += 1;
        if (stagingStatCalls > 1) {
          Object.defineProperty(metadata, "dev", {
            value: Number(metadata.dev) + 1,
          });
        }
      }
      return metadata;
    });
    try {
      await expect(
        stageInboundReference({ url: "u", mimeType: "x", fileName: "x" }, "x", {
          inboundDir: published,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 1,
          fetchImpl: bytesFetch(new Uint8Array([1])),
        }),
      ).rejects.toThrow(INBOUND_PATH_REFUSED);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a symlinked or shared-writable staging directory", async () => {
    for (const kind of ["symlink", "shared-writable"] as const) {
      const published = await tempDir();
      const staging = stagingFor(published);
      if (kind === "symlink") {
        await rm(staging, { recursive: true });
        await symlink(published, staging, "dir");
      } else {
        await chmod(staging, 0o722);
      }
      await expect(
        stageInboundReference({ url: "u", mimeType: "x", fileName: "x" }, "x", {
          inboundDir: published,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 1,
          fetchImpl: bytesFetch(new Uint8Array([1])),
        }),
      ).rejects.toThrow(INBOUND_PATH_REFUSED);
    }
  });

  it("publishes the final name only after the complete stream", async () => {
    const dir = await tempDir();
    let release!: () => void;
    let bodyStarted!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            bodyStarted();
            void released.then(() => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            });
          },
        }),
      )) as unknown as typeof fetch;

    const pending = stageInboundReference(
      { url: "u", mimeType: "text/plain", fileName: "complete.txt" },
      "complete.txt",
      {
        inboundDir: dir,
        stagingDir: stagingFor(dir),
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl,
      },
    );
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileStreaming = await readdir(dir);
    const privateWhileStreaming = await readdir(stagingFor(dir));
    release();
    const staged = await pending;

    expect(whileStreaming).not.toContain("complete.txt");
    expect(whileStreaming).toEqual([]);
    expect(privateWhileStreaming).toHaveLength(1);
    expect(privateWhileStreaming[0]).toMatch(/^\.atrium-inbound-.*\.part$/);
    expect(staged.size).toBe(11);
    expect(await readdir(dir)).toEqual(["complete.txt"]);
    expect(await readFile(join(dir, "complete.txt"), "utf8")).toBe(
      "firstsecond",
    );
  });

  it("keeps a committed publication successful when closing its file reports an error", async () => {
    const dir = await tempDir();
    const staging = stagingFor(dir);
    const closeFileImpl = vi.fn(async (file: FileHandle) => {
      await file.close();
      throw new Error("simulated close failure");
    });
    const staged = await stageInboundReference(
      { url: "u", mimeType: "text/plain", fileName: "committed.txt" },
      "committed.txt",
      {
        inboundDir: dir,
        stagingDir: staging,
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl: bytesFetch(new TextEncoder().encode("committed")),
        closeFileImpl,
      },
    );

    expect(closeFileImpl).toHaveBeenCalledOnce();
    expect(staged.agentPath).toBe("/m/committed.txt");
    expect(await readFile(join(dir, "committed.txt"), "utf8")).toBe(
      "committed",
    );
    expect(await readdir(staging)).toEqual([]);
  });

  it("keeps a close error fatal before publication commits", async () => {
    const dir = await tempDir();
    const staging = stagingFor(dir);
    const closeFileImpl = vi.fn(async (file: FileHandle) => {
      await file.close();
      throw new Error("simulated close failure");
    });
    await expect(
      stageInboundReference(
        { url: "u", mimeType: "x", fileName: "uncommitted" },
        "uncommitted",
        {
          inboundDir: dir,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 32,
          fetchImpl: bytesFetch(new Uint8Array(1), false),
          closeFileImpl,
        },
      ),
    ).rejects.toThrow(INBOUND_STAGE_FAILED);
    expect(closeFileImpl).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("ABORTS + DELETES the partial file when the stream exceeds maxBytes", async () => {
    const dir = await tempDir();
    const data = new Uint8Array(5000); // > maxBytes
    const config: InboundMediaConfig = {
      inboundDir: dir,
      stagingDir: stagingFor(dir),
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
      stagingDir: stagingFor(dir),
      agentMount: "/m",
      maxBytes: 1024,
      fetchImpl: bytesFetch(new Uint8Array(1), false),
    };
    await expect(
      stageInboundReference(
        { url: "u", mimeType: "x", fileName: "f" },
        "f",
        config,
      ),
    ).rejects.toThrow(INBOUND_FETCH_FAILED);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses traversal and malformed leaves before fetching", async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(bytesFetch(new Uint8Array([1])));
    for (const diskName of [
      "../state",
      "/absolute",
      "other\\cell",
      "bad\nname",
      "re\u0301sume\u0301.pdf",
    ]) {
      await expect(
        stageInboundReference(
          { url: "sensitive-url", mimeType: "x", fileName: "x" },
          diskName,
          {
            inboundDir: dir,
            stagingDir: stagingFor(dir),
            agentMount: "/m",
            maxBytes: 1,
            fetchImpl,
          },
        ),
      ).rejects.toThrow(INBOUND_PATH_REFUSED);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses symlink, hardlink, and regular-file collisions without alteration", async () => {
    for (const kind of ["symlink", "hardlink", "regular"] as const) {
      const root = await tempDir();
      const inbound = join(root, "inbound");
      await mkdir(inbound, { mode: 0o700 });
      const protectedPath = join(root, `protected-${kind}`);
      const target = join(inbound, "reserved");
      await writeFile(protectedPath, "protected", { mode: 0o600 });
      if (kind === "symlink") await symlink(protectedPath, target);
      if (kind === "hardlink") await link(protectedPath, target);
      if (kind === "regular")
        await writeFile(target, "existing", { mode: 0o600 });
      const fetchImpl = vi.fn(
        bytesFetch(new TextEncoder().encode("replacement")),
      );

      await expect(
        stageInboundReference(
          { url: "sensitive-url", mimeType: "x", fileName: "x" },
          "reserved",
          {
            inboundDir: inbound,
            stagingDir: stagingFor(root),
            agentMount: "/m",
            maxBytes: 32,
            fetchImpl,
          },
        ),
      ).rejects.toThrow(INBOUND_COLLISION);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(protectedPath, "utf8")).toBe("protected");
      if (kind === "regular") {
        expect(await readFile(target, "utf8")).toBe("existing");
      }
    }
  });

  it("refuses symlinked or shared-writable inbound paths", async () => {
    const root = await tempDir();
    const inbound = join(root, "inbound");
    const alias = join(root, "alias");
    await mkdir(inbound, { mode: 0o700 });
    await symlink(inbound, alias, "dir");
    const fetchImpl = vi.fn(bytesFetch(new Uint8Array([1])));
    const ref = { url: "sensitive-url", mimeType: "x", fileName: "x" };
    await expect(
      stageInboundReference(ref, "safe", {
        inboundDir: alias,
        stagingDir: stagingFor(root),
        agentMount: "/m",
        maxBytes: 1,
        fetchImpl,
      }),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);

    await chmod(inbound, 0o722);
    await expect(
      stageInboundReference(ref, "safe", {
        inboundDir: inbound,
        stagingDir: stagingFor(root),
        agentMount: "/m",
        maxBytes: 1,
        fetchImpl,
      }),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);

    const unsafeParent = join(root, "unsafe-parent");
    const child = join(unsafeParent, "inbound");
    await mkdir(child, { recursive: true, mode: 0o700 });
    await chmod(unsafeParent, 0o722);
    await expect(
      stageInboundReference(ref, "safe", {
        inboundDir: child,
        stagingDir: stagingFor(root),
        agentMount: "/m",
        maxBytes: 1,
        fetchImpl,
      }),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("removes a partial stream and permits an explicit retry", async () => {
    const dir = await tempDir();
    const brokenFetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("private upstream detail"));
          },
        }),
      )) as unknown as typeof fetch;
    const ref = { url: "sensitive-url", mimeType: "x", fileName: "retry" };
    await expect(
      stageInboundReference(ref, "retry", {
        inboundDir: dir,
        stagingDir: stagingFor(dir),
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl: brokenFetch,
      }),
    ).rejects.toThrow(INBOUND_STAGE_FAILED);
    expect(await readdir(dir)).toEqual([]);

    const staged = await stageInboundReference(ref, "retry", {
      inboundDir: dir,
      stagingDir: stagingFor(dir),
      agentMount: "/m",
      maxBytes: 32,
      fetchImpl: bytesFetch(new TextEncoder().encode("complete")),
    });
    expect(staged.size).toBe(8);
    expect(await readFile(join(dir, "retry"), "utf8")).toBe("complete");
  });

  it("does not follow a staging symlink installed during cleanup", async () => {
    const root = await tempDir();
    const inbound = join(root, "inbound");
    const protectedPath = join(root, "protected");
    await mkdir(inbound, { mode: 0o700 });
    await writeFile(protectedPath, "protected", { mode: 0o600 });

    let release!: () => void;
    let bodyStarted!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            bodyStarted();
            void released.then(() => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            });
          },
        }),
      )) as unknown as typeof fetch;

    const pending = stageInboundReference(
      { url: "u", mimeType: "text/plain", fileName: "final" },
      "final",
      {
        inboundDir: inbound,
        stagingDir: stagingFor(root),
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl,
      },
    );
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const privateStaging = stagingFor(root);
    const [stagingName] = await readdir(privateStaging);
    expect(stagingName).toMatch(/^\.atrium-inbound-.*\.part$/);
    await unlink(join(privateStaging, stagingName!));
    await symlink(protectedPath, join(privateStaging, stagingName!));
    release();

    await expect(pending).rejects.toThrow(INBOUND_CLEANUP_FAILED);
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
    expect(
      (await lstat(join(privateStaging, stagingName!))).isSymbolicLink(),
    ).toBe(true);
    expect(await readdir(inbound)).not.toContain("final");
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
      {
        inboundDir: dir,
        stagingDir: stagingFor(dir),
        agentMount: "/m",
        maxBytes: 1024,
        fetchImpl,
      },
      (name) => dropped.push(name),
    );
    expect(staged).toHaveLength(1);
    expect(staged[0]!.agentPath).toBe("/m/cmid-0-ok.pdf");
    expect(dropped).toEqual(["bad.mp4"]);
  });

  it("stops the batch when the inbound directory is unsafe", async () => {
    const root = await tempDir();
    const inbound = join(root, "inbound");
    await mkdir(inbound, { mode: 0o700 });
    await chmod(inbound, 0o722);
    const fetchImpl = vi.fn(bytesFetch(new Uint8Array([1])));
    const onDrop = vi.fn();

    await expect(
      stageInboundReferences(
        [{ url: "u", mimeType: "x", fileName: "a" }],
        "cmid",
        {
          inboundDir: inbound,
          stagingDir: stagingFor(root),
          agentMount: "/m",
          maxBytes: 1,
          fetchImpl,
        },
        onDrop,
      ),
    ).rejects.toThrow(INBOUND_PATH_REFUSED);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("stops the batch when cleanup ownership becomes uncertain", async () => {
    const root = await tempDir();
    const inbound = join(root, "inbound");
    const protectedPath = join(root, "protected");
    await mkdir(inbound, { mode: 0o700 });
    await writeFile(protectedPath, "protected", { mode: 0o600 });
    let release!: () => void;
    let bodyStarted!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            bodyStarted();
            void released.then(() => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            });
          },
        }),
      )) as unknown as typeof fetch;
    const onDrop = vi.fn();

    const pending = stageInboundReferences(
      [{ url: "u", mimeType: "x", fileName: "a" }],
      "cmid",
      {
        inboundDir: inbound,
        stagingDir: stagingFor(root),
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl,
      },
      onDrop,
    );
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const privateStaging = stagingFor(root);
    const [stagingName] = await readdir(privateStaging);
    await unlink(join(privateStaging, stagingName!));
    await symlink(protectedPath, join(privateStaging, stagingName!));
    release();

    await expect(pending).rejects.toThrow(INBOUND_CLEANUP_FAILED);
    expect(onDrop).not.toHaveBeenCalled();
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
  });

  it("rolls back earlier publications when a later file fails fatally", async () => {
    const published = await tempDir();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(new Blob([new TextEncoder().encode("first")]));
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("private upstream detail"));
          },
        }),
      );
    }) as unknown as typeof fetch;

    await expect(
      stageInboundReferences(
        [
          { url: "u1", mimeType: "x", fileName: "first" },
          { url: "u2", mimeType: "x", fileName: "second" },
        ],
        "cmid",
        {
          inboundDir: published,
          stagingDir: stagingFor(published),
          agentMount: "/m",
          maxBytes: 32,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(INBOUND_STAGE_FAILED);
    expect(await readdir(published)).toEqual([]);
    expect(await readdir(stagingFor(published))).toEqual([]);
  });

  it("rolls back earlier publications when the staging mount disappears", async () => {
    const published = await tempDir();
    const staging = stagingFor(published);
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(new Blob([new TextEncoder().encode("first")]));
      }
      if (call === 2) {
        await rm(staging, { recursive: true, force: true });
        return new Response(null, { status: 502 });
      }
      throw new Error("third fetch must not start");
    }) as unknown as typeof fetch;

    await expect(
      stageInboundReferences(
        [
          { url: "u1", mimeType: "x", fileName: "first" },
          { url: "u2", mimeType: "x", fileName: "dropped" },
          { url: "u3", mimeType: "x", fileName: "fatal" },
        ],
        "cmid",
        {
          inboundDir: published,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 32,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(INBOUND_STAGE_FAILED);
    expect(call).toBe(2);
    expect(await readdir(published)).toEqual([]);
  });

  it("reports uncertain rollback when an earlier final gained a hardlink", async () => {
    const published = await tempDir();
    const externalLink = join(published, "external-link");
    let call = 0;
    let failSecond!: () => void;
    let secondStarted!: () => void;
    const fail = new Promise<void>((resolve) => {
      failSecond = resolve;
    });
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(new Blob([new TextEncoder().encode("first")]));
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            secondStarted();
            void fail.then(() =>
              controller.error(new Error("private upstream detail")),
            );
          },
        }),
      );
    }) as unknown as typeof fetch;
    const pending = stageInboundReferences(
      [
        { url: "u1", mimeType: "x", fileName: "first" },
        { url: "u2", mimeType: "x", fileName: "second" },
      ],
      "cmid",
      {
        inboundDir: published,
        stagingDir: stagingFor(published),
        agentMount: "/m",
        maxBytes: 32,
        fetchImpl,
      },
    );
    await started;
    await link(join(published, "cmid-0-first"), externalLink);
    failSecond();

    await expect(pending).rejects.toThrow(INBOUND_CLEANUP_FAILED);
    expect(await readFile(externalLink, "utf8")).toBe("first");
    expect(await readFile(join(published, "cmid-0-first"), "utf8")).toBe(
      "first",
    );
  });
});

describe("buildFilesReceivedBlock", () => {
  it("renders the [FICHIERS REÇUS] block with path + size + mime", () => {
    const block = buildFilesReceivedBlock([
      { agentPath: "/m/a.pdf", size: 12, mimeType: "application/pdf" },
    ]);
    expect(block).toBe(
      "\n[FICHIERS REÇUS]\n- /m/a.pdf (12 o, application/pdf)",
    );
  });
  it("is empty when nothing staged (no empty block)", () => {
    expect(buildFilesReceivedBlock([])).toBe("");
  });

  const ONE = [
    { agentPath: "/m/a.pdf", size: 12, mimeType: "application/pdf" },
  ];

  it("DISABLED → no block at all (even with files staged)", () => {
    expect(
      buildFilesReceivedBlock(ONE, {
        enabled: false,
        template: "ignored {files}",
      }),
    ).toBe("");
  });

  it("ENABLED with a custom template → splices it with {files} filled", () => {
    const block = buildFilesReceivedBlock(ONE, {
      enabled: true,
      template: "Fichiers:\n{files}",
    });
    expect(block).toContain("Fichiers:");
    expect(block).toContain("- /m/a.pdf (12 o, application/pdf)");
    expect(block).not.toContain("{files}");
  });

  it("ENABLED but empty template → falls back to the default block (no suppression)", () => {
    const block = buildFilesReceivedBlock(ONE, { enabled: true, template: "" });
    expect(block).toBe(
      "\n[FICHIERS REÇUS]\n- /m/a.pdf (12 o, application/pdf)",
    );
  });
});
