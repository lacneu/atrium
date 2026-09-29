// @vitest-environment node
//
// The volume store touches `storage/files` and nothing else, never follows a link
// out of it, and never deletes a file that changed after it was listed.

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalFilesStore, main, maintenanceRefusal } from "./atrium-blob-gc.ts";

let volume: string;

beforeEach(async () => {
  volume = await mkdtemp(join(tmpdir(), "atrgc-vol-"));
  await mkdir(join(volume, "storage", "files", "sub"), { recursive: true });
  for (const other of ["modules", "search", "exports", "snapshot_imports"]) {
    await mkdir(join(volume, "storage", other), { recursive: true });
    await writeFile(join(volume, "storage", other, "x.blob"), "not a file blob");
  }
  await writeFile(join(volume, "storage", "files", "a.blob"), "alpha");
  await writeFile(join(volume, "storage", "files", "sub", "b.blob"), "beta");
  await writeFile(join(volume, "storage", "files", "notes.txt"), "ignored");
  await symlink(join(volume, "storage", "modules", "x.blob"), join(volume, "storage", "files", "link.blob"));
});

afterEach(async () => {
  await rm(volume, { recursive: true, force: true });
});

describe("LocalFilesStore", () => {
  test("lists only the .blob files under storage/files, links excluded", async () => {
    const store = new LocalFilesStore(volume);
    const keys = (await store.list()).map((o) => o.key).sort();
    expect(keys).toEqual(["a.blob", "sub/b.blob"]);
  });

  test("digests the bytes", async () => {
    const store = new LocalFilesStore(volume);
    expect(await store.digest("a.blob")).toBe(createHash("sha256").update("alpha").digest("hex"));
  });

  test("deletes a listed file, but keeps one that changed since the listing", async () => {
    const store = new LocalFilesStore(volume);
    const [a, b] = (await store.list()).sort((x, y) => x.key.localeCompare(y.key));
    expect(await store.delete(a!)).toBe(true);
    await expect(stat(join(volume, "storage", "files", "a.blob"))).rejects.toThrow();
    const later = new Date(Date.now() + 60_000);
    await utimes(join(volume, "storage", "files", "sub", "b.blob"), later, later);
    expect(await store.delete(b!)).toBe(false);
    expect((await stat(join(volume, "storage", "files", "sub", "b.blob"))).size).toBe(4);
  });

  test("a key cannot reach outside the files directory", async () => {
    const store = new LocalFilesStore(volume);
    await expect(store.digest("../modules/x.blob")).rejects.toThrow(/escapes/);
  });

  test("a volume without storage/files is refused", async () => {
    await expect(new LocalFilesStore(join(volume, "nope")).list()).rejects.toThrow(/--volume/);
  });
});

describe("the maintenance lock", () => {
  test("absent: no refusal; present: refused", async () => {
    const lock = join(volume, "maintenance");
    expect(await maintenanceRefusal(null)).toBeNull();
    expect(await maintenanceRefusal(lock)).toBeNull();
    await writeFile(lock, "restore in progress");
    expect(await maintenanceRefusal(lock)).toMatch(/maintenance lock/);
  });

  test("while it exists the collector does nothing: exit 2, no state, no file touched", async () => {
    const lock = join(volume, "maintenance");
    const key = join(volume, "key");
    const state = join(volume, "state", "files.json");
    await writeFile(lock, "");
    await writeFile(key, "synthetic-admin-key");
    const code = await main([
      "--convex-url", "http://127.0.0.1:9",
      "--admin-key-file", key,
      "--volume", volume,
      "--state", state,
      "--maintenance-lock", lock,
      "--apply",
    ]);
    expect(code).toBe(2);
    await expect(stat(state)).rejects.toThrow();
    expect((await stat(join(volume, "storage", "files", "a.blob"))).size).toBe(5);
  });
});

describe("the apply re-reads the inventory right before deleting", () => {
  const DAY = 86_400_000;
  const b64 = (body: string) => createHash("sha256").update(body).digest("base64");
  const record = (id: string, body: string) => ({
    storageId: id,
    sha256: b64(body),
    size: body.length,
    contentType: null,
    createdAt: Date.now() - 5 * DAY,
  });

  /** An inventory endpoint answering `reads[i]` to the i-th full read. */
  async function inventory(reads: Array<ReturnType<typeof record>[]>): Promise<{ url: string; server: Server }> {
    let call = 0;
    const server = createServer((_req, res) => {
      const blobs = reads[Math.min(call, reads.length - 1)]!;
      call += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success", value: { blobs, isDone: true, continueCursor: "end" } }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, server };
  }

  async function run(reads: Array<ReturnType<typeof record>[]>) {
    const files = join(volume, "storage", "files");
    const old = new Date(Date.now() - 3 * DAY);
    await utimes(join(files, "sub", "b.blob"), old, old);
    await utimes(join(files, "a.blob"), old, old);
    const key = join(volume, "key");
    await writeFile(key, "synthetic-admin-key");
    const state = join(volume, "state.json");
    await writeFile(
      state,
      JSON.stringify({ version: 1, target: `local:${files}`, orphanSince: { "sub/b.blob": Date.now() - 2 * DAY }, digests: {} }),
    );
    const { url, server } = await inventory(reads);
    try {
      return await main(["--convex-url", url, "--admin-key-file", key, "--volume", volume, "--state", state, "--apply"]);
    } finally {
      server.close();
    }
  }

  const live = record("id-a", "alpha");
  const restored = record("id-b", "beta");

  test("orphaned in both reads: the object goes", async () => {
    expect(await run([[live], [live]])).toBe(0);
    await expect(stat(join(volume, "storage", "files", "sub", "b.blob"))).rejects.toThrow();
  });

  test("its record restored between the reads: nothing is deleted, exit 2", async () => {
    expect(await run([[live], [live, restored]])).toBe(2);
    expect((await stat(join(volume, "storage", "files", "sub", "b.blob"))).size).toBe(4);
  });
});
