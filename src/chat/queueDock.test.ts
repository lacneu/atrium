import { describe, expect, it } from "vitest";
import {
  dockPlaceOf,
  gatewayQueuedIds,
  liveQueueSessions,
  othersInGatewayQueue,
  type GatewayQueueSessionFact,
} from "./queueDock";

// The dock or the thread, never both (phase 6) — and each session's queue governs ONLY its
// own messages (codex phase 6 pass 4).
const NOW = 10_000;
const session = (count: number, until: number, messageIds: string[]): GatewayQueueSessionFact => ({ count, until, sendIds: messageIds });

describe("liveQueueSessions", () => {
  it.each([
    ["projection on, fresh, non-empty", true, [session(1, NOW + 1, ["a"])], 1],
    ["rolled back to shadow: nothing moves a custody any more", false, [session(1, NOW + 1, ["a"])], 0],
    ["the read went stale", true, [session(1, NOW, ["a"])], 0],
    ["the gateway emptied its queue (queuedCount 0)", true, [session(0, NOW + 1, ["a"])], 0],
    ["no read stated a queue", true, [], 0],
  ] as const)("%s", (_n, projection, sessions, n) => {
    expect(liveQueueSessions(projection, { sessions: [...sessions] }, NOW)).toHaveLength(n);
  });
  it("no fact at all", () => {
    expect(liveQueueSessions(true, null, NOW)).toEqual([]);
  });
});

describe("two sessions never steer each other's messages (codex phase 6 pass 4)", () => {
  const msgA = { _id: "mA", queuedSendId: "mA", role: "user", custody: "queued", outbox: { status: "sent" } };
  const msgB = { _id: "mB", queuedSendId: "mB", role: "user", custody: "queued", outbox: { status: "sent" } };
  const none = new Set<string>();

  it("A holds its message queued; a NEWER read of B saying 0 does not move A's message", () => {
    const live = liveQueueSessions(
      true,
      { sessions: [session(0, NOW + 900, []), session(1, NOW + 100, ["mA"])] }, // B newest, A older
      NOW,
    );
    expect(dockPlaceOf(msgA, none, gatewayQueuedIds(live))).toBe("gateway");
  });

  it("a FRESH queue on B never hides an EXPIRED queued entry of A", () => {
    const live = liveQueueSessions(
      true,
      { sessions: [session(2, NOW + 900, ["mB"]), session(1, NOW - 1, ["mA"])] },
      NOW,
    );
    const ids = gatewayQueuedIds(live);
    expect(dockPlaceOf(msgA, none, ids)).toBe("thread");
    expect(dockPlaceOf(msgB, none, ids)).toBe("gateway");
  });

  it("the 'more queued' line counts per session, minus that session's own cards", () => {
    const live = [session(3, NOW + 1, ["mA"]), session(1, NOW + 1, ["mB"])];
    // A: 3 queued, 1 is ours → 2 others; B: 1 queued, ours → 0.
    expect(othersInGatewayQueue(live, new Set(["mA", "mB"]))).toBe(2);
    // A card the reader does not see (a newer read already moved it): never negative.
    expect(othersInGatewayQueue([session(1, NOW + 1, ["mA", "mX"])], new Set(["mA", "mX"]))).toBe(0);
  });
});

describe("dockPlaceOf — one place per message", () => {
  const none = new Set<string>();
  it("Atrium's own queue wins over a gateway custody (it never reached the gateway)", () => {
    expect(dockPlaceOf({ _id: "a", role: "user", custody: "queued", outbox: { status: "queued" } }, none, new Set(["a"]))).toBe("atrium");
    expect(dockPlaceOf({ _id: "e", role: "user" }, new Set(["e"]), none)).toBe("atrium");
  });
  it("matched by its SEND identity, never by its message id (codex phase 6 pass 5)", () => {
    const m = { _id: "msg-1", queuedSendId: "webchat-abc", role: "user", custody: "queued" };
    expect(dockPlaceOf(m, none, new Set(["webchat-abc"]))).toBe("gateway");
    expect(dockPlaceOf(m, none, new Set(["msg-1"]))).toBe("thread");
    expect(dockPlaceOf({ ...m, queuedSendId: undefined }, none, new Set(["webchat-abc"]))).toBe("thread");
  });
  it("a gateway-queued input leaves the thread only while ITS session names it", () => {
    const m = { _id: "g", queuedSendId: "g", role: "user", custody: "queued", outbox: { status: "sent" } };
    expect(dockPlaceOf(m, none, new Set(["g"]))).toBe("gateway");
    expect(dockPlaceOf(m, none, none)).toBe("thread");
  });
  it("a consumed, steered or withdrawn input is back in the thread, even if named", () => {
    for (const custody of ["persisted", "steered", "cancelled", "interrupted", "accepted"]) {
      expect(dockPlaceOf({ _id: "x", queuedSendId: "x", role: "user", custody }, none, new Set(["x"]))).toBe("thread");
    }
    expect(dockPlaceOf({ _id: "r", role: "assistant", custody: "queued" }, none, new Set(["r"]))).toBe("thread");
  });
});
