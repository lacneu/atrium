// Re-hydration guard — the PROD INCIDENT fix. After a redeploy rolled the OpenClaw
// session "fresh", the bridge re-hydrated prior turns onto a chat.send; when that
// turn ALSO carried an attachment, the gateway stack-overflowed (RangeError ->
// INVALID_REQUEST) assembling prepended-history + attachment. Re-hydration alone
// and attachment alone both work — only the COMBINATION crashes. `rehydrationDecision`
// is the pure guard: on a fresh-session attachment turn it ships the bare message
// (a KNOWN best-effort gap, strictly better than crashing — no cross-turn debt state).

import { describe, expect, it } from "vitest";
import { rehydrationDecision } from "../src/server.js";

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
