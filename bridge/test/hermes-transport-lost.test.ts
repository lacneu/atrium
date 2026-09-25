/// <reference types="vitest" />
//
// A DEAD SOCKET is not a delivered failure (lot 31).
//
// When the bridge→Hermes WebSocket dies, the registry settles every turn subscribed on
// it. It used to do that by injecting a synthetic `error` EVENT into the turn's own event
// lane — the branch that means "Hermes told us the run failed". So the turn finalized
// while keeping its stored session, and the run may well have carried on with its tools
// on the far side of the connection that just died. There is not even a
// `session.interrupt` available here: the socket it would travel on is the one that died.
//
// This test drives the REGISTRY'S REAL `onClose`, not the turn's callback: a test that
// calls `onTransportLost` directly stays green when the wiring reverts to an injected
// event, which is exactly the shape of proof this program has already paid for twice.

import { describe, expect, it, vi } from "vitest";

/** Capture the options the registry hands the WS client, so the test can fire the REAL
 *  `onClose` the registry installed. */
const constructed: Array<{
  onClose?: (reason: string) => void;
  onEvent?: (type: string, sessionId: string, payload: Record<string, unknown>) => void;
  onServerRequest?: (
    sessionId: string,
    id: string,
    method: string,
    params: Record<string, unknown>,
  ) => boolean;
}> = [];
vi.mock("../src/providers/hermes/ws-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/hermes/ws-client.js")>()),
  HermesWsClient: class {
    constructor(opts: {
      onClose?: (reason: string) => void;
      onEvent?: (
        type: string,
        sessionId: string,
        payload: Record<string, unknown>,
      ) => void;
    }) {
      constructed.push(opts);
    }
  },
}));

const { HermesTurnRegistry, HermesSessionLaneBusyError } = await import(
  "../src/providers/hermes/dispatch.js"
);

describe("the registry's socket-close fan-out", () => {
  it("tells each subscribed turn its TRANSPORT was lost, not that Hermes errored", () => {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({
      instanceName: "inst-a",
      gatewayHttpBase: "http://x",
      openclawToken: "t",
    } as never);
    const events: Array<[string, unknown]> = [];
    const lost: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (type, payload) => events.push([type, payload]),
      onTransportLost: (reason) => lost.push(reason),
    });

    const onClose = constructed[0]?.onClose;
    expect(onClose, "the registry must install an onClose").toBeTypeOf("function");
    onClose?.("socket closed");

    expect(lost).toHaveLength(1);
    // …and NOTHING went down the event lane. An `error` event there is a DELIVERED
    // gateway failure, and a turn taking that exit keeps its stored session.
    expect(events).toEqual([]);
  });

  it("leaves OTHER instances' turns alone", () => {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({ instanceName: "inst-a", gatewayHttpBase: "http://x" } as never);
    reg.wsClientFor({ instanceName: "inst-b", gatewayHttpBase: "http://y" } as never);
    const lostA: string[] = [];
    const lostB: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: (r) => lostA.push(r),
    });
    reg.subscribeWsSession("inst-b", "sid-1", {
      onEvent: () => {},
      onTransportLost: (r) => lostB.push(r),
    });

    constructed[0]?.onClose?.("socket closed");
    expect(lostA).toHaveLength(1);
    expect(lostB).toEqual([]);
  });
});

describe("one runtime session, one turn (G-36)", () => {
  it("REFUSES a second subscriber instead of stealing the lane", () => {
    // Through the REAL `subscribeWsSession`, because the defect was in the wiring: a
    // plain `set` replaced the live turn's handlers, so turn N stopped receiving
    // anything and its terminal — its whole reply — was applied to turn N+1's bubble.
    // A test that drove a throwing stub would stay green if the `set` came back.
    const reg = new HermesTurnRegistry();
    const first: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => first.push(t),
      onTransportLost: () => {},
    });
    expect(() =>
      reg.subscribeWsSession("inst-a", "sid-1", {
        onEvent: () => {},
        onTransportLost: () => {},
      }),
    ).toThrow(HermesSessionLaneBusyError);
  });

  it("…and the FIRST turn keeps receiving its own events", () => {
    // The assertion that matters: deliver a real event the way the client does, and
    // check WHOSE handler runs. Without it, "the newcomer got nothing" would also be
    // true of a registry that delivered to nobody at all.
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    const first: string[] = [];
    const second: string[] = [];
    reg.wsClientFor({ instanceName: "inst-a", gatewayHttpBase: "http://x" } as never);
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => first.push(t),
      onTransportLost: () => {},
    });
    expect(() =>
      reg.subscribeWsSession("inst-a", "sid-1", {
        onEvent: (t) => second.push(t),
        onTransportLost: () => {},
      }),
    ).toThrow();
    const deliver = constructed[0]?.onEvent;
    expect(deliver, "the registry must install an onEvent").toBeTypeOf("function");
    deliver?.("message.complete", "sid-1", { text: "la réponse du tour N" });
    expect(first, "the terminal belongs to the lane's owner").toEqual([
      "message.complete",
    ]);
    expect(second, "and never to the refused newcomer").toEqual([]);
  });

  it("a released lane can be taken again", () => {
    // The refusal must not wedge the session forever: once the owner unsubscribes, the
    // next turn takes it normally.
    const reg = new HermesTurnRegistry();
    const release = reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: () => {},
    });
    release();
    expect(() =>
      reg.subscribeWsSession("inst-a", "sid-1", {
        onEvent: () => {},
        onTransportLost: () => {},
      }),
    ).not.toThrow();
  });
});

describe("a FINISHED turn lingers without holding the lane (bench 2026-09-23)", () => {
  // Hermes 0.19 resumes the SAME runtime session id turn after turn. A finished turn
  // kept the lane for its 120 s late-child grace, so the person's next message on the
  // chat was refused `HermesSessionLaneBusyError` (live bench: hermes-clarify, sent
  // right after hermes-cron-list on the same chat).
  function setup() {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({ instanceName: "inst-a", gatewayHttpBase: "http://x" } as never);
    return { reg, deliver: constructed[0]!.onEvent!, close: constructed[0]!.onClose! };
  }

  it("the session's next turn takes the lane while the finished one lingers", () => {
    const { reg } = setup();
    const lease = reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: () => {},
    });
    lease.linger();
    expect(() =>
      reg.subscribeWsSession("inst-a", "sid-1", {
        onEvent: () => {},
        onTransportLost: () => {},
      }),
    ).not.toThrow();
  });

  it("a late child terminal reaches ITS parent, the next turn's reply reaches the next turn", () => {
    const { reg, deliver } = setup();
    const first: string[] = [];
    const second: string[] = [];
    const lease = reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => first.push(t),
      onTransportLost: () => {},
      ownsMonitoring: (_t, p) => p.child_session_id === "child-1",
    });
    lease.linger();
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => second.push(t),
      onTransportLost: () => {},
      ownsMonitoring: () => false,
    });
    deliver("message.delta", "sid-1", { text: "tour N+1" });
    deliver("subagent.complete", "sid-1", { child_session_id: "child-1" });
    deliver("subagent.start", "sid-1", { child_session_id: "child-2" });
    expect(first, "only the child it started").toEqual(["subagent.complete"]);
    expect(second).toEqual(["message.delta", "subagent.start"]);
  });

  it("with no live turn, the lingerer still receives its tail", () => {
    const { reg, deliver } = setup();
    const first: string[] = [];
    reg
      .subscribeWsSession("inst-a", "sid-1", {
        onEvent: (t) => first.push(t),
        onTransportLost: () => {},
      })
      .linger();
    deliver("session.info", "sid-1", {});
    expect(first).toEqual(["session.info"]);
  });

  it("two LIVE turns are still refused, and a lingerer's release keeps the live owner", () => {
    const { reg, deliver } = setup();
    const lease = reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: () => {},
    });
    lease.linger();
    const second: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => second.push(t),
      onTransportLost: () => {},
    });
    expect(() =>
      reg.subscribeWsSession("inst-a", "sid-1", {
        onEvent: () => {},
        onTransportLost: () => {},
      }),
    ).toThrow(HermesSessionLaneBusyError);
    lease(); // the lingerer's 120 s grace ends
    deliver("message.complete", "sid-1", {});
    expect(second).toEqual(["message.complete"]);
  });

  it("a socket loss reaches the live turn AND the lingerers", () => {
    const { reg, close } = setup();
    const lost: string[] = [];
    reg
      .subscribeWsSession("inst-a", "sid-1", {
        onEvent: () => {},
        onTransportLost: () => lost.push("lingering"),
      })
      .linger();
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: () => lost.push("live"),
    });
    close("socket closed");
    expect(lost.sort()).toEqual(["lingering", "live"]);
  });
});

describe("a server→client request goes to the run asking it (Hermes 0.21.3+)", () => {
  function setup() {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({ instanceName: "inst-a", gatewayHttpBase: "http://x" } as never);
    return { reg, ask: constructed[0]!.onServerRequest! };
  }

  it("the LIVE turn takes it, as its lane event; a lingering one never does", () => {
    const { reg, ask } = setup();
    const first: Array<[string, Record<string, unknown>]> = [];
    const second: Array<[string, Record<string, unknown>]> = [];
    reg
      .subscribeWsSession("inst-a", "sid-1", {
        onEvent: (t, p) => first.push([t, p]),
        onTransportLost: () => {},
      })
      .linger();
    // Only a lingering turn: nobody can show it — not taken, so the client refuses it.
    expect(ask("sid-1", "srq-1", "approval", { command: "ls" })).toBe(false);
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t, p) => second.push([t, p]),
      onTransportLost: () => {},
    });
    expect(ask("sid-1", "srq-2", "approval", { command: "ls" })).toBe(true);
    expect(first).toEqual([]);
    expect(second).toEqual([
      ["atrium.server_request", { id: "srq-2", method: "approval", params: { command: "ls" } }],
    ]);
  });

  it("a method Atrium does not answer is not taken, even with a live turn", () => {
    const { reg, ask } = setup();
    const seen: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (t) => seen.push(t),
      onTransportLost: () => {},
    });
    expect(ask("sid-1", "srq-3", "vault.code", {})).toBe(false);
    expect(ask("sid-2", "srq-4", "approval", {})).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("one chat, one abortable turn (G-36, found while fixing the lane)", () => {
  it("the seat is CLAIMED before the turn exists, and a second claim is refused", () => {
    // The seat is what `/abort` targets, one per chat. Refusing it only AFTER the run was
    // built was not enough: the run submitted anyway and the chat ended up with two live
    // bubbles, one unabortable (raised in review). So the claim comes first, and a
    // refused claim means nothing is ever sent.
    const reg = new HermesTurnRegistry();
    expect(reg.claimWsTurnSeat("c1")).toBe(true);
    expect(reg.claimWsTurnSeat("c1")).toBe(false);
  });

  it("a merely RESERVED seat exposes no turn to abort", () => {
    // Nothing has been submitted yet, so there is nothing to interrupt — and `/abort`
    // must not mistake the placeholder for a live run.
    const reg = new HermesTurnRegistry();
    reg.claimWsTurnSeat("c1");
    expect(reg.peekWsTurn("c1")).toBeUndefined();
  });

  it("what Hermes TOOK is remembered past the turn, per instance and chat (codex, 0.21.5 passes 26 and 28)", () => {
    const reg = new HermesTurnRegistry();
    reg.noteAnswered("hermes-a", "c1", "srq-1", "denied");
    // No live turn at all (it ended): still known.
    expect(reg.peekWsTurn("c1")).toBeUndefined();
    expect(reg.answeredAs("hermes-a", "c1", "srq-1")).toBe("denied");
    expect(reg.answeredAs("hermes-b", "c1", "srq-1")).toBeNull();
    expect(reg.answeredAs("hermes-a", "c2", "srq-1")).toBeNull();
  });

  it("a live turn proves nothing for ANOTHER instance's requests (codex, 0.21.5 pass 24)", () => {
    const reg = new HermesTurnRegistry();
    expect(reg.claimWsTurnSeat("c1")).toBe(true);
    const live = { run: { runtimeSessionId: () => "sid-1" }, instanceName: "hermes-a" } as never;
    reg.bindWsTurn("c1", live);
    expect(reg.peekWsTurnOn("c1", "hermes-a")).toBe(live);
    expect(reg.peekWsTurnOn("c1", "hermes-b")).toBeUndefined();
    expect(reg.peekWsTurnOn("c2", "hermes-a")).toBeUndefined();
  });

  it("the bound run takes the seat, and the live turn cannot be displaced", () => {
    const reg = new HermesTurnRegistry();
    const live = { run: { runtimeSessionId: () => "sid-1" } } as never;
    reg.claimWsTurnSeat("c1");
    reg.bindWsTurn("c1", live);
    expect(reg.peekWsTurn("c1")).toBe(live);
    expect(reg.claimWsTurnSeat("c1"), "the seat is taken").toBe(false);
  });

  it("ANY exit before the run is bound gives the seat back", () => {
    // Not only a rejected `accepted`: the rehydration await and the reset-generation
    // guard both throw between the claim and the bind, and a `/reset` landing there left
    // the placeholder forever — every later send answered `chat_turn_busy` until the
    // bridge restarted (raised in review). The release therefore lives in a `finally`
    // around the whole path, which is a no-op once the run owns the seat.
    const reg = new HermesTurnRegistry();
    const live = { run: { runtimeSessionId: () => "sid-1" } } as never;
    reg.claimWsTurnSeat("c1");
    reg.bindWsTurn("c1", live);
    reg.releaseWsTurnSeat("c1"); // the same `finally`, on the SUCCESS path
    expect(reg.peekWsTurn("c1"), "a bound run keeps its seat").toBe(live);
  });

  it("a turn that never reached acceptance gives the seat BACK", () => {
    // Otherwise a single failed dispatch would wedge the conversation forever — the
    // refusal must not become a lock.
    const reg = new HermesTurnRegistry();
    reg.claimWsTurnSeat("c1");
    reg.releaseWsTurnSeat("c1");
    expect(reg.claimWsTurnSeat("c1")).toBe(true);
  });

  it("…but releasing does NOT evict a run already bound to the seat", () => {
    const reg = new HermesTurnRegistry();
    const live = { run: { runtimeSessionId: () => "sid-1" } } as never;
    reg.claimWsTurnSeat("c1");
    reg.bindWsTurn("c1", live);
    reg.releaseWsTurnSeat("c1");
    expect(reg.peekWsTurn("c1")).toBe(live);
  });
});
