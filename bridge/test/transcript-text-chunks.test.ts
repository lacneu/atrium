// A read's TEXT reaches Convex in chunks it can persist, ahead of the read (codex phase 4
// pass 6): Convex refuses an apply carrying more text than one transaction can store
// (convex/transcriptProjection.ts `MAX_APPLY_TEXT_*`, `too_large`), and nothing is ever
// deferred — so the bridge posts `textsOnly` chunks first, then the read with identities
// only, and a failure anywhere leaves the cursor where it was. Deterministic.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ROW_TEXT_MAX_BYTES, toTranscriptRow } from "../src/providers/openclaw/transcript-rows.js";

import {
  chunkTextRows,
  rowTextBytes,
  TEXT_CHUNK_MAX_BYTES,
  TEXT_CHUNK_MAX_ROWS,
  TranscriptShadow,
  type TranscriptApply,
  type TranscriptApplyResult,
} from "../src/providers/openclaw/transcript-shadow.js";

const SK = "agent:alice:atrium:chat:u-1:c1";
const CJK = "漢".repeat(32_000);

const assistant = (id: string, seq: number, runId: string, text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  __openclaw: { id, seq, runId },
});

describe("chunkTextRows — the bounds Convex accepts, with margin", () => {
  it("keeps every chunk under both bounds, in order, and skips rows without text", () => {
    const rows: Array<{ id: number; text?: string }> = [
      ...Array.from({ length: 70 }, (_, i) => ({ id: i, text: CJK })),
      { id: 999 },
      ...Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i, text: "x" })),
    ];
    const chunks = chunkTextRows(rows);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TEXT_CHUNK_MAX_ROWS);
      expect(c.reduce((n, r) => n + rowTextBytes(r), 0)).toBeLessThanOrEqual(TEXT_CHUNK_MAX_BYTES);
    }
    expect(chunks.flat().map((r) => r.id)).toEqual(rows.filter((r) => r.text !== undefined).map((r) => r.id));
    // The bounds are under Convex's (40 rows, 4 MiB).
    expect(TEXT_CHUNK_MAX_ROWS).toBeLessThan(40);
    expect(TEXT_CHUNK_MAX_BYTES).toBeLessThan(4 * 1024 * 1024);
  });

  it("counts UTF-8 bytes, not characters (a CJK char is 3 bytes)", () => {
    expect(rowTextBytes({ text: "漢" })).toBe(3 + 128);
    expect(rowTextBytes({ text: "a", yieldAck: "é" })).toBe(1 + 2 + 128);
  });

  it("a single row heavier than the byte bound is a chunk of its own", () => {
    const chunks = chunkTextRows([{ text: "a" }, { text: CJK }, { text: "b" }], 32, 10);
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });
});

/** A gateway whose replies are scripted, and a Convex that records, can refuse (`too_large`
 *  over a chunk bound of its own) or fail. */
function rig(opts: {
  rows: number;
  convexMaxRows?: number;
  failTextsOnce?: boolean;
  refuseReason?: string;
}) {
  const posted: TranscriptApply[] = [];
  const reads: Array<string | null> = [];
  let failTexts = opts.failTextsOnce === true;
  const messages = Array.from({ length: opts.rows }, (_, i) => assistant(`a${i}`, 2 + i, `r${i % 7}`, CJK));
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: SK,
    readHistory: async (cursor) => {
      reads.push(cursor);
      return {
        sessionKey: SK,
        sessionId: "s1",
        messages: reads.length === 1 ? messages : [],
        deltaCursor: "c:after",
        sessionInfo: { sessionId: "s1", hasActiveRun: false, activeRunIds: [] },
      };
    },
    apply: async (p): Promise<TranscriptApplyResult | void> => {
      if (p.textsOnly === true) {
        if (failTexts) {
          failTexts = false;
          throw new Error("convex down");
        }
        if (opts.refuseReason !== undefined) return { ok: false, reason: opts.refuseReason };
        if (opts.convexMaxRows !== undefined && p.rows.length > opts.convexMaxRows) {
          return { ok: false, reason: "too_large" };
        }
      }
      posted.push(p);
      return { ok: true };
    },
    sleep: async () => {},
    now: () => 1000,
    log: () => {},
  });
  shadow.configure({ mode: "on" });
  return { shadow, posted, reads };
}

const flush = async (s: TranscriptShadow) => {
  for (let i = 0; i < 20; i++) {
    await s.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("the reconciler posts a read's texts ahead of it, under Convex's bounds", () => {
  it("70 rows of 32 000 CJK chars: texts-only chunks first, each under the bounds, then the read with identities only", async () => {
    const r = rig({ rows: 70 });
    await flush(r.shadow);
    const texts = r.posted.filter((p) => p.textsOnly === true);
    const read = r.posted.find((p) => p.textsOnly !== true && p.kind !== "live");
    expect(texts.length).toBeGreaterThan(1);
    for (const c of texts) {
      expect(c.kind).toBe("live");
      expect(c.rows.length).toBeLessThanOrEqual(TEXT_CHUNK_MAX_ROWS);
      expect(c.rows.reduce((n, row) => n + rowTextBytes(row), 0)).toBeLessThanOrEqual(TEXT_CHUNK_MAX_BYTES);
    }
    expect(texts.flatMap((c) => c.rows.map((row) => row.entryId))).toEqual(
      Array.from({ length: 70 }, (_, i) => `a${i}`),
    );
    expect(read).toBeDefined();
    expect(r.posted.indexOf(read!)).toBeGreaterThan(r.posted.indexOf(texts[texts.length - 1]!));
    expect(read!.rows).toHaveLength(70);
    expect(read!.rows.every((row) => row.text === undefined && row.yieldAck === undefined)).toBe(true);
  });

  it("a chunk Convex refuses as too large is split and posted again: every text arrives, then the read", async () => {
    const r = rig({ rows: 40, convexMaxRows: 5 });
    await flush(r.shadow);
    const texts = r.posted.filter((p) => p.textsOnly === true);
    expect(texts.every((c) => c.rows.length <= 5)).toBe(true);
    expect(texts.flatMap((c) => c.rows.map((row) => row.entryId)).sort()).toEqual(
      Array.from({ length: 40 }, (_, i) => `a${i}`).sort(),
    );
    expect(r.posted.some((p) => p.textsOnly !== true && p.kind !== "live")).toBe(true);
    expect(r.shadow.stats.textChunksSplit).toBeGreaterThan(0);
  });

  it("a texts chunk that FAILS posts no read: the cursor stays, and the next read starts from it again", async () => {
    const r = rig({ rows: 3, failTextsOnce: true });
    await flush(r.shadow);
    // The first read's texts failed: no read was posted for it…
    const firstReadPosts = r.posted.filter((p) => p.textsOnly !== true && p.kind !== "live" && p.rows.length === 3);
    expect(r.reads[0]).toBeNull();
    // …and the next read is a tail page again (no cursor learnt from the lost one).
    expect(r.reads[1]).toBeNull();
    expect(firstReadPosts).toHaveLength(0);
  });

  it("any other refusal of the texts stops the read too (nothing posted past it)", async () => {
    const r = rig({ rows: 3, refuseReason: "session_owned_elsewhere" });
    await flush(r.shadow);
    expect(r.posted.filter((p) => p.textsOnly !== true && p.kind !== "live" && p.rows.length === 3)).toHaveLength(0);
  });
});

describe("one UTF-8 budget per row, shared with Convex (codex phase 4 pass 7)", () => {
  it("a 32 769-character answer is sent whole; one over the budget is not sent (never cut)", () => {
    const display = { sessionKey: SK };
    const long = toTranscriptRow(assistant("a1", 2, "r1", "a".repeat(32_769)), undefined, display);
    expect(long?.text?.length).toBe(32_769);
    const over = toTranscriptRow(assistant("a2", 3, "r1", "b".repeat(ROW_TEXT_MAX_BYTES + 1)), undefined, display);
    expect(over?.text).toBeUndefined();
    // Counted in BYTES: 262 145 CJK characters are 786 435 bytes — over.
    const cjk = toTranscriptRow(assistant("a3", 4, "r1", "漢".repeat(262_145)), undefined, display);
    expect(cjk?.text).toBeUndefined();
  });

  it("the bridge's budget IS Convex's (the bubble bound)", () => {
    const src = readFileSync(new URL("../../convex/lib/bubbleProjection.ts", import.meta.url), "utf8");
    const m = /export const MAX_COMPOSED_TEXT_BYTES = (\d+) \* 1024;/.exec(src);
    expect(m).not.toBeNull();
    expect(ROW_TEXT_MAX_BYTES).toBe(Number(m![1]) * 1024);
    // …and a row at the budget fits one chunk.
    expect(rowTextBytes({ text: "a".repeat(ROW_TEXT_MAX_BYTES) })).toBeLessThan(TEXT_CHUNK_MAX_BYTES);
  });

  it("a READ Convex refuses as too large is not kept: the next read starts from the same cursor", async () => {
    const posted: TranscriptApply[] = [];
    const reads: Array<string | null> = [];
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: SK,
      readHistory: async (cursor) => {
        reads.push(cursor);
        return {
          sessionKey: SK,
          sessionId: "s1",
          messages: [],
          deltaCursor: `c:${reads.length}`,
          sessionInfo: { sessionId: "s1", hasActiveRun: false, activeRunIds: [] },
        };
      },
      apply: async (p): Promise<TranscriptApplyResult> => {
        posted.push(p);
        return reads.length === 1 ? { ok: false, reason: "too_large" } : { ok: true };
      },
      sleep: async () => {},
      now: () => 1000,
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    await flush(shadow);
    expect(reads[0]).toBeNull();
    expect(reads[1]).toBeNull();
  });
});

describe("the cut rows ride ahead of the texts (codex phase 4 pass 9)", () => {
  it("a read with a steered user row: the first texts chunk carries that row before any text", async () => {
    const posted: TranscriptApply[] = [];
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: SK,
      readHistory: async () => ({
        sessionKey: SK,
        sessionId: "s1",
        messages: [
          assistant("a1", 2, "R", "avant"),
          {
            role: "user",
            content: [{ type: "text", text: "et ensuite ?" }],
            __openclaw: { id: "u1", seq: 3, runId: "webchat-s:user", steerTargetRunId: "R" },
          },
          assistant("a2", 4, "R", "après"),
        ],
        deltaCursor: "c:1",
        sessionInfo: { sessionId: "s1", hasActiveRun: false, activeRunIds: [] },
      }),
      apply: async (p): Promise<TranscriptApplyResult> => {
        posted.push(p);
        return { ok: true };
      },
      sleep: async () => {},
      now: () => 1000,
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    await flush(shadow);
    const first = posted.find((p) => p.textsOnly === true)!;
    expect(first.rows[0]).toMatchObject({ entryId: "u1", role: "user", steerTargetRunId: "R" });
    expect(first.rows.slice(1).every((r) => r.text !== undefined)).toBe(true);
  });
});
