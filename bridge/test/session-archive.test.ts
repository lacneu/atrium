// THE CONVERSATION THAT STOPPED ANSWERING AFTER A WEEK.
//
// OpenClaw auto-archives an idle dashboard session after 7 days
// (`session.maintenance.archiveDashboardAfter`, default
// DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS — upstream store-maintenance.ts:25), and every
// Atrium conversation is a dashboard session. The archived session then refuses
// everything that starts work with one sentence (lifecycle.ts:124-125):
//
//   Session "<key>" is archived. Restore it before starting new work.
//
// Production, 2026-09-20: a user reopened a week-old conversation, asked for an
// image, and nothing happened — no error card, no reply. The voice agent answered
// "my attempt did not succeed" to anything needing the agent, because the consult
// targets the same session key.
//
// The decision is that the person never meets this concept. These tests pin the
// two halves of that: the restore happens BEFORE the work, and every way it can
// fail leaves the turn no worse off than it was.

import { describe, expect, it, vi } from "vitest";

import {
  ensureSessionRestored,
  readArchiveState,
} from "../src/core/session-archive.js";
import { classifyGatewayError, faultDomain } from "../src/core/dispatch-errors.js";
import {
  classifyFailureText,
  isSessionArchivedText,
} from "../src/core/failure-classifier.js";

const KEY = "agent:olivier:atrium:chat:olivier:mh77m9e7q7ek";
const PARAMS = { key: KEY, agentId: "olivier" };

/** The gateway's own refusal, verbatim from upstream, as `chat.send` ships it. */
const ARCHIVED_REFUSAL = `INVALID_REQUEST: Session "${KEY}" is archived. Restore it before starting new work.`;

/** A describe answer. `archived` and `archivedAt` are BOTH presented upstream
 *  (session-utils-row.ts:514-515) — the shape here is the one the gateway sends. */
const describing = (session: Record<string, unknown> | null) => ({
  payload: session === null ? {} : { session },
});

function conn(answers: unknown[]) {
  let i = 0;
  return {
    request: vi.fn(async () => {
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a as { payload?: Record<string, unknown> };
    }),
  };
}

describe("reading the archive state off a describe", () => {
  it("reads the boolean the gateway presents", () => {
    expect(readArchiveState({ session: { archived: true, sessionId: "s1" } })).toEqual({
      archived: true,
      sessionId: "s1",
    });
  });

  it("falls back to `archivedAt` when only the timestamp is there", () => {
    // Both fields come from the same entry value upstream, but a row carrying only
    // one of them must still be readable — and `archived` being absent must never be
    // read as "not archived" while `archivedAt` says otherwise.
    expect(readArchiveState({ session: { archivedAt: 1789, sessionId: "s1" } })?.archived).toBe(
      true,
    );
  });

  it("a live session is not archived, and NO session is not a session", () => {
    expect(readArchiveState({ session: { sessionId: "s1" } })?.archived).toBe(false);
    expect(readArchiveState({ session: null })).toBeNull();
    expect(readArchiveState({})).toBeNull();
    expect(readArchiveState(undefined)).toBeNull();
  });
});

describe("restoring before the work starts", () => {
  it("an ARCHIVED session is restored, with the lock the gateway demands", async () => {
    const patch = vi.fn(async () => ({}));
    const c = conn([describing({ archived: true, sessionId: "s-42" })]);
    const out = await ensureSessionRestored(c, KEY, PARAMS, patch);

    expect(out).toEqual({ kind: "restored" });
    // `expectedSessionId` is MANDATORY upstream for a lifecycle patch
    // (sessions-patch.ts:193-195): without it the restore is refused outright.
    expect(patch).toHaveBeenCalledWith({
      key: KEY,
      agentId: "olivier",
      archived: false,
      expectedSessionId: "s-42",
    });
  });

  it("a LIVE session costs one describe and no patch", async () => {
    const patch = vi.fn(async () => ({}));
    const c = conn([describing({ archived: false, sessionId: "s-1" })]);
    expect(await ensureSessionRestored(c, KEY, PARAMS, patch)).toEqual({
      kind: "not_archived",
    });
    // The whole design rests on this: the repair must be free on the happy path,
    // which is every turn of every conversation younger than a week.
    expect(patch).not.toHaveBeenCalled();
    expect(c.request).toHaveBeenCalledTimes(1);
  });

  it("the JANITOR winning the race is retried ONCE, on a fresh read", async () => {
    // `expectedSessionId` is an optimistic lock: the session can be re-archived or
    // rotated between our describe and our patch, and upstream answers
    // `Session <key> changed before patch. Retry.` (sessions-patch-errors.ts:34-38).
    const patch = vi
      .fn()
      .mockRejectedValueOnce(new Error(`INVALID_REQUEST: Session ${KEY} changed before patch. Retry.`))
      .mockResolvedValueOnce({});
    const c = conn([
      describing({ archived: true, sessionId: "s-old" }),
      describing({ archived: true, sessionId: "s-new" }),
    ]);
    expect(await ensureSessionRestored(c, KEY, PARAMS, patch)).toEqual({ kind: "restored" });
    // The second attempt locks on the id from the SECOND read — retrying with the
    // stale one would lose the same race for ever.
    expect(patch.mock.calls[1]?.[0]).toMatchObject({ expectedSessionId: "s-new" });
  });

  it("a session that keeps moving is REPORTED, never looped on", async () => {
    const patch = vi
      .fn()
      .mockRejectedValue(new Error("INVALID_REQUEST: Session x changed before patch. Retry."));
    const c = conn([describing({ archived: true, sessionId: "s-1" })]);
    const out = await ensureSessionRestored(c, KEY, PARAMS, patch);
    expect(out.kind).toBe("failed");
    // Bounded: two patches, never a spin inside a user's turn.
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("a refusal that is NOT the race is reported at once", async () => {
    const patch = vi.fn().mockRejectedValue(new Error("FORBIDDEN: missing scope"));
    const c = conn([describing({ archived: true, sessionId: "s-1" })]);
    const out = await ensureSessionRestored(c, KEY, PARAMS, patch);
    expect(out.kind).toBe("failed");
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("a FAILED describe attempts nothing and says it does not know", async () => {
    // Inventing "not archived" from a failed read would be a verdict we did not
    // measure. The send proceeds; the gateway decides.
    const patch = vi.fn(async () => ({}));
    const c = conn([new Error("GATEWAY_TIMEOUT: sessions.describe timed out")]);
    expect((await ensureSessionRestored(c, KEY, PARAMS, patch)).kind).toBe("unknown");
    expect(patch).not.toHaveBeenCalled();
  });

  it("an archived row with NO sessionId cannot be locked, so nothing is sent", async () => {
    const patch = vi.fn(async () => ({}));
    const c = conn([describing({ archived: true })]);
    expect((await ensureSessionRestored(c, KEY, PARAMS, patch)).kind).toBe("unknown");
    expect(patch).not.toHaveBeenCalled();
  });

  it("NO session at all is `absent` — the claim owns that case, not this", async () => {
    const patch = vi.fn(async () => ({}));
    const c = conn([describing(null)]);
    expect((await ensureSessionRestored(c, KEY, PARAMS, patch)).kind).toBe("absent");
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("only a lost RACE is retried", () => {
  it("a MISSING expectedSessionId is reported at once — it answers the same every time", async () => {
    // Upstream writes two refusals about this field and only one is a race:
    //   `Session <key> changed before patch. Retry.`            -> retry
    //   `expectedSessionId required for session lifecycle patch` -> never
    // A predicate matching the bare field name took the second for the first and
    // paid a second describe + patch to be told the same thing. It also matched any
    // refusal whose operator data merely contained the word.
    const patch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `INVALID_REQUEST: expectedSessionId required for session lifecycle patch: ${KEY}`,
        ),
      );
    const c = conn([describing({ sessionId: "s-1", archived: true })]);
    const out = await ensureSessionRestored(c, KEY, PARAMS, patch);
    expect(out.kind).toBe("failed");
    expect(patch, "no second attempt on a refusal that cannot change").toHaveBeenCalledTimes(1);
  });
});

describe("the refusal that gets past the restore", () => {
  it("the gateway's own sentence is recognised, behind its INVALID_REQUEST prefix", () => {
    expect(isSessionArchivedText(ARCHIVED_REFUSAL)).toBe(true);
    expect(classifyGatewayError(new Error(ARCHIVED_REFUSAL))).toBe("session_archived");
  });

  it("an ATTACHMENT on the turn does not make it the file's fault", () => {
    // The generic attachment fallback claims any `invalid request` on a turn that
    // carried a file. Blaming the file here would be wrong AND terminal — the
    // session being archived has nothing to do with it.
    expect(
      classifyGatewayError(new Error(ARCHIVED_REFUSAL), { hasAttachments: true }),
    ).toBe("session_archived");
  });

  it("a REAL staging failure still wins over it", () => {
    expect(
      classifyGatewayError(
        new Error(`INVALID_REQUEST: attachment parse/stage failed. ${ARCHIVED_REFUSAL}`),
        { hasAttachments: true },
      ),
    ).toBe("ATTACHMENT_REJECTED");
  });

  it("the bridge stays GREEN: the gateway answered, and answered about the session", () => {
    expect(faultDomain("session_archived")).toBe("downstream");
  });

  it("the SECOND door is closed too: the same sentence arriving as FAILURE TEXT", () => {
    // The refusal reaches Atrium two ways. `classifyGatewayError` covers the
    // dispatch rejection; `classifyFailureText` covers the turn that was already
    // streaming — a run.status reason, a lifecycle error, a sub-agent's own
    // failure. Only the first was wired, so on the wire path the refusal landed in
    // the generic bucket: no card the reader can read, nothing for the per-cause
    // anomaly plane, and no automatic retry on the one failure a retry fixes.
    expect(classifyFailureText(ARCHIVED_REFUSAL)).toBe("session_archived");
    // The bare gateway sentence too — the stream path carries it without the
    // dispatch prefix.
    expect(
      classifyFailureText(
        'Session "agent:olivier:atrium:chat:olivier:mh77m9e7q7ek2xvr636e3bvfr58b9khn" is archived. Restore it before starting new work.',
      ),
    ).toBe("session_archived");
  });

  it("both readers agree on PRECEDENCE — a staging failure still wins on the text path", () => {
    // Two readers of one sentence must not disagree about which class wins.
    // Upstream's preflight-compaction wrapper, verbatim.
    expect(
      classifyFailureText(
        "\u26a0\ufe0f Context is too large and auto-compaction could not recover this turn. Reason: no conversation found for session. Try again, use /compact, or use /new to start a fresh session.",
      ),
    ).toBe("session_gone");
  });

  it("a session key containing the words cannot mint the class by itself", () => {
    expect(
      classifyFailureText(
        'Session "agent:a:atrium:chat:u:is-archived-restore-it-before-starting-new-work" was deleted while starting work. Retry.',
      ),
    ).not.toBe("session_archived");
    // The quoted key is blanked before the test (`withoutOperatorData`), so a chat
    // whose title or id reads like the sentence is not mistaken for the refusal.
    expect(
      isSessionArchivedText(
        'INVALID_REQUEST: Session "agent:a:atrium:chat:u:is-archived-restore-it-before-starting-new-work" was deleted while starting work. Retry.',
      ),
    ).toBe(false);
  });
});
