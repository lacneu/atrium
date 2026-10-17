// `on` TAKES NOTHING FROM THE LIVE SIDE BUT THE TEXT BEING WRITTEN (final design step 4) —
// the bridge's reading of the rows that now carry what the live stream no longer brings.
// Each case cites the upstream behaviour it reproduces (v2026.9.33).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseHistoryReply, RUN_FAILED_BEFORE_REPLY, streamSegmentEntryId, toTranscriptRow } from "../src/providers/openclaw/transcript-rows.js";

const SK = "agent:main:main";
const display = { sessionKey: SK };
const SEGMENT = JSON.parse(
  readFileSync(new URL("./fixtures/transcript-2026.9.33/chat-history-stream-segment.json", import.meta.url), "utf-8"),
) as { sessionKey: string; messages: unknown[] };

describe("the failure row carries the run's error (step 4: « l'erreur vient de la ligne »)", () => {
  // upstream src/gateway/chat-display-projection.state-contention.test.ts:5 — the projected
  // `run-failed-before-reply` row keeps its public `content` and its `__openclaw.runId`;
  // its raw diagnostics never cross (`details` dropped unless certified).
  it.each(["state_contention", "unknown", undefined])(
    "state-contention.test.ts:5 — the projected row (%s): its content is the error text, no raw diagnostic",
    (errorKind) => {
      const projected = {
        role: "custom",
        customType: RUN_FAILED_BEFORE_REPLY,
        content: "Public summary",
        ...(errorKind === "state_contention" ? { details: { errorKind, diagnostic: "certified" } } : {}),
        __openclaw: { id: "fail-1", seq: 4, runId: "run-1" },
      };
      const row = toTranscriptRow(projected, undefined, display);
      expect(row).toMatchObject({ entryId: "fail-1", seq: 4, role: "custom", runId: "run-1", errorMessage: "Public summary" });
      expect(JSON.stringify(row)).not.toContain("PRIVATE_");
    },
  );

  it("upstream session-run-error.ts:57 — the public summary as the gateway writes it", () => {
    const row = toTranscriptRow(
      {
        role: "custom",
        customType: RUN_FAILED_BEFORE_REPLY,
        content: "This turn ended before a reply: provider unavailable",
        __openclaw: { id: "fail-2", seq: 9, runId: "run-2" },
      },
      undefined,
      display,
    );
    expect(row?.errorMessage).toBe("This turn ended before a reply: provider unavailable");
  });

  it("any other custom row states no error; shadow/off reads carry none", () => {
    const other = { role: "custom", customType: "openclaw.runtime-context", content: "x", __openclaw: { id: "c", seq: 1, runId: "r" } };
    expect(toTranscriptRow(other, undefined, display)?.errorMessage).toBeUndefined();
    const failure = { role: "custom", customType: RUN_FAILED_BEFORE_REPLY, content: "boom", __openclaw: { id: "f", seq: 2, runId: "r" } };
    expect(toTranscriptRow(failure)).not.toHaveProperty("errorMessage");
  });
});

describe("the media a run keeps is the row's (step 4: no live file)", () => {
  // upstream src/gateway/chat-display-projection.visibility.test.ts:134 — "drops generated
  // media completion wakes while retaining final media": the wake (an inter-session user
  // row) is not shown, the final assistant reply keeps its image. In Atrium the image is a
  // file block OF THAT ROW — what the copier copies — and no private path ever appears.
  it("visibility.test.ts:134 — the final reply's image is a file block of its row", () => {
    const reply = {
      role: "assistant",
      content: [
        { type: "text", text: "Created." },
        { type: "image", source: { type: "url", url: "/api/chat/media/outgoing/generated.png" } },
      ],
      __openclaw: { id: "reply", seq: 2, runId: "run-img" },
    };
    const row = toTranscriptRow(reply, undefined, display);
    expect(row?.blocks?.map((b) => b.type)).toEqual(["text", "file"]);
    expect(JSON.stringify(row)).not.toContain("/root/.openclaw/media");
  });
});

describe("identity, never a guess (ui/src/pages/chat/chat-thread.test.ts)", () => {
  // :1450 "does not guess that incomplete imported source identities are duplicate prompts".
  // Atrium projects no imported row at all (another identity namespace,
  // transcript-rows.ts `toTranscriptRow`): neither is merged with the other, nor guessed.
  it(":1450 — imported rows sharing a provider id are not merged (Atrium does not project them)", () => {
    const imported = (ts: number) => ({
      role: "user",
      content: [{ type: "text", text: "Incomplete imports can share provider IDs." }],
      timestamp: ts,
      __openclaw: { id: "incomplete-provider-user", externalId: "incomplete-provider-user", importedFrom: "claude-cli" },
    });
    expect(toTranscriptRow(imported(1), undefined, display)).toBeNull();
    expect(toTranscriptRow(imported(2), undefined, display)).toBeNull();
  });

  // :1473 "collapses a replay of the same canonical user prompt": the same `__openclaw.id`
  // is ONE row — Atrium's key (chat, session key, entry id).
  it(":1473 — a replay of the same canonical id is the same row identity", () => {
    const metadata = { id: "canonical-replayed-user", idempotencyKey: "replayed-user-run:user", seq: 1 };
    const a = toTranscriptRow({ role: "user", content: [{ type: "text", text: "This prompt was delivered twice." }], timestamp: 1, __openclaw: metadata }, undefined, display);
    const b = toTranscriptRow({ role: "user", content: [{ type: "text", text: "This prompt was delivered twice." }], timestamp: 2, __openclaw: { ...metadata } }, undefined, display);
    expect(a?.entryId).toBe("canonical-replayed-user");
    expect(b?.entryId).toBe(a?.entryId);
    expect(b?.seq).toBe(a?.seq);
  });
});

describe("a stream segment split out of its row keeps a display identity of its own", () => {
  // upstream src/gateway/server-methods/chat-history-delta.test.ts:554 — "preserves keyed
  // commentary and its tool sibling on cursor refresh": the tail page shows the row as
  // [the segment (`openclawStreamFallback: {source: "segment", itemId}`), the rest (tool
  // call)], both under the row's meta; the Control UI keys the segment by its item id
  // (packages/gateway-client/src/session-projection-message-identity.ts:116-131).
  const meta = { runId: "run-commentary", id: "commentary-and-tool", seq: 7, transcriptPosition: { source: "S", rawSeq: 7 } };
  const commentary = { type: "text", text: "First paragraph.\n\n- first file\n- second file" };
  const toolCall = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "workspace.txt" } };
  for (const withTool of [false, true]) {
    it(`chat-history-delta.test.ts:554 (tool=${withTool}) — two messages, two rows; the segment keeps its text`, () => {
      const projected = [
        { role: "assistant", content: [commentary], openclawStreamFallback: { source: "segment", itemId: "commentary-1" }, __openclaw: meta },
        ...(withTool ? [{ role: "assistant", content: [toolCall], stopReason: "toolUse", __openclaw: meta }] : []),
      ];
      const rows = projected.map((m) => toTranscriptRow(m, undefined, display)!);
      expect(rows[0]).toMatchObject({ entryId: streamSegmentEntryId(projected[0], "commentary-and-tool"), streamSegment: true, seq: 7, text: commentary.text });
      expect(rows[0]!.entryId).not.toBe("commentary-and-tool");
      if (withTool) {
        expect(rows[1]).toMatchObject({ entryId: "commentary-and-tool", seq: 7 });
        expect(rows[1]).not.toHaveProperty("streamSegment");
        expect(rows[1]!.blocks?.map((b) => b.type)).toEqual(["tool"]);
      }
      expect(new Set(rows.map((r) => r.entryId)).size).toBe(rows.length);
    });
  }

  it("the bench capture (yield-settle-media): the segment carries the text and its MEDIA: file, the owner its exec call", () => {
    const { messages } = SEGMENT;
    const [segment, owner] = messages.map((m) => toTranscriptRow(m, undefined, { sessionKey: SEGMENT.sessionKey })!);
    expect(segment).toMatchObject({ streamSegment: true, seq: 114 });
    expect(segment!.text).toContain("SETTLE_MEDIA_DONE");
    expect(segment!.blocks?.filter((b) => b.type === "file")).toHaveLength(1);
    expect(owner).toMatchObject({ entryId: "6f3b0282-6ac6-4189-90dd-d8e253b6c268", seq: 114 });
    expect(owner!.blocks?.map((b) => b.type)).toEqual(["tool"]);
    expect(segment!.entryId.length).toBeLessThanOrEqual(128);
  });

  it("off/shadow keep the row's own identity (their invariance)", () => {
    const m = { role: "assistant", content: [commentary], openclawStreamFallback: { source: "segment", itemId: "commentary-1" }, __openclaw: meta };
    expect(toTranscriptRow(m)).toMatchObject({ entryId: "commentary-and-tool" });
    expect(toTranscriptRow(m)).not.toHaveProperty("streamSegment");
  });

  it("only a `segment` fallback is split out (another fallback is the row itself)", () => {
    const m = { role: "assistant", content: [commentary], openclawStreamFallback: { replacementText: "x", source: "final" }, __openclaw: meta };
    expect(toTranscriptRow(m, undefined, display)).toMatchObject({ entryId: "commentary-and-tool" });
  });
});

describe("the session row's last run failure (the Control UI's terminal error)", () => {
  // ui/src/pages/chat/chat-history-stream.ts:233-247 at v2026.9.33: a failed / timed-out
  // run's error is `failureMessage ?? sessionInfo.lastRunError`. Shape captured on the
  // bench 2026-10-16 (a run timeout, embedded runtime).
  const reply = {
    sessionKey: SK,
    sessionId: "s",
    messages: [],
    sessionInfo: {
      status: "timeout",
      lastRunId: "e023d978-1c7b-455f-889a-db9b3bfbc0ce",
      lastRunError: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
    },
  };
  it("read in `on`, with its run and status", () => {
    expect(parseHistoryReply(reply, display)?.lastRunFailure).toEqual({
      runId: "e023d978-1c7b-455f-889a-db9b3bfbc0ce",
      status: "timeout",
      error: reply.sessionInfo.lastRunError,
    });
  });
  it("never in off/shadow, never for a run that did not fail", () => {
    expect(parseHistoryReply(reply)).not.toHaveProperty("lastRunFailure");
    expect(parseHistoryReply({ ...reply, sessionInfo: { ...reply.sessionInfo, status: "done" } }, display)).not.toHaveProperty("lastRunFailure");
  });
});

// Codex review 10: `projectAssistantCommentaryFallbacks` (9.33) may project SEVERAL segments
// of one row — same id, seq and transcriptPosition — in the items' order. That order is
// carried (`segmentOrder`), never re-derived from the entry id (which ends in a hash of the
// item id: msg_a's hash sorts AFTER msg_b's).
describe("codex review 10 — the segments of one row keep chat.history's order", () => {
  it("two segments then their owner: segmentOrder 0 and 1, in the listed order", () => {
    const meta = { id: "row-1", seq: 7, runId: "run-s", transcriptPosition: { source: "S", rawSeq: 9 } };
    const seg = (itemId: string, text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      openclawStreamFallback: { source: "segment", itemId, replacementText: text },
      __openclaw: meta,
    });
    const read = parseHistoryReply(
      {
        sessionKey: "agent:main:main",
        messages: [seg("msg_a", "Premier."), seg("msg_b", "Deuxième."), { role: "assistant", content: [{ type: "text", text: "Suite." }], __openclaw: meta }],
      },
      { sessionKey: "agent:main:main" },
    )!;
    expect(read.rows.map((r) => [r.text, r.segmentOrder])).toEqual([
      ["Premier.", 0],
      ["Deuxième.", 1],
      ["Suite.", undefined],
    ]);
    // The precondition the defect needs: the identity order is the reverse.
    expect(read.rows[0]!.entryId > read.rows[1]!.entryId).toBe(true);
  });
});
