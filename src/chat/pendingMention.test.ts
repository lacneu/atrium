import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import {
  clearPendingMentions,
  peekPendingMentions,
  resolveMentionSpans,
  restorePendingMentions,
  stagePendingMention,
  takeMentionsForSend,
  takePendingMentions,
  nameInComposer,
} from "./pendingMention";

// The staged thing is a TOKEN, not a span: a span captured when somebody is
// picked drifts on the very next keystroke. The spans are located in the final
// text at send time, which is also what makes "I deleted @alice from the box"
// mean "I did not mention alice".

beforeEach(() => {
  clearPendingMentions("c1");
  clearPendingMentions("c2");
});

describe("staging people per conversation", () => {
  test("keeps one entry per person, and per chat", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    stagePendingMention("c2", { userId: "u2", token: "@bob" });
    expect(peekPendingMentions("c1")).toHaveLength(1);
    expect(peekPendingMentions("c2")).toHaveLength(1);
  });

  test("take reads AND clears, so one send consumes them once", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    expect(takePendingMentions("c1")).toHaveLength(1);
    expect(takePendingMentions("c1")).toHaveLength(0);
  });

  test("a failed send can put them back without duplicating", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    const taken = takePendingMentions("c1");
    stagePendingMention("c1", { userId: "u2", token: "@bob" });
    restorePendingMentions("c1", taken);
    expect(peekPendingMentions("c1").map((m) => m.userId).sort()).toEqual(["u1", "u2"]);
    restorePendingMentions("c1", taken);
    expect(peekPendingMentions("c1")).toHaveLength(2);
  });
});

describe("locating the tokens in the text actually sent", () => {
  test("finds the span wherever the person moved it", () => {
    const text = "bonjour, @alice peux-tu voir ?";
    const spans = resolveMentionSpans(text, [{ userId: "u1", token: "@alice" }]);
    expect(spans).toEqual([{ userId: "u1", start: 9, end: 15 }]);
    expect(text.slice(9, 15)).toBe("@alice");
  });

  test("drops a token the person deleted", () => {
    // Deleting "@alice" from the box IS un-mentioning her.
    expect(
      resolveMentionSpans("plus personne", [{ userId: "u1", token: "@alice" }]),
    ).toEqual([]);
  });

  test("returns spans in TEXT order, whatever order they were picked in", () => {
    // The gateway walks the list once, in order; an out-of-order pair makes it
    // refuse the whole send.
    const text = "@bob puis @alice";
    const spans = resolveMentionSpans(text, [
      { userId: "u1", token: "@alice" },
      { userId: "u2", token: "@bob" },
    ]);
    expect(spans.map((s) => s.userId)).toEqual(["u2", "u1"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
  });

  test("two people whose tokens nest do not claim the same characters", () => {
    // "@ali" is inside "@alice". Both matching at 0 would produce overlapping
    // spans, which upstream refuses.
    const text = "@alice et @ali";
    const spans = resolveMentionSpans(text, [
      { userId: "alice", token: "@alice" },
      { userId: "ali", token: "@ali" },
    ]);
    expect(spans).toHaveLength(2);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("@alice");
    expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe("@ali");
  });

  test("counts UTF-16 code units, like the rest of the chain", () => {
    const text = "🙂 @alice";
    expect(resolveMentionSpans(text, [{ userId: "u1", token: "@alice" }])).toEqual([
      { userId: "u1", start: 3, end: 9 },
    ]);
  });
});

describe("takeMentionsForSend — what a send carries, consumed once", () => {
  test("resolves the staged people against the text sent, and clears them", () => {
    stagePendingMention("c1", { userId: "u-bob", token: "@Bob" });
    const { staged, mentions } = takeMentionsForSend("c1", "et @Bob ?");
    expect(mentions).toEqual([{ userId: "u-bob", start: 3, end: 7 }]);
    expect(staged).toEqual([{ userId: "u-bob", token: "@Bob" }]);
    // Consumed: a later message with the same token names nobody.
    expect(peekPendingMentions("c1")).toEqual([]);
    expect(takeMentionsForSend("c1", "@Bob encore").mentions).toEqual([]);
  });

  test("BOTH send paths — a new turn and a queued follow-up — carry the mentions", () => {
    // The runtime is a React hook (no DOM runner here): its wiring is what is
    // pinned — each path consumes through takeMentionsForSend, sends `mentions`,
    // and gives the staged people back on failure.
    const src = readFileSync(join(process.cwd(), "src/chat/useConvexChatRuntime.ts"), "utf-8");
    const onNew = src.slice(src.indexOf("onNew: async"), src.indexOf("const queueSend"));
    const queueSend = src.slice(src.indexOf("const queueSend"));
    for (const body of [onNew, queueSend.slice(0, queueSend.indexOf("\n  );"))]) {
      expect(body).toMatch(/takeMentionsForSend\(\s*chatId,\s*text,?\s*\)/);
      expect(body).toMatch(/\.\.\.\(mentions\.length > 0 \? \{ mentions \} : \{\}\)/);
      expect(body).toMatch(/restorePendingMentions\(chatId, stagedMentions\)/);
    }
  });
});

describe("resolveMentionSpans — only a whole token names somebody", () => {
  test("@Ali picked, then typed on into @Alice: Ali is not named", () => {
    expect(resolveMentionSpans("salut @Alice", [{ userId: "u-ali", token: "@Ali" }])).toEqual([]);
  });
  test("an address ending in the token is not a mention", () => {
    expect(resolveMentionSpans("bob@Ali", [{ userId: "u-ali", token: "@Ali" }])).toEqual([]);
  });
});

describe("nameInComposer — one person, one unique token per message", () => {
  test("a first pick appends the token and stages it", () => {
    expect(nameInComposer("c1", "salut", "u-bob", "@Bob")).toBe("salut @Bob ");
    expect(peekPendingMentions("c1")).toEqual([{ userId: "u-bob", token: "@Bob" }]);
  });
  test("picking someone already named adds nothing", () => {
    nameInComposer("c1", "", "u-bob", "@Bob");
    expect(nameInComposer("c1", "salut @Bob ", "u-bob", "@Bob")).toBeNull();
  });
  test("…unless the writer deleted their token meanwhile", () => {
    nameInComposer("c1", "", "u-bob", "@Bob");
    expect(nameInComposer("c1", "salut ", "u-bob", "@Bob")).toBe("salut @Bob ");
  });
  test("two people with the same name get distinct tokens, each resolved to its own", () => {
    const a = nameInComposer("c1", "", "u-alex1", "@Alex")!;
    const b = nameInComposer("c1", a, "u-alex2", "@Alex")!;
    expect(b).toBe("@Alex @Alex-2 ");
    // The writer deletes the FIRST Alex: the remaining token still names the second.
    const text = "salut @Alex-2";
    expect(resolveMentionSpans(text, peekPendingMentions("c1"))).toEqual([
      { userId: "u-alex2", start: 6, end: 13 },
    ]);
  });
  test("a person renamed meanwhile is re-staged under the new token", () => {
    nameInComposer("c1", "", "u-bob", "@Bob");
    expect(nameInComposer("c1", "salut ", "u-bob", "@Robert")).toBe("salut @Robert ");
    expect(peekPendingMentions("c1")).toEqual([{ userId: "u-bob", token: "@Robert" }]);
    expect(resolveMentionSpans("salut @Robert", peekPendingMentions("c1"))).toEqual([
      { userId: "u-bob", start: 6, end: 13 },
    ]);
  });
  test("the composer goes through it", () => {
    const src = readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8");
    const at = src.indexOf("const mention = (name: string");
    const body = src.slice(at, src.indexOf("setOpen(false);", at));
    expect(body).toMatch(/nameInComposer\(\s*String\(chatId\),\s*composer\.getState\(\)\.text,/);
    expect(body).not.toMatch(/stagePendingMention/);
  });
});
