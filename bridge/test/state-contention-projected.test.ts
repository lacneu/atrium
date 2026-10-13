// PHASE 6 — a turn the gateway interrupted on STATE CONTENTION (2026.9.7+ `errorKind:
// "state_contention"`) is, on a projected conversation, a status to check, not a failure to
// resend: upstream says "Execution may have occurred; check the recorded outcome before
// resending" (src/sessions/session-run-error-presentation.ts:3-7 at v2026.9.8), and the
// transcript read that follows every terminal shows what was recorded. The class says so
// (`gateway_state_contention`) on `on` ONLY — off/shadow keep 0.97.0's `gateway_storage_busy`
// (pinned here, the bridge half of the never-on invariance).

import { describe, expect, it } from "vitest";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";

const SK = "agent:main:atrium:chat:u:c1";
const RUN = "run-own";
const SUMMARY =
  "The turn was interrupted while the server was busy. Check its status before trying again.\n\n" +
  "SQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.";

function start(decides: boolean): { n: Normalizer; now: number } {
  const n = new Normalizer(SK, null);
  n.transcriptDecides = decides;
  n.beginTurn(1000);
  n.noteRunStarted(RUN, 1000);
  return { n, now: 1000 };
}
const finalOf = (ev: BridgeEvent[]) =>
  ev.find((e) => e.type === "message.final") as (BridgeEvent & { errorKind?: string | null; error?: string | null }) | undefined;

const chatError = { type: "event", event: "chat", payload: { sessionKey: SK, runId: RUN, state: "error", errorMessage: SUMMARY, errorKind: "state_contention" } };
const lifecycleError = {
  type: "event",
  event: "agent",
  payload: { sessionKey: SK, runId: RUN, stream: "lifecycle", data: { phase: "error", error: SUMMARY, errorKind: "state_contention" } },
};

describe("state contention on a projected conversation", () => {
  for (const [name, frame] of [["chat error", chatError], ["lifecycle error", lifecycleError]] as const) {
    it(`${name}: ON → gateway_state_contention; OFF → 0.97.0's gateway_storage_busy`, () => {
      const on = start(true);
      const evOn = on.n.feed(frame, on.now + 1);
      const off = start(false);
      const evOff = off.n.feed(frame, off.now + 1);
      expect(finalOf(evOn)?.errorKind).toBe("gateway_state_contention");
      expect(finalOf(evOff)?.errorKind).toBe("gateway_storage_busy");
    });
  }

  it("ON: any OTHER errorKind keeps its class (the override names one fact only)", () => {
    const on = start(true);
    const ev = on.n.feed(
      { ...chatError, payload: { ...chatError.payload, errorKind: "rate_limit", errorMessage: "429" } },
      on.now + 1,
    );
    expect(finalOf(ev)?.errorKind).toBe("rate_limit");
  });
});
