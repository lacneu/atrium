import { describe, expect, test } from "vitest";
import { classifyGatewayError } from "../src/core/dispatch-errors.js";

describe("classifyGatewayError", () => {
  test("the canonical live failure: INVALID_REQUEST wrapping 'no longer exists' -> AGENT_NOT_FOUND", () => {
    // The agent rule must win over the invalid-request rule (the gateway wraps it).
    expect(
      classifyGatewayError(
        new Error('INVALID_REQUEST: Agent "main" no longer exists in configuration'),
      ),
    ).toBe("AGENT_NOT_FOUND");
  });

  test("auth / pairing rejections -> AUTH_TOKEN_MISMATCH", () => {
    expect(classifyGatewayError(new Error("AUTH_TOKEN_MISMATCH"))).toBe(
      "AUTH_TOKEN_MISMATCH",
    );
    expect(classifyGatewayError(new Error("device not paired"))).toBe(
      "AUTH_TOKEN_MISMATCH",
    );
  });

  test("OpenSSL key decode failure -> DEVICE_SIGNING_FAILED", () => {
    expect(
      classifyGatewayError(
        new Error("device signing failed: error:1E08010C:DECODER routines::unsupported"),
      ),
    ).toBe("DEVICE_SIGNING_FAILED");
  });

  test("scope refusal -> SESSION_SCOPE_DENIED", () => {
    expect(
      classifyGatewayError(new Error("operator.admin scope required")),
    ).toBe("SESSION_SCOPE_DENIED");
  });

  test("timeout -> GATEWAY_TIMEOUT", () => {
    expect(classifyGatewayError(new Error("request timed out"))).toBe(
      "GATEWAY_TIMEOUT",
    );
  });

  test("socket loss -> GATEWAY_DISCONNECTED", () => {
    expect(classifyGatewayError(new Error("socket hang up"))).toBe(
      "GATEWAY_DISCONNECTED",
    );
    expect(classifyGatewayError(new Error("connection closed"))).toBe(
      "GATEWAY_DISCONNECTED",
    );
  });

  test("a bare invalid request (no agent text) -> INVALID_REQUEST", () => {
    expect(classifyGatewayError(new Error("INVALID_REQUEST: bad params"))).toBe(
      "INVALID_REQUEST",
    );
  });

  test("anything unrecognized -> UPSTREAM_ERROR (safe fallback)", () => {
    expect(classifyGatewayError(new Error("kaboom"))).toBe("UPSTREAM_ERROR");
    expect(classifyGatewayError(null)).toBe("UPSTREAM_ERROR");
    expect(classifyGatewayError(undefined)).toBe("UPSTREAM_ERROR");
    expect(classifyGatewayError("plain string")).toBe("UPSTREAM_ERROR");
  });
});
