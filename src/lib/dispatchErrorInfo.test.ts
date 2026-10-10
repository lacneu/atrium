import { describe, expect, test } from "vitest";
import { dispatchErrorInfo } from "./dispatchErrorInfo";
import { m } from "@/paraglide/messages.js";

describe("dispatchErrorInfo", () => {
  test("known code -> label + actionable hint (the fixable info)", () => {
    const info = dispatchErrorInfo("AGENT_NOT_FOUND");
    expect(info.label).toBe("Agent introuvable");
    expect(info.hint).toMatch(/OPENCLAW_AGENT_ID/); // names the exact knob to fix
  });

  test("UNROUTED maps to the Settings → Users fix", () => {
    expect(dispatchErrorInfo("UNROUTED").hint).toMatch(/Override instance|groupe/i);
  });

  test("unknown code degrades to the raw code as label (never blank)", () => {
    const info = dispatchErrorInfo("SOME_FUTURE_CODE");
    expect(info.label).toBe("SOME_FUTURE_CODE");
    // Pin the EXACT fallback hint, not just "non-empty" — a regression that
    // returned a known branch's hint (or a blank) would slip past a length check.
    expect(info.hint).toBe(m.error_uncategorized_hint());
  });

  test("null/undefined -> the UNKNOWN entry, not a crash", () => {
    expect(dispatchErrorInfo(undefined).label).toBe("Cause inconnue");
    expect(dispatchErrorInfo(null).label).toBe("Cause inconnue");
  });
});

describe("a revoked provider credential", () => {
  test("the hint is READ-ONLY diagnosis for THAT agent, filled when known", () => {
    const info = dispatchErrorInfo("provider_auth_revoked", {
      agentId: "jerome",
      provider: "openai",
    });
    expect(info.label).not.toBe("provider_auth_revoked");
    expect(info.hint).toContain("openclaw models auth list --provider openai --agent jerome");
    expect(info.hint).toContain("openclaw models auth order get --provider openai --agent jerome");
  });

  test("it never prints a per-agent login, in any locale", () => {
    // `models auth --agent X login` writes X's OWN store (upstream
    // shared-store-bootstrap.ts:229-245): a shadow copy that masks the instance's shared
    // login. The hint diagnoses; it does not tell anyone to log in per agent.
    for (const locale of ["en", "fr"] as const) {
      const hint = m.error_provider_auth_revoked_hint(
        { agentId: "jerome", provider: "openai" },
        { locale },
      );
      expect(hint, locale).not.toMatch(/\blogin --provider\b|auth --agent \S+ login/);
      expect(hint, locale).toContain("openclaw models auth order get --provider openai --agent jerome");
    }
  });

  test("placeholders, never a guess, when the anomaly did not name one agent", () => {
    expect(dispatchErrorInfo("provider_auth_revoked").hint).toContain(
      "openclaw models auth list --provider <provider> --agent <agentId>",
    );
  });
});

describe("the anomaly row hands the hint its agent and provider", () => {
  test("one agent and one provider fill the command; several keep the placeholders", async () => {
    const { parseDispatchEvidence } = await import("@/chat/admin/anomalyEvidence");
    const one = parseDispatchEvidence({
      kind: "assistant.cause.provider_auth_revoked",
      evidence: JSON.stringify({
        cause: "provider_auth_revoked",
        agents: ["ataraxis/jerome"],
        providers: ["openai"],
        sampleCorrelationId: "c:r",
      }),
    });
    expect(one.dominantCode).toBe("provider_auth_revoked");
    expect(one.context).toEqual({ agentId: "jerome", provider: "openai" });
    expect(one.sampleCorrelationId).toBe("c:r");
    const two = parseDispatchEvidence({
      kind: "assistant.cause.provider_auth_revoked",
      evidence: JSON.stringify({
        cause: "provider_auth_revoked",
        agents: ["ataraxis/jerome", "ataraxis/fabien"],
        providers: ["openai"],
      }),
    });
    expect(two.context).toEqual({ provider: "openai" });
    // Another per-cause class keeps its "—" cell (unchanged).
    expect(
      parseDispatchEvidence({
        kind: "assistant.cause.rate_limit",
        evidence: JSON.stringify({ cause: "rate_limit" }),
      }),
    ).toEqual({});
  });
});
