// Phase 3 — the inbound dir reaper. The TTL guard MUST keep a fresh (mid-turn) file
// and reap only stale ones, or the agent could lose a file it is still reading.

import { afterEach, describe, expect, it } from "vitest";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapDecision, sweepInboundDir } from "../src/core/inbound-reaper.js";

describe("reapDecision", () => {
  it("reaps strictly older than the TTL; keeps younger/equal", () => {
    expect(reapDecision({ ageMs: 1001, ttlMs: 1000 })).toBe(true);
    expect(reapDecision({ ageMs: 1000, ttlMs: 1000 })).toBe(false); // mid-turn-safe
    expect(reapDecision({ ageMs: 1, ttlMs: 1000 })).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("sweepInboundDir", () => {
  it("reaps stale files and KEEPS fresh ones (no mid-turn deletion)", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "atrium-reap-")));
    dirs.push(dir);
    const now = 1_000_000_000_000;
    const ttlMs = 60_000;
    await writeFile(join(dir, "stale.bin"), "old");
    await writeFile(join(dir, "fresh.bin"), "new");
    // stale: mtime 2 min ago (> ttl); fresh: mtime 1 s ago (< ttl).
    await utimes(
      join(dir, "stale.bin"),
      new Date(now),
      new Date(now - 120_000),
    );
    await utimes(join(dir, "fresh.bin"), new Date(now), new Date(now - 1_000));

    const reaped = await sweepInboundDir(dir, ttlMs, now);
    expect(reaped).toBe(1);
    expect(await readdir(dir)).toEqual(["fresh.bin"]);
  });

  it("a missing dir is a no-op (0 reaped, never throws)", async () => {
    expect(await sweepInboundDir("/no/such/atrium/dir", 1000, 0)).toBe(0);
  });

  it("refuses a symlinked or non-canonical directory without touching its target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-reap-")));
    dirs.push(root);
    const alias = join(root, "alias");
    await writeFile(join(root, "protected"), "protected");
    await symlink(root, alias, "dir");

    expect(await sweepInboundDir(alias, 0, Date.now())).toBe(0);
    expect(await sweepInboundDir(`${root}/.`, 0, Date.now())).toBe(0);
    expect(await readFile(join(root, "protected"), "utf8")).toBe("protected");
  });

  it("never follows a symlink entry outside the swept directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-reap-")));
    const dir = join(root, "published");
    dirs.push(root);
    await mkdir(dir);
    const protectedPath = join(root, "protected");
    await writeFile(protectedPath, "protected");
    await symlink(protectedPath, join(dir, "escape"));

    expect(await sweepInboundDir(dir, 0, Date.now())).toBe(0);
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
  });

  it("unlinking a stale hardlink leaves the external name and bytes intact", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-reap-")));
    const dir = join(root, "published");
    dirs.push(root);
    await mkdir(dir);
    const protectedPath = join(root, "protected");
    const candidate = join(dir, "candidate");
    await writeFile(protectedPath, "protected");
    await link(protectedPath, candidate);
    await utimes(candidate, new Date(0), new Date(0));

    expect(await sweepInboundDir(dir, 1, Date.now())).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
  });
});
