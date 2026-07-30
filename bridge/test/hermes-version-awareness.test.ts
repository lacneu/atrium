/// <reference types="vitest" />
//
// The default transport learns its gateway version, and the version DECIDES something
// (lot 46 — G-55).
//
// Two halves of one defect, and the second is the deeper one:
//
//   1. `discoverHermesAgents` returned `gatewayVersion: null` HARD-CODED on the WS branch
//      — the transport everyone uses — while the REST branch below it read
//      `health.version`. The recorded reason was "`hermes serve` has no /health", which is
//      true and beside the point: the version IS on the wire. `session.info` carries it
//      (upstream fills `info["version"] = __version__`, tui_gateway/server.py:3851), and
//      the WS reader already parses that very frame for `stored_session_id`, `model`,
//      `usage` and `cwd`.
//
//   2. `applyHermesTransportOverlay` then granted the WHOLE transport capability set with
//      a flat `true`, using ONE capability (`abort`) as a version proxy. Since `abort`'s
//      minimum is the range floor, that proxy passes for every in-range version — so each
//      capability's own `minVersion` decided nothing. Combined with (1), Hermes capability
//      resolution was settled by neither the version nor the per-capability minimums.
//
// Accuracy matters here, because the gap as written overstates it: nothing is MIS-gated
// today, since every Hermes `minVersion` equals the range floor. The mechanism is INERT —
// and it would silently keep granting the moment any capability is given a higher minimum,
// which is precisely what a version ratchet is for. What IS wrong today is what the
// operator sees: every Hermes WS instance reports an unknown version, and the
// beyond-validated banner can never fire.

import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  applyHermesTransportOverlay,
  buildCapabilityTargets,
  createBridgeServer,
  resolveInstanceVersion,
} from "../src/server.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import {
  HERMES_RANGE,
  isHermesVersionScheme,
  resolveCapabilitiesFor,
} from "../src/compat.js";
import {
  discoverHermesAgents,
  HermesTurnRegistry,
} from "../src/providers/hermes/dispatch.js";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const WS_STORED = "20260706_212939_aee24e";

const WS_CFG = {
  transport: "ws",
  instanceName: "primary",
  gatewayHttpBase: "http://127.0.0.1:1",
  openclawGatewayUrl: "http://127.0.0.1:1",
  openclawToken: "t",
} as unknown as BridgeConfig;

function writerStub(): ConvexWriter {
  return {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
}

/** A registry whose WS client is the test's, so discovery's `model.options` and the turn
 *  share one transport — as they do in one bridge process. */
class StubClientRegistry extends HermesTurnRegistry {
  constructor(private readonly stub: HermesWsClient) {
    super();
  }
  override wsClientFor(): HermesWsClient {
    return this.stub;
  }
}

function wsClient(): HermesWsClient {
  return {
    call: async (method: string) => {
      if (method === "session.resume") {
        return { session_id: "rt-1", stored_session_id: WS_STORED };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      if (method === "model.options") {
        return {
          providers: [
            { is_current: true, name: "openai", current_model: "gpt-5.5" },
          ],
        };
      }
      return {};
    },
  } as unknown as HermesWsClient;
}

/** Run one WS turn and hand back its event lane, so a REAL `session.info` can be fed. */
async function turnOn(
  registry: HermesTurnRegistry,
): Promise<{ lane: (t: string, p: Record<string, unknown>) => void; done: Promise<void> }> {
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client: registry.wsClientFor(WS_CFG),
      writer: writerStub(),
      chatId: "c1",
      sessionKey: "k",
      providerChatId: WS_STORED,
      text: "bonjour",
      onGatewayVersion: (v: string | null) =>
        registry.noteGatewayVersion(WS_CFG.instanceName ?? "", v),
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  run.done.catch(() => {});
  return { lane, done: run.done };
}

describe("the version on the wire reaches the compat surface", () => {
  it("a `session.info` version is learned and reported by discovery", async () => {
    const registry = new StubClientRegistry(wsClient());
    const cold = await discoverHermesAgents(WS_CFG, registry);
    expect(
      cold.gatewayVersion,
      "cold start: no turn has happened, so nothing has been observed — null is honest",
    ).toBeNull();

    const turn = await turnOn(registry);
    // The frame upstream actually sends, with the fields it actually carries.
    turn.lane("session.info", {
      model: "gpt-5.5",
      stored_session_id: WS_STORED,
      version: "0.19.0",
      release_date: "2026-07-20",
      desktop_contract: 4,
    });
    turn.lane("message.complete", { text: "voilà", status: "complete" });
    await turn.done;

    const warm = await discoverHermesAgents(WS_CFG, registry);
    expect(
      warm.gatewayVersion,
      "the version is on the wire, in a frame the reader already parses",
    ).toBe("0.19.0");
  });

  it("a value that is not a version is refused", async () => {
    const registry = new StubClientRegistry(wsClient());
    const turn = await turnOn(registry);
    turn.lane("session.info", { version: "", stored_session_id: WS_STORED });
    turn.lane("session.info", { version: "unknown", stored_session_id: WS_STORED });
    turn.lane("message.complete", { text: "ok", status: "complete" });
    await turn.done;
    expect((await discoverHermesAgents(WS_CFG, registry)).gatewayVersion).toBeNull();
  });

  it("the observed version reaches the operator's compat target", async () => {
    // The user-visible half of G-55: until now every Hermes WS instance reported an
    // unknown version to the admin compat view.
    const [target] = buildCapabilityTargets([], "primary", "0.19.0", "hermes", "ws");
    expect(target?.gatewayVersion).toBe("0.19.0");
  });

  it("a gateway ABOVE the validated max raises the banner", async () => {
    // `versionBeyondValidated` drives a user-visible banner (src/chat/useInstanceCapabilities)
    // and the admin view's "beyond" state. With the version stuck at null it could never
    // fire on this transport, whatever the gateway was running.
    const [beyond] = buildCapabilityTargets([], "primary", "0.99.0", "hermes", "ws");
    expect(beyond?.versionBeyondValidated).toBe(true);
    const [unknown] = buildCapabilityTargets([], "primary", null, "hermes", "ws");
    expect(unknown?.versionBeyondValidated).toBeUndefined();
  });
});

describe("the overlay stops flattening: each capability answers to its own minimum", () => {
  it("a capability above the gateway's version is REFUSED", () => {
    // The load-bearing test, and the only input on which flat-grant and per-minimum
    // differ: today every Hermes minimum equals the range floor, so a table the shipped
    // manifest cannot express is what proves the mechanism is alive. Same reasoning — and
    // the same technique — as `resolveCapabilitiesFor`'s own split.
    const resolved = { capabilities: { abort: true } as Record<string, boolean> };
    applyHermesTransportOverlay(resolved, "0.18.0", "ws", {
      abort: "0.18.0",
      futureThing: "0.19.0",
    });
    expect(resolved.capabilities.abort).toBe(true);
    expect(
      resolved.capabilities.futureThing,
      "granting the whole set flat is what made the version decide nothing",
    ).toBe(false);
  });

  it("…and granted once the gateway reaches it", () => {
    const resolved = { capabilities: { abort: true } as Record<string, boolean> };
    applyHermesTransportOverlay(resolved, "0.19.0", "ws", {
      abort: "0.18.0",
      futureThing: "0.19.0",
    });
    expect(resolved.capabilities.futureThing).toBe(true);
  });

  it("an UNKNOWN version keeps the range floor, and only the floor", () => {
    // The cold-start case, which stays exactly as it was: a floor capability is granted, a
    // higher one is not. Guessing upward on an unobserved gateway is what this whole wave
    // exists to stop.
    const resolved = { capabilities: {} as Record<string, boolean> };
    applyHermesTransportOverlay(resolved, null, "ws", {
      abort: "0.18.0",
      futureThing: "0.19.0",
    });
    expect(resolved.capabilities.abort).toBe(true);
    expect(resolved.capabilities.futureThing).toBe(false);
  });

  it("a gateway BELOW the supported range still gets nothing", () => {
    // The guard the overlay already had, kept: `versionGatePassed` refused an out-of-range
    // gateway outright, and per-capability resolution must not quietly re-open it.
    const resolved = { capabilities: { abort: false } as Record<string, boolean> };
    applyHermesTransportOverlay(resolved, "0.17.0", "ws");
    expect(Object.values(resolved.capabilities).every((v) => v === false)).toBe(true);
  });

  it("REST still loses `inboundAttachments` — the transport split is unchanged", () => {
    const resolved = { capabilities: { abort: true } as Record<string, boolean> };
    applyHermesTransportOverlay(resolved, "0.19.0", "rest");
    expect(resolved.capabilities.inboundAttachments).toBeUndefined();
  });

  it("the SHIPPED table is unaffected — no capability moves at the current versions", () => {
    // The safety assertion: every Hermes minimum is the range floor today, so switching
    // from flat-grant to per-minimum must be a no-op on the real manifest. A regression
    // here would gate a working panel shut.
    for (const version of ["0.18.0", "0.18.2", "0.19.0"]) {
      const flat = { capabilities: { abort: true } as Record<string, boolean> };
      applyHermesTransportOverlay(flat, version, "ws");
      expect(
        Object.values(flat.capabilities).every((v) => v === true),
        `every shipped Hermes capability must stay granted at ${version}`,
      ).toBe(true);
    }
  });
});

describe("the range the overlay resolves against is the manifest's own", () => {
  it("it is not a second copy of the supported range", () => {
    // Two copies of "which versions are supported" would drift, and the drift would show
    // up as capabilities appearing or vanishing for reasons nobody could trace.
    const resolved = resolveCapabilitiesFor(
      HERMES_RANGE,
      { abort: "0.18.0", futureThing: "0.19.0" },
      "0.18.0",
    );
    expect(resolved.capabilities.futureThing).toBe(false);
  });
});

// ── The scheme, and which observer is current ──
//
// Both raised in review, and the first is the dangerous one.
//
// Hermes publishes TWO version schemes for one build: the semver in `pyproject` (`0.19.0`)
// and the git tag (`v2026.7.20`). A calendar major parses as a perfectly valid semver and
// compares as astronomically beyond anything validated — so a first-character guard would
// have let an upstream field change silently republish the gateway as beyond-validated,
// light the banner, and report a version the gateway is not running (G-57's hazard).
//
// The second is about currency, not correctness: `session.info` updates the registry the
// moment a turn runs, while `lastGatewayVersion` is a snapshot taken by the discovery poll.
// Reading the snapshot alone left `/capabilities` serving the pre-restart version until the
// next poll came round.

describe("only a version in the manifest's own scheme is published", () => {
  it("the semver Hermes actually reports is accepted", () => {
    for (const v of ["0.18.0", "0.18.2", "0.19.0", "0.20.0", "0.19.0-beta.1"]) {
      expect(isHermesVersionScheme(v), v).toBe(true);
    }
  });

  it("the CALENDAR tag of the same build is refused", () => {
    // `v2026.7.20` is the tag for 0.19.0. Comparing the two schemes is meaningless, and
    // the comparison silently succeeds — which is exactly why it has to be refused here.
    expect(isHermesVersionScheme("2026.7.20")).toBe(false);
    expect(isHermesVersionScheme("2026.6.11")).toBe(false);
  });

  it("the NEXT major is accepted, and reported honestly as beyond validated", () => {
    // Fail-closed must not mean fail-blind: a genuine 1.0.0 is what the banner exists for.
    expect(isHermesVersionScheme("1.0.0")).toBe(true);
    const [target] = buildCapabilityTargets([], "primary", "1.0.0", "hermes", "ws");
    expect(target?.versionBeyondValidated).toBe(true);
  });

  it("a major further out fails CLOSED", () => {
    expect(isHermesVersionScheme("2.0.0")).toBe(false);
  });

  it("garbage and emptiness are refused, as before", () => {
    for (const v of ["", "unknown", "0.19.0junk", "1.bad", "v0.19.0", "0.19"]) {
      expect(isHermesVersionScheme(v), v).toBe(false);
    }
  });
});

describe("the reader publishes nothing it cannot read", () => {
  it("a calendar-scheme version never reaches the manifest", async () => {
    const registry = new StubClientRegistry(wsClient());
    const turn = await turnOn(registry);
    // The upstream tag, arriving in the field the semver used to occupy.
    turn.lane("session.info", {
      version: "2026.7.20",
      stored_session_id: WS_STORED,
    });
    turn.lane("message.complete", { text: "ok", status: "complete" });
    await turn.done;
    expect(
      (await discoverHermesAgents(WS_CFG, registry)).gatewayVersion,
      "publishing this would report a version the gateway is not running",
    ).toBeNull();
  });

  it("a good version after a refused one still lands", async () => {
    // Order independence: a refusal must not poison the observer.
    const registry = new StubClientRegistry(wsClient());
    const turn = await turnOn(registry);
    turn.lane("session.info", { version: "2026.7.20", stored_session_id: WS_STORED });
    turn.lane("session.info", { version: "0.19.0", stored_session_id: WS_STORED });
    turn.lane("message.complete", { text: "ok", status: "complete" });
    await turn.done;
    expect((await discoverHermesAgents(WS_CFG, registry)).gatewayVersion).toBe("0.19.0");
  });
});

describe("which observer /capabilities believes", () => {
  it("the LIVE observation beats the discovery snapshot", () => {
    // The restart case: the gateway came back as 0.19.0, a turn observed it, and the poll
    // has not run since. Serving 0.18.2 here is serving a version that no longer exists.
    expect(
      resolveInstanceVersion({ seen: true, version: "0.19.0" }, "0.18.2", "0.18.0"),
    ).toBe("0.19.0");
  });

  it("the snapshot covers the cold start, when no turn has run", () => {
    expect(
      resolveInstanceVersion({ seen: false, version: null }, "0.18.2", "0.18.0"),
    ).toBe("0.18.2");
  });

  it("and the configured fallback covers a bridge that has neither", () => {
    expect(
      resolveInstanceVersion({ seen: false, version: null }, null, "0.18.0"),
    ).toBe("0.18.0");
    expect(
      resolveInstanceVersion({ seen: false, version: null }, null, null),
    ).toBeNull();
  });
});

/** Stand a Hermes HTTP gateway up in the fetch layer for the REST discovery path, which
 *  builds its own client from the config and cannot be handed a stub. */
async function withStubbedHermesHttp<T>(
  reply: { models: string[]; version: string },
  body: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ data: reply.models.map((id) => ({ id })) }),
        { status: 200 },
      );
    }
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok", version: reply.version }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

// ── One rule, every door — and an observation that CONTRADICTS is still an observation ──
//
// Both raised in the second review pass.
//
// The scheme rule lived in the WS reader, so the REST discovery branch — which returns
// `health.version` straight through — could publish the very calendar tag the WS side
// refuses. A rule enforced at one of two doors is not a rule.
//
// And a refused observation used to change nothing: after a valid 0.19.0, a `session.info`
// reporting an unreadable 2.0.0 only emitted drift, so the bridge kept publishing 0.19.0
// and its capability set for a gateway that had just told it otherwise. That is the
// fail-open the ratchet exists to prevent. Once a turn has looked, its answer is
// authoritative — INCLUDING when the answer is "I cannot read this version".

describe("the scheme rule holds at every door", () => {
  it("REST discovery refuses the calendar tag from /health", async () => {
    const restCfg = {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const seen = await withStubbedHermesHttp(
      { models: ["hermes-agent"], version: "2026.7.20" },
      () => discoverHermesAgents(restCfg),
    );
    expect(
      seen.gatewayVersion,
      "the WS reader refuses this exact string — the REST door cannot be laxer",
    ).toBeNull();
  });

  it("…and accepts a real one", async () => {
    const restCfg = {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const seen = await withStubbedHermesHttp(
      { models: ["hermes-agent"], version: "0.19.0" },
      () => discoverHermesAgents(restCfg),
    );
    expect(seen.gatewayVersion).toBe("0.19.0");
  });
});

describe("an unreadable version RETIRES the one before it", () => {
  it("0.19.0 then 2.0.0: discovery reports unknown, not the stale 0.19.0", async () => {
    const registry = new StubClientRegistry(wsClient());
    const first = await turnOn(registry);
    first.lane("session.info", { version: "0.19.0", stored_session_id: WS_STORED });
    first.lane("message.complete", { text: "ok", status: "complete" });
    await first.done;
    expect((await discoverHermesAgents(WS_CFG, registry)).gatewayVersion).toBe("0.19.0");

    // The gateway was upgraded to a major this bridge has never validated.
    const second = await turnOn(registry);
    second.lane("session.info", { version: "2.0.0", stored_session_id: WS_STORED });
    second.lane("message.complete", { text: "ok", status: "complete" });
    await second.done;
    expect(
      (await discoverHermesAgents(WS_CFG, registry)).gatewayVersion,
      "publishing 0.19.0's capabilities for a 2.0.0 gateway is the fail-open the ratchet exists to stop",
    ).toBeNull();
  });

  it("a refused observation also suppresses the discovery SNAPSHOT", () => {
    // The snapshot is older by construction, so falling back to it would undo the
    // retirement the live observation just decided.
    expect(
      resolveInstanceVersion({ seen: true, version: null }, "0.19.0", "0.18.0"),
    ).toBeNull();
  });

  it("no observation yet still falls through to the snapshot", () => {
    // The cold start, unchanged: nothing has looked, so the older sources are all there is.
    expect(
      resolveInstanceVersion({ seen: false, version: null }, "0.19.0", "0.18.0"),
    ).toBe("0.19.0");
  });

  it("and a valid observation still wins over both", () => {
    expect(
      resolveInstanceVersion({ seen: true, version: "0.19.0" }, "0.18.2", "0.18.0"),
    ).toBe("0.19.0");
  });
});

// ── Absent is not empty ──
//
// The third review pass asked for the callback to fire on every `session.info`, absent field
// included. Checked against the source first, and that would have been a regression:
// `session.info` is NOT always built by `_session_info`. When a session has no agent yet the
// lazy emitters send `{cwd, branch, project, lazy}` with no `version` at all
// (tui_gateway/server.py:4450, :4585, :6551) — several times per session. Reporting `null`
// on those would retire a perfectly good observation again and again.
//
// So the rule is PRESENCE, not truthiness: a frame that carries the field decides, a frame
// that does not carry it says nothing.

describe("a session.info decides about the version only if it carries one", () => {
  it("an EMPTY version retires the one before it", async () => {
    // `info["version"] = ""` is the literal default upstream writes when its version import
    // fails. The field is there, so it is an answer: we no longer know the version.
    const registry = new StubClientRegistry(wsClient());
    const first = await turnOn(registry);
    first.lane("session.info", { version: "0.19.0", stored_session_id: WS_STORED });
    first.lane("message.complete", { text: "ok", status: "complete" });
    await first.done;
    expect((await discoverHermesAgents(WS_CFG, registry)).gatewayVersion).toBe("0.19.0");

    const second = await turnOn(registry);
    second.lane("session.info", { version: "", stored_session_id: WS_STORED });
    second.lane("message.complete", { text: "ok", status: "complete" });
    await second.done;
    expect(
      (await discoverHermesAgents(WS_CFG, registry)).gatewayVersion,
      "the gateway stopped telling us its version — publishing the old one is a guess",
    ).toBeNull();
  });

  it("a LAZY session.info leaves the observation alone", async () => {
    // The exact lean payload the no-agent emitters send, `lazy: true` included — the flag
    // is what tells them from the full builder, which never sets it. Retiring on this would
    // make the version flicker to unknown several times per session.
    const registry = new StubClientRegistry(wsClient());
    const first = await turnOn(registry);
    first.lane("session.info", { version: "0.19.0", stored_session_id: WS_STORED });
    first.lane("message.complete", { text: "ok", status: "complete" });
    await first.done;

    const second = await turnOn(registry);
    second.lane("session.info", {
      cwd: "/w",
      branch: "main",
      project: null,
      lazy: true,
    });
    second.lane("message.complete", { text: "ok", status: "complete" });
    await second.done;
    expect(
      (await discoverHermesAgents(WS_CFG, registry)).gatewayVersion,
      "a frame that says nothing about the version must not unsay what we know",
    ).toBe("0.19.0");
  });

  it("a FULL session.info that stops carrying the field DOES retire it", async () => {
    // The other direction, and the sharper one: a gateway upgrade — or a protocol change —
    // that emits a complete `session.info` without `version` was leaving the previous
    // version in place, so the manifest, the banner and the gates went on describing a
    // gateway that had been replaced. Absence on a non-lazy frame is an answer.
    const registry = new StubClientRegistry(wsClient());
    const first = await turnOn(registry);
    first.lane("session.info", { version: "0.19.0", stored_session_id: WS_STORED });
    first.lane("message.complete", { text: "ok", status: "complete" });
    await first.done;

    const second = await turnOn(registry);
    second.lane("session.info", {
      model: "gpt-5.5",
      cwd: "/w",
      branch: "main",
      stored_session_id: WS_STORED,
    });
    second.lane("message.complete", { text: "ok", status: "complete" });
    await second.done;
    expect(
      (await discoverHermesAgents(WS_CFG, registry)).gatewayVersion,
      "publishing a version the gateway no longer names is the fail-open, one layer up",
    ).toBeNull();
  });
});

describe("the REST poll records its answer, refusal included", () => {
  it("a reachable /health reporting a refused version is an OBSERVATION", async () => {
    const restCfg = {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const seen = await withStubbedHermesHttp(
      { models: ["hermes-agent"], version: "2026.7.20" },
      () => discoverHermesAgents(restCfg),
    );
    expect(seen.gatewayVersion).toBeNull();
    expect(
      seen.versionObserved,
      "the gateway ANSWERED — that has to retire whatever the cache held",
    ).toBe(true);
  });

  it("an unreachable /health is NOT an observation", async () => {
    const restCfg = {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "hermes-agent" }] }), {
          status: 200,
        });
      }
      throw new Error("connection refused");
    }) as typeof globalThis.fetch;
    try {
      const seen = await discoverHermesAgents(restCfg);
      expect(seen.gatewayVersion).toBeNull();
      expect(
        seen.versionObserved,
        "silence is not an answer: a down /health must leave a known version standing",
      ).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("a reachable /health that names NO version is still an answer", async () => {
    // The case a neutralization exposed as unpinned. `/health` is the only version source on
    // this transport, and Atrium's client deliberately tolerates a version-less body (a
    // plain "ok" is a valid reply). So a gateway that answers without naming a version has
    // told us something: we no longer know it. Treating that as "no answer" would keep
    // publishing a version the gateway has stopped confirming.
    const restCfg = {
      transport: "rest",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "hermes-agent" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const seen = await discoverHermesAgents(restCfg);
      expect(seen.gatewayVersion).toBeNull();
      expect(seen.versionObserved).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ── The third door: the version an OPERATOR configured ──
//
// Raised in the fifth review pass, and it is the one most likely to be got wrong in the
// field: `gatewayVersionFallback` takes the generic three-number grammar, and `2026.7.20`
// is exactly what anyone reads off the upstream repo — it is the git tag of 0.19.0. On a
// cold Hermes instance (no turn yet, no reachable /health) that value went straight to
// `/capabilities`, lit the beyond-validated banner, and resolved every gate against a
// scheme the manifest is not written in.
//
// Driven through the REAL HTTP route, because the point is which SOURCE production reads —
// handing a version to `buildCapabilityTargets` would assume the very step under test.

describe("GET /capabilities: a Hermes instance's configured version is filtered too", () => {
  const hermesConfig = (fallback: string): BridgeConfig =>
    ({
      openclawGatewayUrl: "http://127.0.0.1:1",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawToken: "t",
      deviceIdentity: { id: "d", publicKey: "pk", privateKey: "sk" },
      bridgeInstanceSecret: null,
      instanceName: "hermes-inst",
      kind: "hermes",
      transport: "ws",
      gatewayVersionFallback: fallback,
      bridgeSharedSecret: "shared-secret",
      convexHttpActionsUrl: "http://convex.invalid",
      convexIngestSecret: "s",
      deltaFlushMs: 150,
      port: 0,
      maxBodyBytes: 4096,
      mediaOutboundDir: "/tmp/mo",
      mediaOutboundAgentMount: "/tmp/mo",
      inboundTtlMs: 1000,
    }) as unknown as BridgeConfig;

  const capabilitiesWith = async (
    fallback: string,
  ): Promise<{ gatewayVersion: string | null; beyond: boolean }> => {
    const cfg = hermesConfig(fallback);
    const served = servedMap(cfg);
    const server = createBridgeServer({
      shared: sharedFromConfig(cfg),
      served,
      registry: new SessionRegistry(served),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((res) => server.listen(0, res));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      const body = (await res.json()) as {
        targets?: Array<{
          instanceName: string | null;
          gatewayVersion: string | null;
          versionBeyondValidated?: true;
        }>;
      };
      const t = (body.targets ?? []).find((x) => x.instanceName === "hermes-inst");
      return {
        gatewayVersion: t?.gatewayVersion ?? null,
        beyond: t?.versionBeyondValidated === true,
      };
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  };

  it("the calendar TAG configured by hand does not reach the compat surface", async () => {
    const seen = await capabilitiesWith("2026.7.20");
    expect(
      seen.gatewayVersion,
      "an operator copying the upstream tag must not silently republish it as a version",
    ).toBeNull();
    expect(seen.beyond, "and it must not light the beyond-validated banner").toBe(false);
  });

  it("a real configured version is still honoured", async () => {
    const seen = await capabilitiesWith("0.19.0");
    expect(seen.gatewayVersion).toBe("0.19.0");
    expect(seen.beyond).toBe(false);
  });
});
