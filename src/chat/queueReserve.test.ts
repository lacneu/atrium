// @vitest-environment node
//
// THE END OF THE REPLY IS FOLLOWED ABOVE THE QUEUED CARDS (lot 29), AND THE FOLLOW GIVES
// WAY TO THE READER (lot 30) — TO NO ONE ELSE (lot 31), by assistant-ui's REAL follow —
// ThreadPrimitive.Viewport and its useThreadViewportAutoScroll — with the app's real
// QueuedDock and every stylesheet the app loads, in a real Chrome, in real time, with
// REAL input (keys, wheel, touch, presses, through the DevTools protocol: a page's own
// synthetic events never scroll).
//
// - The reader is at the end of a reply, a message is queued and no text arrives after
//   it: once the reserve's transition is over — at once under reduced motion — the
//   transcript is at its end and the reply's bubble above the cards. On lot 28 the
//   reserve was a spacer neither of the follow's observers saw grow.
// - The reader takes the scroll up during the transition — PageUp, ArrowUp, Home,
//   Shift+Space with the focus in the transcript or on the page, the focus landing on a
//   message above, a script, the app's own jump, a wheel, a touch, the scrollbar: the
//   position they chose is the one they keep, after the transition and after the next
//   text, and assistant-ui reads them away from the end. On lot 29 the follow stopped
//   only on a pointer, a wheel or a touch, and each frame's scroll to the end took any
//   other position back; its smooth scroll, under way, swallowed a wheel, a touch or a
//   scrollbar press and outlived the stop; and the bottom intent it planted in
//   assistant-ui brought the reader back with the next text.
// - What does not take the scroll up does not stop the follow: typing in the composer,
//   Shift+Space on a control, the focus landing in view, PageDown, a wheel down. A
//   reader above the end is not moved by a card.
// - Nor does what the layout moves, no one scrolling (lot 31, pass 20): a widget closing
//   the reply that reports a smaller height, a block far above that folds, the composer
//   cleared by a send — the scroll pulled up with the end, before the next frame grows
//   the reserve. On lot 30 assistant-ui and the follow took the pull for the reader's
//   own: the reader was left 53 px short of the end, under the cards, and the next text
//   no longer followed them.
// - Every scroll the app makes of the transcript tells the follow first (the AST of
//   src/): a smooth scroll shows no move before the follow's next frame.
//
// The probe waits for conditions, never for a clock — a loaded machine slows the frames,
// not the outcome: the whole thread at its end before each experiment, a key's scroll at
// rest, the transcript still after the card, the next text laid out. What must fall
// within the follow's window (100 to 300 ms) stays in real time: an experiment whose
// precondition is missed (the reader acting after the window) is run again, up to
// ATTEMPTS times, and is never a result, green or red — a test of its own says that
// every experiment met it.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { build, type Plugin, type Rollup } from "vite";
import { describe, expect, test, type TestContext } from "vitest";
import {
  focusScrollsTranscript,
  followReserve,
  keyScrollsTranscriptUp,
  longestTimeMs,
  stopReserveFollow,
} from "./queueReserve";
import { appCss, chromeOrFail, ROOT, runChromeLive, scriptData } from "./browserProbe.testkit";

const ENTRY = "virtual:queue-reserve-probe";

// The page's code: plain createElement, the bundle's only source of its own.
const ENTRY_CODE = String.raw`
import { createElement as h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useLocalRuntime, useMessage, useThreadViewportStore } from "@assistant-ui/react";
import { QueuedDock } from "/src/chat/QueuedDock.tsx";
import { QueueDockContext } from "/src/chat/queueDockContext.ts";
import * as reserve from "/src/chat/queueReserve.ts";
import { SIMPLE_FRAME_SANDBOX, WIDGET_SIZE, clampReportedHeight, isFromWidgetFrame } from "/src/chat/widgets/widgetSandbox.ts";

const LINE = "Une ligne de la reponse, assez longue pour revenir a la ligne dans la colonne du fil. ";
const messages = Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: [{ type: "text", text: LINE.repeat(i % 2 ? 8 : 1) }],
}));
const adapter = { async *run() {} };
// Text that reaches the end of the transcript later, as a reply's deltas reach its DOM.
let tail = "";
const tailSubs = new Set();
const Tail = () => {
  const text = useSyncExternalStore((f) => (tailSubs.add(f), () => tailSubs.delete(f)), () => tail);
  return text ? h("p", { className: "oc-probe-tail" }, text) : null;
};
// A widget closing the last reply, sized as WidgetPart sizes it (its simple mode): its
// frame reports its height (openclaw:widget-size), WidgetPart's own helpers check where
// the message comes from and clamp it, and the frame's style takes it. It reports 500 px
// once loaded, then whatever height the page asks it for.
const WIDGET_DOC =
  "<!doctype html><html><body><script>" +
  "const size = (height) => parent.postMessage({ type: " + JSON.stringify(WIDGET_SIZE) + ", height }, '*');" +
  "size(500); addEventListener('message', (e) => { if (typeof e.data === 'number') size(e.data); });" +
  "<\/script></body></html>";
let widgetOn = false;
let widgetFrame = null;
// The widget's frame has reported a size: its script runs, it will answer.
let widgetReported = false;
// An experiment's change of the layout, recorded in the layout effect that applies it —
// where it is, the transcript, and the reserve's height — after, when it asks for one, a
// layout computed before the next frame (a measure, as any component's).
let expected = null;
const applied = (what) => {
  const c = expected;
  if (c === null || c.what !== what) return;
  expected = null;
  const v = vp();
  if (c.measure) void v.scrollHeight;
  c.resolve({ t: Math.round(performance.now() - c.t0), top: v.scrollTop, max: v.scrollHeight - v.clientHeight, spacer: spacer(v) });
};
const change = (t0, what, measure, act) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (expected === null || expected.what !== what) return;
      expected = null;
      reject(new WaitTimeout("waited " + DEADLINE_MS + " ms for the layout change " + what + ": " + JSON.stringify(where())));
    }, DEADLINE_MS);
    const done = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    expected = { t0, what, measure, resolve: done };
    act();
  });
const Widget = () => {
  const [height, setHeight] = useState(500);
  const ref = useRef(null);
  useEffect(() => {
    const onMessage = (event) => {
      const frame = ref.current;
      if (!isFromWidgetFrame(event, frame && frame.contentWindow, "null")) return;
      const d = event.data;
      if (!d || typeof d !== "object" || d.type !== WIDGET_SIZE) return;
      const next = clampReportedHeight(d.height);
      if (next === null) return;
      widgetReported = true;
      setHeight(next);
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);
  useLayoutEffect(() => {
    widgetFrame = ref.current;
    applied("widget:" + height);
  }, [height]);
  return h("iframe", { ref, className: "oc-widget__frame", title: "widget", sandbox: SIMPLE_FRAME_SANDBOX, referrerPolicy: "no-referrer", srcDoc: WIDGET_DOC, style: { height } });
};
// A block the first message holds, far above the end (a reasoning, a tool's card), that
// folds from 300 px to 200 when the experiment asks.
let blockOn = false;
let setBlockHeight = null;
const Block = () => {
  const [height, setHeight] = useState(300);
  setBlockHeight = setHeight;
  useLayoutEffect(() => applied("block:" + height), [height]);
  return h("div", { className: "oc-probe-block", style: { height } });
};
// A message the focus can land on (a screen reader, a script), and a control in it; the
// last one closed by the widget, the first holding the block, when the experiment has them.
const Message = () => {
  const index = useMessage((m) => m.index);
  const last = useMessage((m) => m.isLast);
  return h(
    MessagePrimitive.Root,
    { className: "oc-msg", tabIndex: -1 },
    index === 0 && blockOn ? h(Block) : null,
    h(MessagePrimitive.Content, null),
    last && widgetOn ? h(Widget) : null,
    h("button", { type: "button", className: "oc-probe-copy" }, "Copier"),
  );
};
let setQueued = null;
let store = null;
const Probe = () => ((store = useThreadViewportStore()), null);
// The composer's lines: a draft of several, cleared by a send.
let composerRows = 1;
let setComposerRows = null;
function Thread() {
  const [queued, set] = useState([]);
  setQueued = set;
  const [rows, setRows] = useState(composerRows);
  setComposerRows = setRows;
  useLayoutEffect(() => applied("rows:" + rows), [rows]);
  const dock = { queuedTurns: queued, cancelQueued: async () => true };
  return h(
    ThreadPrimitive.Root,
    { className: "oc-thread", style: { height: "600px" } },
    h(ThreadPrimitive.Viewport, { className: "oc-thread__viewport" }, h(ThreadPrimitive.Messages, { components: { Message } }), h(Tail)),
    h("div", { className: "oc-scrolldown-anchor" }),
    h(QueueDockContext.Provider, { value: dock }, h(QueuedDock), h(Probe)),
    h(
      "form",
      { className: "oc-composer" },
      h("textarea", { className: "oc-composer__input", rows }),
      h("div", { className: "oc-composer__bar" }, h("button", { type: "button", className: "oc-composer__send" }, "Envoyer")),
    ),
  );
}
let runtimeNow = null;
function App() {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  runtimeNow = runtime;
  return h(AssistantRuntimeProvider, { runtime }, h(Thread));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
// Real input, dispatched by the driver (browserProbe.testkit.ts).
let inputs = 0;
const pendingInputs = new Map();
window.__cdpInputDone = (id, error) => {
  const p = pendingInputs.get(id);
  pendingInputs.delete(id);
  if (p) error ? p.reject(new Error(error)) : p.resolve();
};
const input = (events) =>
  new Promise((resolve, reject) => {
    const id = ++inputs;
    pendingInputs.set(id, { resolve, reject });
    window.__cdpInput(JSON.stringify({ id, events }));
  });
const KEYS = {
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  Home: { key: "Home", code: "Home", vk: 36 },
  ShiftSpace: { key: " ", code: "Space", vk: 32, modifiers: 8, text: " " },
  a: { key: "a", code: "KeyA", vk: 65, text: "a" },
};
const keyEvents = (name) => {
  const k = KEYS[name];
  // No native key code: on a Mac it names other keys (33 is "["), and PageUp in the
  // composer then hid the page in Chrome.
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: k.modifiers || 0 };
  return [
    { method: "Input.dispatchKeyEvent", params: k.text ? Object.assign({ type: "keyDown", text: k.text, unmodifiedText: k.text }, base) : Object.assign({ type: "rawKeyDown" }, base) },
    { method: "Input.dispatchKeyEvent", params: Object.assign({ type: "keyUp" }, base) },
  ];
};
const mouse = (type, x, y) => ({ method: "Input.dispatchMouseEvent", params: { type, x, y, button: "left", clickCount: 1 } });

let root = null;
const vp = () => document.querySelector(".oc-thread__viewport");
const atEnd = (v) => Math.abs(v.scrollHeight - v.scrollTop - v.clientHeight) <= 1;
const spacer = (v) => parseFloat(getComputedStyle(v, "::after").height);
const inView = (el) => {
  const r = el.getBoundingClientRect();
  const v = vp().getBoundingClientRect();
  return r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5;
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Every wait an assertion depends on waits for its CONDITION, held on consecutive frames,
// never for a clock: a loaded machine slows the frames, not the outcome. Past the
// deadline, the wait fails by name, with where the thread stood: a WaitTimeout, a
// precondition this attempt missed — the experiment is run again — never a defect of the
// probe, which stops everything.
const DEADLINE_MS = 15000;
class WaitTimeout extends Error {}
// What assistant-ui's runtime holds, against what the DOM shows.
const runtimeState = () => {
  if (runtimeNow === null) return null;
  const out = {};
  try {
    out.messages = runtimeNow.thread.getState().messages.length;
  } catch (e) {
    out.thread = String((e && e.message) || e);
  }
  try {
    const t = runtimeNow.threads.getState();
    out.mainThreadId = t.mainThreadId;
    out.threadIds = t.threadIds;
    out.isLoading = t.isLoading;
  } catch (e) {
    out.threads = String((e && e.message) || e);
  }
  return out;
};
const where = () => {
  const v = vp();
  const page = { visibility: document.visibilityState, hidden: document.hidden, runtime: runtimeState() };
  if (v === null) return Object.assign({ thread: "none" }, page);
  return Object.assign({ top: v.scrollTop, max: v.scrollHeight - v.clientHeight, bubbles: v.querySelectorAll(".oc-msg").length, isAtBottom: store ? store.getState().isAtBottom : null }, page);
};
// The frames a wait saw: how many, the longest gap between two, how many with the page hidden.
const frameWatch = () => {
  const w = { t0: performance.now(), frames: 0, maxGapMs: 0, hiddenFrames: 0, last: performance.now() };
  w.tick = () => {
    const now = performance.now();
    w.frames++;
    w.maxGapMs = Math.max(w.maxGapMs, now - w.last);
    w.last = now;
    if (document.hidden) w.hiddenFrames++;
  };
  w.report = () => ({ ms: Math.round(performance.now() - w.t0), frames: w.frames, maxGapMs: Math.round(w.maxGapMs), hiddenFrames: w.hiddenFrames });
  return w;
};
async function until(what, cond, frames, watch) {
  const t0 = performance.now();
  let held = 0;
  for (;;) {
    await nextFrame();
    if (watch) watch.tick();
    held = cond() ? held + 1 : 0;
    if (held >= frames) return;
    if (performance.now() - t0 > DEADLINE_MS) {
      const e = new WaitTimeout("waited " + DEADLINE_MS + " ms for " + what + ": " + JSON.stringify(where()) + (watch ? " frames " + JSON.stringify(watch.report()) : ""));
      if (watch) e.watch = watch.report();
      throw e;
    }
  }
}
// True once the transcript has not moved since the previous call.
const still = () => {
  let last = null;
  return () => {
    const top = vp().scrollTop;
    const held = last !== null && Math.abs(top - last) <= 0.1;
    last = top;
    return held;
  };
};
const atTheEnd = () => atEnd(vp()) && store.getState().isAtBottom;
// Mounts a fresh thread — with the widget closing its last reply and the composer's draft
// of several lines, when the experiment asks for them; returns how long it took to stand
// at its end, in time and frames.
async function mount(setup = {}) {
  if (root) root.unmount();
  tail = "";
  store = null;
  runtimeNow = null;
  widgetOn = setup.widget === true;
  widgetReported = false;
  blockOn = setup.block === true;
  composerRows = setup.rows || 1;
  expected = null;
  root = createRoot(document.getElementById("root"));
  const watch = frameWatch();
  root.render(h(App));
  // Its 10 messages rendered, the thread scrolling, at its end — for assistant-ui too.
  await until(
    "the thread at its end with its 10 messages (and its widget's size, when it has one)",
    () => {
      const v = vp();
      return v !== null && store !== null && v.querySelectorAll(".oc-msg").length === 10 && v.scrollHeight > v.clientHeight + 100 && atTheEnd() && (!widgetOn || widgetReported);
    },
    5,
    watch,
  );
  return watch.report();
}
const sample = (t0) => {
  const v = vp();
  const q = document.querySelector(".oc-queue-dock");
  const last = [...v.querySelectorAll(".oc-msg")].pop();
  return {
    t: Math.round(performance.now() - t0),
    top: Math.round(v.scrollTop * 10) / 10,
    atEnd: atEnd(v),
    isAtBottom: store.getState().isAtBottom,
    lastBottom: last.getBoundingClientRect().bottom,
    cardsTop: q ? q.getBoundingClientRect().top : null,
  };
};
// SETTLE = 10 frames without a move, once the follow's window is past (its transition
// and 100 ms: 300 ms; 400 here) — and more than SETTLE_FRAMES frames past it, so that
// what is counted in frames holds that many at any refresh rate (the Playwright shell
// draws every 8 ms here, Google Chrome every 17).
const SETTLE_FRAMES = 10;
async function sampleUntilSettled(t0, into) {
  const held = still();
  let frames = 0;
  let past = 0;
  for (;;) {
    await nextFrame();
    const s = sample(t0);
    into.push(s);
    frames = held() ? frames + 1 : 0;
    if (s.t >= 400) past++;
    if (past > SETTLE_FRAMES && frames >= SETTLE_FRAMES) return;
    if (s.t > DEADLINE_MS) throw new Error("waited " + DEADLINE_MS + " ms for the transcript to hold still after the card: " + JSON.stringify(where()));
  }
}

// What the reader does during the reserve's transition, and what the follow must do.
const ACTIONS = {
  untouched: { kind: "keeps" },
  PageUp: { kind: "takes", focus: "message", run: () => input(keyEvents("PageUp")) },
  ArrowUp: { kind: "takes", focus: "message", run: () => input(keyEvents("ArrowUp")) },
  Home: { kind: "takes", focus: "message", run: () => input(keyEvents("Home")) },
  ShiftSpace: { kind: "takes", focus: "message", run: () => input(keyEvents("ShiftSpace")) },
  PageUpOnPage: { kind: "takes", focus: "page", run: () => input(keyEvents("PageUp")) },
  focusAbove: { kind: "takes", run: () => document.querySelectorAll(".oc-msg")[5].focus() },
  scriptInstant: { kind: "takes", target: -400, run: (v) => v.scrollTo({ top: v.scrollTop - 400, behavior: "instant" }) },
  appJump: {
    kind: "takes",
    target: -400,
    run: (v) => {
      if (reserve.stopReserveFollow) reserve.stopReserveFollow(v);
      v.scrollTo({ top: v.scrollTop - 400, behavior: "smooth" });
    },
  },
  wheelUp: { kind: "takes", run: (v) => { const r = v.getBoundingClientRect(); return input([{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: r.left + 200, y: r.top + 200, deltaX: 0, deltaY: -300 } }]); } },
  // A finger dragging the transcript down 300 px, a move a frame: touch events, which
  // scroll in Chrome under Linux too — its synthesized touch gesture does not (measured,
  // lot 31: a press and a release, the transcript unmoved).
  touch: {
    kind: "takes",
    run: async (v) => {
      const r = v.getBoundingClientRect();
      const finger = (type, dy) => ({ method: "Input.dispatchTouchEvent", params: { type, touchPoints: type === "touchEnd" ? [] : [{ x: r.left + 200, y: r.top + 150 + dy }] } });
      await input([finger("touchStart", 0)]);
      for (let i = 1; i <= 15; i++) {
        await nextFrame();
        await input([finger("touchMove", 20 * i)]);
      }
      await input([finger("touchEnd", 0)]);
    },
  },
  scrollbar: { kind: "takes", run: async (v) => { const r = v.getBoundingClientRect(); await input([mouse("mousePressed", r.right - 4, r.top + 30)]); await sleep(60); await input([mouse("mouseReleased", r.right - 4, r.top + 30)]); } },
  typing: { kind: "keeps", focus: "composer", run: () => input(keyEvents("a").concat(keyEvents("ArrowUp"), keyEvents("PageUp"))) },
  ShiftSpaceOnControl: { kind: "keeps", focus: "control", run: () => input(keyEvents("ShiftSpace")) },
  focusInView: { kind: "keeps", run: (v) => [...v.querySelectorAll(".oc-probe-copy")].pop().focus() },
  PageDown: { kind: "keeps", focus: "message", run: () => input(keyEvents("PageDown")) },
  wheelDown: { kind: "keeps", run: (v) => { const r = v.getBoundingClientRect(); return input([{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: r.left + 200, y: r.top + 200, deltaX: 0, deltaY: 120 } }]); } },
  // What layout moves during the transition, no one scrolling — each change made in a
  // task between two frames, and laid out before the next one (a measure, as any
  // component's: the scroll is pulled up with the end there, and the reserve grows at the
  // start of the next frame, before anyone looks). Each folds by 113 px, which the next
  // text's lines do not add up to: assistant-ui knows a change of the content by its
  // height alone, and a fold of 100 px the next text's 100 px made up for went unseen
  // (measured, lot 31: the reader left short of the end — the follow long over, a matter
  // of assistant-ui's own).
  // - the end shrinking: the widget closing the last reply reports 387 px instead of 500;
  widgetShrinks: { kind: "keeps", widget: true, layout: true, run: (v, t0) => change(t0, "widget:387", true, () => widgetFrame.contentWindow.postMessage(387, "*")) },
  // - a block far above the end folding, 300 px down to 187 (the browser's scroll
  //   anchoring keeps what is shown in place, the scroll up by as much);
  aboveShrinks: { kind: "keeps", block: true, layout: true, run: (v, t0) => change(t0, "block:187", true, () => setTimeout(() => setBlockHeight(187), 0)) },
  // - the transcript's box growing: a frame after the card, the send clears the
  //   composer's draft, four lines down to one.
  composerShrinks: { kind: "keeps", rows: 4, afterFrame: true, layout: true, run: (v, t0) => change(t0, "rows:1", true, () => setTimeout(() => setComposerRows(1), 0)) },
  readerAbove: { kind: "away" },
};

// The experiment ran as designed: from the end of the whole thread, and the reader's
// act — its first input as the page received it, else the page's own act — while the
// follow ran: with the reserve still growing, or, under reduced motion (no transition),
// within the follow's 100 ms. A missed precondition is no result, green or red.
function precondition(a, out) {
  const b = out.before;
  if (!(b.atEnd && b.bubbles === 10 && b.overflow)) return { met: false, why: "not at the end of the whole thread: " + JSON.stringify(b) };
  if (!a.run) return { met: true };
  // A change of the layout counts when it is laid out; an input, when the page has it.
  const at = out.changed || out.first || out.acted;
  if (reducedMotion) return at.t < 100 ? { met: true } : { met: false, why: "acted at " + at.t + " ms, past the follow's 100 ms" };
  return at.spacer < out.spacerFinal - 1
    ? { met: true }
    : { met: false, why: "acted with the reserve at " + at.spacer + " px of " + out.spacerFinal + ": its transition was over" };
}

async function attempt(name) {
  const a = ACTIONS[name];
  const mounted = await mount(a);
  const v = vp();
  const out = {
    name,
    kind: a.kind,
    mount: mounted,
    before: { atEnd: atEnd(v), bubbles: v.querySelectorAll(".oc-msg").length, overflow: v.scrollHeight > v.clientHeight + 100 },
    transition: getComputedStyle(v, "::after").transitionDuration,
    samples: [],
    after: [],
    acted: null,
    first: null,
    changed: null,
    atKey: null,
    target: null,
    away: null,
    spacerFinal: null,
    focusedInView: null,
    pre: null,
  };
  const messagesEls = [...v.querySelectorAll(".oc-msg")];
  if (a.focus === "message") messagesEls[messagesEls.length - 1].focus();
  if (a.focus === "control") [...v.querySelectorAll(".oc-probe-copy")].pop().focus();
  if (a.focus === "composer") document.querySelector(".oc-composer__input").focus();
  if (a.focus === "page") {
    // A press in the transcript, then the focus on the page: the browser's keys then
    // scroll the scroller last pressed in.
    const r = messagesEls[messagesEls.length - 1].getBoundingClientRect();
    await input([mouse("mousePressed", r.left + 20, r.top + 10), mouse("mouseReleased", r.left + 20, r.top + 10)]);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  // The start each experiment needs, as assistant-ui reads it.
  if (a.kind === "away") {
    v.scrollTo({ top: v.scrollTop - 200, behavior: "instant" });
    await until("assistant-ui to read the reader away from the end", () => !store.getState().isAtBottom && !atEnd(vp()), 3);
    out.away = v.scrollTop;
  } else {
    await until("the reader at the end, for assistant-ui too", atTheEnd, 3);
  }
  const t0 = performance.now();
  // The reader's first input as the page receives it: capture, before anything else.
  const onInput = (e) => {
    if (out.first !== null) return;
    out.first = { type: e.type, t: Math.round(performance.now() - t0), top: vp().scrollTop, spacer: spacer(vp()) };
    if (e.type === "keydown") out.atKey = out.first.top;
  };
  const kinds = ["keydown", "wheel", "pointerdown", "touchstart"];
  for (const type of kinds) addEventListener(type, onInput, true);
  try {
    setQueued([{ messageId: "q1", text: "Un message mis en file pendant que l'agent travaille", pending: false, mine: true, canCancel: true }]);
    const sampling = sampleUntilSettled(t0, out.samples);
    if (a.run) {
      if (a.afterFrame) await nextFrame();
      else await sleep(50);
      out.acted = { t: Math.round(performance.now() - t0), top: v.scrollTop, spacer: spacer(v) };
      if (a.target !== undefined) out.target = Math.max(0, v.scrollTop + a.target);
      // A layout change resolves to where it was laid out (scrollTo's promise, in this
      // Chrome, to whether it was interrupted).
      if (a.layout) out.changed = await a.run(v, t0);
      else await a.run(v);
    }
    await sampling;
  } finally {
    for (const type of kinds) removeEventListener(type, onInput, true);
  }
  out.settledAt = out.samples.length - (SETTLE_FRAMES + 1);
  out.spacerFinal = spacer(v);
  const focused = document.activeElement;
  const watchFocus = name === "focusAbove";
  if (watchFocus) out.focusedInView = [inView(focused)];
  // The next text, then twenty frames for assistant-ui to answer it (its observers
  // answer within the frame that lays it out).
  const t1 = performance.now();
  tail = LINE.repeat(4);
  tailSubs.forEach((f) => f());
  await until("the next text in the transcript", () => vp().querySelector(".oc-probe-tail") !== null, 1);
  for (let i = 0; i < 20; i++) {
    await nextFrame();
    out.after.push(sample(t1));
  }
  if (watchFocus) out.focusedInView.push(inView(focused));
  out.pre = precondition(a, out);
  return out;
}

// An experiment whose precondition is missed is run again, up to ATTEMPTS times, each
// miss kept with its reason.
const ATTEMPTS = window.__ATTEMPTS;
// A wait that ran out within an attempt — the mount or any other condition of the
// environment — is a precondition that attempt missed: kept with its reason, the attempt
// run again, the other experiments run all the same. Any other error is a defect of the
// probe: it stops everything.
async function scenario(name) {
  const missed = [];
  const mounts = [];
  for (let i = 1; ; i++) {
    let out;
    try {
      out = await attempt(name);
      mounts.push(out.mount);
    } catch (e) {
      if (!(e instanceof WaitTimeout)) throw e;
      if (e.watch) mounts.push(Object.assign({ failed: true }, e.watch));
      out = { name, kind: ACTIONS[name].kind, pre: { met: false, why: "environment: " + e.message } };
    }
    if (out.pre.met || i === ATTEMPTS) {
      out.attempts = i;
      out.missed = out.pre.met ? missed : missed.concat([out.pre.why]);
      out.mounts = mounts;
      return out;
    }
    missed.push(out.pre.why);
  }
}
// The keys' steps with no follow running, under the same rule.
async function idleStep(name) {
  const missed = [];
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const mounted = await mount();
      const msgs = [...vp().querySelectorAll(".oc-msg")];
      msgs[msgs.length - 1].focus();
      await until("the reader at the end, for assistant-ui too", atTheEnd, 3);
      const from = vp().scrollTop;
      await input(keyEvents(name));
      await until(name + " to move the transcript", () => vp().scrollTop < from - 1, 1);
      await until(name + "'s scroll to come to rest", still(), SETTLE_FRAMES);
      return { step: from - vp().scrollTop, attempts: i, missed, mount: mounted };
    } catch (e) {
      if (!(e instanceof WaitTimeout)) throw e;
      missed.push("environment: " + e.message);
    }
  }
  return { step: null, attempts: ATTEMPTS, missed, mount: null };
}

(async () => {
  const res = { errors: [], stage: "running", runs: [], idle: {}, idleRuns: {} };
  const write = () => (document.getElementById("out").textContent = JSON.stringify(res));
  write();
  try {
    // How far each key moves this transcript with no follow running: from the end, to
    // where its scroll comes to rest.
    for (const name of ["PageUp", "ArrowUp"]) {
      const r = await idleStep(name);
      res.idle[name] = r.step;
      res.idleRuns[name] = r;
      write();
    }
    for (const name of window.__SCENARIOS) {
      res.runs.push(await scenario(name));
      write();
    }
    res.stage = "done";
  } catch (e) {
    res.errors.push(String((e && e.stack) || e));
  }
  write();
})();
`;

type Sample = { t: number; top: number; atEnd: boolean; isAtBottom: boolean; lastBottom: number; cardsTop: number | null };
type Run = {
  name: string;
  kind: "keeps" | "takes" | "away";
  before: { atEnd: boolean; bubbles: number; overflow: boolean };
  transition: string;
  samples: Sample[];
  after: Sample[];
  acted: { t: number; top: number; spacer: number } | null;
  first: { type: string; t: number; top: number; spacer: number } | null;
  // A change of the layout the experiment made, as it was laid out.
  changed: { t: number; top: number; max: number; spacer: number } | null;
  atKey: number | null;
  target: number | null;
  away: number | null;
  spacerFinal: number;
  settledAt: number;
  focusedInView: boolean[] | null;
  pre: { met: boolean; why?: string };
  attempts: number;
  missed: string[];
  // Each attempt's mount: how long the thread took to stand at its end, in time and frames.
  mounts: Mount[];
};
type Mount = { ms: number; frames: number; maxGapMs: number; hiddenFrames: number; failed?: boolean };
type IdleRun = { step: number | null; attempts: number; missed: string[]; mount: Mount | null };
type Out = {
  errors: string[];
  stage: string;
  idle: { PageUp: number | null; ArrowUp: number | null };
  idleRuns: { PageUp: IdleRun; ArrowUp: IdleRun };
  runs: Run[];
};

/** min, median and max of a list of numbers. */
function spread(xs: number[]): { min: number; median: number; max: number } | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
}

/** The page's bundle: React, assistant-ui and the dock, as the app's build compiles them. */
async function bundle(): Promise<string> {
  const virtual: Plugin = {
    name: "queue-reserve-probe",
    resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
    load: (id) => (id === `\0${ENTRY}` ? ENTRY_CODE : null),
  };
  const res = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    plugins: [virtual],
    resolve: { alias: { "@": join(ROOT, "src") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The production JSX runtime, as React itself is bundled here (vitest's own
    // NODE_ENV would make Vite emit the development one).
    oxc: { jsx: { runtime: "automatic", development: false } },
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: ENTRY, output: { format: "es", codeSplitting: false } },
    },
  });
  const output = (Array.isArray(res) ? res[0] : res) as Rollup.RollupOutput;
  const entry = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("no bundle");
  return entry.code;
}

// An experiment whose precondition is missed is run again, up to this many times.
const ATTEMPTS = 3;

function page(css: string, code: string, scenarios: string[]): string {
  // An error before the scenarios write their result is the result.
  const onError = `addEventListener("error", (e) => { document.getElementById("out").textContent = JSON.stringify({ errors: [String(e.message) + " at " + e.lineno], stage: "error", runs: [], idle: {} }); });`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${css}</style></head><body><pre id="out"></pre><div id="root"></div><script>${onError} window.__SCENARIOS = ${scriptData(scenarios)}; window.__ATTEMPTS = ${ATTEMPTS};</script><script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

// A transcript, a document and a window, enough for the follow's own logic (Chrome
// runs the real one below): listeners called by hand — the document's first, as the
// capture phase does —, frames run one by one, the reserve's height readable.
function fakeDom(geometry: { top: number; height: number; client: number }) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const on = (prefix: string) => ({
    addEventListener: (type: string, f: (e: unknown) => void) => {
      const k = `${prefix}:${type}`;
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k)!.add(f);
    },
    removeEventListener: (type: string, f: (e: unknown) => void) => listeners.get(`${prefix}:${type}`)?.delete(f),
  });
  const frames = new Map<number, () => void>();
  let ids = 0;
  let now = 0;
  let reserve = 0;
  const win = {
    getComputedStyle: () => ({
      transitionDuration: "0.2s",
      transitionDelay: "0s",
      get height() {
        return `${reserve}px`;
      },
    }),
    performance: { now: () => now },
    requestAnimationFrame: (f: () => void) => {
      frames.set(++ids, f);
      return ids;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  const doc = { defaultView: win, body: { nodeType: 1 }, documentElement: { nodeType: 1 }, ...on("doc") };
  const inside = new Set<unknown>();
  let scrolls = 0;
  const viewport = {
    ownerDocument: doc,
    scrollTop: geometry.top,
    scrollHeight: geometry.height,
    clientHeight: geometry.client,
    contains: (el: unknown) => inside.has(el),
    getBoundingClientRect: () => ({ top: 0, bottom: geometry.client }),
    scrollTo(o: { top: number }) {
      scrolls++;
      this.scrollTop = Math.min(o.top, this.scrollHeight - this.clientHeight);
    },
    ...on("vp"),
  };
  return {
    viewport,
    doc,
    inside,
    scrolls: () => scrolls,
    // An event dispatched at the transcript or the document: the document's listeners first.
    fire: (target: "vp" | "doc", type: string, e: Record<string, unknown> = {}) => {
      const ev = target === "vp" ? { target: viewport, ...e } : e;
      for (const f of [...(listeners.get(`doc:${type}`) ?? [])]) f(ev);
      if (target === "vp") for (const f of [...(listeners.get(`vp:${type}`) ?? [])]) f(ev);
    },
    // The reserve's spacer grows, and the transcript's content with it.
    grow: (px: number) => {
      reserve += px;
      viewport.scrollHeight += px;
    },
    // A layout before the next frame: the content shrinking under the end, or the
    // transcript's box growing — the scroll pulled up with the end, as the browser clamps it.
    shrinkEnd: (px: number) => {
      viewport.scrollHeight -= px;
      viewport.scrollTop = Math.min(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
    },
    growBox: (px: number) => {
      viewport.clientHeight += px;
      viewport.scrollTop = Math.min(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
    },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    // Runs the frames asked for, `ms` later.
    frame: (ms = 16) => {
      now += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const f of due) f();
    },
    pending: () => frames.size,
  };
}

const el = (kind: "plain" | "field" | "control" = "plain") => ({
  nodeType: 1,
  closest: (sel: string) =>
    (kind === "field" && sel.includes("textarea")) || (kind === "control" && sel.includes("button")) ? {} : null,
  getBoundingClientRect: () => ({ top: 10, bottom: 50 }),
});

describe("the reserve's follow, unit by unit (lots 29-30)", () => {
  test("a transition's longest time, in ms", () => {
    expect(longestTimeMs("0.2s")).toBe(200);
    expect(longestTimeMs("0s, 150ms")).toBe(150);
    expect(longestTimeMs("")).toBe(0);
  });

  test("the keys that scroll the transcript up: PageUp, ArrowUp, Home, Shift+Space — not those toward the end", () => {
    const dom = fakeDom({ top: 0, height: 1000, client: 500 });
    const inTranscript = el();
    dom.inside.add(inTranscript);
    const vp = dom.viewport as unknown as HTMLElement;
    const key = (k: string, shiftKey = false, target: unknown = inTranscript) =>
      keyScrollsTranscriptUp({ key: k, shiftKey, target: target as EventTarget }, vp);
    expect(["PageUp", "ArrowUp", "Home"].map((k) => key(k))).toEqual([true, true, true]);
    expect(key(" ", true)).toBe(true);
    expect([" ", "PageDown", "ArrowDown", "End", "a", "Enter", "ArrowLeft"].map((k) => key(k))).toEqual(
      Array(7).fill(false),
    );
  });

  test("…pressed in the transcript or on the page itself, not in a field, Space not on a control it presses", () => {
    const dom = fakeDom({ top: 0, height: 1000, client: 500 });
    const vp = dom.viewport as unknown as HTMLElement;
    const [plain, field, control, outside] = [el(), el("field"), el("control"), el()];
    for (const e of [plain, field, control]) dom.inside.add(e);
    const key = (k: string, target: unknown, shiftKey = false) =>
      keyScrollsTranscriptUp({ key: k, shiftKey, target: target as EventTarget }, vp);
    expect(key("PageUp", dom.doc.body)).toBe(true);
    expect(key("PageUp", dom.doc.documentElement)).toBe(true);
    expect(key("PageUp", plain)).toBe(true);
    expect(key("PageUp", outside)).toBe(false);
    expect(key("PageUp", field)).toBe(false);
    expect(key("ArrowUp", control)).toBe(true);
    expect(key(" ", control, true)).toBe(false);
    expect(key(" ", plain, true)).toBe(true);
    expect(key("PageUp", null)).toBe(false);
    expect(key("PageUp", { nodeType: 3 })).toBe(false);
  });

  test("the focus scrolls the transcript when it lands on an element not wholly in its box", () => {
    const dom = fakeDom({ top: 0, height: 1000, client: 500 });
    const vp = dom.viewport as unknown as HTMLElement;
    const at = (top: number, bottom: number) => ({ nodeType: 1, getBoundingClientRect: () => ({ top, bottom }) });
    expect(focusScrollsTranscript(at(10, 50) as unknown as EventTarget, vp)).toBe(false);
    expect(focusScrollsTranscript(at(0, 500) as unknown as EventTarget, vp)).toBe(false);
    expect(focusScrollsTranscript(at(-20, 30) as unknown as EventTarget, vp)).toBe(true);
    expect(focusScrollsTranscript(at(480, 520) as unknown as EventTarget, vp)).toBe(true);
    expect(focusScrollsTranscript(dom.viewport as unknown as EventTarget, vp)).toBe(false);
    expect(focusScrollsTranscript(null, vp)).toBe(false);
  });

  test("it asks nothing of a reader who is not at the end", () => {
    const dom = fakeDom({ top: 100, height: 1000, client: 500 });
    const stop = followReserve(dom.viewport as unknown as HTMLElement, { getState: () => ({ isAtBottom: false }) });
    stop();
    expect(dom.scrolls()).toBe(0);
    expect(dom.listening()).toBe(0);
    expect(dom.pending()).toBe(0);
  });

  test("at the end, it holds the end on every frame of the transition and once after it, with instant scrolls", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    expect(dom.scrolls()).toBe(1);
    for (let i = 0; i < 6; i++) {
      vp.scrollHeight += 10; // the spacer grows
      dom.frame(50);
      expect(vp.scrollTop).toBe(vp.scrollHeight - vp.clientHeight);
    }
    // 300 ms: the transition (200) and its margin (100) are over.
    expect(dom.pending()).toBe(0);
    expect(dom.listening()).toBe(0);
  });

  const reader: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["a pointer on the transcript", (d) => d.fire("vp", "pointerdown")],
    ["a touch on it", (d) => d.fire("vp", "touchstart")],
    ["a wheel up on it", (d) => d.fire("vp", "wheel", { deltaY: -40 })],
    ["PageUp on the page", (d) => d.fire("doc", "keydown", { key: "PageUp", shiftKey: false, target: d.doc.body })],
    ["the focus landing above the box", (d) => d.fire("vp", "focusin", { target: { nodeType: 1, getBoundingClientRect: () => ({ top: -80, bottom: -40 }) } })],
    [
      "a move up it did not make, seen in a scroll event",
      (d) => {
        d.viewport.scrollTop -= 200;
        d.fire("vp", "scroll");
      },
    ],
    [
      "a move up it did not make, seen on its next frame",
      (d) => {
        d.viewport.scrollTop -= 200;
      },
    ],
    ["the app, before it scrolls the transcript", (d) => stopReserveFollow(d.viewport as unknown as HTMLElement)],
  ];
  for (const [what, act] of reader) {
    test(`it stops for good, and scrolls no more, on ${what}`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      vp.scrollHeight += 10;
      dom.frame();
      act(dom);
      const top = vp.scrollTop;
      const scrolls = dom.scrolls();
      vp.scrollHeight += 10;
      dom.frame();
      dom.frame();
      expect(vp.scrollTop).toBe(top);
      expect(dom.scrolls()).toBe(scrolls);
      expect(dom.listening()).toBe(0);
    });
  }

  const notReader: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["a wheel down", (d) => d.fire("vp", "wheel", { deltaY: 40 })],
    ["PageDown in the transcript", (d) => d.fire("doc", "keydown", { key: "PageDown", shiftKey: false, target: d.doc.body })],
    ["the focus landing in view", (d) => d.fire("vp", "focusin", { target: { nodeType: 1, getBoundingClientRect: () => ({ top: 40, bottom: 80 }) } })],
    [
      "the end shrinking, the scroll pulled up with it",
      (d) => {
        d.viewport.scrollHeight -= 30;
        d.viewport.scrollTop = d.viewport.scrollHeight - d.viewport.clientHeight;
        d.fire("vp", "scroll");
      },
    ],
  ];
  for (const [what, act] of notReader) {
    test(`it keeps holding the end on ${what}`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      vp.scrollHeight += 10;
      dom.frame();
      act(dom);
      vp.scrollHeight += 10;
      dom.frame();
      expect(vp.scrollTop).toBe(vp.scrollHeight - vp.clientHeight);
    });
  }

  // What the layout moves is no one's move (lot 31, pass 20): pulled up with the end, at
  // the end, before the next frame — then the reserve grows at the start of that frame,
  // before the follow looks, in the scroll event of the pull or on its next frame.
  const layouts: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["the end shrinking (a widget, 100 px)", (d) => d.shrinkEnd(100)],
    ["the transcript's box growing (the composer, 72 px)", (d) => d.growBox(72)],
  ];
  for (const [what, pull] of layouts) {
    for (const seen of ["in the scroll event", "on its next frame"] as const) {
      test(`it keeps holding the end through ${what}, the reserve grown before it looks — ${seen} (lot 31)`, () => {
        const dom = fakeDom({ top: 500, height: 1000, client: 500 });
        const vp = dom.viewport;
        const atEnd = () => vp.scrollHeight - vp.scrollTop - vp.clientHeight;
        followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
        dom.grow(10);
        dom.frame();
        pull(dom);
        expect(atEnd()).toBe(0);
        dom.grow(4);
        expect(atEnd()).toBe(4);
        if (seen === "in the scroll event") {
          dom.fire("vp", "scroll");
          expect(atEnd()).toBe(0);
        }
        dom.frame();
        expect(atEnd()).toBe(0);
        for (let i = 0; i < 6; i++) {
          dom.grow(5);
          dom.frame(50);
          expect(atEnd()).toBe(0);
        }
        // Its window ran out, not its patience.
        expect(dom.pending()).toBe(0);
        expect(dom.listening()).toBe(0);
      });
    }
  }

  test("assistant-ui, its listener on the transcript reading after the follow's, reads the reader at the end through the layout's pull (lot 31)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    // assistant-ui's reading of a scroll (useThreadViewportAutoScroll): at the end within 1 px.
    const read: boolean[] = [];
    vp.addEventListener("scroll", () => read.push(Math.abs(vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= 1));
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    dom.shrinkEnd(100);
    dom.grow(4);
    dom.fire("vp", "scroll");
    expect(read).toEqual([true]);
  });

  for (const seen of ["in the scroll event", "on its next frame"] as const) {
    test(`a move up another makes as the end shrinks still stops it for good: short of the end by more than the reserve grew — ${seen} (lot 31)`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      dom.grow(10);
      dom.frame();
      dom.shrinkEnd(100);
      dom.grow(4);
      // 8 px: more than the 4 the reserve grew since the follow left it at the end.
      vp.scrollTop -= 8;
      if (seen === "in the scroll event") dom.fire("vp", "scroll");
      else dom.frame();
      const top = vp.scrollTop;
      const scrolls = dom.scrolls();
      dom.grow(10);
      dom.frame();
      dom.frame();
      expect(vp.scrollTop).toBe(top);
      expect(dom.scrolls()).toBe(scrolls);
      expect(dom.listening()).toBe(0);
    });
  }

  test("assistant-ui reading the reader away from the end stops it; a new follow ends the one under way", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    let isAtBottom = true;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom }) });
    isAtBottom = false;
    vp.scrollHeight += 10;
    dom.frame();
    expect(vp.scrollTop).toBe(500);
    expect(dom.listening()).toBe(0);
    isAtBottom = true;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom }) });
    const first = dom.listening();
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom }) });
    expect(dom.listening()).toBe(first);
    stopReserveFollow(vp as unknown as HTMLElement);
    expect(dom.listening()).toBe(0);
    stopReserveFollow(null);
  });
});

const chrome = chromeOrFail("queueReserve.test.ts");

const MOTION = [
  "untouched",
  "PageUp",
  "ArrowUp",
  "Home",
  "ShiftSpace",
  "PageUpOnPage",
  "focusAbove",
  "scriptInstant",
  "appJump",
  "wheelUp",
  "touch",
  "scrollbar",
  "typing",
  "ShiftSpaceOnControl",
  "focusInView",
  "PageDown",
  "wheelDown",
  "widgetShrinks",
  "aboveShrinks",
  "composerShrinks",
  "readerAbove",
];
const REDUCED = ["untouched", "PageUp", "focusAbove", "scriptInstant", "wheelUp", "widgetShrinks", "aboveShrinks", "composerShrinks", "readerAbove"];

describe.skipIf(chrome === null)("the end of the reply above the queued cards, and the reader's own scroll — assistant-ui's own follow, in Chrome (lots 29-30)", () => {
  // Both runs, once, when a test first needs them — one after the other: each experiment
  // acts within a window of 100 to 300 ms, and two real-time Chromes side by side would
  // compete for a machine the suite already loads.
  let runs: Promise<{ motion: Out; reduced: Out }> | null = null;
  const ready = () =>
    (runs ??= (async () => {
      const [css, code] = await Promise.all([appCss(), bundle()]);
      // Real time: virtual time runs no animation frame and no transition.
      const motion = await runChromeLive<Out>(chrome!, page(css, code, MOTION), { input: true, timeoutMs: 420_000 });
      const reduced = await runChromeLive<Out>(chrome!, page(css, code, REDUCED), {
        input: true,
        timeoutMs: 420_000,
        media: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      return { motion, reduced };
    })());
  const runOf = async (media: "motion" | "reduced", name: string, ctx: TestContext, step?: "PageUp" | "ArrowUp") => {
    const out = (await ready())[media];
    expect(out.errors).toEqual([]);
    const run = out.runs.find((r) => r.name === name);
    expect(run, `${media}: ${name} ran`).toBeDefined();
    // A missed precondition is no result: not counted (the precondition test fails) —
    // nor is a key's step that could not be measured.
    ctx.skip(!run!.pre.met, `${media}: ${name}: precondition missed ${run!.attempts} times`);
    ctx.skip(step !== undefined && out.idle[step] === null, `${media}: ${step}'s step not measured`);
    return { run: run!, idle: out.idle as { PageUp: number; ArrowUp: number } };
  };

  for (const media of ["motion", "reduced"] as const) {
    test(`${media}: every experiment met its precondition — the whole thread at its end, the reader acting while the follow ran — within ${ATTEMPTS} attempts`, async () => {
      const out = (await ready())[media];
      expect(out.errors).toEqual([]);
      const report = out.runs.map((r) => ({
        name: r.name,
        attempts: r.attempts,
        missed: r.missed,
        mounts: r.mounts,
        // What the frame-counted checks had to count, at this browser's refresh rate.
        frames: r.pre.met
          ? { sampled: r.samples.length, showingCards: r.samples.filter((x) => x.cardsTop !== null).length, settled: r.samples.length - r.settledAt }
          : null,
      }));
      const mounts = [
        ...out.runs.flatMap((r) => r.mounts),
        ...[out.idleRuns.PageUp.mount, out.idleRuns.ArrowUp.mount].filter((m): m is Mount => m !== null),
      ];
      const done = mounts.filter((m) => !m.failed);
      const summary = {
        mounts: done.length,
        failedMounts: mounts.length - done.length,
        mountMs: spread(done.map((m) => m.ms)),
        mountFrames: spread(done.map((m) => m.frames)),
        longestFrameGapMs: spread(mounts.map((m) => m.maxGapMs)),
        hiddenFrames: mounts.reduce((n, m) => n + m.hiddenFrames, 0),
      };
      const file = process.env.ATRIUM_FOLLOW_ATTEMPTS;
      if (file) appendFileSync(file, `${JSON.stringify({ media, at: new Date().toISOString(), summary, idle: out.idleRuns, runs: report })}\n`);
      expect(out.runs.map((r) => r.name)).toEqual(media === "motion" ? MOTION : REDUCED);
      expect(out.runs.filter((r) => !r.pre.met).map((r) => `${r.name}: ${r.missed.join("; ")}`)).toEqual([]);
      expect(out.runs.filter((r) => !(r.attempts >= 1 && r.attempts <= ATTEMPTS)).map((r) => r.name)).toEqual([]);
      // The keys' steps, measured with no follow running.
      expect((["PageUp", "ArrowUp"] as const).filter((k) => out.idle[k] === null).map((k) => `${k}: ${out.idleRuns[k].missed.join("; ")}`)).toEqual([]);
    }, 900_000);
  }

  // At the end once the follow's window is over, the reply's bubble above the cards —
  // under reduced motion on every frame that shows the cards (no transition: the follow
  // scrolls before the first of them is painted) — and the next text still followed.
  // Counted in frames, never in a span of time: as many at 60 Hz as at 120.
  const keeps = (run: Run, media: "motion" | "reduced") => {
    const shown = run.samples.filter((s) => s.cardsTop !== null);
    expect(shown.length).toBeGreaterThan(0);
    const settled = media === "reduced" ? shown : run.samples.slice(run.settledAt);
    expect(settled.length).toBeGreaterThan(10);
    const bad = settled
      .filter((s) => !s.atEnd || s.cardsTop === null || s.lastBottom > s.cardsTop + 0.5)
      .map((s) => `${s.t} ms: ${s.atEnd ? "at the end" : "short of the end"}, bubble's foot ${s.lastBottom.toFixed(1)} vs cards ${s.cardsTop?.toFixed(1)}`);
    expect(bad).toEqual([]);
    const last = run.after[run.after.length - 1];
    expect([last.atEnd, last.isAtBottom]).toEqual([true, true]);
  };

  // The position the reader chose, kept: from the frames the transcript settled on, past
  // the follow's window, through the next text; assistant-ui reads them away from the end.
  const takes = (run: Run): number => {
    const settled = run.samples.slice(run.settledAt);
    expect(settled.length).toBeGreaterThan(10);
    const chosen = settled[settled.length - 1].top;
    const moved = [...settled, ...run.after].filter((s) => Math.abs(s.top - chosen) > 0.5 || s.atEnd);
    expect(moved.map((s) => `${s.t} ms at ${s.top}${s.atEnd ? " (the end)" : ""}, chosen ${chosen}`)).toEqual([]);
    expect(run.after[run.after.length - 1].isAtBottom).toBe(false);
    return chosen;
  };

  test("untouched, with the reserve's transition: once it is over, at the end, the bubble above the cards", async (ctx) => {
    const { run } = await runOf("motion", "untouched", ctx);
    expect(longestTimeMs(run.transition)).toBeGreaterThan(0);
    keeps(run, "motion");
  }, 900_000);

  test("untouched, under reduced motion: no transition, and the follow is there at once", async (ctx) => {
    const { run } = await runOf("reduced", "untouched", ctx);
    expect(longestTimeMs(run.transition)).toBe(0);
    keeps(run, "reduced");
  }, 900_000);

  for (const media of ["motion", "reduced"] as const) {
    test(`${media}: PageUp in the transcript — a page up from where the key found it, kept`, async (ctx) => {
      const { run, idle } = await runOf(media, "PageUp", ctx, "PageUp");
      const chosen = takes(run);
      expect(Math.abs(chosen - (run.atKey! - idle.PageUp))).toBeLessThanOrEqual(3);
    }, 900_000);

    test(`${media}: the focus landing on a message above — in view, kept`, async (ctx) => {
      const { run } = await runOf(media, "focusAbove", ctx);
      takes(run);
      expect(run.focusedInView).toEqual([true, true]);
    }, 900_000);

    test(`${media}: a script's instant scroll — where it put the transcript, kept`, async (ctx) => {
      const { run } = await runOf(media, "scriptInstant", ctx);
      const chosen = takes(run);
      expect(Math.abs(chosen - run.target!)).toBeLessThanOrEqual(0.5);
    }, 900_000);

    test(`${media}: a wheel up — not swallowed, kept`, async (ctx) => {
      const { run } = await runOf(media, "wheelUp", ctx);
      const chosen = takes(run);
      expect(chosen).toBeLessThanOrEqual(run.acted!.top - 250);
    }, 900_000);

    test(`${media}: a reader above the end is not moved by a card, nor by the next text`, async (ctx) => {
      const { run } = await runOf(media, "readerAbove", ctx);
      const off = [...run.samples, ...run.after].filter((s) => Math.abs(s.top - run.away!) > 0.5 || s.atEnd);
      expect(off.map((s) => `${s.t} ms at ${s.top}`)).toEqual([]);
      expect(run.after[run.after.length - 1].isAtBottom).toBe(false);
    }, 900_000);
  }

  test("ArrowUp in the transcript — a line up, kept", async (ctx) => {
    const { run, idle } = await runOf("motion", "ArrowUp", ctx, "ArrowUp");
    const chosen = takes(run);
    expect(Math.abs(chosen - (run.atKey! - idle.ArrowUp))).toBeLessThanOrEqual(3);
  }, 900_000);

  test("Home in the transcript — the top, kept", async (ctx) => {
    const { run } = await runOf("motion", "Home", ctx);
    expect(takes(run)).toBeLessThanOrEqual(0.5);
  }, 900_000);

  test("Shift+Space in the transcript — a page up, kept", async (ctx) => {
    const { run, idle } = await runOf("motion", "ShiftSpace", ctx, "PageUp");
    const chosen = takes(run);
    expect(Math.abs(chosen - (run.atKey! - idle.PageUp))).toBeLessThanOrEqual(3);
  }, 900_000);

  test("PageUp with the focus on the page, after a press in the transcript — a page up, kept", async (ctx) => {
    const { run, idle } = await runOf("motion", "PageUpOnPage", ctx, "PageUp");
    const chosen = takes(run);
    expect(Math.abs(chosen - (run.atKey! - idle.PageUp))).toBeLessThanOrEqual(3);
  }, 900_000);

  test("the app's own smooth jump, which tells the follow first — where it went, kept", async (ctx) => {
    const { run } = await runOf("motion", "appJump", ctx);
    const chosen = takes(run);
    expect(Math.abs(chosen - run.target!)).toBeLessThanOrEqual(1);
  }, 900_000);

  test("a touch dragging the transcript down — not swallowed, kept", async (ctx) => {
    const { run } = await runOf("motion", "touch", ctx);
    expect(takes(run)).toBeLessThanOrEqual(run.acted!.top - 200);
  }, 900_000);

  test("a press on the scrollbar's track above its thumb — not swallowed, kept", async (ctx) => {
    const { run } = await runOf("motion", "scrollbar", ctx);
    expect(takes(run)).toBeLessThanOrEqual(run.acted!.top - 200);
  }, 900_000);

  for (const [name, what] of [
    ["typing", "typing in the composer (a letter, ArrowUp, PageUp in the field)"],
    ["ShiftSpaceOnControl", "Shift+Space on a control in the transcript, which it presses"],
    ["focusInView", "the focus landing on a control in view"],
    ["PageDown", "PageDown in the transcript, toward the end"],
    ["wheelDown", "a wheel down"],
  ] as const) {
    test(`${what} does not stop the follow: at the end, the bubble above the cards`, async (ctx) => {
      const { run } = await runOf("motion", name, ctx);
      keeps(run, "motion");
    }, 900_000);
  }

  // What layout moves is no one's move (lot 31, pass 20): the end shrinking, or the
  // transcript's box growing, pulls the scroll up with the end — and the reserve grows
  // before anyone looks. Held at the end through it, and the next text followed.
  for (const media of ["motion", "reduced"] as const) {
    for (const [name, what] of [
      ["widgetShrinks", "the end shrinking under the reader (a widget reports 387 px instead of 500, laid out before the next frame)"],
      ["aboveShrinks", "a block far above folding (300 px to 187, the scroll anchored up with it)"],
      ["composerShrinks", "the transcript's box growing (the composer cleared by a send, a frame after the card)"],
    ] as const) {
      test(`${media}: ${what} does not stop the follow: at the end, the bubble above the cards, the next text followed`, async (ctx) => {
        const { run } = await runOf(media, name, ctx);
        expect(run.changed).not.toBeNull();
        keeps(run, media);
      }, 900_000);
    }
  }
});

// EVERY SCROLL THE APP MAKES OF THE TRANSCRIPT TELLS THE FOLLOW FIRST. A smooth scroll
// shows no move before the follow's next frame, whose instant scroll to the end would
// cancel it (measured in Chrome): the follow cannot see it coming, it must be told. Each
// programmatic scroll of src/ is listed with the transcript (null: it calls
// `stopReserveFollow` before scrolling, in the same function) or with where it scrolls.
const SRC = join(ROOT, "src");
const SCROLLS: Record<string, string | null> = {
  "src/chat/AgentRequests.tsx › scrollToRequest › scrollTo": null,
  "src/chat/AgentRequests.tsx › scrollToRequest › scrollIntoView": null,
  "src/chat/Bookmarks.tsx › attempt › scrollTo": null,
  "src/chat/Bookmarks.tsx › attempt › scrollIntoView": null,
  "src/chat/ConvexChat.tsx › attempt › scrollIntoView": null,
  "src/chat/SubAgentPanel.tsx › scrollToSpawnMessage › scrollTo": null,
  "src/chat/SubAgentPanel.tsx › scrollToSpawnMessage › scrollIntoView": null,
  "src/chat/threadLanding.ts › frame › scrollTop": null,
  "src/chat/ChatSidebar.tsx › ChatItem › scrollIntoView": "a row of the sidebar's list",
  "src/chat/ConvexChat.tsx › useDictationController › scrollTop": "the composer's field, following dictation",
  "src/chat/GlobalSearch.tsx › GlobalSearch › scrollIntoView": "a result of the search palette",
  "src/chat/ProjectPage.tsx › useLocateRef › scrollIntoView": "a project page's row",
  "src/chat/SubAgentPanel.tsx › SubAgentPanelContent › scrollTo": "the sub-agent panel's own exchange",
  "src/chat/admin/CalendarView.tsx › scrollUnderHead › scrollTop": "the admin calendar",
  "src/chat/admin/ReasoningDefaultsCard.tsx › move › scrollIntoView": "an option of an admin list box",
  "src/chat/admin/ScheduledTab.tsx › ScheduledTab › scrollIntoView": "the admin schedule list",
  "src/chat/queueReserve.ts › toEnd › scrollTo": "the follow itself",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e !== "paraglide") sourceFiles(f, out);
    } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) && !/\.testkit\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(f);
  }
  return out;
}

/** The nearest named function a node is in: a declaration, a method, or a function
 *  given to a variable or a property (an anonymous callback is part of its owner). */
function owner(node: ts.Node): ts.Node | null {
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p;
    if (ts.isFunctionExpression(p) && p.name) return p;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent))) return p;
  }
  return null;
}
function ownerName(fn: ts.Node | null): string {
  if (fn === null) return "<module>";
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
  return "<anonymous>";
}

// `scroll` is `scrollTo` under another name.
const SCROLL_CALLS = new Set(["scroll", "scrollTo", "scrollBy", "scrollIntoView", "scrollIntoViewIfNeeded"]);
type Found = { key: string; at: number; fn: ts.Node | null };
function scrollsOf(file: string): Found[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = relative(ROOT, file).split("\\").join("/");
  const found: Found[] = [];
  const visit = (n: ts.Node) => {
    let what: string | null = null;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SCROLL_CALLS.has(n.expression.name.text)) what = n.expression.name.text;
    if (
      ts.isBinaryExpression(n) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind) &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.name.text === "scrollTop"
    )
      what = "scrollTop";
    if (what !== null) {
      const fn = owner(n);
      found.push({ key: `${rel} › ${ownerName(fn)} › ${what}`, at: n.getStart(sf), fn });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
function callsBefore(fn: ts.Node, name: string, before: number): boolean {
  let seen = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && n.getStart() < before) seen = true;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return seen;
}

describe("every scroll the app makes of the transcript tells the follow first (lot 30)", () => {
  const found = sourceFiles(SRC).flatMap(scrollsOf);

  test("each programmatic scroll of src/ is listed: the transcript, or where it scrolls", () => {
    expect([...new Set(found.map((f) => f.key))].sort()).toEqual(Object.keys(SCROLLS).sort());
  });

  test("each scroll of the transcript calls stopReserveFollow before it, in the same function", () => {
    const missing = found
      .filter((f) => SCROLLS[f.key] === null && (f.fn === null || !callsBefore(f.fn, "stopReserveFollow", f.at)))
      .map((f) => f.key);
    expect(missing).toEqual([]);
  });
});
