import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  Normalizer,
  type BridgeEvent,
} from "../src/providers/openclaw/normalizer.js";

// Version-keyed CONTRACT for how OpenClaw transports a bash/exec tool RESULT on
// the operator stream. The frames are REAL captures (OPENCLAW_CAPTURE_FRAMES --
// see the live-bench runbook), one start+result pair per gateway version. The
// pinned fact: the result is ONLY the {status, exitCode, durationMs} envelope --
// the gateway does NOT send the command's stdout to operators (the Control UI
// reads it from a gateway-internal channel). The frontend therefore renders this
// as an OUTCOME, not raw JSON (toolActivityView.formatToolResult).
//
// WHY this guards FUTURE versions: to support a new version, capture its frames
// and add them under `versions`. If that version starts sending stdout (an extra
// key on the result, or a separate frame), the "envelope only" assertion FAILS --
// a loud signal to teach the normalizer + renderer to surface the now-available
// output instead of dropping it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, "./fixtures/tool-result-versions.json"),
    "utf-8",
  ),
) as {
  session_key: string;
  run_id: string;
  versions: Record<string, unknown[]>;
};

function feedAll(frames: unknown[]): BridgeEvent[] {
  const n = new Normalizer(FIXTURE.session_key);
  const events: BridgeEvent[] = [];
  let t = 1000;
  n.beginTurn(t);
  n.noteRunStarted(FIXTURE.run_id, t);
  for (const f of frames) {
    t += 0.01;
    events.push(...n.feed(f, t));
  }
  return events;
}

describe("tool-output transport contract (per OpenClaw version)", () => {
  const versions = Object.keys(FIXTURE.versions);
  it("covers at least one captured version", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const version of versions) {
    it(`${version}: bash result is the envelope ONLY (no stdout transported)`, () => {
      const events = feedAll(FIXTURE.versions[version]!);
      const bashEvents = events.filter(
        (e) =>
          e.type === "tool.status" &&
          (e as { name?: unknown }).name === "bash",
      ) as unknown as Array<{
        name: string;
        phase: string;
        toolCallId?: string;
        output?: unknown;
      }>;
      // start + completed now both surface (same toolCallId, Convex upserts
      // them into one card); the OUTPUT contract lives on the completed.
      const tool = bashEvents.find((e) => e.phase === "completed");
      expect(tool, "a bash completed tool.status must be emitted").toBeDefined();
      const start = bashEvents.find((e) => e.phase === "start");
      if (start !== undefined) {
        expect(start.toolCallId).toBe(tool!.toolCallId);
      }

      const output = tool!.output as Record<string, unknown>;
      // The exact envelope the gateway sends -- and nothing more.
      expect(Object.keys(output).sort()).toEqual([
        "durationMs",
        "exitCode",
        "status",
      ]);
      expect(output.status).toBe("completed");
      // The forward-looking guard: NO stdout-bearing key. A future version that
      // adds one trips this -> update the normalizer + the renderer to show it.
      for (const k of ["output", "stdout", "aggregatedOutput", "stderr"]) {
        expect(
          output,
          `${version} unexpectedly carries "${k}" -- the gateway now transports tool output; teach the normalizer + ToolCard to surface it`,
        ).not.toHaveProperty(k);
      }
    });
  }
});
