// Phase 3 — the inbound dir reaper. The TTL guard MUST keep a fresh (mid-turn) file
// and reap only stale ones, or the agent could lose a file it is still reading.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, utimes } from "node:fs/promises";
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
    const dir = await mkdtemp(join(tmpdir(), "atrium-reap-"));
    dirs.push(dir);
    const now = 1_000_000_000_000;
    const ttlMs = 60_000;
    await writeFile(join(dir, "stale.bin"), "old");
    await writeFile(join(dir, "fresh.bin"), "new");
    // stale: mtime 2 min ago (> ttl); fresh: mtime 1 s ago (< ttl).
    await utimes(join(dir, "stale.bin"), new Date(now), new Date(now - 120_000));
    await utimes(join(dir, "fresh.bin"), new Date(now), new Date(now - 1_000));

    const reaped = await sweepInboundDir(dir, ttlMs, now);
    expect(reaped).toBe(1);
    expect(await readdir(dir)).toEqual(["fresh.bin"]);
  });

  it("a missing dir is a no-op (0 reaped, never throws)", async () => {
    expect(await sweepInboundDir("/no/such/atrium/dir", 1000, 0)).toBe(0);
  });
});
