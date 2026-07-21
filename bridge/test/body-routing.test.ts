/**
 * Phase 2 (prod fix): the bridge routes by the REQUEST BODY, not a static env.
 * These pin the parser contract — agentId + canonical are REQUIRED on every body
 * (no env fallback, which was the "Agent <env-id> no longer exists" bug) — and the
 * M2 instance guard.
 */

import { describe, expect, it } from "vitest";

import {
  parseSendBody,
  parseResetBody,
  parseBodyRouting,
  isInstanceMismatch,
} from "../src/server.js";

const baseSend = {
  chatId: "c1",
  openclawChatId: "oc1",
  text: "hello",
  clientMessageId: "cm1",
};
const R = { agentId: "agent-b", canonical: "alice" };

describe("parseBodyRouting (required, no env fallback)", () => {
  it("extracts agentId + canonical + optional instanceName", () => {
    expect(
      parseBodyRouting({ agentId: "agent-b", canonical: "alice", instanceName: "admin" }),
    ).toEqual({ agentId: "agent-b", canonical: "alice", instanceName: "admin" });
  });

  it("defaults instanceName to null when absent", () => {
    expect(parseBodyRouting({ agentId: "agent-b", canonical: "alice" })).toEqual({
      agentId: "agent-b",
      canonical: "alice",
      instanceName: null,
    });
  });

  it("returns null when agentId or canonical is missing/empty", () => {
    expect(parseBodyRouting({ canonical: "alice" })).toBeNull();
    expect(parseBodyRouting({ agentId: "agent-b" })).toBeNull();
    expect(parseBodyRouting({ agentId: "", canonical: "alice" })).toBeNull();
    expect(parseBodyRouting({ agentId: "agent-b", canonical: "" })).toBeNull();
    expect(parseBodyRouting({ agentId: 7, canonical: "alice" })).toBeNull();
  });
});

describe("parseSendBody routing", () => {
  it("carries the routed agentId + canonical from the body", () => {
    const body = parseSendBody(JSON.stringify({ ...baseSend, ...R, instanceName: "admin" }));
    expect(body).toMatchObject({
      chatId: "c1",
      agentId: "agent-b",
      canonical: "alice",
      instanceName: "admin",
    });
  });

  it("rejects a send with NO routing (no fallback to a stale env agent)", () => {
    expect(parseSendBody(JSON.stringify(baseSend))).toBeNull();
  });
});

describe("parseResetBody routing", () => {
  it("requires routing", () => {
    expect(parseResetBody(JSON.stringify({ chatId: "c1" }))).toBeNull();
    expect(parseResetBody(JSON.stringify({ chatId: "c1", ...R }))).toMatchObject({
      chatId: "c1",
      agentId: "agent-b",
      canonical: "alice",
    });
  });

  it("parses the PANEL refuseIfActive flag (strict true; absent/other = false)", () => {
    // The execution-time reset guard: only an explicit true arms the 409
    // turn_active refusal — a regenerate body (no flag) must never be refused.
    expect(
      parseResetBody(
        JSON.stringify({ chatId: "c1", refuseIfActive: true, ...R }),
      )?.refuseIfActive,
    ).toBe(true);
    expect(
      parseResetBody(JSON.stringify({ chatId: "c1", ...R }))?.refuseIfActive,
    ).toBe(false);
    expect(
      parseResetBody(
        JSON.stringify({ chatId: "c1", refuseIfActive: "yes", ...R }),
      )?.refuseIfActive,
    ).toBe(false);
  });
});

describe("isInstanceMismatch (M2 guard, opt-in)", () => {
  it("is skipped when the bridge declares no instance", () => {
    expect(isInstanceMismatch(null, "family")).toBe(false);
  });

  it("is skipped when the body omits an instance (cannot compare)", () => {
    expect(isInstanceMismatch("admin", null)).toBe(false);
  });

  it("allows a matching instance", () => {
    expect(isInstanceMismatch("admin", "admin")).toBe(false);
  });

  it("REJECTS a body claiming a different instance than the bridge serves", () => {
    expect(isInstanceMismatch("admin", "family")).toBe(true);
  });
});
