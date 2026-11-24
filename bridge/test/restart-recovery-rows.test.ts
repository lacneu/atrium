// A TURN CUT BY A GATEWAY RESTART OR STOP, AS ITS TRANSCRIPT ROWS (bridge hop).
//
// `fixtures/restart-recovery-rows-2026.9.36.json` holds, verbatim, the rows two live proofs
// left on OpenClaw 2026.9.36: an in-process restart and a stop, each cutting a turn that was
// waiting on a tool, each followed by the gateway's own restart recovery — a `user` entry
// `[System] Your previous turn was interrupted…` with `provenance {kind: "internal_system",
// sourceTool: "main_session_restart_recovery"}` (upstream
// src/agents/main-session-recovery/main-session-restart-dispatch.ts `buildResumeMessage`,
// `resumeMainSessionWithinAdmission`), then a NEW run that answers.
//
// What Convex needs from these rows to say what happened (convex/restartRecovery.test.ts
// reads `fixtures/restart-recovery-projected-2026.9.36.json`, this hop's output):
//  - the recovery entry is a row of the RECOVERY run (its `<runId>:user` key), and states
//    its provenance;
//  - the interrupted run's rows carry its tool calls, one of them with no result.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toTranscriptRow, type TranscriptRow } from "../src/providers/openclaw/transcript-rows.js";

type Captured = { source: string; envelope: Record<string, unknown>; message: unknown };
type Capture = { sessionKey?: string; rows: Captured[] };

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/restart-recovery-rows-2026.9.36.json", import.meta.url), "utf8"),
) as { restart: Capture; stop: Capture };
const projected = JSON.parse(
  readFileSync(new URL("./fixtures/restart-recovery-projected-2026.9.36.json", import.meta.url), "utf8"),
) as { restart: TranscriptRow[]; stop: TranscriptRow[] };

const SESSION_KEY = raw.restart.sessionKey!;
const rowsOf = (capture: Capture): TranscriptRow[] =>
  capture.rows.flatMap((r) => {
    const row = toTranscriptRow(r.message, r.envelope, { sessionKey: SESSION_KEY });
    return row === null ? [] : [row];
  });

const INTERRUPTED = "webchat-f5d1f2db9ee87713854fde13ad4d7448c962f4e5dcd7fa9d485b1bef4d73fabf";
const RECOVERY = "a784bc6d-61a0-48df-a1b7-a7b3ecaab9fd";

describe("a turn cut by a gateway restart, as transcript rows", () => {
  const rows = rowsOf(raw.restart);

  it("reads the gateway's recovery entry as a row of the RECOVERY run, with its provenance", () => {
    const entry = rows.find((r) => r.provenanceSourceTool === "main_session_restart_recovery");
    expect(entry).toMatchObject({
      role: "user",
      seq: 12,
      runId: RECOVERY,
      sendId: RECOVERY,
      provenanceKind: "internal_system",
      idempotencyKind: "user",
    });
    // The entry names no link to the run it resumes: only its place in the transcript does.
    expect(entry?.steerTargetRunId).toBeUndefined();
    expect(rows.find((r) => r.seq === 11)).toMatchObject({ role: "assistant", runId: INTERRUPTED, stopReason: "toolUse" });
  });

  it("leaves the interrupted run's last tool call without a result", () => {
    const tools = rows
      .filter((r) => r.runId === INTERRUPTED)
      .flatMap((r) => (r.blocks ?? []).flatMap((b) => (b.type === "tool" ? [b] : [])));
    const byCall = new Map<string, Set<string>>();
    for (const t of tools) byCall.set(t.toolCallId, (byCall.get(t.toolCallId) ?? new Set()).add(t.status));
    const unanswered = [...byCall].filter(([, statuses]) => !statuses.has("result") && !statuses.has("error"));
    expect(unanswered).toHaveLength(1);
    expect(tools.find((t) => t.toolCallId === unanswered[0]![0])?.name).toBe("wait");
  });

  it("gives the recovery run its own rows, ending on an answer", () => {
    const own = rows.filter((r) => r.runId === RECOVERY && r.role === "assistant");
    expect(own.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(own.at(-1)?.text).toContain("interrompue");
  });

  it("produces exactly the rows the Convex hop is tested with", () => {
    expect(JSON.parse(JSON.stringify(rows))).toEqual(projected.restart);
  });
});

describe("a turn cut by a gateway stop, as transcript rows", () => {
  const rows = rowsOf(raw.stop);

  it("reads the recovery entry the same way, after a run whose calls all have a result", () => {
    const entry = rows.find((r) => r.provenanceSourceTool === "main_session_restart_recovery");
    expect(entry).toMatchObject({ role: "user", seq: 95, provenanceKind: "internal_system", runId: "c390ab3b-df0e-41c2-b69b-41f09c739df3" });
    const before = rows.filter((r) => r.seq < 95 && r.role !== "user");
    expect(new Set(before.map((r) => r.runId)).size).toBe(1);
    // The interrupted run stops on a tool exchange (an error result), never on an answer.
    expect(before.filter((r) => r.role === "assistant").at(-1)).toMatchObject({ stopReason: "toolUse" });
  });

  it("produces exactly the rows the Convex hop is tested with", () => {
    expect(JSON.parse(JSON.stringify(rows))).toEqual(projected.stop);
  });
});
