// The Control UI's status badge, ported (0.101.4). The first block is upstream's own test,
// ui/src/lib/session-run-state.test.ts at v2026.9.33, verbatim; the table pins the badge
// rule of ui/src/pages/sessions/session-status.ts:17-37.
import { describe, expect, it } from "vitest";
import {
  SESSION_RUN_STATUSES,
  atriumStatusOfDisplay,
  isSessionRunActive,
  sessionRowDisplay,
  sessionRowKind,
} from "./sessionRowStatus";

describe("isSessionRunActive (upstream ui/src/lib/session-run-state.test.ts)", () => {
  it("uses explicit live-run state over stale running status", () => {
    expect(isSessionRunActive({ status: "running", hasActiveRun: false })).toBe(false);
    expect(isSessionRunActive({ status: "running", hasActiveRun: true })).toBe(true);
  });

  it("keeps terminal status authoritative over stale active flags", () => {
    expect(isSessionRunActive({ status: "done", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "failed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "killed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "timeout", hasActiveRun: true })).toBe(false);
  });

  it("keeps legacy running status active when no live-run flag exists", () => {
    expect(isSessionRunActive({ status: "running" })).toBe(true);
    expect(isSessionRunActive({ hasActiveRun: true })).toBe(true);
  });

  it("keeps queued work active before execution starts", () => {
    expect(isSessionRunActive({ status: "queued", hasActiveRun: true })).toBe(true);
    expect(isSessionRunActive({ status: "queued" })).toBe(true);
  });
});

describe("the badge (session-status.ts:17-37)", () => {
  it("label and kind for every row shape", () => {
    const cases: Array<[Parameters<typeof sessionRowDisplay>[0], string, string]> = [
      [{ status: "queued" }, "queued", "warn"],
      [{ status: "queued", hasActiveRun: false }, "queued", "warn"],
      [{ status: "running" }, "live", "ok"],
      [{ status: "running", hasActiveRun: true }, "live", "ok"],
      [{ status: "running", hasActiveRun: false }, "idle", "muted"],
      [{ hasActiveRun: false }, "idle", "muted"],
      [{ hasActiveRun: true }, "live", "ok"],
      [{}, "unknown", "muted"],
      [{ status: "done" }, "done", "ok"],
      [{ status: "done", hasActiveRun: true }, "done", "ok"],
      [{ status: "failed" }, "failed", "danger"],
      [{ status: "timeout", hasActiveRun: false }, "timeout", "danger"],
      [{ status: "killed" }, "killed", "danger"],
      [{ status: "interrupted" }, "interrupted", "muted"],
    ];
    for (const [row, label, kind] of cases) {
      expect([sessionRowDisplay(row), sessionRowKind(row)], JSON.stringify(row)).toEqual([label, kind]);
    }
  });

  it("maps every word onto Atrium's four states; idle and unknown leave the state alone", () => {
    expect(
      SESSION_RUN_STATUSES.map((s) => [s, atriumStatusOfDisplay(sessionRowDisplay({ status: s }))]),
    ).toEqual([
      ["queued", "running"],
      ["running", "running"],
      ["done", "done"],
      ["failed", "error"],
      ["interrupted", "aborted"],
      ["killed", "aborted"],
      ["timeout", "error"],
    ]);
    expect(atriumStatusOfDisplay("idle")).toBeNull();
    expect(atriumStatusOfDisplay("unknown")).toBeNull();
  });
});
