// @vitest-environment node
//
// EVERY BOX BOUNDED BY WHAT IS SHOWN KEEPS ITS PRIMARY CONTROLS IN VIEW (lot 28),
// laid out by a REAL browser. The app's own stylesheets, compiled by Vite with the
// app's Tailwind plugin, lay out the DOM the app renders (layoutFloor.fixtures.ts,
// captured from the running app, its text replaced by filler) in a headless Chrome,
// under each text scale and keyboard height, on a phone held both ways. The inset's
// variables are written as lib/virtualKeyboard.ts writes them; the detached composer
// is clamped by the app's own clampGeometry.
//
// What is asserted, per box: its FLOOR — the smallest height shown at which its
// primary controls are whole (the field shows a line in its content box, the send bar
// is whole; a layer's action bar is) — is no more than those controls and the box's
// own chrome (nothing else holds out: no header, no padding, no quote, no
// attachment); above it, at every keyboard of the grid, the controls are whole; under
// it (lot 12's physical limit, a 336 px keyboard over a 360 px phone held sideways: 24
// px shown), the bar's foot stays in view — a layer's where its scroll ends. And what
// gives way first does: the quotes and attachments before the lines of a long text,
// the detached composer's quotes before its head; the transcript keeps its spacing.
//
// A browser is needed: ATRIUM_CHROME, else Playwright's headless shell, else Chrome or
// Chromium where they install. Without one the guard is skipped locally and fails on
// CI (CI=true): it is the only one here that lays out.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { describe, expect, test } from "vitest";
import { clampGeometry } from "./dictationHold";
import { LAYOUT_FIXTURES, type LayoutFixture } from "./layoutFloor.fixtures";

const ROOT = join(__dirname, "..", "..");
const SCALES = { sm: "87.5%", md: "", lg: "112.5%", xl: "125%", "2xl": "137.5%", "3xl": "150%" } as const;
const KEYBOARDS = [0, 160, 200, 220, 260] as const;
// Lot 12's physical limit: a portrait keyboard over a phone held sideways.
const LIMIT_KB = 336;

function findChrome(): string | null {
  const env = process.env.ATRIUM_CHROME;
  if (env && existsSync(env)) return env;
  for (const base of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(base, dir))) {
        const bin = join(base, dir, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** The app's stylesheets as its build serves them (index.css with Tailwind's
 *  utilities, then the stylesheets these boxes use). Tailwind's plugin alone: the
 *  app's config would run Paraglide too, whose compile rewrites src/paraglide without
 *  the declarations the typecheck reads. */
async function appCss(): Promise<string> {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    plugins: [tailwindcss()],
    resolve: { alias: { "@": join(ROOT, "src") } },
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out: string[] = [];
    for (const file of [
      "/src/index.css",
      "/src/chat/convexChat.css",
      "/src/chat/chatParticipants.css",
    ]) {
      const r = await server.transformRequest(`${file}?direct`);
      if (!r) throw new Error(`no stylesheet for ${file}`);
      out.push(r.code);
    }
    return out.join("\n");
  } finally {
    await server.close();
  }
}

type Seen = { top: number; bottom: number; height: number; seen: number; whole: boolean };
type Cell = {
  fixture: string;
  scale: string;
  kb: number;
  shown: number;
  field: (Seen & { oneLine: boolean }) | null;
  bar: Seen | null;
  /** The stacks that give way before the field's lines (quotes, attachments). */
  stacks: number;
  /** The field's height with nothing pressing on it (no keyboard). */
  fieldNatural: number | null;
  /** The detached composer's head and its quotes, as seen. */
  head: Seen | null;
  quotesSeen: number;
  ok: boolean;
};
type Spacing = { fixture: string; scale: string; above: number; below: number; rem: number };
type FloorRow = { fixture: string; scale: string; floor: number | null; bound: number; parts: Record<string, number> };
type ProbeOut = { cells: Cell[]; floors: FloorRow[]; limit: Cell[]; spacing: Spacing[]; errors: string[] };

/** The page Chrome runs: one iframe per fixture, at the fixture's screen size (its
 *  viewport is the screen: 100dvh, the media queries), each text scale, each keyboard. */
function probePage(css: string, fixtures: LayoutFixture[], docks: Record<string, Record<number, { x: number; y: number; w: number; h: number }>>): string {
  const data = JSON.stringify({ css, fixtures, scales: SCALES, kbs: KEYBOARDS, limitKb: LIMIT_KB, docks }).replace(/<\//g, "<\\/");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre><script>
const DATA = ${data};
${PROBE_SCRIPT}
</script></body></html>`;
}

// Runs in Chrome. Kept as a string: it is the browser's code, not the test's.
const PROBE_SCRIPT = String.raw`
const errors = [];
const cells = [], floors = [], limit = [], spacings = [];
function seen(w, el, shownBottom, inset) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // inset: the paddings to leave out (a field's line is in its content box).
  let top = Math.max(r.top + (inset ? inset[0] : 0), 0), bottom = Math.min(r.bottom - (inset ? inset[1] : 0), shownBottom);
  for (let p = el.parentElement; p && p !== w.document.documentElement; p = p.parentElement) {
    const cs = w.getComputedStyle(p);
    if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
      const pr = p.getBoundingClientRect();
      top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom);
    }
    if (cs.position === "fixed") break;
  }
  const s = Math.max(0, bottom - top);
  return { top: r.top, bottom: r.bottom, height: r.height, seen: s, whole: r.height > 0 && s >= r.height - 0.5 };
}
/** A field shows a line when the part of its CONTENT box a person sees holds one: a
 *  field seen by its padding alone shows no line. */
function fieldLine(w, el, shownBottom) {
  const s = seen(w, el, shownBottom);
  if (!s) return null;
  const cs = w.getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const content = seen(w, el, shownBottom, [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)]);
  return { ...s, oneLine: content.seen >= line - 0.5, line };
}
function px(w, value) {
  const d = w.document.createElement("div");
  d.style.cssText = "position:absolute;visibility:hidden;height:" + value;
  w.document.body.appendChild(d);
  const h = d.getBoundingClientRect().height;
  d.remove();
  return h;
}
function setKeyboard(w, fx, kb, scale) {
  const root = w.document.documentElement;
  // As lib/virtualKeyboard.ts writes them for a keyboard over a layout viewport the
  // screen's height: what lies below what is shown is the keyboard.
  root.style.setProperty("--oc-kb", kb + "px");
  root.style.setProperty("--oc-vv-bottom", kb + "px");
  root.style.setProperty("--oc-vv-top", "0px");
  root.style.setProperty("--oc-vv-left", "0px");
  if (fx.box === "dock") {
    const g = DATA.docks[fx.name][kb];
    const dock = w.document.querySelector(".oc-detach");
    if (dock && g) Object.assign(dock.style, { left: g.x + "px", top: g.y + "px", width: g.w + "px", height: g.h + "px" });
  }
  void root.offsetHeight;
}
function primary(w, fx) {
  const d = w.document;
  if (fx.box === "composer") { const f = d.querySelector("form.oc-composer:not(.oc-composer--expanded)"); return { field: f && f.querySelector(".oc-composer__input"), bar: f && f.querySelector(".oc-composer__bar") }; }
  if (fx.box === "expanded") { const f = d.querySelector(".oc-composer--expanded"); return { field: f && f.querySelector(".oc-composer__input"), bar: f && f.querySelector(".oc-composer__bar") }; }
  if (fx.box === "dock") { const f = d.querySelector(".oc-detach"); return { field: f && f.querySelector(".oc-detach__input"), bar: f && f.querySelector(".oc-detach__bar") }; }
  const layer = [...d.querySelectorAll('[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]')].pop();
  return { field: null, bar: layer && layer.querySelector('[data-slot="dialog-footer"], [data-slot="alert-dialog-footer"], [data-slot="sheet-footer"]') };
}
function measure(w, fx, kb, scale) {
  setKeyboard(w, fx, kb, scale);
  const shown = fx.screen[1] - kb;
  const p = primary(w, fx);
  const field = p.field ? fieldLine(w, p.field, shown) : null;
  const bar = seen(w, p.bar, shown);
  // A layer's action bar is whole when every control in it is.
  let barOk = !!bar && bar.whole;
  if (fx.box === "layer" && p.bar) barOk = barOk && [...p.bar.querySelectorAll("button")].every((b) => { const s = seen(w, b, shown); return !s || s.height === 0 || s.whole; });
  const ok = barOk && (p.field ? !!field && field.oneLine : true);
  const box = p.field && p.field.closest("form.oc-composer");
  const stacks = box ? [...box.querySelectorAll(".oc-composer__quotes, .oc-attachrow")].reduce((n, el) => n + el.getBoundingClientRect().height, 0) : 0;
  const dock = fx.box === "dock" ? w.document.querySelector(".oc-detach") : null;
  const head = dock ? seen(w, dock.querySelector(".oc-detach__head"), shown) : null;
  const quotes = dock ? seen(w, dock.querySelector(".oc-detach__quotes"), shown) : null;
  return { fixture: fx.name, scale, kb, shown, field, bar, stacks, head, quotesSeen: quotes ? quotes.seen : 0, ok };
}
/** The transcript's space above its first message and below its last, scrolled to its
 *  end: the spacers that replaced its padding (lot 28) keep 1.5rem and 2rem. */
function spacing(w, fx, scale) {
  const vp = w.document.querySelector(".oc-thread__viewport");
  const first = vp && vp.querySelector(":scope > .oc-msg");
  if (!vp || !first) return null;
  setKeyboard(w, fx, 0, scale);
  // Enough messages to scroll: the space below the last is where the scroll ends.
  const copies = [];
  for (let i = 0; i < 8; i++) { const c = first.cloneNode(true); vp.appendChild(c); copies.push(c); }
  const last = copies[copies.length - 1];
  // The transcript scrolls smoothly: the probe jumps.
  vp.scrollTo({ top: 0, behavior: "instant" });
  const above = first.getBoundingClientRect().top - vp.getBoundingClientRect().top;
  vp.scrollTo({ top: vp.scrollHeight, behavior: "instant" });
  const below = vp.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
  vp.scrollTo({ top: 0, behavior: "instant" });
  copies.forEach((c) => c.remove());
  return { fixture: fx.name, scale, above, below, rem: px(w, "1rem") };
}
/** What the box cannot give up, in its own layout: its controls' minimal sizes and the
 *  chrome between them and its edges — the bound its floor must not exceed. */
function inFlow(w, el) {
  // The flex items of a column, a display: contents region flattened into it.
  const out = [];
  for (const c of el.children) {
    const cs = w.getComputedStyle(c);
    if (cs.display === "contents") out.push(...inFlow(w, c));
    else if (cs.display !== "none" && cs.position !== "absolute" && cs.position !== "fixed") out.push(c);
  }
  return out;
}
function bound(w, fx) {
  const d = w.document, cs = (el) => w.getComputedStyle(el), n = (v) => parseFloat(v) || 0;
  const p = primary(w, fx);
  const parts = { bar: p.bar ? p.bar.getBoundingClientRect().height : 0 };
  if (fx.box === "composer" || fx.box === "expanded" || fx.box === "dock") {
    const field = p.field, box = field.closest(fx.box === "dock" ? ".oc-detach" : "form.oc-composer");
    const b = cs(box);
    parts.field = n(cs(field).minHeight);
    parts.border = n(b.borderTopWidth) + n(b.borderBottomWidth);
    if (fx.box === "composer") {
      parts.padding = n(b.paddingTop) + n(b.paddingBottom);
      parts.margin = n(b.marginBottom);
      parts.gaps = Math.max(0, inFlow(w, box).length - 1) * n(b.rowGap);
      // Held sideways the bar is a rail; upright the top bar stays above the thread.
      const top = d.querySelector(".oc-topbar:not(.oc-topbar--rail)");
      if (top && top.getBoundingClientRect().width > top.getBoundingClientRect().height) parts.topbar = top.getBoundingClientRect().height;
    } else if (fx.box === "expanded") {
      // Its paddings at their largest (0.9rem), the region's gaps and the one above the bar.
      const region = box.querySelector(".oc-composer__body");
      parts.padding = 2 * px(w, "0.9rem");
      parts.gaps = (Math.max(0, inFlow(w, region).length - 1) + 1) * n(b.rowGap);
    }
  } else {
    // A layer's action bar is its controls, wherever its footer puts them: from the
    // top of the first to the bottom of the last (a heading above them is not one).
    const layer = p.bar.closest('[data-slot$="-content"]');
    const rects = [...p.bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect()).filter((r) => r.height > 0);
    parts.bar = rects.length ? Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top)) : parts.bar;
    parts.padding = 2 * px(w, "0.5rem");
    parts.border = n(cs(layer).borderTopWidth) + n(cs(layer).borderBottomWidth);
  }
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0) + 2 };
}
function floorOf(w, fx, scale) {
  // The smallest height shown, by bisection over the keyboard, at which the controls are whole.
  let lo = 0, hi = fx.screen[1];
  if (!measure(w, fx, 0, scale).ok) return null;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (measure(w, fx, fx.screen[1] - mid, scale).ok) hi = mid; else lo = mid; }
  return hi;
}
for (const fx of DATA.fixtures) {
  try {
    const frame = document.createElement("iframe");
    frame.style.cssText = "border:0;position:absolute;left:0;top:0;width:" + fx.screen[0] + "px;height:" + fx.screen[1] + "px";
    document.body.appendChild(frame);
    const d = frame.contentDocument;
    d.open();
    d.write('<!doctype html><html lang="fr" class="' + fx.htmlClass + '" style="' + fx.htmlStyle + '"><head><meta charset="utf-8"><style>' + DATA.css + '</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body>' + fx.html + '</body></html>');
    d.close();
    const w = frame.contentWindow;
    for (const [scale, size] of Object.entries(DATA.scales)) {
      d.documentElement.style.fontSize = size;
      setKeyboard(w, fx, 0, scale);
      const b = bound(w, fx);
      floors.push({ fixture: fx.name, scale, floor: floorOf(w, fx, scale), bound: b.total, parts: b.parts });
      const natural = measure(w, fx, 0, scale).field;
      for (const kb of DATA.kbs) cells.push({ ...measure(w, fx, kb, scale), fieldNatural: natural ? natural.height : null });
      const sp = fx.box === "composer" ? spacing(w, fx, scale) : null;
      if (sp) spacings.push(sp);
      // Under its floor a layer scrolls: its action bar is where its scroll ends.
      setKeyboard(w, fx, DATA.limitKb, scale);
      const layer = fx.box === "layer" ? [...d.querySelectorAll('[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]')].pop() : null;
      if (layer) layer.scrollTo({ top: layer.scrollHeight, behavior: "instant" });
      limit.push(measure(w, fx, DATA.limitKb, scale));
      if (layer) layer.scrollTo({ top: 0, behavior: "instant" });
    }
    frame.remove();
  } catch (e) { errors.push(fx.name + ": " + String(e && e.stack || e)); }
}
document.getElementById("out").textContent = JSON.stringify({ cells, floors, limit, spacing: spacings, errors });
`;

function runChrome(chrome: string, page: string): ProbeOut {
  const dir = mkdtempSync(join(tmpdir(), "atrium-layout-"));
  try {
    const file = join(dir, "probe.html");
    writeFileSync(file, page);
    const shell = /headless[-_]shell/.test(chrome);
    const res = spawnSync(
      chrome,
      [
        ...(shell ? [] : ["--headless=new"]),
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(dir, "profile")}`,
        "--window-size=1200,1000",
        // A phone: a coarse pointer, no hover (the 44 px targets).
        "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
        "--virtual-time-budget=20000",
        "--dump-dom",
        `file://${file}`,
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(res.stdout ?? "");
    if (!m) throw new Error(`Chrome returned no result (status ${res.status}): ${(res.stderr ?? "").slice(0, 400)}`);
    const text = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return JSON.parse(text) as ProbeOut;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The detached composer's geometry for each keyboard, as the app clamps it. */
function dockGeometry(fx: LayoutFixture): Record<number, { x: number; y: number; w: number; h: number }> {
  const out: Record<number, { x: number; y: number; w: number; h: number }> = {};
  // Every keyboard height the probe may try (its floor is found by bisection).
  for (let kb = 0; kb <= fx.screen[1]; kb++) {
    out[kb] = clampGeometry(fx.dock!, { x: 0, y: 0, w: fx.screen[0], h: Math.max(0, fx.screen[1] - kb) });
  }
  return out;
}

// What the guard and the rules it lays out rely on, and the component that renders
// each: the fixtures must still hold it, and the component must still render it — a
// fixture left behind by a change of markup would lay out a DOM the app no longer has.
const RELIED: Array<[string, string]> = [
  ["oc-thread", "chat/ConvexChat.tsx"],
  ["oc-thread__viewport", "chat/ConvexChat.tsx"],
  ["oc-chathead", "chat/ConvexChat.tsx"],
  ["oc-composer", "chat/ConvexChat.tsx"],
  ["oc-composer__body", "chat/ConvexChat.tsx"],
  ["oc-composer__input", "chat/ConvexChat.tsx"],
  ["oc-composer__bar", "chat/ConvexChat.tsx"],
  ["oc-composer__quotes", "chat/ConvexChat.tsx"],
  ["oc-attachrow", "chat/ConvexChat.tsx"],
  ["oc-composer--expanded", "chat/ConvexChat.tsx"],
  ["oc-shell--short", "router.tsx"],
  ["oc-detach", "chat/HeldDictationDock.tsx"],
  ["oc-detach__head", "chat/HeldDictationDock.tsx"],
  ["oc-detach__quotes", "chat/HeldDictationDock.tsx"],
  ["oc-detach__input", "chat/HeldDictationDock.tsx"],
  ["oc-detach__bar", "chat/HeldDictationDock.tsx"],
  ["oc-spanel", "chat/SessionPanel.tsx"],
  ["oc-spanel__actions", "chat/SessionPanel.tsx"],
  ['data-slot="dialog-content"', "components/ui/dialog.tsx"],
  ['data-slot="dialog-footer"', "components/ui/dialog.tsx"],
  ['data-slot="sheet-content"', "components/ui/sheet.tsx"],
  ['data-slot="sheet-footer"', "components/ui/sheet.tsx"],
];

describe("the fixtures are the DOM the components render (lot 28)", () => {
  const html = LAYOUT_FIXTURES.map((f) => f.html).join("\n");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  test.each(RELIED)("%s: in the fixtures, and rendered by %s", (token, file) => {
    const source = readFileSync(join(ROOT, "src", file), "utf-8");
    if (token.startsWith("data-slot=")) {
      expect(html).toContain(token);
      expect(source).toContain(token);
      return;
    }
    // A class among others, never a prefix of a longer one (oc-detach, not oc-detach__bar).
    const inFixture = new RegExp(`class="[^"]*(?<![\\w-])${escape(token)}(?![\\w-])`);
    expect(html, token).toMatch(inFixture);
    expect(source, token).toMatch(new RegExp(`(?<![\\w-])${escape(token)}(?![\\w-])`));
  });
});

const chrome = findChrome();
if (chrome === null && process.env.CI) {
  throw new Error("layoutFloor.test.ts lays out in a real browser: set ATRIUM_CHROME (a Chrome or a chrome-headless-shell)");
}

describe.skipIf(chrome === null)("every bounded box keeps its primary controls in view — laid out by Chrome (lot 28)", () => {
  let out: ProbeOut;
  const fixtures = LAYOUT_FIXTURES;
  const ready = (async () => {
    const css = await appCss();
    const docks: Record<string, Record<number, { x: number; y: number; w: number; h: number }>> = {};
    for (const fx of fixtures) if (fx.box === "dock") docks[fx.name] = dockGeometry(fx);
    out = runChrome(chrome!, probePage(css, fixtures, docks));
  })();

  test("the browser laid out every fixture", async () => {
    await ready;
    expect(out.errors).toEqual([]);
    expect(out.floors.length).toBe(fixtures.length * Object.keys(SCALES).length);
    expect(out.cells.length).toBe(fixtures.length * Object.keys(SCALES).length * KEYBOARDS.length);
    expect(out.limit.length).toBe(out.floors.length);
  }, 180_000);

  test("the quotes and the attachments give way before the lines of a long text", async () => {
    await ready;
    // Three lines typed: while either stack still has height, the field keeps all three.
    const typed = out.cells.filter((c) => c.fixture.includes("typed"));
    expect(typed.length).toBeGreaterThan(0);
    const bad = typed
      // The field gives a hundredth of the shortage while the stacks remain (their
      // shrink factor is a hundred times its own): within a pixel and a half.
      .filter((c) => c.stacks > 0.5 && c.field !== null && c.fieldNatural !== null && c.field.height < c.fieldNatural - 1.5)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: field ${c.field!.height.toFixed(1)} of ${c.fieldNatural!.toFixed(1)} px while the stacks keep ${c.stacks.toFixed(1)} px`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("the detached composer's quotes give way before its head (its close, its grip)", async () => {
    await ready;
    const docks = out.cells.filter((c) => c.fixture.startsWith("dock"));
    expect(docks.length).toBeGreaterThan(0);
    const bad = docks
      .filter((c) => c.quotesSeen > 0.5 && !(c.head && c.head.whole))
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: head ${c.head ? `${c.head.seen.toFixed(1)}/${c.head.height.toFixed(1)}` : "none"} while ${c.quotesSeen.toFixed(1)} px of quotes are seen`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("the transcript keeps 1.5rem above its first message and 2rem below its last", async () => {
    await ready;
    expect(out.spacing.length).toBeGreaterThan(0);
    for (const s of out.spacing) {
      // Within a pixel and a half: a scroll position is rounded to the device pixel.
      expect(Math.abs(s.above - 1.5 * s.rem), `${s.fixture} ${s.scale} above`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(s.below - 2 * s.rem), `${s.fixture} ${s.scale} below`).toBeLessThanOrEqual(1.5);
    }
  }, 180_000);

  test("each box's floor is its primary controls and its own chrome, nothing else", async () => {
    await ready;
    const over = out.floors
      .filter((f) => f.floor === null || f.floor > f.bound)
      .map((f) => `${f.fixture} at ${f.scale}: floor ${f.floor ?? "never met"} > ${f.bound.toFixed(1)} (${JSON.stringify(f.parts)})`);
    expect(over).toEqual([]);
  }, 180_000);

  test("above its floor, at every keyboard, the field shows a line and the bar is whole", async () => {
    await ready;
    const floor = new Map(out.floors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.cells
      .filter((c) => c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && !c.ok)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: ${c.shown} px shown, field ${c.field ? `${c.field.seen.toFixed(1)}/${c.field.height.toFixed(1)}` : "-"}, bar ${c.bar ? `${c.bar.seen.toFixed(1)}/${c.bar.height.toFixed(1)}` : "none"}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("under its floor (24 px shown), the bar's foot stays in view — a layer's where its scroll ends", async () => {
    await ready;
    const bad = out.limit
      .filter((c) => !c.bar || c.bar.seen <= 0 || c.bar.bottom > c.shown + 0.5)
      .map((c) => `${c.fixture} ${c.scale}: bar ${c.bar ? `${c.bar.top.toFixed(1)}-${c.bar.bottom.toFixed(1)}, ${c.bar.seen.toFixed(1)} seen` : "none"} for ${c.shown} px shown`);
    expect(bad).toEqual([]);
  }, 180_000);
});
