/**
 * NAMING a connection end — the pure classification.
 *
 * Upstream facts these tests encode (v2026.7.1):
 *  - `event:"shutdown"` `{reason, restartExpectedMs?}` is broadcast just BEFORE
 *    the socket closes (`src/gateway/server-close.ts`), scope-free
 *    (`EVENT_SCOPE_GUARDS.shutdown = []` in `server-broadcast.ts`) — so every
 *    operator connection receives it.
 *  - `1008` is AMBIGUOUS on the code alone: `1008 "slow consumer"` when our
 *    receive buffer passed MAX_BUFFERED_BYTES (`server-broadcast.ts`), and
 *    `1008 "unauthorized: …"` for a refused device/signature
 *    (`src/gateway/client.test.ts`). Only the reason separates them.
 */

import { describe, expect, it } from "vitest";

import {
  classifyConnectionEnd,
  readShutdownNotice,
} from "../src/providers/openclaw/connection-end.js";

describe("readShutdownNotice", () => {
  it("reads the upstream shutdown frame, keeping the delay and only the PRESENCE of a reason", () => {
    const notice = readShutdownNotice({
      type: "event",
      event: "shutdown",
      payload: { reason: "operator requested restart", restartExpectedMs: 45_000 },
    });
    expect(notice).toEqual({
      reasonPresent: true,
      restartExpectedMs: 45_000,
      restartAnnounced: true,
    });
    // The free-text reason must NOT be part of the result (SOC2): assert on the
    // serialized shape so a future field carrying it would fail here.
    expect(JSON.stringify(notice)).not.toContain("operator requested restart");
  });

  it("still recognizes a notice with no delay and no reason — its ARRIVAL is the signal", () => {
    expect(readShutdownNotice({ type: "event", event: "shutdown" })).toEqual({
      reasonPresent: false,
      restartExpectedMs: null,
      restartAnnounced: false,
    });
  });

  it("reads a plain STOP as a notice that announces no restart (captured frame)", () => {
    // Verbatim from a bench capture (2026-10-01, gateway stopped): upstream sends
    // `restartExpectedMs` for a restart only (run-loop.ts `isRestart ? 1500 : null`;
    // server-shutdown.ts resolveGatewayShutdownNotice leaves an absent value absent).
    expect(
      readShutdownNotice({
        type: "event",
        event: "shutdown",
        payload: { reason: "gateway stopping" },
      }),
    ).toEqual({ reasonPresent: true, restartExpectedMs: null, restartAnnounced: false });
    // Through 2026.7.x the same stop carried an explicit null (server-close.ts
    // broadcast `{reason, restartExpectedMs}` unconditionally).
    expect(
      readShutdownNotice({
        type: "event",
        event: "shutdown",
        payload: { reason: "gateway stopping", restartExpectedMs: null },
      })?.restartAnnounced,
    ).toBe(false);
    // …and a restart carries the delay (run-loop.ts: 1500).
    expect(
      readShutdownNotice({
        type: "event",
        event: "shutdown",
        payload: { reason: "gateway restarting", restartExpectedMs: 1500 },
      }),
    ).toEqual({ reasonPresent: true, restartExpectedMs: 1500, restartAnnounced: true });
  });

  it("keeps a restart a restart when its delay is unusable", () => {
    // The Control UI arms its restart state on `typeof restartExpectedMs === "number"`
    // (ui/src/app/gateway-store.ts) and leaves a hostile value to its timer clamp: a
    // number that cannot size a budget still says "restart", never "stop".
    const notice = readShutdownNotice({
      type: "event",
      event: "shutdown",
      payload: { reason: "r", restartExpectedMs: -5 },
    });
    expect(notice).toEqual({ reasonPresent: true, restartExpectedMs: null, restartAnnounced: true });
    // A non-number is not a restart announcement at all.
    expect(
      readShutdownNotice({
        type: "event",
        event: "shutdown",
        payload: { reason: "r", restartExpectedMs: "soon" },
      })?.restartAnnounced,
    ).toBe(false);
  });

  it("rejects a nonsense delay rather than sizing a recovery budget with it", () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, "soon"]) {
      expect(
        readShutdownNotice({
          type: "event",
          event: "shutdown",
          payload: { reason: "r", restartExpectedMs: ms },
        })?.restartExpectedMs,
      ).toBeNull();
    }
  });

  it("is not fooled by another frame", () => {
    expect(readShutdownNotice({ type: "event", event: "health" })).toBeNull();
    expect(readShutdownNotice({ type: "res", id: "1", ok: true })).toBeNull();
    expect(readShutdownNotice(null)).toBeNull();
    expect(readShutdownNotice("shutdown")).toBeNull();
  });
});

describe("classifyConnectionEnd", () => {
  it("separates the two meanings of 1008 by their reason", () => {
    expect(
      classifyConnectionEnd({ code: 1008, reasonText: "slow consumer" }).kind,
    ).toBe("slow_consumer");
    expect(
      classifyConnectionEnd({
        code: 1008,
        reasonText: "unauthorized: device token mismatch",
      }).kind,
    ).toBe("unauthorized");
    // A 1008 we do not recognize is still a REFUSAL, never an ordinary blip.
    expect(classifyConnectionEnd({ code: 1008, reasonText: "nope" }).kind).toBe(
      "policy_violation",
    );
  });

  it("lets an ANNOUNCED shutdown outrank the close code", () => {
    // The gateway told us its intention; the code that follows is just how the
    // socket went away. Reading the code first would demote a known restart.
    const end = classifyConnectionEnd({
      code: 1006,
      reasonText: "",
      shutdown: { reasonPresent: true, restartExpectedMs: 30_000, restartAnnounced: true },
    });
    expect(end.kind).toBe("gateway_restarting");
    expect(end.restartExpectedMs).toBe(30_000);
  });

  it("names an announced STOP for what it is, never a restart", () => {
    // The gateway said it was going away and did not say it was coming back.
    const end = classifyConnectionEnd({
      code: 1012,
      reasonText: "service restart",
      shutdown: { reasonPresent: true, restartExpectedMs: null, restartAnnounced: false },
    });
    expect(end.kind).toBe("gateway_stopping");
    expect(end.restartExpectedMs).toBeNull();
    // A restart whose delay was unusable is still a restart.
    expect(
      classifyConnectionEnd({
        code: 1006,
        shutdown: { reasonPresent: true, restartExpectedMs: null, restartAnnounced: true },
      }).kind,
    ).toBe("gateway_restarting");
    // An announced stop still outranks a policy close code.
    expect(
      classifyConnectionEnd({
        code: 1008,
        reasonText: "slow consumer",
        shutdown: { reasonPresent: false, restartExpectedMs: null, restartAnnounced: false },
      }).kind,
    ).toBe("gateway_stopping");
  });

  it("names an ordinary drop, and never carries the reason text out", () => {
    const end = classifyConnectionEnd({ code: 1006, reasonText: "  " });
    expect(end.kind).toBe("connection_closed");
    expect(end.reasonPresent).toBe(false); // whitespace is not a reason
    const withText = classifyConnectionEnd({ code: 1011, reasonText: "internal boom" });
    expect(withText.reasonPresent).toBe(true);
    expect(JSON.stringify(withText)).not.toContain("internal boom");
  });
});
