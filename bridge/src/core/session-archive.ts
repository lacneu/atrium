// THE CONVERSATION THAT STOPPED ANSWERING AFTER A WEEK.
//
// OpenClaw auto-archives a durable dashboard session after 7 days of inactivity —
// `session.maintenance.archiveDashboardAfter`, defaulting to
// DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS (upstream
// src/config/sessions/store-maintenance.ts:25) — and EVERY Atrium conversation is
// a dashboard session. An archived session then refuses everything that starts
// work, through one sentence (src/config/sessions/lifecycle.ts:124-125):
//
//   Session "<key>" is archived. Restore it before starting new work.
//
// `chat.send`, `sessions.reset` and the realtime voice consult all go through that
// same guard. Production, 2026-09-20: a user reopened a conversation older than a
// week, asked for an image, and nothing happened — while the voice agent answered
// "my attempt did not succeed" to anything needing the agent. Atrium showed no
// error at all: the conversation simply stopped replying.
//
// WHY RESTORE RATHER THAN OPEN A NEW SESSION. Both were on the table. A new key
// would be simpler, and Atrium's own thread would look untouched — but the model's
// side of the conversation would be gone, and the re-hydration that exists to paper
// over that is capped (it is skipped above a fill threshold and on any turn
// carrying an attachment). The user would be told nothing and would get an agent
// that had forgotten a week of work. Restoring keeps the gateway's own context, and
// costs nothing in resources that the maintenance policy does not immediately take
// back: the session re-archives after another 7 idle days. The archive policy stays
// exactly as the operator set it — this only undoes the archive for a conversation
// the person is demonstrably using again.
//
// WHY IT IS NOT THE USER'S PROBLEM. The product decision is that the person never
// meets this concept: they open a conversation, they type, it works. So the restore
// happens on the path that is ABOUT to need the session, before the work starts.

import type { GatewayRequester } from "../conf.js";

/** How the restore ended. Returned rather than thrown: every caller treats a
 *  failure as "carry on and let the gateway speak", never as a reason to lose a
 *  turn on its own. */
export type SessionRestoreOutcome =
  /** The session was not archived — nothing was sent. */
  | { kind: "not_archived" }
  /** It was archived, and the gateway accepted the restore. */
  | { kind: "restored" }
  /** The describe found no session at all: there is nothing to restore, and
   *  `sessions.create` (the claim) owns that case. */
  | { kind: "absent" }
  /** We could not tell (the describe failed, or answered without the field we
   *  need). NOTHING was attempted — see `ensureSessionRestored`. */
  | { kind: "unknown"; reason: string }
  /** It was archived and the restore did NOT take. The caller proceeds anyway:
   *  the gateway's own refusal is a better message than a guess of ours. */
  | { kind: "failed"; reason: string };

/** A `sessions.describe` answer, read for the two fields this decision needs. */
interface DescribedSession {
  archived: boolean;
  /** The optimistic-concurrency token the archive patch REQUIRES upstream
   *  (`expectedSessionId required for session lifecycle patch`,
   *  src/gateway/sessions-patch.ts:193-195). */
  sessionId: string | null;
}

/** Read the archive state off a `sessions.describe` payload.
 *
 *  Upstream presents BOTH `archived` (a boolean) and `archivedAt` (the instant),
 *  from the same entry field (src/gateway/session-utils-row.ts:514-515). The
 *  boolean is the primary reading and the timestamp is the fallback: a row that
 *  carries only one of them is still readable, and `archived` being absent is
 *  never silently taken as "not archived" when `archivedAt` says otherwise. */
export function readArchiveState(payload: unknown): DescribedSession | null {
  const sess = (payload as { session?: unknown } | undefined)?.session;
  if (sess === null || sess === undefined || typeof sess !== "object") return null;
  const row = sess as Record<string, unknown>;
  const archived =
    typeof row.archived === "boolean"
      ? row.archived
      : row.archivedAt !== undefined && row.archivedAt !== null;
  const sessionId =
    typeof row.sessionId === "string" && row.sessionId !== "" ? row.sessionId : null;
  return { archived, sessionId };
}

/**
 * Restore this session if the gateway has archived it. Safe to call on every path
 * that is about to start work; a session that is not archived costs one describe.
 *
 * FAIL-OPEN, ALWAYS. Every failure mode returns rather than throws, and the caller
 * carries on: a restore is a repair, and a repair that breaks the thing it repairs
 * is worse than the fault. If the restore did not take, the gateway refuses the
 * work itself with its own sentence — which the classifier names
 * (`isSessionArchivedText`), so the reader gets a real card instead of silence.
 *
 * THE RACE IS REAL AND IT IS HANDLED BY RETRYING ONCE. `expectedSessionId` is an
 * optimistic lock: the janitor can re-archive, or a concurrent turn can rotate the
 * session, between our describe and our patch — upstream then answers
 * `Session <key> changed before patch. Retry.`
 * (server-methods/sessions-patch-errors.ts:34-38). We re-read and try again, once.
 * A second failure is reported, not looped: a session that keeps moving under us is
 * a fact for the log, not something to spin on inside a user's turn.
 *
 * @param describeParams the same `{key, agentId}` the caller's own describe uses —
 *   the agent id matters, because a key can resolve per agent upstream.
 * @param opts.known the archive state the caller ALREADY read. The send path
 *   describes every turn anyway, so handing that answer over is what keeps this
 *   repair free: without it the first attempt would describe a second time — and,
 *   worse, a re-read that happens to answer "live" would silently skip the patch the
 *   caller's own read said was needed. Used for the FIRST attempt only; the retry
 *   always re-reads, because the whole point of the retry is that the row moved.
 */
export async function ensureSessionRestored(
  conn: GatewayRequester,
  sessionKey: string,
  describeParams: Record<string, unknown>,
  /** Sends the archive patch on whatever socket its scope requires. Injected so
   *  this module never has to know about operator sockets or auth modes. */
  patch: (params: Record<string, unknown>) => Promise<unknown>,
  opts?: { known?: DescribedSession | null; timeoutMs?: number },
): Promise<SessionRestoreOutcome> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let described: DescribedSession | null;
    if (attempt === 0 && opts?.known !== undefined) {
      described = opts.known;
    } else {
      try {
        const res = await conn.request("sessions.describe", describeParams, timeoutMs);
        described = readArchiveState(res.payload);
      } catch (err) {
        // A describe that fails tells us NOTHING. Saying "not archived" here would
        // be inventing a verdict; the send proceeds and the gateway decides.
        return { kind: "unknown", reason: errText(err) };
      }
    }
    if (described === null) return { kind: "absent" };
    if (!described.archived) return { kind: "not_archived" };
    if (described.sessionId === null) {
      // Archived, but the row carries no id to lock on — upstream refuses a
      // lifecycle patch without one, so there is nothing to send.
      return { kind: "unknown", reason: "archived session has no sessionId to lock on" };
    }
    try {
      await patch({
        ...describeParams,
        archived: false,
        expectedSessionId: described.sessionId,
      });
      return { kind: "restored" };
    } catch (err) {
      const reason = errText(err);
      // The optimistic lock lost a race: re-read and try once more. Anything else
      // is a real refusal and is reported as it stands.
      if (attempt === 0 && /changed before patch|expectedsessionid/i.test(reason)) {
        continue;
      }
      return { kind: "failed", reason };
    }
  }
  return { kind: "failed", reason: "the session kept changing under the restore" };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
