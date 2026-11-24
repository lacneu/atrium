/**
 * The DERIVED emission surface of the gateway's `agent` channel (scripts/lib/
 * derive-agent-emissions.mjs).
 *
 * `AgentEventSchema.data` is an open record, so nothing in the vendored protocol says which
 * `stream` values exist, which `data.phase` each one moves through, or which keys it
 * carries. The deriver answers from the code that EMITS the frames: one dispatcher is
 * named, every other emitter is discovered by following references, values are resolved
 * by an abstract evaluator, and what it cannot resolve is an OPAQUE row with its reason.
 *
 * What these tests pin are the ways it could return a SHORT inventory in silence — a
 * wrapper not followed, an alias not searched, a spread dropped, a test file counted, a
 * reference left unclassified — on a synthetic upstream, the only place those failure
 * modes can be exercised deliberately.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import * as deriver from "../scripts/lib/derive-agent-emissions.mjs";
// @ts-expect-error — plain .mjs script, no types
import { diffInventories } from "../scripts/diff-agent-emissions.mjs";

type Key = { key: string; optional: boolean; src: string };
type Row = {
  key: string;
  stream: string | null;
  streamOpaque: { reason: string; pattern: string | null } | null;
  phase: unknown;
  phaseAbsent: boolean;
  phaseOpaque: { reason: string } | null;
  keys: Key[];
  dataOpaque: { reason: string; origin: string | null }[];
  file: string;
  lines: number[];
  function: string;
  emitter: string;
  chain: string[];
};
type Inventory = {
  emissions: Row[];
  opaque: { file: string; what: string; reason: string }[];
  escapes: { at: string; reason: string }[];
  family: { kind: string; label: string; names: string[]; at: string | null; chain: string[] }[];
  openEntries: { label: string; openVia: string[]; shapes: { streams: { caller?: boolean; value?: string }[]; keys: { key: string }[]; dataFromCaller: boolean }[] }[];
  transformations: {
    fabricated: { stream: string | null; keys: string[]; file: string; sender: string }[];
    dataRewrites: { scope: string; added: string[]; guard: { stream?: string[]; phase?: string[]; negated: boolean }[] }[];
    dataRemovals: { scope: string; removed: string }[];
  };
  chatContentParts: { fabricated: { type: string }[]; recognized: { type: string; sites: { how: string }[] }[] };
  completeness: {
    identifiers: number;
    matched: number;
    homonyms: number;
    unaccounted: number;
    unaccountedReferences: { name: string; at: string }[];
    byName: Record<string, { identifiers: number; matched: number; homonym: number; classes: Record<string, number> }>;
    homonymDeclarations: { name: string; boundTo: string; count: number }[];
  };
  scope: {
    testExclusion: {
      byRule: Record<string, number>;
      excludedFilesMentioningFamily: Record<string, { rule: string; identifiers: number }>;
      reincludedByImportGuard: { file: string; importedBy: string }[];
    };
  };
  summary: Record<string, { sites: number; phases: Record<string, { sites: number; keys: Record<string, string> }> }>;
};

type ReadOnlyMember = {
  type: string;
  member: string;
  argument: number;
  declaredIn: string;
  implementation: { file: string; factory: string; fn: string };
  reviewedAt: string;
  evidence: string;
  bodies: { file: string; fn: string; sha256: string }[];
};
type DeriveInput = {
  root: string;
  files: Record<string, string>;
  tsconfig?: unknown;
  compilerOptions?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  readOnlyMembers?: ReadOnlyMember[];
};
const deriveWith = deriver.deriveAgentEmissions as (input: DeriveInput) => Inventory;
// The synthetic upstream has none of upstream's chat-state modules: no read-only member
// declaration applies unless a test brings its own.
const derive = (input: DeriveInput) => deriveWith({ readOnlyMembers: [], ...input });
const serialize = deriver.serializeInventory as (inv: Inventory) => string;
const diff = diffInventories as (a: Inventory, b: Inventory) => string;

/** A bus shaped like upstream's src/infra/agent-events.ts: the dispatcher hands an
 *  ENRICHED event (lifecycle data gains `completionSource`) to the public listener
 *  iterator; an audit notifier is a second channel, out of scope. */
const BUS = `
export type AgentEventPayload = { runId: string; seq: number; stream: string; ts: number; data: Record<string, unknown>; sessionKey?: string };
type Listener = (evt: AgentEventPayload) => void;
const listeners = new Set<Listener>();
const auditListeners = new Set<Listener>();
let completionSource: string | undefined;
function notifyListeners(it: Iterable<Listener>, evt: AgentEventPayload): void {
  for (const l of it) l(evt);
}
function* iterateAgentEventListeners(evt: AgentEventPayload): Generator<Listener> {
  yield* listeners;
}
function enrichAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">): AgentEventPayload | undefined {
  let data = event.data;
  if (event.stream === "lifecycle") {
    if (completionSource) {
      data = { ...data, completionSource };
    }
  }
  return { ...event, data, seq: 1, ts: 0 };
}
function dispatchAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  const enriched = enrichAgentEvent(event);
  if (!enriched) return false;
  notifyListeners(iterateAgentEventListeners(enriched), enriched);
  return true;
}
export function emitAgentEventIfCurrent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  return dispatchAgentEvent(event);
}
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  emitAgentEventIfCurrent(event);
}
export function emitAgentAuditEvent(event: AgentEventPayload) {
  notifyListeners(auditListeners, event);
}
`;

/** The gateway's frame senders, shaped like upstream's transports: the broadcaster factory
 *  hands out (event, payload) senders (one of them guarded to `plugin.*` events), the node
 *  runtime one more, the node registry a public method. Their bodies are the transport. */
const TRANSPORT: Record<string, string> = {
  "src/gateway/server-broadcast.ts": `
declare function deliver(frame: string): void;
export function createGatewayBroadcaster() {
  const broadcastInternal = (event: string, payload: unknown) => deliver(JSON.stringify({ type: "event", event, payload }));
  const broadcast = (event: string, payload: unknown) => broadcastInternal(event, payload);
  const broadcastToConnIds = (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
    void connIds;
    broadcastInternal(event, payload);
  };
  const broadcastPluginEvent = (event: string, payload: unknown) => {
    if (!event.startsWith("plugin.")) throw new Error("invalid plugin event");
    broadcastInternal(event, payload);
  };
  const getBufferedAmount = (connId: string) => connId.length;
  return { broadcast, broadcastToConnIds, broadcastPluginEvent, getBufferedAmount };
}
`,
  "src/gateway/server-node-session-runtime.ts": `
declare function deliverToNodes(sessionKey: string, event: string, payload: unknown): void;
export function createGatewayNodeSessionRuntime() {
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) => deliverToNodes(sessionKey, event, payload);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) => deliverToNodes("*", event, payload);
  return { nodeSendToSession, nodeSendToAllSubscribed };
}
`,
  "src/gateway/node-registry.ts": `
declare function deliverToNode(nodeId: string, frame: string): void;
export class NodeRegistry {
  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    this.sendEventInternal(nodeId, event, payload);
    return true;
  }
  sendEventRaw(nodeId: string, event: string, payloadJSON?: string | null): boolean {
    this.sendEventInternal(nodeId, event, payloadJSON);
    return true;
  }
  async sendEventForPairingIdentity(params: { nodeId: string; connId: string; event: string; payload?: unknown }): Promise<boolean> {
    return this.sendEventInternal(params.nodeId, params.event, params.payload);
  }
  async sendEventRawForPairingGeneration(nodeId: string, pairingGeneration: string, event: string, payloadJSON?: string | null): Promise<boolean> {
    void pairingGeneration;
    return this.sendEventInternal(nodeId, event, payloadJSON);
  }
  private sendEventInternal(nodeId: string, event: string, payload: unknown): boolean {
    deliverToNode(nodeId, JSON.stringify({ type: "event", event, payload }));
    return true;
  }
}
`,
};

/** The synthetic upstream: one file per behaviour, each on its own stream. */
const UPSTREAM: Record<string, string> = {
  ...TRANSPORT,
  "src/infra/agent-events.ts": BUS,
  "src/infra/streams.ts": `export const CONST_STREAM = "t_const";\n`,
  "src/cases/literal.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function literal(runId: string) {
  emitAgentEvent({ runId, stream: "t_literal", data: { phase: "start", name: "x" } });
}
`,
  "src/cases/constant.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
import { CONST_STREAM } from "../infra/streams.js";
const PHASE = "p_const";
export function constant(runId: string) {
  emitAgentEvent({ runId, stream: CONST_STREAM, data: { phase: PHASE } });
}
`,
  "src/cases/ternary.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function ternary(runId: string, ok: boolean) {
  emitAgentEvent({ runId, stream: "t_ternary", data: { phase: ok ? "end" : "error", ok } });
}
`,
  "src/cases/spread.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function spread(runId: string, id: string, extra: boolean) {
  const base = { itemId: id, kind: "k" };
  emitAgentEvent({ runId, stream: "t_spread", data: { ...base, phase: "update", ...(extra ? { extra: 1 } : {}) } });
}
`,
  "src/cases/wrapper.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function emitItem(runId: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream: "t_wrap", data });
}
export function emitTracked(ctx: { runId: string }, itemData: Record<string, unknown>) {
  emitItem(ctx.runId, itemData);
}
export function caller(ctx: { runId: string }) {
  emitTracked(ctx, { phase: "start", itemId: "i" });
}
`,
  "src/cases/opaque.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
declare function computeStream(): string;
declare function readData(): Record<string, unknown>;
export function unknownStream(runId: string) {
  emitAgentEvent({ runId, stream: computeStream(), data: { phase: "x" } });
}
export function unknownData(runId: string) {
  emitAgentEvent({ runId, stream: "t_opaque_data", data: readData() });
}
`,
  "src/cases/emits.test.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function fromATest() {
  emitAgentEvent({ runId: "r", stream: "t_test_only", data: { phase: "never" } });
}
`,
  "src/cases/alias.ts": `
import { emitAgentEvent as emitGlobal } from "../infra/agent-events.js";
export function aliased(runId: string) {
  emitGlobal({ runId, stream: "t_alias", data: { phase: "via-alias" } });
}
`,
  "src/cases/callback.ts": `
import { emitAgentEventIfCurrent } from "../infra/agent-events.js";
function recordTokens(params: { emit: (data: Record<string, unknown>) => void }) {
  params.emit({ outputTokens: 1 });
}
export function withCallback(runId: string) {
  recordTokens({ emit: (data) => emitAgentEventIfCurrent({ runId, stream: "t_usage", data }) });
}
`,
  "src/cases/escape.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export const registry: unknown[] = [];
registry.push(emitAgentEvent);
`,
  "src/cases/homonym.ts": `
export function homonym(emitAgentEvent: (x: unknown) => void) {
  emitAgentEvent({ stream: "t_homonym", data: { phase: "no" } });
}
`,
  "src/cases/factory.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function makeEmitter(runId: string, stream: string) {
  return (data: Record<string, unknown>) => emitAgentEvent({ runId, stream, data });
}
export function useFactory() {
  const emitX = makeEmitter("r", "t_factory");
  emitX({ phase: "go" });
}
`,
  "src/cases/accumulate.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function accumulate(runId: string, c: boolean) {
  let data: Record<string, unknown> = { phase: "a" };
  if (c) data = { ...data, accumulated: 1 };
  const meta: Record<string, unknown> = { phase: "w" };
  meta.written = true;
  emitAgentEvent({ runId, stream: "t_let", data });
  emitAgentEvent({ runId, stream: "t_write", data: meta });
}
`,
  "src/cases/iterate.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function iterate(runId: string) {
  const events = [
    { runId, stream: "t_iter", data: { phase: "one" } },
    { runId, stream: "t_iter", data: { phase: "two" } },
  ];
  for (const e of events) emitAgentEvent(e);
  [{ runId, stream: "t_foreach", data: { phase: "each" } }].forEach((e) => emitAgentEvent(e));
}
`,
  "src/cases/narrow.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
type State = { kind: "pending" } | { kind: "captured"; event: { runId: string; stream: string; data: Record<string, unknown> } } | { kind: "emitted" };
export function backstop(runId: string) {
  let state: State = { kind: "pending" };
  const prepare = (phase: "end" | "error") => ({ runId, stream: "t_narrow", data: { phase, endedAt: 1 } });
  const capture = (phase: "end" | "error") => {
    state = { kind: "captured", event: prepare(phase) };
  };
  const emit = (phase: "end" | "error") => {
    const current = state;
    const event = current.kind === "captured" ? current.event : prepare(phase);
    emitAgentEvent({ ...event, data: { ...event.data, settled: true } });
  };
  return { capture, emit };
}
export function useBackstop() {
  const b = backstop("r");
  b.emit("end");
}
`,
  "src/cases/guard.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function project(tool: { phase: string; name: string }) {
  return { phase: tool.phase === "result" ? "end" : tool.phase, name: tool.name };
}
export function emitToolItem(runId: string, tool: { phase: string; name: string }) {
  emitAgentEvent({ runId, stream: "t_guard", data: project(tool) });
}
export function guardCallers() {
  emitToolItem("r", { phase: "result", name: "a" });
  emitToolItem("r", { phase: "start", name: "b" });
}
`,
  "src/cases/registry.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
type Notification = { method: string; params: { id: string } };
const handlers: Array<(n: Notification) => void> = [];
export function onNotification(handler: (n: Notification) => void) {
  handlers.push(handler);
}
export function wire(runId: string) {
  onNotification((n) => emitAgentEvent({ runId, stream: "t_registry", data: { phase: "notified", ...n.params } }));
}
`,
  "src/cases/lifecycle.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function lifecycle(runId: string) {
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
}
`,
  "src/plugin-sdk/public.ts": `export { emitAgentEvent } from "../infra/agent-events.js";\n`,
  "src/gateway/server-chat.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
type Broadcast = (event: string, payload: unknown) => void;
// The bus event the gateway relays (a relay is of the bus event type, or made from it).
type Ev = Pick<AgentEventPayload, "runId" | "stream" | "data">;
export function relay(broadcast: Broadcast, evt: Ev, expected: number) {
  broadcast("agent", { runId: evt.runId, stream: "error", data: { reason: "seq gap", expected } });
  broadcast("agent", evt);
}
export function onEvent(evt: Ev, expected: number) {
  const { broadcast } = createGatewayBroadcaster();
  relay(broadcast, evt, expected);
}
export function project(event: Ev): Ev {
  if (event.stream === "assistant") {
    return { ...event, data: { ...event.data, text: "accumulated" } };
  }
  return event;
}
`,
  "src/gateway/chat-display-projection.core.ts": `
type Block = { type?: unknown; text?: unknown };
export function project(message: { content: Block[]; senderIdentity?: { type: string } }) {
  const displayContent: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "image") displayContent.push(block);
    if (isReasoning(block.type)) continue;
  }
  displayContent.push({ type: "text", text: "x" });
  const identity = message.senderIdentity;
  if (identity?.type === "profile") return { senderIdentity: { type: "profile", id: 1 }, content: displayContent };
  return { content: displayContent };
}
function isReasoning(type: unknown): boolean {
  return typeof type === "string" && (type === "thinking" || type === "reasoning");
}
`,
};

const TSCONFIG = { compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, paths: { "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"] } } };
const OPTIONS = { lib: ["lib.es5.d.ts"] };

let inv: Inventory;
const rows = (stream: string) => inv.emissions.filter((e) => e.stream === stream);
const keyList = (r: Row) => r.keys.map((k) => `${k.key}${k.optional ? "?" : ""}`);
const phases = (stream: string) => rows(stream).map((r) => (r.phaseAbsent ? "-" : String(r.phase))).sort();

beforeAll(() => {
  inv = derive({ root: "/virtual-upstream", files: UPSTREAM, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
});

describe("deriveAgentEmissions — values", () => {
  it("reads a literal stream, phase and key set", () => {
    const [r] = rows("t_literal");
    expect(rows("t_literal")).toHaveLength(1);
    expect(r?.phase).toBe("start");
    expect(r && keyList(r)).toEqual(["name", "phase"]);
    expect(r?.file).toBe("src/cases/literal.ts");
    expect(r?.function).toBe("literal");
  });

  it("resolves a constant imported from another module and a local one", () => {
    expect(phases("t_const")).toEqual(["p_const"]);
  });

  it("splits a ternary phase into one row per value", () => {
    expect(phases("t_ternary")).toEqual(["end", "error"]);
    for (const r of rows("t_ternary")) expect(keyList(r)).toEqual(["ok", "phase"]);
  });

  it("reads a spread's keys from its binding and keeps a conditional key optional", () => {
    const [r] = rows("t_spread");
    expect(r && keyList(r)).toEqual(["extra?", "itemId", "kind", "phase"]);
  });

  it("accumulates a `let` reassigned from itself, and a property written on a binding", () => {
    // One row per value the binding can hold: before the reassignment, and after it.
    expect(rows("t_let").map(keyList)).toEqual([["accumulated", "phase"], ["phase"]]);
    // `meta.written = true` runs, unconditionally, before the emission: the key is certain.
    expect(rows("t_write").map(keyList)).toEqual([["phase", "written"]]);
  });

  it("decides a test on a parameter where the parameter is filled (`p === x ? a : p`)", () => {
    // The projector maps "result" to "end": "result" must not survive as a phase.
    expect(phases("t_guard")).toEqual(["end", "start"]);
  });

  it("narrows a discriminated state in a ternary — no impossible phase-less variant", () => {
    // `end` from the call; `error` from the captured branch, whose `phase` is capture()'s
    // declared parameter type. What must NOT appear is a row without a phase: the
    // un-narrowed `current.event` of a pending state is absent.
    expect(phases("t_narrow")).toEqual(["end", "error"]);
    for (const r of rows("t_narrow")) expect(keyList(r)).toEqual(["endedAt", "phase", "settled"]);
  });
});

describe("deriveAgentEmissions — the emitter family is DISCOVERED", () => {
  it("follows a transitive wrapper to the caller that fixes the data", () => {
    const [r] = rows("t_wrap");
    expect(rows("t_wrap")).toHaveLength(1);
    expect(r?.phase).toBe("start");
    expect(r && keyList(r)).toEqual(["itemId", "phase"]);
    expect(r?.function).toBe("caller");
    expect(r?.chain.slice(0, 3)).toEqual(["emitTracked", "emitItem", "emitAgentEvent"]);
    const labels = inv.family.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(["emitTracked", "emitItem", "emitAgentEvent", "emitAgentEventIfCurrent"]));
  });

  it("searches an import ALIAS, not only the exported name", () => {
    expect(phases("t_alias")).toEqual(["via-alias"]);
    expect(inv.completeness.byName.emitGlobal?.matched).toBeGreaterThan(0);
  });

  it("follows a callback property to the call that fills it", () => {
    expect(rows("t_usage").map(keyList)).toEqual([["outputTokens"]]);
  });

  it("follows a factory's returned closure to the binding that calls it", () => {
    expect(phases("t_factory")).toEqual(["go"]);
  });

  it("treats array iteration as the call of its callback", () => {
    expect(phases("t_iter")).toEqual(["one", "two"]);
    expect(phases("t_foreach")).toEqual(["each"]);
  });

  it("refuses a bus without its dispatcher, or with a second door to the listeners", () => {
    expect(() => derive({ root: "/v", files: { ...UPSTREAM, "src/infra/agent-events.ts": BUS.replace(/dispatchAgentEvent/g, "dispatchRenamed") }, tsconfig: TSCONFIG, compilerOptions: OPTIONS })).toThrow(/expected exactly one dispatchAgentEvent/);
    const second = `${BUS}\nexport function backdoor(e: AgentEventPayload) { notifyListeners(iterateAgentEventListeners(e), e); }\n`;
    expect(() => derive({ root: "/v", files: { ...UPSTREAM, "src/infra/agent-events.ts": second }, tsconfig: TSCONFIG, compilerOptions: OPTIONS })).toThrow(/must be fed by dispatchAgentEvent alone/);
  });

  // v2026.10.33: the generator is gone — the dispatcher reads the registrations itself and
  // calls each one's `listener`; the bus's types moved to a sibling module it re-exports.
  const BUS_INLINE = BUS.replace('export type AgentEventPayload = { runId: string; seq: number; stream: string; ts: number; data: Record<string, unknown>; sessionKey?: string };', 'import type { AgentEventPayload } from "./agent-events.types.js";\nexport type { AgentEventPayload, AgentEventStream } from "./agent-events.types.js";')
    .replace("function* iterateAgentEventListeners(evt: AgentEventPayload): Generator<Listener> {\n  yield* listeners;\n}\n", "const registrations = new Map<Listener, { listener: Listener; id: number }>();\n")
    .replace("notifyListeners(iterateAgentEventListeners(enriched), enriched);", "notifyListeners([...registrations.values()].map((registration) => (delivered: AgentEventPayload) => { registration.listener(delivered); }), enriched);");
  const BUS_TYPES = `export type AgentEventStream = "lifecycle" | "tool" | (string & {});\nexport type AgentEventPayload = { runId: string; seq: number; stream: AgentEventStream; ts: number; data: Record<string, unknown>; sessionKey?: string };\n`;
  const inline = (bus: string) => derive({ root: "/virtual-upstream", files: { ...UPSTREAM, "src/infra/agent-events.ts": bus, "src/infra/agent-events.types.ts": BUS_TYPES }, tsconfig: TSCONFIG, compilerOptions: OPTIONS });

  it("derives the same surface from a dispatcher that calls the registrations itself, with the bus types re-exported (v2026.10.33 layout)", () => {
    expect(BUS_INLINE).not.toContain("iterateAgentEventListeners");
    expect(BUS_INLINE).toContain("registration.listener(delivered)");
    const next = inline(BUS_INLINE);
    const rows = (i: Inventory) => i.emissions.map((e) => `${e.file}|${e.function}|${e.stream}|${String(e.phase)}|${e.keys.map((k) => k.key).join(",")}`).sort();
    expect(rows(next)).toEqual(rows(inv));
    const root = (next as unknown as { root: { listenerIterator: string | null; listenerMember?: string; declaredStreams: { literals: string[]; open: boolean; source?: string } | null } }).root;
    expect(root.listenerIterator).toBeNull();
    expect(root.listenerMember).toBe("listener");
    // The declared stream union is read through the re-export, and says where it lives.
    expect(root.declaredStreams).toMatchObject({ literals: ["lifecycle", "tool"], open: true, source: "src/infra/agent-events.types.ts" });
    // …and the older layout's record is unchanged: no new key, the generator named.
    const before = (inv as unknown as { root: Record<string, unknown> }).root;
    expect(before.listenerIterator).toBe("iterateAgentEventListeners");
    expect(before).not.toHaveProperty("listenerMember");
  });

  it("in that layout, a second function reading a registration's listener is a second door", () => {
    const second = `${BUS_INLINE}\nexport function backdoor(e: AgentEventPayload) { for (const r of registrations.values()) r.listener(e); }\n`;
    expect(() => inline(second)).toThrow(/must be read by dispatchAgentEvent alone; read by \[dispatchAgentEvent, backdoor\]/);
    // Handed out without being called is the same door.
    const handed = `${BUS_INLINE}\nexport function leak() { return [...registrations.values()].map((r) => r.listener); }\n`;
    expect(() => inline(handed)).toThrow(/a second door to the public listeners/);
    // And a dispatcher that reaches no listener at all is not a root.
    const none = BUS_INLINE.replace("registration.listener(delivered);", "void delivered; void registration;");
    expect(() => inline(none)).toThrow(/must be read by dispatchAgentEvent alone; read by \[\]/);
  });
});

describe("deriveAgentEmissions — nothing is lost in silence", () => {
  it("an unresolvable stream is an OPAQUE row with its reason, not a missing one", () => {
    const op = inv.emissions.filter((e) => e.stream === null && e.file === "src/cases/opaque.ts");
    expect(op).toHaveLength(1);
    expect(op[0]?.streamOpaque?.reason).toMatch(/computeStream|string/);
    expect(inv.opaque.some((o) => o.file === "src/cases/opaque.ts" && o.what === "stream")).toBe(true);
  });

  it("unresolvable data is an opaque contribution on its row", () => {
    const [r] = rows("t_opaque_data");
    expect(r?.dataOpaque.map((o) => o.reason).join(" ")).toMatch(/index signature/);
    expect(inv.opaque.some((o) => o.file === "src/cases/opaque.ts" && o.what === "data")).toBe(true);
  });

  it("a reference that cannot be followed is an ESCAPE, listed", () => {
    expect(inv.escapes.some((e) => e.at.startsWith("src/cases/escape.ts:") && /push/.test(e.reason))).toBe(true);
  });

  it("excludes test files, and says which file and rule", () => {
    expect(rows("t_test_only")).toHaveLength(0);
    expect(inv.scope.testExclusion.byRule["test-suffix"]).toBeGreaterThanOrEqual(1);
    expect(inv.scope.testExclusion.excludedFilesMentioningFamily["src/cases/emits.test.ts"]?.rule).toBe("test-suffix");
  });

  it("puts back an excluded file that production code imports at runtime", () => {
    const files = {
      ...UPSTREAM,
      "src/cases/shared.test-helpers.ts": `import { emitAgentEvent } from "../infra/agent-events.js";\nexport function helper(runId: string) { emitAgentEvent({ runId, stream: "t_reincluded", data: { phase: "used" } }); }\n`,
      "src/cases/uses-helper.ts": `import { helper } from "./shared.test-helpers.js";\nexport function prod() { helper("r"); }\n`,
    };
    const out = derive({ root: "/v", files, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
    expect(out.scope.testExclusion.reincludedByImportGuard).toEqual([expect.objectContaining({ file: "src/cases/shared.test-helpers.ts", importedBy: "src/cases/uses-helper.ts" })]);
    expect(out.emissions.some((e) => e.stream === "t_reincluded")).toBe(true);
  });

  it("COMPLETENESS: every identifier spelled like a member is matched or a named homonym", () => {
    const c = inv.completeness;
    // `unaccounted` counts identifiers that DO bind to a member yet received no class.
    expect(c.unaccounted).toBe(0);
    expect(c.matched + c.homonyms + c.unaccounted).toBe(c.identifiers);
    // The parameter that shadows the emitter is not a reference to it…
    expect(c.homonymDeclarations).toEqual(expect.arrayContaining([expect.objectContaining({ name: "emitAgentEvent", boundTo: expect.stringMatching(/^src\/cases\/homonym\.ts:/) })]));
    expect(rows("t_homonym")).toHaveLength(0);
    // …and every reference to the real one is classified.
    const e = c.byName.emitAgentEvent;
    expect(e?.classes.emission).toBeGreaterThan(0);
    expect(e?.classes["import-export"]).toBeGreaterThan(0);
  });

  it("a wrapper stored where its calls cannot be followed still emits an OPEN row", () => {
    // The handler goes into a registry: its caller is unseen, but its template fixes the
    // stream and the phase, and the declared type of its parameter gives the rest.
    const [r] = rows("t_registry");
    expect(rows("t_registry")).toHaveLength(1);
    expect(r?.phase).toBe("notified");
    expect(r && keyList(r)).toEqual(["id", "phase"]);
    expect((r as unknown as { open: string[] | null }).open?.join(" ")).toMatch(/escapes: /);
  });

  it("a member exported by the public surface is an OPEN entry (callers unseen)", () => {
    const open = inv.openEntries.find((o) => o.label === "emitAgentEvent");
    expect(open?.openVia.join(" ")).toMatch(/exported as emitAgentEvent by the public module src\/plugin-sdk\/public\.ts/);
    expect(open?.shapes[0]?.streams[0]?.caller).toBe(true);
  });
});

describe("deriveAgentEmissions — after the emitter", () => {
  it("records the bus's own enrichment of lifecycle data", () => {
    const rw = inv.transformations.dataRewrites.find((r) => r.scope === "bus");
    expect(rw?.added).toEqual(["completionSource"]);
    expect(rw?.guard).toEqual([{ stream: ["lifecycle"], negated: false }]);
  });

  it("records a frame the gateway fabricates, and a data key it adds", () => {
    expect(inv.transformations.fabricated).toEqual([expect.objectContaining({ stream: "error", keys: ["expected", "reason"], sender: expect.stringContaining("broadcast") })]);
    expect(inv.transformations.dataRewrites).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "gateway", added: ["text"], guard: [{ stream: ["assistant"], negated: false }] })]));
  });

  it("content-part types: built into content, or compared on a content block — never by spelling alone", () => {
    expect(inv.chatContentParts.fabricated.map((x) => x.type)).toEqual(["text"]);
    const recognized = inv.chatContentParts.recognized.map((x) => x.type);
    expect(recognized).toEqual(["image", "reasoning", "thinking"]);
    expect(inv.chatContentParts.recognized.find((x) => x.type === "thinking")?.sites[0]?.how).toMatch(/^helper isReasoning/);
  });
});

describe("deriveAgentEmissions — gateway senders are DISCOVERED by symbol and classified on their final payload", () => {
  // Two reviews (2026-11-08): a sender call counted only when its event was a literal AT the
  // call and the callee's parameter was NAMED `event` — `const event = "agent"` or a wrapper
  // naming its parameter otherwise sent frames the inventory never saw; and following a
  // payload's stream to its origin dropped what a helper did to the payload (a replaced
  // `data`). Senders are now discovered by symbol from the transports' own senders, and each
  // call's payload is the template with the call's arguments substituted.
  const CHAT = `
import type { NodeRegistry } from "./node-registry.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
type Ctx = {
  broadcast: (event: string, payload: unknown) => void;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  registry: NodeRegistry;
};
// The bus event the handlers relay (a relay is of the bus event type, or made from it).
type Ev = Pick<AgentEventPayload, "runId" | "stream" | "data">;
declare function make(): unknown;
declare function pick(): string;
declare function pickEvent(): string;
declare function openRecord(): Record<string, unknown>;
/** Two literals contextually typed by ONE property: both reach the same declaration. */
type NotifyParams = { broadcast: (event: string, payload: unknown) => void };
function notifyAgent(params: NotifyParams) {
  params.broadcast("agent", { stream: "x_notify", data: { n: 1 } });
}
/** A sender stored in a field: the assignment's TARGET is not where the value goes. */
export class Relay {
  private readonly send: (event: string, payload: unknown) => void;
  constructor(options: { send: (event: string, payload: unknown) => void }) {
    this.send = options.send;
  }
  ping() {
    this.send("chat", { state: "final" });
  }
}
/** Exposed to plugins through the public surface: callers outside the program. */
export type PluginGatewayApi = { emitRaw: (event: string, payload: unknown) => void };
export function createChatHandlers(ctx: Ctx) {
  const constEvent = () => {
    const event = "agent";
    ctx.broadcast(event, { stream: "missed", data: { key: 1 } });
  };
  const viaBinding = (runId: string) => {
    const extra = { runId, stream: "x_extra", data: { k: 1 } };
    ctx.broadcast("agent", extra);
  };
  const relayAs = (channel: string, frame: unknown) => ctx.broadcastToConnIds(channel, frame, new Set());
  const renamed = () => relayAs("agent", { stream: "missed_renamed", data: { key: 1 } });
  const rewrite = (evt: Ev) => ctx.broadcast("agent", { ...evt, data: { phase: "new_phase", missed: 1 } });
  const caller = (runId: string) => rewrite({ runId, stream: "lifecycle", data: { phase: "start" } });
  const handleEvent = (evt: Ev) => {
    ctx.nodeSendToSession("k", "agent", evt);
    ctx.registry.sendEvent("n", "agent", { ...evt, data: { ...evt.data, text: "accumulated" } });
    ctx.broadcast("agent", { ...evt, data: { replaced: 1 } });
    ctx.broadcast("chat", { state: "final" });
  };
  const typedCall = (get: () => Ev) => ctx.broadcast("agent", get());
  const untyped = () => ctx.broadcast("agent", make());
  const computedStream = (evt: Ev) => ctx.broadcast("agent", { ...evt, stream: pick() });
  const openSpread = (evt: Ev) => ctx.broadcast("agent", { ...evt, ...openRecord() });
  const unknownEvent = () => ctx.broadcast(pickEvent(), { stream: "x_unknown_event", data: {} });
  const viaNotify1 = () => notifyAgent({ broadcast: ctx.broadcast });
  const viaNotify2 = () => notifyAgent({ broadcast: ctx.broadcast });
  const relay = new Relay({ send: ctx.broadcast });
  const api: PluginGatewayApi = { emitRaw: ctx.broadcast };
  return { constEvent, viaBinding, renamed, caller, handleEvent, typedCall, untyped, computedStream, openSpread, unknownEvent, viaNotify1, viaNotify2, relay, api };
}
`;
  const SERVER = `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { NodeRegistry } from "./node-registry.js";
import { createChatHandlers } from "./server-chat.js";
export function startGateway() {
  const broadcaster = createGatewayBroadcaster();
  const nodes = createGatewayNodeSessionRuntime();
  // A SPREAD into a contextually typed argument: \`ctx.broadcast\` is Ctx's property, linked
  // back to the broadcaster's by symbol.
  const handlers = createChatHandlers({ ...broadcaster, nodeSendToSession: nodes.nodeSendToSession, registry: new NodeRegistry() });
  return { handlers, plugin: broadcaster.broadcastPluginEvent };
}
`;
  let senders: Inventory;
  type Row = { function: string; sender?: string; reason?: string; stream?: string; keys?: string[]; phase?: unknown; phaseAbsent?: boolean; origins?: { kind: string; entries?: string[] }[] };
  const tf = () =>
    senders.transformations as unknown as {
      fabricated: Row[];
      relays: Row[];
      unresolved: Row[];
      senderSites: Record<string, number>;
      senders: { label: string }[];
      openSenders: { label: string; channel: string; open: string[] }[];
    };
  const fnOf = (r: Row) => r.function.replace(/^createChatHandlers > /, "");
  beforeAll(() => {
    senders = derive({
      root: "/virtual-upstream",
      files: {
        ...TRANSPORT,
        "src/infra/agent-events.ts": BUS,
        "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!,
        "src/gateway/server-chat.ts": CHAT,
        "src/gateway/server.ts": SERVER,
        "src/plugin-sdk/gateway.ts": `export type { PluginGatewayApi } from "../gateway/server-chat.js";\n`,
      },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("a frame sent through a const event, a renamed wrapper parameter or a binding is FABRICATED", () => {
    const fab = new Map(tf().fabricated.map((g) => [g.stream, [fnOf(g), g.keys]]));
    expect(fab.get("missed")).toEqual(["constEvent", ["key"]]);
    expect(fab.get("missed_renamed")).toEqual(["renamed", ["key"]]);
    expect(fab.get("x_extra")).toEqual(["viaBinding", ["k"]]);
  });

  it("a helper's transformation survives: its `data` replacement is the frame's", () => {
    const rows = tf().fabricated.filter((g) => g.stream === "lifecycle");
    expect(rows).toEqual([expect.objectContaining({ phase: "new_phase", keys: ["missed", "phase"] })]);
  });

  it("a relayed event names its origins — including where an escaping entry is reached", () => {
    const relays = tf().relays.filter((r) => fnOf(r) === "handleEvent");
    expect(relays.length).toBeGreaterThan(0);
    for (const r of relays) expect(r.origins?.every((o) => o.kind === "typed" && (o.entries ?? []).length > 0)).toBe(true);
    expect(tf().relays.some((r) => fnOf(r) === "typedCall")).toBe(true);
  });

  it("anything that cannot be resolved is UNRESOLVED and counted — never omitted", () => {
    const un = tf().unresolved.map((u) => [fnOf(u), u.reason]);
    expect(un).toEqual(
      expect.arrayContaining([
        ["untyped", expect.stringContaining("declared type is unknown")],
        ["computedStream", expect.stringMatching(/^a computed stream/)],
        ["openSpread", expect.stringContaining("may set the stream")],
        // A relayed event whose data the gateway REPLACES is not a relay of the bus event.
        ["handleEvent", expect.stringContaining("replaces a relayed event's data")],
        // An event nobody can evaluate could be `agent`.
        ["unknownEvent", expect.stringContaining("the event is not evaluated")],
      ]),
    );
    // …while a relayed event's data plus a RECORDED rewrite is not unresolved.
    expect(un.some(([, reason]) => /adds `text`/.test(String(reason)))).toBe(false);
    // …nor an event handed to a sender before another send: a send is a delivery.
    expect(un.some(([, reason]) => /passed to ctx\.nodeSendToSession/.test(String(reason)))).toBe(false);
  });

  it("another channel is pruned, and a sender whose own guard admits only `plugin.*` never counts as agent", () => {
    // Every send of the fixture, by the channel its EVALUATED event names: the node sends
    // (event second, after a session key) and the registry's are agent sends like the rest.
    expect(tf().senderSites).toEqual({ agent: 10, other: 3, undetermined: 1 });
    expect(tf().unresolved.some((u) => /plugin/i.test(`${u.function} ${u.reason}`))).toBe(false);
    expect(tf().senders.some((s) => /broadcastPluginEvent/.test(s.label))).toBe(true);
  });

  it("the forms the first 9.36 run lost are followed: shared declarations, a field assignment, plugin callers", () => {
    // Two literals typed by one property: each is credited with the references, so neither
    // reads as "referenced by no name" (open, and unresolved for a sender).
    expect(tf().fabricated.filter((g) => g.stream === "x_notify")).toHaveLength(1);
    expect(tf().unresolved.some((u) => /notify/i.test(`${u.function} ${u.reason}`))).toBe(false);
    // …so the only event nobody can evaluate is the one the fixture makes so.
    expect(tf().unresolved.filter((u) => /the event is not evaluated/.test(String(u.reason))).map(fnOf)).toEqual(["unknownEvent"]);
    // `this.send = options.send`: the target is not an escape; the field's calls are sites.
    expect(senders.escapes.some((e) => /BinaryExpression/.test(e.reason))).toBe(false);
    // A sender plugins can call is an OPEN entry, listed — not a site guessed at.
    expect(tf().openSenders).toEqual([expect.objectContaining({ channel: "undetermined", open: expect.arrayContaining([expect.stringContaining("a type the public surface exposes")]) })]);
    expect(tf().unresolved.some((u) => /emitRaw/.test(`${u.function} ${u.sender}`))).toBe(false);
  });

  it("every reference to a sender is accounted for", () => {
    expect(senders.completeness.unaccounted).toBe(0);
  });

  it("refuses a gateway whose transport moved: a discovery that starts nowhere finds nothing", () => {
    const files = { ...UPSTREAM };
    delete files["src/gateway/server-broadcast.ts"];
    expect(() => derive({ root: "/v", files, tsconfig: TSCONFIG, compilerOptions: OPTIONS })).toThrow(/upstream moved a frame sender/);
    const renamed = { ...UPSTREAM, "src/gateway/node-registry.ts": TRANSPORT["src/gateway/node-registry.ts"]!.replace("class NodeRegistry", "class NodeRegistryRenamed") };
    expect(() => derive({ root: "/v", files: renamed, tsconfig: TSCONFIG, compilerOptions: OPTIONS })).toThrow(/no class NodeRegistry/);
  });
});

describe("deriveAgentEmissions — a sender stored in an object is followed through the object", () => {
  // The second 9.36 run (2026-11-08) refused nine senders as "referenced by no name". Three
  // mirrors of what upstream does with them: a shorthand destructuring
  // (`createAgentEventHandler({ broadcast, … })`), a whole object handed to a function whose
  // own type redeclares the slot (`abortChatRunById(params, …)` reading `ops.broadcast`), and
  // a field no use reads (`GatewayConnectionOptions.broadcast`). Then what must stay refused.
  const FILES: Record<string, string> = {
    "src/gateway/handler-a.ts": `
export type HandlerAOptions = { broadcast: (event: string, payload: unknown) => void; nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void };
export function createHandlerA({ broadcast, nodeSendToSession }: HandlerAOptions) {
  return (runId: string) => {
    broadcast("agent", { stream: "x_destructured", data: { runId } });
    nodeSendToSession("k", "agent", { stream: "x_destructured_node", data: { runId } });
  };
}
`,
    "src/gateway/abort-ops.ts": `
export type AbortOps = { broadcast: (event: string, payload: unknown) => void; nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void };
export function abortRun(ops: AbortOps, runId: string) {
  ops.broadcast("chat", { runId, state: "aborted" });
  ops.nodeSendToSession("k", "chat", { runId });
  ops.broadcast("agent", { stream: "x_converted", data: { runId } });
}
`,
    "src/gateway/shutdown-b.ts": `
import { abortRun } from "./abort-ops.js";
export type ShutdownParams = {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  runs: string[];
};
function abortAll(params: ShutdownParams): number {
  for (const runId of params.runs) abortRun(params, runId);
  return params.runs.length;
}
export function prepareShutdown(params: { restart: boolean } & ShutdownParams) {
  if (!params.restart) abortAll(params);
}
export function shutdown(params: ShutdownParams & { reason: string }) {
  prepareShutdown({ ...params, restart: false });
}
`,
    "src/gateway/conn-c.ts": `
export type ConnOptions = { broadcast: (event: string, payload: unknown) => void; logWarn: (message: string) => void; port: number };
export function attachConn(params: ConnOptions & { socket: object }) {
  const { logWarn, port } = params;
  const onClose = () => {
    logWarn(\`closed on \${port}\`);
    return params.socket;
  };
  return onClose;
}
export function attachWs(params: ConnOptions & { wss: { on: (event: string, f: () => void) => void } }) {
  params.wss.on("connection", () => {
    attachConn({ ...params, socket: {} });
  });
}
`,
    "src/gateway/conn-d.ts": `
declare function externalSink(value: unknown): void;
export type DynOptions = { broadcast: (event: string, payload: unknown) => void; other: () => void };
export function useDyn(params: DynOptions, key: keyof DynOptions) {
  return params[key];
}
export type SinkOptions = { broadcast: (event: string, payload: unknown) => void; label: string };
export function useSink(params: SinkOptions) {
  externalSink(params);
}
export type KeepOptions = { broadcast: (event: string, payload: unknown) => void; label: string };
export function keep(params: KeepOptions) {
  return params;
}
// A container RETURNED by a function no analysed code calls: an entry point outside the
// sources could read the slot.
import { createGatewayBroadcaster } from "./server-broadcast.js";
export function exposeOps() {
  const { broadcast } = createGatewayBroadcaster();
  return { send: broadcast, label: "q" };
}
`,
    // A parameter property outlives its constructor: \`this.opts\` is read in another method.
    "src/gateway/holder-e.ts": `
export type HolderOptions = { broadcast: (event: string, payload: unknown) => void; label: string };
type Sender = { broadcast: (event: string, payload: unknown) => void };
function sendThrough(target: Sender) {
  target.broadcast("agent", { stream: "x_field", data: {} });
}
export class Holder {
  constructor(private readonly opts: HolderOptions) {}
  flush() {
    sendThrough(this.opts);
  }
}
`,
    // A second, DIFFERENT sender reaches the same AbortOps slot (the third 9.36 run: the close
    // path's wrapper and the maintenance path's runtime sender both land in
    // \`ChatAbortOps.nodeSendToSession\`).
    "src/gateway/maintenance-g.ts": `
import { abortRun } from "./abort-ops.js";
export type MaintenanceParams = { broadcast: (event: string, payload: unknown) => void; nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void };
export function startMaintenance(params: MaintenanceParams) {
  abortRun(params, "stale");
}
`,
    "src/gateway/cast-f.ts": `
export type CastOptions = { broadcast: (event: string, payload: unknown) => void; label: string };
type Loose = { broadcast: (event: string, payload: unknown) => void };
export function viaCast(params: CastOptions) {
  (params as Loose).broadcast("agent", { stream: "x_cast", data: {} });
}
`,
    "src/gateway/wiring.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { createHandlerA } from "./handler-a.js";
import { shutdown } from "./shutdown-b.js";
import { attachWs } from "./conn-c.js";
import { keep, useDyn, useSink } from "./conn-d.js";
import { Holder } from "./holder-e.js";
import { viaCast } from "./cast-f.js";
import { startMaintenance } from "./maintenance-g.js";
export function wire(wss: { on: (event: string, f: () => void) => void }) {
  const { broadcast } = createGatewayBroadcaster();
  const { nodeSendToSession } = createGatewayNodeSessionRuntime();
  const handler = createHandlerA({ broadcast, nodeSendToSession });
  shutdown({ broadcast, nodeSendToSession: (k, e, p) => { void nodeSendToSession(k, e, p); }, runs: [], reason: "stop" });
  attachWs({ wss, broadcast, logWarn: () => {}, port: 1 });
  useDyn({ broadcast, other: () => {} }, "other");
  useSink({ broadcast, label: "x" });
  keep({ broadcast, label: "y" });
  new Holder({ broadcast, label: "z" }).flush();
  viaCast({ broadcast, label: "w" });
  startMaintenance({ broadcast, nodeSendToSession });
  return handler;
}
`,
  };
  type Row = { file: string; line: number; function: string; reason?: string; open?: string[]; stream?: string };
  let followed: Inventory;
  const tf = () => followed.transformations as unknown as { fabricated: Row[]; unresolved: Row[] };
  const unread = () => (followed as unknown as { unreadSlots: { family: string; slot: string; at: string; followed: number }[] }).unreadSlots;
  const lineOf = (needle: string) => FILES["src/gateway/wiring.ts"]!.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const unresolvedAt = (needle: string) => tf().unresolved.filter((u) => u.file === "src/gateway/wiring.ts" && u.line === lineOf(needle));
  beforeAll(() => {
    followed = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("a member read only by a shorthand destructuring is referenced: the new binding does not take its credit", () => {
    expect(unresolvedAt("createHandlerA({")).toEqual([]);
    const streams = tf().fabricated.map((g) => g.stream);
    expect(streams).toEqual(expect.arrayContaining(["x_destructured", "x_destructured_node"]));
  });

  it("an object handed whole to another type carries the slot into THAT type's declaration", () => {
    expect(unresolvedAt("shutdown({")).toEqual([]);
    expect(tf().fabricated).toEqual(expect.arrayContaining([expect.objectContaining({ stream: "x_converted", file: "src/gateway/abort-ops.ts" })]));
  });

  it("a slot two different senders reach: a call fills EACH sender's parameters", () => {
    // `ops.nodeSendToSession("k", "chat", …)` is a chat send whichever sender the slot holds.
    expect(tf().unresolved.filter((u) => u.file === "src/gateway/abort-ops.ts")).toEqual([]);
    expect(unresolvedAt("startMaintenance({")).toEqual([]);
  });

  it("a cast is a conversion too: the asserted type's slot is followed", () => {
    expect(unresolvedAt("viaCast({")).toEqual([]);
    expect(tf().fabricated).toEqual(expect.arrayContaining([expect.objectContaining({ stream: "x_cast", file: "src/gateway/cast-f.ts" })]));
  });

  it("a slot no use of its object reads is UNREAD, proved, not unresolved", () => {
    expect(unresolvedAt("attachWs({")).toEqual([]);
    expect(unread()).toEqual(expect.arrayContaining([expect.objectContaining({ family: "sender", slot: "broadcast", at: `src/gateway/wiring.ts:${lineOf("attachWs({")}` })]));
  });

  it("what the following cannot see stays UNRESOLVED: a computed key, code outside the sources, an uncalled factory, a class field", () => {
    const openOf = (needle: string) => unresolvedAt(needle).flatMap((u) => u.open ?? []);
    expect(openOf("useDyn({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is read under a computed key")]));
    expect(openOf("useSink({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is passed to code outside the analysed sources")]));
    // A returned object reaches its function's callers; one no analysed code calls escapes.
    const exposed = tf().unresolved.filter((u) => u.file === "src/gateway/conn-d.ts").flatMap((u) => u.open ?? []);
    expect(exposed).toEqual(expect.arrayContaining([expect.stringContaining("its object is returned by a function no analysed code calls")]));
    for (const needle of ["useDyn({", "useSink({"]) {
      expect(unread().some((s) => s.at === `src/gateway/wiring.ts:${lineOf(needle)}`), needle).toBe(false);
    }
  });

  it("a class field is followed: `this.opts` anywhere in the class holds the object", () => {
    expect(unresolvedAt("new Holder({")).toEqual([]);
    expect(tf().fabricated).toEqual(expect.arrayContaining([expect.objectContaining({ stream: "x_field", file: "src/gateway/holder-e.ts" })]));
  });

  it("a returned object is followed to its callers: discarded there, its slot is unread", () => {
    expect(unresolvedAt("keep({")).toEqual([]);
    expect(unread()).toEqual(expect.arrayContaining([expect.objectContaining({ slot: "broadcast", at: `src/gateway/wiring.ts:${lineOf("keep({")}` })]));
  });

  it("every reference is still accounted for", () => {
    expect(followed.completeness.unaccounted).toBe(0);
  });
});

describe("deriveAgentEmissions — the third review's silent omissions", () => {
  // Codex, 2026-11-08: three forms passed with `unresolved: []` and `unaccounted: 0` while
  // an agent frame went missing. Each must now enrich the inventory or refuse.
  const MIRROR: Record<string, string> = {
    // 1. A call through a literal key, beside a followed call by name; a computed key.
    "src/gateway/ops-h.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
declare function later(run: () => void): void;
export function runOps() {
  const { broadcast } = createGatewayBroadcaster();
  const ops = { send: broadcast };
  ops.send("chat", {});
  ops["send"]("agent", { stream: "x_bracket", data: { lost: 1 } });
  later(() => ops["send"]("agent", { stream: "x_bracket_closure", data: { late: 1 } }));
}
export function runComputed(key: "send" | "other") {
  const { broadcast } = createGatewayBroadcaster();
  const table = { send: broadcast, other: (event: string, payload: unknown) => void [event, payload] };
  table.send("chat", {});
  table[key]("agent", { stream: "x_hidden", data: {} });
}
// A read the following sees but no reference by name can follow (the slot typed \`any\`).
export function runUntyped() {
  const { broadcast } = createGatewayBroadcaster();
  const box = { send: broadcast };
  const loose: any = box;
  loose.send("agent", { stream: "x_untyped_read", data: {} });
}
// An object NESTED in another, handed whole to a function of another type.
type OtherOps = { send: (event: string, payload: unknown) => void };
function abortWith(o: OtherOps) {
  o.send("agent", { stream: "x_nested_conv", data: { n: 1 } });
}
function useNested(deps: { ops: { send: (event: string, payload: unknown) => void } }) {
  abortWith(deps.ops);
}
export function runNested() {
  const { broadcast } = createGatewayBroadcaster();
  useNested({ ops: { send: broadcast } });
}
// An object returned by a callback handed to code that does not pass its return on.
declare function register(make: () => unknown): void;
export function registerOps() {
  const { broadcast } = createGatewayBroadcaster();
  register(() => ({ send: broadcast }));
}
`,
    // 2. A payload written after it is built, through an alias, by a helper, by code
    //    outside the sources — and after the send.
    "src/gateway/mutate-i.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
declare function externalMutate(p: unknown): void;
function rewriteFrame(p: { stream: string; data: Record<string, unknown> }) {
  p.stream = "x_rewritten";
  p.data = { replaced: 1 };
}
export function runMutations() {
  const { broadcast } = createGatewayBroadcaster();
  const payload = { stream: "x_mut", data: { a: 1 } as Record<string, unknown> };
  payload.data.newKey = 1;
  const d = payload.data;
  d.aliasKey = 1;
  broadcast("agent", payload);
  const viaHelper = { stream: "x_helper", data: { b: 1 } as Record<string, unknown> };
  rewriteFrame(viaHelper);
  broadcast("agent", viaHelper);
  const viaExternal = { stream: "x_external", data: { c: 1 } };
  externalMutate(viaExternal);
  broadcast("agent", viaExternal);
  const late = { stream: "x_late", data: { e: 1 } as Record<string, unknown> };
  broadcast("agent", late);
  late.data.afterSend = 1;
}
`,
  };
  // The forms the first pass after these fixes refused on 9.36 (2026-11-08): an event
  // string handed to a helper, a factory reached through a dynamic import, a callback
  // whose return a wrapper passes through, a class field assigned in the constructor.
  Object.assign(MIRROR, {
    "src/gateway/runtime-k.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
declare function observe(event: string): void;
export function createRuntimeK() {
  const { broadcast } = createGatewayBroadcaster();
  return { notify: broadcast, label: "k" };
}
export function relayK(event: string, payload: { stream: string; data: Record<string, unknown> }) {
  observe(event);
  const { broadcast } = createGatewayBroadcaster();
  broadcast(event, payload);
}
export function useRelayK() {
  relayK("agent", { stream: "x_prim", data: {} });
}
`,
    "src/gateway/lazy-k.ts": `
// upstream's startupTrace.measure (src/gateway/server-channels.ts)
declare function measure<T>(name: string, run: () => T | Promise<T>): Promise<T>;
type Deps = { notify: (event: string, payload: unknown) => void };
class Keeper {
  private deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }
  fire() {
    this.deps.notify("agent", { stream: "x_kept", data: { f: 1 } });
  }
  fireDestructured() {
    const { deps } = this;
    deps.notify("agent", { stream: "x_this_destructured", data: { d: 1 } });
  }
}
// upstream's GatewayRestartTransaction (src/gateway/server-reload-restart.ts)
class Txn {
  constructor(private readonly options: Deps) {}
  run() {
    this.options.notify("agent", { stream: "x_txn", data: { t: 1 } });
  }
}
export async function startLazy() {
  const { createRuntimeK } = await import("./runtime-k.js");
  const { notify } = createRuntimeK();
  notify("agent", { stream: "x_lazy", data: { z: 1 } });
  // upstream's server-lifecycle.ts: a rest destructuring of the factory's object
  const { label, ...restK } = createRuntimeK();
  void label;
  restK.notify("agent", { stream: "x_rest", data: { r: 1 } });
  const runtime = await measure("runtime", () => createRuntimeK());
  runtime.notify("agent", { stream: "x_measured", data: { m: 1 } });
  const keeper = new Keeper({ notify: createRuntimeK().notify });
  keeper.fire();
  keeper.fireDestructured();
  new Txn({ notify: createRuntimeK().notify }).run();
}
`,
  });
  // A payload handed to a sender before another send: upstream's sendLivePayload
  // (src/gateway/server-chat.ts) broadcasts a payload, then sends the same one to the node
  // session. A send is a delivery; a helper's own writes still count, and code outside the
  // sources still refuses.
  Object.assign(MIRROR, {
    "src/gateway/live-q.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
type Senders = {
  broadcast: (event: string, payload: unknown, opts?: unknown) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown, opts?: unknown) => void;
};
declare function audit(p: unknown): void;
function createLiveQ({ broadcast, nodeSendToSession }: Senders) {
  const sendLive = (event: "agent" | "chat", sessionKey: string | undefined, payload: Frame) => {
    broadcast(event, payload, {});
    if (sessionKey) nodeSendToSession(sessionKey, event, payload, {});
  };
  const stamp = (p: Frame) => {
    p.data.stamped = 1;
    broadcast("agent", p);
  };
  return {
    liveQ: () => sendLive("agent", "k", { runId: "r", stream: "x_live", data: { q: 1 } }),
    stampedQ: () => {
      const p: Frame = { runId: "r", stream: "x_stamped", data: { s: 1 } };
      stamp(p);
      nodeSendToSession("k", "agent", p);
    },
    auditedQ: () => {
      const p: Frame = { runId: "r", stream: "x_audited", data: {} };
      broadcast("agent", p);
      audit(p);
      nodeSendToSession("k", "agent", p);
    },
  };
}
export function wireQ() {
  const b = createGatewayBroadcaster();
  const n = createGatewayNodeSessionRuntime();
  return createLiveQ({ broadcast: b.broadcast, nodeSendToSession: n.nodeSendToSession });
}
// The transport's own sender, called directly: its body hands the payload to code outside
// the sources, and is the transport, not analysed.
export function directQ() {
  const { nodeSendToSession } = createGatewayNodeSessionRuntime();
  const { broadcast } = createGatewayBroadcaster();
  const p = { runId: "r", stream: "x_direct", data: { d: 1 } };
  nodeSendToSession("k", "agent", p);
  broadcast("agent", p);
}
`,
  });
  // A class field is followed only where TypeScript keeps its reads: each form below can
  // read the field where no reference is followed, and must refuse. One factory per form.
  const factory = (letter: string) => `
import { createGatewayBroadcaster } from "./server-broadcast.js";
export function createRuntime${letter}() {
  const { broadcast } = createGatewayBroadcaster();
  return { notify: broadcast };
}
`;
  Object.assign(MIRROR, {
    "src/gateway/runtime-l.ts": factory("L"),
    "src/gateway/runtime-m.ts": factory("M"),
    "src/gateway/runtime-n.ts": factory("N"),
    "src/gateway/runtime-o.ts": factory("O"),
    "src/gateway/runtime-p.ts": factory("P"),
    "src/gateway/fields-l.ts": `
import { createRuntimeL } from "./runtime-l.js";
import { createRuntimeM } from "./runtime-m.js";
import { createRuntimeN } from "./runtime-n.js";
import { createRuntimeO } from "./runtime-o.js";
import { createRuntimeP } from "./runtime-p.js";
type Notify = { notify: (event: string, payload: unknown) => void };
declare function leak(x: unknown): void;
// Not private: any holder of an instance reads \`deps\`.
class Exposed {
  constructor(readonly deps: Notify) {}
}
// A computed key on the instance can be the field.
class Lookup {
  private deps: Notify;
  constructor(deps: Notify) {
    this.deps = deps;
  }
  get(key: string) {
    return (this as any)[key];
  }
}
// Destructured from the instance, then handed on.
class Leaky {
  private deps: Notify;
  constructor(deps: Notify) {
    this.deps = deps;
  }
  run() {
    const { deps } = this;
    leak(deps);
  }
}
// A literal key reaches a private field from anywhere.
class Keyed {
  private deps: Notify;
  constructor(deps: Notify) {
    this.deps = deps;
  }
}
// A rest destructuring of the instance carries every field.
class Rest {
  private deps: Notify;
  constructor(deps: Notify) {
    this.deps = deps;
  }
  run() {
    const { ...all } = this;
    leak(all);
  }
}
export function fieldsL() {
  void new Exposed({ notify: createRuntimeL().notify });
  void new Lookup({ notify: createRuntimeM().notify });
  new Leaky({ notify: createRuntimeN().notify }).run();
  leak(new Keyed({ notify: createRuntimeO().notify })["deps"]);
  new Rest({ notify: createRuntimeP().notify }).run();
}
`,
  });
  type Row = { file: string; line: number; function: string; stream?: string; keys?: string[]; reason?: string; open?: string[] };
  let inv3: Inventory;
  const tf = () => inv3.transformations as unknown as { fabricated: Row[]; unresolved: Row[] };
  const rowsOf = (stream: string) => tf().fabricated.filter((g) => g.stream === stream);
  beforeAll(() => {
    inv3 = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...MIRROR },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("1. a literal key is a reference like a name: `ops[\"send\"](…)` is a site, in a closure too", () => {
    expect(rowsOf("x_bracket")).toEqual([expect.objectContaining({ keys: ["lost"] })]);
    expect(rowsOf("x_bracket_closure")).toEqual([expect.objectContaining({ keys: ["late"] })]);
  });

  it("1. a computed key on the object is UNRESOLVED, even beside a followed reference", () => {
    const open = tf().unresolved.filter((u) => u.file === "src/gateway/ops-h.ts").flatMap((u) => u.open ?? []);
    expect(open).toEqual(expect.arrayContaining([expect.stringContaining("its object is read under a computed key")]));
    expect(rowsOf("x_hidden")).toEqual([]);
  });

  it("1. a read the following sees and no reference follows is UNRESOLVED, never dropped", () => {
    const open = tf().unresolved.filter((u) => u.file === "src/gateway/ops-h.ts").flatMap((u) => u.open ?? []);
    expect(open).toEqual(expect.arrayContaining([expect.stringContaining("its object is read where no reference was followed")]));
  });

  it("1. an object a nameless callback returns to code that does not pass it on is UNRESOLVED", () => {
    const open = tf().unresolved.filter((u) => u.file === "src/gateway/ops-h.ts").flatMap((u) => u.open ?? []);
    expect(open).toEqual(expect.arrayContaining([expect.stringContaining("its object is returned by a function with no name to be called by")]));
  });

  it("1. an object nested in another is followed: handed whole to another type, its slot is linked", () => {
    expect(rowsOf("x_nested_conv")).toEqual([expect.objectContaining({ keys: ["n"] })]);
  });

  it("2. writes to the payload before the send are its frame: nested, through an alias", () => {
    expect(rowsOf("x_mut")).toEqual([expect.objectContaining({ keys: expect.arrayContaining(["a", "newKey", "aliasKey"]) })]);
  });

  it("2. a helper's writes are followed into the frame", () => {
    expect(rowsOf("x_rewritten")).toEqual(expect.arrayContaining([expect.objectContaining({ keys: ["replaced"] })]));
  });

  it("2. a payload handed to code whose effects are not modeled, before the send, is UNRESOLVED", () => {
    const un = tf().unresolved.filter((u) => u.file === "src/gateway/mutate-i.ts");
    expect(un.map((u) => u.reason).join(" | ")).toMatch(/externalMutate/);
  });

  it("2. a write after the send is not the frame's", () => {
    expect(rowsOf("x_late")).toEqual([expect.objectContaining({ keys: ["e"] })]);
  });

  it("the forms the 9.36 pass refused: a string handed to a helper stays a string; a dynamic import, a passthrough callback and a class field are followed", () => {
    for (const stream of ["x_prim", "x_lazy", "x_rest", "x_measured", "x_kept", "x_this_destructured", "x_txn"]) expect(rowsOf(stream).length, stream).toBeGreaterThan(0);
    const un = tf().unresolved.filter((u) => u.file === "src/gateway/runtime-k.ts" || u.file === "src/gateway/lazy-k.ts");
    expect(un.map((u) => `${u.file}:${u.line} ${u.reason} ${(u.open ?? []).join("; ")}`)).toEqual([]);
  });

  it("2. a payload handed to a sender before another send keeps its shape: a send is a delivery", () => {
    const un = tf().unresolved.filter((u) => u.file === "src/gateway/live-q.ts");
    expect(rowsOf("x_live").length).toBeGreaterThan(0);
    for (const r of rowsOf("x_live")) expect(r.keys).toEqual(["q"]);
    // The helper's own write counts; only its inner send is a delivery.
    expect(rowsOf("x_stamped").length).toBeGreaterThan(0);
    for (const r of rowsOf("x_stamped")) expect(r.keys).toEqual(expect.arrayContaining(["s", "stamped"]));
    expect(rowsOf("x_direct").length).toBeGreaterThan(0);
    for (const r of rowsOf("x_direct")) expect(r.keys).toEqual(["d"]);
    expect(un.filter((u) => /liveQ|stampedQ|sendLive|stamp|directQ/.test(u.function)).map((u) => `${u.function}: ${u.reason}`)).toEqual([]);
  });

  it("2. beside a send, code outside the sources still refuses, named alone", () => {
    const reasons = tf().unresolved.filter((u) => u.file === "src/gateway/live-q.ts").map((u) => u.reason ?? "");
    expect(reasons.some((r) => /audit\(/.test(r))).toBe(true);
    expect(reasons.some((r) => /passed to broadcast\(/.test(r))).toBe(false);
  });

  // The open slot is the one each literal `{ notify: createRuntimeX().notify }` fills.
  const openOfFactory = (letter: string) => {
    const line = (MIRROR["src/gateway/fields-l.ts"] ?? "").split("\n").findIndex((l) => l.includes(`createRuntime${letter.toUpperCase()}().notify`)) + 1;
    expect(line, letter).toBeGreaterThan(0);
    return tf().unresolved.filter((u) => u.file === "src/gateway/fields-l.ts" && u.line === line).flatMap((u) => u.open ?? []);
  };
  it("a class field code outside the class can read is UNRESOLVED", () => {
    expect(openOfFactory("l")).toEqual(expect.arrayContaining([expect.stringContaining("its object is kept in a class field that code outside the class can read")]));
  });

  it("a class that reads its instance under a computed key is UNRESOLVED", () => {
    expect(openOfFactory("m")).toEqual(expect.arrayContaining([expect.stringContaining("the class reads its instance under a computed key")]));
  });

  it("a field destructured from its instance is followed: handed to code outside the sources, UNRESOLVED", () => {
    expect(openOfFactory("n")).toEqual(expect.arrayContaining([expect.stringContaining("its object is passed to code outside the analysed sources")]));
  });

  it("a literal key reaches a private field from anywhere: handed to code outside the sources, UNRESOLVED", () => {
    expect(openOfFactory("o")).toEqual(expect.arrayContaining([expect.stringContaining("its object is passed to code outside the analysed sources")]));
  });

  it("a rest destructuring of the instance carries its fields: handed on, UNRESOLVED", () => {
    expect(openOfFactory("p")).toEqual(expect.arrayContaining([expect.stringContaining("its object is passed to code outside the analysed sources")]));
  });

  it("every reference is accounted for, literal keys included", () => {
    expect(inv3.completeness.unaccounted).toBe(0);
  });
});

describe("deriveAgentEmissions — what the first 9.36 pass after the C3 fixes refused", () => {
  // Pass 8 (2026-11-08): the busiest bus site (embedded-agent-subscribe.handlers.tools.
  // completion.ts, handleToolExecutionEnd) ran out of evaluation budget — a binding written
  // before it is read was re-evaluated at every reference — and lost its family and keys; the
  // gateway kernel hands its runtime through more layers than the container following's
  // bound allowed. And an alias read at the send must see what was done to its object after
  // the alias.
  const chain = (n: number) => {
    const lines = [`  const v0 = { k0: 1 } as Record<string, unknown>;`, `  v0.w0 = 1;`];
    for (let i = 1; i <= n; i += 1) lines.push(`  const v${i} = { ...v${i - 1}, ...v${i - 1} } as Record<string, unknown>;`, `  v${i}.w${i} = 1;`);
    return lines.join("\n");
  };
  const blow = (n: number) => {
    const lines = [`  const a0 = { ...x, ...x };`];
    for (let i = 1; i <= n; i += 1) lines.push(`  const a${i} = { ...a${i - 1}, ...a${i - 1} };`);
    return `${lines.join("\n")}\n  return a${n};`;
  };
  // An argument costly enough that evaluating it at each of eight references runs out of
  // budget, and once does not.
  const REPEAT_DEPTH = 12;
  const SHARED_DEPTH = 13;
  const SHARED_FILLER_DEPTH = 10;
  const SHARED_FILLERS = 12;
  const layers = 8;
  const deepTypes = Array.from({ length: layers }, (_, i) => `type T${i + 1} = { inner: T${i} };`).join("\n");
  const deepFns = Array.from({ length: layers }, (_, i) => `function w${i + 1}(x: T${i}): T${i + 1} {\n  return { inner: x };\n}`).join("\n");
  const deepUse = Array.from({ length: layers }, (_, i) => `  const r${i + 1} = w${i + 1}(r${i});`).join("\n");
  const FILES: Record<string, string> = {
    "src/cases/cost-r.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function costly(runId: string) {
${chain(18)}
  emitAgentEvent({ runId, stream: "x_cost", data: v18 });
}
`,
    // The first site spends most of its budget on fillers no memo can share (fresh
    // arguments each time), then reads `shared`, whose own evaluation crosses the bound; the
    // second site reads `shared` with a budget of its own, and has room for it.
    "src/cases/shared-r.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function filler(x: Record<string, unknown>) {
${blow(SHARED_FILLER_DEPTH)}
}
function heavy(x: Record<string, unknown>) {
${blow(SHARED_DEPTH)}
}
export function sharedSites(runId: string) {
  const shared = { ...heavy({ sharedKey: 1 }) };
  emitAgentEvent({ runId, stream: "x_blow", data: { ${Array.from({ length: SHARED_FILLERS }, (_, i) => `...filler({ f${i}: 1 })`).join(", ")}, ...shared } });
  emitAgentEvent({ runId, stream: "x_shared", data: { ...shared } });
}
export function aliasBus(runId: string) {
  const b = { k: 1 } as Record<string, unknown>;
  const a = b;
  b.lateBus = 1;
  emitAgentEvent({ runId, stream: "x_alias_bus", data: a });
}
`,
    "src/gateway/alias-r.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
export function aliasR() {
  const { broadcast } = createGatewayBroadcaster();
  const b: Frame = { runId: "r", stream: "x_alias_late", data: { a: 1 } };
  const a = b;
  b.data.late = 1;
  broadcast("agent", a);
  const p: Frame = { runId: "r", stream: "x_unsent", data: { c: 1 } };
  const { data } = p;
  p.data.late2 = 1;
  broadcast("agent", { stream: "x_alias_destr", data });
  const q: Frame = { runId: "r", stream: "x_alias_cond", data: { e: 1 } };
  const pick = q.runId ? q : q;
  q.data.late3 = 1;
  broadcast("agent", pick);
}
`,
    "src/cases/repeat-r.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function heavy(x: Record<string, unknown>) {
${blow(REPEAT_DEPTH)}
}
function enrich(target: Record<string, unknown>, extra: Record<string, unknown>) {
  target.data = extra;
}
export function repeated(runId: string) {
  const p = { data: {} } as { data: Record<string, unknown> };
  enrich(p, heavy({ k: 1 }));
  emitAgentEvent({ runId, stream: "x_repeat", data: { ...p.data, ...p.data, ...p.data, ...p.data, ...p.data, ...p.data, ...p.data, ...p.data } });
}
`,
    // Pass 9: handleEvent hands its event through predicate chains deeper than the effect
    // bound. Past the bound, a chain that only reads still has no effect; one that writes,
    // or reaches code whose effects are not modeled, refuses, naming what it reached.
    "src/gateway/chain-r.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
declare function opaqueCheck(x: unknown): boolean;
${Array.from({ length: 6 }, (_, i) => `function r${i}(x: Frame): boolean {\n  return ${i < 5 ? `r${i + 1}(x)` : "typeof x.stream === \"string\""};\n}`).join("\n")}
${Array.from({ length: 6 }, (_, i) => `function w${i}(x: Frame): boolean {\n  ${i < 5 ? `return w${i + 1}(x);` : "x.data.late = 1;\n  return true;"}\n}`).join("\n")}
${Array.from({ length: 6 }, (_, i) => `function e${i}(x: Frame): boolean {\n  return ${i < 5 ? `e${i + 1}(x)` : "opaqueCheck(x)"};\n}`).join("\n")}
function loopA(x: Frame, n: number): boolean {
  return n > 0 ? loopB(x, n - 1) : x.stream === "s";
}
function loopB(x: Frame, n: number): boolean {
  return loopA(x, n);
}
export function chains() {
  const { broadcast } = createGatewayBroadcaster();
  const readOnly: Frame = { runId: "r", stream: "x_chain_read", data: { a: 1 } };
  r0(readOnly);
  broadcast("agent", readOnly);
  const written: Frame = { runId: "r", stream: "x_chain_write", data: { b: 1 } };
  w0(written);
  broadcast("agent", written);
  const external: Frame = { runId: "r", stream: "x_chain_external", data: { c: 1 } };
  e0(external);
  broadcast("agent", external);
  const cyclic: Frame = { runId: "r", stream: "x_chain_cycle", data: { d: 1 } };
  loopA(cyclic, 3);
  broadcast("agent", cyclic);
}
`,
    // A callee that writes a key but never reads its other argument: that argument, however
    // costly, is not evaluated.
    "src/cases/marked-r.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
function huge(x: Record<string, unknown>) {
${blow(20)}
}
function mark(target: Record<string, unknown>, unused: Record<string, unknown>) {
  target.marked = 1;
}
export function marked(runId: string) {
  const q = { base: 1 } as Record<string, unknown>;
  mark(q, huge({ k: 1 }));
  const after = { tail: 1 };
  emitAgentEvent({ runId, stream: "x_marked", data: { ...q, ...after } });
}
`,
    // One binding read by the bus and by a sender: each mode has its own value.
    "src/gateway/mixed-r.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
declare function externalTouch(x: unknown): void;
export function mixed(runId: string) {
  const { broadcast } = createGatewayBroadcaster();
  const inner = { m: 1 } as Record<string, unknown>;
  externalTouch(inner);
  const data = { ...inner };
  const outer = { runId, stream: "x_mixed", data };
  broadcast("agent", outer);
  emitAgentEvent(outer);
}
`,
    "src/gateway/deep-r.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type T0 = { notify: (event: string, payload: unknown) => void };
${deepTypes}
${deepFns}
function createRuntimeR(): T0 {
  const { broadcast } = createGatewayBroadcaster();
  return { notify: broadcast };
}
export function deepR() {
  const r0 = createRuntimeR();
${deepUse}
  r${layers}${".inner".repeat(layers)}.notify("agent", { stream: "x_deep", data: { d: 1 } });
}
`,
  };
  let inv4: Inventory;
  type Fab = { file: string; stream?: string; keys?: string[]; reason?: string; open?: string[] };
  const tf4 = () => inv4.transformations as unknown as { fabricated: Fab[]; unresolved: Fab[] };
  const busKeys = (stream: string) => inv4.emissions.filter((e) => e.stream === stream).map(keyList);
  // Where the evaluation budget ran out in a file: an opaque row, or an opaque part of a row.
  const budgetCutsIn = (file: string) => [
    ...inv4.opaque.filter((o) => o.file === file && /budget/.test(o.reason)).map((o) => o.reason),
    ...inv4.emissions
      .filter((e) => (e as unknown as { file: string }).file === file)
      .flatMap((e) => ((e as unknown as { dataOpaque: { reason: string }[] }).dataOpaque ?? []).map((o) => o.reason))
      .filter((r) => /budget/.test(r)),
  ];
  beforeAll(() => {
    inv4 = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("a binding written before it is read is evaluated once per set of preceding writes, not at every reference", () => {
    // 18 bindings, each read twice by the next: re-evaluated at every reference, 2^18
    // evaluations; once per signature, 36.
    expect(busKeys("x_cost")).toEqual([[...Array.from({ length: 19 }, (_, i) => [`w${i}`]).flat(), "k0"].sort()]);
    expect(budgetCutsIn("src/cases/cost-r.ts")).toEqual([]);
  });

  it("what a call does to a binding is computed once for the references it precedes", () => {
    // `enrich` replaces the data with its costly argument: read once, not at each of the
    // eight references.
    expect(busKeys("x_repeat")).toEqual([["k"]]);
    expect(budgetCutsIn("src/cases/repeat-r.ts")).toEqual([]);
  });

  it("past the effect bound, a chain that only reads has no effect; one that writes or reaches unmodeled code refuses", () => {
    const keysOf = (stream: string) => tf4().fabricated.filter((g) => g.stream === stream).map((g) => g.keys);
    expect(keysOf("x_chain_read")).toEqual([["a"]]);
    expect(keysOf("x_chain_cycle")).toEqual([["d"]]);
    const reasons = tf4().unresolved.filter((u) => u.file === "src/gateway/chain-r.ts").map((u) => u.reason ?? "");
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/more than 3 calls before the send, then w5 writes into it/),
        expect.stringMatching(/more than 3 calls before the send, then passed to opaqueCheck\(/),
      ]),
    );
    expect(reasons).toHaveLength(2);
  });

  it("an argument a callee never reads is not evaluated to know what the callee writes", () => {
    // Evaluated, it would spend the site's budget, and `after`, read next, would be cut short.
    expect(busKeys("x_marked")).toEqual([["base", "marked", "tail"]]);
    expect(budgetCutsIn("src/cases/marked-r.ts")).toEqual([]);
  });

  it("a binding read by the bus and by a sender has a value per mode: the sender still refuses", () => {
    // The bus keeps what it sees, with no opaque part; the sender refuses, naming the call.
    expect(busKeys("x_mixed")).toEqual([["m"]]);
    expect(inv4.emissions.filter((e) => e.stream === "x_mixed").map((e) => (e as unknown as { dataOpaque: unknown[] }).dataOpaque)).toEqual([[]]);
    const reasons = tf4().unresolved.filter((u) => u.file === "src/gateway/mixed-r.ts").map((u) => u.reason ?? "");
    expect(reasons).toEqual([expect.stringContaining("externalTouch(")]);
    expect(tf4().fabricated.filter((g) => g.stream === "x_mixed")).toEqual([]);
  });

  it("a value the budget cut short at one site is not reused at another", () => {
    // `blow` exhausts the budget at the first site, after which `shared` is read there; the
    // second site reads `shared` with a budget of its own.
    const rowsOf = (stream: string) => inv4.emissions.filter((e) => e.stream === stream) as unknown as { dataOpaque: { reason: string; origin: string }[] }[];
    // The first site's budget runs out inside `shared`'s own evaluation (the mirror is
    // calibrated so)…
    expect(rowsOf("x_blow").flatMap((r) => r.dataOpaque).some((o) => /budget/.test(o.reason))).toBe(true);
    // …and the second site's `shared` is whole: its key, and no part cut short.
    expect(busKeys("x_shared")).toEqual([["sharedKey"]]);
    expect(rowsOf("x_shared").flatMap((r) => r.dataOpaque)).toEqual([]);
  });

  it("an alias read at the send sees what was done to its object after the alias", () => {
    expect(busKeys("x_alias_bus")).toEqual([["k", "lateBus"]]);
    const keysOf = (stream: string) => tf4().fabricated.filter((g) => g.stream === stream).map((g) => g.keys);
    expect(keysOf("x_alias_late")).toEqual([["a", "late"]]);
    expect(keysOf("x_alias_destr")).toEqual([["c", "late2"]]);
    expect(keysOf("x_alias_cond")).toEqual([["e", "late3"]]);
  });

  it("an object handed through more layers than the old bound is followed to its read", () => {
    expect(tf4().fabricated.filter((g) => g.stream === "x_deep").map((g) => g.keys)).toEqual([["d"]]);
    expect(tf4().unresolved.flatMap((u) => u.open ?? []).filter((o) => /past the analysis bound/.test(o))).toEqual([]);
  });

  it("every reference is accounted for", () => {
    expect(inv4.completeness.unaccounted).toBe(0);
  });
});

describe("deriveAgentEmissions — the fallback cycle (pass 10 lost terminalReceipt)", () => {
  // Upstream 9.36, reduced to its shape. The candidate run writes the lifecycle backstop into
  // a SUB-OBJECT of the cycle's parameters (state.pendingLifecycleTerminal, from a callback);
  // the settlement then emits through that backstop with the run's terminal facts — facts
  // that come from the caller's parameters. Pass 10 stopped treating executeAgentFallbackCycle
  // as a member that forwards, so its callers' data, and terminalReceipt, were lost.
  const FILES: Record<string, string> = {
    // upstream src/auto-reply/reply/agent-lifecycle-terminal.ts:59-190
    "src/auto-reply/reply/agent-lifecycle-terminal.ts": `
import { emitAgentEvent } from "../../infra/agent-events.js";
export type AgentLifecycleTerminalBackstop = {
  emit: (phase: "end" | "error", resultOrError: unknown, extraData?: Record<string, unknown>) => void;
};
export function createAgentLifecycleTerminalBackstop(params: { runId: string }): AgentLifecycleTerminalBackstop {
  const startedAt = Date.now();
  const prepareTerminal = (phase: "end" | "error", extraData?: Record<string, unknown>) => {
    const data: Record<string, unknown> = { phase, endedAt: Date.now(), startedAt };
    if (extraData) {
      Object.assign(data, extraData);
    }
    return { runId: params.runId, stream: "lifecycle", data };
  };
  const emit: AgentLifecycleTerminalBackstop["emit"] = (phase, _resultOrError, extraData) => {
    const event = prepareTerminal(phase, extraData);
    const settled = { ...event, data: { ...event.data, executionSettled: true } };
    emitAgentEvent(settled);
  };
  return { emit };
}
`,
    // upstream src/auto-reply/reply/agent-runner-fallback-cycle.types.ts:64-81
    "src/auto-reply/reply/agent-runner-fallback-cycle.types.ts": `
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
export type AgentFallbackCycleState = {
  lifecycleGeneration: string;
  pendingLifecycleTerminal?: { provider: string; model: string; backstop: AgentLifecycleTerminalBackstop };
};
export type AgentTurnTiming = {
  logIfSlow: (entry: { runId: string }) => void;
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};
export type AgentFallbackCycleParams = {
  runId: string;
  turn: { sessionKey?: string };
  state: AgentFallbackCycleState;
  timing: AgentTurnTiming;
};
`,
    // upstream src/auto-reply/reply/agent-runner-turn-timing.ts:74-76: \`measure: timing.measure\`
    "src/auto-reply/reply/agent-runner-turn-timing.ts": `
import type { AgentTurnTiming } from "./agent-runner-fallback-cycle.types.js";
export function createAgentTurnTimingTracker(): AgentTurnTiming {
  const timing = {
    measure: async <T>(_name: string, run: () => T | Promise<T>): Promise<T> => await run(),
  };
  return {
    logIfSlow: () => undefined,
    measure: timing.measure,
  };
}
`,
    // upstream src/auto-reply/reply/agent-runner-fallback-candidate.ts:280-345 (the callbacks
    // at :322-324 and :343-345 write into params.state), the run entry's receipt from
    // src/agents/embedded-agent-runner/run-entry-terminal.ts:115-125
    "src/auto-reply/reply/agent-runner-fallback-candidate.ts": `
import { createAgentLifecycleTerminalBackstop, type AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import type { AgentFallbackCycleParams } from "./agent-runner-fallback-cycle.types.js";
type Common = {
  runId: string;
  onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => void;
  onLifecycleGeneration: (generation: string) => void;
};
function runEmbeddedFallbackCandidate(common: Common) {
  common.onLifecycleGeneration("g2");
  common.onLifecycleBackstop(createAgentLifecycleTerminalBackstop({ runId: common.runId }));
  return { terminal: { metadata: { terminalReceipt: { rerouted: false } } } };
}
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const provider = "p";
  const model = "m";
  const common: Common = {
    runId: params.runId,
    onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => {
      params.state.pendingLifecycleTerminal = { provider, model, backstop };
    },
    onLifecycleGeneration: (generation: string) => {
      params.state.lifecycleGeneration = generation;
    },
  };
  // upstream :125-130: the run goes through the caller's timing
  return params.timing.measure("model_fallback", () => runEmbeddedFallbackCandidate(common));
}
`,
    // upstream src/auto-reply/reply/agent-runner-fallback-settlement.ts:24-60, :79-95, :179-188
    "src/auto-reply/reply/agent-runner-fallback-settlement.ts": `
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { AgentFallbackCycleParams } from "./agent-runner-fallback-cycle.types.js";
export async function settleAgentFallbackCycle({ cycle, fallbackResult }: { cycle: AgentFallbackCycleParams; fallbackResult: { terminal: { metadata: Record<string, unknown> } } }) {
  const turn = cycle.turn;
  const terminalMetadata = fallbackResult.terminal.metadata;
  const settledLifecycleTerminal =
    cycle.state.pendingLifecycleTerminal?.provider === "p" ? cycle.state.pendingLifecycleTerminal.backstop : undefined;
  cycle.state.pendingLifecycleTerminal = undefined;
  const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
    if (settledLifecycleTerminal) {
      settledLifecycleTerminal.emit("error", error, extraData);
      return;
    }
    emitAgentEvent({
      runId: cycle.runId,
      lifecycleGeneration: cycle.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: { phase: "error", error: error.message, endedAt: Date.now(), ...extraData, executionSettled: true },
    });
  };
  const privateFinalTerminalReply = turn.sessionKey ? { disposition: "visible" } : undefined;
  if (terminalMetadata.failed) {
    emitSettledLifecycleError(new Error("failed"), terminalMetadata);
  } else {
    settledLifecycleTerminal?.emit(
      "end",
      undefined,
      privateFinalTerminalReply ? { ...terminalMetadata, terminalReply: privateFinalTerminalReply } : terminalMetadata,
    );
  }
}
`,
    // upstream src/auto-reply/reply/agent-runner-fallback-cycle.ts:11-21
    "src/auto-reply/reply/agent-runner-fallback-cycle.ts": `
import { runAgentFallbackCandidates } from "./agent-runner-fallback-candidate.js";
import type { AgentFallbackCycleParams } from "./agent-runner-fallback-cycle.types.js";
import { settleAgentFallbackCycle } from "./agent-runner-fallback-settlement.js";
export async function executeAgentFallbackCycle(params: AgentFallbackCycleParams) {
  const fallbackResult = await runAgentFallbackCandidates(params);
  params.timing.logIfSlow({ runId: params.runId });
  return settleAgentFallbackCycle({ cycle: params, fallbackResult });
}
`,
    // upstream src/auto-reply/reply/agent-runner-execution.ts:307-330: the caller, with facts of
    // its own
    "src/auto-reply/reply/agent-runner-execution.ts": `
import { executeAgentFallbackCycle } from "./agent-runner-fallback-cycle.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
export async function executeAgentTurnInternalLoop(runId: string) {
  // upstream :137-139
  const agentTurnTiming = createAgentTurnTimingTracker();
  const fallbackCycleState = { lifecycleGeneration: "g1" };
  await executeAgentFallbackCycle({
    runId,
    turn: { sessionKey: "s" },
    state: fallbackCycleState,
    timing: agentTurnTiming,
  });
}
`,
  };
  let inv5: Inventory;
  beforeAll(() => {
    inv5 = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("a write into a sub-object of the parameters does not cut the caller's data off: executeAgentFallbackCycle forwards", () => {
    expect(inv5.family.map((f) => f.label)).toEqual(expect.arrayContaining(["executeAgentFallbackCycle"]));
  });

  it("the run's terminalReceipt, reached through the caller's timing, is on the lifecycle frames at the caller", () => {
    const rows = inv5.emissions.filter((e) => e.stream === "lifecycle" && (e as unknown as { file: string }).file === "src/auto-reply/reply/agent-runner-execution.ts");
    expect(rows.length).toBeGreaterThan(0);
    const keys = rows.map((r) => keyList(r).map((k) => k.replace(/\?$/, "")));
    for (const k of keys) expect(k).toContain("terminalReceipt");
    // settle's own reply rides on the end frame (upstream agent-runner-fallback-settlement.ts:183-189)
    expect(keys.some((k) => k.includes("terminalReply"))).toBe(true);
  });
});

describe("deriveAgentEmissions — a member declared read-only for a version (READ_ONLY_MEMBERS)", () => {
  // upstream 9.36: handleEvent hands its payload to chatRunState.recordProgressEvent, typed
  // by ChatRunState; the checker sees the type's signature, no body. The declaration names
  // the member and locks the bodies it was reviewed on.
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const RECORD = `(runId: string, event: Ev, extra?: Ev) => {
    void extra;
    store.set(runId, copyEvent(event));
  }`;
  const COPY = `export function copyEvent(event: Ev): Ev {
  return JSON.parse(JSON.stringify(event)) as Ev;
}`;
  const runState = (record: string) => `
export type Ev = { runId: string; stream: string; data: Record<string, unknown> };
export type RunState = {
  record: (runId: string, event: Ev, extra?: Ev) => void;
};
${COPY}
export function createRunState(): RunState {
  const store = new Map<string, Ev>();
  const record = ${record};
  return { record };
}
`;
  const USE = `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createRunState, type RunState } from "./run-state.js";
export function relayRecorded(state: RunState) {
  const { broadcast } = createGatewayBroadcaster();
  const payload = { runId: "r", stream: "x_recorded", data: { a: 1 } };
  state.record("r", payload);
  broadcast("agent", payload);
}
export function relayAsExtra(state: RunState) {
  const { broadcast } = createGatewayBroadcaster();
  const other = { runId: "r", stream: "x_extra_arg", data: { b: 1 } };
  state.record("r", { runId: "r", stream: "s", data: {} }, other);
  broadcast("agent", other);
}
export function wire() {
  relayRecorded(createRunState());
  relayAsExtra(createRunState());
}
`;
  const ENTRY: ReadOnlyMember = {
    type: "RunState",
    member: "record",
    argument: 1,
    declaredIn: "src/gateway/run-state.ts",
    implementation: { file: "src/gateway/run-state.ts", factory: "createRunState", fn: "createRunState > record" },
    reviewedAt: "test",
    evidence: "createRunState's record copies the event through JSON (copyEvent) and stores the copy.",
    bodies: [
      { file: "src/gateway/run-state.ts", fn: "createRunState > record", sha256: sha(RECORD) },
      { file: "src/gateway/run-state.ts", fn: "copyEvent", sha256: sha(COPY) },
    ],
  };
  const run = (files: Record<string, string>, readOnlyMembers: ReadOnlyMember[]) =>
    deriveWith({ root: "/virtual-upstream", files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...files }, tsconfig: TSCONFIG, compilerOptions: OPTIONS, readOnlyMembers });
  type Fab = { function: string; stream?: string; keys?: string[]; reason?: string };
  const tfOf = (inv: Inventory) => inv.transformations as unknown as { fabricated: Fab[]; unresolved: Fab[] };
  const FILES = { "src/gateway/run-state.ts": runState(RECORD), "src/gateway/use-q.ts": USE };

  it("declared, the member is a call that writes nothing into the object: the send is a fabricated frame", () => {
    const tf = tfOf(run(FILES, [ENTRY]));
    expect(tf.fabricated.filter((g) => g.stream === "x_recorded").map((g) => g.keys)).toEqual([["a"]]);
    expect(tf.unresolved.filter((u) => u.function === "relayRecorded")).toEqual([]);
  });

  it("undeclared, the same call is code whose effects are not modeled: the send is UNRESOLVED", () => {
    const tf = tfOf(run(FILES, []));
    expect(tf.unresolved.filter((u) => u.function === "relayRecorded").map((u) => u.reason)).toEqual([expect.stringContaining("passed to state.record(")]);
  });

  it("an object handed at another argument than the declared one stays UNRESOLVED", () => {
    const tf = tfOf(run(FILES, [ENTRY]));
    expect(tf.unresolved.filter((u) => u.function === "relayAsExtra").map((u) => u.reason)).toEqual([expect.stringContaining("passed to state.record(")]);
  });

  it("a body that changed since the review refuses the derivation", () => {
    const changed = { ...FILES, "src/gateway/run-state.ts": runState(RECORD.replace("store.set(runId, copyEvent(event));", "event.data.touched = 1;\n    store.set(runId, copyEvent(event));")) };
    expect(() => run(changed, [ENTRY])).toThrow(/RunState\.record: createRunState > record \(src\/gateway\/run-state\.ts\) is not the body the declaration was reviewed on/);
  });

  it("another object providing the member refuses the derivation", () => {
    const other = { ...FILES, "src/gateway/other-state.ts": `import type { RunState } from "./run-state.js";\nexport const fake: RunState = { record: (runId, event) => void [runId, event] };\n` };
    expect(() => run(other, [ENTRY])).toThrow(/RunState\.record: another object provides it \(src\/gateway\/other-state\.ts:2\)/);
  });

  it("a type DERIVED from the factory declares no signature to trust: the entry is not applied and the body is read (v2026.10.33)", () => {
    // `type ChatRunState = ReturnType<typeof createChatRunState>`: the checker reaches the
    // member's body, so the send resolves from the body itself — with the stale entry
    // present (not a refusal) exactly as with none.
    const derived = runState(RECORD)
      .replace("export type RunState = {\n  record: (runId: string, event: Ev, extra?: Ev) => void;\n};", "export type RunState = ReturnType<typeof createRunState>;")
      .replace("export function createRunState(): RunState {", "export function createRunState() {");
    expect(derived).toContain("ReturnType<typeof createRunState>");
    const files = { ...FILES, "src/gateway/run-state.ts": derived };
    const withEntry = tfOf(run(files, [ENTRY]));
    const without = tfOf(run(files, []));
    expect(withEntry).toEqual(without);
    expect(withEntry.fabricated.filter((g) => g.stream === "x_recorded").map((g) => g.keys)).toEqual([["a"]]);
    // A body that WRITES into the event is then seen, entry or not: nothing was trusted.
    const writing = { ...files, "src/gateway/run-state.ts": derived.replace("store.set(runId, copyEvent(event));", "event.data.touched = 1;\n    store.set(runId, copyEvent(event));") };
    expect(tfOf(run(writing, [ENTRY]))).toEqual(tfOf(run(writing, [])));
  });

  it("a declared member that is gone refuses the derivation", () => {
    const gone = { ...FILES, "src/gateway/run-state.ts": runState(RECORD).replace("  record: (runId: string, event: Ev, extra?: Ev) => void;\n", "") };
    expect(() => run(gone, [ENTRY])).toThrow(/RunState\.record: the declared member is absent/);
  });

  // Codex pass 4 (lot E): the reviewed body must BE the member the factory hands out.
  const MUTATOR = `const mutator = (runId: string, event: Ev, extra?: Ev) => {
    void [runId, extra];
    event.stream = "changed";
    event.data.lost = 1;
  };`;
  it("a factory that returns another function than the reviewed body refuses the derivation", () => {
    const swapped = { ...FILES, "src/gateway/run-state.ts": runState(RECORD).replace("  return { record };", `  ${MUTATOR}\n  return { record: mutator };`) };
    expect(() => run(swapped, [ENTRY])).toThrow(/RunState\.record: createRunState hands out .*mutator.*, not the reviewed createRunState > record/);
  });

  it("a member written after the factory returns it, by name or by literal key, refuses the derivation", () => {
    for (const write of ["state.record = mutator;", 'state["record"] = mutator;']) {
      const later = { ...FILES, "src/gateway/use-q.ts": `${USE}\nexport function swap(state: RunState) {\n  ${MUTATOR.replace(/: Ev/g, ": { stream: string; data: Record<string, unknown> }")}\n  ${write}\n}\n` };
      expect(() => run(later, [ENTRY]), write).toThrow(/RunState\.record: (another object provides it|the member is assigned) \(src\/gateway\/use-q\.ts:\d+\)/);
    }
  });

  it("a reviewed body whose binding is reassigned refuses the derivation", () => {
    const reassigned = { ...FILES, "src/gateway/run-state.ts": runState(RECORD).replace("  const record = ", "  let record = ").replace("  return { record };", `  ${MUTATOR}\n  record = mutator;\n  return { record };`) };
    expect(() => run(reassigned, [ENTRY])).toThrow(/RunState\.record: the binding of the reviewed body is reassigned/);
  });

  it("upstream's declaration names the member, its argument and three locked bodies", () => {
    const entries = deriver.READ_ONLY_MEMBERS as ReadOnlyMember[];
    expect(entries.map((e) => `${e.type}.${e.member}#${e.argument}`)).toEqual(["ChatRunState.recordProgressEvent#1"]);
    expect(entries[0]!.bodies.map((b) => b.fn)).toEqual(["createChatRunState > recordProgressEvent", "updateChatRunProgressSnapshot", "captureProgressEvent"]);
    expect(entries[0]!.implementation.fn).toBe("createChatRunState > recordProgressEvent");
    for (const b of entries[0]!.bodies) expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveAgentEmissions — the fourth review's counterexamples (lot E)", () => {
  const chain = (prefix: string, type: string, last: string) =>
    Array.from({ length: 5 }, (_, i) => `function ${prefix}${i}(x: ${type}): unknown {\n  return ${i < 4 ? `${prefix}${i + 1}(x)` : last};\n}`).join("\n");
  const FILES: Record<string, string> = {
    // 1. What is done to an object applies in the order it runs: a key reassigned after a
    //    write one key down holds the new object only; a helper's writes take their place in
    //    that order; an alias of the old object writes the old object; a reassignment of the
    //    binding (or of a parameter) replaces what came before it.
    "src/gateway/order-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
declare function defer(cb: () => void): void;
function replaceData(p: Frame) {
  p.data = { helperKey: 1 };
}
function innerReplace(x: Frame) {
  x.data = { innerKey: 1 };
}
function maybeReplace(x: Frame, c: boolean) {
  if (c) innerReplace(x);
}
function replaceLater(x: Frame) {
  defer(() => {
    x.data = { lateKey: 1 };
  });
}
function nestThenReplace(x: Frame) {
  x.data.inner = 1;
  x.data = { replacedInHelper: 1 };
}
export function ordered(c: boolean) {
  const { broadcast } = createGatewayBroadcaster();
  const p: Frame = { runId: "r", stream: "x_order", data: {} };
  p.data = { initial: 1 };
  p.data.oldKey = 1;
  p.data = { actualKey: 1 };
  broadcast("agent", p);
  const q: Frame = { runId: "r", stream: "x_order_helper", data: { a: 1 } };
  q.data.before = 1;
  replaceData(q);
  q.data.after = 1;
  broadcast("agent", q);
  const r: Frame = { runId: "r", stream: "x_order_alias", data: { b: 1 } };
  const d = r.data;
  r.data = { fresh: 1 };
  d.old = 1;
  broadcast("agent", r);
  const s: Frame = { runId: "r", stream: "x_cond_helper", data: { kept: 1 } };
  maybeReplace(s, c);
  broadcast("agent", s);
  const t: Frame = { runId: "r", stream: "x_late_helper", data: { now: 1 } };
  replaceLater(t);
  broadcast("agent", t);
  const u: Frame = { runId: "r", stream: "x_logical", data: { kept: 1 } };
  u.data ??= { replaced: 1 };
  broadcast("agent", u);
  let v: Frame = { runId: "r", stream: "x_rebind", data: { first: 1 } };
  v.data = { stale: 1 };
  v = { runId: "r", stream: "x_rebind", data: { second: 1 } };
  broadcast("agent", v);
  let w: Frame = { runId: "r", stream: "x_alias_rebind", data: { w1: 1 } };
  const kept = w;
  w = { runId: "r", stream: "x_alias_rebind", data: { w2: 1 } };
  kept.data = { detached: 1 };
  broadcast("agent", w);
  const f: Frame = { runId: "r", stream: "x_floating", data: { f0: 1 } };
  defer(() => {
    f.data = { fx: 1 };
  });
  f.data.fk = 1;
  broadcast("agent", f);
  const g: Frame = { runId: "r", stream: "x_floating_pair", data: { g0: 1 } };
  defer(() => {
    g.data.gk = 1;
  });
  defer(() => {
    g.data = { gn: 1 };
  });
  broadcast("agent", g);
  const l: Frame = { runId: "r", stream: "x_loop", data: { l0: 1 } };
  for (const n of [1, 2]) {
    void n;
    l.data.lk = 1;
    l.data = { lnew: 1 };
  }
  broadcast("agent", l);
  const h: Frame = { runId: "r", stream: "x_helper_order", data: { h0: 1 } };
  nestThenReplace(h);
  broadcast("agent", h);
  const y: Frame = { runId: "r", stream: "x_alias_reassigned", data: { y0: 1 } };
  let yy: Frame = y;
  yy = { runId: "r", stream: "other", data: {} };
  yy.data = { elsewhere: 1 };
  broadcast("agent", y);
  const z: Frame = { runId: "r", stream: "x_pattern", data: { z0: 1 } };
  [z.data] = [{ zp: 1 }];
  broadcast("agent", z);
}
function relayCopy(evt: Frame) {
  const { broadcast } = createGatewayBroadcaster();
  evt = { ...evt, data: { ...evt.data, added: 1 } };
  broadcast("agent", evt);
}
function relayStream(stream?: string) {
  const { broadcast } = createGatewayBroadcaster();
  stream = stream ?? "x_param_default";
  broadcast("agent", { runId: "r", stream, data: { d: 1 } });
}
export function wireParams() {
  relayCopy({ runId: "r", stream: "x_param_reassign", data: { orig: 1 } });
  relayStream();
  relayStream("x_param_given");
}
`,
    // 1. (pass 12) A binding reassigned with a copy of itself, on branches: upstream's
    //    \`params = { ...params, … }\` (src/agents/cli-runner/prepare.ts, ten times) — each
    //    such reassignment is the binding plus what it adds, never a copy nested in the next.
    "src/gateway/accumulate-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
declare function defer(cb: () => void): void;
export function accumulate(params: Frame, flags: boolean[]) {
  const { broadcast } = createGatewayBroadcaster();
${Array.from({ length: 24 }, (_, i) => `  if (flags[${i}]) params = { ...params, data: { ...params.data, a${i}: 1 } };`).join("\n")}
  params.data.last = 1;
  broadcast("agent", params);
  defer(() => broadcast("agent", { ...params, stream: "x_accumulate_later" }));
}
const withKey = (p: Frame, k: string): Frame => ({ ...p, data: { ...p.data, [k]: 1 } });
export function accumulateByHelper(params: Frame, flags: boolean[]) {
  const { broadcast } = createGatewayBroadcaster();
${Array.from({ length: 10 }, (_, i) => `  if (flags[${i}]) params = withKey(params, "h${i}");`).join("\n")}
  broadcast("agent", params);
}
export function accumulateLater(params: Frame) {
  const { broadcast } = createGatewayBroadcaster();
  defer(() => {
    params = withKey(params, "late");
  });
${Array.from({ length: 12 }, (_, i) => `  params.data.d${i} = 1;`).join("\n")}
  broadcast("agent", params);
}
export function wireAccumulate(flags: boolean[]) {
  accumulate({ runId: "r", stream: "x_accumulate", data: { base: 1 } }, flags);
  accumulateByHelper({ runId: "r", stream: "x_accumulate_helper", data: { base: 1 } }, flags);
  accumulateLater({ runId: "r", stream: "x_accumulate_floating", data: { base: 1 } });
}
export function sameObject() {
  const { broadcast } = createGatewayBroadcaster();
  const s: Frame = { runId: "r", stream: "x_same_object", data: { s0: 1 } };
  const sd = s.data;
  s.data = sd;
  sd.kept = 1;
  broadcast("agent", s);
  let c: Frame = { runId: "r", stream: "x_shallow_copy", data: { c0: 1 } };
  const cd = c.data;
  c = { ...c };
  cd.shared = 1;
  broadcast("agent", c);
}
`,
    // 1. (pass 13) A reassignment that reaches the binding through another one (upstream's
    //    lifecycle backstop, src/auto-reply/reply/agent-lifecycle-terminal.ts:166-167:
    //    \`const event = prepareTerminal(state, …); state = { kind: "captured", event }\`).
    "src/cases/backstop-bus.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
type State = { kind: string; metadata: Record<string, unknown>; event?: { stream: string; data: Record<string, unknown> } };
export function backstop(runId: string) {
  let state: State = { kind: "pending", metadata: { m0: 1 } };
  const prepare = (s: State) => ({ stream: "x_indirect", data: { ...s.metadata, phase: "end" } });
  const note = () => {
    state.metadata.noted = 1;
  };
  const capture = () => {
    const event = prepare(state);
    state = { kind: "captured", metadata: {}, event };
  };
  const emit = () => {
    const current = state;
    const event = current.event ?? prepare(current);
    emitAgentEvent({ runId, stream: event.stream, data: event.data });
  };
  note();
  capture();
  emit();
}
`,
    "src/cases/order-bus.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
export function orderedBus(runId: string) {
  const e: { data: Record<string, unknown> } = { data: {} };
  e.data = { a: 1 };
  e.data.b = 1;
  emitAgentEvent({ runId, stream: "x_order_bus", data: e.data });
}
`,
    // 3. Code that runs with the object as \`this\` — a method called on it, an accessor read
    //    or written on it, an accessor its type declares (run by a copy or the transport's
    //    serialization) — is an effect: proven absent, or the send refuses (past the bound too).
    "src/gateway/accessors-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
const makeGetter = (stream: string) => ({ runId: "r", stream, data: { g: 1 } as Record<string, unknown>, get effect() { this.data.lost = 1; return 1; } });
const makeStamper = (stream: string) => ({ runId: "r", stream, data: { m: 1 } as Record<string, unknown>, stamp() { this.data.stamped = 1; } });
const makeReader = (stream: string) => ({ runId: "r", stream, data: { k: 1 } as Record<string, unknown>, describe() { return this.stream; }, get label() { return this.stream; } });
const makeSetter = (stream: string) => ({ runId: "r", stream, data: { s: 1 } as Record<string, unknown>, set tag(v: string) { this.data.tagged = v; } });
type Getterful = ReturnType<typeof makeGetter>;
type Stampful = ReturnType<typeof makeStamper>;
type Hooked = { runId: string; stream: string; data: Record<string, unknown>; touch(): void };
type Plain = { runId: string; stream: string; data: Record<string, unknown> };
type Boxed = { payload: Plain; poke(): void };
${chain("g", "Getterful", "x.effect")}
${chain("m", "Stampful", "x.stamp()")}
export function accessors(hooked: Hooked, plain: Plain) {
  const { broadcast } = createGatewayBroadcaster();
  const p = makeGetter("x_getter");
  void p.effect;
  broadcast("agent", p);
  const q = makeStamper("x_method");
  q.stamp();
  broadcast("agent", q);
  const ok = makeReader("x_reader");
  ok.describe();
  void ok.label;
  broadcast("agent", ok);
  const st = makeSetter("x_setter");
  st.tag = "t";
  broadcast("agent", { runId: "r", stream: "x_setter", data: st.data });
  const deepGetter = makeGetter("x_deep_getter");
  g0(deepGetter);
  broadcast("agent", { runId: "r", stream: "x_deep_getter", data: deepGetter.data });
  const deepMethod = makeStamper("x_deep_method");
  m0(deepMethod);
  broadcast("agent", { runId: "r", stream: "x_deep_method", data: deepMethod.data });
  hooked.touch();
  broadcast("agent", { runId: "r", stream: "x_hooked", data: hooked.data });
  plain.data.toString();
  broadcast("agent", { runId: "r", stream: "x_plain", data: plain.data });
  const box: Boxed = { payload: { runId: "r", stream: "x_box", data: { k: 1 } }, poke() { this.payload.data.poked = 1; } };
  box.poke();
  broadcast("agent", box.payload);
  broadcast("agent", { runId: "r", stream: "x_serialized", data: { get late(): number { (this as Record<string, unknown>).seen = 1; return 1; } } });
  broadcast("agent", { runId: "r", stream: "x_serialized_plain", data: { get calm(): number { return 1; } } });
}
`,
    // 3. (pass 13, decided) A PROPERTY holding a function is called as the function it holds:
    //    upstream's six forms are classified; a method copied unbound into one, or a class
    //    field's arrow, that uses \`this\` refuses by name; a function type with \`this:\` is strict.
    "src/gateway/property-calls-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
type RespondFn = (ok: boolean, payload?: unknown, error?: unknown) => void;
type Pending = {
  respond: RespondFn;
  requestEventName: string;
  requestEvent: { id: string };
  afterDecision?: (decision: string | null) => Promise<void> | void;
  register: (cb: (decision: string) => Promise<void>) => void;
};
// upstream's handlePendingApprovalRequest (src/gateway/server-methods/approval-shared.ts:284)
async function handlePending(params: Pending) {
  const { broadcast } = createGatewayBroadcaster();
  params.register(async (decision) => {
    if (params.afterDecision) await params.afterDecision(decision);
    params.respond(true, { decision });
  });
  broadcast(params.requestEventName, params.requestEvent);
}
// upstream's handlePendingApprovalRequestWithDelivery (approval-request-delivery.ts:76-101)
function viaDelivery(pending: Omit<Pending, "requestEventName" | "afterDecision">, kind: "exec" | "plugin", afterDecision?: (d: string | null) => void) {
  return handlePending({ ...pending, requestEventName: \`\${kind}.approval.requested\`, afterDecision: async (decision) => { await afterDecision?.(decision); } });
}
// system-agent-approval.ts:333 (respond: () => undefined)
export function direct(register: Pending["register"]) {
  return handlePending({ respond: () => undefined, requestEventName: "openclaw.approval.requested", requestEvent: { id: "1" }, register });
}
// exec-approval.ts:449, plugin-approval.ts:259, environments.session-exec-approval.ts:80: the dispatcher's respond, handed on
export function rpcExec({ respond, register }: { respond: RespondFn; register: Pending["register"] }) {
  return viaDelivery({ respond, requestEvent: { id: "2" }, register }, "exec");
}
export function rpcPlugin({ respond, register }: { respond: RespondFn; register: Pending["register"] }) {
  return viaDelivery({ respond, requestEvent: { id: "3" }, register }, "plugin");
}
export function sessionExec({ respond, register }: { respond: RespondFn; register: Pending["register"] }) {
  return viaDelivery({ respond, requestEvent: { id: "4" }, register }, "exec");
}
// node-invoke-plugin-approval.ts:198 (const respond: RespondFn = () => {})
export function nodeInvoke(register: Pending["register"]) {
  const respond: RespondFn = () => {};
  return viaDelivery({ respond, requestEvent: { id: "5" }, register }, "plugin");
}
// server-chat.ts:1181-1185 (buffered.isCurrent?.(), isCurrent a bound arrow, server-chat.ts:1335)
type Buffered = { isCurrent?: () => boolean; payload: Frame };
const shouldProcess = (runId: string) => runId.length > 0;
export function flushBuffered() {
  const { broadcast } = createGatewayBroadcaster();
  const buffered: Buffered = { isCurrent: shouldProcess.bind(null, "r"), payload: { runId: "r", stream: "x_buffered", data: { b: 1 } } };
  if (buffered.isCurrent?.() === false) return;
  broadcast("agent", buffered.payload);
}
type Holder = { runId: string; stream: string; data: Record<string, unknown>; mark: () => void };
export function plainFunction() {
  const { broadcast } = createGatewayBroadcaster();
  const h: Holder = { runId: "r", stream: "x_plain_fn", data: { p: 1 }, mark: function () { void 0; } };
  h.mark();
  broadcast("agent", h);
}
class Recorder {
  data: Record<string, unknown> = {};
  stamp() {
    this.data.stamped = 1;
  }
}
export function copiedUnbound() {
  const { broadcast } = createGatewayBroadcaster();
  const rec = new Recorder();
  const h: Holder = { runId: "r", stream: "x_unbound", data: { u: 1 }, mark: rec.stamp };
  h.mark();
  broadcast("agent", h);
}
class Panel {
  data: Record<string, unknown> = { f0: 1 };
  touchField = () => {
    this.data.f = 1;
  };
}
export function fieldArrow() {
  const { broadcast } = createGatewayBroadcaster();
  const panel = new Panel();
  panel.touchField();
  broadcast("agent", { runId: "r", stream: "x_field_arrow", data: panel.data });
}
type Bound = { runId: string; stream: string; data: Record<string, unknown>; touch: (this: Bound) => void };
export function thisTyped(b: Bound) {
  const { broadcast } = createGatewayBroadcaster();
  b.touch();
  broadcast("agent", { runId: "r", stream: "x_this_typed", data: b.data });
}
`,
  };
  let inv6: Inventory;
  type Fab = { file: string; function: string; stream?: string; keys?: string[]; reason?: string };
  const tf6 = () => inv6.transformations as unknown as { fabricated: Fab[]; unresolved: Fab[] };
  const keysOf = (stream: string) => tf6().fabricated.filter((g) => g.stream === stream).map((g) => g.keys);
  const hasRow = (stream: string, keys: string[]) => keysOf(stream).some((k) => JSON.stringify(k) === JSON.stringify(keys));
  const reasonsIn = (file: string) => tf6().unresolved.filter((u) => u.file === file).map((u) => u.reason ?? "");
  beforeAll(() => {
    inv6 = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
  });

  it("1. a key reassigned after a write one key down holds the new object only", () => {
    expect(keysOf("x_order")).toEqual([["actualKey"]]);
    expect(inv6.emissions.filter((e) => e.stream === "x_order_bus").map(keyList)).toEqual([["a", "b"]]);
  });

  it("1. a helper's write takes its place in the order: what came before it on the old object is gone", () => {
    expect(keysOf("x_order_helper")).toEqual([["after", "helperKey"]]);
    // …and the helper's own writes run in their order too.
    expect(keysOf("x_helper_order")).toEqual([["replacedInHelper"]]);
  });

  it("1. an alias of the old object writes the old object, not the new one", () => {
    expect(keysOf("x_order_alias")).toEqual([["fresh"]]);
    expect(keysOf("x_alias_rebind")).toEqual([["w2"]]);
    // An alias reassigned may hold another object: what it writes may not reach this one.
    expect(hasRow("x_alias_reassigned", ["y0"])).toBe(true);
  });

  it("1. a write by a destructuring assignment is a write, its value not read", () => {
    const rows = tf6().fabricated.filter((g) => g.stream === "x_pattern") as unknown as { keys: string[]; dataOpaque: unknown[] }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.keys).not.toContain("z0");
      expect(r.dataOpaque.length).toBeGreaterThan(0);
    }
  });

  it("1. a reassignment of the binding replaces what was written before it", () => {
    expect(keysOf("x_rebind")).toEqual([["second"]]);
  });

  it("1. a write a helper makes only on one branch, or in a callback, or by `??=`, may not happen: what it would replace stays possible", () => {
    expect(hasRow("x_cond_helper", ["kept"]) && hasRow("x_cond_helper", ["innerKey"])).toBe(true);
    expect(hasRow("x_late_helper", ["now"]) && hasRow("x_late_helper", ["lateKey"])).toBe(true);
    expect(hasRow("x_logical", ["kept"])).toBe(true);
  });

  it("1. a write that may run at any time (a callback, a loop) is applied wherever it may run, as often as it may", () => {
    // f.data replaced by the callback before or after f.data.fk, or never.
    for (const keys of [["f0", "fk"], ["fk", "fx"], ["fx"]]) expect(hasRow("x_floating", keys), keys.join()).toBe(true);
    // Two callbacks in either order: gn then gk gives both keys.
    expect(keysOf("x_floating_pair").some((k) => k!.includes("gn") && k!.includes("gk"))).toBe(true);
    expect(keysOf("x_loop").some((k) => k!.includes("lnew"))).toBe(true);
    expect(keysOf("x_loop").some((k) => k!.includes("l0"))).toBe(true);
  });

  const keysAt = (stream: string) => new Set(keysOf(stream).flat());
  it("1. a binding reassigned with a copy of itself on many branches is the binding plus what each adds, in linear size", () => {
    for (const stream of ["x_accumulate", "x_accumulate_later"]) {
      const keys = keysAt(stream);
      for (const k of ["base", "last", ...Array.from({ length: 24 }, (_, i) => `a${i}`)]) expect(keys.has(k), `${stream} ${k}`).toBe(true);
    }
  });

  it("1. a reassignment that reads the binding through a helper, past the bound, refuses the frame by name", () => {
    expect(reasonsIn("src/gateway/accumulate-s.ts").some((r) => /more than 5 reassignments of params that read it and may not run \(evaluator bound\)/.test(r))).toBe(true);
    expect(reasonsIn("src/gateway/accumulate-s.ts").some((r) => /event variants/.test(r))).toBe(false);
  });

  it("1. a reassignment in a callback that reads the binding runs against the fullest state, once at the end", () => {
    const keys = keysAt("x_accumulate_floating");
    for (const k of ["base", "late", ...Array.from({ length: 12 }, (_, i) => `d${i}`)]) expect(keys.has(k), k).toBe(true);
    // Not merged before each of the twelve writes: the bound is never reached there.
    expect(tf6().unresolved.filter((u) => String((u as { payload?: string }).payload ?? "").includes("accumulateLater"))).toEqual([]);
  });

  it("1. a reassignment that reaches the binding through another binding reads its state, not a recursion", () => {
    const rows = inv6.emissions.filter((e) => e.stream === "x_indirect");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/recursive definition of state/);
    const keys = new Set(rows.flatMap((r) => r.keys.map((k) => k.key)));
    for (const k of ["m0", "noted", "phase"]) expect(keys.has(k), k).toBe(true);
  });

  it("1. an alias stays on the object when what is put back may be that same object", () => {
    expect(keysAt("x_same_object").has("kept")).toBe(true);
    expect(keysAt("x_shallow_copy").has("shared")).toBe(true);
  });

  it("1. a parameter reassigned before the send: the frame carries the new value", () => {
    expect(keysOf("x_param_reassign")).toEqual([["added", "orig"]]);
    // `stream ?? default` over a parameter: the default at every call (an over-approximation
    // where the caller passes one), the caller's value where it does.
    expect(keysOf("x_param_default").length).toBeGreaterThan(0);
    expect(keysOf("x_param_default").every((k) => JSON.stringify(k) === '["d"]')).toBe(true);
    expect(keysOf("x_param_given")).toEqual([["d"]]);
  });

  it("3. a getter, a setter or a method that may change the object makes the send UNRESOLVED; one that only reads does not", () => {
    const reasons = reasonsIn("src/gateway/accessors-s.ts");
    for (const re of [/getter effect/, /method stamp/, /setter tag/, /method touch/]) expect(reasons.some((r) => re.test(r)), String(re)).toBe(true);
    expect(keysOf("x_getter")).toEqual([]);
    expect(keysOf("x_method")).toEqual([]);
    expect(keysOf("x_setter")).toEqual([]);
    expect(keysOf("x_hooked")).toEqual([]);
    expect(keysOf("x_reader")).toEqual([["k"]]);
    expect(keysOf("x_plain")).toEqual([[]]);
  });

  it("3. a payload read from an object code not modeled ran on is unresolved as a whole, no path of it fabricated", () => {
    expect(keysOf("x_box")).toEqual([]);
    expect(reasonsIn("src/gateway/accessors-s.ts").some((r) => /method poke .*has no body/.test(r))).toBe(true);
  });

  it("3. a getter the frame's data declares runs when the transport serializes it: the send refuses, unless it only reads", () => {
    expect(keysOf("x_serialized")).toEqual([]);
    expect(reasonsIn("src/gateway/accessors-s.ts").some((r) => /getter late/.test(r) && /serializ/.test(r))).toBe(true);
    expect(keysOf("x_serialized_plain")).toEqual([["calm"]]);
  });

  it("3. a property holding a function is called as the function it holds: upstream's six forms are classified", () => {
    const unresolved = tf6().unresolved.filter((u) => u.file === "src/gateway/property-calls-s.ts");
    expect(unresolved.filter((u) => /respond|afterDecision|register|isCurrent|approval/.test(u.reason ?? ""))).toEqual([]);
    // Only the three refusals the file is written for (the copied method, the field's arrow,
    // the `this:`-typed member): every other send of it is classified.
    expect(unresolved).toHaveLength(3);
    expect(keysOf("x_buffered")).toEqual([["b"]]);
    expect(keysOf("x_plain_fn")).toEqual([["p"]]);
  });

  it("3. a method copied unbound into a function-typed property, or a class field's arrow, that uses `this` refuses by name", () => {
    const reasons = reasonsIn("src/gateway/property-calls-s.ts");
    expect(reasons.some((r) => /property mark .*holds Recorder\.stamp .*a function that is not an arrow that uses `this`/.test(r))).toBe(true);
    expect(reasons.some((r) => /property touchField .*holds Panel\.touchField .*a class field's arrow that uses `this`/.test(r))).toBe(true);
    expect(keysOf("x_unbound")).toEqual([]);
    expect(keysOf("x_field_arrow")).toEqual([]);
  });

  it("3. a function type that declares `this:` stays strict", () => {
    expect(reasonsIn("src/gateway/property-calls-s.ts").some((r) => /method touch .*has no body in the analysed sources/.test(r))).toBe(true);
    expect(keysOf("x_this_typed")).toEqual([]);
  });

  it("3. past the effect bound too: a chain that ends on a getter or a method refuses", () => {
    expect(keysOf("x_deep_getter")).toEqual([]);
    expect(keysOf("x_deep_method")).toEqual([]);
    const reasons = reasonsIn("src/gateway/accessors-s.ts");
    expect(reasons.some((r) => /more than 3 calls.*getter effect/.test(r))).toBe(true);
    expect(reasons.some((r) => /more than 3 calls.*method stamp/.test(r))).toBe(true);
  });
});

describe("deriveAgentEmissions — the fifth review's counterexamples (lot F)", () => {
  const FILES: Record<string, string> = {
    // 1. What a helper does after its first await, or in a generator, runs later than its
    //    call: not before a send that does not wait for it; certain once the call is awaited.
    "src/gateway/async-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
async function replaceLater(p: Frame) {
  await 0;
  p.stream = "x_async_after";
  p.data = { late: 1 };
}
async function replaceAwaited(p: Frame) {
  p.data.sync = 1;
  await 0;
  p.stream = "x_awaited_after";
  p.data = { done: 1 };
}
function* replaceGen(p: Frame) {
  p.stream = "x_gen_after";
  p.data = { genLate: 1 };
  yield 1;
}
export function notAwaited() {
  const { broadcast } = createGatewayBroadcaster();
  const p: Frame = { runId: "r", stream: "x_async_before", data: { early: 1 } };
  void replaceLater(p);
  broadcast("agent", p);
  const g: Frame = { runId: "r", stream: "x_gen_before", data: { genEarly: 1 } };
  replaceGen(g);
  broadcast("agent", g);
  const s: Frame = { runId: "r", stream: "x_sync_part", data: { e: 1 } };
  void replaceAwaited(s);
  broadcast("agent", s);
}
export async function awaited() {
  const { broadcast } = createGatewayBroadcaster();
  const p: Frame = { runId: "r", stream: "x_awaited_before", data: { e: 1 } };
  await replaceAwaited(p);
  broadcast("agent", p);
}
`,
    // 2. Every value a function-typed property may hold is examined: a reassignment of the
    //    binding it comes from, both branches of a conditional; a value that is not known
    //    among known ones refuses too.
    "src/gateway/values-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
type Actor = { runId: string; stream: string; data: Record<string, unknown>; act: () => void };
declare function makeAct(): () => void;
export function reassignedValue() {
  const { broadcast } = createGatewayBroadcaster();
  let act = () => {};
  act = function (this: Frame) {
    this.stream = "x_after_act";
    this.data = { late: 1 };
  };
  const p: Actor = { runId: "r", stream: "x_act", data: { e: 1 }, act };
  p.act();
  broadcast("agent", p);
}
export function ternaryValue(cond: boolean) {
  const { broadcast } = createGatewayBroadcaster();
  const mutator = function (this: Frame) {
    this.data = { late: 1 };
  };
  const q: Actor = { runId: "r", stream: "x_ternary_act", data: { e: 1 }, act: cond ? () => {} : mutator };
  q.act();
  broadcast("agent", q);
}
export function unknownValue() {
  const { broadcast } = createGatewayBroadcaster();
  const u: Actor = { runId: "r", stream: "x_unknown_act", data: { e: 1 }, act: makeAct() };
  u.act();
  broadcast("agent", u);
}
export function arrowsOnly(cond: boolean) {
  const { broadcast } = createGatewayBroadcaster();
  let act = () => {};
  if (cond) act = () => undefined;
  const a: Actor = { runId: "r", stream: "x_arrows_act", data: { a: 1 }, act: cond ? act : () => {} };
  a.act();
  broadcast("agent", a);
}
`,
    // 3. LIMIT — what may run any number of times is applied at the end in two passes at most,
    //    never until the object stops changing: the states past them are not derived. The
    //    contract states it; the bench's emission check and the drift detector are its nets.
    "src/gateway/loop-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
const next = (p: Frame): Frame => ({ ...p, stream: p.stream === "x_s0" ? "x_s1" : p.stream === "x_s1" ? "x_s2" : "x_s3", data: { k: 1 } });
export function loopNext() {
  const { broadcast } = createGatewayBroadcaster();
  let p: Frame = { runId: "r", stream: "x_s0", data: {} };
  for (let i = 0; i < 3; i++) p = next(p);
  broadcast("agent", p);
}
const step = (p: Frame): Frame => ({ ...p, stream: p.stream === "x_v0" ? "x_v1" : p.stream === "x_v1" ? "x_v2" : "x_v3", data: { v: 1 } });
export function throughBinding() {
  const { broadcast } = createGatewayBroadcaster();
  let v: Frame = { runId: "r", stream: "x_v0", data: {} };
  for (let i = 0; i < 3; i++) {
    const n = step(v);
    v = n;
  }
  broadcast("agent", v);
}
export function untouchedLoop() {
  const { broadcast } = createGatewayBroadcaster();
  let u: Frame = { runId: "r", stream: "x_u0", data: {} };
  for (let i = 0; i < 3; i++) u = { ...u, stream: u.stream === "x_u0" ? "x_u1" : u.stream === "x_u1" ? "x_u2" : "x_u3" };
  broadcast("agent", { runId: "r", stream: u.stream, data: u.data });
}
export function untouchedSequence() {
  const { broadcast } = createGatewayBroadcaster();
  let w: Frame = { runId: "r", stream: "x_w0", data: {} };
  w = { ...w, stream: w.stream === "x_w0" ? "x_w1" : "x_w9" };
  w = { ...w, stream: w.stream === "x_w1" ? "x_w2" : "x_w9" };
  broadcast("agent", { runId: "r", stream: w.stream, data: { w: 1 } });
}
export function chained(on: (cb: () => void) => void) {
  const { broadcast } = createGatewayBroadcaster();
  let c: Frame = { runId: "r", stream: "x_c0", data: { a: 1 } };
  on(() => {
    c.data.deep = 1;
  });
  on(() => {
    c.data = { fresh: 1 };
  });
  on(() => {
    c = { runId: "r", stream: "x_c1", data: {} };
  });
  broadcast("agent", c);
}
`,
    // The memory of calls: one evaluation serves arguments that are the same value — never
    // two closures from one node, which capture different things, called or held by an
    // object the callee writes into.
    "src/gateway/memo-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Frame = { runId: string; stream: string; data: Record<string, unknown> };
function framed(cb: () => string): Frame {
  return { runId: "r", stream: cb(), data: {} };
}
const make = (s: string) => () => s;
export function twoCallbacks() {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", framed(make("x_cb_one")));
  broadcast("agent", framed(make("x_cb_two")));
}
function settle(o: { get(): string; used?: boolean }): Frame {
  o.used = true;
  return { runId: "r", stream: o.get(), data: {} };
}
const holder = (s: string) => ({
  get() {
    return s;
  },
});
export function twoHolders() {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", settle(holder("x_holder_one")));
  broadcast("agent", settle(holder("x_holder_two")));
}
// The same literal argument in two branches that narrow a binding the callee reads.
export function narrowedCalls(cond: boolean) {
  const { broadcast } = createGatewayBroadcaster();
  const e = cond ? { kind: "a" as const, tag: "x_n_a" } : { kind: "b" as const, tag: "x_n_b" };
  const label = (suffix: string): Frame => ({ runId: "r", stream: e.tag, data: { suffix } });
  broadcast("agent", e.kind === "a" ? label("s") : label("s"));
}
`,
    // 4. A library copy is valued from its arguments, with their provenance; a relay is an
    //    event of the bus's own type, not any value that has a stream and a data.
    "src/gateway/assign-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
export function assignCopy() {
  const { broadcast } = createGatewayBroadcaster();
  const p = { runId: "r", stream: "x_assign_before", data: { early: 1 } };
  const q = Object.assign({}, p);
  broadcast("agent", q);
  const j = JSON.parse(JSON.stringify({ runId: "r", stream: "x_json_copy", data: { copied: 1 } }));
  broadcast("agent", j);
}
export function relayShape(x: { runId: string; seq: number; ts: number; stream: string; data: Record<string, unknown> }) {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", x);
}
export function relayBus(evt: AgentEventPayload) {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", evt);
}
`,
    // 4, the general cause: the other library copies, and a relay of a type made from the
    //    bus's (an intersection, a standard library transformation).
    "src/gateway/copy-general-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
export function otherCopies() {
  const { broadcast } = createGatewayBroadcaster();
  // A binding's declared type widens the stream to string: only its value keeps the literal.
  const f = { runId: "r", stream: "x_frozen", data: { f: 1 } };
  broadcast("agent", Object.freeze(f));
  broadcast("agent", structuredClone({ runId: "r", stream: "x_cloned", data: { c: 1 } }));
}
export function relayExtended(evt: AgentEventPayload & { spawnedBy?: string }) {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", evt);
}
export function relayOmitted(evt: Omit<AgentEventPayload, "seq" | "ts">) {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", evt);
}
`,
    // 4, the general cause: a relayed event's data is its own only when it is read from a
    //    value of the bus's type — not from any value with a stream and a data.
    "src/gateway/relay-data-s.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
export function relayForeignData(evt: AgentEventPayload, other: { stream: string; data: Record<string, unknown> }) {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", { ...evt, data: other.data });
}
`,
  };
  let inv7: Inventory;
  type Fab = { file: string; function: string; stream?: string; keys?: string[]; reason?: string; line?: number };
  type Relay = { file: string; function: string; origins: { kind: string; type?: string }[] };
  const tf7 = () => inv7.transformations as unknown as { fabricated: Fab[]; unresolved: Fab[]; relays: Relay[] };
  const keysOf = (stream: string) => tf7().fabricated.filter((g) => g.stream === stream).map((g) => g.keys);
  const keysAt = (stream: string) => new Set(keysOf(stream).flat());
  const reasonsIn = (file: string) => tf7().unresolved.filter((u) => u.file === file).map((u) => u.reason ?? "");
  beforeAll(() => {
    inv7 = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES },
      tsconfig: TSCONFIG,
      // The DOM library declares structuredClone, as @types/node does upstream.
      compilerOptions: { lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] },
    });
  });

  it("1. what a helper does after its first await, or in a generator, may not have run at a send that does not wait for it", () => {
    expect(keysOf("x_async_before")).toEqual([["early"]]);
    expect(keysOf("x_async_after")).toEqual([["late"]]);
    expect(keysOf("x_gen_before")).toEqual([["genEarly"]]);
    expect(keysOf("x_gen_after")).toEqual([["genLate"]]);
    // The part before the first await runs with the call.
    expect(keysOf("x_sync_part")).toEqual([["e", "sync"]]);
    // The continuation replaces the data after the synchronous write, never before it.
    expect(keysOf("x_awaited_after").some((k) => JSON.stringify(k) === '["done","sync"]')).toBe(false);
  });

  it("1. awaited, the helper has finished: its writes are certain", () => {
    expect(keysOf("x_awaited_before")).toEqual([]);
    expect(keysOf("x_awaited_after").some((k) => JSON.stringify(k) === '["done"]')).toBe(true);
  });

  it("2. every value a function-typed property may hold is examined, and an unknown one among known ones refuses", () => {
    const reasons = reasonsIn("src/gateway/values-s.ts");
    expect(reasons.some((r) => /property act .*holds .*a function that is not an arrow that uses `this`/.test(r) && /reassignedValue/.test(r))).toBe(true);
    expect(reasons.some((r) => /property act .*holds ternaryValue > mutator/.test(r))).toBe(true);
    expect(reasons.some((r) => /property act .*may hold makeAct\(\)/.test(r))).toBe(true);
    expect(keysOf("x_act")).toEqual([]);
    expect(keysOf("x_ternary_act")).toEqual([]);
    expect(keysOf("x_unknown_act")).toEqual([]);
    expect(keysOf("x_arrows_act")).toEqual([["a"]]);
  });

  it("3. LIMIT — what may run any number of times is applied in two passes at most: the states past them are not derived", () => {
    // `p = next(p)` three times from x_s0: followed through two applications, so x_s3 is not
    // derived. A limit the contract states, not a refusal: nothing is unresolved.
    for (const s of ["x_s0", "x_s1", "x_s2"]) expect(keysOf(s).length, s).toBeGreaterThan(0);
    expect(keysOf("x_s3")).toEqual([]);
    // Read through another binding (`const n = step(v); v = n`): valued once, where it first runs.
    expect(keysOf("x_v1").length).toBeGreaterThan(0);
    expect(keysOf("x_v2")).toEqual([]);
    // A binding handed to no call: each reassignment read against its first value, in a loop
    // or in a sequence.
    expect(keysOf("x_u1").length).toBeGreaterThan(0);
    expect(keysOf("x_u2")).toEqual([]);
    expect(keysOf("x_w9").length).toBeGreaterThan(0);
    expect(keysOf("x_w2")).toEqual([]);
    // Three callbacks, each replacing what the next writes into: not every order.
    expect(keysOf("x_c1").some((k) => JSON.stringify(k) === '["deep","fresh"]')).toBe(false);
    expect(reasonsIn("src/gateway/loop-s.ts")).toEqual([]);
  });

  it("the memory of calls shares one evaluation only between arguments that are the same value: never two closures", () => {
    for (const s of ["x_cb_one", "x_cb_two", "x_holder_one", "x_holder_two"]) expect(keysOf(s).length, s).toBeGreaterThan(0);
    // Nor across two branches that narrow a binding the callee reads.
    expect(keysOf("x_n_a").length).toBeGreaterThan(0);
    expect(keysOf("x_n_b").length).toBeGreaterThan(0);
  });

  it("4. a library copy is valued from its arguments: the local frame stays fabricated", () => {
    expect(keysOf("x_assign_before")).toEqual([["early"]]);
    expect(keysOf("x_json_copy")).toEqual([["copied"]]);
    expect(tf7().relays.filter((r) => r.file === "src/gateway/assign-s.ts" && r.function === "assignCopy")).toEqual([]);
  });

  it("4. a relay is an event of the bus's own type, not any value with a stream and a data", () => {
    const relays = tf7().relays.filter((r) => r.file === "src/gateway/assign-s.ts");
    expect(relays.map((r) => r.function)).toEqual(["relayBus"]);
    expect(reasonsIn("src/gateway/assign-s.ts").some((r) => /not an event of the bus/.test(r))).toBe(true);
  });

  it("4. the other library copies are valued from their arguments too, and a relay may be of a type made from the bus's", () => {
    expect(keysOf("x_frozen")).toEqual([["f"]]);
    expect(keysOf("x_cloned")).toEqual([["c"]]);
    const relays = tf7().relays.filter((r) => r.file === "src/gateway/copy-general-s.ts").map((r) => r.function).sort();
    expect(relays).toEqual(["relayExtended", "relayOmitted"]);
  });

  it("4. a relayed event's data read from a value not of the bus's type is the gateway's own", () => {
    expect(reasonsIn("src/gateway/relay-data-s.ts").some((r) => /replaces a relayed event's data/.test(r))).toBe(true);
  });

  it("4. a bus without its event type refuses the derivation: no relay could be told from a frame", () => {
    const files = { ...TRANSPORT, "src/infra/agent-events.ts": BUS.replace(/AgentEventPayload/g, "BusEvent"), "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]! };
    expect(() => derive({ root: "/virtual-upstream", files, tsconfig: TSCONFIG, compilerOptions: OPTIONS })).toThrow(/no AgentEventPayload type/);
  });
});

describe("deriveAgentEmissions — the gateway's handler chain at v2026.10.33: admission, live sender, shared reads", () => {
  // Three shapes that tag introduces between the bus and the transports, each of which
  // left a gateway sender unresolved. Mirrors of src/gateway/server-chat.ts
  // (`sendLivePayload`, :734-799), src/gateway/server-chat-event-admission.ts
  // (`createAgentEventAdmission`, :16-142) and src/gateway/shared-read-responses.ts
  // (`owners`, :29-41 and :103-128) at v2026.10.33.
  type Tf = { relays: { file: string; function: string; origins: { kind: string; type?: string; entries?: string[] }[] }[]; unresolved: { file: string; function: string; reason: string }[]; senderSites: Record<string, number> };
  type Forward = { at: string; function: string; wrapper: string; followed: Record<string, unknown>[] };
  const LIB = { lib: ["lib.es2022.d.ts"] };
  const deriveWithFiles = (files: Record<string, string>) =>
    derive({ root: "/virtual-upstream", files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, ...files }, tsconfig: TSCONFIG, compilerOptions: LIB });
  const tfOf = (i: Inventory) => i.transformations as unknown as Tf;
  const inFile = (i: Inventory, file: string) => ({
    relays: tfOf(i).relays.filter((r) => r.file === file),
    unresolved: tfOf(i).unresolved.filter((u) => u.file === file),
  });

  const LIVE = `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
type ChatEvent = { runId: string; state: "delta" | "final" | "error" | "aborted" };
type Opts = { visible?: boolean; agentId?: string };
declare const publication: { holdTerminal(runId: string, release: () => void): boolean };
declare function snapshot(sessionKey: string): { sessionKey: string };
type Send = (event: string, payload: unknown) => void;
export function wire() {
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster();
  const { nodeSendToSession } = createGatewayNodeSessionRuntime();
  return createHandler({ broadcast, broadcastToConnIds, nodeSendToSession });
}
export function createHandler({ broadcast, broadcastToConnIds, nodeSendToSession }: { broadcast: Send; broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void; nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void }) {
  const sendLivePayload = (event: "agent" | "chat", sessionKey: string | undefined, payload: ChatEvent | AgentEventPayload, opts?: Opts) => {
    if (__RECURSE__) return;
    if (opts?.visible ?? true) {
      broadcast(event, payload);
      if (sessionKey) nodeSendToSession(sessionKey, event, payload);
      return;
    }
    const delivered = event === "agent" && sessionKey ? { ...payload, ...snapshot(sessionKey) } : payload;
    broadcastToConnIds(event, delivered, new Set<string>());
  };
  const sendAgentPayload = (sessionKey: string | undefined, payload: AgentEventPayload & { spawnedBy?: string }, opts?: Opts) => {
    sendLivePayload("agent", sessionKey, payload, { ...opts });
  };
  const buffer: { bufferedEvent?: { sessionKey: string; payload: AgentEventPayload & { spawnedBy?: string } } }[] = [];
  const flush = () => {
    for (const state of buffer) {
      const buffered = state.bufferedEvent;
      if (!buffered) continue;
      delete state.bufferedEvent;
      sendAgentPayload(buffered.sessionKey, buffered.payload, { visible: false });
    }
  };
  const chat = (p: ChatEvent) => sendLivePayload("chat", "k", p);
  const handleEvent = (evt: AgentEventPayload) => {
    const spawnedBy = evt.sessionKey;
    const text = String(evt.data.text ?? "");
    if (evt.stream === "assistant") {
      const agentPayload = { ...evt, ...(spawnedBy ? { spawnedBy } : {}), data: { ...evt.data, text } };
      if (text) buffer.push({ bufferedEvent: { sessionKey: "k", payload: agentPayload } });
      else sendAgentPayload(evt.sessionKey, agentPayload, { visible: true });
      return;
    }
    if (evt.stream === "tool") {
      sendAgentPayload(evt.sessionKey, spawnedBy ? { ...evt, spawnedBy } : evt);
      return;
    }
    sendAgentPayload(evt.sessionKey, evt, { agentId: "a" });
    chat({ runId: evt.runId, state: "final" });
  };
  return Object.assign(handleEvent, { flush });
}
`;

  const HELD = 'event === "chat" && "state" in payload && payload.state === "final" && publication.holdTerminal(payload.runId, () => sendLivePayload(event, sessionKey, payload, opts))';
  const live = (recurse: string) => deriveWithFiles({ "src/gateway/live.ts": LIVE.replace("__RECURSE__", recurse) });

  it("a wrapper calling itself with its own parameters adds no frame: the live sender resolves as it does without the recursion", () => {
    const plain = inFile(live("false"), "src/gateway/live.ts");
    const held = live(HELD);
    expect(plain.unresolved).toEqual([]);
    expect(plain.relays.map((r) => r.function).sort()).toEqual(["createHandler > flush", "createHandler > handleEvent"]);
    // Followed as a forward, the self-call re-entered the wrapper's template with one more
    // layer of the body's effects on each round and ended on the evaluator's bound
    // ("the event is not evaluated: more than 64 alternatives").
    expect(inFile(held, "src/gateway/live.ts")).toEqual(plain);
    expect(tfOf(held).senderSites.undetermined).toBe(tfOf(live("false")).senderSites.undetermined);
    const self = ((held as unknown as { forwards: Forward[] }).forwards).filter((f) => f.followed.some((x) => "self" in x));
    expect(self.map((f) => f.wrapper)).toEqual(["createHandler > sendLivePayload"]);
  });

  it("a recursion that changes what it passes on is a forward like any other", () => {
    for (const changed of [
      // another payload
      'event === "chat" && publication.holdTerminal(payload.runId, () => sendLivePayload(event, sessionKey, { ...payload, runId: "again" }, opts))',
      // another event
      'event === "chat" && publication.holdTerminal(payload.runId, () => sendLivePayload("agent", sessionKey, payload, opts))',
    ]) {
      const forwards = (live(changed) as unknown as { forwards: Forward[] }).forwards;
      expect(forwards.filter((f) => f.followed.some((x) => "self" in x)), changed).toEqual([]);
    }
  });

  const SHARED = (decl: string) => `
import { createGatewayBroadcaster } from "./server-broadcast.js";
type Send = (event: string, payload: unknown) => void;
${decl}
export function invalidate(owner: Send): void {
  owners.get(owner)?.clear();
}
export function share(context: { broadcast: Send }) {
  const owner = context.broadcast;
  let entries = owners.get(owner);
  if (!entries) {
    entries = new Map();
    owners.set(owner, entries);
  }
}
export function wireShared() {
  const { broadcast } = createGatewayBroadcaster();
  share({ broadcast });
  invalidate(broadcast);
}
`;
  const ADMISSION = `
import type { AgentEventPayload } from "../infra/agent-events.js";
export function createAdmission({ handleEvent, resolveSession, isCurrent }: {
  handleEvent: (e: AgentEventPayload) => void;
  resolveSession: (e: AgentEventPayload) => { key?: string };
  isCurrent: (e: AgentEventPayload) => boolean;
}) {
  const accept = (evt: AgentEventPayload) => {
    if (!isCurrent(evt)) return;
    const session = resolveSession(evt);
    void session;
    handleEvent(evt);
  };
  return Object.assign((event: AgentEventPayload) => accept(event), { dispose: () => {} });
}
`;
  const HANDLER = (isCurrent: string, extra = "") => `
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createAdmission } from "./admission.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
type Send = (event: string, payload: unknown) => void;
export function createHandler({ broadcast }: { broadcast: Send }) {
  const handleEvent = (evt: AgentEventPayload) => {
    broadcast("agent", evt);
  };
  const resolveSession = (evt: AgentEventPayload) => ({ key: evt.sessionKey });
  return createAdmission({ handleEvent, resolveSession, isCurrent: ${isCurrent} });
}
export function wire() {
  const { broadcast } = createGatewayBroadcaster();
  return createHandler({ broadcast });
}
${extra}
`;

  it("a sender used as the KEY of a standard WeakMap goes nowhere through it", () => {
    const weak = inFile(deriveWithFiles({ "src/gateway/shared.ts": SHARED("const owners = new WeakMap<Send, Map<string, number>>();") }), "src/gateway/shared.ts");
    expect(weak).toEqual({ relays: [], unresolved: [] });
  });

  it("the key of a Map can be read back and called: it still escapes — and so does a subclass with methods of its own", () => {
    const map = inFile(deriveWithFiles({ "src/gateway/shared.ts": SHARED("const owners = new Map<Send, Map<string, number>>();") }), "src/gateway/shared.ts");
    expect(map.unresolved.length).toBeGreaterThan(0);
    expect(map.unresolved.every((u) => /closure parameter #0 of createGatewayBroadcaster > broadcast/.test(u.reason))).toBe(true);
    const sub = inFile(
      deriveWithFiles({
        "src/gateway/shared.ts": SHARED("class Owners extends WeakMap<Send, Map<string, number>> {\n  get(key: Send) {\n    key(\"agent\", {});\n    return super.get(key);\n  }\n}\nconst owners = new Owners();"),
      }),
      "src/gateway/shared.ts",
    );
    // Its own `get` is read as the caller it is; its inherited `set` is not the library's.
    expect(sub.unresolved.map((u) => u.function).sort()).toEqual(["Owners.get", "broadcast=createGatewayBroadcaster()→broadcast"]);
  });

  it("an event handed to callback parameters that only read it stays a relay of the bus's event", () => {
    const adm = inFile(deriveWithFiles({ "src/gateway/admission.ts": ADMISSION, "src/gateway/handler.ts": HANDLER('(evt) => evt.runId !== ""') }), "src/gateway/admission.ts");
    expect(adm.unresolved).toEqual([]);
    expect(adm.relays.map((r) => [r.function, r.origins.map((o) => [o.kind, o.type])])).toEqual([
      ["createAdmission > Object.assign(#0)", [["typed", "AgentEventPayload"]]],
    ]);
  });

  it("a callback that writes into the event, or one whose value is not in the sources, leaves the send unresolved — by name", () => {
    const writes = inFile(deriveWithFiles({ "src/gateway/admission.ts": ADMISSION, "src/gateway/handler.ts": HANDLER("(evt) => { evt.data.seen = 1; return true; }") }), "src/gateway/admission.ts");
    expect(writes.relays).toEqual([]);
    expect(writes.unresolved.map((u) => u.reason)).toEqual([
      expect.stringMatching(/^passed to isCurrent\(…\) before the send, a callback that may be createHandler > isCurrent \(src\/gateway\/handler\.ts:\d+\): .*writes into it$/),
    ]);
    // A second caller hands in values this cannot read: nothing is assumed about them.
    const external = inFile(
      deriveWithFiles({
        "src/gateway/admission.ts": ADMISSION,
        "src/gateway/handler.ts": HANDLER(
          '(evt) => evt.runId !== ""',
          "declare const external: { handleEvent: (e: AgentEventPayload) => void; resolveSession: (e: AgentEventPayload) => { key?: string }; isCurrent: (e: AgentEventPayload) => boolean };\nexport const other = createAdmission(external);",
        ),
      }),
      "src/gateway/admission.ts",
    );
    expect(external.relays).toEqual([]);
    expect(external.unresolved.map((u) => u.reason)).toEqual([
      "passed to resolveSession(…) before the send, code whose effects on it are not modeled; passed to isCurrent(…) before the send, code whose effects on it are not modeled",
    ]);
  });
});

describe("deriveAgentEmissions — upstream's lifecycle terminal backstop is a state machine of three kinds (lot F)", () => {
  // src/auto-reply/reply/agent-lifecycle-terminal.ts (all 194 lines) at 2026.9.36, verbatim but for its
  // package import; the helpers it imports declared with their upstream signatures. Its
  // state is reassigned in closures — pending (beginAttempt :77), written into (note :93-94),
  // emitted (:97, :175), captured with an event prepared from it (capture :166-167) — and
  // the emit's prepareTerminal spreads pending.metadata (:110-115).
  const FILES: Record<string, string> = {
    "src/auto-reply/reply/agent-lifecycle-terminal.ts": `import { readStringValue } from "../../shared/string-coerce.js";
import { classifyOAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { renderAgentHarnessPreflightUserMessage } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { getFailoverErrorCode } from "../../agents/failover/error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";

export type AgentLifecycleTerminalBackstop = {
  beginAttempt: () => void;
  capture: AgentLifecycleTerminalBackstop["emit"];
  emit: (
    phase: "end" | "error",
    resultOrError: unknown,
    extraData?: Record<string, unknown>,
  ) => void;
  getDeferredError: () => string | undefined;
  note: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

type PendingLifecycleTerminal = {
  kind: "pending";
  deferredError?: string;
  metadata: Record<string, unknown>;
};

type LifecycleTerminalState =
  | PendingLifecycleTerminal
  | { kind: "captured"; event: Parameters<typeof emitAgentEvent>[0] }
  | { kind: "emitted" };

const DEFERRED_TERMINAL_METADATA_KEYS = [
  "stopReason",
  "yielded",
  "timeoutPhase",
  "providerStarted",
  "aborted",
  "livenessState",
  "replayInvalid",
  "errorObservation",
  "assistantTranscriptIdempotencyKey",
] as const;

export function resolveAgentLifecycleTerminalMetadata(meta: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (!meta || typeof meta !== "object") {
    return metadata;
  }
  const record = meta as Record<string, unknown>;
  for (const key of DEFERRED_TERMINAL_METADATA_KEYS) {
    if (Object.hasOwn(record, key)) {
      metadata[key] = record[key];
    }
  }
  return metadata;
}

export function createAgentLifecycleTerminalBackstop(params: {
  runId: string;
  sessionKey?: string;
  startedAt?: number;
  getLifecycleGeneration: () => string;
  onTerminalEvent?: (event: Parameters<typeof emitAgentEvent>[0]) => void;
  resolveTerminationFields: (error?: unknown) => {
    aborted?: true;
    stopReason?: string;
    timeoutPhase?: string;
  };
}): AgentLifecycleTerminalBackstop {
  let state: LifecycleTerminalState = { kind: "pending", metadata: {} };
  // Preparation can fail before a lifecycle start. Capture its real boundary
  // without signaling readiness; an observed model start replaces it below.
  let startedAt = params.startedAt ?? Date.now();
  const beginAttempt = () => {
    if (state.kind !== "emitted") {
      state = { kind: "pending", metadata: {} };
    }
  };

  const note = (evt: { stream: string; data: Record<string, unknown> }) => {
    if (state.kind === "emitted" || evt.stream !== "lifecycle") {
      return;
    }
    const phase = readStringValue(evt.data.phase);
    if (phase === "start") {
      beginAttempt();
      if (typeof evt.data.startedAt === "number") {
        startedAt = evt.data.startedAt;
      }
    }
    if (phase === "finishing" && state.kind === "pending") {
      state.deferredError = readStringValue(evt.data.error) ?? state.deferredError;
      Object.assign(state.metadata, resolveAgentLifecycleTerminalMetadata(evt.data));
    }
    if (phase === "end" || phase === "error") {
      state = { kind: "emitted" };
    }
  };

  const prepareTerminal = (
    pending: PendingLifecycleTerminal,
    phase: "end" | "error",
    resultOrError: unknown,
    extraData?: Record<string, unknown>,
  ): Parameters<typeof emitAgentEvent>[0] => {
    const terminationFields = params.resolveTerminationFields(
      phase === "error" ? resultOrError : undefined,
    );
    const restartAbort = terminationFields.stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON;
    const data: Record<string, unknown> = {
      ...pending.metadata,
      phase: restartAbort ? "end" : phase,
      endedAt: Date.now(),
      startedAt,
    };
    if (restartAbort) {
      data.aborted = true;
      data.stopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
    } else if (phase === "error") {
      const oauthFailure = classifyOAuthRefreshFailureError(resultOrError);
      data.error =
        renderAgentHarnessPreflightUserMessage(resultOrError) ??
        renderFailoverCodeUserCopy(getFailoverErrorCode(resultOrError)) ??
        (oauthFailure?.summary ? \`⚠️ \${oauthFailure.summary}\` : undefined) ??
        formatErrorMessage(resultOrError);
      if (oauthFailure?.summary) {
        data.errorObservation = {
          ...(oauthFailure.provider ? { provider: oauthFailure.provider } : {}),
          ...(oauthFailure.reason ? { failoverReason: oauthFailure.reason } : {}),
          providerRuntimeFailureKind: "auth_refresh",
          ...(oauthFailure.errorType ? { providerErrorType: oauthFailure.errorType } : {}),
          ...(oauthFailure.status ? { httpStatus: oauthFailure.status } : {}),
        };
      }
      Object.assign(data, terminationFields);
    } else {
      const meta =
        resultOrError && typeof resultOrError === "object" && "meta" in resultOrError
          ? (resultOrError as { meta?: Record<string, unknown> }).meta
          : undefined;
      Object.assign(data, resolveAgentLifecycleTerminalMetadata(meta));
      if (terminationFields.aborted === true) {
        data.aborted = true;
      }
      if (terminationFields.stopReason && !readStringValue(data.stopReason)) {
        data.stopReason = terminationFields.stopReason;
      }
    }
    if (extraData) {
      Object.assign(data, extraData);
    }
    return {
      runId: params.runId,
      lifecycleGeneration: params.getLifecycleGeneration(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      stream: "lifecycle",
      data,
    };
  };

  const capture: AgentLifecycleTerminalBackstop["capture"] = (phase, resultOrError, extraData) => {
    if (state.kind === "pending") {
      // Record bounded terminal facts before awaited bookkeeping can change
      // the abort signal, lifecycle generation, or subsequent workflow outcome.
      const event = prepareTerminal(state, phase, resultOrError, extraData);
      state = { kind: "captured", event };
    }
  };
  const emit: AgentLifecycleTerminalBackstop["emit"] = (phase, resultOrError, extraData) => {
    const current = state;
    if (current.kind === "emitted") {
      return;
    }
    state = { kind: "emitted" };
    const event =
      current.kind === "captured"
        ? current.event
        : prepareTerminal(current, phase, resultOrError, extraData);
    // Captured candidates can still be replaced by retries. Only publication
    // settles execution; delivery and yielded-parent continuation remain separate.
    const settled = { ...event, data: { ...event.data, executionSettled: true } };
    emitAgentEvent(settled);
    params.onTerminalEvent?.(settled);
  };

  return {
    beginAttempt,
    capture,
    emit,
    getDeferredError: () => (state.kind === "pending" ? state.deferredError : undefined),
    note,
  };
}
`,
    "src/shared/string-coerce.ts": `export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
`,
    "src/agents/auth-profiles/oauth-refresh-failure.ts": `type OAuthRefreshFailure = { summary?: string; provider?: string; reason?: string; errorType?: string; status?: number };
export declare function classifyOAuthRefreshFailureError(err: unknown): OAuthRefreshFailure | null;
`,
    "src/agents/embedded-agent-helpers/user-facing-text.ts": `export declare function renderAgentHarnessPreflightUserMessage(error: unknown): string | undefined;
`,
    "src/agents/failover/error.ts": `export declare function getFailoverErrorCode(err: unknown): string | undefined;
`,
    "src/agents/failover/user-copy.ts": `export declare const renderFailoverCodeUserCopy: (code: unknown) => string | undefined;
`,
    "src/agents/run-termination.ts": `export const AGENT_RUN_RESTART_ABORT_STOP_REASON = "restart_abort";
`,
    "src/infra/errors.ts": `export declare function formatErrorMessage(err: unknown): string;
`,
    "src/agents/backstop-caller.ts": `import { createAgentLifecycleTerminalBackstop, resolveAgentLifecycleTerminalMetadata } from "../auto-reply/reply/agent-lifecycle-terminal.js";
declare function onRunEvents(listener: (evt: { stream: string; data: Record<string, unknown> }) => void): void;
type Result = { meta: Record<string, unknown> & { error?: { message: string } } };
export async function runWithBackstop(runId: string, run: () => Promise<Result>) {
  const terminal = createAgentLifecycleTerminalBackstop({
    runId,
    getLifecycleGeneration: () => "g1",
    resolveTerminationFields: (error) => (error ? { aborted: true, stopReason: "error" } : {}),
  });
  onRunEvents((evt) => terminal.note(evt));
  terminal.beginAttempt();
  const result = await run();
  terminal.capture("end", result);
  const error = result.meta.error?.message ?? terminal.getDeferredError();
  terminal.emit(error ? "error" : "end", error ? new Error(error) : result, { ...resolveAgentLifecycleTerminalMetadata(result.meta) });
}
`,
  };
  let invB: Inventory;
  beforeAll(() => {
    invB = derive({ root: "/virtual-upstream", files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...FILES }, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
  });
  type Un = { file: string; reason: string };
  const unresolvedB = () => (invB.transformations as unknown as { unresolved: Un[] }).unresolved;

  it("its emit is derived without an evaluator bound", () => {
    // The transport fixtures' own sends aside (their event is a parameter of the transport).
    expect(unresolvedB().filter((u) => !u.file.startsWith("src/gateway/")).map((u) => `${u.file}: ${u.reason}`)).toEqual([]);
    expect(JSON.stringify(invB.emissions)).not.toMatch(/evaluator bound/);
  });

  it("its terminal rows carry the backstop's keys", () => {
    const rows = invB.emissions.filter((e) => /backstop-caller\.ts/.test(e.key));
    expect(rows.every((r) => r.stream === "lifecycle"), JSON.stringify(rows.map((r) => r.key))).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const keys = new Set(rows.flatMap((r) => r.keys.map((k) => k.key)));
    for (const k of ["phase", "endedAt", "startedAt", "executionSettled"]) expect(keys.has(k), k).toBe(true);
  });
});

describe("deriveAgentEmissions — the transport's senders are a known set, each with its contract", () => {
  const withTransport = (file: string, edit: (text: string) => string) => ({ ...TRANSPORT, [file]: edit(TRANSPORT[file]!) });
  const run = (transport: Record<string, string>, extra: Record<string, string> = {}) =>
    derive({ root: "/virtual-upstream", files: { ...transport, "src/infra/agent-events.ts": BUS, "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!, ...extra }, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
  const SITE = {
    "src/gateway/site-j.ts": `
import { createGatewayBroadcaster } from "./server-broadcast.js";
export function sendOne() {
  const { broadcast } = createGatewayBroadcaster();
  broadcast("agent", { stream: "x_contract", data: { k: 1 } });
}
`,
  };
  const fabricated = (inv: Inventory) => (inv.transformations as unknown as { fabricated: { stream: string }[] }).fabricated.map((g) => g.stream);
  const BROADCAST = "src/gateway/server-broadcast.ts";

  it("parameters renamed (`topic`, `body`): the contract is positional, the sender still found", () => {
    const t = withTransport(BROADCAST, (s) => s.replace("const broadcast = (event: string, payload: unknown) => broadcastInternal(event, payload);", "const broadcast = (topic: string, body: unknown) => broadcastInternal(topic, body);"));
    expect(t[BROADCAST]).toContain("topic: string");
    expect(fabricated(run(t, SITE))).toContain("x_contract");
  });

  it("`broadcast: broadcastInternal`: the member is found through its identifier", () => {
    const t = withTransport(BROADCAST, (s) => s.replace("return { broadcast, broadcastToConnIds", "return { broadcast: broadcastInternal, broadcastToConnIds"));
    expect(t[BROADCAST]).toContain("broadcast: broadcastInternal");
    expect(fabricated(run(t, SITE))).toContain("x_contract");
  });

  it("a listed sender absent refuses the derivation", () => {
    const t = withTransport(BROADCAST, (s) => s.replace("return { broadcast, broadcastToConnIds, broadcastPluginEvent, getBufferedAmount };", "return { broadcast, broadcastPluginEvent, getBufferedAmount };"));
    expect(() => run(t)).toThrow(/broadcastToConnIds: the listed frame sender is absent/);
  });

  it("a contract the signature does not bear out refuses the derivation", () => {
    const t = withTransport(BROADCAST, (s) => s.replace("const broadcast = (event: string, payload: unknown) => broadcastInternal(event, payload);", "const broadcast = (payload: unknown, event: string) => broadcastInternal(event, payload);"));
    expect(() => run(t)).toThrow(/broadcast: argument #0, the event, is not typed as a string/);
  });

  it("a candidate sender nobody listed refuses the derivation", () => {
    const t = withTransport(BROADCAST, (s) =>
      s
        .replace("const getBufferedAmount", "const broadcastRaw = (event: string, frame: unknown) => broadcastInternal(event, frame);\n  const getBufferedAmount")
        .replace("broadcastPluginEvent, getBufferedAmount };", "broadcastPluginEvent, getBufferedAmount, broadcastRaw };"),
    );
    expect(() => run(t)).toThrow(/broadcastRaw takes a string and reaches the transport's delivery/);
  });
});

describe("deriveAgentEmissions — a loop element a caller fills is an element", () => {
  // The fourth 9.36 run lost `title` and `toolCallId` of `acp / runtime_event`: upstream
  // loops over a parameter (`for await (const event of params.events)`) and hands each
  // element to a callback; filling that parameter read the element as a property named
  // "[]", absent, so every test on the element was decided false and the `tool_call` branch
  // of acpRuntimeEventDiagnostics dropped its keys. Only rows the derivation wrongly called
  // open had carried them.
  const files: Record<string, string> = {
    "src/acp/runtime-types.ts": `
export type AcpRuntimeEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought" }
  | { type: "status"; text: string; tag?: string }
  | { type: "tool_call"; text: string; tag?: string; status?: string; title?: string; toolCallId?: string }
  | { type: "done"; status?: "completed" | "cancelled"; stopReason?: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
`,
    "src/acp/lifecycle.ts": `
import { emitAgentEvent } from "../infra/agent-events.js";
import type { AcpRuntimeEvent } from "./runtime-types.js";
function diagnostics(event: AcpRuntimeEvent): Record<string, unknown> {
  if (event.type === "status" || event.type === "tool_call") {
    return {
      eventType: event.type,
      text: event.text,
      ...(event.tag ? { tag: event.tag } : {}),
      ...(event.type === "tool_call"
        ? { ...(event.status ? { status: event.status } : {}), ...(event.title ? { title: event.title } : {}), ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}) }
        : {}),
    };
  }
  if (event.type === "done") return { eventType: event.type, ...(event.stopReason ? { stopReason: event.stopReason } : {}) };
  return { eventType: event.type };
}
export function emitAcpRuntimeEvent(params: { runId: string; event: AcpRuntimeEvent }) {
  emitAgentEvent({ runId: params.runId, stream: "x_acp", data: { phase: "runtime_event", ...diagnostics(params.event) } });
}
`,
    "src/acp/execution.ts": `
import { emitAcpRuntimeEvent } from "./lifecycle.js";
import type { AcpRuntimeEvent } from "./runtime-types.js";
function consumeEvents(events: AcpRuntimeEvent[], onEvent?: (event: AcpRuntimeEvent) => void) {
  for (const event of events) onEvent?.(event);
}
export function runAcp(runId: string, events: AcpRuntimeEvent[]) {
  consumeEvents(events, (event) => { if (event.type !== "text_delta") emitAcpRuntimeEvent({ runId, event }); });
}
declare function nextEvents(): AcpRuntimeEvent[];
// A caller that FILLS the array (upstream: \`events: turn.events\` from the runtime).
export function runFilled(runId: string) {
  consumeEvents(nextEvents(), (event) => { if (event.type !== "text_delta") emitAcpRuntimeEvent({ runId, event }); });
}
`,
  };
  it("the tool_call branch keeps its keys through the callback", () => {
    const loops = derive({
      root: "/virtual-upstream",
      files: { ...TRANSPORT, "src/infra/agent-events.ts": BUS, ...files },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
    const acp = loops.emissions.filter((e) => e.stream === "x_acp");
    // The open row (the caller's parameter closed by its type) and the filled call.
    expect(acp.map((r) => r.function).sort()).toEqual(["runAcp", "runFilled"]);
    for (const r of acp) expect(keyList(r), r.function).toEqual(expect.arrayContaining(["status?", "title?", "toolCallId?", "stopReason?", "tag?"]));
  });
});

describe("deriveAgentEmissions — the normalization upstream applies before comparing a content type", () => {
  // Review defect (2026-11-08): upstream compares tool block types as
  // `type.trim().toLowerCase()`, so a `toolResult` block is recognized; the inventory kept
  // only the literal spelling and the detector called it drift.
  it("records a fold with the literal it applies to, and none on an exact comparison", () => {
    const folded = derive({
      root: "/virtual-upstream",
      files: {
        ...TRANSPORT,
        "src/infra/agent-events.ts": BUS,
        "src/cases/lifecycle.ts": UPSTREAM["src/cases/lifecycle.ts"]!,
        "src/chat/tool-content.ts": `
function normalizeToolContentType(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
export function isToolResultContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolresult" || type === "tool_result";
}
`,
        "src/gateway/chat-display-projection.canvas.ts": `
import { isToolResultContentType } from "../chat/tool-content.js";
export function isToolResultHistoryBlockType(type: unknown): boolean {
  return typeof type === "string" && isToolResultContentType(type.trim());
}
function isCanvas(type: unknown): boolean {
  return type === "canvas";
}
export function project(message: { content: { type?: unknown }[] }) {
  for (const block of message.content) {
    if (isToolResultHistoryBlockType(block.type)) return 1;
    if (isCanvas(block.type)) return 3;
    if (block.type === "toolCall") return 2;
  }
  return 0;
}
`,
      },
      tsconfig: TSCONFIG,
      compilerOptions: OPTIONS,
    });
    const recognized = (folded.chatContentParts.recognized as { type: string; sites: { fold?: string }[] }[]).map((r) => [
      r.type,
      [...new Set(r.sites.map((s) => s.fold ?? "exact"))],
    ]);
    expect(recognized).toEqual([
      ["canvas", ["exact"]],
      ["toolCall", ["exact"]],
      ["tool_result", ["trim+lowercase"]],
      ["toolresult", ["trim+lowercase"]],
    ]);
  });
});

describe("deriveAgentEmissions — stable output", () => {
  it("is byte-identical across runs, and its row key carries no line number", () => {
    const again = derive({ root: "/virtual-upstream", files: UPSTREAM, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
    expect(serialize(again)).toBe(serialize(inv));
    const [r] = rows("t_literal");
    expect(r?.key).toBe("t_literal|start|name,phase|src/cases/literal.ts|literal");
  });

  it("the diff names an added phase and an added key, and ignores a line shift", () => {
    const shifted = {
      ...UPSTREAM,
      "src/cases/literal.ts": `\n\n${UPSTREAM["src/cases/literal.ts"]}`,
      "src/cases/ternary.ts": UPSTREAM["src/cases/ternary.ts"]!.replace('ok ? "end" : "error"', 'ok ? "end" : flag ? "retry" : "error"').replace("ok: boolean)", "ok: boolean, flag: boolean)"),
      "src/cases/spread.ts": UPSTREAM["src/cases/spread.ts"]!.replace('phase: "update"', 'phase: "update", added: true'),
    };
    const next = derive({ root: "/virtual-upstream", files: shifted, tsconfig: TSCONFIG, compilerOptions: OPTIONS });
    const md = diff(inv, next);
    expect(md).toContain("### (stream, phase) added (1)\n\n- `t_ternary / retry`");
    expect(md).toMatch(/`t_spread \/ update`: added `added`/);
    expect(md).not.toMatch(/Rows added[^\n]*\n\n- [^\n]*t_literal/);
    expect(md).toContain("Unchanged rows whose line numbers moved: 1");
  });
});
