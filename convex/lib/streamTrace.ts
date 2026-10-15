// The ONE writer of `assistant.stream` traces (D2 metadata only — never message text).
// Shared by the stream mutations and by every path that ends a live stream row outside
// them (the stuck-stream watchdog, the boot sweep, a message deletion), so the phase
// vocabulary and the correlation id cannot drift between them.

import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { writeTraceEvent } from "../observability";
import {
  regressionSummary,
  type RegressionSummary,
  type SnapshotSourceValue,
} from "./snapshotRegression";

/**
 * Build the stable per-turn correlationId for an assistant message. Prefers
 * `chatId:runId` (the whole conversational turn); falls back to chatId, then to
 * the messageId, so a trace is always correlatable even mid-run.
 *
 * TODO(M8): the user half (send.ts traceSend) keys on `${chatId}:${outboxId}`,
 * which is never associated with this `${chatId}:${runId}`. Linking the two
 * halves end-to-end needs the bridge to carry a single correlationId across the
 * turn (write the runId back onto the outbox row, or echo a shared id through
 * startAssistant). Bridge wiring — deferred.
 */
export function streamCorrelationId(
  chatId: Id<"chats">,
  runId: string | undefined,
  messageId: Id<"messages">,
): string {
  if (runId) return `${chatId}:${runId}`;
  if (chatId) return `${chatId}`;
  return `${messageId}`;
}

/**
 * Emit an `assistant.stream` trace (D2 metadata only — never message text).
 * Wrapped so a trace failure can NEVER abort the bridge's streaming mutation.
 */
export async function traceStream(
  ctx: MutationCtx,
  args: {
    phase:
      | "start"
      | "finalize"
      | "snapshot_regression"
      | "snapshot_regression_summary"
      | "finalize_repaired";
    chatId: Id<"chats">;
    runId: string | undefined;
    messageId: Id<"messages">;
    streamStatus: "streaming" | "complete" | "error" | "aborted" | "dropped_empty";
    textLen?: number;
    /** Snapshot regression only: the LENGTHS of the kept and refused texts.
     *  Lengths only — the texts themselves are conversational content (SOC2). */
    oldLen?: number;
    newLen?: number;
    /** Snapshot regression only: WHICH producer path wrote the refused snapshot, and
     *  which one wrote the text that was kept — closed vocabulary
     *  (lib/snapshotRegression.ts), never a free string. */
    snapshotSource?: SnapshotSourceValue;
    keptSource?: SnapshotSourceValue;
    /** `snapshot_regression_summary` only: the counters one stream accumulated after
     *  its first refusal (the first one is traced on its own). */
    regression?: RegressionSummary;
    /** `snapshot_regression_summary` only: WHICH path ended the stream row. */
    endedBy?: StreamEndPath;
    /** The CURATED failure class (`errorCode`) — a stable non-PHI code, never the
     *  gateway's text. Without it the anomaly detector could only count errors:
     *  a context overflow and two unrelated blips looked identical, so the signal
     *  named a number instead of a cause (C-01). */
    errorCode?: string;
    /** WHICH AGENT failed, for a cause whose remedy is per agent
     *  (PER_AGENT_FAILURE_CAUSES — a provider credential, permission, billing or model):
     *  ids only, never text. */
    failedAgent?: { agentId: string; instanceName?: string };
    /** The provider id the gateway's re-authentication hint names (an operator
     *  configuration value, shape-checked by `reauthProviderFromText`). */
    authProvider?: string;
  },
): Promise<void> {
  try {
    await writeTraceEvent(ctx, {
      kind: "assistant.stream",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      runId: args.runId,
      correlationId: streamCorrelationId(args.chatId, args.runId, args.messageId),
      meta: JSON.stringify({
        phase: args.phase,
        messageId: args.messageId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        streamStatus: args.streamStatus,
        ...(args.textLen !== undefined ? { textLen: args.textLen } : {}),
        ...(args.oldLen !== undefined ? { oldLen: args.oldLen } : {}),
        ...(args.newLen !== undefined ? { newLen: args.newLen } : {}),
        ...(args.snapshotSource !== undefined
          ? { snapshotSource: args.snapshotSource }
          : {}),
        ...(args.keptSource !== undefined ? { keptSource: args.keptSource } : {}),
        ...(args.regression !== undefined ? args.regression : {}),
        ...(args.endedBy !== undefined ? { endedBy: args.endedBy } : {}),
        ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
        ...(args.failedAgent !== undefined
          ? {
              agentId: args.failedAgent.agentId,
              ...(args.failedAgent.instanceName !== undefined
                ? { instanceName: args.failedAgent.instanceName }
                : {}),
            }
          : {}),
        ...(args.authProvider !== undefined ? { authProvider: args.authProvider } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the primary stream write on a trace error.
  }
}

/** Every path that ends a live stream row (each one calls `traceRegressionSummary`
 *  right before deleting it). */
export type StreamEndPath =
  | "finalize"
  | "dropped_empty"
  | "steer_segment"
  | "stuck_reconcile"
  | "stuck_reap"
  | "orphan_row"
  | "boot_sweep"
  | "message_deleted"
  | "chat_purge";

/**
 * The END of a stream that had MORE than one snapshot refused: ONE trace with the
 * counters its live row accumulated (stream.setSnapshot traced only the first).
 * A no-op for every other row — no read, no write. Call it BEFORE deleting the row.
 */
export async function traceRegressionSummary(
  ctx: MutationCtx,
  row: Doc<"streamingText">,
  args: {
    runId: string | undefined;
    streamStatus: "streaming" | "complete" | "error" | "aborted" | "dropped_empty";
    endedBy: StreamEndPath;
  },
): Promise<void> {
  const summary = regressionSummary(row.snapshotRegression);
  if (summary === null) return;
  await traceStream(ctx, {
    phase: "snapshot_regression_summary",
    chatId: row.chatId,
    runId: args.runId,
    messageId: row.messageId,
    streamStatus: args.streamStatus,
    regression: summary,
    endedBy: args.endedBy,
  });
}
