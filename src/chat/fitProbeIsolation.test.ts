// THE MEASURING ELEMENTS ARE NOT STYLED BY THE MODE THEY MEASURE FOR (lot 13).
//
// Every measured fit reads widths off an element of its own — a DOM clone, a probe,
// a React ghost — and decides a presentation (a "mode": stacked, labels off,
// agenda…) that the page then wears as an attribute. A CSS rule keyed on that
// attribute which also reaches the measuring element makes the reading depend on
// the mode it decides: the scheduled jobs' clone, wrapped like the stacked rows,
// read 98 px narrower once stacked, and the table and the stacked rows called each
// other for ever. useFitLevel's locked hysteresis makes such a loop impossible;
// this guard keeps the readings themselves honest.
//
// The registry below is the EXHAUSTIVE list of the measured fits, their measuring
// element and their modes, each checked against the sources: a new fit, clone or
// mode attribute that is not listed fails here first. Then every CSS rule keyed on
// a mode is checked against the measuring elements it could reach.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

type Mode =
  /** The measuring element carries the attribute itself, set by each variant of
   *  the measure: a rule keyed on it styles the clone as the level it measures. */
  | { attr: string; on: "self" }
  /** The attribute sits on an ANCESTOR of the measuring element: every rule keyed
   *  on it must leave the measuring element out — `exclusion` in the selector, on
   *  the element that is the measuring element's root. `directChild`: the measuring
   *  element is a direct child of the mode's element, so a rule going straight
   *  (`>`) to another child cannot reach it. */
  | {
      attr: string;
      on: "ancestor";
      owner: string;
      exclusion: string;
      directChild: boolean;
      probeClasses: string[];
    }
  /** The attribute sits on an element that does not contain the measuring one. */
  | { attr: string; on: "elsewhere"; owner: string }
  /** The mode is React state: no attribute, the ghost is rendered at its widest. */
  | { on: "react" };

type Fit = {
  view: string;
  caller: string;
  owner: string;
  probe: string;
  kind: "clone" | "probe" | "ghost";
  modes: Mode[];
};

const TABLE_MODE: Mode = {
  attr: "data-layout",
  on: "ancestor",
  owner: "oc-tablefit",
  exclusion: "table:not(.oc-dt__measure)",
  directChild: false,
  probeClasses: ["oc-dt__measure"],
};

/** Every measured fit of the app. */
const FITS: Fit[] = [
  {
    view: "composer action bar",
    caller: "src/chat/ConvexChat.tsx:Composer",
    owner: "oc-composer__bar",
    probe: "oc-composer__bar--measure",
    kind: "clone",
    modes: [
      { attr: "data-labels", on: "self" },
      { attr: "data-moved", on: "self" },
    ],
  },
  {
    view: "full-page prompt header",
    caller: "src/chat/ConvexChat.tsx:Composer",
    owner: "oc-composer__exphead",
    probe: "oc-composer__exphead--measure",
    kind: "clone",
    modes: [{ attr: "data-labels", on: "self" }],
  },
  {
    view: "project page action bar",
    caller: "src/chat/ProjectPage.tsx:ProjectPageBody",
    owner: "oc-projpage__actions",
    probe: "oc-projpage__actions--measure",
    kind: "clone",
    modes: [
      { attr: "data-labels", on: "self" },
      { attr: "data-moved", on: "self" },
    ],
  },
  {
    view: "agent files list",
    caller: "src/chat/admin/AgentFilesTab.tsx:AgentFilesTab",
    owner: "oc-afiles__list",
    probe: "oc-afiles__measure",
    kind: "clone",
    modes: [{ attr: "data-layout", on: "self" }],
  },
  {
    view: "admin tables",
    caller: "src/chat/admin/DataTableShell.tsx:DataTableShell",
    owner: "oc-tablefit",
    probe: "oc-dt__measure",
    kind: "clone",
    modes: [TABLE_MODE],
  },
  {
    view: "scheduled jobs list",
    caller: "src/chat/admin/ScheduledTab.tsx:ScheduledTab",
    owner: "oc-tablefit",
    probe: "oc-dt__measure",
    kind: "clone",
    modes: [TABLE_MODE],
  },
  {
    view: "scheduled jobs calendar",
    caller: "src/chat/admin/CalendarView.tsx:CalendarView",
    owner: "oc-cal",
    probe: "oc-cal__chipmeasure",
    kind: "probe",
    modes: [
      {
        attr: "data-mode",
        on: "ancestor",
        owner: "oc-cal",
        exclusion: ":not(.oc-cal__chipmeasure)",
        directChild: true,
        probeClasses: ["oc-cal__event", "oc-cal__chipmeasure"],
      },
    ],
  },
  {
    view: "project page columns",
    caller: "src/chat/ProjectPage.tsx:ColumnView",
    owner: "oc-projpage__cols",
    probe: "oc-projpage__colprobes",
    kind: "probe",
    modes: [{ attr: "data-layout", on: "elsewhere", owner: "oc-projpage__cols" }],
  },
  {
    view: "chat header",
    caller: "src/chat/ConvexChat.tsx:ChatHeader",
    owner: "oc-chathead",
    probe: "oc-chathead-ghost",
    kind: "ghost",
    modes: [{ on: "react" }],
  },
  {
    view: "sidebar new-chat row",
    caller: "src/chat/ChatSidebar.tsx:ChatSidebar",
    owner: "oc-sidebar__top",
    probe: "oc-newchat-ghost",
    kind: "ghost",
    modes: [{ on: "react" }],
  },
];

/** Attributes some components write that are NOT a fit's mode. */
const NOT_A_FIT: { file: string; attr: string; why: string }[] = [
  {
    file: "src/chat/ThemeShowroom.tsx",
    attr: "data-mode",
    why: "the brand logo preview's light/dark background, chosen by the user",
  },
];
const MODE_ATTRS = ["data-layout", "data-labels", "data-moved", "data-mode"];

// ---- sources -------------------------------------------------------------------

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "paraglide" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** The name of the function a node sits in (a component). */
function owner(node: ts.Node): string {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  }
  return "?";
}

const SOURCES = walk(SRC, /\.tsx?$/).map((file) => ({
  where: relative(ROOT, file),
  sf: parse(file),
}));

const callsNamed = (sf: ts.SourceFile, name: string) =>
  find(sf, ts.isCallExpression).filter(
    (c) => ts.isIdentifier(c.expression) && c.expression.text === name,
  );

// ---- CSS -----------------------------------------------------------------------

/** Every style rule's selectors, at-rules (media, layer, container) opened. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let at = 0;
  const stack: boolean[] = []; // true: inside @keyframes
  while (at < text.length) {
    const open = text.indexOf("{", at);
    const close = text.indexOf("}", at);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      stack.pop();
      at = close + 1;
      continue;
    }
    const prelude = text.slice(at, open).trim().replace(/^[;\s]+/, "");
    const inKeyframes = stack.includes(true);
    if (prelude.startsWith("@")) {
      stack.push(/^@(-webkit-)?keyframes/.test(prelude));
    } else {
      stack.push(false);
      if (!inKeyframes) {
        // The declarations' braces never nest here: skip to the rule's end.
        out.push(...splitTop(prelude, ",").map((s) => s.trim()).filter(Boolean));
        const end = text.indexOf("}", open);
        stack.pop();
        at = end + 1;
        continue;
      }
    }
    at = open + 1;
  }
  return out;
}

/** Splits on `sep` outside brackets and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

type Step = { combinator: string; compound: string };

/** A selector as compounds and the combinators before them. */
function steps(selector: string): Step[] {
  const out: Step[] = [];
  let depth = 0;
  let compound = "";
  let pending = "";
  const flush = () => {
    if (compound !== "") {
      out.push({ combinator: out.length === 0 ? "" : pending || " ", compound });
      compound = "";
      pending = "";
    }
  };
  for (const ch of selector.trim()) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (ch === " " || ch === "\n" || ch === "\t")) {
      flush();
      continue;
    }
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) {
      flush();
      pending = ch;
      continue;
    }
    compound += ch;
  }
  flush();
  return out;
}

/** The classes a compound requires (not those inside :not() or :has()). */
function classesOf(compound: string): string[] {
  const bare = compound.replace(/:(not|has|is|where)\((?:[^()]|\([^()]*\))*\)/g, "");
  return [...bare.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
}

const CSS_FILES = walk(SRC, /\.css$/).map((file) => ({
  where: relative(ROOT, file),
  selectors: selectors(readFileSync(file, "utf-8")),
}));

/** Every selector that keys on a mode attribute, with the compound carrying it. */
const KEYED = CSS_FILES.flatMap(({ where, selectors: list }) =>
  list.flatMap((selector) => {
    const chain = steps(selector);
    return chain.flatMap((step, index) => {
      const attr = MODE_ATTRS.find((a) => step.compound.includes(`[${a}`));
      return attr === undefined ? [] : [{ where, selector, chain, index, attr, step }];
    });
  }),
);

// ---- the registry is exhaustive --------------------------------------------------

describe("the registry lists every measured fit (lot 13)", () => {
  test("every caller of useFitLevel / useTableLayout is listed, and nothing else", () => {
    const callers = new Set<string>();
    for (const { where, sf } of SOURCES) {
      if (where.endsWith("useFitLevel.ts") || where.endsWith("useTableLayout.ts")) continue;
      for (const c of [...callsNamed(sf, "useFitLevel"), ...callsNamed(sf, "useTableLayout")]) {
        callers.add(`${where}:${owner(c)}`);
      }
    }
    expect([...callers].sort()).toEqual([...new Set(FITS.map((f) => f.caller))].sort());
  });

  test("every DOM clone's class is a listed measuring element", () => {
    const clones = new Set<string>();
    for (const { sf } of SOURCES) {
      for (const c of callsNamed(sf, "measureCloneWidths")) {
        const cls = c.arguments[2];
        clones.add(cls !== undefined && ts.isStringLiteral(cls) ? cls.text : "<not a literal>");
      }
    }
    clones.delete("<not a literal>");
    expect([...clones].sort()).toEqual(
      [...new Set(FITS.filter((f) => f.kind === "clone").map((f) => f.probe))].sort(),
    );
  });

  test("every mode attribute written in JSX belongs to a listed fit", () => {
    const owners = new Set(FITS.map((f) => f.owner));
    const strays: string[] = [];
    for (const { where, sf } of SOURCES) {
      for (const attr of find(sf, ts.isJsxAttribute)) {
        const name = attr.name.getText();
        if (!MODE_ATTRS.includes(name)) continue;
        if (NOT_A_FIT.some((n) => n.file === where && n.attr === name)) continue;
        const element = attr.parent.parent;
        const className = ts.isJsxOpeningLikeElement(element)
          ? element.attributes.properties.find(
              (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "className",
            )
          : undefined;
        const classes = className?.initializer?.getText().match(/oc-[\w-]+/g) ?? [];
        if (!classes.some((c) => owners.has(c))) strays.push(`${where}: ${name} on ${classes.join(" ")}`);
      }
    }
    expect(strays).toEqual([]);
  });

  test("the composer bar's mode attributes are exactly what fitAttributes writes", () => {
    const sf = SOURCES.find((s) => s.where === "src/chat/composerFit.ts")!.sf;
    const fn = find(sf, ts.isFunctionDeclaration).find((f) => f.name?.text === "fitAttributes")!;
    const literal = find(fn, ts.isObjectLiteralExpression)[0];
    const keys = literal.properties.map((p) => p.name?.getText().replace(/"/g, ""));
    expect(keys.sort()).toEqual(["data-labels", "data-moved"]);
  });
});

// ---- the clones that carry their own mode are configured for every level ------------

describe("a clone carrying its own mode is set to the level it measures (lot 13)", () => {
  const selfFits = FITS.filter((f) => f.modes.some((m) => m.on === "self"));

  test.each(selfFits.map((f) => [f.view, f] as const))("%s", (_view, fit) => {
    const [file] = fit.caller.split(":");
    const sf = SOURCES.find((s) => s.where === file)!.sf;
    const call = callsNamed(sf, "measureCloneWidths").find(
      (c) => ts.isStringLiteral(c.arguments[2]) && (c.arguments[2] as ts.StringLiteral).text === fit.probe,
    );
    expect(call, `no measureCloneWidths for ${fit.probe}`).toBeDefined();
    const text = call!.arguments[1].getText();
    for (const mode of fit.modes) {
      if (mode.on !== "self") continue;
      // Each variant sets the attribute — directly, or through fitAttributes.
      const direct = new RegExp(`setAttribute\\(\\s*"${mode.attr}"`).test(text);
      const viaFitAttributes = /fitAttributes\(/.test(text) && /setAttribute\(name, value\)/.test(text);
      expect(direct || viaFitAttributes, `${fit.probe}: ${mode.attr} not set on the clone`).toBe(true);
    }
  });

  test("no rule goes from a clone's own mode to a sibling (+, ~): the clone is one", () => {
    // The clone is appended next to the element it copies: a sibling combinator
    // straight after the mode would style it as the LIVE element's level.
    const sibling = KEYED.filter(({ chain, index }) => {
      const next = chain[index + 1];
      return next !== undefined && (next.combinator === "+" || next.combinator === "~");
    }).filter(({ step }) =>
      FITS.some((f) => f.modes.some((m) => m.on === "self") && classesOf(step.compound).includes(f.owner)),
    );
    expect(sibling.map((k) => `${k.where}: ${k.selector}`)).toEqual([]);
  });
});

// ---- the rules keyed on an ancestor's mode leave the measuring element out --------

describe("every rule keyed on a mode leaves the measuring element out (lot 13)", () => {
  test("each selector keyed on a mode names a listed owner — no unknown mode", () => {
    const known = new Set(FITS.map((f) => f.owner));
    const notFits = new Set(["oc-chart-mine__logo-preview"]);
    const unknown = KEYED.filter(({ step }) => {
      const classes = classesOf(step.compound);
      return !classes.some((c) => known.has(c) || notFits.has(c));
    });
    expect(unknown.map((k) => `${k.where}: ${k.selector}`)).toEqual([]);
  });

  const ancestorModes = FITS.flatMap((f) =>
    f.modes.filter((m): m is Extract<Mode, { on: "ancestor" }> => m.on === "ancestor").map((m) => ({ fit: f, mode: m })),
  );
  const seenOwners = new Set<string>();
  const uniqueAncestorModes = ancestorModes.filter(({ mode }) => {
    if (seenOwners.has(mode.owner)) return false;
    seenOwners.add(mode.owner);
    return true;
  });

  test.each(uniqueAncestorModes.map((a) => [`${a.mode.owner}[${a.mode.attr}]`, a] as const))(
    "%s",
    (_name, { mode }) => {
      const offenders: string[] = [];
      let keyed = 0;
      for (const k of KEYED) {
        if (k.attr !== mode.attr || !classesOf(k.step.compound).includes(mode.owner)) continue;
        keyed += 1;
        const after = k.chain.slice(k.index + 1);
        // Styling the mode's own element: whatever it sets is inherited by the
        // measuring element inside it.
        if (after.length === 0) {
          offenders.push(`${k.where}: ${k.selector} (styles the element the clone sits in)`);
          continue;
        }
        const excluded = after.some((s) => s.compound.includes(mode.exclusion));
        // Straight to another child: the measuring element (a direct child) is not
        // it, nor inside it.
        const escapes =
          mode.directChild &&
          after[0].combinator === ">" &&
          classesOf(after[0].compound).some((c) => !mode.probeClasses.includes(c));
        if (!excluded && !escapes) offenders.push(`${k.where}: ${k.selector}`);
      }
      expect(keyed, "no rule keyed on this mode: the check would be vacuous").toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    },
  );

  test("the scheduled jobs' stacked actions rule is one of them (the reported loop)", () => {
    const rule = KEYED.find((k) => k.selector.includes("oc-dt__actionsrow .oc-cronactions"));
    expect(rule?.selector).toContain("table:not(.oc-dt__measure)");
  });
});
