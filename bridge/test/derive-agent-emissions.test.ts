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

/** The synthetic upstream: one file per behaviour, each on its own stream. */
const UPSTREAM: Record<string, string> = {
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
type Broadcast = (event: string, payload: unknown) => void;
type Ev = { runId: string; stream: string; data: Record<string, unknown> };
export function relay(broadcast: Broadcast, evt: Ev, expected: number) {
  broadcast("agent", { runId: evt.runId, stream: "error", data: { reason: "seq gap", expected } });
  broadcast("agent", evt);
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
    expect(inv.transformations.fabricated).toEqual([expect.objectContaining({ stream: "error", keys: ["expected", "reason"], sender: "broadcast" })]);
    expect(inv.transformations.dataRewrites).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "gateway", added: ["text"], guard: [{ stream: ["assistant"], negated: false }] })]));
  });

  it("content-part types: built into content, or compared on a content block — never by spelling alone", () => {
    expect(inv.chatContentParts.fabricated.map((x) => x.type)).toEqual(["text"]);
    const recognized = inv.chatContentParts.recognized.map((x) => x.type);
    expect(recognized).toEqual(["image", "reasoning", "thinking"]);
    expect(inv.chatContentParts.recognized.find((x) => x.type === "thinking")?.sites[0]?.how).toMatch(/^helper isReasoning/);
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
