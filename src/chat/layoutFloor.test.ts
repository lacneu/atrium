// @vitest-environment node
//
// EVERY BOX BOUNDED BY WHAT IS SHOWN KEEPS ITS PRIMARY CONTROLS IN VIEW (lot 28),
// laid out by a REAL browser. Every stylesheet the app loads (lot 29: all of them, in
// the build's order — browserProbe.testkit.ts), compiled by Vite with the app's
// Tailwind plugin, lays out the DOM the app renders (layoutFloor.fixtures.ts,
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
// And what a layer holds fits its width (lot 32) — these layers, and the dialogs,
// popovers and settings page captured for their content (layerContent.fixtures.ts) —,
// with scrollbars that take room as Windows' and Linux's do, in this platform's font and
// in a wider one.
//
// A browser is needed (browserProbe.testkit.ts's findChrome says which). Without one
// the guard is skipped locally and fails on CI (CI=true).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { cn } from "@/lib/utils";
import {
  appCss,
  appStylesheets,
  CLASSIC_SCROLLBARS,
  type ChromeSearch,
  chromeOrFail,
  findChrome,
  OVERRUNS_SCRIPT,
  type Overrun,
  overrunText,
  ROOT,
  runChrome,
  scriptData,
  sourceStylesheets,
  WIDTH_FONTS,
} from "./browserProbe.testkit";
import { clampGeometry } from "./dictationHold";
import { LAYER_CONTENT_FIXTURES, type LayerContentFixture } from "./layerContent.fixtures";
import { LAYOUT_FIXTURES, type LayoutFixture } from "./layoutFloor.fixtures";

const SCALES = { sm: "87.5%", md: "", lg: "112.5%", xl: "125%", "2xl": "137.5%", "3xl": "150%" } as const;
const KEYBOARDS = [0, 160, 200, 220, 260] as const;
// Lot 12's physical limit: a portrait keyboard over a phone held sideways.
const LIMIT_KB = 336;

type Seen = { top: number; bottom: number; height: number; seen: number; whole: boolean };
type Cell = {
  fixture: string;
  scale: string;
  kb: number;
  shown: number;
  field: (Seen & { oneLine: boolean }) | null;
  bar: Seen | null;
  /** What gives way before the field's lines (quotes, attachments, a live preview, an
   *  upload's progress; the detached composer's quotes and preview). */
  stacks: number;
  /** How far the inline card paints above its own top. */
  overCard?: number;
  /** The field's height with nothing pressing on it (no keyboard). */
  fieldNatural: number | null;
  /** The detached composer's head and its quotes, as seen. */
  head: Seen | null;
  quotesSeen: number;
  ok: boolean;
  /** In the thread: the pending request's response controls, and what sits above the
   *  composer (each one's height in the thread). */
  request?: "whole" | "cut" | "absent";
  above?: { banner: number; queue: number; dock: number };
  /** What the queued cards cover, of what they must not. */
  covers?: string[];
  composerShown?: boolean;
  /** In the request's regime: the composer's own controls whole. */
  composerOk?: boolean;
};
type Spacing = { fixture: string; scale: string; above: number; below: number; rem: number };
type FloorRow = { fixture: string; scale: string; floor: number | null; bound: number; parts: Record<string, number> };
type ProbeOut = {
  cells: Cell[];
  floors: FloorRow[];
  limit: Cell[];
  spacing: Spacing[];
  /** The thread with the request's card focused: its cells and the request's floor. */
  focus: Cell[];
  requestFloors: Array<{ fixture: string; scale: string; floor: number | null; focused: boolean }>;
  /** The thread at every height shown, 4 px apart, in each regime. */
  sweep: Array<{ fixture: string; scale: string; shown: number; ok: boolean; request: string; above: number }>;
  sweepFocus: Array<{ fixture: string; scale: string; shown: number; ok: boolean; request: string; composerShown: boolean; composerOk: boolean; dockBottom: number; roomy: boolean }>;
  /** Each layer fixture, and each layer captured for its content, with scrollbars that
   *  take room: what runs past its width. */
  widths: Array<{ fixture: string; scale: string; font: string; kb: number; overruns: Overrun[] }>;
  /** The names that shrink with their row (lot 33): how many of their characters show. */
  names: Array<{ fixture: string; scale: string; font: string; item: string; width: number; length: number; shown: number; fits: boolean }>;
  errors: string[];
};

/** The page Chrome runs: one iframe per fixture, at the fixture's screen size (its
 *  viewport is the screen: 100dvh, the media queries), each text scale, each keyboard. */
function probePage(
  css: string,
  fixtures: LayoutFixture[],
  docks: Record<string, Record<number, { x: number; y: number; w: number; h: number }>>,
  contents: LayerContentFixture[],
): string {
  const data = scriptData({ css, fixtures, contents, scales: SCALES, kbs: KEYBOARDS, limitKb: LIMIT_KB, docks, fonts: WIDTH_FONTS, classicScrollbars: CLASSIC_SCROLLBARS });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre><script>
const DATA = ${data};
${OVERRUNS_SCRIPT}
${PROBE_SCRIPT}
</script></body></html>`;
}

// Runs in Chrome. Kept as a string: it is the browser's code, not the test's.
const PROBE_SCRIPT = String.raw`
const errors = [];
const cells = [], floors = [], limit = [], spacings = [], focus = [], requestFloors = [], sweep = [], sweepFocus = [], widths = [], names = [];
// What shows of every text a layer truncates (lots 33-34): each box that ends its OWN text
// in an ellipsis — a block container that hides its overflow, holding text of its own —,
// measured itself: its characters counted by their own boxes against its box, the
// ellipsis's room kept. Never a box found through another's: a row's column was measured
// by its last truncating descendant, the subtitle, and a name 0 px wide passed for seven
// characters shown (lot 34).
const TRUNCATES = /^(block|inline-block|list-item|flow-root|table-cell|table-caption|-webkit-box)$/;
function truncatedTexts(w, layer) {
  return [...layer.querySelectorAll("*")].filter((e) => {
    if (e.getClientRects().length === 0) return false;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim() !== "")) return false;
    const cs = w.getComputedStyle(e);
    return cs.textOverflow === "ellipsis" && cs.overflowX !== "visible" && TRUNCATES.test(cs.display) && cs.visibility !== "hidden";
  });
}
function nameShown(w, d, box) {
  const cs = w.getComputedStyle(box);
  const right = box.getBoundingClientRect().left + box.clientLeft + box.clientWidth - parseFloat(cs.paddingRight);
  const probe = d.createElement("span");
  probe.textContent = "\u2026";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  box.appendChild(probe);
  const ell = probe.getBoundingClientRect().width;
  probe.remove();
  const fits = box.scrollWidth <= box.clientWidth + 0.5;
  const length = box.textContent.replace(/\s/g, "").length;
  let count = 0;
  const walker = d.createTreeWalker(box, 4);
  const range = d.createRange();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    for (let i = 0; i < t.data.length; i++) {
      range.setStart(t, i);
      range.setEnd(t, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.right <= (fits ? right : right - ell) + 0.5) count++;
    }
  }
  return { item: String(box.className).split(/\s+/).find((k) => k.startsWith("oc-")) || box.tagName.toLowerCase(), width: Math.round(box.clientWidth), length, shown: fits ? length : Math.min(count, length), fits };
}
function seen(w, el, shownBottom, inset, card) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // inset: the paddings to leave out (a field's line is in its content box).
  let top = Math.max(r.top + (inset ? inset[0] : 0), 0), bottom = Math.min(r.bottom - (inset ? inset[1] : 0), shownBottom);
  // card: the box a control belongs to (lot 29): out of it, a field runs over what sits
  // above it — the request's controls, under a composer squeezed past its floor.
  if (card) {
    const cr = card.getBoundingClientRect();
    top = Math.max(top, cr.top); bottom = Math.min(bottom, cr.bottom);
  }
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
function fieldLine(w, el, shownBottom, card) {
  const s = seen(w, el, shownBottom, null, card);
  if (!s) return null;
  const cs = w.getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const content = seen(w, el, shownBottom, [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)], card);
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
  if (fx.box === "composer" || fx.box === "thread") { const f = d.querySelector("form.oc-composer:not(.oc-composer--expanded)"); return { field: f && f.querySelector(".oc-composer__input"), bar: f && f.querySelector(".oc-composer__bar") }; }
  if (fx.box === "expanded") { const f = d.querySelector(".oc-composer--expanded"); return { field: f && f.querySelector(".oc-composer__input"), bar: f && f.querySelector(".oc-composer__bar") }; }
  if (fx.box === "dock") { const f = d.querySelector(".oc-detach"); return { field: f && f.querySelector(".oc-detach__input"), bar: f && f.querySelector(".oc-detach__bar") }; }
  const layer = [...d.querySelectorAll('[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]')].pop();
  return { field: null, bar: layer && layer.querySelector('[data-slot="dialog-footer"], [data-slot="alert-dialog-footer"], [data-slot="sheet-footer"]') };
}
function measure(w, fx, kb, scale) {
  setKeyboard(w, fx, kb, scale);
  const shown = fx.screen[1] - kb;
  const p = primary(w, fx);
  // The inline card's field and bar count within the card.
  const card = fx.box === "composer" || fx.box === "thread" ? w.document.querySelector("form.oc-composer:not(.oc-composer--expanded)") : null;
  const field = p.field ? fieldLine(w, p.field, shown, card) : null;
  const bar = seen(w, p.bar, shown, null, card);
  // A layer's action bar is whole when every control in it is.
  let barOk = !!bar && bar.whole;
  if (fx.box === "layer" && p.bar) barOk = barOk && [...p.bar.querySelectorAll("button")].every((b) => { const s = seen(w, b, shown); return !s || s.height === 0 || s.whole; });
  const ok = barOk && (p.field ? !!field && field.oneLine : true);
  const box = p.field && p.field.closest("form.oc-composer");
  const stacks = box
    ? [...box.querySelectorAll(".oc-composer__quotes, .oc-attachrow, .oc-composer__interim, .oc-upload")].reduce((n, el) => n + el.getBoundingClientRect().height, 0)
    : fx.box === "dock"
      ? [...w.document.querySelectorAll(".oc-detach__quotes, .oc-detach__interim")].reduce((n, el) => n + el.getBoundingClientRect().height, 0)
      : 0;
  const dock = fx.box === "dock" ? w.document.querySelector(".oc-detach") : null;
  const head = dock ? seen(w, dock.querySelector(".oc-detach__head"), shown) : null;
  const quotes = dock ? seen(w, dock.querySelector(".oc-detach__quotes"), shown) : null;
  // What the inline card holds besides its field and bar, painted above its own top:
  // nothing, above its floor (the field's padding is the floor's to cut, lot 28).
  let above = 0;
  if (box && (fx.box === "composer" || fx.box === "thread")) {
    const top = box.getBoundingClientRect().top;
    for (const c of inFlow(w, box.querySelector(".oc-composer__body") || box)) {
      if (c.classList.contains("oc-composer__input")) continue;
      const r = c.getBoundingClientRect();
      if (r.height > 0.5 && r.top < top - 0.5) above = Math.max(above, top - r.top);
    }
  }
  const cell = { fixture: fx.name, scale, kb, shown, field, bar, stacks, head, quotesSeen: quotes ? quotes.seen : 0, ok, overCard: above };
  if (fx.box === "thread") {
    const d = w.document;
    // The request's response controls: whole, cut, or not shown at all (folded, out of
    // the thread) — never cut.
    const buttons = [...d.querySelectorAll(".oc-thread > .oc-areq-dock .oc-areq__actions button")]
      .map((b) => seen(w, b, shown))
      .filter((s) => s.height > 0);
    cell.request = buttons.length === 0 || buttons.every((b) => b.seen <= 0) ? "absent" : buttons.every((b) => b.whole) ? "whole" : "cut";
    const h = (sel) => { const el = d.querySelector(sel); return el ? seen(w, el, shown).seen : 0; };
    cell.above = { banner: h(".oc-thread > .oc-chat-banner"), queue: h(".oc-thread > .oc-queue-dock"), dock: h(".oc-thread > .oc-areq-dock") };
    // The queued cards float over the end of the transcript only: never over the
    // banner, nor over the header.
    const q = d.querySelector(".oc-thread > .oc-queue-dock");
    const shownBox = (sel) => { const el = d.querySelector(sel); if (!el || w.getComputedStyle(el).display === "none") return null; const r = el.getBoundingClientRect(); return r.height > 0 ? r : null; };
    const qr = q ? q.getBoundingClientRect() : null;
    const over = (r) => !!(qr && r && qr.height > 0.5 && qr.top < r.bottom - 0.5 && qr.bottom > r.top + 0.5);
    cell.covers = [over(shownBox(".oc-thread > .oc-chat-banner")) ? "banner" : null, over(shownBox(".oc-thread > .oc-chathead")) ? "header" : null].filter(Boolean);
    const form = d.querySelector("form.oc-composer:not(.oc-composer--expanded)");
    cell.composerShown = !!form && w.getComputedStyle(form).display !== "none";
  }
  return cell;
}
/** With the request's card focused (its first response control), the request's own
 *  regime: its controls are the primary ones. */
function measureFocused(w, fx, kb, scale) {
  const c = measure(w, fx, kb, scale);
  return { ...c, composerOk: c.ok, ok: c.request === "whole" };
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
  if (fx.box === "composer" || fx.box === "thread" || fx.box === "expanded" || fx.box === "dock") {
    const field = p.field, box = field.closest(fx.box === "dock" ? ".oc-detach" : "form.oc-composer");
    const b = cs(box);
    parts.field = n(cs(field).minHeight);
    parts.border = n(b.borderTopWidth) + n(b.borderBottomWidth);
    if (fx.box === "composer" || fx.box === "thread") {
      parts.padding = n(b.paddingTop) + n(b.paddingBottom);
      parts.margin = n(b.marginBottom);
      // One gap, between the field and the bar (lot 29): what else the card holds
      // gives way whole, its gaps with it — counted, they hid a preview's 9 px.
      parts.gaps = n(b.rowGap);
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
      if (fx.box === "thread") {
        // Every height shown, 4 px apart: what lies between the keyboards of the grid.
        for (let shown = fx.screen[1]; shown >= 40; shown -= 4) {
          const c = measure(w, fx, fx.screen[1] - shown, scale);
          sweep.push({ fixture: fx.name, scale, shown, ok: c.ok, request: c.request, above: c.above.banner + c.above.queue + c.above.dock });
        }
        setKeyboard(w, fx, 0, scale);
        const first = d.querySelector(".oc-thread > .oc-areq-dock .oc-areq__actions button");
        // Reachable: the card is shown at rest (a request folded to its bar, in a thread
        // too short for it, is answered from its panel).
        if (first && first.getClientRects().length > 0) {
          first.focus();
          const focused = !!first.closest(".oc-areq-dock__list") && first.closest(".oc-areq-dock__list").matches(":focus-within");
          for (const kb of DATA.kbs) focus.push(measureFocused(w, fx, kb, scale));
          let floor = null;
          if (measureFocused(w, fx, 0, scale).ok) {
            let lo = 0, hi = fx.screen[1];
            while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (measureFocused(w, fx, fx.screen[1] - mid, scale).ok) hi = mid; else lo = mid; }
            floor = hi;
          }
          requestFloors.push({ fixture: fx.name, scale, floor, focused });
          for (let shown = fx.screen[1]; shown >= 40; shown -= 4) {
            const c = measureFocused(w, fx, fx.screen[1] - shown, scale);
            const dock = d.querySelector(".oc-thread > .oc-areq-dock").getBoundingClientRect();
            const thread = d.querySelector(".oc-thread").getBoundingClientRect();
            // What the request cannot give up: its margins and borders.
            const chrome = px(w, "0.9rem") + 4;
            sweepFocus.push({ fixture: fx.name, scale, shown, ok: c.ok, request: c.request, composerShown: c.composerShown, composerOk: c.composerOk, dockBottom: dock.bottom, roomy: Math.min(thread.bottom, shown) - thread.top >= chrome });
          }
          first.blur();
        }
      }
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
// WHAT A LAYER HOLDS FITS ITS WIDTH (lot 32): each layer fixture again — the app's own
// content —, and each layer captured for its content alone (a dialog, a popover in its
// Floating UI wrapper, a settings page's scrolling body), in a document whose scrollbars
// take room as Windows' do, at every scale, font and keyboard.
const CONTENT_OF = {
  layer: '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]',
  popover: '[data-slot="popover-content"]',
  page: ".oc-admin__body",
};
for (const fx of [...DATA.fixtures.filter((f) => f.box === "layer"), ...DATA.contents]) {
  try {
    const frame = document.createElement("iframe");
    frame.style.cssText = "border:0;position:absolute;left:0;top:0;width:" + fx.screen[0] + "px;height:" + fx.screen[1] + "px";
    document.body.appendChild(frame);
    const d = frame.contentDocument;
    d.open();
    d.write('<!doctype html><html lang="fr" class="' + fx.htmlClass + '" style="' + fx.htmlStyle + '"><head><meta charset="utf-8"><style>' + DATA.css + '</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style><style>' + DATA.classicScrollbars + '</style></head><body>' + fx.html + '</body></html>');
    d.close();
    const w = frame.contentWindow;
    const layer = [...d.querySelectorAll(CONTENT_OF[fx.box])].pop();
    for (const [scale, size] of Object.entries(DATA.scales)) {
      d.documentElement.style.fontSize = size;
      for (const [font, stack] of DATA.fonts) {
        if (stack === null) d.documentElement.style.removeProperty("--ui-font-sans");
        else d.documentElement.style.setProperty("--ui-font-sans", stack);
        for (const kb of DATA.kbs) {
          setKeyboard(w, fx, kb, scale);
          widths.push({ fixture: fx.name, scale, font, kb, overruns: overruns(w, layer) });
        }
        for (const box of truncatedTexts(w, layer)) names.push(Object.assign({ fixture: fx.name, scale, font }, nameShown(w, d, box)));
      }
    }
    frame.remove();
  } catch (e) { errors.push(fx.name + " (widths): " + String(e && e.stack || e)); }
}
document.getElementById("out").textContent = JSON.stringify({ cells, floors, limit, spacing: spacings, focus, requestFloors, sweep, sweepFocus, widths, names, errors });
`;

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
  ["oc-scrolldown-anchor", "chat/ConvexChat.tsx"],
  ["oc-chat-banner", "chat/ConvexChat.tsx"],
  ["oc-queue-dock", "chat/QueuedDock.tsx"],
  ["oc-queue-card", "chat/QueuedDock.tsx"],
  ["oc-areq-dock", "chat/AgentRequests.tsx"],
  ["oc-areq-dock__bar", "chat/AgentRequests.tsx"],
  ["oc-areq-dock__list", "chat/AgentRequests.tsx"],
  ["oc-areq__body", "chat/AgentRequests.tsx"],
  ["oc-areq__approval", "chat/AgentRequests.tsx"],
  ["oc-areq__actions", "chat/AgentRequests.tsx"],
  ["oc-composer__interim", "chat/ConvexChat.tsx"],
  ["oc-upload", "chat/ConvexChat.tsx"],
  ["oc-presence", "chat/ConversationPanel.tsx"],
  ["oc-detach__interim", "chat/HeldDictationDock.tsx"],
  ["oc-cronedit", "chat/admin/ScheduledTab.tsx"],
  ["oc-tzcombo__trigger", "chat/admin/TimezoneCombobox.tsx"],
  ["oc-dtp__trigger", "chat/admin/DateTimePicker.tsx"],
  ["oc-dtp__pop", "chat/admin/DateTimePicker.tsx"],
  ["oc-dtp__grid", "chat/admin/DateTimePicker.tsx"],
  ["oc-dtp__time", "chat/admin/DateTimePicker.tsx"],
  ["oc-access__list", "chat/admin/InstancesTab.tsx"],
  ["oc-agentcard__head", "chat/admin/InstancesTab.tsx"],
  ["oc-agentcard__main", "chat/admin/InstancesTab.tsx"],
  ["oc-convpicker", "chat/ConversationPanel.tsx"],
  ["oc-convpicker__role", "chat/ConversationPanel.tsx"],
  ["oc-access__tabs", "chat/admin/GroupsTab.tsx"],
  ["oc-access__search", "chat/admin/GroupsTab.tsx"],
  ["oc-bridge-config-dialog", "chat/admin/BridgeTab.tsx"],
  ["oc-bridge-config__grid", "chat/admin/BridgeTab.tsx"],
  ["oc-convpanel__members", "chat/ConversationPanel.tsx"],
  ["oc-convpanel__member", "chat/ConversationPanel.tsx"],
  ["oc-convpanel__role", "chat/ConversationPanel.tsx"],
  ["oc-convpanel__nametext", "chat/ConversationPanel.tsx"],
  ["oc-convpanel__subtext", "chat/ConversationPanel.tsx"],
  ["oc-convpanel__badge", "chat/ConversationPanel.tsx"],
  ["oc-agenttype__label", "chat/admin/InstancesTab.tsx"],
  ["oc-talk__settings", "chat/TalkControl.tsx"],
  ["oc-talk__setting", "chat/TalkControl.tsx"],
  ["oc-admin__body", "router.tsx"],
  ["oc-injtab__content-locale", "chat/admin/PromptInjectionsTab.tsx"],
  ['data-slot="popover-content"', "components/ui/popover.tsx"],
  ['data-slot="tabs-list"', "components/ui/tabs.tsx"],
  ['data-slot="dialog-content"', "components/ui/dialog.tsx"],
  ['data-slot="dialog-footer"', "components/ui/dialog.tsx"],
  ['data-slot="sheet-content"', "components/ui/sheet.tsx"],
  ['data-slot="sheet-footer"', "components/ui/sheet.tsx"],
];

/** What the call sites of a shared component pass as its `className` (lot 32): nothing
 *  (""), or a string. */
function callerClasses(component: string): Set<string> {
  const out = new Set<string>([""]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) return e === "paraglide" ? [] : walk(f);
      return e.endsWith(".tsx") && !e.endsWith(".test.tsx") ? [f] : [];
    });
  for (const file of walk(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes(`<${component}`)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === component) {
        for (const p of n.attributes.properties) {
          if (!ts.isJsxAttribute(p) || p.name.getText(sf) !== "className" || !p.initializer) continue;
          const v = p.initializer;
          if (ts.isStringLiteral(v)) out.add(v.text);
          else if (ts.isJsxExpression(v) && v.expression && ts.isStringLiteralLike(v.expression)) out.add(v.expression.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("the fixtures are the DOM the components render (lot 28)", () => {
  const html = [...LAYOUT_FIXTURES, ...LAYER_CONTENT_FIXTURES].map((f) => f.html).join("\n");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classes = (s: string) => s.split(/\s+/).filter(Boolean).sort().join(" ");
  const unescape = (t: string) => t.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const classesOf = (slot: string) =>
    [...html.matchAll(new RegExp(`data-slot="${slot}"[^>]*?class="([^"]*)"`, "g"))].map((m) => classes(unescape(m[1])));
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
  // The selects are the shared SelectTrigger as it renders now (lot 32): the fixtures
  // were captured, and a change to the component (its max-w-full) reaches the guard only
  // if they follow it — recaptured, or edited to match. Each one is the component's
  // classes merged, as its cn() merges them, with what one of its call sites passes.
  test("every select trigger of the fixtures has the classes the shared SelectTrigger renders with a call site's, no more, no fewer", () => {
    const source = readFileSync(join(ROOT, "src", "components", "ui", "select.tsx"), "utf-8");
    const trigger = source.slice(source.indexOf("function SelectTrigger("), source.indexOf("function SelectContent("));
    const call = trigger.slice(trigger.indexOf("className={cn("), trigger.indexOf("className,", trigger.indexOf("className={cn(")));
    const own = [...call.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const renders = [...callerClasses("SelectTrigger")].map((caller) => classes(cn(...own, caller)));
    const triggers = classesOf("select-trigger");
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) expect(renders, t).toContain(t);
  });
  // And the dialogs (lot 32): their column is the primitive's (grid-cols-1), which a
  // captured dialog holds only if it follows the component.
  test("every dialog of the fixtures has the classes the shared DialogContent renders with a call site's, no more, no fewer", () => {
    const source = readFileSync(join(ROOT, "src", "components", "ui", "dialog.tsx"), "utf-8");
    const own = /export const dialogContentClassName =\s*"([^"]+)"/.exec(source)?.[1];
    expect(own).toBeDefined();
    const renders = [...callerClasses("DialogContent")].map((caller) => classes(cn("z-50", own!, caller)));
    const dialogs = classesOf("dialog-content");
    expect(dialogs.length).toBeGreaterThan(0);
    for (const t of dialogs) expect(renders, t).toContain(t);
  });
});

// EVERY STYLESHEET THE APP LOADS lays the boxes out (lot 29): the guard compiled three
// of them, and a rule in another (the agent-file editor's height, confTabs.css) went
// unseen. The walk follows the build: the static imports from src/main.tsx, then the
// lazily loaded modules', whose chunks' CSS comes after.
describe("the guards lay out with every stylesheet the app loads (lot 29)", () => {
  test("the walk from src/main.tsx reaches every stylesheet under src/, in the build's order", () => {
    const loaded = appStylesheets();
    expect([...loaded].sort()).toEqual(sourceStylesheets());
    expect(new Set(loaded).size).toBe(loaded.length);
    // The main bundle's sheets come before a lazily loaded tab's.
    expect(loaded.indexOf("/src/chat/convexChat.css")).toBeLessThan(loaded.indexOf("/src/chat/admin/confTabs.css"));
    expect(loaded.indexOf("/src/index.css")).toBeLessThan(loaded.indexOf("/src/chat/convexChat.css"));
  });
});

// THE BROWSER THE GUARDS LAY OUT IN (lot 31): the system's Chrome or Chromium — CI's, at
// a reader's 60 frames a second — before Playwright's headless shell, which draws about
// 120 here; ATRIUM_CHROME before both. findChrome, over files of its own.
describe("the guards' browser: ATRIUM_CHROME, then the system's Chrome or Chromium, then Playwright's shell (lot 31)", () => {
  const MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const SHELL = "/home/r/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/chrome-headless-shell";
  const search = (env: string | undefined, files: string[]): ChromeSearch => ({
    env,
    exists: (p) => files.some((f) => f === p || f.startsWith(`${p}/`)),
    list: (dir) => [...new Set(files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split("/")[0]))],
    home: "/home/r",
  });
  test("the system's browser before the shell, the variable before both, null when there is none", () => {
    expect(findChrome(search(undefined, [MAC, SHELL]))).toBe(MAC);
    expect(findChrome(search(undefined, ["/usr/bin/google-chrome", SHELL]))).toBe("/usr/bin/google-chrome");
    expect(findChrome(search(undefined, ["/usr/bin/chromium", SHELL]))).toBe("/usr/bin/chromium");
    expect(findChrome(search(undefined, [SHELL]))).toBe(SHELL);
    expect(findChrome(search("/opt/chrome", ["/opt/chrome", MAC, SHELL]))).toBe("/opt/chrome");
    expect(findChrome(search("/opt/missing", [SHELL]))).toBe(SHELL);
    expect(findChrome(search(undefined, []))).toBe(null);
  });
});

const chrome = chromeOrFail("layoutFloor.test.ts");

describe.skipIf(chrome === null)("every bounded box keeps its primary controls in view — laid out by Chrome (lot 28)", () => {
  let out: ProbeOut;
  const fixtures = LAYOUT_FIXTURES;
  const ready = (async () => {
    const css = await appCss();
    const docks: Record<string, Record<number, { x: number; y: number; w: number; h: number }>> = {};
    for (const fx of fixtures) if (fx.box === "dock") docks[fx.name] = dockGeometry(fx);
    out = await runChrome<ProbeOut>(chrome!, probePage(css, fixtures, docks, LAYER_CONTENT_FIXTURES));
    // What the browser measured, for the floors a lot reports (opt-in).
    if (process.env.ATRIUM_LAYOUT_DUMP) writeFileSync(process.env.ATRIUM_LAYOUT_DUMP, JSON.stringify(out));
  })();

  test("the browser laid out every fixture", async () => {
    await ready;
    expect(out.errors).toEqual([]);
    expect(out.floors.length).toBe(fixtures.length * Object.keys(SCALES).length);
    expect(out.cells.length).toBe(fixtures.length * Object.keys(SCALES).length * KEYBOARDS.length);
    expect(out.limit.length).toBe(out.floors.length);
  }, 180_000);

  test("the quotes and the attachments give way before the lines of a long text — and, in the detached composer, the quotes and the live preview (lot 29)", async () => {
    await ready;
    // Three lines typed: while a stack still has height, the field keeps all three.
    const typed = out.cells.filter((c) => c.fixture.includes("typed") || c.fixture.startsWith("dock-interim"));
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

  test("what a box holds besides its controls adds nothing to its floor: loaded, it is the plain box's (lot 29)", async () => {
    await ready;
    const floor = new Map(out.floors.map((f) => [`${f.fixture}/${f.scale}`, f.floor]));
    const pairs: Array<[string, string]> = [];
    for (const o of ["landscape", "portrait"]) {
      pairs.push([`composer-live-${o}`, `composer-${o}`], [`dock-interim-${o}`, `dock-${o}`]);
      for (const t of ["banner", "queue", "request", "all"]) pairs.push([`thread-${t}-${o}`, `composer-${o}`]);
    }
    pairs.push(["composer-typed-landscape", "composer-landscape"]);
    const bad: string[] = [];
    for (const [loaded, plain] of pairs) {
      for (const scale of Object.keys(SCALES)) {
        const a = floor.get(`${loaded}/${scale}`);
        const b = floor.get(`${plain}/${scale}`);
        expect(a, `${loaded} ${scale}`).not.toBeUndefined();
        if (a === null || b === null || a! > b! + 1) bad.push(`${loaded} ${scale}: floor ${a} > ${plain}'s ${b}`);
      }
    }
    expect(bad).toEqual([]);
  }, 180_000);

  test("above its floor, what the inline card holds besides its controls paints nothing above its top (lot 29)", async () => {
    await ready;
    const floor = new Map(out.floors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.cells
      .filter((c) => c.overCard !== undefined && c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && c.overCard > 0.5)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: ${c.overCard!.toFixed(1)} px painted above the card`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("above its floor, at every keyboard, the field shows a line and the bar is whole", async () => {
    await ready;
    const floor = new Map(out.floors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.cells
      .filter((c) => c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && !c.ok)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: ${c.shown} px shown, field ${c.field ? `${c.field.seen.toFixed(1)}/${c.field.height.toFixed(1)}` : "-"}, bar ${c.bar ? `${c.bar.seen.toFixed(1)}/${c.bar.height.toFixed(1)}` : "none"}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("a pending request's response controls are whole or not shown, never cut — at every keyboard, in both regimes (lot 29)", async () => {
    await ready;
    const thread = [...out.cells, ...out.focus].filter((c) => c.request !== undefined);
    expect(thread.length).toBeGreaterThan(0);
    expect(thread.some((c) => c.request === "whole")).toBe(true);
    const bad = thread
      .filter((c) => c.request === "cut")
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: the request's controls cut, ${c.shown} px shown`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("between the keyboards too, every 4 px of height: never a request cut, nothing held over the composer's floor (lot 29)", async () => {
    await ready;
    expect(out.sweep.length).toBeGreaterThan(1000);
    const floor = new Map(out.floors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.sweep
      .filter(
        (c) =>
          c.request === "cut" ||
          (!c.ok && c.above > 2.5) ||
          (c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && !c.ok),
      )
      .map((c) => `${c.fixture} ${c.scale} ${c.shown} px shown: composer ${c.ok ? "whole" : "under its floor"}, request ${c.request}, ${c.above.toFixed(1)} px above it`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("between the keyboards too, the request's card focused: above its floor its controls are whole, the composer aside or whole (lot 29)", async () => {
    await ready;
    expect(out.sweepFocus.length).toBeGreaterThan(500);
    // Under its floor (its controls, its bar and the header, as the composer's under
    // its own), the owner of the keyboard is cut: what does not fit at all.
    const floor = new Map(out.requestFloors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.sweepFocus
      .filter((c) => c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && (!c.ok || (c.composerShown && !c.composerOk)))
      .map((c) => `${c.fixture} ${c.scale} ${c.shown} px shown: request ${c.request}, composer ${c.composerShown ? (c.composerOk ? "whole" : "cut") : "aside"}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("answered, the request never runs under the keyboard, however short the thread (lot 29)", async () => {
    await ready;
    // Where the thread has room for its margins and borders at all.
    expect(out.sweepFocus.filter((c) => c.roomy).length).toBeGreaterThan(500);
    const bad = out.sweepFocus
      .filter((c) => c.roomy && c.dockBottom > c.shown + 0.5)
      .map((c) => `${c.fixture} ${c.scale} ${c.shown} px shown: the request reaches ${c.dockBottom.toFixed(1)}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("the queued cards float over the end of the transcript, never over the banner or the header (lot 29)", async () => {
    await ready;
    const queued = out.cells.filter((c) => c.covers !== undefined && (c.above?.queue ?? 0) > 0);
    expect(queued.length).toBeGreaterThan(0);
    const bad = queued
      .filter((c) => c.covers!.length > 0)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: the queued cards cover the ${c.covers!.join(" and the ")}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("nothing above the composer keeps its height while the composer is under its floor (lot 29)", async () => {
    await ready;
    const thread = out.cells.filter((c) => c.above !== undefined);
    expect(thread.length).toBeGreaterThan(0);
    const bad = thread
      // A banner's own border (2 px) is all it keeps, given way.
      .filter((c) => !c.ok && c.above!.banner + c.above!.queue + c.above!.dock > 2.5)
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: composer under its floor (${c.shown} px shown) while banner ${c.above!.banner.toFixed(1)}, queue ${c.above!.queue.toFixed(1)}, request ${c.above!.dock.toFixed(1)} px`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("with its card focused, the request keeps its controls and the composer steps aside (lot 29)", async () => {
    await ready;
    expect(out.requestFloors.length).toBeGreaterThan(0);
    // The focus is real (:focus-within matched): the regime the stylesheet keys on.
    expect(out.requestFloors.filter((f) => !f.focused).map((f) => `${f.fixture} ${f.scale}`)).toEqual([]);
    expect(out.requestFloors.filter((f) => f.floor === null).map((f) => `${f.fixture} ${f.scale}`)).toEqual([]);
    const floor = new Map(out.requestFloors.map((f) => [`${f.fixture}/${f.scale}`, f.floor ?? Infinity]));
    const bad = out.focus
      .filter((c) => c.shown >= floor.get(`${c.fixture}/${c.scale}`)! && (c.request !== "whole" || (c.composerShown && !c.composerOk)))
      .map((c) => `${c.fixture} ${c.scale} keyboard ${c.kb}: request ${c.request}, composer ${c.composerShown ? (c.composerOk ? "whole" : "cut") : "aside"}`);
    expect(bad).toEqual([]);
  }, 180_000);

  test("under its floor (24 px shown), the bar's foot stays in view — a layer's where its scroll ends", async () => {
    await ready;
    const bad = out.limit
      .filter((c) => !c.bar || c.bar.seen <= 0 || c.bar.bottom > c.shown + 0.5)
      .map((c) => `${c.fixture} ${c.scale}: bar ${c.bar ? `${c.bar.top.toFixed(1)}-${c.bar.bottom.toFixed(1)}, ${c.bar.seen.toFixed(1)} seen` : "none"} for ${c.shown} px shown`);
    expect(bad).toEqual([]);
  }, 180_000);

  // WHAT A LAYER HOLDS FITS ITS WIDTH (lot 32): the report-a-problem dialog and the
  // session settings sheet as the app renders them, and the layers captured for their
  // content (layerContent.fixtures.ts), with scrollbars that take room as Windows' (17 px)
  // and Linux's (15 px) do — a Mac's take none —, at every text scale and keyboard, in
  // this platform's font and in one as wide as monospace: nothing scrolls in width,
  // nothing is cut by a hidden overflow (OVERRUNS_SCRIPT, browserProbe.testkit.ts; the
  // layers guard holds every layer's frame so, with generic content). Under Linux the
  // dialog's category select, as wide as its value and on one line, ran 4 px past the
  // dialog when its scrollbar took room, and a scrollbar in width took 15 px more.
  test("what a layer holds fits its width — no scroll in width, nothing cut — at every scale and keyboard, in this platform's font and in text as wide as monospace, with scrollbars that take room (lot 32)", async () => {
    await ready;
    const layers = [...fixtures.filter((f) => f.box === "layer"), ...LAYER_CONTENT_FIXTURES];
    expect(layers.length).toBeGreaterThan(0);
    expect(out.widths.length).toBe(layers.length * Object.keys(SCALES).length * WIDTH_FONTS.length * KEYBOARDS.length);
    const bad = out.widths.flatMap((c) => c.overruns.map((o) => `${c.fixture} ${c.scale} keyboard ${c.kb}, ${c.font}: ${overrunText(o)}`));
    expect(bad).toEqual([]);
  }, 180_000);

  // A NAME KEEPS A FEW CHARACTERS BEFORE ITS ROW BREAKS (lot 33): the names lot 32 let
  // shrink with their row — a member's, an access row's — grew from nothing, and the row
  // broke only where even an empty name left its controls no room: before that, a name
  // showed one letter and its ellipsis. Each keeps three characters, or all of its own,
  // at every scale and in both fonts, on the phones the layers were captured on.
  test("a name that shrinks with its row keeps three of its characters, or all of its own, before the row breaks — at every scale, in both fonts (lot 33)", async () => {
    await ready;
    expect(out.names.length).toBeGreaterThan(0);
    const bad = out.names
      .filter((c) => c.shown < Math.min(3, c.length))
      .map((c) => `${c.fixture} ${c.scale}, ${c.font}: ${c.item} shows ${c.shown} of its ${c.length} characters in ${c.width} px`);
    expect(bad).toEqual([]);
  }, 180_000);
});
