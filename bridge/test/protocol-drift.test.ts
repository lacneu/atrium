// Protocol-drift detector (Inc 2): observe-only classification of inbound
// chat/agent frames against the vendored protocol surface. Two guarantees are
// pinned here:
//   1. behavior — unknown fields are counted (names only), known fields are
//      silent, nothing ever throws or gates a frame, the registry is bounded;
//   2. the CHAIN — the runtime known-field sets are a BIJECTION of the
//      coverage manifest's per-field entries (which the coverage ratchet in
//      turn pins against the vendored TypeBox schemas). One chain:
//        vendored schema <-> coverage.json <-> runtime sets.

import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promisedVersion, vendoredVersions } from "./helpers/vendored.js";
import * as vendoredChatSchemas from "../protocol/openclaw/2026.9.36/logs-chat.js";
import {
  COVERAGE_SUMMARY,
  DRIFT_VENDORED_VERSION,
  AGENT_ROUTING_ENVELOPE_FIELDS,
  KNOWN_AGENT_FIELDS,
  KNOWN_CHAT_FIELDS,
  KNOWN_CHAT_FIELDS_BY_STATE,
  ProtocolDriftRegistry,
  driftDigestKey,
  protocolDrift,
} from "../src/providers/openclaw/protocol-drift.js";

afterEach(() => protocolDrift.resetForTests());

const SESSION_KEY = "agent:alice:atrium:chat:olivier:driftchat";

/** What the unknown-state id would be WITHOUT the per-process salt — the dictionary
 *  attack a reader of the reported shape could run against a guessed value. */
function unsaltedFnv1a(s: string): string {
  return fnvFrom(0x811c9dc5, s).toString(16).padStart(8, "0");
}

/** FNV-1a 32 over UTF-16 code units, from a given hash state. */
function fnvFrom(h0: number, s: string): number {
  let h = h0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** The FNV prime's inverse mod 2^32 (Newton): FNV-1a can be run BACKWARDS. */
const FNV_PRIME_INVERSE = (() => {
  let x = 0x01000193;
  for (let i = 0; i < 5; i++) x = Math.imul(x, (2 - Math.imul(0x01000193, x)) >>> 0) >>> 0;
  return x >>> 0;
})();
/** Undo FNV-1a over `s`, from the final state back to the state before it. */
function fnvBack(h0: number, s: string): number {
  let h = h0;
  for (let i = s.length - 1; i >= 0; i--) {
    h = Math.imul(h, FNV_PRIME_INVERSE) >>> 0;
    h = (h ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}
/** The digest the detector gives an unknown chat state (its shape's last segment). */
function unknownStateDigest(state: string): string {
  protocolDrift.resetForTests();
  protocolDrift.observe({ type: "event", event: "chat", payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state } });
  return protocolDrift.report()[0]!.shape.split(".").pop()!;
}

function chatFrame(extra: Record<string, unknown> = {}): unknown {
  return {
    type: "event",
    event: "chat",
    payload: {
      runId: "webchat-x",
      sessionKey: SESSION_KEY,
      seq: 1,
      state: "delta",
      deltaText: "bonjour",
      ...extra,
    },
  };
}

describe("protocol drift detector", () => {
  it("a fully-known frame reports zero drift", () => {
    protocolDrift.observe(chatFrame());
    expect(protocolDrift.report()).toEqual([]);
  });

  it("an unknown chat payload field is counted by DIGEST — never its name, never a value", () => {
    protocolDrift.observe(chatFrame({ steerHint: "secret content" }));
    protocolDrift.observe(chatFrame({ steerHint: "other content" }));
    // The shape is keyed PER STATE since W9: the union hid cross-state fields. A name no
    // vendored schema spells is a wire string nobody vouched for (review, 2026-11-08).
    const report = protocolDrift.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.count).toBe(2);
    expect(report[0]!.shape).toMatch(/^chat\.delta\.field_[0-9a-f]{8}$/);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("steer");
  });

  it("a content-bearing identifier used as a field name never reaches the shape", () => {
    // `AliceMartin` is a perfectly plain identifier: a charset filter passes it, which is
    // exactly why a name is published only when it is vocabulary.
    protocolDrift.observe(chatFrame({ AliceMartin: 1 }));
    protocolDrift.observe({ type: "event", event: "agent", payload: { runId: "r", seq: 1, stream: "assistant", ts: 1, data: {}, AliceMartin: 1 } });
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toHaveLength(2);
    expect(shapes.join(" ").toLowerCase()).not.toContain("alice");
    expect(shapes.some((s) => /^chat\.delta\.field_[0-9a-f]{8}$/.test(s))).toBe(true);
    expect(shapes.some((s) => /^agent\.field_[0-9a-f]{8}$/.test(s))).toBe(true);
  });

  it("a field of ANOTHER state is drift — the union hid these", () => {
    // `ChatEventSchema` is a discriminated union: `deltaText` belongs to `delta`, and an
    // `aborted` frame carrying it is a contract deviation. Checked against the UNION, this
    // reported zero — and it is precisely the shape that breaks a reader branching on
    // `state`.
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: {
        runId: "webchat-x",
        sessionKey: SESSION_KEY,
        seq: 1,
        state: "aborted",
        deltaText: "half a sentence",
      },
    });
    expect(protocolDrift.report()).toMatchObject([
      { shape: "chat.aborted.deltaText", count: 1 },
    ]);
  });

  it("an UNRECOGNISED state is reported once, not as a wall of unknown fields", () => {
    // A fifth state cannot be judged field by field: every field would look unknown, which
    // is noise. The state itself is the finding.
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: {
        runId: "webchat-x",
        sessionKey: SESSION_KEY,
        seq: 1,
        state: "paused",
        message: "…",
        somethingElse: 1,
      },
    });
    const report = protocolDrift.report();
    expect(report.length).toBe(1);
    expect(report[0]!.count).toBe(1);
    expect(report[0]!.shape).toMatch(/^chat\.«unknown-state»\.[0-9a-f]{8}$/);
  });

  it("two DIFFERENT unknown states are two findings, not one bucket", () => {
    // Aggregating every unrecognised state under one key hides whether one new state
    // appeared or five — which is the thing that has to be classified.
    for (const state of ["paused", "resumed"]) {
      protocolDrift.observe({
        type: "event",
        event: "chat",
        payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state },
      });
    }
    expect(new Set(protocolDrift.report().map((d) => d.shape)).size).toBe(2);
  });

  it("the SAME unknown state is one finding across frames", () => {
    // The id has to be stable, or an operator reads a new shape on every frame.
    for (let i = 0; i < 3; i++) {
      protocolDrift.observe({
        type: "event",
        event: "chat",
        payload: { runId: "r", sessionKey: SESSION_KEY, seq: i, state: "paused" },
      });
    }
    expect(protocolDrift.report().length).toBe(1);
    expect(protocolDrift.report()[0]!.count).toBe(3);
  });

  it("a PROTOTYPE-named state cannot silence the detector", () => {
    // `KNOWN_CHAT_FIELDS_BY_STATE["toString"]` returned a function from the prototype,
    // `known.has` threw, and the observe-only catch swallowed it: the frame produced no
    // drift at all. A detector a wire value can silence is worse than none.
    for (const state of ["toString", "constructor", "__proto__"]) {
      protocolDrift.resetForTests();
      protocolDrift.observe({
        type: "event",
        event: "chat",
        payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state },
      });
      const report = protocolDrift.report();
      expect(report.length, state).toBe(1);
      expect(report[0]!.shape, state).toMatch(/^chat\.«unknown-state»\.[0-9a-f]{8}$/);
    }
  });

  it("a state VALUE never reaches the shape key", () => {
    // The state is an UNVALIDATED wire value on a surface that is stored and displayed.
    // A charset filter was the first attempt and proved nothing — a name passes it. The
    // digest is one-way, so the non-leak is structural rather than a promise about what a
    // gateway sends. Content in ANY form: with spaces, and as a bare identifier.
    for (const state of ["secret conversational content", "AliceMartin"]) {
      protocolDrift.resetForTests();
      protocolDrift.observe({
        type: "event",
        event: "chat",
        payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state },
      });
      const shape = protocolDrift.report()[0]!.shape;
      expect(shape).toMatch(/^chat\.«unknown-state»\.[0-9a-f]{8}$/);
      expect(shape.toLowerCase()).not.toContain(state.slice(0, 6).toLowerCase());
      // …and it is not a plain digest of the value either: an unsalted one is one-way in
      // form only, since anyone holding the shape can confirm a guess by hashing it.
      expect(shape, "the id must not be derivable from the value").not.toContain(
        unsaltedFnv1a(state),
      );
    }
  });

  it("the detector cannot fail SILENTLY", () => {
    // Observe-only means "never break the feed", not "never say anything". The catch used
    // to swallow the failure whole, so a frame the detector could not read at all produced
    // the same report as a clean one — the detector's own blind spot, invisible in the very
    // surface built to expose blind spots. It is counted as a shape, through the pipeline
    // that is already bounded and rendered.
    protocolDrift.observe({
      type: "event",
      event: "chat",
      get payload(): unknown {
        throw new TypeError("boom");
      },
    });
    expect(protocolDrift.report()).toMatchObject([
      { shape: "«detector-failure».TypeError", count: 1 },
    ]);
  });

  it("a detector failure never carries the error MESSAGE", () => {
    // `err.message` can quote the frame that caused it (SOC2): the class name is protocol
    // vocabulary, the message is content.
    protocolDrift.observe({
      type: "event",
      event: "chat",
      get payload(): unknown {
        throw new RangeError("secret conversational content");
      },
    });
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toEqual(["«detector-failure».RangeError"]);
    expect(shapes.join(" ")).not.toContain("secret");
  });

  it("the per-state sets EQUAL the vendored per-state schemas", async () => {
    // Derived, not trusted: the agent list spent weeks as production observations, and this
    // one must not repeat it. Every state's set is compared to its schema's own properties.
    // A STATIC import: vitest cannot resolve a variable dynamic import here, and pinning
    // the version in the path is fine precisely because the next test asserts that this is
    // the version the detector claims to vendor.
    const mod = vendoredChatSchemas as unknown as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(DRIFT_VENDORED_VERSION, "the static import must track the vendored version").toBe(
      "2026.9.36",
    );
    const bySchema: Record<string, string> = {
      delta: "ChatDeltaEventSchema",
      final: "ChatFinalEventSchema",
      aborted: "ChatAbortedEventSchema",
      error: "ChatErrorEventSchema",
      status: "ChatStatusEventSchema",
    };
    expect(Object.keys(KNOWN_CHAT_FIELDS_BY_STATE).sort()).toEqual(
      Object.keys(bySchema).sort(),
    );
    for (const [state, schemaName] of Object.entries(bySchema)) {
      const props = Object.keys(mod[schemaName]?.properties ?? {});
      expect(props.length, `${schemaName} has no properties`).toBeGreaterThan(3);
      expect(
        [...KNOWN_CHAT_FIELDS_BY_STATE[state]!].sort(),
        `${state} drifted from ${schemaName}`,
      ).toEqual(props.sort());
    }
  });

  it("the tracked-shape OVERFLOW is counted, not just logged", () => {
    // The cap used to be a console.error and nothing else: the report said "here is the
    // drift" while omitting everything past it.
    for (let i = 0; i < 600; i += 1) {
      protocolDrift.observe(chatFrame({ [`f${i}`]: 1 }));
    }
    expect(protocolDrift.report().length).toBeLessThanOrEqual(512);
    expect(
      protocolDrift.overflowCount(),
      "observations past the cap must be counted",
    ).toBeGreaterThan(0);
  });

  it("agent frames are classified against their own surface", () => {
    protocolDrift.observe({
      type: "event",
      event: "agent",
      payload: {
        runId: "r",
        seq: 1,
        stream: "assistant",
        ts: 1,
        data: {},
        brandNewField: 42,
      },
    });
    const report = protocolDrift.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.shape).toMatch(/^agent\.field_[0-9a-f]{8}$/);
  });

  it("the 2026.6.11 sub-agent metadata fields report ZERO drift (live ataraxis 2026-07-10)", () => {
    // The exact prod symptom: an agent frame carrying the child's role/scope, its
    // parent session key, runtime, and child-session list must be fully known now.
    protocolDrift.observe({
      type: "event",
      event: "agent",
      payload: {
        runId: "r",
        seq: 1,
        stream: "assistant",
        ts: 1,
        data: {},
        subagentRole: "worker",
        subagentControlScope: "session",
        parentSessionKey: "agent:x:webchat:chat:c:1",
        runtimeMs: 1234,
        childSessions: ["agent:x:subagent:uuid"],
      },
    });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("non-chat/agent events and malformed frames are ignored, never thrown on", () => {
    protocolDrift.observe({ type: "event", event: "health", payload: { weird: 1 } });
    protocolDrift.observe(null);
    protocolDrift.observe("garbage");
    protocolDrift.observe({ type: "event", event: "chat", payload: null });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("the tracked-shape registry is bounded", () => {
    for (let i = 0; i < 250; i++) {
      protocolDrift.observe(chatFrame({ [`field${i}`]: true }));
    }
    expect(protocolDrift.report().length).toBeLessThanOrEqual(100);
  });
});

describe("agent data: phases and keys the inventory never emits", () => {
  const agentFrame = (stream: string, data: Record<string, unknown>): unknown => ({
    type: "event",
    event: "agent",
    payload: { runId: "r", seq: 1, stream, ts: 1, data },
  });
  // The Convex boundary stores a field-drift shape only when it matches its closed grammar
  // (convex/compat.ts BASE: `agent` and one to three `[A-Za-z0-9_]{1,64}` segments).
  // Restated here because the bridge cannot import that module; a shape outside it would
  // be counted at the boundary and never named.
  const CONVEX_FIELD_GRAMMAR = /^agent(?:\.[A-Za-z0-9_]{1,64}){1,3}$/;

  it("a frame the inventory emits reports nothing", () => {
    protocolDrift.observe(
      agentFrame("lifecycle", { phase: "waiting-approval", approvalId: "a1", toolCallId: "t1" }),
    );
    protocolDrift.observe(
      agentFrame("lifecycle", { phase: "error", error: "x", executionSettled: true, startedAt: 1, endedAt: 2 }),
    );
    protocolDrift.observe(agentFrame("tool", { phase: "input_delta", name: "edit", toolCallId: "t", diff: "…" }));
    protocolDrift.observe(agentFrame("usage", { inputTokens: 1, outputTokens: 2 }));
    protocolDrift.observe(agentFrame("error", { reason: "seq gap", expected: 3, received: 4 }));
    expect(protocolDrift.report()).toEqual([]);
  });

  it("an unknown PHASE is counted under its stream, digested — never named", () => {
    protocolDrift.observe(agentFrame("lifecycle", { phase: "AliceMartin" }));
    protocolDrift.observe(agentFrame("lifecycle", { phase: "AliceMartin" }));
    const report = protocolDrift.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.count).toBe(2);
    expect(report[0]!.shape).toMatch(/^agent\.lifecycle\.phase_[0-9a-f]{8}$/);
    expect(report[0]!.shape.toLowerCase()).not.toContain("alice");
    expect(report[0]!.shape).toMatch(CONVEX_FIELD_GRAMMAR);
  });

  it("an unknown KEY is DIGESTED under its stream — a content-bearing identifier included", () => {
    // It used to be named whenever it was a plain identifier, and `AliceMartin` is one: a
    // key that no inventory spells is a wire string nobody vouched for (review, 2026-11-08).
    protocolDrift.observe(agentFrame("tool", { phase: "result", toolCallId: "t", AliceMartin: "secret content" }));
    protocolDrift.observe(agentFrame("tool", { phase: "result", toolCallId: "t", brandNewKey: 1 }));
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toHaveLength(2);
    for (const s of shapes) {
      expect(s).toMatch(/^agent\.tool\.datakey_[0-9a-f]{8}$/);
      expect(s).toMatch(CONVEX_FIELD_GRAMMAR);
    }
    expect(JSON.stringify(protocolDrift.report()).toLowerCase()).not.toMatch(/alice|secret|brandnew/);
  });

  it("a key that is not a plain identifier is digested, not named", () => {
    protocolDrift.observe(agentFrame("tool", { phase: "result", "alice@example.com": 1 }));
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatch(/^agent\.tool\.datakey_[0-9a-f]{8}$/);
    expect(shapes[0]).toMatch(CONVEX_FIELD_GRAMMAR);
  });

  it("a key ANOTHER stream carries is vocabulary, and named — once", () => {
    // `executionSettled` is a lifecycle key: on `usage` it is misplaced, not unknown.
    protocolDrift.observe(agentFrame("usage", { outputTokens: 1, executionSettled: true }));
    expect(protocolDrift.report().map((d) => d.shape)).toEqual(["agent.usage.data_executionSettled"]);
  });

  it("ANY phase on a stream whose emitters write none is reported — digested, its key not counted twice", () => {
    // `usage` writes no phase. The check used to run only on streams WITH phases, and the
    // `phase` key passed as "known on every stream": a new phase there reported nothing.
    protocolDrift.observe(agentFrame("usage", { phase: "brand_new_phase", outputTokens: 1 }));
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatch(/^agent\.usage\.phase_[0-9a-f]{8}$/);
    expect(shapes[0]).not.toContain("brand");
  });

  it("a phase that is not a string is reported by its JavaScript type only", () => {
    protocolDrift.observe(agentFrame("lifecycle", { phase: 3 }));
    protocolDrift.observe(agentFrame("usage", { phase: { secret: "x" } }));
    expect(protocolDrift.report().map((d) => d.shape).sort()).toEqual([
      "agent.lifecycle.phasetype_number",
      "agent.usage.phasetype_object",
    ]);
  });

  it("a key only an unresolved-stream emitter writes is REPORTED apart, not known everywhere", () => {
    // `pluginId` comes from the plugin SDK's emitter and `result` from the worker relay,
    // whose streams the derivation could not resolve. They were known on EVERY stream, so
    // `usage` carrying `result` reported nothing (review, 2026-11-08): now the field is
    // flagged as one an unresolved emitter could have added — a name from the inventory.
    protocolDrift.observe(agentFrame("lifecycle", { phase: "start", startedAt: 1, pluginId: "p" }));
    protocolDrift.observe(agentFrame("usage", { outputTokens: 1, result: "payload" }));
    expect(protocolDrift.report().map((d) => d.shape).sort()).toEqual([
      "agent.lifecycle.opaquekey_pluginId",
      "agent.usage.opaquekey_result",
    ]);
  });

  it("a DOTTED stream the vocabulary knows is judged like any other (review, 2026-11-08)", () => {
    // `codex_app_server.*` streams are inventoried: exempting every dotted name before
    // looking it up let their new phases and keys through.
    for (const stream of ["codex_app_server.item", "codex_app_server.guardian"]) {
      protocolDrift.resetForTests();
      protocolDrift.observe(agentFrame(stream, { phase: "new_phase", unknown_key: 1 }));
      const shapes = protocolDrift.report().map((d) => d.shape);
      expect(shapes, stream).toHaveLength(2);
      expect(shapes.some((s) => /\.phase_[0-9a-f]{8}$/.test(s)), stream).toBe(true);
      expect(shapes.some((s) => /\.datakey_[0-9a-f]{8}$/.test(s)), stream).toBe(true);
      // …and a frame it does emit stays silent.
      protocolDrift.resetForTests();
      protocolDrift.observe(agentFrame(stream, { phase: "started" }));
      expect(protocolDrift.report(), stream).toEqual([]);
    }
  });

  it("dotted (plugin-scoped) streams and unknown streams are not judged further", () => {
    protocolDrift.observe(agentFrame("acme.provenance", { phase: "whatever", anything: 1 }));
    protocolDrift.observe(agentFrame("brandnew", { phase: "whatever", anything: 1 }));
    const shapes = protocolDrift.report().map((d) => d.shape);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatch(/^agent\.stream_[0-9a-f]{8}$/);
  });

  it("prototype-named phases and keys cannot silence or break the detector", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      protocolDrift.resetForTests();
      protocolDrift.observe(agentFrame("lifecycle", { phase: name }));
      protocolDrift.observe(agentFrame("lifecycle", JSON.parse(`{"phase":"start","${name}":1}`)));
      const shapes = protocolDrift.report().map((d) => d.shape);
      expect(shapes.some((s) => /^agent\.lifecycle\.phase_[0-9a-f]{8}$/.test(s)), name).toBe(true);
      expect(shapes.some((s) => s.startsWith("«detector-failure»")), name).toBe(false);
    }
  });
});

describe("runtime sets <-> coverage manifest bijection (the anti-drift chain)", () => {
  interface Manifest {
    schemas: Record<
      string,
      { fields?: Record<string, unknown> } & Record<string, unknown>
    >;
  }
  // The manifest of the version the bridge PROMISES — `maxValidated` — not the newest
  // directory on disk (raised in review: vendoring a future version to prepare a bump
  // would otherwise swing the runtime matrix onto a contract nobody had promised).
  // `compat.test.ts` separately refuses a `maxValidated` with no vendored directory,
  // so this lookup cannot point at nothing.
  const REFERENCE = promisedVersion();
  const MANIFEST = JSON.parse(
    readFileSync(
      new URL(`../protocol/openclaw/coverage/${REFERENCE}.json`, import.meta.url),
      "utf-8",
    ),
  ) as Manifest;

  it("KNOWN_CHAT_FIELDS == union of the four chat event schemas' manifest fields", () => {
    const union = new Set<string>();
    for (const name of [
      "ChatDeltaEvent",
      "ChatFinalEvent",
      "ChatAbortedEvent",
      "ChatErrorEvent",
      // The fifth state, declared since 2026.8.1 (see KNOWN_CHAT_FIELDS_BY_STATE).
      "ChatStatusEvent",
    ]) {
      for (const f of Object.keys(MANIFEST.schemas[name]?.fields ?? {})) {
        union.add(f);
      }
    }
    expect([...KNOWN_CHAT_FIELDS].sort()).toEqual([...union].sort());
  });

  it("DRIFT_VENDORED_VERSION equals the PROMISED version (maxValidated)", () => {
    // The constant is what the operator matrix and the drift badge report as "the
    // contract this bridge is judged against". Nothing pinned it, so it sat on
    // 2026.6.11 while `maxValidated` said 2026.7.1 — and its comment then explained,
    // at length, why 6.11 plus one field WAS the 7.1 surface. Pinned to
    // `maxValidated` rather than to the newest directory: a directory vendored ahead
    // of a bump is legitimate preparation and must not move what we report.
    expect(DRIFT_VENDORED_VERSION).toBe(REFERENCE);
  });

  it("COVERAGE_SUMMARY == a recount of the manifest (counts + gap list)", () => {
    const counts = { handled: 0, ignored: 0, gap: 0 };
    const gaps: string[] = [];
    for (const [name, entry] of Object.entries(MANIFEST.schemas)) {
      if (entry.fields !== undefined) {
        for (const [f, fe] of Object.entries(entry.fields)) {
          const st = (fe as { status: keyof typeof counts }).status;
          counts[st]++;
          if (st === "gap") gaps.push(`${name}.${f}`);
        }
      } else {
        const st = (entry as { status: keyof typeof counts }).status;
        counts[st]++;
        if (st === "gap") gaps.push(name);
      }
    }
    expect(COVERAGE_SUMMARY.handled).toBe(counts.handled);
    expect(COVERAGE_SUMMARY.ignored).toBe(counts.ignored);
    expect(COVERAGE_SUMMARY.gaps).toBe(counts.gap);
    expect([...COVERAGE_SUMMARY.gapList].sort()).toEqual(gaps.sort());
  });

  it("KNOWN_AGENT_FIELDS == manifest fields + the DERIVED session snapshot + the envelope", () => {
    // This assertion used to carry a forty-line hand-written list of "observed flattened
    // fields", each with the date of the production badge that revealed it. The
    // hand-maintenance it was supposed to replace had simply MOVED into the test: the
    // runtime set and the list agreed because a human had typed both, and a field upstream
    // added was missing from both at once. `lastTo` had been reported twenty-four times in
    // production and appeared in neither.
    //
    // The envelope is now DERIVED: the vendored `session-event-snapshot.json` (the return
    // shape of the gateway's own `buildSessionEventSnapshot`, extracted at vendoring time)
    // plus the two-field routing envelope, which is declared ONCE in protocol-drift.ts
    // because it appears in no schema and in no session row. Nothing here is typed twice.
    const snapshot = JSON.parse(
      readFileSync(
        new URL(
          `../protocol/openclaw/${DRIFT_VENDORED_VERSION}/session-event-snapshot.json`,
          import.meta.url,
        ),
        "utf-8",
      ),
    ) as { fields: string[] };
    expect(
      snapshot.fields.length,
      "the derived snapshot is empty — the extraction stopped working",
    ).toBeGreaterThan(30);

    // …UNIONED over every vendored version: a field a SUPPORTED older gateway still emits
    // is not drift. 2026.9.6 retired the two compaction-checkpoint fields, and a 2026.9.5
    // frame carrying them was badged "gateway newer than vendored" (codex, 9.6 pass 2).
    const older = vendoredVersions().flatMap(
      (v) =>
        (
          JSON.parse(
            readFileSync(
              new URL(`../protocol/openclaw/${v}/session-event-snapshot.json`, import.meta.url),
              "utf-8",
            ),
          ) as { fields: string[] }
        ).fields,
    );
    const expected = new Set([
      ...Object.keys(MANIFEST.schemas.AgentEvent?.fields ?? {}),
      ...snapshot.fields,
      ...older,
      ...AGENT_ROUTING_ENVELOPE_FIELDS,
    ]);
    expect(
      [...KNOWN_AGENT_FIELDS].sort(),
      "the known-field set no longer equals (manifest ∪ every vendored derived snapshot ∪ envelope) — " +
        "re-run scripts/vendor-protocol.mjs and copy the derived list, deliberately",
    ).toEqual([...expected].sort());
  });
});

describe("C4 — the reader threw on a frame (W9)", () => {
  // A frame that makes the reader throw is a frame this build could not read AT ALL. It
  // used to be a `console.error` and nothing else: no report, no product surface, no way
  // for an operator to know a conversation broke on a shape we cannot parse.

  class WeirdError extends Error {}

  it("reports the error class, the site and the frame's protocol shape", () => {
    protocolDrift.observeException(chatFrame(), new WeirdError("boom"), "feed");
    expect(protocolDrift.report()).toMatchObject([
      { shape: "«exception».WeirdError@feed.chat.delta", count: 1 },
    ]);
  });

  it("keeps the two call sites apart", () => {
    protocolDrift.observeException(chatFrame(), new WeirdError("a"), "feed");
    protocolDrift.observeException(chatFrame(), new WeirdError("b"), "subagent-observe");
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes).toContain("«exception».WeirdError@feed.chat.delta");
    expect(shapes).toContain("«exception».WeirdError@subagent-observe.chat.delta");
  });

  it("the same shape recurring is COUNTED, not repeated", () => {
    for (let i = 0; i < 5; i++) {
      protocolDrift.observeException(chatFrame(), new WeirdError("x"), "feed");
    }
    expect(protocolDrift.report()).toMatchObject([
      { shape: "«exception».WeirdError@feed.chat.delta", count: 5 },
    ]);
  });

  it("names an agent frame by its own surface", () => {
    protocolDrift.observeException(
      { type: "event", event: "agent", payload: { stream: "lifecycle" } },
      new TypeError("x"),
      "feed",
    );
    expect(protocolDrift.report()[0]?.shape).toBe("«exception».TypeError@feed.agent");
  });

  it("survives frames that are not events at all", () => {
    // The reader throws on whatever arrived: an RPC response, a malformed envelope, a
    // null. Each has to land somewhere rather than crash the sensor.
    protocolDrift.observeException(null, new TypeError("x"), "feed");
    protocolDrift.observeException({ type: "response", id: 3 }, new TypeError("x"), "feed");
    protocolDrift.observeException(
      { type: "event", event: "chat" },
      new TypeError("x"),
      "feed",
    );
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes).toContain("«exception».TypeError@feed.«non-object»");
    expect(shapes).toContain("«exception».TypeError@feed.«non-event»");
    expect(shapes).toContain("«exception».TypeError@feed.chat.«no-payload»");
  });

  it("a non-Error throw is still reported", () => {
    // `throw "string"` and `throw {}` are legal. `err.constructor.name` is unavailable or
    // meaningless there, and losing the finding would be the silence this sensor removes.
    protocolDrift.observeException(chatFrame(), "just a string", "feed");
    expect(protocolDrift.report()[0]?.shape).toBe("«exception».string@feed.chat.delta");
  });

  it("never throws, whatever it is handed", () => {
    const hostile = {
      type: "event",
      get event(): string {
        throw new Error("getter");
      },
    };
    expect(() => protocolDrift.observeException(hostile, new Error("x"), "feed")).not.toThrow();
    // …and the failure is COUNTED rather than lost.
    expect(protocolDrift.report()[0]?.shape).toBe("«detector-failure».ExceptionSensor");
  });
});

describe("C4 — SOC2: no byte of frame content reaches the report", () => {
  // The adversarial test W9 asks for: content injected in EVERY position an exception
  // touches. The promise under test is about the REPORTED surface — `report()`, and so
  // Convex and the UI — which is what leaves the process as data.
  const SECRET = "AliceMartin-0612345678-secret";

  it("not through a field name, a value, a state, an event, or the error message", () => {
    protocolDrift.observeException(
      {
        type: "event",
        event: "chat",
        payload: {
          state: SECRET, // discriminant
          [SECRET]: 1, // KEY position
          deltaText: SECRET, // value position
          runId: SECRET,
        },
      },
      new Error(SECRET), // the error MESSAGE — the closest leak on this path
      "feed",
    );
    protocolDrift.observeException(
      { type: "event", event: SECRET, payload: {} }, // event position
      new Error(SECRET),
      "feed",
    );
    const serialized = JSON.stringify(protocolDrift.report());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("AliceMartin");
    expect(serialized).not.toContain("0612345678");
    // …and the findings ARE reported: a sensor that leaks nothing by reporting nothing
    // would pass the assertions above.
    expect(protocolDrift.report()).toHaveLength(2);
    for (const e of protocolDrift.report()) {
      expect(e.shape.startsWith("«exception».Error@feed.")).toBe(true);
    }
  });

  it("an unknown state and an unknown event are DISTINGUISHED without being named", () => {
    protocolDrift.observeException(
      { type: "event", event: "chat", payload: { state: "alpha" } },
      new Error("x"),
      "feed",
    );
    protocolDrift.observeException(
      { type: "event", event: "chat", payload: { state: "beta" } },
      new Error("x"),
      "feed",
    );
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(new Set(shapes).size).toBe(2);
    expect(shapes.every((s) => s.includes("«unknown-state»"))).toBe(true);
    expect(shapes.some((s) => s.includes("alpha") || s.includes("beta"))).toBe(false);
  });

  it("the digest is SALTED — a guessed value cannot be confirmed", () => {
    protocolDrift.observeException(
      { type: "event", event: SECRET, payload: {} },
      new Error("x"),
      "feed",
    );
    expect(protocolDrift.report()[0]?.shape).not.toContain(unsaltedFnv1a(SECRET));
  });

  it("ONE known (value, digest) pair predicts no other value's digest (keyed MAC, review 2026-11-08)", () => {
    // The salted FNV-1a fell to this: run it BACKWARDS over a known value from its digest
    // and you hold the hash state after the salt — every other digest follows. With a
    // keyed MAC the same computation predicts nothing.
    const known = unknownStateDigest("AliceMartin");
    const target = unknownStateDigest("BobDupont");
    const stateAfterSalt = fnvBack(parseInt(known, 16), "\u0000AliceMartin");
    const predicted = fnvFrom(stateAfterSalt, "\u0000BobDupont").toString(16).padStart(8, "0");
    expect(predicted).not.toBe(target);
    // …and the digest is still stable within the process: one id per distinct value.
    expect(unknownStateDigest("BobDupont")).toBe(target);
  });

});

describe("the digest key: stable per deployment, secret, random without a secret", () => {
  // What protects a digest is a SECRET key; a key that changes at every restart only broke
  // the Convex shape ledger's triage (a new `new` row per restart, two bridges never
  // merged). The key is derived from the ingest secret the bridge already holds.
  const SECRET = "ingest-S3cr3t-0123456789abcdef";
  const LABEL = "atrium-drift-digest-v1";
  const state = (s: string): unknown => ({ type: "event", event: "chat", payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state: s } });
  const digestOf = (r: ProtocolDriftRegistry, s: string): string => {
    r.resetForTests();
    r.observe(state(s));
    return r.report()[0]!.shape.split(".").pop()!;
  };
  const expected = (secret: string, value: string): string =>
    createHmac("sha256", createHmac("sha256", secret).update(LABEL).digest()).update(value).digest("hex").slice(0, 8);
  const withEnv = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
    const prev = process.env.BRIDGE_INGEST_SECRET;
    if (value === undefined) delete process.env.BRIDGE_INGEST_SECRET;
    else process.env.BRIDGE_INGEST_SECRET = value;
    try {
      vi.resetModules();
      return await run();
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_INGEST_SECRET;
      else process.env.BRIDGE_INGEST_SECRET = prev;
      vi.resetModules();
    }
  };

  it("two detectors with the same secret give the same digest — the key is HMAC-SHA256(secret, label)", () => {
    const a = new ProtocolDriftRegistry(driftDigestKey(SECRET));
    const b = new ProtocolDriftRegistry(driftDigestKey(SECRET));
    expect(digestOf(b, "AliceMartin")).toBe(digestOf(a, "AliceMartin"));
    expect(digestOf(a, "AliceMartin")).toBe(expected(SECRET, "AliceMartin"));
  });

  it("another secret gives another digest", () => {
    const a = new ProtocolDriftRegistry(driftDigestKey(SECRET));
    const b = new ProtocolDriftRegistry(driftDigestKey(`${SECRET}-rotated`));
    expect(digestOf(b, "AliceMartin")).not.toBe(digestOf(a, "AliceMartin"));
  });

  it("without a secret the key is random: two detectors disagree", () => {
    for (const none of [null, ""]) {
      const a = new ProtocolDriftRegistry(driftDigestKey(none));
      const b = new ProtocolDriftRegistry(driftDigestKey(none));
      expect(digestOf(b, "AliceMartin"), String(none)).not.toBe(digestOf(a, "AliceMartin"));
    }
  });

  it("one known (value, digest) pair still predicts nothing without the secret", () => {
    const r = new ProtocolDriftRegistry(driftDigestKey(SECRET));
    const known = digestOf(r, "AliceMartin");
    const target = digestOf(r, "BobDupont");
    const stateAfterSalt = fnvBack(parseInt(known, 16), "\u0000AliceMartin");
    expect(fnvFrom(stateAfterSalt, "\u0000BobDupont").toString(16).padStart(8, "0")).not.toBe(target);
    // …and the PUBLIC label alone does not recompute it: the secret is the key.
    expect(createHmac("sha256", LABEL).update("BobDupont").digest("hex").slice(0, 8)).not.toBe(target);
    expect(expected("", "BobDupont")).not.toBe(target);
  });

  it("the secret and the key appear in no output: report, logs, errors, the object itself", () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    const spies = [vi.spyOn(console, "log").mockImplementation(capture), vi.spyOn(console, "error").mockImplementation(capture), vi.spyOn(console, "warn").mockImplementation(capture)];
    try {
      const key = driftDigestKey(SECRET);
      const r = new ProtocolDriftRegistry(key);
      r.observe(state("AliceMartin"));
      r.observe({ type: "event", event: "agent", payload: { runId: "r", seq: 1, stream: "tool", ts: 1, data: { phase: "zzz", [SECRET]: SECRET } } });
      r.observe({ type: "event", event: "agent", payload: { runId: "r", seq: 1, stream: SECRET, ts: 1, data: {} } });
      r.observeException(state(SECRET), new Error(SECRET), "feed");
      r.observeUnknownValue("history_receipt_state", SECRET);
      const out = [JSON.stringify(r.report()), String(r.overflowCount()), JSON.stringify(r), Object.keys(r).join(","), ...lines].join("\n");
      expect(r.report().length).toBeGreaterThan(3);
      for (const forbidden of [SECRET, key.toString("hex"), key.toString("base64"), Buffer.from(SECRET).toString("hex"), Buffer.from(SECRET).toString("base64")]) {
        expect(out.includes(forbidden), forbidden.slice(0, 6)).toBe(false);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("the process singleton derives its key from BRIDGE_INGEST_SECRET as the configuration reads it", async () => {
    // Trimmed, as `requireEnv` reads it: one secret, one key.
    await withEnv(`  ${SECRET}  `, async () => {
      const fresh = (await import("../src/providers/openclaw/protocol-drift.js")).protocolDrift;
      fresh.observe(state("AliceMartin"));
      expect(fresh.report()[0]!.shape.split(".").pop()).toBe(expected(SECRET, "AliceMartin"));
    });
  });

  it("…and, without it, a fresh process digests the same value differently", async () => {
    await withEnv(undefined, async () => {
      const fresh = (await import("../src/providers/openclaw/protocol-drift.js")).protocolDrift;
      fresh.observe(state("AliceMartin"));
      const other = fresh.report()[0]!.shape.split(".").pop();
      expect(other).toMatch(/^[0-9a-f]{8}$/);
      expect(other).not.toBe(unknownStateDigest("AliceMartin"));
    });
  });
});

describe("chat content parts: the case equivalences upstream applies", () => {
  it("a `toolResult` block is a known type — upstream compares tool types lowercased", () => {
    // The projection folds a tool block's type (`type.trim().toLowerCase()`) before it
    // compares it, so `toolResult` is its `toolresult`; judging the literal spelling only
    // reported a false drift (review, 2026-11-08).
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: {
        runId: "r",
        sessionKey: SESSION_KEY,
        seq: 1,
        state: "final",
        message: { role: "assistant", content: [{ type: "toolResult", text: "x" }, { type: "ToolCall" }, { type: "text", text: "y" }] },
      },
    });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("…while a type no fold reaches is still drift", () => {
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: { runId: "r", sessionKey: SESSION_KEY, seq: 1, state: "final", message: { role: "assistant", content: [{ type: "Text" }] } },
    });
    expect(protocolDrift.report().map((d) => d.shape)).toEqual([expect.stringMatching(/^chat\.final\.contentpart_[0-9a-f]{8}$/)]);
  });
});

describe("C4 — the label survives the Convex boundary", () => {
  it("even the longest possible exception shape fits PROTOCOL_MAX_STR", () => {
    // `boundProtocolInfo` truncates a shape past 120 chars (adding a hash suffix to keep
    // distinct names distinct). Truncation would not corrupt the report, but it would cut
    // the tail — which is precisely the part an operator reads: the SITE and the frame's
    // shape. Worth one assertion rather than one arithmetic in a comment.
    const longestClass = `A${"a".repeat(47)}`; // the charset guard's ceiling
    const longestSite = "subagent-observe";
    const longestFrameShape = `chat.«unknown-state».${"f".repeat(8)}`;
    const longest = `«exception».${longestClass}@${longestSite}.${longestFrameShape}`;
    expect(longest.length).toBeLessThanOrEqual(120);
  });

  it("a hostile class name cannot smuggle length or content", () => {
    class X extends Error {}
    Object.defineProperty(X, "name", { value: "A".repeat(500) });
    protocolDrift.observeException(chatFrame(), new X("x"), "feed");
    const shape = protocolDrift.report()[0]?.shape ?? "";
    // `constructor.name` is what is read, and it is guarded by the same charset rule the
    // detector-failure path uses — an over-long or exotic name becomes the marker.
    expect(shape.length).toBeLessThanOrEqual(120);
  });
});

describe("C4 — gateway noise cannot starve the exception signal", () => {
  class Boom extends Error {}

  it("a saturated FIELD registry still reports a reader exception in full", () => {
    // The failure mode this budget exists for: a gateway jumps a version, unknown fields
    // pour in and fill the registry, and the next unreadable frame becomes an untyped
    // overflow tick — no class, no site, nothing to tie to the broken conversation.
    for (let i = 0; i < 300; i++) {
      protocolDrift.observe(chatFrame({ [`novel_field_${i}`]: 1 }));
    }
    expect(protocolDrift.overflowCount()).toBeGreaterThan(0); // the field budget IS full

    protocolDrift.observeException(chatFrame(), new Boom("x"), "feed");
    expect(protocolDrift.report().map((e) => e.shape)).toContain(
      "«exception».Boom@feed.chat.delta",
    );
  });

  it("the sensor budget is bounded too — it just cannot be spent by field drift", () => {
    for (let i = 0; i < 300; i++) {
      protocolDrift.observe(chatFrame({ [`novel_field_${i}`]: 1 }));
    }
    // 40 distinct sensor shapes against a 32 budget: bounded, and the overflow is
    // reported rather than silent.
    for (let i = 0; i < 40; i++) {
      const Named = class extends Error {};
      Object.defineProperty(Named, "name", { value: `Boom${i}` });
      protocolDrift.observeException(chatFrame(), new Named("x"), "feed");
    }
    const sensorShapes = protocolDrift
      .report()
      .filter((e) => e.shape.startsWith("«exception»."));
    expect(sensorShapes.length).toBe(32);
    expect(protocolDrift.overflowCount()).toBeGreaterThan(0);
  });
});

describe("C4 — the reservation has to survive the trip, not just the registry", () => {
  class Boom extends Error {}

  it("sensor shapes head the report, so a bounded consumer keeps them", () => {
    // The Convex boundary keeps a bounded PREFIX. Reserving room in the registry and then
    // appending the sensor shapes at the END undid the reservation one hop later.
    for (let i = 0; i < 300; i++) {
      protocolDrift.observe(chatFrame({ [`novel_field_${i}`]: 1 }));
    }
    protocolDrift.observeException(chatFrame(), new Boom("x"), "feed");
    const head = protocolDrift.report()[0];
    expect(head?.shape).toBe("«exception».Boom@feed.chat.delta");
    // …and it is still first when the field counts are far larger than the sensor's.
    for (let i = 0; i < 50; i++) protocolDrift.observe(chatFrame({ novel_field_0: 1 }));
    expect(protocolDrift.report()[0]?.shape).toBe("«exception».Boom@feed.chat.delta");
  });

  it("one thrown error is ONE finding, however many guards rethrow it", () => {
    // `feedInner` re-enters the public `feed()` to replay a stashed announce: the inner
    // guard reports the inner frame, rethrows, and the outer guard used to report the
    // same failure again — against the OUTER frame, which never broke.
    const err = new Boom("one failure");
    protocolDrift.observeException(chatFrame({ runId: "inner" }), err, "feed");
    protocolDrift.observeException(chatFrame({ runId: "outer" }), err, "feed");
    expect(protocolDrift.report()).toMatchObject([
      { shape: "«exception».Boom@feed.chat.delta", count: 1 },
    ]);
  });

  it("two DISTINCT failures are still two findings", () => {
    protocolDrift.observeException(chatFrame(), new Boom("a"), "feed");
    protocolDrift.observeException(chatFrame(), new Boom("b"), "feed");
    expect(protocolDrift.report()).toMatchObject([
      { shape: "«exception».Boom@feed.chat.delta", count: 2 },
    ]);
  });
});

describe("a field only an OLDER supported gateway emits is not drift (codex, 9.6 pass 2)", () => {
  it("a 2026.9.5 frame carrying the retired compaction-checkpoint fields is not badged", () => {
    const frame = (extra: Record<string, unknown>) => ({
      type: "event",
      event: "agent",
      payload: { runId: "r1", stream: "lifecycle", data: {}, sessionKey: SESSION_KEY, ...extra },
    });
    protocolDrift.observe(frame({ compactionCheckpointCount: 2, latestCompactionCheckpoint: { id: "k1" } }));
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes).not.toContain("agent.compactionCheckpointCount");
    expect(shapes).not.toContain("agent.latestCompactionCheckpoint");
    // …while a field NO supported gateway ever sent still is (the detector is not blind) —
    // digested, since no vendored schema spells it.
    protocolDrift.observe(frame({ neverSentByAnyone: 1 }));
    expect(protocolDrift.report().map((e) => e.shape).some((s) => /^agent\.field_[0-9a-f]{8}$/.test(s))).toBe(true);
  });
});
