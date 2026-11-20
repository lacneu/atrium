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
//   no longer followed them. Nor a pull followed, in the same task, by another block
//   growing below (lot 32, pass 21), laid out as Safari does it, without scroll anchoring:
//   on lot 31 the follow took it for another's move.
// - The follow's window is the clock's, not the frames' (lot 32, pass 21): a frame that
//   comes late lands once, only if no one has moved the transcript, and a scroll past the
//   window is taken back no more. Two seconds of a busy main thread delay the follow's
//   frame past its window; a smooth scroll nothing announces, begun at the end of that
//   task, is kept. On lot 31 the late frame scrolled to the end first and cancelled it.
// - The send and a long task (lot 33): Chrome starts a transition on the frame after the
//   change of style, and dispatches the scroll events a frame has queued before its frame
//   callbacks. The send's commit — the composer's draft cleared, the card queued — then two
//   seconds of a busy main thread: the follow's window opens on its first frame, late,
//   with the transition. A transition running through a long task: Chrome runs the late
//   frame on a stale clock (the pull's scroll event finds the end), lands the rest of the
//   growth on the next frame in one step, and keeps the end there itself. The reserve at
//   rest, the window not yet over, a widget shrinking and another block growing 60 px in the
//   same task, as Safari lays it out, then the long task: the late frame's first scroll event
//   is the pull's, past the window, 60 px short, and the end is landed once — on lot 32 the
//   follow stopped there without a landing, and assistant-ui read the pull as the reader's
//   own move up.
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
import { flushSync } from "react-dom";
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
// Another block at the end of the transcript, below the reply its widget closes, that
// grows from nothing to 60 px in the same task as the widget shrinks, once the shrink is
// laid out (lot 32, pass 21). In the transcript's column, not in the message's row,
// where it would only be as tall as the widget beside it.
let growerOn = false;
let growAfterShrink = false;
let setGrowerHeight = null;
// Two seconds of a busy main thread once the block has grown, in that task (lot 33); the
// attempt's start, for what the late frame finds.
let busyAfterGrow = false;
let attemptT0 = 0;
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
    if (height === 387 && growAfterShrink) {
      // The shrink laid out (the scroll pulled up with the end), then the other block
      // grows, in this task: from where it ends, another's move up.
      void vp().scrollHeight;
      growAfterShrink = false;
      setGrowerHeight(60);
    }
  }, [height]);
  return h("iframe", { ref, className: "oc-widget__frame", title: "widget", sandbox: SIMPLE_FRAME_SANDBOX, referrerPolicy: "no-referrer", srcDoc: WIDGET_DOC, style: { height } });
};
const Grower = () => {
  const [height, setHeight] = useState(0);
  setGrowerHeight = setHeight;
  useLayoutEffect(() => {
    applied("grower:" + height);
    if (height === 60 && busyAfterGrow) {
      busyAfterGrow = false;
      lateWatch(vp(), attemptT0, reserveTransition(vp()));
      busy(2000);
    }
  }, [height]);
  // Never shrunk by the transcript's column, which holds more than it shows.
  return h("div", { className: "oc-probe-grower", style: { height, flex: "none" } });
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
    h(ThreadPrimitive.Viewport, { className: "oc-thread__viewport" }, h(ThreadPrimitive.Messages, { components: { Message } }), h(Tail), growerOn ? h(Grower) : null),
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
  growerOn = setup.grower === true;
  growAfterShrink = false;
  busyAfterGrow = false;
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
    spacer: Math.round(spacer(v) * 100) / 100,
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

// A long task: no frame runs until it ends.
const busy = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // The main thread busy.
  }
};
// The reserve's transition, caught at a change (a finished one leaves getAnimations(),
// the object keeps its start time), and as Chrome holds it at each look: whether it has
// started it (a pending animation has no start time yet), when, where it is, and the
// document's timeline then.
const reserveTransition = (v) => (v.getAnimations ? v.getAnimations({ subtree: true }).find((x) => x.transitionProperty === "height" && x.effect && x.effect.pseudoElement === "::after") : undefined) || null;
const transitionState = (tr) => ({ transition: tr ? { pending: tr.pending, startTime: tr.startTime === null ? null : Math.round(tr.startTime), playState: tr.playState, timeline: Math.round(document.timeline.currentTime) } : null });
// What a late frame finds (lot 33): its first scroll event — where the transcript is, how
// far short of its end, the reserve, and what assistant-ui read of it (its listener on
// the transcript runs before this one) — and, on that frame and the next, the reserve and
// its transition.
let late = null;
const lateWatch = (v, t0, tr) => {
  late = { scroll: null, frames: [] };
  const record = () => Object.assign({ t: Math.round(performance.now() - t0), top: v.scrollTop, short: v.scrollHeight - v.scrollTop - v.clientHeight, spacer: spacer(v), isAtBottom: store.getState().isAtBottom }, transitionState(tr));
  const onScroll = () => {
    v.removeEventListener("scroll", onScroll);
    late.scroll = record();
  };
  v.addEventListener("scroll", onScroll);
  requestAnimationFrame(() => {
    late.frames.push(record());
    requestAnimationFrame(() => late.frames.push(record()));
  });
};

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
  // - the end shrinking, then another block below it growing 60 px in the same task, the
  //   shrink laid out in between (lot 32, pass 21): from where it ends — 60 px short, the
  //   reserve's growth on top —, the pull cannot be told from another's move up; only the
  //   layout, which moved, can tell. As Safari lays it out, with no scroll anchoring:
  //   Chrome's keeps the end where it was as the block grows (measured: the transcript at
  //   its end, 60 px further), and there the follow has nothing to tell apart.
  widgetShrinksAnotherGrows: {
    kind: "keeps",
    widget: true,
    grower: true,
    layout: true,
    run: (v, t0) =>
      change(t0, "grower:60", true, () => {
        v.style.overflowAnchor = "none";
        growAfterShrink = true;
        widgetFrame.contentWindow.postMessage(387, "*");
      }),
  },
  // - a block far above the end folding, 300 px down to 187 (the browser's scroll
  //   anchoring keeps what is shown in place, the scroll up by as much);
  aboveShrinks: { kind: "keeps", block: true, layout: true, run: (v, t0) => change(t0, "block:187", true, () => setTimeout(() => setBlockHeight(187), 0)) },
  // - the transcript's box growing: a frame after the card, the send clears the
  //   composer's draft, four lines down to one.
  composerShrinks: { kind: "keeps", rows: 4, afterFrame: true, layout: true, run: (v, t0) => change(t0, "rows:1", true, () => setTimeout(() => setComposerRows(1), 0)) },
  readerAbove: { kind: "away" },
  // A long task, then a smooth scroll nothing announces (lot 32, pass 21): the reserve's
  // transition over, the follow's window not yet — two seconds of a busy main thread
  // delay its next frame past its window; the scroll begins at the end of that task. On
  // lot 31 that late frame scrolled to the end first, which cancelled the smooth scroll.
  longTaskThenSmooth: {
    kind: "takes",
    window: true,
    run: async (v, t0) => {
      // The reserve at rest: its transition is over.
      let last = spacer(v);
      for (;;) {
        await nextFrame();
        const now = spacer(v);
        if (Math.abs(now - last) < 0.01) break;
        last = now;
      }
      const act = { t: Math.round(performance.now() - t0), top: v.scrollTop, spacer: spacer(v), short: v.scrollHeight - v.scrollTop - v.clientHeight };
      const busy = performance.now() + 2000;
      while (performance.now() < busy) {
        // A long task: no frame runs until it ends.
      }
      v.scrollTo({ top: v.scrollTop - 400, behavior: "smooth" });
      return act;
    },
  },
  // THE SEND AND A LONG TASK (lot 33): two seconds of a busy main thread, in the task of
  // the send.
  // - The send's commit: the composer's draft cleared (four lines down to one: the box
  //   taller, the scroll pulled up with the end) and the card queued, in one commit, in a
  //   task of its own after a frame (an input event's). The follow's first frame comes
  //   late, and Chrome starts the reserve's transition there.
  sendThenLongTask: { kind: "keeps", rows: 4, send: true },
  // - A frame after the card, the send clears the composer: the transition runs through
  //   the long task. Chrome runs the late frame on a stale clock — the reserve where the
  //   task left it, the pull's scroll event at the end —, then lands the rest of the growth
  //   on the next frame in one step, and keeps the end there itself (measured: no script
  //   moved the transcript).
  clearThenLongTask: {
    kind: "keeps",
    rows: 4,
    afterFrame: true,
    layout: true,
    longTask: true,
    run: (v, t0) =>
      change(t0, "rows:1", true, () =>
        setTimeout(() => {
          flushSync(() => setComposerRows(1));
          lateWatch(v, t0, reserveTransition(v));
          busy(2000);
        }, 0),
      ),
  },
  // - The reserve at rest, the follow's window not yet over: the widget closing the reply
  //   shrinks and another block below it grows 60 px in the same task, as Safari lays it out
  //   (no scroll anchoring), then two seconds of a busy main thread in that task. The late
  //   frame's first scroll event is the pull's, past the window, 60 px short of the end.
  pullGrowThenLongTask: {
    kind: "keeps",
    widget: true,
    grower: true,
    layout: true,
    longTask: true,
    atRest: true,
    run: async (v, t0) => {
      // The reserve at rest: its transition is over.
      let last = spacer(v);
      for (;;) {
        await nextFrame();
        const now = spacer(v);
        if (Math.abs(now - last) < 0.01) break;
        last = now;
      }
      const before = { t: Math.round(performance.now() - t0), top: v.scrollTop, max: v.scrollHeight - v.clientHeight };
      busyAfterGrow = true;
      const c = await change(t0, "grower:60", true, () => {
        v.style.overflowAnchor = "none";
        growAfterShrink = true;
        widgetFrame.contentWindow.postMessage(387, "*");
      });
      return Object.assign({ before }, c);
    },
  },
};

// The experiment ran as designed: from the end of the whole thread, and the reader's
// act — its first input as the page received it, else the page's own act — while the
// follow ran: with the reserve still growing, or, under reduced motion (no transition),
// within the follow's 100 ms. A missed precondition is no result, green or red.
function precondition(a, out) {
  const b = out.before;
  if (!(b.atEnd && b.bubbles === 10 && b.overflow)) return { met: false, why: "not at the end of the whole thread: " + JSON.stringify(b) };
  const span = reserve.longestTimeMs(out.transition) + 100;
  // The send's commit (lot 33): the composer cleared, the transcript's box taller (what
  // pulls the scroll up with the end — under reduced motion the follow's first step, at
  // once, may take more back than that), and the long task after it put the next frame
  // past the follow's window, counted from the commit.
  if (a.send) {
    const s = out.sent;
    const f = out.late && out.late.frames[0];
    if (!(s && s.client > s.before.client + 1)) return { met: false, why: "the send did not make the transcript's box taller: " + JSON.stringify(s) };
    if (!(f && f.t - s.t > span)) return { met: false, why: "the next frame came " + (f ? f.t - s.t + " ms" : "never") + " after the send, within " + span + " ms" };
    if (reducedMotion) return s.t < 100 ? { met: true } : { met: false, why: "sent at " + s.t + " ms, past the follow's 100 ms" };
    return s.spacer < out.spacerFinal - 1 ? { met: true } : { met: false, why: "sent with the reserve at " + s.spacer + " px of " + out.spacerFinal };
  }
  // A long task after a change of the layout (lot 33): the change pulled the scroll up,
  // and the next frame came past the follow's window.
  if (a.longTask) {
    const c = out.changed;
    const f = out.late && out.late.frames[0];
    const from = c && c.before ? c.before.top : out.acted && out.acted.top;
    if (!(c && from !== undefined && c.top < from - 1)) return { met: false, why: "the change did not pull the scroll up: " + JSON.stringify({ acted: out.acted, changed: c }) };
    if (!(f && f.t - c.t > span)) return { met: false, why: "the next frame came " + (f ? f.t - c.t + " ms" : "never") + " after the change, within " + span + " ms" };
    // At rest and inside the window, which opens on the follow's first frame (the first
    // sample's): the late frame finds the pull, not the reserve's growth.
    if (a.atRest) {
      const opened = out.samples.length ? out.samples[0].t : 0;
      return c.spacer >= out.spacerFinal - 0.5 && c.t < opened + span
        ? { met: true }
        : { met: false, why: "changed at " + c.t + " ms with the reserve at " + c.spacer + " px of " + out.spacerFinal + ", the window open from " + opened + " ms for " + span };
    }
  }
  if (!a.run) return { met: true };
  // A long task begun inside the follow's window, the reserve at rest: past its
  // transition, short of its window (its longest time and 100 ms).
  if (a.window) {
    const w = out.windowAct;
    return w !== null && w.t < span && w.short <= 1
      ? { met: true }
      : { met: false, why: "the long task began at " + (w ? w.t + " ms, " + w.short.toFixed(1) + " px short of the end" : "no time") + ", the window ending at " + span + " ms" };
  }
  // A change of the layout counts when it is laid out; an input, when the page has it.
  const at = out.sent || out.changed || out.first || out.acted;
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
    windowAct: null,
    sent: null,
    late: null,
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
  attemptT0 = t0;
  // The reader's first input as the page receives it: capture, before anything else.
  const onInput = (e) => {
    if (out.first !== null) return;
    out.first = { type: e.type, t: Math.round(performance.now() - t0), top: vp().scrollTop, spacer: spacer(vp()) };
    if (e.type === "keydown") out.atKey = out.first.top;
  };
  const kinds = ["keydown", "wheel", "pointerdown", "touchstart"];
  for (const type of kinds) addEventListener(type, onInput, true);
  try {
    const card = [{ messageId: "q1", text: "Un message mis en file pendant que l'agent travaille", pending: false, mine: true, canCancel: true }];
    late = null;
    if (a.send) {
      // The send's commit: the composer's draft cleared and the card queued, in one
      // commit, then a long task in that same task (lot 33) — a task of its own after a
      // frame, as an input event's: in a frame callback's continuation, the frame it
      // blocks would be the one that paints the change.
      await nextFrame();
      out.sent = await new Promise((resolve) =>
        setTimeout(() => {
          const before = { top: v.scrollTop, max: v.scrollHeight - v.clientHeight, client: v.clientHeight };
          flushSync(() => {
            setComposerRows(1);
            setQueued(card);
          });
          const tr = reserveTransition(v);
          const sent = Object.assign({ t: Math.round(performance.now() - t0), before, top: v.scrollTop, max: v.scrollHeight - v.clientHeight, client: v.clientHeight, spacer: spacer(v) }, transitionState(tr));
          lateWatch(v, t0, tr);
          busy(2000);
          resolve(sent);
        }, 0),
      );
    } else setQueued(card);
    const sampling = sampleUntilSettled(t0, out.samples);
    if (a.run) {
      if (a.afterFrame) await nextFrame();
      else await sleep(50);
      out.acted = { t: Math.round(performance.now() - t0), top: v.scrollTop, spacer: spacer(v) };
      if (a.target !== undefined) out.target = Math.max(0, v.scrollTop + a.target);
      // A layout change resolves to where it was laid out (scrollTo's promise, in this
      // Chrome, to whether it was interrupted).
      if (a.layout) out.changed = await a.run(v, t0);
      else if (a.window) out.windowAct = await a.run(v, t0);
      else await a.run(v);
    }
    await sampling;
    out.late = late;
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

type Sample = { t: number; top: number; atEnd: boolean; isAtBottom: boolean; lastBottom: number; cardsTop: number | null; spacer: number };
// The reserve's transition as Chrome holds it (lot 33): pending until Chrome starts it.
type TransitionState = { transition: { pending: boolean; startTime: number | null; playState: string; timeline: number } | null };
type LateRecord = { t: number; top: number; short: number; spacer: number; isAtBottom: boolean } & TransitionState;
type Run = {
  name: string;
  kind: "keeps" | "takes" | "away";
  before: { atEnd: boolean; bubbles: number; overflow: boolean };
  transition: string;
  samples: Sample[];
  after: Sample[];
  acted: { t: number; top: number; spacer: number } | null;
  first: { type: string; t: number; top: number; spacer: number } | null;
  // A change of the layout the experiment made, as it was laid out (and, when the
  // experiment says so, where the transcript stood before it).
  changed: { t: number; top: number; max: number; spacer: number; before?: { t: number; top: number; max: number } } | null;
  // A long task the experiment began inside the follow's window, the reserve at rest.
  windowAct?: { t: number; top: number; spacer: number; short: number } | null;
  // The send's commit (lot 33): where the transcript stood before and after it, the reserve.
  sent?: ({ t: number; before: { top: number; max: number; client: number }; top: number; max: number; client: number; spacer: number } & TransitionState) | null;
  // What the late frame found after a long task (lot 33).
  late?: { scroll: LateRecord | null; frames: LateRecord[] } | null;
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

// A transcript, a document and a window, enough for the follow's own logic (Chrome runs
// the real one below), in Chrome's order (lot 33): every change of the transcript's scroll
// position — a scrollTo, the layout's clamp, another's move — queues one scroll event,
// which the next frame dispatches before its frame callbacks, at the document's listeners
// first (the capture phase), then at the transcript's own. The reserve's height readable,
// the scroll height a whole number, as the browser reports it — and, `fractional`, the
// scroll positions in fractions of a pixel, to the exact end, as a zoomed page lays them
// out.
// `scale`, Blink's own clamp (lot 37): it bounds the scroll with the content's and the
// box's heights rounded in physical pixels — the page's zoom times the screen's density —,
// then reports the position in CSS pixels.
function fakeDom(geometry: { top: number; height: number; client: number }, transition = "0.2s", fractional = false, scale = 0) {
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
    devicePixelRatio: scale || 1,
    getComputedStyle: () => ({
      transitionDuration: transition,
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
  // The content's exact height, the reserve's included; where the transcript is scrolled;
  // whether a scroll event waits for the next frame.
  let height = geometry.height;
  let top = geometry.top;
  let queued = false;
  // The box's exact height; its client height is a whole number, as the browser reports it.
  let box = geometry.client;
  const viewport = {
    ownerDocument: doc,
    get clientHeight() {
      return Math.round(box);
    },
    set clientHeight(v: number) {
      box = v;
    },
    get scrollHeight() {
      return Math.round(height);
    },
    get scrollTop() {
      return top;
    },
    // Clamped as the browser clamps it; a change queues the scroll event.
    set scrollTop(v: number) {
      const end = scale ? (Math.round(height * scale) - Math.round(box * scale)) / scale : fractional ? height - box : this.scrollHeight - this.clientHeight;
      const next = Math.max(0, Math.min(v, end));
      if (next === top) return;
      top = next;
      queued = true;
    },
    contains: (el: unknown) => inside.has(el),
    getBoundingClientRect: () => ({ top: 0, bottom: geometry.client }),
    scrollTo(o: { top: number }) {
      scrolls++;
      this.scrollTop = o.top;
    },
    ...on("vp"),
  };
  const dispatch = (target: "vp" | "doc", type: string, e: Record<string, unknown>) => {
    const ev = target === "vp" ? { target: viewport, ...e } : e;
    for (const f of [...(listeners.get(`doc:${type}`) ?? [])]) f(ev);
    if (target === "vp") for (const f of [...(listeners.get(`vp:${type}`) ?? [])]) f(ev);
  };
  return {
    viewport,
    doc,
    inside,
    scrolls: () => scrolls,
    short: () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
    // An event other than a scroll, dispatched at the transcript or the document: the
    // document's listeners first. A scroll event is the browser's, with the next frame.
    fire: (target: "vp" | "doc", type: string, e: Record<string, unknown> = {}) => {
      if (type === "scroll") throw new Error("a scroll event comes with the next frame, from the queue");
      dispatch(target, type, e);
    },
    // The reserve's spacer grows — its transition, at the start of a frame — and the
    // transcript's content with it.
    grow: (px: number) => {
      reserve += px;
      height += px;
    },
    // A layout: the content shrinking under the end, or the transcript's box growing —
    // the scroll pulled up with the end, as the browser clamps it.
    shrinkEnd: (px: number) => {
      height -= px;
      viewport.scrollTop = top;
    },
    growBox: (px: number) => {
      viewport.clientHeight += px;
      viewport.scrollTop = top;
    },
    // Content growing at the end (another widget, a block that unfolds), and the box
    // shrinking (the keyboard opening, the composer growing): the scroll stays.
    // The box growing by a fraction of a pixel (a zoomed page, the composer's line): its
    // client height may read the same; the scroll is pulled up all the same.
    growBoxExact: (px: number) => {
      box += px;
      viewport.scrollTop = top;
    },
    growContent: (px: number) => {
      height += px;
    },
    shrinkBox: (px: number) => {
      viewport.clientHeight -= px;
    },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    // The next frame, `ms` later: the scroll event queued since the last one, dispatched
    // first; then, when given, what another does on that frame after its scroll events — a
    // frame callback of its own asked for before the follow's, a transitionend listener —;
    // then the frame callbacks asked for.
    frame: (ms = 16, others?: () => void) => {
      now += ms;
      if (queued) {
        queued = false;
        dispatch("vp", "scroll", {});
      }
      others?.();
      const due = [...frames.values()];
      frames.clear();
      for (const f of due) f();
    },
    // Time passing with no frame (a long task, a hidden tab).
    tick: (ms: number) => {
      now += ms;
    },
    pending: () => frames.size,
  };
}

// assistant-ui's reading of the transcript (useThreadViewportAutoScroll), its own intent
// to scroll to the end aside — it has none during a turn: on a scroll event, at its
// listener on the transcript — after the follow's, on the document —, at the end within
// 1 px; a scroll down short of the end is not read; else what it reads is its store's.
// And the next text, as its observers answer it: followed to the end only if it reads the
// reader there.
function assistantUi(dom: ReturnType<typeof fakeDom>) {
  const vp = dom.viewport;
  const state = { isAtBottom: true };
  const reads: boolean[] = [];
  let lastTop = vp.scrollTop;
  vp.addEventListener("scroll", () => {
    const at = Math.abs(vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= 1 || vp.scrollHeight <= vp.clientHeight;
    if (at || lastTop >= vp.scrollTop) state.isAtBottom = at;
    reads.push(at);
    lastTop = vp.scrollTop;
  });
  return {
    store: { getState: () => state },
    reads,
    nextText: (px: number) => {
      dom.growContent(px);
      if (state.isAtBottom) vp.scrollTo({ top: vp.scrollHeight });
    },
  };
}

const el = (kind: "plain" | "field" | "control" = "plain") => ({
  nodeType: 1,
  closest: (sel: string) =>
    (kind === "field" && sel.includes("textarea")) || (kind === "control" && sel.includes("button")) ? {} : null,
  getBoundingClientRect: () => ({ top: 10, bottom: 50 }),
});

// Where the follow first sees a change: in the scroll event the next frame dispatches
// first, the change made in a task between two frames — or in its frame callback, the
// change made on that frame after its scroll events (another's frame callback, asked for
// before the follow's; a transitionend listener).
const SEEN = ["in its scroll event, first on the next frame", "made on the frame after its scroll events, in its step"] as const;

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
    for (let i = 0; i < 7; i++) {
      dom.grow(10); // the spacer grows
      dom.frame(50);
      expect(vp.scrollTop).toBe(vp.scrollHeight - vp.clientHeight);
    }
    // 350 ms: the window — the transition (200) and its margin (100), from the first
    // frame (50) — is over.
    expect(dom.pending()).toBe(0);
    expect(dom.listening()).toBe(0);
  });

  const reader: Array<[string, (dom: ReturnType<typeof fakeDom>) => void, "on the frame"?]> = [
    ["a pointer on the transcript", (d) => d.fire("vp", "pointerdown")],
    ["a touch on it", (d) => d.fire("vp", "touchstart")],
    ["a wheel up on it", (d) => d.fire("vp", "wheel", { deltaY: -40 })],
    ["PageUp on the page", (d) => d.fire("doc", "keydown", { key: "PageUp", shiftKey: false, target: d.doc.body })],
    ["the focus landing above the box", (d) => d.fire("vp", "focusin", { target: { nodeType: 1, getBoundingClientRect: () => ({ top: -80, bottom: -40 }) } })],
    [
      "a move up it did not make, seen in its scroll event, first on the next frame",
      (d) => {
        d.viewport.scrollTop -= 200;
      },
    ],
    [
      "a move up it did not make, made on the frame after its scroll events, seen in its step",
      (d) => {
        d.viewport.scrollTop -= 200;
      },
      "on the frame",
    ],
    ["the app, before it scrolls the transcript", (d) => stopReserveFollow(d.viewport as unknown as HTMLElement)],
  ];
  for (const [what, act, when] of reader) {
    test(`it stops for good, and scrolls no more, on ${what}`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      dom.grow(10);
      dom.frame();
      if (when === "on the frame") dom.frame(16, () => act(dom));
      else act(dom);
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

  const notReader: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["a wheel down", (d) => d.fire("vp", "wheel", { deltaY: 40 })],
    ["PageDown in the transcript", (d) => d.fire("doc", "keydown", { key: "PageDown", shiftKey: false, target: d.doc.body })],
    ["the focus landing in view", (d) => d.fire("vp", "focusin", { target: { nodeType: 1, getBoundingClientRect: () => ({ top: 40, bottom: 80 }) } })],
    ["the end shrinking, the scroll pulled up with it", (d) => d.shrinkEnd(30)],
  ];
  for (const [what, act] of notReader) {
    test(`it keeps holding the end on ${what}`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      dom.grow(10);
      dom.frame();
      act(dom);
      dom.grow(10);
      dom.frame();
      expect(vp.scrollTop).toBe(vp.scrollHeight - vp.clientHeight);
    });
  }

  // What the layout moves is no one's move (lot 31, pass 20): pulled up with the end, at
  // the end, before the next frame — then the reserve grows at the start of that frame,
  // before the follow looks: in the scroll event of the pull, which that frame dispatches
  // first. Or the pull made on the frame, after the reserve has grown and the frame's
  // scroll events: its step finds the end.
  const layouts: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["the end shrinking (a widget, 100 px)", (d) => d.shrinkEnd(100)],
    ["the transcript's box growing (the composer, 72 px)", (d) => d.growBox(72)],
  ];
  for (const [what, pull] of layouts) {
    for (const seen of SEEN) {
      test(`it keeps holding the end through ${what}, the reserve grown before it looks — ${seen} (lots 31, 33)`, () => {
        const dom = fakeDom({ top: 500, height: 1000, client: 500 });
        followReserve(dom.viewport as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
        dom.grow(10);
        dom.frame();
        if (seen === SEEN[0]) {
          pull(dom);
          expect(dom.short()).toBe(0);
          dom.grow(4);
          expect(dom.short()).toBe(4);
          dom.frame();
        } else {
          dom.grow(4);
          dom.frame(16, () => pull(dom));
        }
        expect(dom.short()).toBe(0);
        for (let i = 0; i < 6; i++) {
          dom.grow(5);
          dom.frame(50);
          expect(dom.short()).toBe(0);
        }
        // Its window ran out, not its patience.
        expect(dom.pending()).toBe(0);
        expect(dom.listening()).toBe(0);
      });
    }
  }

  test("assistant-ui, its listener on the transcript reading after the follow's, reads the reader at the end through the layout's pull (lot 31)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const aui = assistantUi(dom);
    followReserve(dom.viewport as unknown as HTMLElement, aui.store);
    dom.grow(10);
    dom.frame();
    dom.shrinkEnd(100);
    dom.grow(4);
    dom.frame();
    expect(aui.reads).toEqual([true]);
    expect(aui.store.getState().isAtBottom).toBe(true);
  });

  // Two changes before the follow looks (lot 32, pass 21): pulled up with the end, then
  // content growing below it, or the box changing besides — from where it all ends, the
  // position and the height of another's move up. Only the layout tells them apart: it
  // moved, so the move is its own, taken back. The reserve grows at the start of a frame.
  const twice: Array<[string, (dom: ReturnType<typeof fakeDom>) => void, number]> = [
    ["a widget shrinking 113 px, then another growing 60 and the reserve 4", (d) => (d.shrinkEnd(113), d.growContent(60)), 4],
    ["another widget growing 60 px, then one shrinking 113, and the reserve 4", (d) => (d.growContent(60), d.shrinkEnd(113)), 4],
    ["a widget shrinking 113 px as the keyboard opens 100 px, and the reserve 4", (d) => (d.shrinkEnd(113), d.shrinkBox(100)), 4],
    ["the composer cleared (the box 72 px taller), then a widget growing 60, and the reserve 4", (d) => (d.growBox(72), d.growContent(60)), 4],
    ["the keyboard closing (the box 260 px taller), then a widget growing 60", (d) => (d.growBox(260), d.growContent(60)), 0],
  ];
  for (const [what, changes, reserveGrew] of twice) {
    for (const seen of SEEN) {
      test(`it keeps holding the end through ${what} — ${seen} (lots 32-33)`, () => {
        const dom = fakeDom({ top: 500, height: 1000, client: 500 });
        followReserve(dom.viewport as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
        dom.grow(10);
        dom.frame();
        if (seen === SEEN[0]) {
          changes(dom);
          dom.grow(reserveGrew);
          expect(dom.short()).toBeGreaterThan(1);
          dom.frame();
        } else {
          // The reserve grows at the start of the frame, the changes come after: what ends
          // in a pull ends at the end — pulled up all the same.
          dom.grow(reserveGrew);
          dom.frame(16, () => {
            const before = dom.viewport.scrollTop;
            changes(dom);
            expect(dom.viewport.scrollTop).toBeLessThan(before);
          });
        }
        expect(dom.short()).toBe(0);
        for (let i = 0; i < 6; i++) {
          dom.grow(5);
          dom.frame(50);
          expect(dom.short()).toBe(0);
        }
        expect(dom.pending()).toBe(0);
        expect(dom.listening()).toBe(0);
      });
    }
  }

  // Another's move up with the layout as the follow left it — the reserve may have grown
  // meanwhile, it is set aside — is another's: the follow stops for good (lot 32).
  for (const reserveGrew of [0, 4]) {
    for (const seen of SEEN) {
      test(`a move up another makes, the layout as the follow left it and the reserve grown ${reserveGrew} px, stops it for good — ${seen} (lots 32-33)`, () => {
        const dom = fakeDom({ top: 500, height: 1000, client: 500 });
        const vp = dom.viewport;
        followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
        dom.grow(10);
        dom.frame();
        dom.grow(reserveGrew);
        if (seen === SEEN[0]) {
          vp.scrollTop -= 8;
          dom.frame();
        } else {
          dom.frame(16, () => {
            vp.scrollTop -= 8;
          });
        }
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
  }

  // Where the follow leaves the transcript, it notes the layout then (lots 31-33): after a
  // change of the layout it took back, the layout it holds is the new one, and another's
  // move up, the layout held since, is another's.
  const changes: Array<[string, (dom: ReturnType<typeof fakeDom>) => void]> = [
    ["the composer cleared (the box 72 px taller)", (d) => d.growBox(72)],
    ["a widget shrinking 100 px", (d) => d.shrinkEnd(100)],
  ];
  for (const [what, change] of changes) {
    test(`after ${what}, taken back, a move up another makes — the layout held since — stops the follow for good (lots 31-33)`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 });
      const vp = dom.viewport;
      followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
      dom.grow(10);
      dom.frame();
      change(dom);
      dom.grow(4);
      dom.frame();
      expect(dom.short()).toBe(0);
      dom.grow(4);
      vp.scrollTop -= 8;
      dom.frame();
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

  // What the rule costs, declared (lot 32): a move another makes in the same interval as
  // a change of the layout cannot be told from the layout's own pull — it is taken back.
  test("a move up another makes in the same interval as a change of the layout is taken back, the follow going on (lot 32)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    dom.shrinkEnd(100);
    dom.grow(4);
    vp.scrollTop -= 8;
    dom.frame();
    expect(dom.short()).toBe(0);
    expect(dom.listening()).toBeGreaterThan(0);
  });

  // WHAT THE CONTENT LOSES AT THE END PULLS THE SCROLL UP AS MUCH (lot 33): a move up is
  // another's only beyond that, and a pixel — the pull and the loss as the follow reads
  // it, each off a whole scroll height, differ by less than one. assistant-ui has read
  // where the follow left the transcript (a frame between), so that a pull is a move up
  // to it too.
  test("a pull of a pixel — the content a pixel shorter at the end, the reserve 4 px taller since — is the layout's: taken back, and assistant-ui reads the reader at the end (lot 33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const aui = assistantUi(dom);
    followReserve(dom.viewport as unknown as HTMLElement, aui.store);
    dom.grow(10);
    dom.frame();
    dom.frame();
    dom.shrinkEnd(1);
    dom.grow(4);
    expect(dom.short()).toBe(4);
    dom.frame();
    expect(dom.short()).toBe(0);
    expect(aui.store.getState().isAtBottom).toBe(true);
    expect(dom.listening()).toBeGreaterThan(1);
  });

  test("…and so is it with the reserve's height fractional and the scroll height a whole number: a pull of a pixel against a loss read as 0.2 px (lot 33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    const aui = assistantUi(dom);
    followReserve(vp as unknown as HTMLElement, aui.store);
    dom.grow(10.4);
    dom.frame();
    dom.frame();
    expect(vp.scrollTop).toBe(510);
    dom.shrinkEnd(1);
    dom.grow(4.2);
    expect(vp.scrollTop).toBe(509);
    dom.frame();
    expect(dom.short()).toBe(0);
    expect(aui.store.getState().isAtBottom).toBe(true);
    expect(dom.listening()).toBeGreaterThan(1);
  });

  test("…and so is a pull of more than a pixel within what the content lost and a pixel, the scroll positions in fractions of a pixel (a zoomed page): 1.2 px against a loss read as 0.8 (lot 33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 }, "0.2s", true);
    const vp = dom.viewport;
    const aui = assistantUi(dom);
    followReserve(vp as unknown as HTMLElement, aui.store);
    dom.grow(10.4);
    dom.frame();
    dom.frame();
    expect(vp.scrollTop).toBeCloseTo(510.4, 6);
    dom.shrinkEnd(1.2);
    dom.grow(1.8);
    expect(vp.scrollTop).toBeCloseTo(509.2, 6);
    expect(dom.short()).toBeCloseTo(1.8, 6);
    dom.frame();
    expect(Math.abs(dom.short())).toBeLessThanOrEqual(0.5);
    expect(aui.store.getState().isAtBottom).toBe(true);
    expect(dom.listening()).toBeGreaterThan(1);
  });

  test("a move up another makes past what the content lost, and a pixel, is still another's: it stops the follow for good, and assistant-ui reads the reader away from the end (lot 33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    const aui = assistantUi(dom);
    followReserve(vp as unknown as HTMLElement, aui.store);
    dom.grow(10);
    dom.frame();
    dom.frame();
    dom.shrinkEnd(1);
    dom.grow(4);
    vp.scrollTop -= 8;
    dom.frame();
    const top = vp.scrollTop;
    const scrolls = dom.scrolls();
    dom.grow(10);
    dom.frame();
    dom.frame();
    expect(vp.scrollTop).toBe(top);
    expect(dom.scrolls()).toBe(scrolls);
    expect(dom.listening()).toBe(1);
    expect(aui.store.getState().isAtBottom).toBe(false);
  });

  // THE WINDOW IS THE CLOCK'S (lots 32-33), not the frames': the transition and 100 ms from
  // the follow's first frame. Past it, a frame that comes late — a long task, a hidden tab
  // — lands once at most, in the scroll event it dispatches first or in its step, then
  // stops.
  test("a frame 2 s late lands the reserve's last growth once — in the scroll event it dispatches first, the follow's own last scroll's —, no one having moved, and stops (lots 32-33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    dom.grow(4);
    const scrolls = dom.scrolls();
    dom.frame(2000);
    expect(vp.scrollHeight - vp.scrollTop - vp.clientHeight).toBe(0);
    expect(dom.scrolls()).toBe(scrolls + 1);
    expect(dom.pending()).toBe(0);
    expect(dom.listening()).toBe(0);
  });

  test("a frame 2 s late, with no scroll event before it — the follow's last scroll moved nothing —, lands the reserve's growth once in its step, and stops (lots 32-33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    followReserve(dom.viewport as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    // The first frame: the transition starts there, at its first value.
    dom.frame();
    dom.grow(80);
    const scrolls = dom.scrolls();
    dom.frame(2000);
    expect(dom.short()).toBe(0);
    expect(dom.scrolls()).toBe(scrolls + 1);
    expect(dom.pending()).toBe(0);
    expect(dom.listening()).toBe(0);
  });

  test("a frame 2 s late, the transcript at its end, scrolls nothing — a smooth scroll begun meanwhile goes on — and stops (lot 32)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    const scrolls = dom.scrolls();
    // 2250 ms in all, as Codex reproduced it: no frame in between.
    dom.frame(2234);
    expect(dom.scrolls()).toBe(scrolls);
    expect(dom.pending()).toBe(0);
    expect(dom.listening()).toBe(0);
  });

  test("a frame 2 s late, after another moved the transcript down during the long task, the layout held, stops without a scroll (lots 32-33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    dom.grow(20);
    // Down, toward the end: never another's move up, and short of the end all the same.
    vp.scrollTop += 10;
    const top = vp.scrollTop;
    const scrolls = dom.scrolls();
    dom.frame(2000);
    expect(vp.scrollTop).toBe(top);
    expect(dom.scrolls()).toBe(scrolls);
    expect(dom.listening()).toBe(0);
  });

  test("the scroll event of a pull, past the window, lands the end once and stops the follow: assistant-ui reads the reader at the end, and the next text follows them (lot 33)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const aui = assistantUi(dom);
    followReserve(dom.viewport as unknown as HTMLElement, aui.store);
    dom.grow(10);
    dom.frame();
    dom.frame();
    // A long task; a widget shrinking during it, the scroll pulled up with the end; the
    // reserve's last growth at the start of the late frame.
    dom.tick(400);
    dom.shrinkEnd(100);
    dom.grow(4);
    const scrolls = dom.scrolls();
    dom.frame();
    expect(dom.short()).toBe(0);
    expect(dom.scrolls()).toBe(scrolls + 1);
    expect(dom.listening()).toBe(1);
    expect(aui.store.getState().isAtBottom).toBe(true);
    aui.nextText(30);
    expect(dom.short()).toBe(0);
  });

  // WHAT THE BROWSER ROUNDS (lot 36): the scroll height and the box's client height are
  // whole numbers, the scroll position is not. A pull of the layout can pass what the
  // content is read to have lost by up to two pixels — one for the loss, read off two
  // rounded scroll heights, one for a growth of the box its client height does not show.
  // Codex's case (pass 24): the content 1.6 px shorter and the box 0.8 px taller pull the
  // scroll 2.4 px up, against a loss read as 1 px and a client height unchanged — lot 35
  // read another's move up, and stopped with assistant-ui reading the reader away.
  test.each([
    ["within the window", 0],
    ["past the window", 400],
  ])("%s, a pull of 2.4 px — the content 1.6 px shorter, the box 0.8 px taller, its client height the same — is the layout's: taken back, assistant-ui reads the reader at the end, and the next text follows them (lot 36)", (_when, wait) => {
    const dom = fakeDom({ top: 468.8, height: 968.4, client: 499.6 }, "0.2s", true);
    const vp = dom.viewport;
    const aui = assistantUi(dom);
    followReserve(vp as unknown as HTMLElement, aui.store);
    dom.grow(32);
    dom.frame();
    dom.frame();
    expect(vp.scrollTop).toBeCloseTo(500.8, 6);
    expect(vp.clientHeight).toBe(500);
    dom.tick(wait);
    dom.shrinkEnd(1.6);
    dom.growBoxExact(0.8);
    dom.grow(4);
    expect(vp.clientHeight).toBe(500);
    expect(vp.scrollTop).toBeCloseTo(498.4, 6);
    dom.frame();
    expect(Math.abs(dom.short())).toBeLessThanOrEqual(1);
    expect(aui.store.getState().isAtBottom).toBe(true);
    aui.nextText(30);
    expect(Math.abs(dom.short())).toBeLessThanOrEqual(1);
  });

  // WHAT BLINK ROUNDS TOO (lot 37): the end of the scroll, bounded with heights rounded in
  // physical pixels. Codex's case (pass 25), a page at 125 %: the content 0.825 px shorter
  // and the box 0.4 px taller move the end 2.4 px up, against a loss read as 0.2 px and a
  // client height unchanged — past lot 36's two pixels, which counted CSS pixels only.
  test.each([
    ["within the window", 0],
    ["past the window", 400],
  ])("%s, on a page zoomed to 1.25, a pull of 2.4 px against a loss read as 0.2 px — the end of the scroll rounded in physical pixels — is the layout's: taken back, assistant-ui reads the reader at the end, and the next text follows them (lot 37)", (_when, wait) => {
    const dom = fakeDom({ top: 268.4, height: 568.4125, client: 300.0125 }, "0.2s", true, 1.25);
    const vp = dom.viewport;
    const aui = assistantUi(dom);
    followReserve(vp as unknown as HTMLElement, aui.store);
    dom.grow(32);
    dom.frame();
    dom.frame();
    expect(vp.scrollTop).toBeCloseTo(300.8, 6);
    dom.tick(wait);
    dom.shrinkEnd(0.825);
    dom.growBoxExact(0.4);
    expect(vp.scrollTop).toBeCloseTo(298.4, 6);
    dom.grow(4.2);
    expect(vp.clientHeight).toBe(300);
    dom.frame();
    // At the end as Blink bounds it: a scroll further down moves nothing. (What is read
    // short of it there — whole heights against a position in physical pixels — can pass
    // a pixel at the very end.)
    const atEnd = () => {
      const top = vp.scrollTop;
      vp.scrollTop = top + 100;
      return vp.scrollTop === top;
    };
    expect(atEnd()).toBe(true);
    expect(dom.listening()).toBeGreaterThan(0);
    aui.nextText(30);
    expect(atEnd()).toBe(true);
  });

  test("a move up another makes past what the browser rounds — 4.5 px on a page at its own size, the layout held — is still another's: it stops the follow for good (lot 37)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom: true }) });
    dom.grow(10);
    dom.frame();
    dom.frame();
    vp.scrollTop -= 4.5;
    dom.frame();
    const scrolls = dom.scrolls();
    dom.grow(10);
    dom.frame();
    expect(dom.scrolls()).toBe(scrolls);
    expect(dom.listening()).toBe(0);
  });

  // A PULL WITHIN THE TOLERANCE, PAST THE WINDOW (lot 35): the content a pixel shorter
  // is the layout "held" as the follow reads it, and the transcript no longer
  // where the follow left it. Not another's move up — no further than the loss and a pixel
  // —, so the layout's, and landed as within the window: lot 33 skipped the landing and
  // stopped, and assistant-ui read the reader away from the end for good.
  test("the scroll event of a pull of a pixel, past the window, the reserve 4 px taller since, lands the end once and stops: assistant-ui reads the reader at the end, and the next text follows them (lot 35)", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const aui = assistantUi(dom);
    followReserve(dom.viewport as unknown as HTMLElement, aui.store);
    dom.grow(10);
    dom.frame();
    dom.frame();
    dom.tick(400);
    dom.shrinkEnd(1);
    dom.grow(4);
    const scrolls = dom.scrolls();
    dom.frame();
    expect(dom.short()).toBeLessThanOrEqual(1);
    expect(dom.scrolls()).toBe(scrolls + 1);
    expect(aui.store.getState().isAtBottom).toBe(true);
    aui.nextText(30);
    expect(dom.short()).toBeLessThanOrEqual(1);
  });

  // THE SEND AND A LONG TASK (lot 33), in Chrome's order: a transition starts on the frame
  // after the change of style, and a frame dispatches the scroll events queued before it
  // ahead of its callbacks. Under reduced motion the reserve has no transition: it is
  // whole at once, and the follow's first step, at once, holds the end. (A transition that
  // runs through a long task is not grown on the late frame: Chrome runs it on a stale
  // clock, and lands the rest of its growth on the next frame — measured; what grows
  // before the late frame looks is other content.)
  for (const media of ["motion", "reduced"] as const) {
    test(`${media}: the reserve at rest, the window not yet over, a widget shrinks and another block grows 60 px in the same task, then a long task: the late frame's first scroll event, the pull's, lands the end once; assistant-ui reads the reader at the end, and the next text follows them (lot 33)`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 }, media === "motion" ? "0.2s" : "0s");
      const aui = assistantUi(dom);
      if (media === "reduced") dom.grow(80);
      followReserve(dom.viewport as unknown as HTMLElement, aui.store);
      // The first frame opens the window; under motion, the transition runs to its end
      // inside it (16 + 200 ms, the window 316).
      dom.frame();
      if (media === "motion") {
        for (let i = 0; i < 4; i++) {
          dom.grow(20);
          dom.frame(50);
        }
      }
      // assistant-ui reads where the follow left the transcript.
      dom.frame();
      // A task: the widget shrinks, the scroll pulled up with the end, another block grows
      // below it; then the long task.
      dom.shrinkEnd(113);
      dom.growContent(60);
      dom.tick(2000);
      dom.frame();
      expect(dom.short()).toBe(0);
      expect(aui.store.getState().isAtBottom).toBe(true);
      expect(dom.listening()).toBe(1);
      aui.nextText(30);
      expect(dom.short()).toBe(0);
    });

    test(`${media}: the send's commit — the composer cleared, the scroll pulled up with the end, and the card queued — then a long task: the follow's window opens on its first frame, late, where the transition starts; it holds the end through it, assistant-ui reads the reader at the end, and the next text follows them (lot 33)`, () => {
      const dom = fakeDom({ top: 500, height: 1000, client: 500 }, media === "motion" ? "0.2s" : "0s");
      const aui = assistantUi(dom);
      dom.growBox(72);
      if (media === "reduced") dom.grow(80);
      followReserve(dom.viewport as unknown as HTMLElement, aui.store);
      dom.tick(2000);
      dom.frame();
      expect(dom.short()).toBe(0);
      // The transition, from the late frame on.
      if (media === "motion") {
        for (let i = 0; i < 8; i++) {
          dom.grow(10);
          dom.frame(25);
          expect(dom.short()).toBe(0);
        }
      }
      for (let i = 0; i < 25 && dom.pending() > 0; i++) dom.frame();
      expect(dom.pending()).toBe(0);
      expect(dom.listening()).toBe(1);
      expect(aui.store.getState().isAtBottom).toBe(true);
      aui.nextText(30);
      expect(dom.short()).toBe(0);
    });
  }

  test("assistant-ui reading the reader away from the end stops it; a new follow ends the one under way", () => {
    const dom = fakeDom({ top: 500, height: 1000, client: 500 });
    const vp = dom.viewport;
    let isAtBottom = true;
    followReserve(vp as unknown as HTMLElement, { getState: () => ({ isAtBottom }) });
    isAtBottom = false;
    dom.grow(10);
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
  "widgetShrinksAnotherGrows",
  "aboveShrinks",
  "composerShrinks",
  "readerAbove",
  "longTaskThenSmooth",
  "sendThenLongTask",
  "clearThenLongTask",
  "pullGrowThenLongTask",
];
const REDUCED = ["untouched", "PageUp", "focusAbove", "scriptInstant", "wheelUp", "widgetShrinks", "widgetShrinksAnotherGrows", "aboveShrinks", "composerShrinks", "readerAbove", "longTaskThenSmooth", "sendThenLongTask", "clearThenLongTask", "pullGrowThenLongTask"];

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
        // The send and its long task (lot 33): what the commit and the late frame found.
        ...(r.sent || r.late ? { sent: r.sent ?? null, late: r.late ?? null, firstSamples: r.samples.slice(0, 16) } : {}),
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
      ["widgetShrinksAnotherGrows", "the end shrinking, then another block below it growing 60 px in the same task (lot 32, pass 21)"],
      ["aboveShrinks", "a block far above folding (300 px to 187, the scroll anchored up with it)"],
      ["composerShrinks", "the transcript's box growing (the composer cleared by a send, a frame after the card)"],
    ] as const) {
      test(`${media}: ${what} does not stop the follow: at the end, the bubble above the cards, the next text followed`, async (ctx) => {
        const { run } = await runOf(media, name, ctx);
        expect(run.changed).not.toBeNull();
        // The block grows in a task between two frames: the page's sampler, first on the
        // next frame, sees what the follow takes back on that same frame, before it is
        // painted. That one is judged once the transcript has settled, in both runs.
        keeps(run, name === "widgetShrinksAnotherGrows" ? "motion" : media);
      }, 900_000);
    }
  }

  // THE FOLLOW'S WINDOW IS THE CLOCK'S (lot 32, pass 21): two seconds of a busy main thread,
  // begun inside the window with the reserve at rest, delay the follow's next frame past
  // it; a smooth scroll nothing announces begins at the end of that task. The late frame
  // does not take it back: the position it reaches is kept, and assistant-ui reads the
  // reader away from the end. On lot 31 the late frame scrolled to the end first.
  for (const media of ["motion", "reduced"] as const) {
    test(`${media}: a long task, then a smooth scroll nothing announces — the late frame does not take it back (lot 32)`, async (ctx) => {
      const { run } = await runOf(media, "longTaskThenSmooth", ctx);
      expect(run.windowAct).not.toBeNull();
      takes(run);
    }, 900_000);
  }

  // THE SEND AND A LONG TASK (lot 33): Chrome starts a transition on the frame after the
  // change of style, and dispatches the scroll events a frame has queued before its frame
  // callbacks. Two seconds of a busy main thread, in the task of the send.
  for (const media of ["motion", "reduced"] as const) {
    test(`${media}: the send's commit — the composer cleared and the card queued — then a long task: the follow's window opens on its first frame, late, with the reserve's transition; at the end, the bubble above the cards, the next text followed (lot 33)`, async (ctx) => {
      const { run } = await runOf(media, "sendThenLongTask", ctx);
      expect(run.sent).not.toBeNull();
      keeps(run, media);
    }, 900_000);

    test(`${media}: a frame after the card, the send clears the composer, then a long task: Chrome's late frame on a stale clock — the pull's scroll event at the end, assistant-ui reading the reader there —, the rest of the growth on the next frame; at the end, the bubble above the cards, the next text followed (lot 33)`, async (ctx) => {
      const { run } = await runOf(media, "clearThenLongTask", ctx);
      expect(run.changed).not.toBeNull();
      expect(run.late?.scroll?.isAtBottom).toBe(true);
      keeps(run, media);
    }, 900_000);

    test(`${media}: the reserve at rest, the window not yet over, a widget shrinks and another block grows 60 px in the same task, as Safari lays it out, then a long task: the late frame's first scroll event, the pull's, lands the end once — assistant-ui reads the reader at the end; at the end, the bubble above the cards, the next text followed (lot 33)`, async (ctx) => {
      const { run } = await runOf(media, "pullGrowThenLongTask", ctx);
      expect(run.changed).not.toBeNull();
      expect(run.late?.scroll?.isAtBottom).toBe(true);
      // The block grows in a task: as with the widget and the block above, judged once the
      // transcript has settled, in both runs.
      keeps(run, "motion");
    }, 900_000);
  }

  // What the window's opening rests on, measured (lot 33): Chrome starts the reserve's
  // transition on the frame after the change of style, not at it. After the send's commit
  // and its long task, the transition is pending at the commit and still on the late
  // frame's callbacks, at its first value there; by the next frame Chrome has started it,
  // at the late frame's time (read off the transition caught at the commit: by then it
  // may be over).
  test("motion: Chrome starts the reserve's transition on the frame after the send's commit — pending at the commit and on the late frame, at its first value there, started at that frame's time (lot 33)", async (ctx) => {
    const { run } = await runOf("motion", "sendThenLongTask", ctx);
    const sent = run.sent!;
    const [lateFrame, next] = run.late!.frames;
    expect(sent.transition).toEqual(expect.objectContaining({ pending: true, startTime: null }));
    expect(lateFrame.transition).toEqual(expect.objectContaining({ pending: true, startTime: null }));
    expect(Math.abs(lateFrame.spacer - sent.spacer)).toBeLessThanOrEqual(0.5);
    expect(next.transition).toEqual(expect.objectContaining({ pending: false }));
    expect(Math.abs(next.transition!.startTime! - lateFrame.transition!.timeline)).toBeLessThanOrEqual(1);
  }, 900_000);
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

// NO CSS ZOOM IN THE APP (lot 38). The follow's rounding slack takes the page's physical
// pixels from `devicePixelRatio`. Blink bounds a scroll in the element's own effective
// zoom, which a CSS `zoom` on it or on an ancestor multiplies without changing the
// frame's ratio (Codex, pass 27): under one, the slack would be too small. The app sets
// none; this keeps it so, or brings whoever adds one here.
describe("the app sets no CSS zoom, which the follow's rounding slack does not count (lot 38)", () => {
  const all = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) all(f, out);
      else if (/\.(css|tsx?)$/.test(e) && !/\.(test|fixtures|testkit)\.tsx?$/.test(e) && !/\.d\.ts$/.test(e)) out.push(f);
    }
    return out;
  };
  // A declaration in a stylesheet, an inline style's property, a script's assignment.
  const ZOOM = { css: /(^|[;{\s])zoom\s*:/m, tsx: /\bstyle\.zoom\b|\bzoom\s*:\s*["'`\d]/ };
  test("no stylesheet, inline style or script of src/ sets it", () => {
    const hits = [...all(SRC), join(ROOT, "index.html")].filter((f) =>
      (f.endsWith(".css") ? ZOOM.css : ZOOM.tsx).test(readFileSync(f, "utf8")),
    );
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });
  test("the patterns see a declaration, an inline style and an assignment", () => {
    expect(ZOOM.css.test(".a {\n  zoom: 0.5;\n}")).toBe(true);
    expect(ZOOM.css.test(".a { cursor: zoom-in; }")).toBe(false);
    expect(ZOOM.tsx.test("<div style={{ zoom: 0.5 }} />")).toBe(true);
    expect(ZOOM.tsx.test('el.style.zoom = "2"')).toBe(true);
    expect(ZOOM.tsx.test("zoom: PdfZoom;")).toBe(false);
  });
});
