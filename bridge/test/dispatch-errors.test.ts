import { describe, expect, test } from "vitest";
import {
  classifyGatewayError,
  faultDomain,
  type DispatchErrorCode,
} from "../src/core/dispatch-errors.js";

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

  describe("attachment-specific failures", () => {
    test("the sandbox staging cap -> ATTACHMENT_TOO_LARGE (by message, no context needed)", () => {
      expect(
        classifyGatewayError(
          new Error(
            "INVALID_REQUEST: UnsupportedAttachmentError: attachments exceed sandbox staging limit (5242880 bytes): big.pdf (11498819 bytes)",
          ),
        ),
      ).toBe("ATTACHMENT_TOO_LARGE");
    });

    test("a GENERIC 'exceeds the maximum' on an ATTACHMENT turn -> ATTACHMENT_TOO_LARGE", () => {
      // A size cap that doesn't name "attachment" is the file ONLY when the turn
      // carried one.
      expect(
        classifyGatewayError(
          new Error("INVALID_REQUEST: payload exceeds the maximum size of 33554432 bytes"),
          { hasAttachments: true },
        ),
      ).toBe("ATTACHMENT_TOO_LARGE");
    });

    test("INVERSE: a text-only 'exceeds the maximum' is NOT blamed on a file (stays INVALID_REQUEST)", () => {
      // Discriminating (codex P2): a no-attachment "prompt exceeds the maximum"
      // must NOT tell the user to shrink a non-existent attachment. Dropping the
      // hasAttachments guard on the generic size pattern would break this.
      expect(
        classifyGatewayError(
          new Error("INVALID_REQUEST: prompt exceeds the maximum context length"),
        ),
      ).toBe("INVALID_REQUEST");
    });

    test("the prod isValidBase64 overflow, on an ATTACHMENT turn -> ATTACHMENT_REJECTED", () => {
      // The gateway returns "INVALID_REQUEST: RangeError: Maximum call stack size
      // exceeded" with NO 'attachment' in the text — only the hasAttachments context
      // distinguishes it from a generic bad request.
      expect(
        classifyGatewayError(
          new Error("INVALID_REQUEST: RangeError: Maximum call stack size exceeded"),
          { hasAttachments: true },
        ),
      ).toBe("ATTACHMENT_REJECTED");
    });

    test("INVERSE: the SAME overflow with NO attachment stays INVALID_REQUEST (not misattributed)", () => {
      // Discriminating: if hasAttachments is not set, a generic INVALID_REQUEST must
      // NOT be blamed on a file. Removing the context guard would break this.
      expect(
        classifyGatewayError(
          new Error("INVALID_REQUEST: RangeError: Maximum call stack size exceeded"),
        ),
      ).toBe("INVALID_REQUEST");
    });

    test("an explicit 'attachment parse/stage' message -> ATTACHMENT_REJECTED (no context needed)", () => {
      expect(
        classifyGatewayError(new Error("chat.send attachment parse/stage failed: boom")),
      ).toBe("ATTACHMENT_REJECTED");
    });

    test("a non-attachment INVALID_REQUEST with hasAttachments=false stays INVALID_REQUEST", () => {
      expect(
        classifyGatewayError(new Error("INVALID_REQUEST: bad params"), {
          hasAttachments: false,
        }),
      ).toBe("INVALID_REQUEST");
    });

    test("the agent rule still wins over the attachment context (specificity order)", () => {
      expect(
        classifyGatewayError(
          new Error('INVALID_REQUEST: Agent "olivier" no longer exists in configuration'),
          { hasAttachments: true },
        ),
      ).toBe("AGENT_NOT_FOUND");
    });
  });
});

describe("faultDomain (bridge-health classification)", () => {
  // BRIDGE-domain = the bridge could not REACH/AUTHENTICATE its gateway -> red.
  // UPSTREAM_ERROR (the catch-all for any UNRECOGNIZED throw) is bridge-domain by
  // design: fail-closed, since we cannot prove the gateway ever responded.
  const BRIDGE: DispatchErrorCode[] = [
    "AUTH_TOKEN_MISMATCH",
    "DEVICE_SIGNING_FAILED",
    "SESSION_SCOPE_DENIED",
    "GATEWAY_TIMEOUT",
    "GATEWAY_DISCONNECTED",
    "UPSTREAM_ERROR",
  ];
  // DOWNSTREAM = the gateway DEMONSTRABLY responded + refused -> NOT a bridge fault.
  const DOWNSTREAM: DispatchErrorCode[] = [
    "AGENT_NOT_FOUND",
    "ATTACHMENT_TOO_LARGE",
    "ATTACHMENT_REJECTED",
    "INVALID_REQUEST",
  ];

  test.each(BRIDGE)("%s is a BRIDGE-domain fault (turns the bridge red)", (code) => {
    expect(faultDomain(code)).toBe("bridge");
  });

  test.each(DOWNSTREAM)("%s is a DOWNSTREAM rejection (bridge stays green)", (code) => {
    expect(faultDomain(code)).toBe("downstream");
  });

  test("the production case: a rejected attachment is NOT a bridge fault", () => {
    // The exact incident: re-sending the gateway's base64-overflow attachment must
    // classify as ATTACHMENT_REJECTED and be DOWNSTREAM — the bridge survived it.
    expect(faultDomain("ATTACHMENT_REJECTED")).toBe("downstream");
  });

  test("DISCRIMINATING: a real disconnect and an attachment reject are NOT the same domain", () => {
    // If the split were dropped (everything -> one bucket) this would fail: a
    // transport loss MUST still mark the bridge red, a payload reject MUST NOT.
    expect(faultDomain("GATEWAY_DISCONNECTED")).not.toBe(
      faultDomain("ATTACHMENT_REJECTED"),
    );
    expect(faultDomain("GATEWAY_DISCONNECTED")).toBe("bridge");
  });

  test("every classifiable code has a defined domain (no silent gap)", () => {
    for (const code of [...BRIDGE, ...DOWNSTREAM]) {
      expect(["bridge", "downstream"]).toContain(faultDomain(code));
    }
  });

  test("FAIL-CLOSED: the UPSTREAM_ERROR catch-all is bridge-domain, not benign", () => {
    // An UNRECOGNIZED throw (e.g. an unexpected registry.acquire/performSend
    // failure) classifies as UPSTREAM_ERROR. We cannot prove the gateway answered,
    // so it must stay VISIBLE as a bridge error — never silently green. If this
    // ever flips to "downstream", a real bridge failure could hide as a reject.
    expect(faultDomain("UPSTREAM_ERROR")).toBe("bridge");
    // The end-to-end shape: an unknown error string -> UPSTREAM_ERROR -> bridge.
    expect(faultDomain(classifyGatewayError(new Error("kaboom")))).toBe("bridge");
    expect(faultDomain(classifyGatewayError(null))).toBe("bridge");
  });
});
