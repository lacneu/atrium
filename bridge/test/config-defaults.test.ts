/**
 * CONF-4d `/config-defaults`: the admin chat-defaults surface, restricted to
 * EXACTLY agents.defaults.{thinkingDefault,fastModeDefault}. Pins the strict
 * value allowlist, the defensive config.get extraction (snapshot `.config`
 * primary, flat fallback) and — load-bearing — the BENCH-VERIFIED (P3-1)
 * `config.patch` flow: get (top-level `hash`) -> patch `{raw, baseHash}` with
 * a MINIMAL raw containing nothing but the provided fields, ONE retry on a
 * "base hash" conflict, then a clear error.
 */

import { describe, expect, it } from "vitest";

import {
  defaultsApplied,
  extractAgentDefaults,
  parseConfigDefaultsBody,
  performConfigDefaultsOp,
  THINKING_DEFAULT_VALUES,
  type GatewayRequester,
} from "../src/conf.js";

/** Scripted gateway: each config.get pops a payload from a FIFO (last one
 *  repeats); config.patch can be scripted to fail per-call. */
function mockGateway(opts: {
  gets: Record<string, unknown>[];
  patchErrors?: (string | null)[];
}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const gets = [...opts.gets];
  const patchErrors = [...(opts.patchErrors ?? [])];
  const conn: GatewayRequester = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "config.get") {
        return { payload: gets.length > 1 ? gets.shift()! : gets[0]! };
      }
      if (method === "config.patch") {
        const err = patchErrors.shift() ?? null;
        if (err !== null) throw new Error(err);
        return { payload: { ok: true } };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { conn, calls };
}

describe("parseConfigDefaultsBody", () => {
  it("parses get and set (each field alone or both)", () => {
    expect(parseConfigDefaultsBody(JSON.stringify({ op: "get" }))).toEqual({
      op: "get",
      instanceName: null,
    });
    expect(
      parseConfigDefaultsBody(JSON.stringify({ op: "set", thinkingDefault: "high" })),
    ).toEqual({
      op: "set",
      instanceName: null,
      thinkingDefault: "high",
      fastModeDefault: null,
    });
    expect(
      parseConfigDefaultsBody(JSON.stringify({ op: "set", fastModeDefault: false })),
    ).toEqual({
      op: "set",
      instanceName: null,
      thinkingDefault: null,
      fastModeDefault: false,
    });
  });

  it("carries instanceName through for the route's instance guard (P2-3)", () => {
    expect(
      parseConfigDefaultsBody(JSON.stringify({ op: "get", instanceName: "main" })),
    ).toEqual({ op: "get", instanceName: "main" });
  });

  it("accepts every valid thinkingDefault value", () => {
    for (const v of THINKING_DEFAULT_VALUES) {
      expect(
        parseConfigDefaultsBody(JSON.stringify({ op: "set", thinkingDefault: v })),
      ).not.toBeNull();
    }
  });

  it("REJECTS invalid values and an empty set", () => {
    for (const thinkingDefault of ["default", "HIGH", "max", "", 3]) {
      expect(
        parseConfigDefaultsBody(JSON.stringify({ op: "set", thinkingDefault })),
      ).toBeNull();
    }
    expect(
      parseConfigDefaultsBody(JSON.stringify({ op: "set", fastModeDefault: "true" })),
    ).toBeNull();
    expect(parseConfigDefaultsBody(JSON.stringify({ op: "set" }))).toBeNull();
    expect(parseConfigDefaultsBody(JSON.stringify({ op: "patch" }))).toBeNull();
    expect(parseConfigDefaultsBody("{not json")).toBeNull();
  });
});

describe("extractAgentDefaults (defensive payload shapes)", () => {
  const DEFAULTS = { thinkingDefault: "medium", fastModeDefault: true };

  it("reads the 6.5 snapshot shape (payload.config.agents.defaults)", () => {
    expect(
      extractAgentDefaults({ config: { agents: { defaults: DEFAULTS } }, valid: true }),
    ).toEqual(DEFAULTS);
  });

  it("falls back to a flat payload.agents.defaults", () => {
    expect(extractAgentDefaults({ agents: { defaults: DEFAULTS } })).toEqual(DEFAULTS);
    // EXACT ?? semantics: a present-but-defaultless `config` still falls back.
    expect(
      extractAgentDefaults({ config: {}, agents: { defaults: DEFAULTS } }),
    ).toEqual(DEFAULTS);
  });

  it("degrades missing/shapeless payloads to nulls", () => {
    expect(extractAgentDefaults(undefined)).toEqual({
      thinkingDefault: null,
      fastModeDefault: null,
    });
    expect(extractAgentDefaults({ config: {} })).toEqual({
      thinkingDefault: null,
      fastModeDefault: null,
    });
    expect(
      extractAgentDefaults({ config: { agents: { defaults: { thinkingDefault: 3 } } } }),
    ).toEqual({ thinkingDefault: null, fastModeDefault: null });
  });
});

describe("performConfigDefaultsOp", () => {
  const PAYLOAD = {
    config: { agents: { defaults: { thinkingDefault: "low", fastModeDefault: false } } },
    hash: "h1",
  };

  it("get -> config.get, returns ONLY the two allowlisted defaults", async () => {
    const { conn, calls } = mockGateway({ gets: [PAYLOAD] });
    const res = await performConfigDefaultsOp(conn, { op: "get", instanceName: null });
    expect(calls).toEqual([{ method: "config.get", params: {} }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      defaults: { thinkingDefault: "low", fastModeDefault: false },
    });
  });

  it("set -> get(hash) -> MINIMAL config.patch {raw, baseHash}, then re-get", async () => {
    const { conn, calls } = mockGateway({ gets: [PAYLOAD] });
    await performConfigDefaultsOp(conn, {
      op: "set",
      instanceName: null,
      thinkingDefault: "high",
      fastModeDefault: null,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "config.get",
      "config.patch",
      "config.get",
    ]);
    // The patch is a JSON string under `raw` carrying NOTHING beyond the
    // allowlisted path — no fastModeDefault key when it was not provided —
    // plus the BASE HASH from the preceding get (bench-verified contract).
    expect(calls[1]!.params).toEqual({
      raw: JSON.stringify({ agents: { defaults: { thinkingDefault: "high" } } }),
      baseHash: "h1",
    });
  });

  it("set with both fields patches both, response echoes the CONFIRMED state", async () => {
    const { conn, calls } = mockGateway({ gets: [PAYLOAD] });
    const res = await performConfigDefaultsOp(conn, {
      op: "set",
      instanceName: null,
      thinkingDefault: "off",
      fastModeDefault: true,
    });
    expect(calls[1]!.params).toEqual({
      raw: JSON.stringify({
        agents: { defaults: { thinkingDefault: "off", fastModeDefault: true } },
      }),
      baseHash: "h1",
    });
    // Echo is the re-get truth (mock returns the unchanged PAYLOAD), never an
    // optimistic merge of the request.
    expect(res.body).toEqual({
      ok: true,
      defaults: { thinkingDefault: "low", fastModeDefault: false },
    });
  });

  it("retries ONCE with a FRESH hash on a base-hash conflict (P3-1)", async () => {
    const { conn, calls } = mockGateway({
      gets: [PAYLOAD, { ...PAYLOAD, hash: "h2" }],
      patchErrors: ["stale base hash", null],
    });
    const res = await performConfigDefaultsOp(conn, {
      op: "set",
      instanceName: null,
      thinkingDefault: "high",
      fastModeDefault: null,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "config.get",
      "config.patch",
      "config.get",
      "config.patch",
      "config.get",
    ]);
    expect(calls[1]!.params).toMatchObject({ baseHash: "h1" });
    expect(calls[3]!.params).toMatchObject({ baseHash: "h2" }); // re-get re-read
    expect(res.status).toBe(200);
  });

  it("a persistent base-hash conflict fails with a CLEAR error after one retry", async () => {
    const { conn, calls } = mockGateway({
      gets: [PAYLOAD],
      patchErrors: ["base hash mismatch", "base hash mismatch"],
    });
    await expect(
      performConfigDefaultsOp(conn, {
        op: "set",
        instanceName: null,
        thinkingDefault: "high",
        fastModeDefault: null,
      }),
    ).rejects.toThrow(/base-hash conflict persisted after one retry/);
    expect(calls.filter((c) => c.method === "config.patch")).toHaveLength(2);
  });

  it("a non-hash patch failure propagates WITHOUT a retry", async () => {
    const { conn, calls } = mockGateway({
      gets: [PAYLOAD],
      patchErrors: ["INVALID_REQUEST: nope"],
    });
    await expect(
      performConfigDefaultsOp(conn, {
        op: "set",
        instanceName: null,
        thinkingDefault: "high",
        fastModeDefault: null,
      }),
    ).rejects.toThrow(/INVALID_REQUEST/);
    expect(calls.filter((c) => c.method === "config.patch")).toHaveLength(1);
  });
});

describe("defaultsApplied (gateway-restart read-back confirmation)", () => {
  // Live-protocol finding (2026.6.5): config.patch can RESTART the gateway
  // (restartReason=config.patch), dropping the socket after the write APPLIED.
  // The route reconnects and reports success iff this read-back matches.
  const setBody = (
    thinkingDefault: string | null,
    fastModeDefault: boolean | null,
  ) =>
    ({ op: "set", instanceName: null, thinkingDefault, fastModeDefault }) as const;

  it("confirms when every requested field reads back as written", () => {
    expect(
      defaultsApplied(setBody("low", null), {
        thinkingDefault: "low",
        fastModeDefault: null,
      }),
    ).toBe(true);
    expect(
      defaultsApplied(setBody("low", true), {
        thinkingDefault: "low",
        fastModeDefault: true,
      }),
    ).toBe(true);
  });

  it("an unrequested field never blocks confirmation", () => {
    expect(
      defaultsApplied(setBody("low", null), {
        thinkingDefault: "low",
        fastModeDefault: false, // pre-existing value, not part of this set
      }),
    ).toBe(true);
  });

  it("refuses when a requested field did NOT land", () => {
    expect(
      defaultsApplied(setBody("low", null), {
        thinkingDefault: "high",
        fastModeDefault: null,
      }),
    ).toBe(false);
    expect(
      defaultsApplied(setBody("low", null), {
        thinkingDefault: null,
        fastModeDefault: null,
      }),
    ).toBe(false);
    expect(
      defaultsApplied(setBody(null, true), {
        thinkingDefault: null,
        fastModeDefault: false,
      }),
    ).toBe(false);
  });
});
