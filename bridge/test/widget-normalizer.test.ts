// Inline widgets through the normalizer, replayed from frames CAPTURED LIVE on the
// 2026.9.6 bench (fixtures/widgets/probe-2026.9.6.json). Three carriers name the same
// view — the `canvas` part on every chat delta and on the final, the nested
// `show_widget` result, the `[embed]` shortcode in the text — and exactly one widget
// must come out, before the terminal, while the text keeps the shortcode exactly as the
// gateway sent it (the SPA hides it at render time, beside the widget it names) and never
// shrinks. The widget-only turn's second, delivery-mirror final must not
// replace the widget with its fallback sentence.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import type { BridgeEvent } from "../src/core/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/widgets/probe-2026.9.6.json"), "utf-8"),
) as {
  session_key: string;
  runs: { cap: string; widgetOnly: string };
  cap: Array<{ t: number; event: string; payload: Record<string, unknown> }>;
  widgetOnly: Array<{ t: number; event: string; payload: Record<string, unknown> }>;
};

const CAP_VIEW = "cv_87c3b1326a2c47028d93b4c38e242832";
const WIDGET_ONLY_VIEW = "cv_3eca04c48b4847638952336f6b09bdc2";
const FALLBACK = "The tool run finished, but no final summary was produced";

afterEach(() => protocolDrift.resetForTests());

function replay(run: "cap" | "widgetOnly", widgets: boolean) {
  const frames = FIXTURE[run];
  const n = new Normalizer(FIXTURE.session_key);
  n.widgetsEnabled = widgets;
  const t0 = 1000;
  n.beginTurn(t0);
  n.noteRunStarted(FIXTURE.runs[run], t0);
  const events: BridgeEvent[] = [];
  /** Events produced by each frame, to locate WHEN something happened. */
  const perFrame: BridgeEvent[][] = [];
  for (const f of frames) {
    const out = n.feed({ event: f.event, payload: f.payload }, t0 + f.t / 1000);
    perFrame.push(out);
    events.push(...out);
  }
  return { n, events, perFrame, frames };
}

const widgetsOf = (events: BridgeEvent[]) => events.filter((e) => e.type === "widget");
const texts = (events: BridgeEvent[]) =>
  events
    .filter((e) => e.type === "message.snapshot" || e.type === "message.delta" || e.type === "message.final")
    .map((e) => ({ type: e.type, text: String(e.text ?? "") }));

describe("inline widgets — the code-mode turn (three carriers, one view)", () => {
  it("emits exactly one widget, from the first carrier, before the terminal", () => {
    const { events } = replay("cap", true);
    const widgets = widgetsOf(events);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.widget).toEqual({ viewId: CAP_VIEW, title: "Counter", sandbox: "scripts" });
    // Named first by the turn's own show_widget result: the one carrier Convex
    // registers a view from.
    expect(widgets[0]!.origin).toBe("tool");
    const finalAt = events.findIndex((e) => e.type === "message.final");
    expect(finalAt).toBeGreaterThan(events.indexOf(widgets[0]!));
  });

  it("the nested show_widget RESULT alone carries the widget (the socket that sent the turn)", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const result = FIXTURE.cap.find(
      (f) => f.event === "agent" && (f.payload.data as { name?: string; phase?: string })?.name === "show_widget" &&
        (f.payload.data as { phase?: string }).phase === "result",
    )!;
    expect(String((result.payload.data as { toolCallId: string }).toolCallId)).toMatch(/:show_widget:\d+$/);
    const out = n.feed({ event: result.event, payload: result.payload }, 1001);
    expect(widgetsOf(out).map((e) => (e.widget as { viewId: string }).viewId)).toEqual([CAP_VIEW]);
  });

  it("the chat part alone carries the widget (a socket that did not send the turn gets no tool frames)", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const events: BridgeEvent[] = [];
    // Only the canvas parts: the text (and its [embed] shortcode) is removed, so no other
    // carrier can stand in for the part this test is about.
    for (const f of FIXTURE.cap.filter((x) => x.event === "chat")) {
      const message = f.payload.message as { content?: Array<{ type: string }> } | undefined;
      const payload = message?.content
        ? { ...f.payload, deltaText: undefined, message: { ...message, content: message.content.filter((c) => c.type === "canvas") } }
        : f.payload;
      events.push(...n.feed({ event: f.event, payload }, 1000 + f.t / 1000));
    }
    expect(widgetsOf(events).map((e) => (e.widget as { viewId: string }).viewId)).toEqual([CAP_VIEW]);
    expect(widgetsOf(events).map((e) => e.origin)).toEqual(["canvas"]);
  });

  it("an authoritative result arriving AFTER a non-authoritative carrier is still emitted (once)", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const events: BridgeEvent[] = [];
    const chat = FIXTURE.cap.filter((x) => x.event === "chat" && x.payload.state === "delta");
    const result = FIXTURE.cap.find(
      (f) => f.event === "agent" && (f.payload.data as { name?: string; phase?: string })?.name === "show_widget" &&
        (f.payload.data as { phase?: string }).phase === "result",
    )!;
    events.push(...n.feed({ event: "chat", payload: chat[0]!.payload }, 1001));
    events.push(...n.feed({ event: result.event, payload: result.payload }, 1002));
    events.push(...n.feed({ event: result.event, payload: result.payload }, 1003));
    expect(widgetsOf(events).map((e) => e.origin)).toEqual(["canvas", "tool"]);
  });

  it("model-written carriers cannot crowd out the turn's own show_widget result (separate caps)", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const views = Array.from({ length: 20 }, (_, i) => `cv_flood${String(i).padStart(2, "0")}`);
    const text = views.map((v) => `[embed ref="${v}" /]`).join("\n");
    const events: BridgeEvent[] = n.feed(
      {
        event: "chat",
        payload: {
          runId: FIXTURE.runs.cap,
          sessionKey: FIXTURE.session_key,
          seq: 1,
          state: "delta",
          deltaText: text,
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      },
      1001,
    );
    // The other-origin budget is spent (bounded), …
    expect(widgetsOf(events).filter((e) => e.origin === "shortcode")).toHaveLength(16);
    const result = FIXTURE.cap.find(
      (f) => f.event === "agent" && (f.payload.data as { name?: string; phase?: string })?.name === "show_widget" &&
        (f.payload.data as { phase?: string }).phase === "result",
    )!;
    // … and the authoritative result still passes on its own budget.
    const out = n.feed({ event: result.event, payload: result.payload }, 1002);
    expect(widgetsOf(out).map((e) => [e.origin, (e.widget as { viewId: string }).viewId])).toEqual([["tool", CAP_VIEW]]);
  });

  it("a shortcode Atrium will not render stays visible text", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const text = 'See [embed url="https://example.test/x.html" /] and [embed ref="board-x" /].';
    const out = n.feed(
      {
        event: "chat",
        payload: {
          runId: FIXTURE.runs.cap,
          sessionKey: FIXTURE.session_key,
          seq: 1,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      },
      1001,
    );
    expect(widgetsOf(out)).toEqual([]);
    expect(String(out.find((e) => e.type === "message.final")?.text)).toBe(text);
  });

  it("the stored text keeps the shortcode as sent and never shrinks while it is written", () => {
    const { events } = replay("cap", true);
    let shown = "";
    for (const { type, text } of texts(events)) {
      if (type === "message.delta") {
        shown += text;
      } else {
        expect(text.startsWith(shown), `"${text}" shrinks "${shown}"`).toBe(true);
        shown = text;
      }
    }
    expect(shown.startsWith("Tiny counter:")).toBe(true);
    expect(shown).toContain(`[embed ref="${CAP_VIEW}"`);
    expect(shown.endsWith("TOOLS: show_widget, canvas")).toBe(true);
  });

  it("a reply that is ONLY a shortcode is a real reply: final text kept, no fallback, widget emitted", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const text = `[embed ref="${CAP_VIEW}" title="Counter" /]`;
    const out = n.feed(
      {
        event: "chat",
        payload: {
          runId: FIXTURE.runs.cap,
          sessionKey: FIXTURE.session_key,
          seq: 1,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      },
      1001,
    );
    expect(widgetsOf(out).map((e) => e.origin)).toEqual(["shortcode"]);
    const final = out.find((e) => e.type === "message.final");
    expect(String(final?.text)).toBe(text);
    expect(String(final?.text)).not.toContain(FALLBACK);
  });

  it("with widgets OFF on the socket: no widget, and the text is left as the gateway sent it", () => {
    const { events } = replay("cap", false);
    expect(widgetsOf(events)).toEqual([]);
    const final = events.find((e) => e.type === "message.final")!;
    expect(String(final.text)).toContain(`[embed ref="${CAP_VIEW}"`);
  });

  it("every frame of the turn is known to the drift sensors (canvas part, run_status, …)", () => {
    for (const f of FIXTURE.cap) protocolDrift.observe({ type: "event", event: f.event, payload: f.payload });
    for (const f of FIXTURE.widgetOnly) protocolDrift.observe({ type: "event", event: f.event, payload: f.payload });
    expect(protocolDrift.report()).toEqual([]);
  });
});

describe("inline widgets — the widget-only turn (two finals for one run)", () => {
  it("the canvas-only final closes the turn WITH its widget; the delivery-mirror final is not the answer", () => {
    const { events, perFrame, frames, n } = replay("widgetOnly", true);
    expect(widgetsOf(events).map((e) => (e.widget as { viewId: string }).viewId)).toEqual([WIDGET_ONLY_VIEW]);
    const finals = events.filter((e) => e.type === "message.final");
    expect(finals).toHaveLength(1);
    expect(String(finals[0]!.text)).toBe("");
    // The raw passthrough still carries it; no NORMALIZED event does.
    expect(JSON.stringify(events.filter((e) => e.type !== "openclaw.frame"))).not.toContain(FALLBACK);
    // Closed by the FIRST final — the one carrying the canvas part.
    const firstFinal = frames.findIndex((f) => f.event === "chat" && f.payload.state === "final");
    expect(perFrame[firstFinal]!.some((e) => e.type === "message.final")).toBe(true);
    expect(n.finalized).toBe(true);
  });

  it("with widgets OFF, the same frames end on the fallback sentence (the behaviour widgets change)", () => {
    const { events } = replay("widgetOnly", false);
    expect(widgetsOf(events)).toEqual([]);
    const final = events.find((e) => e.type === "message.final");
    expect(String(final?.text ?? "")).toContain(FALLBACK);
  });
});

describe("drift sensors one level inside the known fields", () => {
  it("an unknown chat content-part type is counted, digested, per state", () => {
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: {
        runId: "r",
        sessionKey: FIXTURE.session_key,
        seq: 1,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "hologram", data: 1 }] },
      },
    });
    const report = protocolDrift.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.shape).toMatch(/^chat\.final\.contentpart_[0-9a-f]{8}$/);
    expect(report[0]!.shape).not.toContain("hologram");
  });

  it("an unknown agent stream is counted, digested; a plugin-scoped stream is not", () => {
    const agent = (stream: string) => ({
      type: "event",
      event: "agent",
      payload: { runId: "r", sessionKey: FIXTURE.session_key, seq: 1, ts: 1, stream, data: {} },
    });
    protocolDrift.observe(agent("telepathy"));
    protocolDrift.observe(agent("some-plugin.workflow"));
    protocolDrift.observe(agent("run_status"));
    const report = protocolDrift.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.shape).toMatch(/^agent\.stream_[0-9a-f]{8}$/);
  });
});

describe("a widget does not cost a message-tool reply its recovery", () => {
  it("a turn that showed a widget AND delivered its text through the message tool still recovers the text", () => {
    const n = new Normalizer(FIXTURE.session_key);
    n.widgetsEnabled = true;
    n.beginTurn(1000);
    n.noteRunStarted(FIXTURE.runs.cap, 1000);
    const result = FIXTURE.cap.find(
      (f) => f.event === "agent" && (f.payload.data as { name?: string; phase?: string })?.name === "show_widget" &&
        (f.payload.data as { phase?: string }).phase === "result",
    )!;
    n.feed({ event: result.event, payload: result.payload }, 1001);
    const item = (phase: string) => ({
      event: "agent",
      payload: {
        sessionKey: FIXTURE.session_key,
        runId: FIXTURE.runs.cap,
        stream: "item",
        data: { itemId: "i1", kind: "tool", name: "message", phase, status: phase === "start" ? "running" : "completed" },
      },
    });
    n.feed(item("start"), 1002);
    n.feed(item("end"), 1003);
    // The final carries the canvas part only: the text sits in the transcript.
    n.feed(
      {
        event: "chat",
        payload: {
          runId: FIXTURE.runs.cap,
          sessionKey: FIXTURE.session_key,
          seq: 99,
          state: "final",
          message: { role: "assistant", content: [] },
        },
      },
      1004,
    );
    expect(n.wantsHistoryRecovery).toBe(true);
  });
});
