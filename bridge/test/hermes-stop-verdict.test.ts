/// <reference types="vitest" />
//
// What the bridge LEARNED when it asked Hermes to stop (lot 45 — G-41).
//
// The abort swallowed every outcome — `.catch(() => {})` on both transports, under a
// comment calling the server-side stop "a courtesy". On the REST transport that comment
// was false twice over: the stop is not a courtesy but the only thing that ends the run,
// and it can never succeed. Read from the restored upstream (v2026.7.20):
// `/api/sessions/{id}/chat/stream` mints its own `run_` id and registers it in neither
// `_active_run_agents` nor `_active_run_tasks`, which is exactly what
// `_handle_stop_run` looks in before answering 404 `run_not_found`.
//
// So the bridge must come back with a VERDICT, and the three names are kept apart on
// purpose even though they share one consequence: `ineffective` is the structural REST
// case (constant, expected), `unknown` is the rare live-socket one. A trace that cannot
// tell them apart cannot answer "why did my chat forget after I pressed Stop".

import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDurableSessionDrop,
  HermesTurnRegistry,
  hermesAbortResponseBody,
  performHermesAbort,
  selectPriorSession,
} from "../src/providers/hermes/dispatch.js";
import { runHermesTurn } from "../src/providers/hermes/turn.js";
import {
  isHermesWsStoredSessionId,
  runHermesWsTurn,
} from "../src/providers/hermes/ws-turn.js";
import type { HermesClient } from "../src/providers/hermes/client.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const REST_SESSION = "api_1783351043_b99e6df2";
const WS_STORED = "20260706_212939_aee24e";
const WS_ROTATED = "20260706_221500_bb31cc";
/** The abort's in-flight-bind budget (`ABORT_BIND_SETTLE_MS`). The cut must happen well
 *  inside it, not after it. */
const ABORT_WAIT_BUDGET_MS = 2_000;

function writerStub(
  finals: Array<{ status: string; clearProviderSession?: string }> = [],
): ConvexWriter {
  return {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    addMedia: async () => {},
    addProvenancePart: async () => {},
    setPhase: () => {},
    finalize: async (
      _id: string,
      status: string,
      _t?: string,
      _e?: string | null,
      _k?: string | null,
      o?: { clearProviderSession?: string },
    ) => {
      finals.push({ status, clearProviderSession: o?.clearProviderSession });
    },
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
}

// ── REST: a real HermesClient against a real gateway that answers the real shape ──
//
// Stubbing `stopRun` would prove only that a branch exists. The 404 body upstream
// actually sends is what the classifier has to recognize, so it is served here.

let gateway: Server | null = null;
afterEach(async () => {
  if (gateway) {
    await new Promise<void>((res) => gateway!.close(() => res()));
    gateway = null;
  }
});

/** Bring up a gateway whose `/v1/runs/{id}/stop` behaves as `reply` says, and hand back
 *  a BridgeConfig pointed at it — `hermesClientFor` builds its client from this. */
async function gatewayAnswering(
  reply: "not_found" | "ok" | "server_error" | "hang_up",
): Promise<{ cfg: BridgeConfig; stops: string[] }> {
  const stops: string[] = [];
  gateway = createServer((req, res) => {
    const m = /^\/v1\/runs\/([^/]+)\/stop$/.exec(req.url ?? "");
    const stopped = m?.[1];
    if (stopped === undefined) {
      res.writeHead(404).end("{}");
      return;
    }
    stops.push(decodeURIComponent(stopped));
    if (reply === "hang_up") {
      req.socket.destroy();
      return;
    }
    if (reply === "not_found") {
      // Verbatim upstream shape: `_openai_error(f"Run not found: {run_id}",
      // code="run_not_found")` at HTTP 404.
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: {
            message: `Run not found: ${stopped}`,
            code: "run_not_found",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    if (reply === "server_error") {
      res.writeHead(500, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ run_id: stopped, status: "stopping" }));
  });
  await new Promise<void>((res) => gateway!.listen(0, "127.0.0.1", res));
  const port = (gateway.address() as AddressInfo).port;
  return {
    cfg: {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: `http://127.0.0.1:${port}`,
      openclawGatewayUrl: `http://127.0.0.1:${port}`,
      openclawToken: "t",
    } as unknown as BridgeConfig,
    stops,
  };
}

/** A REST turn that has ACCEPTED and is streaming — the state a Stop lands in.
 *  `runId` absent = the Stop arrives before `run.started`. */
async function liveRestTurn(
  registry: HermesTurnRegistry,
  opts: { runId?: string } = {},
): Promise<void> {
  let onAbort: (() => void) | null = null;
  const client = {
    ensureSession: async () => REST_SESSION,
    openStream: async (_s: string, _t: string, signal?: AbortSignal) => {
      signal?.addEventListener("abort", () => onAbort?.(), { once: true });
      return {} as Response;
    },
    readStream: (
      _res: Response,
      onFrame: (f: { event: string; data: string }) => void,
    ) =>
      new Promise<void>((_resolve, reject) => {
        if (opts.runId) {
          onFrame({
            event: "run.started",
            data: JSON.stringify({ run_id: opts.runId }),
          });
        }
        onAbort = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
      }),
  } as unknown as HermesClient;
  const abort = new AbortController();
  const run = runHermesTurn({
    client,
    writer: writerStub(),
    chatId: "c1",
    sessionKey: "k",
    providerChatId: REST_SESSION,
    text: "explique-moi",
    signal: abort.signal,
  });
  await run.accepted;
  run.done.catch(() => {});
  registry.set("c1", { abort, run });
}

describe("REST: the stop that can never work is reported as such", () => {
  it("a 404 `run_not_found` is INEFFECTIVE, and names the session to drop", async () => {
    const { cfg, stops } = await gatewayAnswering("not_found");
    const registry = new HermesTurnRegistry();
    await liveRestTurn(registry, { runId: "run_deadbeef" });
    const result = await performHermesAbort(cfg, "c1", registry, "run_deadbeef");
    expect(stops, "the stop must still be ATTEMPTED — the verdict is measured, not assumed").toEqual([
      "run_deadbeef",
    ]);
    expect(result.aborted).toBe(true);
    expect(result.interrupt).toBe("ineffective");
    // The id is what makes the drop safe: Convex clears only a binding this turn held.
    expect(result.providerSession).toBe(REST_SESSION);
  });

  it("a 2xx is INTERRUPTED — nothing to drop", async () => {
    const { cfg } = await gatewayAnswering("ok");
    const registry = new HermesTurnRegistry();
    await liveRestTurn(registry, { runId: "run_ok" });
    const result = await performHermesAbort(cfg, "c1", registry, "run_ok");
    expect(result.interrupt).toBe("interrupted");
  });

  it("a dead socket is UNKNOWN, not a proven no-op", async () => {
    // The distinction that keeps the trace useful: a network failure says nothing about
    // whether the interrupt ran. Both drop, but only one is a structural certainty.
    const { cfg } = await gatewayAnswering("hang_up");
    const registry = new HermesTurnRegistry();
    await liveRestTurn(registry, { runId: "run_gone" });
    const result = await performHermesAbort(cfg, "c1", registry, "run_gone");
    expect(result.interrupt).toBe("unknown");
  });

  it("an HTTP 500 is UNKNOWN — the gateway may have interrupted before failing", async () => {
    const { cfg } = await gatewayAnswering("server_error");
    const registry = new HermesTurnRegistry();
    await liveRestTurn(registry, { runId: "run_500" });
    const result = await performHermesAbort(cfg, "c1", registry, "run_500");
    expect(result.interrupt).toBe("unknown");
  });

  it("a Stop with NO run id yet is INEFFECTIVE — nothing was even asked", async () => {
    // The run was accepted (the agent task is running upstream) but `run.started` had
    // not arrived, so the bridge has no name to stop. Reporting `interrupted` here — or
    // reporting nothing — would leave the session bound to a run still going.
    const { cfg, stops } = await gatewayAnswering("ok");
    const registry = new HermesTurnRegistry();
    await liveRestTurn(registry);
    const result = await performHermesAbort(cfg, "c1", registry, null);
    expect(stops).toEqual([]);
    expect(result.aborted).toBe(true);
    expect(result.interrupt).toBe("ineffective");
    expect(result.providerSession).toBe(REST_SESSION);
  });

  it("a Stop that matched no live turn reports no verdict at all", async () => {
    // Nothing was aborted, so there is nothing to say about an interrupt — and above
    // all no session to drop: the chat may be bound to a turn that is working.
    const { cfg } = await gatewayAnswering("ok");
    const registry = new HermesTurnRegistry();
    const result = await performHermesAbort(cfg, "c1", registry, null);
    expect(result.aborted).toBe(false);
    expect(result.interrupt).toBeNull();
    expect(result.providerSession).toBeNull();
  });
});

// ── WS: the transport where the interrupt genuinely works ──

/** A registry whose persistent WS client is the test's — the abort routes its interrupt
 *  through `wsClientFor`, so substituting the TRANSPORT is the only way to observe what
 *  the abort actually said (and the only thing substituted). */
class StubClientRegistry extends HermesTurnRegistry {
  constructor(private readonly stub: HermesWsClient) {
    super();
  }
  override wsClientFor(): HermesWsClient {
    return this.stub;
  }
}

/** A live WS turn bound to `WS_STORED`, with `interrupt` behaving as told. */
async function liveWsTurn(
  interrupt: "ok" | "reject",
  events: Array<[string, Record<string, unknown>]> = [],
): Promise<{ calls: string[]; registry: HermesTurnRegistry }> {
  const calls: string[] = [];
  const client = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "session.resume") {
        return { session_id: "rt-1", stored_session_id: WS_STORED };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      if (method === "session.interrupt") {
        if (interrupt === "reject") throw new Error("socket write failed");
        return { status: "interrupted" };
      }
      return {};
    },
  } as unknown as HermesWsClient;
  const registry = new StubClientRegistry(client);
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer: writerStub(),
      chatId: "c1",
      sessionKey: "k",
      providerChatId: WS_STORED,
      text: "suite",
      onBoundSession: async () => {},
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  run.done.catch(() => {});
  for (const [type, payload] of events) lane(type, payload);
  // Seat then bind — the production order (`claimWsTurnSeat` before any RPC, lot 32):
  // `bindWsTurn` refuses to attach a run to a seat nobody reserved.
  registry.claimWsTurnSeat("c1");
  registry.bindWsTurn("c1", { run });
  return { calls, registry };
}

const WS_CFG = {
  transport: "ws",
  instanceName: "primary",
  gatewayHttpBase: "http://127.0.0.1:1",
  openclawGatewayUrl: "http://127.0.0.1:1",
  openclawToken: "t",
} as unknown as BridgeConfig;

describe("WS: a confirmed interrupt is kept apart from a lost one", () => {
  it("`session.interrupt` answering is INTERRUPTED", async () => {
    const { calls, registry } = await liveWsTurn("ok");
    const result = await performHermesAbort(WS_CFG, "c1", registry, null);
    expect(calls).toContain("session.interrupt");
    expect(result.interrupt).toBe("interrupted");
    expect(
      result.providerSession,
      "a confirmed interrupt still names its session — Convex is what decides not to drop",
    ).toBe(WS_STORED);
  });

  it("a failed `session.interrupt` is UNKNOWN, and the session is dropped", async () => {
    const { registry } = await liveWsTurn("reject");
    const result = await performHermesAbort(WS_CFG, "c1", registry, null);
    expect(result.interrupt).toBe("unknown");
    expect(result.providerSession).toBe(WS_STORED);
  });

  it("the session named is the STORED id, and the one after a rotation", async () => {
    // Two ways to get this wrong. `session.interrupt` targets the RUNTIME id, but the
    // chat's binding holds the STORED one — naming the runtime id would match nothing
    // and the drop would silently do nothing. And a turn that rotated mid-flight
    // (lot 36) must name what it HOLDS, not what it started on.
    const { registry } = await liveWsTurn("reject", [
      ["session.info", { stored_session_id: WS_ROTATED }],
    ]);
    const result = await performHermesAbort(WS_CFG, "c1", registry, null);
    expect(result.providerSession).toBe(WS_ROTATED);
  });
});

// ── The WIRE, whose keys are the whole contract ──
//
// The verdict is useless if Convex cannot read it, and a key mismatch across that
// boundary is a SILENT failure: `readUntrustedSessionAfterAbort` would see `undefined`,
// drop nothing, and the phantom-turn defect would be back with every other test green.
// So the names are pinned here, on the single function that produces them, and named as
// the consumer's contract rather than left implicit.

describe("the /abort body Convex reads", () => {
  it("carries the verdict and the session under the names Convex looks for", () => {
    expect(
      hermesAbortResponseBody({
        aborted: true,
        interrupt: "ineffective",
        providerSession: REST_SESSION,
      }),
    ).toEqual({
      ok: true,
      aborted: true,
      // Read by convex/bridge.ts → readUntrustedSessionAfterAbort. Renaming either key
      // on one side only is the failure this asserts against.
      interrupt: "ineffective",
      providerSession: REST_SESSION,
    });
  });

  it("OMITS both when nothing was aborted — absence is what an old bridge sends", () => {
    // Convex must read a missing verdict as "no verdict". Sending `interrupt: null`
    // instead would make the two indistinguishable from a body that never had the field,
    // which is exactly the case that must change nothing.
    const body = hermesAbortResponseBody({
      aborted: false,
      interrupt: null,
      providerSession: null,
    });
    expect(body).toEqual({ ok: true, aborted: false });
    expect(Object.keys(body)).not.toContain("interrupt");
    expect(Object.keys(body)).not.toContain("providerSession");
  });

  it("a confirmed interrupt still says so — Convex is what decides not to drop", () => {
    expect(
      hermesAbortResponseBody({
        aborted: true,
        interrupt: "interrupted",
        providerSession: WS_STORED,
      }),
    ).toMatchObject({ interrupt: "interrupted", providerSession: WS_STORED });
  });
});

// ── The SECOND layer, without which the first one is decoration ──
//
// Raised in review, and it defeated the whole lot on the most common path. Convex nulls
// `openclawChatId`, but `selectPriorSession` FALLS BACK to the bridge's in-memory memory
// of the session — so inside the same bridge process the very next turn resumed the
// session that had just been declared untrusted. The two layers are the rule dispatch.ts
// already states three lines from this fix ("the DURABLE drop rides the terminal, this is
// the cache"); the first cut of this lot shipped only one of them.
//
// A bind already IN FLIGHT is the third way back in: a turn that rotated its session has
// a queued write for the new id, and nothing stopped it from landing after the Stop.

const TARGET_KEY = "primary main c1";

describe("an unhonoured Stop closes every way back to the session", () => {
  it("REST: the next turn's selector no longer offers the tainted session", async () => {
    const { cfg } = await gatewayAnswering("not_found");
    const registry = new HermesTurnRegistry();
    // The bridge remembers this chat's session — what it does after any turn, and the
    // fallback the selector reads when Convex has nothing.
    registry.rememberSession(TARGET_KEY, REST_SESSION);
    await liveRestTurn(registry, { runId: "run_x" });
    await performHermesAbort(cfg, "c1", registry, "run_x");
    // The REAL selector, with the slot Convex has just emptied.
    expect(
      selectPriorSession(
        registry,
        { chatId: "c1", openclawChatId: null },
        TARGET_KEY,
      ),
      "the durable drop is worthless while the process still hands the session back",
    ).toBeNull();
  });

  it("WS: same, on the default transport", async () => {
    const { registry } = await liveWsTurn("reject");
    registry.rememberSession(TARGET_KEY, WS_STORED);
    await performHermesAbort(WS_CFG, "c1", registry, null);
    expect(
      selectPriorSession(
        registry,
        { chatId: "c1", openclawChatId: null },
        TARGET_KEY,
        isHermesWsStoredSessionId,
      ),
    ).toBeNull();
  });

  it("a CONFIRMED interrupt keeps the memory — the eviction is not unconditional", async () => {
    const { cfg } = await gatewayAnswering("ok");
    const registry = new HermesTurnRegistry();
    registry.rememberSession(TARGET_KEY, REST_SESSION);
    await liveRestTurn(registry, { runId: "run_ok" });
    await performHermesAbort(cfg, "c1", registry, "run_ok");
    expect(
      selectPriorSession(
        registry,
        { chatId: "c1", openclawChatId: REST_SESSION },
        TARGET_KEY,
      ),
      "a stopped run leaves a perfectly usable conversation behind",
    ).toBe(REST_SESSION);
  });

  it("a bind still IN FLIGHT cannot restore the session after the Stop", async () => {
    // The rotation window (lot 36): `session.info` arrives, the turn queues the write for
    // the rotated id, and the Stop lands before it does. Nothing marked the turn's session
    // unusable on a user Stop, so that queued write went through — and the next turn
    // resumed a session declared untrusted a moment earlier.
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const client = {
      call: async (method: string) => {
        if (method === "session.resume") {
          return { session_id: "rt-1", stored_session_id: WS_STORED };
        }
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.interrupt") throw new Error("socket write failed");
        return {};
      },
    } as unknown as HermesWsClient;
    const registry = new StubClientRegistry(client);
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client,
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: WS_STORED,
        text: "suite",
        onBoundSession: async (sid) => {
          await gate;
          writes.push(sid);
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    run.done.catch(() => {});
    lane("session.info", { stored_session_id: WS_ROTATED }); // the write is queued…
    registry.claimWsTurnSeat("c1");
    registry.bindWsTurn("c1", { run });
    await performHermesAbort(WS_CFG, "c1", registry, null); // …and the Stop lands first
    release();
    await run.done;
    expect(
      writes,
      "a queued bind must not outlive the decision that the session is unusable",
    ).toEqual([]);
  });
});

// ── The bind that is not merely QUEUED but already ON THE NETWORK ──
//
// The narrower half of the same race, raised in the second review pass. After a rotation
// A→B, `bindProviderChat(B)` can already be in flight when the Stop lands. Reading "the
// session this turn holds" then gave B while Convex still held A — and a MISMATCH clears
// nothing AND bumps no epoch (`providerSessionClearPatch`), so the in-flight write landed
// afterwards and put B back in the slot. The next send resumed the session of the turn the
// user had just stopped.
//
// Two things fix it, and both are asserted here: the abort waits (bounded) for writes it
// finds in flight, and the id it reports is what CONVEX HOLDS rather than what the turn
// believes — those diverge precisely when a write is dropped.

describe("the abort names the session Convex actually holds", () => {
  it("waits for a bind already in flight, then names the rotated id", async () => {
    const client = {
      call: async (method: string) => {
        if (method === "session.resume") {
          return { session_id: "rt-1", stored_session_id: WS_STORED };
        }
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.interrupt") throw new Error("socket write failed");
        return {};
      },
    } as unknown as HermesWsClient;
    const registry = new StubClientRegistry(client);
    let releaseWrite!: () => void;
    const writeInFlight = new Promise<void>((res) => {
      releaseWrite = res;
    });
    let entered = false;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client,
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: WS_STORED,
        text: "suite",
        onBoundSession: async () => {
          // Past the untrusted check and inside the Convex mutation — the exact state the
          // Stop has to cope with.
          entered = true;
          await writeInFlight;
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    run.done.catch(() => {});
    lane("session.info", { stored_session_id: WS_ROTATED });
    // Let the chain enter the write before the Stop arrives.
    await new Promise((r) => setTimeout(r, 0));
    expect(entered, "the test must reproduce an IN-FLIGHT write, not a queued one").toBe(
      true,
    );
    registry.claimWsTurnSeat("c1");
    registry.bindWsTurn("c1", { run });
    const pending = performHermesAbort(WS_CFG, "c1", registry, null);
    // The write completes while the Stop is being handled.
    releaseWrite();
    const result = await pending;
    await run.done;
    expect(
      result.providerSession,
      "Convex now holds the rotated id, so that is the only name the clear can match",
    ).toBe(WS_ROTATED);
  });

  it("a rotation whose write was DROPPED is not named — the previous id is", async () => {
    // The mirror, and the reason the reported id cannot simply be "what the turn believes":
    // this bind is still QUEUED when the Stop lands, so it is dropped and Convex keeps the
    // session the turn resumed. Naming the rotated id here would match nothing and clear
    // nothing at all.
    const client = {
      call: async (method: string) => {
        if (method === "session.resume") {
          return { session_id: "rt-1", stored_session_id: WS_STORED };
        }
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.interrupt") throw new Error("socket write failed");
        return {};
      },
    } as unknown as HermesWsClient;
    const registry = new StubClientRegistry(client);
    const written: string[] = [];
    let block!: () => void;
    const blocked = new Promise<void>((res) => {
      block = res;
    });
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client,
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: WS_STORED,
        text: "suite",
        onBoundSession: async (sid) => {
          await blocked;
          written.push(sid);
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    run.done.catch(() => {});
    registry.claimWsTurnSeat("c1");
    registry.bindWsTurn("c1", { run });
    lane("session.info", { stored_session_id: WS_ROTATED }); // queued, never entered
    const pending = performHermesAbort(WS_CFG, "c1", registry, null);
    block();
    const result = await pending;
    await run.done;
    expect(written, "the queued write is dropped by the untrusted mark").toEqual([]);
    expect(result.providerSession).toBe(WS_STORED);
  });
});

// ── The local cut comes FIRST, before any waiting ──
//
// Raised in the third review pass, and it was a regression this lot introduced: waiting up
// to 2 s for an in-flight binding BEFORE cutting the turn left the reader consuming for
// that whole window. A provider terminal landing there finalized the message `complete`,
// and Convex's guaranteed settle then lost to first-terminal-wins — so a Stop the user
// pressed could render a finished answer. Protecting the session must never cost the Stop
// itself.

describe("a Stop cuts the turn before it waits for anything", () => {
  it("WS: a terminal arriving during the bind wait cannot finish the message", async () => {
    const finals: Array<{ status: string }> = [];
    const client = {
      call: async (method: string) => {
        if (method === "session.resume") {
          return { session_id: "rt-1", stored_session_id: WS_STORED };
        }
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.interrupt") throw new Error("socket write failed");
        return {};
      },
    } as unknown as HermesWsClient;
    const registry = new StubClientRegistry(client);
    let releaseWrite!: () => void;
    const held = new Promise<void>((res) => {
      releaseWrite = res;
    });
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client,
        writer: writerStub(finals),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: WS_STORED,
        text: "suite",
        onBoundSession: async () => {
          await held;
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    run.done.catch(() => {});
    lane("session.info", { stored_session_id: WS_ROTATED });
    await new Promise((r) => setTimeout(r, 0)); // the write is now in flight
    registry.claimWsTurnSeat("c1");
    registry.bindWsTurn("c1", { run });
    const pending = performHermesAbort(WS_CFG, "c1", registry, null);
    // The provider answers WHILE the Stop is still resolving the binding.
    lane("message.complete", { text: "la réponse entière", status: "complete" });
    releaseWrite();
    await pending;
    await run.done;
    expect(
      finals.map((f) => f.status),
      "a Stop must never let a provider terminal turn the turn into a finished reply",
    ).not.toContain("complete");
  });

  it("REST: the stream is cut before the wait, not after it", async () => {
    const { cfg } = await gatewayAnswering("not_found");
    const registry = new HermesTurnRegistry();
    let releaseWrite!: () => void;
    const held = new Promise<void>((res) => {
      releaseWrite = res;
    });
    let onAbort: (() => void) | null = null;
    let cutAt: number | null = null;
    const client = {
      ensureSession: async () => null as unknown as string,
      openStream: async (_s: string, _t: string, signal?: AbortSignal) => {
        signal?.addEventListener(
          "abort",
          () => {
            cutAt = Date.now();
            onAbort?.();
          },
          { once: true },
        );
        return {} as Response;
      },
      readStream: (
        _res: Response,
        onFrame: (f: { event: string; data: string }) => void,
      ) =>
        new Promise<void>((_resolve, reject) => {
          onFrame({
            event: "run.started",
            data: JSON.stringify({ run_id: "run_slow" }),
          });
          onAbort = () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
        }),
    } as unknown as HermesClient;
    const abort = new AbortController();
    const run = runHermesTurn({
      client,
      writer: writerStub(),
      chatId: "c1",
      sessionKey: "k",
      // A FRESH session, so the mint's bind is what the abort finds in flight.
      providerChatId: null,
      text: "explique-moi",
      signal: abort.signal,
      onBoundSession: async () => {
        await held;
      },
    });
    await run.accepted;
    run.done.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    registry.set("c1", { abort, run });
    const startedAt = Date.now();
    const pending = performHermesAbort(cfg, "c1", registry, "run_slow");
    // Give the abort a chance to reach its wait, then confirm the cut ALREADY happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(
      cutAt,
      "the stream must be cut on the way in, not once the bindings have settled",
    ).not.toBeNull();
    expect((cutAt as unknown as number) - startedAt).toBeLessThan(ABORT_WAIT_BUDGET_MS);
    releaseWrite();
    await pending;
  });
});

// ── The drop must not depend on one HTTP reply surviving ──
//
// Raised in the third review pass. The verdict's primary carrier is the `/abort` response,
// and that is deliberate: it rides Convex's guaranteed settle, so the drop is atomic with
// the aborted terminal (lot 31). But it was the ONLY carrier. A response lost after the
// bridge had already done the work took the drop with it — the run may still be writing to
// the session, Convex settles the bubble, and the persisted binding survives to be resumed
// by the next turn, which is the whole defect back again.
//
// So the bridge writes it too. What is asserted is that the durable op is ISSUED, and only
// when it should be: the Convex end of `clearProviderChat` — the epoch bump, the id-shape
// guard — is pinned by convex/providerSessionBind.test.ts.

describe("the durable drop has a second carrier", () => {
  const spyWriter = (cleared: string[]) =>
    ({
      clearProviderChat: async (chatId: string) => {
        cleared.push(chatId);
      },
    }) as unknown as ConvexWriter;

  it("an unhonoured verdict is written durably, not only answered", async () => {
    const cleared: string[] = [];
    await applyDurableSessionDrop(spyWriter(cleared), "c1", {
      aborted: true,
      interrupt: "ineffective",
      providerSession: REST_SESSION,
    });
    expect(cleared).toEqual(["c1"]);
  });

  it("…and `unknown` too", async () => {
    const cleared: string[] = [];
    await applyDurableSessionDrop(spyWriter(cleared), "c1", {
      aborted: true,
      interrupt: "unknown",
      providerSession: WS_STORED,
    });
    expect(cleared).toEqual(["c1"]);
  });

  it("a CONFIRMED interrupt writes nothing", async () => {
    const cleared: string[] = [];
    await applyDurableSessionDrop(spyWriter(cleared), "c1", {
      aborted: true,
      interrupt: "interrupted",
      providerSession: REST_SESSION,
    });
    expect(cleared).toEqual([]);
  });

  it("no turn aborted writes nothing — the chat may be running a turn that works", async () => {
    const cleared: string[] = [];
    await applyDurableSessionDrop(spyWriter(cleared), "c1", {
      aborted: false,
      interrupt: null,
      providerSession: null,
    });
    expect(cleared).toEqual([]);
  });

  it("a failing durable write never propagates — a Stop must not answer 502", async () => {
    const writer = {
      clearProviderChat: async () => {
        throw new Error("convex unreachable");
      },
    } as unknown as ConvexWriter;
    await expect(
      applyDurableSessionDrop(writer, "c1", {
        aborted: true,
        interrupt: "ineffective",
        providerSession: REST_SESSION,
      }),
    ).resolves.toBeUndefined();
  });
});
