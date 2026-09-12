// Phase 3 — the bridge OWNS the inbound shared-fs dir lifecycle (the OpenWebUI pipe
// leaned on OWUI's own cleanup; Atrium writes the bytes, so Atrium reaps them). A
// periodic sweep deletes files older than the TTL. The TTL MUST exceed the longest
// possible turn so a file is never reaped mid-read by the agent.

import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openCanonicalDirectory(dir: string): Promise<FileHandle | null> {
  if (!isAbsolute(dir) || resolve(dir) !== dir) return null;
  try {
    if ((await realpath(dir)) !== dir) return null;
    const handle = await open(
      dir,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const [opened, current] = await Promise.all([handle.stat(), lstat(dir)]);
    if (
      !opened.isDirectory() ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameObject(opened, current)
    ) {
      await handle.close().catch(() => undefined);
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

function anchoredDirectoryPath(handle: FileHandle, dir: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : dir;
}

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
  const handle = await openCanonicalDirectory(dir);
  if (handle === null) return 0;
  const anchoredDir = anchoredDirectoryPath(handle, dir);
  let entries: string[];
  try {
    entries = await readdir(anchoredDir);
  } catch {
    await handle.close().catch(() => undefined);
    return 0; // dir not created yet (no inbound file ever staged) — nothing to do
  }
  let reaped = 0;
  try {
    for (const name of entries) {
      const path = join(anchoredDir, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
        if (reapDecision({ ageMs: now - metadata.mtimeMs, ttlMs })) {
          await unlink(path);
          reaped++;
        }
      } catch {
        // Racing delete / permission / vanished — skip, the next sweep retries.
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
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
