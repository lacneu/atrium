// Settings › Trash › orphaned files, as pure data: which report the card shows and
// whether its "apply" may be offered. The server re-checks every condition
// (convex/blobSweep.startBlobSweep) — this only keeps the button honest.

import type { FunctionReturnType } from "convex/server";
import type { api } from "../convexApi";

export type SweepRow = FunctionReturnType<typeof api.blobSweep.listBlobSweeps>[number];

export type ApplyBlock =
  | "running"
  | "no_report"
  | "expired"
  | "mirror"
  | "nothing"
  | null;

export type SweepView = {
  /** A sweep whose chain is alive. */
  running: SweepRow | null;
  /** The newest finished dry run — the report the admin reads and may apply. */
  report: SweepRow | null;
  /** The newest apply that ended (done or refused), if it is newer than the report. */
  lastApply: SweepRow | null;
  /** Why "apply" is not offered, or null when it is. */
  applyBlock: ApplyBlock;
};

/** `rows` newest first, as listBlobSweeps returns them. */
export function sweepView(rows: readonly SweepRow[], now: number): SweepView {
  const running = rows.find((r) => r.status === "running" && !r.stale) ?? null;
  const report = rows.find((r) => r.mode === "dryRun" && r.status === "done") ?? null;
  const lastApply =
    rows.find(
      (r) =>
        r.mode === "apply" &&
        (r.status === "done" || r.status === "refused") &&
        (report === null || r.startedAt > report.startedAt),
    ) ?? null;
  let applyBlock: ApplyBlock = null;
  if (running !== null) applyBlock = "running";
  else if (report === null || lastApply !== null) applyBlock = "no_report";
  else if (report.applicableUntil === null || report.applicableUntil <= now) applyBlock = "expired";
  else if (report.mirrorMissing > 0) applyBlock = "mirror";
  else if (report.orphans.count === 0) applyBlock = "nothing";
  return { running, report, lastApply, applyBlock };
}
