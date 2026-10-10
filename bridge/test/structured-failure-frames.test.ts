/**
 * The structured failure fields on the WIRE, read before the prose (0.91.3).
 *
 * `ChatErrorEvent.errorDetail` (packages/gateway-protocol/src/schema/logs-chat.ts
 * ChatErrorDetailSchema at v2026.9.6) is projected by the gateway from the lifecycle
 * `data.errorObservation` (src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:168-174,
 * :219 → src/gateway/server-chat.ts:738, :1219-1245); the OAuth-refresh backstop builds its
 * own (src/auto-reply/reply/agent-lifecycle-terminal.ts:126-136). Shapes below are those
 * schemas, field for field. The TEXT beside them is upstream's own copy for the same failure
 * — the hedged 401 sentence (src/agents/failover/user-copy.ts:40-43) that the text rules
 * deliberately leave unclassified — so a class here can only have come from the structure.
 *
 * Not elicitable on the bench: it takes a provider that really refuses the credential.
 * The deterministic replay is the proof (coverage manifest `ChatErrorEvent.errorDetail`).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";
import { SubAgentObserver } from "../src/providers/openclaw/sub-agent-observer.js";
import { classifyGatewayError } from "../src/core/dispatch-errors.js";

const SESSION_KEY = "agent:alice:atrium:chat:id1:id2";
const RUN = "run-structured-1";
const HEDGED_401 =
  "Authentication failed (provider returned HTTP 401). Your provider token may have expired — try the request again in a moment. If the failure persists, re-authenticate this provider.";

class Clock {
  now = 1000.0;
  tick(seconds = 0.01): number {
    this.now += seconds;
    return this.now;
  }
}

function start(): { n: Normalizer; clock: Clock } {
  const n = new Normalizer(SESSION_KEY, null);
  const clock = new Clock();
  n.beginTurn(clock.now);
  n.noteRunStarted(RUN, clock.now);
  return { n, clock };
}

const chat = (payload: Record<string, unknown>) => ({
  type: "event",
  event: "chat",
  payload: { runId: RUN, sessionKey: SESSION_KEY, seq: 5, ...payload },
});
const lifecycle = (data: Record<string, unknown>) => ({
  type: "event",
  event: "agent",
  payload: { runId: RUN, sessionKey: SESSION_KEY, stream: "lifecycle", data },
});

function finalOf(events: BridgeEvent[]): { errorKind?: string; error?: string } | undefined {
  return events.find((e) => e.type === "message.final") as
    | { errorKind?: string; error?: string }
    | undefined;
}
function statusOf(events: BridgeEvent[]): string | undefined {
  return (events.find((e) => e.type === "run.status") as { status?: string } | undefined)?.status;
}

describe("chat state:error — errorDetail decides before the text", () => {
  it("auth + 401 is the revoked credential, whatever the hedged sentence says", () => {
    const { n, clock } = start();
    const events = n.feed(
      chat({
        state: "error",
        errorMessage: HEDGED_401,
        errorDetail: {
          provider: "openai",
          model: "gpt-5.6-sol",
          failoverReason: "auth",
          providerRuntimeFailureKind: "auth_invalid_token",
          httpStatus: 401,
        },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("provider_auth_revoked");
    // Without the structure, the same sentence stays unclassified (the hedge).
    const bare = start();
    const plain = bare.n.feed(chat({ state: "error", errorMessage: HEDGED_401 }), bare.clock.tick());
    expect(finalOf(plain)?.errorKind ?? null).toBeNull();
  });

  it("auth + 403 is a permission refusal, not the expired-access card", () => {
    const { n, clock } = start();
    const events = n.feed(
      chat({
        state: "error",
        errorMessage: "openai isn't accepting your saved login.",
        errorDetail: { failoverReason: "auth", httpStatus: 403 },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("provider_permission_denied");
  });

  it("billing and model_not_found reach their own classes; overloaded is transient", () => {
    for (const [detail, expected] of [
      [{ failoverReason: "billing", httpStatus: 402 }, "provider_billing"],
      [{ failoverReason: "model_not_found", httpStatus: 404 }, "model_not_found"],
      [{ failoverReason: "overloaded", httpStatus: 529 }, "provider_internal"],
    ] as const) {
      const { n, clock } = start();
      const events = n.feed(
        chat({ state: "error", errorMessage: "LLM request failed.", errorDetail: detail }),
        clock.tick(),
      );
      expect(finalOf(events)?.errorKind, expected).toBe(expected);
    }
  });

  it("the gateway's `timeout` terminal fact still outranks the provider observation", () => {
    const { n, clock } = start();
    const events = n.feed(
      chat({
        state: "error",
        errorMessage: "Request timed out before a response was generated.",
        errorKind: "timeout",
        errorDetail: { failoverReason: "auth", httpStatus: 401 },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("timeout");
  });

  it("an empty or foreign errorDetail leaves the decision to the text, as before", () => {
    const { n, clock } = start();
    const events = n.feed(
      chat({
        state: "error",
        errorMessage: "maximum context length exceeded",
        errorDetail: { provider: "openai", providerErrorMessagePreview: "401 revoked token" },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("context_length");
  });
});

describe("lifecycle phase:error — errorObservation decides before the text", () => {
  it("the OAuth-refresh backstop's observation names the revoked login", () => {
    const { n, clock } = start();
    const events = n.feed(
      lifecycle({
        phase: "error",
        error: "⚠️ OAuth refresh failed.",
        errorObservation: {
          provider: "openai-codex",
          failoverReason: "invalid_grant",
          providerRuntimeFailureKind: "auth_refresh",
          httpStatus: 400,
        },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("provider_auth_revoked");
  });

  it("an embedded run's observation (failoverReason auth_permanent) is a permission refusal", () => {
    const { n, clock } = start();
    const events = n.feed(
      lifecycle({
        phase: "error",
        error: "LLM request failed.",
        errorObservation: { failoverReason: "auth_permanent", httpStatus: 401 },
      }),
      clock.tick(),
    );
    expect(finalOf(events)?.errorKind).toBe("provider_permission_denied");
  });
});

describe("chat state:aborted with stopReason auth-revoked — a labelled end, not a Stop", () => {
  it("finalizes as the provider-access-removed error, never `aborted`", () => {
    const { n, clock } = start();
    const events = n.feed(chat({ state: "aborted", stopReason: "auth-revoked" }), clock.tick());
    expect(statusOf(events)).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("provider_access_removed");
    expect(finalOf(events)?.error).toBe("provider_access_removed");
  });

  it("every other abort still reads as the reader's Stop", () => {
    for (const stopReason of ["rpc", "stop", undefined]) {
      const { n, clock } = start();
      const events = n.feed(
        chat({ state: "aborted", ...(stopReason ? { stopReason } : {}) }),
        clock.tick(),
      );
      expect(statusOf(events), String(stopReason)).toBe("aborted");
    }
  });
});

describe("a sub-agent's chat error — the same structured read", () => {
  type Frame = Record<string, any>;
  const FRAMES: Frame[] = readFileSync(
    new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { frame: Frame }).frame);
  const PARENT = "agent:id2:atrium:chat:id3-id4:id5-id6";
  const CHILD = "agent:id9:subagent:00000000-0000-4000-8000-000000000010";
  const pick = (pred: (f: Frame) => boolean): Frame => {
    const f = FRAMES.find(pred);
    if (f === undefined) throw new Error("golden frame not found");
    return structuredClone(f);
  };

  function childTerminal(errorDetail: unknown, errorMessage = HEDGED_401) {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(
      pick(
        (x) =>
          x.payload?.stream === "tool" &&
          x.payload?.data?.name === "sessions_spawn" &&
          x.payload?.data?.phase === "start",
      ),
      100,
      "msgA",
    );
    obs.observe(
      pick(
        (x) =>
          x.payload?.stream === "tool" &&
          x.payload?.data?.name === "sessions_spawn" &&
          x.payload?.data?.phase === "result",
      ),
      101,
      "msgA",
    );
    const err = pick(
      (x) => x.event === "chat" && x.payload?.sessionKey === CHILD && x.payload?.state === "final",
    );
    err.payload.state = "error";
    delete err.payload.message;
    err.payload.errorMessage = errorMessage;
    if (errorDetail !== undefined) err.payload.errorDetail = errorDetail;
    return obs
      .observe(err, 1000)
      .find((u) => u.childSessionKey === CHILD && u.status === "error");
  }

  it("classes a child's 401 from errorDetail, where the text alone says nothing", () => {
    expect(childTerminal({ failoverReason: "auth", httpStatus: 401 })?.errorCode).toBe(
      "provider_auth_revoked",
    );
    expect(childTerminal(undefined)?.errorCode).toBeUndefined();
  });
});

describe("the dispatch door names the same three credential classes", () => {
  it("revoked, permission, unnamed — never the bridge's own AUTH_TOKEN_MISMATCH", () => {
    expect(
      classifyGatewayError(new Error("401: Encountered invalidated oauth token for user")),
    ).toBe("provider_auth_revoked");
    expect(
      classifyGatewayError(
        new Error(
          "403 Forbidden: unsupported_country_region_territory. Re-authenticate with: openclaw models auth login --provider 'openai' --force",
        ),
      ),
    ).toBe("provider_permission_denied");
    expect(
      classifyGatewayError(
        new Error("Re-authenticate with: openclaw models auth login --provider 'openai' --force"),
      ),
    ).toBe("provider_auth_failed");
    // A proxy's 403 on the bridge's OWN link is not a provider's refusal: no hint, no class.
    expect(classifyGatewayError(new Error("Unexpected server response: 403 Forbidden"))).not.toBe(
      "provider_permission_denied",
    );
    // The bridge's own pairing refusal keeps its class.
    expect(classifyGatewayError(new Error("unauthorized: token mismatch"))).toBe(
      "AUTH_TOKEN_MISMATCH",
    );
  });
});
