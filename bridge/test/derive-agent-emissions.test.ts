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

const derive = deriver.deriveAgentEmissions as (input: {
  root: string;
  files: Record<string, string>;
  tsconfig?: unknown;
  compilerOptions?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}) => Inventory;
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
  return { nodeSendToSession };
}
`,
  "src/gateway/node-registry.ts": `
declare function deliverToNode(nodeId: string, frame: string): void;
export class NodeRegistry {
  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    this.sendEventInternal(nodeId, event, payload);
    return true;
  }
  private sendEventInternal(nodeId: string, event: string, payload: unknown): void {
    deliverToNode(nodeId, JSON.stringify({ type: "event", event, payload }));
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
type Broadcast = (event: string, payload: unknown) => void;
type Ev = { runId: string; stream: string; data: Record<string, unknown> };
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
    expect(rows("t_write").map(keyList)).toEqual([["phase", "written?"]]);
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
type Ctx = {
  broadcast: (event: string, payload: unknown) => void;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  registry: NodeRegistry;
};
type Ev = { runId: string; stream: string; data: Record<string, unknown> };
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

  it("what the following cannot see stays UNRESOLVED: a computed key, code outside the sources, a return, a class field", () => {
    const openOf = (needle: string) => unresolvedAt(needle).flatMap((u) => u.open ?? []);
    expect(openOf("useDyn({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is read under a computed key")]));
    expect(openOf("useSink({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is passed to code outside the analysed sources")]));
    expect(openOf("keep({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is returned")]));
    expect(openOf("new Holder({")).toEqual(expect.arrayContaining([expect.stringContaining("its object is kept as a class field")]));
    for (const needle of ["useDyn({", "useSink({", "keep({", "new Holder({"]) {
      expect(unread().some((s) => s.at === `src/gateway/wiring.ts:${lineOf(needle)}`), needle).toBe(false);
    }
  });

  it("every reference is still accounted for", () => {
    expect(followed.completeness.unaccounted).toBe(0);
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
