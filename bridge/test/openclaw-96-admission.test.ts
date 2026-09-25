// OpenClaw 2026.9.6 admission refusals of `chat.send`, and the pause after a provider
// review — each reaches Atrium through TWO readers (a dispatch rejection, and the
// failure text of a turn already streaming), which must agree on the class.
import { describe, expect, it } from "vitest";
import { classifyGatewayError, faultDomain } from "../src/core/dispatch-errors.js";
import { classifyFailureText } from "../src/core/failure-classifier.js";

const KEY = "agent:alice:atrium:chat:olivier:c1";
// Verbatim from upstream v2026.9.6 (sources cited in failure-classifier.ts).
const REBUILDING = "UNAVAILABLE: session transcript is rebuilding; retry shortly";
const INITIALIZING = `INVALID_REQUEST: Session "${KEY}" is still initializing. Retry after initialization completes.`;
const PAUSED = `INVALID_REQUEST: Session "${KEY}" is paused as a precaution. Review the provider findings in chat before continuing.`;
const REVIEW_CHANGED = `INVALID_REQUEST: Session "${KEY}" provider review changed. Refresh the findings before continuing.`;

describe("a transient admission refusal rides the bounded retry, blamed on nobody", () => {
  it("the transcript rebuilding (UNAVAILABLE, retryAfterMs 250) and a session still initializing", () => {
    for (const text of [REBUILDING, INITIALIZING]) {
      expect(classifyGatewayError(new Error(text)), text).toBe("session_init_conflict");
      expect(classifyFailureText(text), text).toBe("session_init_conflict");
    }
    // …downstream: the gateway answered, the link is healthy.
    expect(faultDomain("session_init_conflict")).toBe("downstream");
  });
});

describe("a session paused for provider review is named, not called malformed", () => {
  it("both sentences, both readers — and never INVALID_REQUEST or a file's fault", () => {
    for (const text of [PAUSED, REVIEW_CHANGED]) {
      expect(classifyGatewayError(new Error(text)), text).toBe("session_paused_review");
      expect(classifyGatewayError(new Error(text), { hasAttachments: true }), text).toBe(
        "session_paused_review",
      );
      expect(classifyFailureText(text), text).toBe("session_paused_review");
    }
    expect(faultDomain("session_paused_review")).toBe("downstream");
  });
  it("keys on the fixed words: a session KEY carrying them does not classify alone", () => {
    const tricky = `INVALID_REQUEST: Session "is paused as a precaution. Review the provider findings" is archived.`;
    expect(classifyFailureText(tricky)).not.toBe("session_paused_review");
    expect(classifyGatewayError(new Error(tricky))).not.toBe("session_paused_review");
  });
});
