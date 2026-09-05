/// <reference types="vitest" />
//
// An ownerless `models.list` returns NOTHING on a multi-agent gateway.
//
// Gateway 2026.8.1 refuses a request with no explicit owner on a multi-agent
// roster: `INVALID_REQUEST: Multiple agents are configured, but this Gateway
// request has no explicit owner. Set agentId to one of the configured agents.`
// Observed live on the bench, with the model picker as the casualty — and
// SILENTLY: ensureAvailableModels catches, logs "non-fatal", and caches an empty
// roster. Nothing surfaces; the user just sees no models.

import { describe, expect, it } from "vitest";

import { ensureAvailableModels, modelsListTakesOwner, resolveModelsOwner } from "../src/server.js";

/** A gateway whose answer DEPENDS on the requested owner — the shape 2026.8.1+
 *  actually has (`agentId` selects a visibility scope). */
function perOwnerConnSpy(byOwner: Record<string, { id: string }[]>, failFor?: string) {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    conn: {
      gatewayVersion: "2026.8.1",
      modelsByOwner: new Map(),
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        const owner = (params as { agentId?: string } | undefined)?.agentId ?? "";
        if (failFor !== undefined && owner === failFor) throw new Error("boom");
        return { payload: { models: byOwner[owner] ?? [] } };
      },
    } as never,
  };
}

function connSpy(
  models: { id: string }[],
  gatewayVersion: string | null = "2026.8.1",
  rejectParams?: (params: unknown) => boolean,
) {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    conn: {
      gatewayVersion,
      modelsByOwner: new Map(),
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (rejectParams?.(params)) throw new Error("INVALID_REQUEST");
        return { payload: { models } };
      },
    } as never,
  };
}

describe("one catalogue per OWNER, never one for the connection", () => {
  it("does not serve Alice's catalogue to Bob (codex)", async () => {
    // The answer is a per-agent VISIBILITY scope. One cache per connection meant the
    // first agent asked decided what every other chat could see.
    const { conn, calls } = perOwnerConnSpy({
      alice: [{ id: "openai/gpt-5.5" }],
      bob: [{ id: "anthropic/claude-fable-5.1" }],
    });
    const a = await ensureAvailableModels(conn, "alice");
    const b = await ensureAvailableModels(conn, "bob");
    expect(a.map((m) => m.id)).toEqual(["openai/gpt-5.5"]);
    expect(b.map((m) => m.id)).toEqual(["anthropic/claude-fable-5.1"]);
    expect(calls).toHaveLength(2); // one round trip each, then cached
    expect(await ensureAvailableModels(conn, "alice")).toEqual(a);
    expect(calls).toHaveLength(2);
  });

  it("a failure for Alice does not empty Bob's picker (codex)", async () => {
    const { conn } = perOwnerConnSpy(
      { bob: [{ id: "anthropic/claude-fable-5.1" }] },
      "alice",
    );
    expect(await ensureAvailableModels(conn, "alice")).toEqual([]);
    expect((await ensureAvailableModels(conn, "bob")).map((m) => m.id)).toEqual([
      "anthropic/claude-fable-5.1",
    ]);
  });

  it("UNKNOWN version: the owner-scoped retry is not filed connection-wide (codex)", async () => {
    // The ownerless form goes first, the gateway refuses it, and the retry answers FOR
    // ALICE. Filing that under the connection-wide key served it to Bob.
    const calls: { params: unknown }[] = [];
    const conn = {
      gatewayVersion: null,
      modelsByOwner: new Map(),
      request: async (_m: string, params: unknown) => {
        calls.push({ params });
        const owner = (params as { agentId?: string } | undefined)?.agentId;
        if (owner === undefined) throw new Error("INVALID_REQUEST: no explicit owner");
        return { payload: { models: [{ id: `model-for-${owner}` }] } };
      },
    } as never;
    const a = await ensureAvailableModels(conn, "alice");
    const b = await ensureAvailableModels(conn, "bob");
    expect(a.map((m) => m.id)).toEqual(["model-for-alice"]);
    expect(b.map((m) => m.id)).toEqual(["model-for-bob"]);
  });
  it("UNKNOWN version: Alice failing on BOTH forms does not empty Bob's picker (codex)", async () => {
    const conn = {
      gatewayVersion: null,
      modelsByOwner: new Map(),
      request: async (_m: string, params: unknown) => {
        const owner = (params as { agentId?: string } | undefined)?.agentId ?? "";
        if (owner !== "bob") throw new Error("boom");
        return { payload: { models: [{ id: "model-for-bob" }] } };
      },
    } as never;
    expect(await ensureAvailableModels(conn, "alice")).toEqual([]);
    expect((await ensureAvailableModels(conn, "bob")).map((m) => m.id)).toEqual([
      "model-for-bob",
    ]);
  });
  it("a cached FAILURE expires, instead of emptying the picker until restart", async () => {
    // The 2026-08-04 symptom: an empty model picker, no message, until the bridge was
    // restarted. A failure is remembered briefly, not forever.
    const { conn, calls } = perOwnerConnSpy({ alice: [{ id: "openai/gpt-5.5" }] }, "alice");
    expect(await ensureAvailableModels(conn, "alice")).toEqual([]);
    expect(await ensureAvailableModels(conn, "alice")).toEqual([]);
    expect(calls, "the failure is cached, not retried on every turn").toHaveLength(1);
    const entry = (conn as unknown as {
      modelsByOwner: Map<string, { failedAt: number | null }>;
    }).modelsByOwner.get("alice");
    expect(entry?.failedAt, "a failure must be marked as one").not.toBeNull();
    entry!.failedAt = Date.now() - 10 * 60_000; // …and it ages out
    await ensureAvailableModels(conn, "alice");
    expect(calls, "an expired failure is retried").toHaveLength(2);
  });
});

describe("models.list carries its owner", () => {
  it("sends agentId when the session names one", async () => {
    const { conn, calls } = connSpy([{ id: "openai/gpt-5.5" }]);
    const models = await ensureAvailableModels(conn, "alice");
    expect(calls[0]?.method).toBe("models.list");
    expect(calls[0]?.params).toEqual({ agentId: "alice" });
    expect(models).toHaveLength(1);
  });

  it("omits it when there is none — a single-agent gateway must not be handed a made-up owner", async () => {
    const { conn, calls } = connSpy([{ id: "openai/gpt-5.5" }]);
    await ensureAvailableModels(conn, null);
    expect(calls[0]?.params).toEqual({});
  });
});

describe("the owner is resolved from the routed body when describe omits it (codex P2)", () => {
  // SessionRow.agentId is OPTIONAL on 2026.8.x: a valid `sessions.describe` may
  // omit it, while the turn's routed `agentId` is mandatory and already known.
  it("falls back to the routed agentId", () => {
    expect(resolveModelsOwner({}, "alice")).toBe("alice");
    expect(resolveModelsOwner({ agentId: undefined }, "alice")).toBe("alice");
    expect(resolveModelsOwner(null, "alice")).toBe("alice");
  });
  it("the live session's owner wins when it is named", () => {
    expect(resolveModelsOwner({ agentId: "bob" }, "alice")).toBe("bob");
  });
  it("stays ownerless only when NOBODY names an owner (single-agent gateway)", () => {
    expect(resolveModelsOwner({}, null)).toBeNull();
    expect(resolveModelsOwner({ agentId: "" }, "")).toBeNull();
  });
});

describe("the owner form follows the gateway GENERATION (codex P1, second pass)", () => {
  // <= 2026.7.x: ModelsListParamsSchema is a closed object WITHOUT agentId
  // (vendored 2026.6.11 / 2026.7.1) — sending one is refused and the picker
  // would be cached empty for the whole connection.
  it("omits the owner on a 2026.7.1 gateway even when the session names one", async () => {
    const { conn, calls } = connSpy([{ id: "m" }], "2026.7.1");
    await ensureAvailableModels(conn, "alice");
    expect(calls[0]?.params).toEqual({});
  });
  it("sends it from 2026.8.1 on", async () => {
    for (const v of ["2026.8.1", "2026.8.2", "2026.9.1-beta.1"]) {
      const { conn, calls } = connSpy([{ id: "m" }], v);
      await ensureAvailableModels(conn, "alice");
      expect(calls[0]?.params).toEqual({ agentId: "alice" });
    }
  });
  it("decides on the RAW version, not the validated ceiling", () => {
    expect(modelsListTakesOwner("2026.7.1")).toBe(false);
    expect(modelsListTakesOwner("2026.8.1")).toBe(true);
    expect(modelsListTakesOwner("2026.9.1-beta.1")).toBe(true);
    expect(modelsListTakesOwner(null)).toBeNull();
  });
  it("unknown version: the UNIVERSAL form first, then ONE owner-scoped retry", async () => {
    // The ownerless body is the one every supported generation accepts. Guessing the
    // owned form first put `agentId` on the wire for gateways whose schema forbids
    // additional properties — the outbound ratchet's whole subject (codex).
    const { conn, calls } = connSpy([{ id: "m" }], null, (p) => Object.keys(p as object).length > 0);
    const models = await ensureAvailableModels(conn, "alice");
    expect(calls.map((c) => c.params)).toEqual([{}]);
    expect(models).toHaveLength(1);
  });
  it("unknown version: an ownerless REFUSAL falls back to the owner form, once", async () => {
    const { conn, calls } = connSpy(
      [{ id: "m" }],
      null,
      (p) => Object.keys(p as object).length === 0, // an owner-scoped gateway
    );
    const models = await ensureAvailableModels(conn, "alice");
    expect(calls.map((c) => c.params)).toEqual([{}, { agentId: "alice" }]);
    expect(models).toHaveLength(1);
  });
  it("known version: no second guess — a refusal stays a refusal", async () => {
    const { conn, calls } = connSpy([{ id: "m" }], "2026.8.1", () => true);
    const models = await ensureAvailableModels(conn, "alice");
    expect(calls).toHaveLength(1);
    expect(models).toEqual([]);
  });
});
