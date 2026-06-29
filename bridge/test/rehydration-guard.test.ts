// Re-hydration guard — the PROD INCIDENT fix. After a redeploy rolled the OpenClaw
// session "fresh", the bridge re-hydrated prior turns onto a chat.send; when that
// turn ALSO carried an attachment, the gateway stack-overflowed (RangeError ->
// INVALID_REQUEST) assembling prepended-history + attachment. Re-hydration alone
// and attachment alone both work — only the COMBINATION crashes. `rehydrationDecision`
// is the pure guard: on a fresh-session attachment turn it ships the bare message
// (a KNOWN best-effort gap, strictly better than crashing — no cross-turn debt state).

import { describe, expect, it } from "vitest";
import { computeFreshSession, rehydrationDecision } from "../src/server.js";

const D = (freshSession: boolean, hasAttachments: boolean, enabled: boolean) =>
  rehydrationDecision({ freshSession, hasAttachments, enabled });

describe("rehydrationDecision — gateway-crash guard", () => {
  it("rehydrates on a fresh, attachment-free, enabled turn", () => {
    expect(D(true, false, true)).toBe("rehydrate");
  });

  it("SKIPS on a fresh attachment turn (the live crash) — ships the bare message", () => {
    expect(D(true, true, true)).toBe("skip_attachment");
  });

  it("the kill-switch disables re-hydration entirely (no crash risk either way)", () => {
    expect(D(true, false, false)).toBe("skip_disabled");
    expect(D(true, true, false)).toBe("skip_disabled"); // disabled wins (no prepend)
  });

  it("a warm session never re-hydrates — attachment or not", () => {
    expect(D(false, false, true)).toBe("skip_warm");
    expect(D(false, true, true)).toBe("skip_warm");
  });
});

// computeFreshSession — the MULTI-AGENT context-carryover fix. An agent SWITCH
// re-keys the gateway session (epoch segment + new agentId), so the bridge builds a
// brand-new Session (firstSendPending=true). The gateway reports a freshly-created
// webchat session's `systemSent` as TRUTHY, so the systemSent heuristic ALONE misread
// the switch as "warm" and skipped re-hydration → the new agent answered with ZERO
// context (live-reproduced: "oui" → the switched agent: "je viens d'arriver…").
describe("computeFreshSession — switch (new key) counts as fresh", () => {
  it("a RESET/rolled session (systemSent=false) is fresh — the original trigger", () => {
    expect(computeFreshSession({ systemSent: false }, false, false)).toBe(true);
    expect(computeFreshSession(undefined, false, false)).toBe(true); // no session row
  });

  it("THE FIX: a freshly-routed agent (firstSendPending) on a ROUTED switch is fresh EVEN when the gateway reports systemSent truthy", () => {
    expect(computeFreshSession({ systemSent: true }, true, /*routedSwitch*/ true)).toBe(true);
    // The gateway may even omit systemSent for a brand-new session — still fresh.
    expect(computeFreshSession({}, true, true)).toBe(true);
  });

  it("a WARM same-agent follow-up (session reused, firstSendPending already false) is NOT fresh — no wasteful re-prepend", () => {
    expect(computeFreshSession({ systemSent: true }, false, true)).toBe(false);
  });

  it("CODEX P2: a SAME-AGENT routed follow-up whose Session was REBUILT by a bridge restart (firstSendPending true) but is NOT a switch (routedSwitch false) on a warm gateway session is NOT fresh — keeps the warm session, no duplicate re-inject", () => {
    expect(
      computeFreshSession({ systemSent: true }, /*firstSendPending*/ true, /*routedSwitch*/ false),
    ).toBe(false);
  });

  it("DISCRIMINATING: drop the (firstSendPending && routedSwitch) term => the switch case regresses to NOT-fresh (the shipped bug)", () => {
    const systemSentOnly = (sess: { systemSent?: unknown } | undefined) =>
      !sess || sess.systemSent === false;
    expect(systemSentOnly({ systemSent: true })).toBe(false); // <- the regression
    expect(computeFreshSession({ systemSent: true }, true, true)).toBe(true); // <- fixed
  });
});
