/// <reference types="vitest" />
// The chat's openclawChatId slot is shared with OpenClaw routing segments; only
// a REAL Hermes session id (api_<ts>_<hex>) may be reused as a Hermes session
// (codex P1) — a routing segment must mint a fresh session, not POST to a
// non-existent one.
import { describe, expect, it } from "vitest";
import { isHermesSessionId } from "../src/providers/hermes/dispatch.js";

describe("isHermesSessionId", () => {
  it("accepts the real Hermes session-id shape", () => {
    expect(isHermesSessionId("api_1783351043_b99e6df2")).toBe(true);
  });
  it("rejects OpenClaw per-turn + documentary routing segments (they carry a colon)", () => {
    expect(isHermesSessionId("turn:alice:msg_123")).toBe(false);
    expect(isHermesSessionId("documentary:msg_123")).toBe(false);
  });
  it("rejects null / empty / arbitrary strings", () => {
    expect(isHermesSessionId(null)).toBe(false);
    expect(isHermesSessionId("")).toBe(false);
    expect(isHermesSessionId("hello")).toBe(false);
  });
});

describe("HermesTurnRegistry abort targeting", () => {
  it("peek/take + deleteIf are identity-guarded (a stale cleanup keeps a newer turn)", async () => {
    const { HermesTurnRegistry } = await import("../src/providers/hermes/dispatch.js");
    const reg = new HermesTurnRegistry();
    const mk = (rid: string | null) => ({
      abort: new AbortController(),
      run: { accepted: Promise.resolve(), done: Promise.resolve(), runId: () => rid },
    });
    const t1 = mk("run-1");
    reg.set("c1", t1);
    // Old turn's stale cleanup after a newer turn registered: deleteIf must NOT
    // evict the newer entry.
    const t2 = mk("run-2");
    reg.set("c1", t2);
    reg.deleteIf("c1", t1);
    expect(reg.peek("c1")).toBe(t2);
  });
});

describe("fresh-session rotation nonces", () => {
  it("isHermesSessionId rejects rotation nonces (they must mint fresh)", async () => {
    const { isHermesSessionId } = await import("../src/providers/hermes/dispatch.js");
    expect(isHermesSessionId("summarize:chat_1:1700000000")).toBe(false);
    expect(isHermesSessionId("documentary:msg_1")).toBe(false);
    expect(isHermesSessionId("curate:agent_1:1700000000")).toBe(false);
  });
});
