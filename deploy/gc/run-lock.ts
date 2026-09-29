// THE RUN LOCK — one exclusive flock(2) lock shared by the collector and every
// restore (docs/installation/BACKUP.md §4, §6).
//
// WHY flock(2), AND WHY THROUGH A HELPER PROCESS. A restore can bring back a
// `_storage` record whose bytes the collector is about to delete. Checking a
// marker file before deleting leaves a window; only a lock HELD for the whole run
// (listing -> second inventory read -> deletes) and taken by the restore too
// closes it. flock(2) is that lock: the operator's side is one standard command
// (`flock <lock file> <restore command>`, util-linux or BusyBox), it waits for a
// running collector, and the kernel releases it when its holder dies — no stale
// PID file to judge, no PID namespace to reason about across containers. Node has
// no flock API, so the lock is held by a small child process: `flock -x -n FILE`
// (present in node:24-alpine via BusyBox, and in util-linux), or Perl's flock()
// where no flock command exists (a macOS workstation). The child keeps the lock
// while it reads its stdin; the collector's end of that pipe closes when the
// collector exits for any reason — normal exit, exception, SIGKILL — so the child
// exits and the kernel drops the lock.
//
// An O_EXCL lock file with a PID was the alternative: it needs stale detection
// (a PID from another container's namespace means nothing here) and a restore
// runbook would need our own script rather than a standard command.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LockTool = "flock" | "perl";

const PERL_HOLDER =
  'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or die "$!\\n"; ' +
  "flock($f, LOCK_EX | LOCK_NB) or exit 1; $| = 1; print \"locked\\n\"; 1 while <STDIN>;";

/** The flock command when there is one, Perl otherwise; null when neither. */
export function pickLockTool(env: NodeJS.ProcessEnv = process.env): LockTool | null {
  const forced = env.ATRIUM_GC_LOCK_TOOL;
  if (forced === "flock" || forced === "perl") return forced;
  for (const tool of ["flock", "perl"] as const) {
    const probe = spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    if (probe.status === 0) return tool;
  }
  return null;
}

export type RunLock = {
  /** Drop the lock (idempotent); resolves once the holder has exited. */
  release(): Promise<void>;
};

/**
 * Take the lock at `path` without waiting. Null when someone else holds it — a
 * restore or another collector run.
 */
export async function acquireRunLock(path: string, tool: LockTool | null = pickLockTool()): Promise<RunLock | null> {
  if (tool === null) {
    throw new Error("no flock command and no perl: cannot take the run lock (install util-linux or perl)");
  }
  await mkdir(dirname(path), { recursive: true });
  const child: ChildProcess =
    tool === "flock"
      ? spawn("flock", ["-x", "-n", path, "sh", "-c", "echo locked; exec cat"], { stdio: ["pipe", "pipe", "inherit"] })
      : spawn("perl", ["-e", PERL_HOLDER, path], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  const acquired = await new Promise<boolean>((ok, fail) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("locked\n")) ok(true);
    });
    child.once("error", fail);
    void exited.then((code) => {
      if (code === 1) ok(false);
      else fail(new Error(`run lock helper (${tool}) exited with ${code}`));
    });
  });
  if (!acquired) return null;
  let released: Promise<void> | null = null;
  return {
    release() {
      released ??= (async () => {
        child.stdin!.end();
        await exited;
      })();
      return released;
    },
  };
}
