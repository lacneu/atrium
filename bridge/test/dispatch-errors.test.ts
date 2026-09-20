import { describe, expect, test } from "vitest";
import { TalkCallActiveError } from "../src/session.js";
import {
  classifyGatewayError,
  errorChainText,
  faultDomain,
  LOST_RESPONSE_CODES,
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

  test("a NAMED close outranks the generic disconnect rule", () => {
    // The client appends its classification of the close to the rejection message
    // (`connection-end.ts`). Both strings ALSO match /closed/, so order matters: a
    // send interrupted by an announced restart must not read as a plain socket loss.
    expect(
      classifyGatewayError(
        new Error("OpenClaw Gateway connection closed [gateway_restarting]"),
      ),
    ).toBe("GATEWAY_RESTARTING");
    expect(
      classifyGatewayError(
        new Error("OpenClaw Gateway connection closed [slow_consumer]"),
      ),
    ).toBe("CONNECTION_SATURATED");
    // OUR OWN overflow close is the same user-facing fact as the gateway's.
    expect(
      classifyGatewayError(
        new Error("inbound queue overflow [inbound_overflow]"),
      ),
    ).toBe("CONNECTION_SATURATED");
    // An UNNAMED close keeps its historic code (no behavior change).
    expect(
      classifyGatewayError(new Error("OpenClaw Gateway connection closed")),
    ).toBe("GATEWAY_DISCONNECTED");
    // Both are bridge-domain like the disconnect they refine — health semantics
    // are deliberately untouched by this lot.
    expect(faultDomain("GATEWAY_RESTARTING")).toBe("bridge");
    expect(faultDomain("CONNECTION_SATURATED")).toBe("bridge");
    // …and both keep the LOST-RESPONSE property of the code they refine: a
    // `config.patch` that TRIGGERS an announced restart is the paradigm case for the
    // read-back confirmation, so naming the end must not exclude it (codex P2).
    for (const code of [
      "GATEWAY_DISCONNECTED",
      "GATEWAY_RESTARTING",
      "CONNECTION_SATURATED",
    ] as const) {
      expect(LOST_RESPONSE_CODES.has(code)).toBe(true);
    }
    // A refusal is NOT a lost response: nothing was applied, so nothing to confirm.
    expect(LOST_RESPONSE_CODES.has("AUTH_TOKEN_MISMATCH")).toBe(false);
    expect(LOST_RESPONSE_CODES.has("INVALID_REQUEST")).toBe(false);
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

  test("refusing to cut a live voice call is a LOCAL refusal, not a bridge fault", () => {
    // The link and the credentials are perfect: we declined to re-key the socket
    // because a gateway-owned call was live on it. Painting the bridge red for
    // honouring its own invariant is the exact lie the `local` class exists to end,
    // and `downstream` would claim the gateway answered — clearing a real incident.
    expect(faultDomain("talk_call_active")).toBe("local");
    expect(classifyGatewayError(new TalkCallActiveError("c1"))).toBe(
      "talk_call_active",
    );
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

// LIVE PROD 2026-08-04: a send lost on a conversation carrying a 66-page report.
// The gateway refused it with `Session "…" changed while starting work. Retry.`
// — a transient conflict it explicitly asks us to retry — and the bridge folded
// it into INVALID_REQUEST because the text arrives behind that prefix. That code
// is a dead end: the message was lost and the user was told the chat service was
// unavailable.
describe("a session that moved under a starting run is retriable, not malformed", () => {
  const raw =
    'INVALID_REQUEST: Error: Session "agent:fabien:atrium:chat:fabien.lacombe:mh796j2qfy71p8dq9trafvtmmx8bdead" changed while starting work. Retry.';

  test("classifies the gateway's own 'Retry.' as the session conflict it is", () => {
    expect(classifyGatewayError(new Error(raw))).toBe("session_init_conflict");
  });

  test("does NOT fall into the malformed-request bucket", () => {
    expect(classifyGatewayError(new Error(raw))).not.toBe("INVALID_REQUEST");
  });

  test("the OTHER two 2026.9.1 forms are the same conflict, on this door too (codex)", () => {
    // The frame classifier learned all three; this one — the door an exception thrown
    // by `chat.send` comes through — knew only the first, so the two others became
    // terminal errors with no bounded retry. Both doors now share one predicate.
    const deleted =
      'INVALID_REQUEST: Error: Session "agent:alice:atrium:chat:u-1" was deleted while starting work. Retry.';
    const claimed =
      "INVALID_REQUEST: Error: Session 7f3a already has an active turn claim";
    for (const raw2 of [deleted, claimed]) {
      expect(classifyGatewayError(new Error(raw2)), raw2).toBe("session_init_conflict");
      expect(classifyGatewayError(new Error(raw2)), raw2).not.toBe("INVALID_REQUEST");
    }
    // …and with an attachment on the send, the file is still not blamed.
    expect(
      classifyGatewayError(new Error(deleted), { hasAttachments: true }),
    ).toBe("session_init_conflict");
  });

  // The same conflict on a send that CARRIES a file: the attachment fallback
  // fires on `hasAttachments && /invalid request/`, so this was classified
  // ATTACHMENT_REJECTED — terminal, and blaming a file that had nothing to do
  // with it.
  test("a send WITH an attachment is not blamed on the attachment", () => {
    expect(
      classifyGatewayError(new Error(raw), { hasAttachments: true }),
    ).toBe("session_init_conflict");
  });

  test("an explicit attachment failure still wins over it", () => {
    expect(
      classifyGatewayError(new Error("INVALID_REQUEST: invalid base64"), {
        hasAttachments: true,
      }),
    ).toBe("ATTACHMENT_REJECTED");
  });

  // A message carrying BOTH signals states a real file failure: retrying it
  // would loop on a payload that cannot be staged.
  test("an explicit attachment marker in the SAME message wins", () => {
    expect(
      classifyGatewayError(
        new Error(
          'attachment parse/stage failed: Session "x" changed while starting work. Retry.',
        ),
        { hasAttachments: true },
      ),
    ).toBe("ATTACHMENT_REJECTED");
  });

  test("a genuinely malformed request still classifies as one", () => {
    expect(
      classifyGatewayError(new Error("INVALID_REQUEST: malformed payload")),
    ).toBe("INVALID_REQUEST");
  });

  // The gateway answered — the bridge's link and credentials worked. Counting
  // this as a bridge fault would paint the Bridge tab red on a healthy bridge.
  test("is a DOWNSTREAM rejection, so bridge health stays green", () => {
    expect(faultDomain("session_init_conflict")).toBe("downstream");
  });
});

// 2026.9.2: an idempotency key is bound to the content it was first used with
// (src/gateway/server-methods/chat-send-request.ts:248-256 hashes message +
// mentions; chat-send-pre-admission.ts:148-155 refuses a reuse with other input).
// The response is `INVALID_REQUEST` with `details.reason: "chat-request-conflict"`
// and the ORIGINAL run keeps running. Folded into INVALID_REQUEST it read as a
// malformed send; retried it would start a second turn beside the first.
describe("a key reused for different input is a conflict, not a malformed request (2026.9.2)", () => {
  // Verbatim gateway text, chat-send-pre-admission.ts:150-152 at v2026.9.2, behind
  // the `INVALID_REQUEST:` prefix the client puts on every refused RPC.
  const raw =
    "INVALID_REQUEST: This message ID was already used for different input. Check the conversation history and use a new message ID to send again.";

  test("classifies the reuse as chat_request_conflict", () => {
    expect(classifyGatewayError(new Error(raw))).toBe("chat_request_conflict");
  });

  test("does NOT fall into the malformed-request bucket, even with an attachment on the send", () => {
    expect(classifyGatewayError(new Error(raw))).not.toBe("INVALID_REQUEST");
    expect(classifyGatewayError(new Error(raw), { hasAttachments: true })).toBe("chat_request_conflict");
  });

  test("is a downstream rejection: the bridge did its job", () => {
    expect(faultDomain("chat_request_conflict")).toBe("downstream");
  });
});

describe("a profile NAME cannot choose the dispatch code", () => {
  test("the operator-chosen id is stripped before the patterns run", () => {
    // The id travels inside the sentence this classifier reads. A profile called
    // `timeout` became GATEWAY_TIMEOUT, and one carrying a conflict phrase reached the
    // RETRYABLE branch — a name buying itself re-dispatches (codex).
    const cooldown = (name: string, model = "gpt-5.6-sol") =>
      new Error(
        `Auth profile "${name}" is temporarily unavailable for openai/${model}.`,
      );
    expect(classifyGatewayError(cooldown("timeout"))).not.toBe("GATEWAY_TIMEOUT");
    // AGENT_NOT_FOUND, the value this function really returns for that phrase — the
    // first version of this case compared against `no_agent`, which it never returns,
    // so it was green by construction (codex).
    expect(classifyGatewayError(cooldown("unknown agent"))).not.toBe("AGENT_NOT_FOUND");
    // The MODEL ID is operator-chosen too, and the tail names it (codex).
    expect(classifyGatewayError(cooldown("x", "timeout"))).not.toBe("GATEWAY_TIMEOUT");
    // …and the RETRYABLE branch, which is the one worth buying: a session-init
    // conflict is re-dispatched by a bounded auto-retry.
    expect(
      classifyGatewayError(
        cooldown("reply session initialization conflicted"),
      ),
    ).not.toBe("session_init_conflict");
    // …while a real timeout, with no profile name in it, still classifies.
    expect(classifyGatewayError(new Error("gateway timeout after 60s"))).toBe(
      "GATEWAY_TIMEOUT",
    );
  });
});

describe("a network cut is NAMED, not swept into the catch-all", () => {
  test("the errno behind `fetch failed` is read from the CAUSE", () => {
    // Node reports a cut socket as `TypeError: fetch failed` and puts the errno in
    // `cause`. Reading only `message` saw a sentence no rule recognises, so the send
    // fell to `UPSTREAM_ERROR` — "something upstream", with nothing for an operator to
    // act on. That is the open production anomaly this fixes (dispatch failure on
    // instance `lacneu`, dominant cause UPSTREAM_ERROR).
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(classifyGatewayError(wrapped)).toBe("GATEWAY_DISCONNECTED");
    // …and with an OUTER message no rule recognises either, so ONLY the cause can
    // answer.
    const opaque = new Error("dispatch failed", {
      cause: new Error("read ECONNRESET"),
    });
    expect(classifyGatewayError(opaque)).toBe("GATEWAY_DISCONNECTED");
    // A BARE wrapper proves nothing and must stay the catch-all: Node emits
    // `fetch failed` for an unknown scheme, a bad port or a TLS failure as readily as
    // for a cut socket, and this class asserts the write may have been applied
    // (LOST_RESPONSE_CODES) — a claim the wrapper does not support (codex).
    expect(classifyGatewayError(new TypeError("fetch failed"))).toBe("UPSTREAM_ERROR");
  });

  test("the ERRNO spellings, not only the prose ones", () => {
    // `connection reset` was listed; `econnreset`, what Node actually emits, was not.
    for (const message of [
      "read ECONNRESET",
      "write EPIPE",
      "socket hang up",
      // BOTH spellings — the pattern says `socket hang ?up` and only one was covered.
      "socket hangup",
    ]) {
      expect(classifyGatewayError(new Error(message)), message).toBe(
        "GATEWAY_DISCONNECTED",
      );
    }
  });

  test("the pre-connection errnos are classed PESSIMISTICALLY, and that is stated", () => {
    // They go to the class that says a write MAY have been applied, which they cannot
    // support — nothing was written yet. A first attempt to give them their own
    // "nothing was sent" class was WRONG in the dangerous direction: after the gateway
    // ACKs, `startAssistant` fetches Convex, so a Convex outage surfaces the very same
    // ECONNREFUSED, and telling the reader it is safe to re-send would invite
    // re-running a turn the agent may already be executing (codex). Pessimistic is the
    // safe error until the PHASE is threaded from the call sites.
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:8790",
      "getaddrinfo ENOTFOUND gateway.example",
      "getaddrinfo EAI_AGAIN gateway.example",
    ]) {
      expect(classifyGatewayError(new Error(message)), message).toBe(
        "GATEWAY_DISCONNECTED",
      );
    }
    expect(LOST_RESPONSE_CODES.has("GATEWAY_DISCONNECTED")).toBe(true);
  });

  test("a timeout keeps its OWN name, and an unknown failure still falls through", () => {
    // The errno family must not swallow the timeout class beside it…
    expect(classifyGatewayError(new Error("connect ETIMEDOUT"))).toBe("GATEWAY_TIMEOUT");
    // …and the catch-all must remain reachable: an unrecognised throw is not a network
    // cut, and painting it as one would hide it.
    expect(classifyGatewayError(new Error("the gateway did something new"))).toBe(
      "UPSTREAM_ERROR",
    );
  });

  test("the chain walk is BOUNDED — a cause chain can loop", () => {
    // The errno is on the INNER error, so the walk has to reach it — and the chain
    // loops back, which is the shape the bound exists for.
    const a = new Error("dispatch failed");
    const b = new Error("read ECONNRESET");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(classifyGatewayError(a)).toBe("GATEWAY_DISCONNECTED");
    // Asserted on the TEXT: without the bound this walk does not return at all, so
    // there is nothing to assert about the classifier. Five links is the bound.
    expect(errorChainText(a).split(" <- ")).toHaveLength(5);
  });
});
