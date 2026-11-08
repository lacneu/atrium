// The measured-collapse decision shared by the chat header and the sidebar's
// new-chat bar. Anchored on widths measured in the browser (fr, 1280×800): the
// new-chat row needs 222 px with its shortcut badge, 173 px without it.

import { describe, expect, test } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { createTargetWatch, naturalWidthOf, pickFitLevel, type FitInput } from "./useFitLevel";

const NEW_CHAT_ROW = [222, 173] as const;

describe("pickFitLevel — the most detailed presentation that fits", () => {
  test("stays full while the space covers the most detailed ghost, a tie included", () => {
    expect(pickFitLevel({ available: 242, required: NEW_CHAT_ROW })).toBe(0);
    expect(pickFitLevel({ available: 222, required: NEW_CHAT_ROW })).toBe(0);
  });

  test("steps down exactly where the measured width stops fitting", () => {
    expect(pickFitLevel({ available: 221, required: NEW_CHAT_ROW })).toBe(1);
    expect(pickFitLevel({ available: 173, required: NEW_CHAT_ROW })).toBe(1);
  });

  test("past every ghost, lands one past the last level: the most compact form", () => {
    expect(pickFitLevel({ available: 172, required: NEW_CHAT_ROW })).toBe(2);
    expect(pickFitLevel({ available: 0, required: NEW_CHAT_ROW })).toBe(2);
  });

  test("a ghost not laid out yet (0) gives no verdict: the detailed form stays", () => {
    // Collapsing on a 0 would flash the compact layout on the first frame — also
    // when a caller reserves part of the space and the remainder is negative.
    expect(pickFitLevel({ available: 10, required: [0, 173] })).toBe(0);
    expect(pickFitLevel({ available: -16, required: [0, 173] })).toBe(0);
    expect(pickFitLevel({ available: 10, required: [] })).toBe(0);
  });

  test("decides on the content's width, not on the space: a wider locale steps down sooner", () => {
    // The same 222 px that holds the French row drops the badge of a longer label.
    expect(pickFitLevel({ available: 222, required: [268, 214] })).toBe(1);
  });
});

describe("pickFitLevel — hysteresis (lot 11)", () => {
  const NEED = [700] as const;

  test("without a band, the decision ignores the current level", () => {
    expect(pickFitLevel({ available: 700, required: NEED }, 1)).toBe(0);
    expect(pickFitLevel({ available: 699, required: NEED }, 0)).toBe(1);
  });

  test("climbing back to a more detailed level takes the band on top", () => {
    expect(pickFitLevel({ available: 723, required: NEED }, 1, 24)).toBe(1);
    expect(pickFitLevel({ available: 724, required: NEED }, 1, 24)).toBe(0);
  });

  test("staying at a level, or stepping down, takes no band", () => {
    expect(pickFitLevel({ available: 700, required: NEED }, 0, 24)).toBe(0);
    expect(pickFitLevel({ available: 699, required: NEED }, 0, 24)).toBe(1);
  });

  test("a ghost not laid out yet still gives no verdict", () => {
    expect(pickFitLevel({ available: 10, required: [0] }, 1, 24)).toBe(0);
  });
});

describe("naturalWidthOf — a block whose lines ellipsize their own overflow", () => {
  test("is the widest line's scrollWidth", () => {
    expect(naturalWidthOf([{ scrollWidth: 412 }, { scrollWidth: 805 }])).toBe(805);
  });

  test("an empty block claims nothing", () => {
    expect(naturalWidthOf([])).toBe(0);
  });
});

// LOT 12 — an observed element unmounted and mounted again, the hook's `deps`
// unchanged: in a Hermes chat, a draft detached then recovered gave the composer a
// NEW bar while the observers stayed on the old, detached one — the recovered bar
// kept the level of the window it had left (labels on in 305 px for 368 needed).
// The hook syncs its observers with the elements after every commit; this is that
// sync, with observers that record what they watch.
describe("createTargetWatch — mounted, unmounted, mounted again (lot 12)", () => {
  class FakeObserver {
    static all: FakeObserver[] = [];
    watched = new Set<unknown>();
    live = true;
    constructor(public cb: () => void) {
      FakeObserver.all.push(this);
    }
    observe(target: unknown) {
      this.watched.add(target);
    }
    disconnect() {
      this.live = false;
      this.watched.clear();
    }
  }
  /** The browser telling the observers that `el` changed size. */
  const resize = (el: unknown) => {
    for (const o of FakeObserver.all) if (o.live && o.watched.has(el)) o.cb();
  };
  const watching = () => FakeObserver.all.filter((o) => o.live).flatMap((o) => [...o.watched]);

  /** A composer bar: its width, and the widths its levels need (labels, icons). */
  const NEED = [368, 321];
  function setup() {
    FakeObserver.all = [];
    const width = new Map<object, number>();
    let current: object | null = null; // the bar mounted now (the hook's ref)
    let level = 0;
    const measure = (): FitInput | null =>
      current === null ? null : { available: width.get(current)!, required: NEED };
    const watch = createTargetWatch(
      () => {
        const input = measure();
        if (input !== null) level = pickFitLevel(input, level);
      },
      false,
      (cb) => new FakeObserver(cb),
      (cb) => new FakeObserver(cb),
    );
    /** One React commit: the ref is `el`, the hook syncs after it. */
    const commit = (el: object | null) => {
      current = el;
      watch.sync([el as Element | null]);
    };
    return { width, commit, watch, level: () => level };
  }

  test("a remounted bar is observed and measured at once; the old one is dropped", () => {
    const t = setup();
    const before = {};
    t.width.set(before, 745);
    t.commit(before); // mounted in a wide window: labels on
    expect(t.level()).toBe(0);
    expect(watching()).toEqual([before]);

    t.commit(null); // the draft detached: the bar is gone
    expect(watching()).toEqual([]);

    const after = {};
    t.width.set(after, 305);
    t.commit(after); // recovered in a narrow window: a NEW node, same deps
    expect(watching()).toEqual([after]);
    expect(t.level()).toBe(2); // measured at once: neither labels nor icons fit

    t.width.set(after, 400);
    resize(after); // the new bar is the one heard
    expect(t.level()).toBe(0);

    t.width.set(before, 100);
    resize(before); // the detached node is not
    expect(t.level()).toBe(0);
  });

  test("a node swapped for another in ONE commit — same count, no empty commit between — is re-subscribed", () => {
    const t = setup();
    const first = {};
    t.width.set(first, 745);
    t.commit(first);
    const second = {};
    t.width.set(second, 305);
    t.commit(second); // re-keyed, or moved to another parent, within one commit
    expect(watching()).toEqual([second]);
    expect(t.level()).toBe(2);
  });

  test("the same node, commit after commit: nothing is re-subscribed", () => {
    const t = setup();
    const bar = {};
    t.width.set(bar, 745);
    t.commit(bar);
    const subscribed = FakeObserver.all.length;
    t.commit(bar);
    t.commit(bar);
    expect(FakeObserver.all.length).toBe(subscribed);
  });

  test("dispose drops every observer", () => {
    const t = setup();
    const bar = {};
    t.width.set(bar, 745);
    t.commit(bar);
    t.watch.dispose();
    expect(watching()).toEqual([]);
  });

  // The hook must sync after EVERY commit, not when its deps change: read from the
  // syntax tree (a comment cannot fake it) — an effect with no dependency list
  // that calls `sync`.
  test("useFitLevel syncs its observers after every commit", () => {
    const file = "src/lib/useFitLevel.ts";
    const sf = ts.createSourceFile(
      file,
      readFileSync(join(process.cwd(), file), "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const everyCommit: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "useLayoutEffect" &&
        n.arguments.length === 1
      ) {
        everyCommit.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const syncs = everyCommit.filter((c) => /\.sync\(/.test(c.arguments[0].getText()));
    expect(syncs).toHaveLength(1);
  });
});
