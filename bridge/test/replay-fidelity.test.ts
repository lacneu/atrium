/**
 * The FIDELITY gate (W11/G4): promotion may change what a capture says, never what
 * Atrium makes of it.
 *
 * This guard exists because fourteen review passes over the anonymiser missed three
 * promotion defects that it found on its first run — a version marker renamed
 * (`announce:v1:` → announced children never settled), session keys masked inside a tool
 * result (the `awaiting_subagents` phase never fired) and item-stream tool names masked
 * (plan advances never counted). Each was invisible in the fixture: the corpus replayed
 * green while covering less than it claimed.
 */

import { describe, expect, it } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { fidelityDiff, loadRunManager } from "../scripts/lib/replay-fidelity.mjs";

// The RunManager comes from SOURCE here. `loadRunManager` reads the compiled bridge
// because the PROMOTER runs from a checkout with a build; `dist/` is gitignored and the
// bridge CI job runs typecheck + test only, so a test that needed it would fail on every
// clean checkout (raised in review — reproduced by moving `dist` aside).

const KEY = "agent:alice:atrium:chat:u-x:turn-y";
const RUN = "webchat-r1";

/** A minimal but REAL capture: an ack, a tool call and a final. */
function capture(toolName: string): { receivedAt: number; frame: unknown }[] {
  return [
    { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } },
    {
      receivedAt: 10,
      frame: {
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          stream: "tool",
          seq: 1,
          data: { name: toolName, phase: "start", toolCallId: "c1", args: {} },
        },
      },
    },
    {
      receivedAt: 20,
      frame: {
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          seq: 2,
          state: "final",
          message: { content: [{ type: "text", text: "fini" }] },
        },
      },
    },
  ];
}

describe("replay fidelity", () => {
  it("sees no difference when promotion preserved the reading", async () => {
    const diffs = await fidelityDiff(RunManager, capture("exec"), capture("exec"));
    expect(diffs).toEqual([]);
  });

  it("REPORTS a difference when a masked path kills the media reading", async () => {
    // The real shape of a promotion defect: the frame still parses, the fixture still
    // looks healthy, and one reading is simply gone. (A CONSISTENT rename is not a
    // difference — the replay derives the session from the capture, which is why a
    // pseudonymised corpus is faithful in the first place.)
    const withMedia = capture("exec").map((e, i) =>
      i === 1
        ? {
            ...e,
            frame: {
              event: "agent",
              payload: {
                runId: RUN,
                sessionKey: KEY,
                stream: "assistant",
                seq: 1,
                data: {
                  mediaUrls: ["/home/node/.openclaw/media/outbound/a.png"],
                  text: "voila",
                },
              },
            },
          }
        : e,
    );
    const masked = JSON.parse(
      JSON.stringify(withMedia).replace(
        "/home/node/.openclaw/media/outbound/a.png",
        "/xxxx/xxxx/.xxxxxxxx/xxxxx/xxxxxxxx/x.xxx",
      ),
    ) as typeof withMedia;
    const clean = await fidelityDiff(RunManager, withMedia, withMedia);
    expect(clean, "identical input, no difference").toEqual([]);
    const diffs = await fidelityDiff(RunManager, withMedia, masked);
    expect(diffs.join(" "), "the lost media delivery must be reported").toContain("addMedia");
  });

  it("REFUSES to load without a build, instead of skipping the check", async () => {
    await expect(loadRunManager("/nonexistent/bridge")).rejects.toThrow(/npm run build/);
  });
});

describe("the gate compares ORDER, not just counts", () => {
  it("a permuted write sequence is a difference", async () => {
    // Write order is semantic: a card updated after a finalize is a different reading
    // from the same card updated before it. Comparing frequencies alone accepted any
    // permutation of the same calls.
    // Two captures with the same writes in a different order: a tool card before vs after
    // the final. The frames themselves carry the order.
    const toolFrame = (seq: number) => ({
      receivedAt: seq * 10,
      frame: {
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          stream: "tool",
          seq,
          data: { name: "exec", phase: "start", toolCallId: `c${seq}`, args: {} },
        },
      },
    });
    const finalFrame = (seq: number) => ({
      receivedAt: seq * 10,
      frame: {
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          seq,
          state: "final",
          message: { content: [{ type: "text", text: "fini" }] },
        },
      },
    });
    const ack = { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } };
    const toolFirst = [ack, toolFrame(1), finalFrame(2)];
    const finalFirst = [ack, finalFrame(1), toolFrame(2)];
    const diffs = await fidelityDiff(RunManager, toolFirst, finalFirst);
    expect(diffs.length, "a reordered reading must not pass").toBeGreaterThan(0);
  });
});
