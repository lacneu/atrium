// touched-names: what a read site touches, and through WHAT — resolved by binding, never
// by spelling. The truth guard (coverage-truth.test.ts, V3) rests on two answers it gives:
// which binding a read goes through, and whether a read is unreachable for a schema's own
// discriminant value. Both were matched by NAME, and a shadowing binding spelled like the
// discriminant proved a read unreachable that runs (review, 2026-11-08, second pass).

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper, no types
import { touchedNames, unreachableWhen } from "../scripts/lib/touched-names.mjs";

type Touch = { receiverKeys: Map<string, Set<string>>; textKeys: Map<string, Set<string>>; aliases: Map<string, string> };
const FILE = "src/sample.ts";
const fnTouch = (text: string, fn: string): Touch => (touchedNames(text, FILE) as { functions: Map<string, Touch> }).functions.get(fn)!;
const keyOf = (t: Touch, text: string): string => {
  const keys = [...(t.textKeys.get(text) ?? [])];
  expect(keys, `one binding for ${text}`).toHaveLength(1);
  return keys[0]!;
};
const proof = (text: string, fn: string) => {
  const t = fnTouch(text, fn);
  const payload = keyOf(t, "payload");
  return unreachableWhen(text, FILE, fn, "errorMessage", [payload], { receiverKey: payload, field: "state" }, "aborted") as {
    accesses: number;
    unguarded: number[];
  };
};

describe("unreachableWhen — a discriminant is the BINDING, not its spelling", () => {
  it("the review's counterexample: a shadowing `state` in a block proves nothing", () => {
    const text = `
function handle(payload: { state?: string; errorMessage?: string }) {
  const state = payload.state;
  if (state === "aborted") return;
  {
    const state = "error";
    if (state === "error") return payload.errorMessage;
  }
  return undefined;
}`;
    // The early return on the REAL alias excludes "aborted" — so the read IS unreachable
    // for an aborted frame here; the shadowing test must not be what proves it.
    expect(proof(text, "handle")).toEqual({ accesses: 1, unguarded: [] });
    const withoutRealGuard = text.replace('if (state === "aborted") return;', "");
    expect(proof(withoutRealGuard, "handle").unguarded).toEqual([7]);
  });

  it("…and in a closure: the shadowing binding is a closure's, and a guard outside a closure proves nothing about it", () => {
    const text = `
function closure(payload: { state?: string; errorMessage?: string }) {
  const state = payload.state;
  if (state === "aborted") return;
  const read = () => {
    const state = "error";
    if (state === "error") return payload.errorMessage;
    return undefined;
  };
  return read();
}`;
    expect(proof(text, "closure").unguarded).toEqual([7]);
  });

  it("a real guard still proves: the alias by binding, or the read itself", () => {
    const viaAlias = `
function ok(payload: { state?: string; errorMessage?: string }) {
  const state = payload.state;
  if (state === "aborted") return;
  return payload.errorMessage;
}`;
    expect(proof(viaAlias, "ok")).toEqual({ accesses: 1, unguarded: [] });
    const direct = `
function ok(payload: { state?: string; errorMessage?: string }) {
  if (payload.state === "error") return payload.errorMessage;
  return undefined;
}`;
    expect(proof(direct, "ok")).toEqual({ accesses: 1, unguarded: [] });
  });

  it("a read through ANOTHER binding spelled `payload` is not the declared receiver's", () => {
    const text = `
function shadow(payload: { state?: string; errorMessage?: string }, other: { errorMessage?: string }) {
  if (payload.state === "error") return payload.errorMessage;
  {
    const payload = other;
    return payload.errorMessage;
  }
}`;
    const t = fnTouch(text, "shadow");
    // Two bindings spelled `payload`: the text is ambiguous at this site…
    expect(t.textKeys.get("payload")?.size).toBe(2);
    // …and the outer one's reads are exactly the guarded one.
    const outer = [...t.textKeys.get("payload")!].sort()[0]!;
    const r = unreachableWhen(text, FILE, "shadow", "errorMessage", [outer], { receiverKey: outer, field: "state" }, "aborted") as { accesses: number };
    expect(r.accesses).toBe(1);
  });
});

describe("touchedNames — receivers by binding", () => {
  it("a renaming is an alias of the binding it renames, not of a homonym", () => {
    const text = `
function f(evt: { runId: string }, other: { runId: string }) {
  const e = evt;
  {
    const evt = other;
    void evt.runId;
  }
  return e.runId;
}`;
    const t = fnTouch(text, "f");
    // Two reads of runId, through two different bindings…
    expect([...t.receiverKeys.get("runId")!]).toHaveLength(2);
    // …`e` renames the PARAMETER `evt`, not the block's `evt` (the only `evt` read directly).
    const aliasKey = [...t.textKeys.get("e")!][0]!;
    const renamed = t.aliases.get(aliasKey);
    const innerEvt = [...t.textKeys.get("evt")!][0]!;
    expect(renamed).toMatch(/^evt@\d+$/);
    expect(renamed).not.toBe(innerEvt);
  });
});
