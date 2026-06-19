// Phase 3 — the bridge OWNS the inbound shared-fs dir lifecycle (the OpenWebUI pipe
// leaned on OWUI's own cleanup; Atrium writes the bytes, so Atrium reaps them). A
// periodic sweep deletes files older than the TTL. The TTL MUST exceed the longest
// possible turn so a file is never reaped mid-read by the agent.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Pure: should a file of this age be reaped? (the discriminating unit). */
export function reapDecision(opts: { ageMs: number; ttlMs: number }): boolean {
  return opts.ageMs > opts.ttlMs;
}

/** Sweep the dir once, deleting files older than `ttlMs`. Returns the count reaped.
 *  Tolerant: a missing dir, a racing delete, or an unreadable entry is skipped. */
export async function sweepInboundDir(
  dir: string,
  ttlMs: number,
  now: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // dir not created yet (no inbound file ever staged) — nothing to do
  }
  let reaped = 0;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      if (reapDecision({ ageMs: now - s.mtimeMs, ttlMs })) {
        await rm(p, { force: true });
        reaped++;
      }
    } catch {
      // racing delete / permission / vanished — skip, the next sweep retries.
    }
  }
  return reaped;
}

/** Start the periodic sweep (unref'd so it never holds the process open). Sweeps at
 *  most every 30 min, and at least once per TTL. */
export function startInboundReaper(
  dir: string,
  ttlMs: number,
  clock: () => number = () => Date.now(),
): NodeJS.Timeout {
  const intervalMs = Math.max(60_000, Math.min(ttlMs, 30 * 60 * 1000));
  const timer = setInterval(() => {
    void sweepInboundDir(dir, ttlMs, clock()).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
