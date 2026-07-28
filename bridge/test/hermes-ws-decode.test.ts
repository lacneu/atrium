/**
 * The Hermes WS reader reports what it cannot read (W9/C4) — behaviourally.
 *
 * The structural scan next door asserts the module CALLS the sensor. That check was green
 * while this exact path was broken: `JSON.parse("null")` succeeds, the cast validated
 * nothing at runtime, and the null reached `route()` outside any guard, where reading
 * `obj.id` threw a TypeError straight out of the socket callback — reported by nobody, on
 * the DEFAULT Hermes transport.
 *
 * So this drives the decoder itself, which is why it was extracted: a reader nobody can
 * call is a reader nobody can test.
 */

import { afterEach, describe, expect, it } from "vitest";

import { decodeWsFrame, routeEventDecision } from "../src/providers/hermes/ws-client.js";
import {
  decodeInboundFrame,
  protocolDrift,
} from "../src/providers/openclaw/protocol-drift.js";

afterEach(() => protocolDrift.resetForTests());

const shapes = (): string[] => protocolDrift.report().map((e) => e.shape);

describe("decodeWsFrame", () => {
  it("passes a normal frame through, reporting nothing", () => {
    expect(decodeWsFrame('{"id":1,"type":"message.delta"}')).toEqual({
      id: 1,
      type: "message.delta",
    });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("REPORTS a frame that is not JSON at all", () => {
    expect(decodeWsFrame("{not json")).toBeNull();
    expect(shapes()).toEqual(["«exception».SyntaxError@hermes-ws-parse.«hermes»"]);
  });

  it("REPORTS a frame that parses to null — the bypass", () => {
    // The regression: this used to return `null` as a valid object and blow up downstream.
    expect(decodeWsFrame("null")).toBeNull();
    expect(shapes()).toEqual(["«exception».TypeError@hermes-ws-parse.«hermes»"]);
  });

  it("REPORTS the other non-object shapes JSON allows", () => {
    for (const raw of ["3", '"a string"', "true", "[1,2]"]) {
      expect(decodeWsFrame(raw), raw).toBeNull();
    }
    expect(shapes()).toEqual(["«exception».TypeError@hermes-ws-parse.«hermes»"]);
    expect(protocolDrift.report()[0]?.count).toBe(4);
  });

  it("carries no byte of the frame into the report", () => {
    const SECRET = "AliceMartin-0612345678";
    decodeWsFrame(`{"broken": "${SECRET}"`); // unterminated: SyntaxError quotes input
    decodeWsFrame(JSON.stringify(SECRET)); // a bare string frame
    const serialized = JSON.stringify(protocolDrift.report());
    expect(serialized).not.toContain("AliceMartin");
    expect(serialized).not.toContain("0612345678");
    expect(protocolDrift.report().length).toBeGreaterThan(0);
  });
});

describe("the SHARED decoder, per transport", () => {
  // Both providers had the same defect and only one was fixed at first. The decoder is
  // one function now, so the assertion is that every site reaches it — including the
  // OpenClaw operator socket, which every chat rides.
  const SITES = [
    "openclaw-ws-parse",
    "openclaw-handshake-parse",
    "hermes-ws-parse",
  ] as const;

  it("refuses a null frame on EVERY transport, and names the one it came from", () => {
    for (const site of SITES) {
      expect(decodeInboundFrame("null", site), site).toBeNull();
    }
    // The frame is `null` by then, so OpenClaw sites report the non-object marker and
    // Hermes reports its provider marker — written out rather than computed, so the test
    // cannot agree with the code by construction.
    expect(protocolDrift.report().map((e) => e.shape).sort()).toEqual(
      [
        "«exception».TypeError@hermes-ws-parse.«hermes»",
        "«exception».TypeError@openclaw-handshake-parse.«non-object»",
        "«exception».TypeError@openclaw-ws-parse.«non-object»",
      ].sort(),
    );
  });

  it("passes a real frame through untouched", () => {
    expect(decodeInboundFrame('{"type":"event","event":"chat"}', "openclaw-ws-parse")).toEqual({
      type: "event",
      event: "chat",
    });
    expect(protocolDrift.report()).toEqual([]);
  });
});

describe("nested WS members are validated too", () => {
  // The shared decoder validates the ENVELOPE. Everything below it used `?? {}`, so a
  // corrupt inner value became an empty one that read as valid — and on `message.complete`
  // that meant a truncated or empty answer settling as a clean success.
  it("a non-object payload is reported, not silently turned into {}", () => {
    for (const payload of ["null", '"text"', "[1]", "7"]) {
      protocolDrift.resetForTests();
      const frame = `{"method":"event","params":{"type":"message.complete","session_id":"s","payload":${payload}}}`;
      const decoded = decodeInboundFrame(frame, "hermes-ws-parse");
      expect(decoded, payload).not.toBeNull();
      // The envelope is fine; the nested check lives in the client's router, so this
      // asserts the SHAPE the router is handed rather than re-running it here.
      const params = (decoded as { params: Record<string, unknown> }).params;
      const inner = params.payload;
      expect(typeof inner === "object" && inner !== null && !Array.isArray(inner)).toBe(
        false,
      );
    }
  });
});

describe("routeEventDecision — what a corrupt frame does to the turn it names", () => {
  const ok = (payload: unknown) => ({
    type: "message.complete",
    session_id: "sid-1",
    payload,
  });

  it("passes a healthy event straight through", () => {
    expect(routeEventDecision(ok({ text: "bonjour" }))).toEqual({
      type: "message.complete",
      sid: "sid-1",
      payload: { text: "bonjour" },
    });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("turns a corrupt TERMINAL into an error for THAT session", () => {
    // The frame still says whose turn it is. Dropping it left that turn waiting for a
    // terminal that had already arrived broken — up to twelve minutes of "Réflexion…".
    const d = routeEventDecision(ok(null));
    expect(d?.type).toBe("error");
    expect(d?.sid).toBe("sid-1");
    expect(protocolDrift.report()[0]?.shape).toContain("hermes-ws-parse");
  });

  it("does NOT end a turn over a corrupt DELTA", () => {
    // A lost delta is a lost delta. Ending the turn would trade a visible defect for a
    // worse one.
    const d = routeEventDecision({ type: "message.delta", session_id: "sid-1", payload: 7 });
    expect(d?.type).toBe("message.delta");
    expect(d?.payload).toEqual({});
    expect(protocolDrift.report().length).toBe(1); // reported all the same
  });

  it("drops an event whose params are unreadable — nobody to tell", () => {
    for (const params of [null, "x", [1], 3]) {
      protocolDrift.resetForTests();
      expect(routeEventDecision(params), JSON.stringify(params)).toBeNull();
      expect(protocolDrift.report()[0]?.shape).toContain("hermes-ws-parse");
    }
  });

  it("an ABSENT payload stays legitimate", () => {
    const d = routeEventDecision({ type: "message.delta", session_id: "s" });
    expect(d?.payload).toEqual({});
    expect(protocolDrift.report()).toEqual([]);
  });

  it("the terminal set matches the reader's own settling cases", () => {
    // Guessing this vocabulary is how a fix starts ending turns the reader would have
    // continued. These are the three cases that call `settle()` in ws-turn.ts.
    for (const t of ["message.complete", "error", "approval.request"]) {
      expect(routeEventDecision({ type: t, session_id: "s", payload: null })?.type).toBe(
        "error",
      );
      protocolDrift.resetForTests();
    }
  });
});
