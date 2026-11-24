// A thought's text is read only while its block is near what the reader sees
// (nearViewport.ts).
//
// THE DEFECT THIS ANSWERS (review after 0.104.2). Thoughts are on view by default and the
// transcript mounts its whole window: 100 replies of 30 thoughts opened 3 000
// `getRowReasoning` subscriptions on opening the conversation, for rows far off screen.
//
// The decision is pure and tested here with a stand-in observer; that the block goes
// through it is read from its source (the block needs React and Convex to render); what a
// real browser does with a long thread is measured outside the suite.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastRead, NEAR_MARGIN, readWhileNear, watchNear, type NearObserverMaker } from "./nearViewport";

type Change = { target: Element; isIntersecting: boolean };

function standIn() {
  const made: Array<{ root: Element | null; rootMargin: string; watched: Set<Element>; live: boolean; fire: (c: Change[]) => void }> = [];
  const make: NearObserverMaker = (onChange, options) => {
    const o = { ...options, watched: new Set<Element>(), live: true, fire: (c: Change[]) => onChange(c) };
    made.push(o);
    return {
      observe: (el) => void o.watched.add(el),
      unobserve: (el) => void o.watched.delete(el),
      disconnect: () => {
        o.live = false;
      },
    };
  };
  return { made, make };
}

const scroller = { name: "scroller" } as unknown as Element;
const blockIn = (root: Element | null) =>
  ({ closest: (sel: string) => (sel === ".oc-thread__viewport" ? root : null) }) as unknown as Element;

describe("the read follows the block's place", () => {
  it("not near: no subscription; near: the row is read", () => {
    const args = { messageId: "m1", entryId: "r2" };
    expect(readWhileNear(false, args)).toBe("skip");
    expect(readWhileNear(true, args)).toBe(args);
  });

  it("a text once read stays shown while its read is released, and is replaced when read again", () => {
    expect(lastRead(undefined, undefined)).toBeUndefined();
    expect(lastRead({ text: "a" }, undefined)).toEqual({ text: "a" });
    expect(lastRead(undefined, { text: "a" })).toEqual({ text: "a" });
    expect(lastRead({ text: "b" }, { text: "a" })).toEqual({ text: "b" });
    // A reasoning that is gone (null) is an answer too, not an absence of one.
    expect(lastRead<{ text: string } | null>(null, { text: "a" })).toBeNull();
  });
});

describe("near is told by the transcript's scroller, a screen around its visible part", () => {
  it("a block is not near until the observer says so, and follows it both ways", () => {
    const { made, make } = standIn();
    const el = blockIn(scroller);
    const told: boolean[] = [];
    const stop = watchNear(el, (n) => told.push(n), make);
    expect(told).toEqual([]);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ root: scroller, rootMargin: NEAR_MARGIN });
    expect(NEAR_MARGIN).toBe("100% 0px");
    made[0]!.fire([{ target: el, isIntersecting: true }]);
    made[0]!.fire([{ target: el, isIntersecting: false }]);
    expect(told).toEqual([true, false]);
    stop();
    made[0]!.fire([{ target: el, isIntersecting: true }]);
    expect(told).toEqual([true, false]);
  });

  it("the blocks of one scroller share one observer, released with the last of them", () => {
    const { made, make } = standIn();
    const root = { name: "other" } as unknown as Element;
    const a = blockIn(root);
    const b = blockIn(root);
    const near = new Map<Element, boolean>();
    const stopA = watchNear(a, (n) => near.set(a, n), make);
    const stopB = watchNear(b, (n) => near.set(b, n), make);
    expect(made).toHaveLength(1);
    expect(made[0]!.watched.size).toBe(2);
    made[0]!.fire([{ target: b, isIntersecting: true }]);
    expect([near.get(a), near.get(b)]).toEqual([undefined, true]);
    stopA();
    expect(made[0]!.live).toBe(true);
    stopB();
    expect(made[0]!.live).toBe(false);
    // A block mounted afterwards gets a fresh one.
    watchNear(blockIn(root), () => {}, make)();
    expect(made).toHaveLength(2);
  });

  it("a block outside any transcript is watched against the page", () => {
    const { made, make } = standIn();
    watchNear(blockIn(null), () => {}, make)();
    expect(made[0]!.root).toBeNull();
  });

  it("without an observer (a server render, an old browser) a block is near at once", () => {
    const told: boolean[] = [];
    // This runtime has none: the default is the platform's.
    expect(typeof IntersectionObserver).toBe("undefined");
    watchNear(blockIn(scroller), (n) => told.push(n));
    expect(told).toEqual([true]);
  });
});

describe("the reasoning block reads through it", () => {
  const src = readFileSync(join(process.cwd(), "src/chat/ReasoningBlocks.tsx"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("its one read of a row's reasoning is skipped while the block is not near", () => {
    const reads = src.match(/useQuery\([^;]*;/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/useQuery\(api\.messages\.getRowReasoning, readWhileNear\(near, \{/);
    expect(src).toMatch(/const near = useNearViewport\(block\)/);
  });

  it("the block watched is the thought's own, and what it shows is the text last read", () => {
    expect(src).toMatch(/<div ref=\{block\} className="oc-msg__meta oc-work oc-thinking"/);
    expect(src).toMatch(/<RowReasoning block=\{block\}/);
    expect(src).toMatch(/lastRead\(read, kept\.current\)/);
  });
});
