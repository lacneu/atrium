// Lot 24: what each refused block action says, and the bookmark toggle's outcome. The
// surfaces that say them — the lists in their dialog, the gutter beside its row — are
// read from their syntax tree in blockPickerWiring.test.ts; the region's announcements
// in src/lib/liveStatus.test.ts.
import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { bookmarkRefusalText, bookmarkToggleOutcome, quoteRefusalText } from "./blockRefusals";
import { QUOTE_MAX_PER_TURN } from "./pendingQuote";

describe("a refused quote says why (lot 24)", () => {
  test("staged, or already staged: nothing to say", () => {
    expect(quoteRefusalText("ok")).toBeNull();
  });

  test("past the count bound, or past the length bound: each its own reason", () => {
    expect(quoteRefusalText("too-many")).toBe(m.quote_reply_max_reached({ count: QUOTE_MAX_PER_TURN }));
    expect(quoteRefusalText("too-many")).toContain(String(QUOTE_MAX_PER_TURN));
    expect(quoteRefusalText("too-long")).toBe(m.quote_reply_budget_reached());
    expect(quoteRefusalText("too-many")).not.toBe(quoteRefusalText("too-long"));
  });
});

describe("a bookmark toggle says how it ended — never a refusal left unseen (lot 24)", () => {
  test("done: placed, or removed — nothing to say", async () => {
    expect(await bookmarkToggleOutcome(false, async () => ({ placed: true }))).toEqual({ done: true, placed: true });
    expect(await bookmarkToggleOutcome(false, async () => ({ placed: false }))).toEqual({ done: true, placed: false });
    expect(bookmarkRefusalText({ done: true, placed: true })).toBeNull();
    expect(bookmarkRefusalText({ done: true, placed: false })).toBeNull();
  });

  test("the server refuses (its bound on a conversation's bookmarks): the rejection becomes a refusal said", async () => {
    const outcome = await bookmarkToggleOutcome(false, async () => {
      throw new Error("Too many bookmarks in this chat");
    });
    expect(outcome).toEqual({ done: false, reason: "server" });
    expect(bookmarkRefusalText(outcome)).toBe(m.bookmark_refused_server());
  });

  test("an admin viewing another person's account: refused without asking the server, which would say nothing", async () => {
    let asked = false;
    const outcome = await bookmarkToggleOutcome(true, async () => {
      asked = true;
      return { placed: false };
    });
    expect(asked).toBe(false);
    expect(outcome).toEqual({ done: false, reason: "impersonating" });
    expect(bookmarkRefusalText(outcome)).toBe(m.bookmark_refused_impersonating());
  });

  test("each refusal its own words", () => {
    const server = bookmarkRefusalText({ done: false, reason: "server" });
    const impersonating = bookmarkRefusalText({ done: false, reason: "impersonating" });
    expect(server).not.toBe(impersonating);
    for (const text of [server, impersonating]) expect(text).toMatch(/\S/);
  });
});
