// A widget-only turn through the whole reading stack (RunManager → normalizer → sink),
// replayed from the frames captured live on 2026.9.6: the widget part reaches the
// writer as a `tool`-origin descriptor, and the turn closes COMPLETE — never as the
// empty-response error card a text-less turn otherwise earns.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/widgets/probe-2026.9.6.json"), "utf-8"),
) as {
  session_key: string;
  runs: { cap: string; widgetOnly: string };
  widgetOnly: Array<{ t: number; event: string; payload: Record<string, unknown> }>;
};

/** Records every call; answers what the sink needs to keep going. */
function recordingWriter(widgetLands = true) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const answers: Record<string, unknown> = {
    startAssistant: "msg1",
    setSnapshot: true,
    addMedia: true,
    addWidgetPart: widgetLands,
    getRehydrationContext: { history: null, turnCount: 0 },
  };
  const writer = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return Promise.resolve(answers[String(prop)]);
        };
      },
    },
  ) as ConvexWriter;
  return { writer, calls };
}

async function replay(widgets: boolean, widgetLands = true) {
  const { writer, calls } = recordingWriter(widgetLands);
  const m = new RunManager("chat-w", FIXTURE.session_key, writer);
  m.setWidgetsEnabled(widgets);
  const t0 = 1000;
  await m.beginTurn(t0, FIXTURE.runs.widgetOnly);
  for (const f of FIXTURE.widgetOnly) {
    await m.feed({ type: "event", event: f.event, payload: f.payload }, t0 + f.t / 1000);
  }
  return calls;
}

describe("a widget-only turn, sink side", () => {
  it("stores the widget as a tool-origin descriptor and closes complete", async () => {
    const calls = await replay(true);
    const parts = calls.filter((c) => c.method === "addWidgetPart");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.args[1]).toMatchObject({
      kind: "widget",
      provider: "openclaw",
      origin: "tool",
      viewId: "cv_3eca04c48b4847638952336f6b09bdc2",
      sandbox: "scripts",
    });
    const finals = calls.filter((c) => c.method === "finalize");
    expect(finals).toHaveLength(1);
    const [, status, , error, errorKind] = finals[0]!.args as [string, string, string, unknown, unknown];
    expect(status).toBe("complete");
    expect(error).toBeNull();
    expect(errorKind).toBeNull();
  });

  it("a widget Convex REFUSED is not a reply: the text-less turn closes as the empty-response error", async () => {
    const calls = await replay(true, false);
    expect(calls.filter((c) => c.method === "addWidgetPart")).toHaveLength(1);
    const finals = calls.filter((c) => c.method === "finalize");
    expect(finals).toHaveLength(1);
    const [, status, , error, errorKind] = finals[0]!.args as [string, string, string, unknown, unknown];
    expect(status).toBe("error");
    expect(errorKind).toBe("empty_response");
    expect(error).toEqual(expect.any(String));
  });
});
