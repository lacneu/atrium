// @vitest-environment node
//
// The run lock: exclusive between collector runs and restores, held for the whole
// run (a restore cannot slip in between the listing and the deletes), refused at
// start while a restore holds it, and dropped by the kernel when its holder dies.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "./atrium-blob-gc.ts";
import { acquireRunLock, type LockTool } from "./run-lock.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atrgc-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const available = (tool: LockTool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
/** Every lock tool this host has (both use flock(2), so they exclude each other). */
const tools = (["flock", "perl"] as const).filter(available);

describe.each(tools)("acquireRunLock (%s)", (tool) => {
  test("exclusive: a second holder is refused until the first releases", async () => {
    const path = join(dir, "atrium-gc.lock");
    const first = await acquireRunLock(path, tool);
    expect(first).not.toBeNull();
    expect(await acquireRunLock(path, tool)).toBeNull();
    await first!.release();
    const again = await acquireRunLock(path, tool);
    expect(again).not.toBeNull();
    await again!.release();
  });
});

test("a holder killed with SIGKILL loses the lock (no stale lock)", async () => {
  const path = join(dir, "atrium-gc.lock");
  const url = pathToFileURL(join(import.meta.dirname, "run-lock.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireRunLock } from ${JSON.stringify(url)};
       const lock = await acquireRunLock(process.argv[1]);
       console.log(lock ? "held" : "busy");
       setInterval(() => {}, 1000);`,
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((ok) => child.stdout!.on("data", (d: Buffer) => d.toString().includes("held") && ok()));
  expect(await acquireRunLock(path)).toBeNull();
  child.kill("SIGKILL");
  let lock = null;
  for (let i = 0; i < 50 && lock === null; i++) {
    lock = await acquireRunLock(path);
    if (lock === null) await new Promise((ok) => setTimeout(ok, 100));
  }
  expect(lock).not.toBeNull();
  await lock!.release();
});

describe("the collector under the run lock", () => {
  const DAY = 86_400_000;
  const b64 = (body: string) => createHash("sha256").update(body).digest("base64");
  const live = { storageId: "id-a", sha256: b64("alpha"), size: 5, contentType: null, createdAt: Date.now() - 5 * DAY };

  /** A volume with one live object and one orphan eligible for deletion. */
  async function setup(onRead: () => Promise<void> = async () => {}) {
    const files = join(dir, "vol", "storage", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "a.blob"), "alpha");
    await writeFile(join(files, "b.blob"), "beta");
    const old = new Date(Date.now() - 3 * DAY);
    await utimes(join(files, "a.blob"), old, old);
    await utimes(join(files, "b.blob"), old, old);
    await writeFile(join(dir, "key"), "synthetic-admin-key");
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(
      join(dir, "state", "files.json"),
      JSON.stringify({ version: 1, target: `local:${files}`, orphanSince: { "b.blob": Date.now() - 2 * DAY }, digests: {} }),
    );
    const server: Server = createServer((_req, res) => {
      void onRead().then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "success", value: { blobs: [live], isDone: true, continueCursor: "e" } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as { port: number };
    const args = [
      "--convex-url", `http://127.0.0.1:${port}`,
      "--admin-key-file", join(dir, "key"),
      "--volume", join(dir, "vol"),
      "--state", join(dir, "state", "files.json"),
      "--apply",
    ];
    return { args, server, orphan: join(files, "b.blob"), lock: join(dir, "state", "atrium-gc.lock") };
  }

  test("a restore holding the lock: the collector refuses to start, nothing deleted", async () => {
    const { args, server, orphan, lock } = await setup();
    const restore = await acquireRunLock(lock);
    try {
      expect(await main(args)).toBe(2);
      expect((await stat(orphan)).size).toBe(4);
    } finally {
      await restore!.release();
    }
    expect(await main(args)).toBe(0);
    await expect(stat(orphan)).rejects.toThrow();
    server.close();
  });

  test("while a run is between its reads and its deletes, a restore cannot take the lock", async () => {
    let seenByRestore: Awaited<ReturnType<typeof acquireRunLock>> | "unset" = "unset";
    const { args, server, lock } = await setup(async () => {
      if (seenByRestore === "unset") seenByRestore = await acquireRunLock(lock);
    });
    expect(await main(args)).toBe(0);
    expect(seenByRestore).toBeNull();
    // Released on exit: the restore gets it now.
    const after = await acquireRunLock(lock);
    expect(after).not.toBeNull();
    await after!.release();
    server.close();
  });
});
