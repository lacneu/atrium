// THE COMPOSER "+" MENU — its "Connaissances" section (knowledgeView.ts, pure) and its
// React wiring (ComposerAddMenu.tsx, pinned on the comment-stripped source: commenting a
// guard out is exactly how it would disappear).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { m } from "@/paraglide/messages.js";
import { IMAGE_PICKER_ACCEPT } from "./attachmentAdapter";
import {
  knowledgeReasonText,
  knowledgeView,
  settlePending,
  knowledgeTargetKey,
  pendingChoiceFor,
  pendingOnDone,
  pendingOnPick,
  pendingOnServer,
  toggledChoice,
  withPending,
  type KnowledgeControlData,
} from "./knowledgeView";

const base = (over: Partial<KnowledgeControlData> = {}): KnowledgeControlData => ({
  target: { instanceName: "olivier", agentId: "alice" },
  provider: "openclaw",
  viewerRole: "owner",
  supported: true,
  facts: {
    available: true,
    reason: null,
    injection: "auto",
    defaultSources: ["graph", "docs"],
    overridesAllowed: true,
    sources: [
      { id: "graph", label: "Graphe", description: "Le graphe" },
      { id: "docs", label: "Documents", description: "" },
      { id: "archive", label: "Archives", description: "" },
    ],
  },
  choice: null,
  apply: null,
  ...over,
});

describe("feature detection: shown only where it can work", () => {
  test("hidden without data, on Hermes, on a bridge that cannot apply it, without the plugin", () => {
    expect(knowledgeView(undefined).hidden).toBe(true);
    expect(knowledgeView(null).hidden).toBe(true);
    expect(knowledgeView(base({ provider: "hermes" })).hidden).toBe(true);
    expect(knowledgeView(base({ supported: false })).hidden).toBe(true);
    expect(knowledgeView(base({ facts: null })).hidden).toBe(true);
    expect(
      knowledgeView(base({ facts: { ...base().facts!, available: false, reason: "plugin_absent" } })).hidden,
    ).toBe(true);
    expect(knowledgeView(base({ facts: { ...base().facts!, sources: [] } })).hidden).toBe(true);
    expect(knowledgeView(base()).hidden).toBe(false);
  });
});

describe("what the section shows", () => {
  test("nobody chose: the agent's default, said as such, no reset offered", () => {
    const v = knowledgeView(base());
    expect(v.items.map((i) => [i.id, i.checked])).toEqual([
      ["graph", true],
      ["docs", true],
      ["archive", false],
    ]);
    expect(v.origin).toBe("agent");
    expect(v.originLabel).toBe(m.chat_knowledge_origin_agent());
    expect(v.canReset).toBe(false);
    expect(v.readOnlyReason).toBeNull();
  });

  test("a conversation choice: its selection, its origin, and the way back", () => {
    const v = knowledgeView(base({ choice: { kind: "sources", sources: ["archive"] } }));
    expect(v.items.filter((i) => i.checked).map((i) => i.id)).toEqual(["archive"]);
    expect(v.origin).toBe("conversation");
    expect(v.canReset).toBe(true);
    const off = knowledgeView(base({ choice: { kind: "off" } }));
    expect(off.items.every((i) => !i.checked)).toBe(true);
    expect(off.allOff).toBe(true);
    // "default" stored = back on the agent's default.
    expect(knowledgeView(base({ choice: { kind: "default" } })).origin).toBe("agent");
  });

  test("ticked sources over an agent default that is off: searched, and said so (codex pass 13)", () => {
    const facts = { ...base().facts!, injection: "off" };
    const v = knowledgeView(base({ facts, choice: { kind: "sources", sources: ["docs"] } }));
    expect(v.items.filter((i) => i.checked).map((i) => i.id)).toEqual(["docs"]);
    expect(v.originLabel).toBe(m.chat_knowledge_origin_conversation_over_off());
    // An active default, or an `off` choice: the plain wording.
    expect(knowledgeView(base({ choice: { kind: "sources", sources: ["docs"] } })).originLabel).toBe(
      m.chat_knowledge_origin_conversation(),
    );
    expect(knowledgeView(base({ facts, choice: { kind: "off" } })).originLabel).toBe(
      m.chat_knowledge_origin_conversation(),
    );
  });

  test("the operator clamped a chosen source: said by name, shown unticked and unavailable (codex pass 15)", () => {
    const choice = { kind: "sources" as const, sources: ["graph", "docs"] };
    const v = knowledgeView(base({ choice, apply: { status: "clamped", dropped: ["graph"] } }));
    expect(v.status).toBe(m.chat_knowledge_clamped_one({ source: base().facts!.sources[0]!.label }));
    expect(v.statusIsError).toBe(false);
    const graph = v.items.find((i) => i.id === "graph")!;
    expect(graph).toMatchObject({ checked: false, unavailable: true });
    expect(v.items.find((i) => i.id === "docs")).toMatchObject({ checked: true, unavailable: false });
    // Several, and an id the plugin no longer lists at all: named by its id.
    const many = knowledgeView(base({ choice: { kind: "sources", sources: ["graph", "gone"] }, apply: { status: "clamped", dropped: ["graph", "gone"] } }));
    expect(many.status).toBe(m.chat_knowledge_clamped_many({ sources: `${base().facts!.sources[0]!.label}, gone` }));
    // Any other outcome: nothing is marked unavailable.
    expect(knowledgeView(base({ choice, apply: { status: "applied", dropped: ["graph"] } })).items.every((i) => !i.unavailable)).toBe(true);
  });

  test("every source removed by the operator: the section stays while a choice stands, with its way back (codex pass 17)", () => {
    const facts = { ...base().facts!, sources: [] };
    for (const choice of [{ kind: "off" as const }, { kind: "sources" as const, sources: ["graph"] }]) {
      const v = knowledgeView(base({ facts, choice }));
      expect(v.hidden).toBe(false);
      expect(v.items).toEqual([]);
      expect(v.canReset).toBe(true);
      expect(v.emptyNote).toBe(m.chat_knowledge_no_sources());
    }
    // No choice (or `default`): nothing to offer, nothing to go back from.
    expect(knowledgeView(base({ facts })).hidden).toBe(true);
    expect(knowledgeView(base({ facts, choice: { kind: "default" } })).hidden).toBe(true);
    // Sources listed: no note.
    expect(knowledgeView(base({ choice: { kind: "off" } })).emptyNote).toBeNull();
  });

  test("a participant sees, read-only, with the reason; so does an owner the operator forbids", () => {
    const p = knowledgeView(base({ viewerRole: "participant", choice: { kind: "off" } }));
    expect(p.readOnlyReason).toBe(m.chat_knowledge_readonly_participant());
    expect(p.canReset).toBe(false);
    const o = knowledgeView(base({ facts: { ...base().facts!, overridesAllowed: false } }));
    expect(o.readOnlyReason).toBe(m.chat_knowledge_readonly_overrides());
    // …the sources are locked, but the way back stays open over a standing choice: it
    // only removes Atrium's choice, and it is the owner's way out (decided 2026-09-28).
    const locked = knowledgeView(
      base({
        choice: { kind: "off" },
        facts: { ...base().facts!, overridesAllowed: false },
        apply: { status: "failed", reason: "overrides_disabled" },
      }),
    );
    expect(locked.readOnlyReason).toBe(m.chat_knowledge_readonly_overrides());
    expect(locked.canReset).toBe(true);
    // The withheld choice says where the way out is.
    expect(locked.status).toBe(
      m.chat_knowledge_failed({ reason: m.chat_knowledge_reason_overrides_disabled() }),
    );
    expect(m.chat_knowledge_reason_overrides_disabled()).toMatch(/revenez au défaut|go back to the default/);
  });

  test("the apply outcome is said: pending, deferred, failed with its reason", () => {
    const at = (status: string, reason?: string) =>
      knowledgeView(base({ choice: { kind: "off" }, apply: { status, ...(reason ? { reason } : {}) } }));
    expect(at("pending").status).toBe(m.chat_knowledge_pending());
    expect(at("deferred").status).toBe(m.chat_knowledge_deferred());
    const failed = at("failed", "plugin_absent");
    expect(failed.statusIsError).toBe(true);
    expect(failed.status).toBe(m.chat_knowledge_failed({ reason: m.chat_knowledge_reason_plugin_absent() }));
    expect(at("applied").status).toBeNull();
    expect(knowledgeReasonText("brand_new")).toBe(m.chat_knowledge_reason_other());
  });
});

describe("a toggle's next choice", () => {
  test("from the default: removing one keeps the rest, in the plugin's order", () => {
    expect(toggledChoice(base(), "graph")).toEqual({ kind: "sources", sources: ["docs"] });
    expect(toggledChoice(base(), "archive")).toEqual({ kind: "sources", sources: ["graph", "docs", "archive"] });
  });

  test("every source off is `off` (a selection needs at least one source)", () => {
    const one = base({ choice: { kind: "sources", sources: ["docs"] } });
    expect(toggledChoice(one, "docs")).toEqual({ kind: "off" });
  });

  test("from off: the source alone", () => {
    expect(toggledChoice(base({ choice: { kind: "off" } }), "archive")).toEqual({
      kind: "sources",
      sources: ["archive"],
    });
  });

  test("over an agent whose default injection is off, a selection turns retrieval on", () => {
    const off = base({ facts: { ...base().facts!, injection: "off" } });
    expect(toggledChoice(off, "docs")).toEqual({ kind: "sources", sources: ["docs"], injection: "auto" });
  });

  test("never an id the plugin does not list", () => {
    const stale = base({ choice: { kind: "sources", sources: ["gone", "docs"] } });
    expect(toggledChoice(stale, "graph")).toEqual({ kind: "sources", sources: ["graph", "docs"] });
  });
});

// Codex P2: two toggles faster than the server's answer.
describe("quick toggles start from the owner's latest choice, not the stale server state", () => {
  test("graph+docs, untick graph, untick docs before the server answers: off", () => {
    const server = base(); // default: graph + docs
    const first = toggledChoice(withPending(server, null), "graph");
    expect(first).toEqual({ kind: "sources", sources: ["docs"] });
    // The server still says graph+docs; the second toggle starts from the pending choice.
    const second = toggledChoice(withPending(server, first), "docs");
    expect(second).toEqual({ kind: "off" });
    // …and the section shows the pending choice at once.
    expect(knowledgeView(withPending(server, second)).allOff).toBe(true);
  });

  test("the pending choice is dropped only once the server shows it and nothing is in flight", () => {
    const off = { kind: "off" } as const;
    expect(settlePending(null, off, 1)).toEqual(off);
    expect(settlePending({ kind: "sources", sources: ["docs"] }, off, 0)).toEqual(off);
    expect(settlePending(off, off, 1)).toEqual(off);
    expect(settlePending(off, off, 0)).toBeNull();
    expect(
      settlePending({ kind: "sources", sources: ["docs", "graph"] }, { kind: "sources", sources: ["graph", "docs"] }, 0),
    ).toBeNull();
  });
});

// --- The React wiring -----------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));
const MENU = read("src/chat/ComposerAddMenu.tsx");
const CHAT = read("src/chat/ConvexChat.tsx");

describe("the '+' is a menu", () => {
  test("the composer renders it in place of the bare attach button, scoped to the next target", () => {
    expect(CHAT).not.toMatch(/<ComposerPrimitive\.AddAttachment/);
    const at = CHAT.indexOf("<ComposerAddMenu");
    expect(at).toBeGreaterThan(-1);
    const props = CHAT.slice(at, at + 500);
    expect(props).toMatch(/routedAgent=\{\s*composerTarget/);
    expect(props).toMatch(/attachmentsSupported=\{attachmentsSupported\}/);
    expect(props).toMatch(/attachDisabled=\{queued \|\| unavailable\}/);
  });

  test("a file and an image go through the composer's own pipeline (the adapter's limits)", () => {
    expect(MENU).toMatch(/composer\.addAttachment\(file\)/);
    expect(MENU).toMatch(/accept=\{IMAGE_ACCEPT\}/);
    expect(MENU).toMatch(/IMAGE_PICKER_ACCEPT as IMAGE_ACCEPT/);
    expect(IMAGE_PICKER_ACCEPT).toBe("image/" + "*");
    // Both items are disabled exactly when the old button was.
    expect([...MENU.matchAll(/disabled=\{attachDisabled\}/g)]).toHaveLength(2);
  });

  test("a toggle goes through the view's rule and the owner-only mutation; read-only is enforced in the DOM", () => {
    expect(MENU).toMatch(/useMutation\(api\.knowledge\.setKnowledgeChoice\)/);
    // Every toggle starts from the pending local choice (quick toggles, codex P2)…
    expect(MENU).toMatch(/if \(editable && !item\.unavailable\) \{\s*pick\(toggledChoice\(withPending\(control, pendingChoice\), item\.id\)\)/);
    // …which a pick sets at once, the section renders, and the server's answer settles.
    // Keyed per target (codex pass 12): the pick, each mutation's own settlement, the
    // shown target's reconciliation, and the shown target's own entry.
    expect(MENU).toMatch(/setPending\(\(cur\) => pendingOnPick\(cur, key, choice, gen\)\)/);
    expect(MENU).toMatch(/pendingOnDone\(cur, key, gen, true, visibleKey\.current\)/);
    expect(MENU).toMatch(/pendingOnDone\(cur, key, gen, false, visibleKey\.current\)/);
    expect(MENU).toMatch(/pendingOnServer\(cur, targetKey, serverChoice\)/);
    expect(MENU).toMatch(/const pendingChoice = pendingChoiceFor\(pending, targetKey\);/);
    expect(MENU).not.toMatch(/setPending\(null\)/);
    expect(MENU).toMatch(/knowledgeView\(shown\)/);
    // The empty-list note, when every source was removed (codex pass 17).
    expect(MENU).toMatch(/view\.emptyNote !== null \? <p className="oc-perm__note">\{view\.emptyNote\}<\/p>/);
    // …a source the operator took out of the allowlist is not selectable (codex pass 15).
    expect(MENU).toMatch(/disabled=\{!editable \|\| item\.unavailable\}/);
    expect(MENU).toMatch(/role="menuitemcheckbox"/);
    expect(MENU).toMatch(/onSelect=\{\(\) => pick\(\{ kind: "default" \}\)\}/);
  });

  test("nothing at all when there is neither an attachment, a knowledge section nor a widget switch to offer", () => {
    expect(MENU).toMatch(/if \(!attachmentsSupported && view\.hidden && !widgets\.offered\) return null;/);
  });
});

// Codex pass 12: one pending entry per target agent (a per-turn chat moves between them).
describe("pending choices are kept per target agent", () => {
  const A = knowledgeTargetKey({ instanceName: "alpha", agentId: "alice" });
  const B = knowledgeTargetKey({ instanceName: "alpha", agentId: "bob" });
  const graphOnly = { kind: "sources" as const, sources: ["graph"] };
  const docsOnly = { kind: "sources" as const, sources: ["docs"] };

  test("A → B → A before the server answers: A's choice is still there, and the next click starts from it", () => {
    let m = pendingOnPick({}, A, graphOnly, 1);
    m = pendingOnPick(m, B, docsOnly, 1);
    // Back on A: the section shows A's pending pick, not the stale server selection.
    expect(pendingChoiceFor(m, A)).toEqual(graphOnly);
    const server = base();
    const next = toggledChoice(withPending(server, pendingChoiceFor(m, A)), "docs");
    expect(next).toEqual({ kind: "sources", sources: ["graph", "docs"] });
  });

  test("a failed mutation for A clears A only — never B's pending choice", () => {
    let m = pendingOnPick({}, A, graphOnly, 1);
    m = pendingOnPick(m, B, docsOnly, 1);
    m = pendingOnDone(m, A, 1, false, B);
    expect(pendingChoiceFor(m, A)).toBeNull();
    expect(pendingChoiceFor(m, B)).toEqual(docsOnly);
  });

  test("an OLDER pick's refusal leaves the newer one pending", () => {
    let m = pendingOnPick({}, A, graphOnly, 1);
    m = pendingOnPick(m, A, docsOnly, 2);
    m = pendingOnDone(m, A, 1, false, A);
    expect(pendingChoiceFor(m, A)).toEqual(docsOnly);
    expect(m[A]?.inFlight).toBe(1);
  });

  test("settled: a target not shown is dropped (re-read when shown); the shown one waits for the server", () => {
    let m = pendingOnPick({}, A, graphOnly, 1);
    m = pendingOnPick(m, B, docsOnly, 1);
    m = pendingOnDone(m, A, 1, true, B);
    expect(pendingChoiceFor(m, A)).toBeNull();
    m = pendingOnDone(m, B, 1, true, B);
    expect(pendingChoiceFor(m, B)).toEqual(docsOnly);
    // The server does not show it yet: kept (same map, so the effect does not loop).
    expect(pendingOnServer(m, B, null)).toBe(m);
    expect(pendingChoiceFor(pendingOnServer(m, B, docsOnly), B)).toBeNull();
    // …never while a mutation of it is in flight.
    const flying = pendingOnPick({}, B, docsOnly, 1);
    expect(pendingOnServer(flying, B, docsOnly)).toBe(flying);
  });
});

