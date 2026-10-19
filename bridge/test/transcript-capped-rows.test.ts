// A ROW `chat.history` CAPPED FOR DISPLAY, COMPLETED AS THE CONTROL UI COMPLETES IT (0.101.3,
// prod feedback prod-ms71ea7g…, 2026-10-19: a long answer shown cut at 8 000 characters).
//   - `chat.history` bounds a text to 8 000 characters, appends `\n...(truncated)...` and marks
//     the message `__openclaw: {truncated: true, reason: "display-cap"}`
//     (src/gateway/chat-display-projection.sanitize.ts:576-586; upstream test
//     chat-display-projection.test.ts:518 "records a display-cap marker when history text is
//     truncated");
//   - the full message is asked by `chat.message.get {sessionKey, messageId, maxChars}`
//     (ui/src/pages/chat/chat-pane-sidebar-layout.ts:270-277), on the structured marker only,
//     for an assistant message that is not a message-tool mirror (chat-message-recovery.ts:
//     30-41); the upstream handler test chat-message-get-handler.test.ts:200-235 reads the
//     bounded preview from `chat.history` and the whole text from `chat.message.get`.
// Once per row and version; a failure keeps the preview, told as cut, never asked again.

import { beforeEach, describe, expect, it } from "vitest";
import {
  DISPLAY_CAP_SENTINEL,
  capDisplayedRow,
  isDisplayCapped,
  parseHistoryReply,
} from "../src/providers/openclaw/transcript-rows.js";
import {
  TranscriptShadow,
  resetCappedRowMemory,
  type TranscriptApply,
} from "../src/providers/openclaw/transcript-shadow.js";

// What the process remembers about capped rows is process-wide: each test is a fresh process.
beforeEach(() => resetCappedRowMemory());
import capturedFixture from "./fixtures/capped-row-2026.9.33.json" with { type: "json" };

const KEY = "agent:alice:atrium:chat:u-1:c1";
const FULL = Array.from({ length: 1200 }, (_, i) => `Ligne ${i} du texte long.`).join("\n");
const META = { id: "e42", seq: 42, runId: "run-long" };

/** The message as `chat.history` serves it: the first 8 000 characters, the sentinel, the marker. */
const preview = (meta = META) => ({
  role: "assistant",
  content: [{ type: "text", text: `${FULL.slice(0, 8_000)}${DISPLAY_CAP_SENTINEL}` }],
  __openclaw: { ...meta, truncated: true, reason: "display-cap" },
});
/** The message as `chat.message.get` serves it: whole, no marker. */
const full = (meta = META) => ({ role: "assistant", content: [{ type: "text", text: FULL }], __openclaw: { ...meta } });

const page = (messages: unknown[]) => ({
  sessionKey: KEY,
  sessionId: "s-1",
  messages,
  deltaCursor: "c:1",
  sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
});

type Texts = Array<{ entryId: string; text?: string; blocks?: Array<{ type: string; text?: string; capped?: boolean }> }>;

function rig(opts: {
  history: unknown[] | (() => unknown);
  message?: (id: string) => Promise<unknown>;
  mode?: "on" | "shadow";
  cursor?: { sessionId: string; deltaCursor: string };
}) {
  const applies: TranscriptApply[] = [];
  const asked: string[] = [];
  const reads: Array<string | null> = [];
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    readHistory: async (cursor) => {
      reads.push(cursor);
      return typeof opts.history === "function" ? opts.history() : page(opts.history);
    },
    ...(opts.message === undefined
      ? {}
      : {
          readMessage: async (id: string) => {
            asked.push(id);
            return opts.message!(id);
          },
        }),
    apply: async (p) => {
      applies.push(p);
      return { ok: true };
    },
    sleep: async () => {},
    log: () => {},
  });
  shadow.configure({ mode: opts.mode ?? "on", ...(opts.cursor ? { cursor: opts.cursor } : {}) });
  const texts = (): Texts =>
    applies.filter((a) => a.textsOnly === true).flatMap((a) => a.rows as unknown as Texts);
  return { shadow, applies, asked, reads, texts };
}

describe("the display-cap marker (chat-message-recovery.ts:30-41)", () => {
  it("an assistant message marked truncated is capped; a mirror, or sentinel text alone, is not", () => {
    expect(isDisplayCapped(preview())).toBe(true);
    expect(isDisplayCapped({ ...preview(), openclawMessageToolMirror: true })).toBe(false);
    expect(isDisplayCapped({ role: "assistant", content: `x${DISPLAY_CAP_SENTINEL}`, __openclaw: META })).toBe(false);
  });
  it("a read lists the capped rows, their text stripped of the sentinel and their block marked cut", () => {
    const read = parseHistoryReply(page([preview()]), { sessionKey: KEY })!;
    expect(read.capped).toEqual([{ entryId: "e42", seq: 42 }]);
    const row = read.rows[0]!;
    expect(row.text).toBe(FULL.slice(0, 8_000));
    expect(row.blocks).toEqual([{ type: "text", text: FULL.slice(0, 8_000), capped: true }]);
  });
  it("outside `on` nothing changes: no list, rows as always", () => {
    const read = parseHistoryReply(page([preview()]))!;
    expect(read.capped).toBeUndefined();
  });
  it("capDisplayedRow marks the last text block when no block carried the sentinel", () => {
    const r = capDisplayedRow({ entryId: "e", seq: 1, role: "assistant", hidden: false, visible: true, text: "a", blocks: [{ type: "text", text: "a" }] });
    expect(r.blocks).toEqual([{ type: "text", text: "a", capped: true }]);
  });
});

describe("projection `on`: the capped row is completed by chat.message.get", () => {
  it("the full text replaces the preview, posted ahead of the read; asked once per row and version", async () => {
    const r = rig({ history: [preview()], message: async () => ({ ok: true, message: full() }) });
    await r.shadow.idle();
    expect(r.asked).toEqual(["e42"]);
    const posted = r.texts().find((t) => t.entryId === "e42")!;
    expect(posted.text).toBe(FULL);
    expect(posted.blocks).toEqual([{ type: "text", text: FULL }]);
    expect(JSON.stringify(r.texts())).not.toContain("...(truncated)...");
    // A later read of the same row asks nothing again.
    r.shadow.requestRead("again");
    await r.shadow.idle();
    expect(r.asked).toEqual(["e42"]);
    expect(r.texts().filter((t) => t.entryId === "e42").every((t) => t.text === FULL)).toBe(true);
  });

  it("a refusal or a failure keeps the preview, marked cut, and is never asked again", async () => {
    for (const answer of [
      async () => ({ ok: false, unavailableReason: "oversized" }),
      async () => {
        throw new Error("chat.message.get timed out");
      },
    ]) {
      resetCappedRowMemory();
      const r = rig({ history: [preview()], message: answer });
      await r.shadow.idle();
      r.shadow.requestRead("again");
      await r.shadow.idle();
      expect(r.asked).toEqual(["e42"]);
      const posted = r.texts().find((t) => t.entryId === "e42")!;
      expect(posted.text).toBe(FULL.slice(0, 8_000));
      expect(posted.blocks).toEqual([{ type: "text", text: FULL.slice(0, 8_000), capped: true }]);
    }
  });

  it("another row answered (wrong identity) is not taken", async () => {
    const r = rig({ history: [preview()], message: async () => ({ ok: true, message: full({ ...META, id: "other" }) }) });
    await r.shadow.idle();
    expect(r.texts().find((t) => t.entryId === "e42")!.blocks![0]!.capped).toBe(true);
  });

  it("a new version of the row (a new seq) is asked again", async () => {
    let meta = META;
    const r = rig({ history: () => page([preview(meta)]), message: async () => ({ ok: true, message: full(meta) }) });
    await r.shadow.idle();
    meta = { ...META, seq: 43 };
    r.shadow.requestRead("again");
    await r.shadow.idle();
    expect(r.asked).toEqual(["e42", "e42"]);
  });

  it("outside `on`, chat.message.get is never asked", async () => {
    const r = rig({ history: [preview()], message: async () => ({ ok: true, message: full() }), mode: "shadow" });
    await r.shadow.idle();
    expect(r.asked).toEqual([]);
  });
});

describe("a row stored capped before 0.101.3 is repaired on a conversation that resumes by its cursor", () => {
  it("one tail page per process, its capped rows completed and posted; nothing else of the page", async () => {
    const other = { role: "assistant", content: [{ type: "text", text: "court" }], __openclaw: { id: "e41", seq: 41, runId: "run-short" } };
    // The resumed delta brings nothing; the tail page holds the old capped row.
    const r = rig({
      history: () => ({
        sessionKey: KEY,
        sessionId: "s-1",
        messages: [],
        kind: "delta",
        deltaCursor: "c:2",
        sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
      }),
      message: async () => ({ ok: true, message: full() }),
      cursor: { sessionId: "s-1", deltaCursor: "c:1" },
    });
    // The tail read (cursor null) answers the page.
    const readHistory = (r.shadow as unknown as { deps: { readHistory: (c: string | null) => Promise<unknown> } }).deps;
    const delta = readHistory.readHistory;
    readHistory.readHistory = async (cursor) => (cursor === null ? page([other, preview()]) : delta(cursor));
    await r.shadow.idle();
    expect(r.asked).toEqual(["e42"]);
    const posted = r.texts();
    expect(posted.map((t) => t.entryId)).toEqual(["e42"]);
    expect(posted[0]!.text).toBe(FULL);
    // Once per process: a later read does not scan again.
    r.shadow.requestRead("again");
    await r.shadow.idle();
    expect(r.asked).toEqual(["e42"]);
  });
});

// THE CAPTURED REPLIES (bench 2026.9.33 r6, fixtures/capped-row-2026.9.33.json): the tail page
// that holds the capped assistant row, then the `chat.message.get` the bridge asked for it.

describe("captured on the 2026.9.33 bench: a 17 000-character answer", () => {
  const fx = capturedFixture as unknown as { sessionKey: string; chatHistory: { messages: unknown[] }; chatMessageGet: { ok: boolean; message: { content: Array<{ text: string }> } } };
  const fullText = fx.chatMessageGet.message.content[0]!.text;

  it("chat.history serves it capped at 8 000 characters, marked; chat.message.get whole, unmarked", () => {
    const capped = fx.chatHistory.messages.find((m) => isDisplayCapped(m));
    expect(capped).toBeDefined();
    const previewText = (capped as { content: Array<{ text: string }> }).content[0]!.text;
    expect(previewText.endsWith(DISPLAY_CAP_SENTINEL)).toBe(true);
    expect(previewText.length - DISPLAY_CAP_SENTINEL.length).toBe(8_000);
    expect(fullText.length).toBeGreaterThan(8_000);
    expect(fullText.startsWith(previewText.slice(0, -DISPLAY_CAP_SENTINEL.length))).toBe(true);
    expect(isDisplayCapped(fx.chatMessageGet.message)).toBe(false);
  });

  it("the reader posts the whole text in place of the preview", async () => {
    const applies: TranscriptApply[] = [];
    const asked: string[] = [];
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: fx.sessionKey,
      readHistory: async () => fx.chatHistory,
      readMessage: async (id) => {
        asked.push(id);
        return fx.chatMessageGet;
      },
      apply: async (p) => {
        applies.push(p);
        return { ok: true };
      },
      sleep: async () => {},
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    await shadow.idle();
    expect(asked).toHaveLength(1);
    const posted = applies
      .filter((a) => a.textsOnly === true)
      .flatMap((a) => a.rows as unknown as Array<{ role: string; text?: string }>)
      .filter((r) => r.role === "assistant");
    expect(posted.map((r) => r.text?.length)).toEqual([fullText.length]);
    expect(JSON.stringify(posted)).not.toContain("...(truncated)...");
  });
});


// 0.101.3 REVIEW: a reader dies with its session (IDLE_SESSION_TTL_SECONDS). The process
// remembers which rows it completed, so a new reader neither asks again nor lets its tail
// scan post a preview; and Convex never lets a preview replace a whole text (that half is
// src/chat/transcriptCappedRow.test.ts).
describe("across readers of one conversation (the session expired and came back)", () => {
  function reader(message: (id: string) => Promise<unknown>, asked: string[], applies: TranscriptApply[]) {
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: KEY,
      instanceName: "olivier",
      readHistory: async () => page([preview()]),
      readMessage: async (id) => {
        asked.push(id);
        return message(id);
      },
      apply: async (p) => {
        applies.push(p);
        return { ok: true };
      },
      sleep: async () => {},
      log: () => {},
    });
    shadow.configure({ mode: "on", cursor: { sessionId: "s-1", deltaCursor: "c:0" } });
    return shadow;
  }
  const postedTexts = (applies: TranscriptApply[]) =>
    applies.filter((a) => a.textsOnly === true).flatMap((a) => a.rows as unknown as Texts).filter((t) => t.entryId === "e42");

  it("completed once: three returns ask the gateway once in all", async () => {
    const asked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const applies: TranscriptApply[] = [];
      const s = reader(async () => ({ ok: true, message: full() }), asked, applies);
      await s.idle();
      s.close();
    }
    expect(asked).toEqual(["e42"]);
  });

  it("completed, the session gone, then a return whose question would fail: no question, and the tail scan posts no preview", async () => {
    const asked: string[] = [];
    const first: TranscriptApply[] = [];
    const a = reader(async () => ({ ok: true, message: full() }), asked, first);
    await a.idle();
    a.close();
    expect(postedTexts(first).some((t) => t.text === FULL)).toBe(true);
    const later: TranscriptApply[] = [];
    const b = reader(async () => {
      throw new Error("chat.message.get timed out");
    }, asked, later);
    await b.idle();
    expect(asked).toEqual(["e42"]);
    // The read itself carries the preview (Convex keeps the whole text); the scan adds none.
    expect(postedTexts(later).filter((t) => t.blocks?.[0]?.capped === true).length).toBeLessThanOrEqual(1);
  });

  it("the tail scan never posts a preview, even when its question fails", async () => {
    const asked: string[] = [];
    const applies: TranscriptApply[] = [];
    const s = new TranscriptShadow({
      chatId: "c1",
      sessionKey: KEY,
      instanceName: "olivier",
      readHistory: async (cursor) =>
        cursor === null
          ? page([preview()])
          : { sessionKey: KEY, sessionId: "s-1", kind: "delta", messages: [], deltaCursor: "c:2", sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] } },
      readMessage: async (id) => {
        asked.push(id);
        throw new Error("socket closed");
      },
      apply: async (p) => {
        applies.push(p);
        return { ok: true };
      },
      sleep: async () => {},
      log: () => {},
    });
    s.configure({ mode: "on", cursor: { sessionId: "s-1", deltaCursor: "c:1" } });
    await s.idle();
    expect(asked).toEqual(["e42"]);
    expect(postedTexts(applies)).toEqual([]);
  });
});
