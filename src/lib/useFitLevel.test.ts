// The measured-collapse decision shared by the chat header and the sidebar's
// new-chat bar. Anchored on widths measured in the browser (fr, 1280×800): the
// new-chat row needs 222 px with its shortcut badge, 173 px without it.

import { describe, expect, test } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import {
  CONTENT_CHANGES,
  createFitController,
  createRestyleHub,
  createTargetWatch,
  decideFitLevel,
  FRESH_FIT,
  naturalWidthOf,
  pickFitLevel,
  type FitInput,
  type FitMemory,
  type RestyleEnv,
} from "./useFitLevel";

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

// THE LOCKED HYSTERESIS (lot 13). Anchored on the scheduled jobs measured in the
// browser at 1400×800: the OpenClaw table needs 1137.4 px read as a table, but
// 1039 px read once the list is stacked — its clone inherited the stacked rule
// that wraps the five actions — and the list had 1085 px.
const TABLE = 1137.4;
const TABLE_READ_STACKED = 1039;

/** A page whose reading depends on the presentation it shows, as the clone's did. */
function modeDependentPage(available: number) {
  const page = { available, shown: 0, content: 0, reads: 0 };
  const read = (): FitInput => {
    page.reads += 1;
    const table = page.shown === 0 ? TABLE : TABLE_READ_STACKED;
    return { available: page.available, required: [table + page.content] };
  };
  return { page, read };
}

/** The hook's schedule, without React. A frame: the observer wakes (`measure`);
 *  a move it decides is rendered, and the render's layout effect measures at once
 *  (`shown`) — a move decided THERE is rendered too, before the browser paints.
 *  `painted` records the level each frame ends on, when it changed: the moves a
 *  user sees; `decided` every move, painted or not. */
function runFit(available: number, hysteresis = 0) {
  const { page, read } = modeDependentPage(available);
  const decided: number[] = [];
  const painted: number[] = [];
  let pending: number | null = null;
  const fit = createFitController((level) => {
    decided.push(level);
    pending = level;
  });
  const render = () => {
    for (let guard = 0; pending !== null; guard += 1) {
      if (guard > 20) throw new Error("a render loop");
      const level: number = pending;
      pending = null;
      page.shown = level;
      fit.shown(level, read, hysteresis);
    }
  };
  let onScreen = 0;
  const paint = () => {
    if (page.shown !== onScreen) {
      onScreen = page.shown;
      painted.push(onScreen);
    }
  };
  const settle = (frames: number) => {
    for (let i = 0; i < frames; i += 1) {
      fit.measure(read, hysteresis);
      render();
      paint();
    }
  };
  fit.shown(0, read, hysteresis); // the mount's own measure, in a layout effect
  render();
  paint();
  return { page, read, decided, painted, settle, fit, hysteresis };
}

describe("decideFitLevel — the locked hysteresis (lot 13)", () => {
  test("the reported loop: without the lock, table and stacked rows call each other", () => {
    // The stateless pick, fed the reading of the presentation on screen.
    let level = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const required = [level === 0 ? TABLE : TABLE_READ_STACKED];
      level = pickFitLevel({ available: 1085, required }, level);
      seen.push(level);
    }
    expect(seen).toEqual([1, 0, 1, 0, 1, 0]);
  });

  test("with it: one move to the stacked rows, then nothing, however often the observer wakes", () => {
    const f = runFit(1085);
    f.settle(50);
    expect(f.painted).toEqual([1]);
    expect(f.page.shown).toBe(1);
    // One unseen probe — the stacked reading allowed the table, the table's own
    // reading refused it before anything was painted — and the lock is verified.
    expect(f.decided).toEqual([1, 0, 1]);
  });

  test("the climb needs the width read when the table was left — not the stacked reading", () => {
    const f = runFit(1085);
    f.settle(5);
    for (const width of [1100, 1137]) {
      f.page.available = width; // wider than the stacked reading (1039), short of the table
      f.settle(5);
      expect(f.painted, `${width}`).toEqual([1]);
    }
    expect(f.decided).toEqual([1, 0, 1]); // the verified lock is not probed again
    f.page.available = TABLE; // the width the table needed when it was left
    f.settle(20);
    expect(f.painted).toEqual([1, 0]);
  });

  test("plus the band, when there is one", () => {
    const f = runFit(1085, 24);
    f.settle(5);
    f.page.available = TABLE + 23;
    f.settle(5);
    expect(f.painted).toEqual([1]);
    f.page.available = TABLE + 24;
    f.settle(20);
    expect(f.painted).toEqual([1, 0]);
  });

  test("swept a pixel at a time, up then down across the threshold: one move each way", () => {
    const f = runFit(1000);
    f.settle(5);
    for (let width = 1000; width <= 1200; width += 1) {
      f.page.available = width;
      f.settle(4);
    }
    for (let width = 1200; width >= 1000; width -= 1) {
      f.page.available = width;
      f.settle(4);
    }
    expect(f.painted).toEqual([1, 0, 1]);
  });

  test("the content shrinks while stacked: the lock is verified again, and the table comes back", () => {
    const f = runFit(1085);
    f.settle(5);
    f.page.content = -100; // a row gone: 100 px less, in either presentation
    f.settle(20);
    // The table now needs 1037.4: it fits in 1085 — back, once, and it stays.
    expect(f.painted).toEqual([1, 0]);
  });

  test("the content grows while stacked: the climb needs the grown width", () => {
    const f = runFit(1085);
    f.settle(5);
    f.page.content = 50;
    f.settle(5);
    f.page.available = TABLE + 49;
    f.settle(5);
    expect(f.painted).toEqual([1]); // a climb was tried there, and refused unseen
    f.page.available = TABLE + 50;
    f.settle(20);
    expect(f.painted).toEqual([1, 0]);
  });

  test("the larger of the lock and the current reading is taken", () => {
    const memory: FitMemory = { levels: 1, locked: [900], seen: [1300], verified: true, climbed: false };
    // Read in this presentation, the level now needs 1300: the old lock is not enough.
    expect(decideFitLevel({ available: 1200, required: [1300] }, 1, 0, memory).level).toBe(1);
  });

  test("a sub-pixel wobble of the reading is not a content change", () => {
    const memory: FitMemory = {
      levels: 1,
      locked: [TABLE],
      seen: [TABLE_READ_STACKED],
      verified: true,
      climbed: false,
    };
    const next = decideFitLevel(
      { available: 1085, required: [TABLE_READ_STACKED + 0.4] },
      1,
      0,
      memory,
    );
    expect(next.level).toBe(1);
    expect(next.memory.locked[0]).toBe(TABLE);
    expect(next.memory.verified).toBe(true);
  });

  test("leaving several levels at once, each keeps the width read in the widest presentation", () => {
    // The composer bar: labels on 368, labels off 321, then moved items 282.
    const next = decideFitLevel({ available: 300, required: [368, 321, 282] }, 0, 0, FRESH_FIT);
    expect(next.level).toBe(2);
    expect(next.memory.locked).toEqual([368, 321]);
    expect(next.memory.seen).toEqual([]);
  });

  test("back on a level: it and the levels below lose their lock, those above keep theirs", () => {
    const memory: FitMemory = { levels: 3, locked: [368, 321], seen: [360, 300], verified: true, climbed: false };
    const next = decideFitLevel({ available: 330, required: [360, 300, 282] }, 2, 0, memory);
    expect(next.level).toBe(1);
    expect(next.memory.locked).toEqual([368]);
    expect(next.memory.seen).toEqual([]); // another presentation: its readings start again
  });

  test("another number of levels: the old indices mean nothing, all is forgotten", () => {
    const memory: FitMemory = { levels: 3, locked: [368, 321], seen: [360, 300], verified: true, climbed: false };
    const next = decideFitLevel({ available: 330, required: [320, 300] }, 2, 0, memory);
    expect(next.level).toBe(0);
    expect(next.memory.locked).toEqual([]);
  });

  test("nothing laid out yet (a 0): the most detailed level, nothing kept", () => {
    const memory: FitMemory = {
      levels: 1,
      locked: [TABLE],
      seen: [TABLE_READ_STACKED],
      verified: true,
      climbed: false,
    };
    expect(decideFitLevel({ available: 1085, required: [0] }, 1, 0, memory)).toEqual({
      level: 0,
      memory: FRESH_FIT,
    });
  });
});

describe("a lock is never trusted above what the content needs (lot 14)", () => {
  // Codex's sequence, on the real controller: 700 px for 800 → compact; the need
  // drops to 600 before the compact render (a smaller text size, applied by a
  // passive effect React runs before that render); a 24 px band.
  function scripted(available: number) {
    const page = { available, need: 800, shown: 0 };
    const read = (): FitInput => ({ available: page.available, required: [page.need] });
    const decided: number[] = [];
    let pending: number | null = null;
    const fit = createFitController((level) => {
      decided.push(level);
      pending = level;
    });
    const render = () => {
      for (let guard = 0; pending !== null; guard += 1) {
        if (guard > 20) throw new Error("a render loop");
        const level: number = pending;
        pending = null;
        page.shown = level;
        fit.shown(level, read, 24);
      }
    };
    return { page, read, decided, fit, render };
  }

  test("the need drops before the compact render: back at once — 600 + 24 fits in 700", () => {
    const s = scripted(700);
    s.fit.shown(0, s.read, 24); // the mount: 800 > 700
    expect(s.decided).toEqual([1]);
    s.page.need = 600; // before the compact render
    s.render();
    expect(s.page.shown).toBe(0);
    expect(s.decided).toEqual([1, 0]); // the compact presentation was never painted
  });

  test("with less room, it waits for 624 — the need plus the band, not the stale 824", () => {
    const s = scripted(610);
    s.fit.shown(0, s.read, 24);
    s.page.need = 600;
    s.render();
    expect(s.page.shown).toBe(1); // 610 < 624: compact, rightly
    s.page.available = 623;
    s.fit.measure(s.read, 24);
    s.render();
    expect(s.page.shown).toBe(1);
    s.page.available = 624;
    s.fit.measure(s.read, 24);
    s.render();
    expect(s.page.shown).toBe(0);
  });

  test("a verified lock is not probed again until the content changes — then once", () => {
    const f = runFit(1085);
    f.settle(30);
    expect(f.decided).toEqual([1, 0, 1]);
    f.page.content = 3; // the content changes, the table still does not fit
    f.settle(30);
    expect(f.decided).toEqual([1, 0, 1, 0, 1]); // one probe for that change, unseen
    expect(f.painted).toEqual([1]);
  });

  test("an unverified lock never refuses a climb the readings allow", () => {
    const memory: FitMemory = { levels: 1, locked: [800], seen: [600], verified: false, climbed: false };
    expect(decideFitLevel({ available: 700, required: [600] }, 1, 24, memory).level).toBe(0);
    expect(decideFitLevel({ available: 700, required: [600] }, 1, 24, { ...memory, verified: true }).level).toBe(1);
  });
});

describe("useFitLevel decides through the controller (lot 13)", () => {
  // The hook needs React and a DOM to run: its wiring is read from the syntax tree.
  const file = "src/lib/useFitLevel.ts";
  const sf = ts.createSourceFile(file, readFileSync(join(process.cwd(), file), "utf-8"), ts.ScriptTarget.Latest, true);
  const hook = (() => {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "useFitLevel") found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found!;
  })();
  const calls = (name: string) => {
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if ((ts.isIdentifier(e) && e.text === name) || (ts.isPropertyAccessExpression(e) && e.name.text === name)) {
          out.push(n);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(hook);
    return out;
  };

  test("no stateless pick inside the hook: every decision goes through the controller", () => {
    expect(calls("pickFitLevel")).toHaveLength(0);
    expect(calls("createFitController")).toHaveLength(1);
    expect(calls("measure").length).toBeGreaterThan(0);
  });

  test("the level on screen is reported to the controller after each render of a new level", () => {
    const shown = calls("useLayoutEffect").filter((c) => /\.shown\(/.test(c.arguments[0].getText()));
    expect(shown).toHaveLength(1);
    const deps = shown[0].arguments[1];
    expect(deps !== undefined && ts.isArrayLiteralExpression(deps)).toBe(true);
    expect((deps as ts.ArrayLiteralExpression).elements.map((e) => e.getText())).toContain("level");
  });
});

describe("createFitController — decisions only on what the screen shows (lot 13)", () => {
  test("between a move and its render, no reading is even taken", () => {
    const { page, read } = modeDependentPage(1085);
    const moves: number[] = [];
    const fit = createFitController((level) => moves.push(level));
    fit.shown(0, read, 0);
    expect(moves).toEqual([1]);
    const before = page.reads;
    fit.measure(read, 0); // the DOM still shows the table: its reading would mislead
    fit.measure(read, 0);
    expect(page.reads).toBe(before);
    page.shown = 1;
    fit.shown(1, read, 0); // rendered: read, in the stacked rows
    expect(page.reads).toBe(before + 1);
    // The stacked reading allows the table and the lock is not verified yet: a
    // climb, to be checked in the table at its own render.
    expect(moves).toEqual([1, 0]);
    fit.measure(read, 0);
    expect(page.reads).toBe(before + 1);
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
  class FakeMutations {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    constructor(public cb: () => void) {}
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
      (cb) => new FakeObserver(cb),
      (cb) => new FakeMutations(cb),
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

// CONTENT THAT CHANGES WITHOUT CHANGING A BOX (lot 14): "Review the proposal"
// appeared in an agent file's row — the list kept its size, nothing re-measured,
// and the action was cut. Every fit now hears its observed elements' content.
describe("createTargetWatch — every fit hears its content (lot 14)", () => {
  class Watcher {
    static made: Watcher[] = [];
    observed: Array<[unknown, MutationObserverInit | undefined]> = [];
    drained = 0;
    constructor(public cb: () => void) {
      Watcher.made.push(this);
    }
    observe(target: unknown, options?: MutationObserverInit) {
      this.observed.push([target, options]);
    }
    disconnect() {}
    takeRecords() {
      this.drained += 1;
      return [];
    }
  }

  test("each observed element is watched for its content, whatever the caller", () => {
    Watcher.made = [];
    let measured = 0;
    const watch = createTargetWatch(
      () => (measured += 1),
      (cb) => new Watcher(cb),
      (cb) => new Watcher(cb),
    );
    const list = {};
    watch.sync([list as Element]);
    const [, content] = Watcher.made;
    expect(content.observed).toEqual([[list, CONTENT_CHANGES]]);
    const before = measured;
    content.cb(); // an action appeared in a row
    expect(measured).toBe(before + 1);
  });

  test("nodes, text, a class or `hidden` — not the level's own data attributes, not inline styles", () => {
    expect(CONTENT_CHANGES).toMatchObject({ childList: true, characterData: true, subtree: true, attributes: true });
    expect(CONTENT_CHANGES.attributeFilter).toEqual(["class", "hidden"]);
  });

  test("the measure's own clone is drained, not heard", () => {
    Watcher.made = [];
    const watch = createTargetWatch(
      () => {},
      (cb) => new Watcher(cb),
      (cb) => new Watcher(cb),
    );
    watch.sync([{} as Element]);
    watch.drain();
    expect(Watcher.made[1].drained).toBe(1);
  });

  test("the hook listens to the page's restyles, for every caller", () => {
    const file = "src/lib/useFitLevel.ts";
    const text = readFileSync(join(process.cwd(), file), "utf-8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let hook: ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "useFitLevel") hook = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(hook!.getText()).toMatch(/RESTYLE\.subscribe\(/);
    // …and no option can turn the content off any more.
    expect(hook!.parameters[3].getText()).not.toMatch(/content/);
  });

  test("the hook drains right after each measure", () => {
    const file = "src/lib/useFitLevel.ts";
    const text = readFileSync(join(process.cwd(), file), "utf-8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let read: ts.Node | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === "readRef") read = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(read, "no readRef").toBeDefined();
    const body = read!.getText();
    expect(body.indexOf("measureRef.current()")).toBeLessThan(body.indexOf(".drain()"));
    expect(body.indexOf(".drain()")).toBeGreaterThan(-1);
  });
});

describe("createRestyleHub — the page restyles what is measured (lot 14)", () => {
  function fakePage() {
    const page = {
      fontSize: "16px",
      root: null as ((attributes: ReadonlyArray<string | null>) => void) | null,
      fonts: null as (() => void) | null,
      stopped: 0,
    };
    const env: RestyleEnv = {
      watchRoot(cb) {
        page.root = cb;
        return () => (page.stopped += 1);
      },
      fontSize: () => page.fontSize,
      watchFonts(cb) {
        page.fonts = cb;
        return () => (page.stopped += 1);
      },
    };
    return { page, env };
  }

  test("a smaller text size re-measures every fit; the keyboard's height in the same style does not", () => {
    const { page, env } = fakePage();
    const hub = createRestyleHub(() => env);
    let heard = 0;
    hub.subscribe(() => (heard += 1));
    hub.subscribe(() => (heard += 1));
    page.root!(["style"]); // --oc-kb moved: same font size
    expect(heard).toBe(0);
    page.fontSize = "14px";
    page.root!(["style"]);
    expect(heard).toBe(2);
  });

  test("a theme or a language on the root, web fonts loaded: again", () => {
    const { page, env } = fakePage();
    const hub = createRestyleHub(() => env);
    let heard = 0;
    hub.subscribe(() => (heard += 1));
    page.root!(["class"]);
    page.root!(["lang"]);
    page.fonts!();
    expect(heard).toBe(3);
  });

  test("the last fit gone, the page is no longer watched", () => {
    const { page, env } = fakePage();
    const hub = createRestyleHub(() => env);
    const off1 = hub.subscribe(() => {});
    const off2 = hub.subscribe(() => {});
    off1();
    expect(page.stopped).toBe(0);
    off2();
    expect(page.stopped).toBe(2);
  });

  test("without a page (tests, server), nothing is watched", () => {
    const hub = createRestyleHub(() => null);
    expect(() => hub.subscribe(() => {})()).not.toThrow();
  });
});

