import { describe, expect, test } from "vitest";
import { parseDispatchEvidence } from "./anomalyEvidence";

describe("the anomaly row hands the hint its agent and provider", () => {
  test("one agent and one provider fill the command; several keep the placeholders", () => {
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
