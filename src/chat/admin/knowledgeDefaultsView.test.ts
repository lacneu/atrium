// The admin card "Connaissances par agent" (knowledgeDefaultsView.ts, pure) and its wiring
// (KnowledgeDefaultsCard.tsx, comment-stripped source pins).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { m } from "@/paraglide/messages.js";
import {
  agentDefaultForm,
  baselineDiverged,
  draftOf,
  expectedOf,
  saveOutcomeText,
  toggleDraftSource,
  type AgentKnowledgeRow,
} from "./knowledgeDefaultsView";

const row = (over: Partial<AgentKnowledgeRow> = {}): AgentKnowledgeRow => ({
  agentId: "alice",
  available: true,
  reason: null,
  injection: "auto",
  defaultSources: ["graph", "docs"],
  overridesAllowed: true,
  sources: [
    { id: "graph", label: "Graphe", description: "" },
    { id: "docs", label: "Documents", description: "" },
    { id: "archive", label: "Archives", description: "" },
  ],
  defaultWriteRefused: null,
  ...over,
});

describe("the form", () => {
  test("starts from the stored default; saving needs a change and at least one allowed source", () => {
    const r = row();
    const draft = draftOf(r);
    expect(draft).toEqual({ injection: "auto", sources: ["graph", "docs"] });
    expect(agentDefaultForm(r, draft, true)).toMatchObject({ dirty: false, valid: true, readOnlyReason: null });
    const narrowed = toggleDraftSource(r, draft, "graph");
    expect(narrowed.sources).toEqual(["docs"]);
    expect(agentDefaultForm(r, narrowed, true).dirty).toBe(true);
    const empty = toggleDraftSource(r, narrowed, "docs");
    expect(agentDefaultForm(r, empty, true)).toMatchObject({
      valid: false,
      invalidReason: m.cdefaults_knowledge_pick_one(),
    });
    // Order follows the plugin's allowlist, not the click order.
    expect(toggleDraftSource(r, { injection: "auto", sources: ["docs"] }, "graph").sources).toEqual([
      "graph",
      "docs",
    ]);
  });

  test("read-only, with the reason: a bridge that cannot write it, a socket without admin scope", () => {
    expect(agentDefaultForm(row(), draftOf(row()), false).readOnlyReason).toBe(m.cdefaults_knowledge_unsupported());
    expect(
      agentDefaultForm(row({ defaultWriteRefused: "scope_refused" }), draftOf(row()), true).readOnlyReason,
    ).toBe(m.cdefaults_knowledge_readonly_scope());
  });

  test("a stored default naming a source no longer allowed never reaches the draft", () => {
    expect(draftOf(row({ defaultSources: ["gone", "docs"] })).sources).toEqual(["docs"]);
  });

  test("what the admin was shown travels whole: the effective default and the raw config view", () => {
    expect(expectedOf(row())).toEqual({ injection: "auto", defaultSources: ["graph", "docs"] });
    expect(expectedOf(row({ config: { injection: null, sources: ["graph", "x"] } }))).toEqual({
      injection: "auto",
      defaultSources: ["graph", "docs"],
      config: { injection: null, sources: ["graph", "x"] },
    });
  });

  // Codex pass 7: a change the EFFECTIVE default does not show still counts.
  test("the live row moved away from the one opened — raw change included", () => {
    const opened = row({ config: { injection: "auto", sources: ["graph", "docs"] } });
    expect(baselineDiverged(opened, opened)).toBe(false);
    // Same effective default, the raw config reordered / a disabled id added.
    expect(baselineDiverged(opened, row({ config: { injection: "auto", sources: ["docs", "graph"] } }))).toBe(true);
    expect(baselineDiverged(opened, row({ config: { injection: "auto", sources: ["graph", "docs", "x"] } }))).toBe(true);
    // The effective default changed.
    expect(baselineDiverged(opened, row({ injection: "tool", config: opened.config }))).toBe(true);
    // The raw view appeared or disappeared.
    expect(baselineDiverged(opened, row())).toBe(true);
  });

  // Codex pass 18: on openclaw-knowledge 4.0.x, an agent known to have no allowlist of
  // its own cannot have its default written from Atrium.
  test("4.0.x and no own allowlist: read-only, telling the admin to update the plugin", () => {
    const r = row({ contract: 1, ownAllowlist: false });
    expect(agentDefaultForm(r, draftOf(r), true).readOnlyReason).toBe(m.cdefaults_knowledge_plugin_too_old());
    // Contract 2, an own allowlist, or not known yet: editable (the bridge decides at the write).
    for (const over of [{ contract: 2, ownAllowlist: false }, { contract: 1, ownAllowlist: true }, { contract: 1, ownAllowlist: null }, {}]) {
      const x = row(over);
      expect(agentDefaultForm(x, draftOf(x), true).readOnlyReason).toBeNull();
    }
  });

  test("the save outcome, in the admin's words", () => {
    expect(saveOutcomeText({ ok: true })).toBeNull();
    expect(saveOutcomeText({ ok: false, code: "stale_default" })).toBe(m.cdefaults_knowledge_stale());
    expect(saveOutcomeText({ ok: false, code: "scope_refused" })).toBe(m.cdefaults_knowledge_readonly_scope());
    expect(saveOutcomeText({ ok: false, code: "knowledge_unavailable", reason: "plugin_absent" })).toBe(
      m.cdefaults_knowledge_absent(),
    );
    expect(saveOutcomeText({ ok: false, code: "write_unknown" })).toBe(m.cdefaults_knowledge_unknown());
    expect(saveOutcomeText({ ok: false, code: "not_applied" })).toBe(m.cdefaults_knowledge_not_applied());
    expect(saveOutcomeText({ ok: false, code: "default_too_large" })).toBe(m.cdefaults_knowledge_too_large());
    expect(saveOutcomeText({ ok: false, code: "allowlist_too_large" })).toBe(m.cdefaults_knowledge_allowlist_too_large());
    expect(saveOutcomeText({ ok: false, code: "plugin_too_old" })).toBe(m.cdefaults_knowledge_plugin_too_old());
    expect(saveOutcomeText({ ok: false, code: "source_not_allowed" })).toBe(m.cdefaults_knowledge_source_not_allowed());
    expect(saveOutcomeText({ ok: false, code: "plugin_config_lag" })).toBe(m.cdefaults_knowledge_config_lag());
    expect(saveOutcomeText({ ok: false, code: "not_confirmed" })).toBe(m.cdefaults_knowledge_unknown());
    expect(saveOutcomeText({ ok: false, code: "config_rejected" })).toBe(
      m.cdefaults_knowledge_error({ code: "config_rejected" }),
    );
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));

describe("the card's wiring", () => {
  const CARD = read("src/chat/admin/KnowledgeDefaultsCard.tsx");
  const TAB = read("src/chat/admin/ChatDefaultsTab.tsx");
  test("lives in the chat-defaults tab, per selected instance", () => {
    expect(TAB).toMatch(/<KnowledgeDefaultsCard instanceName=\{inst\.name\} \/>/);
  });
  test("writes through the admin action with the default the admin was shown", () => {
    expect(CARD).toMatch(/useAction\(api\.knowledge\.setAgentKnowledgeDefault\)/);
    // Checked against the row AS OPENED, never the live one…
    expect(CARD).toMatch(/expected: expectedOf\(base\)/);
    expect(CARD).not.toMatch(/expected: expectedOf\(row\)/);
    // …which is adopted only by an explicit reload (or our own confirmed save), and a
    // divergence is announced with that reload.
    expect(CARD).toMatch(/const diverged = baselineDiverged\(base, row\)/);
    expect(CARD).toMatch(/onClick=\{\(\) => reload\(row\)\}/);
    expect(CARD).not.toMatch(/storedKey/);
  });
  test("offers only the plugin's sources, and nothing on Hermes or without the plugin", () => {
    expect(CARD).toMatch(/row\.sources\.map\(\(s\) =>/);
    expect(CARD).toMatch(/data\.provider !== "openclaw"/);
    expect(CARD).toMatch(/if \(withPlugin\.length === 0 && status !== "CanLoadMore"\) return null;/);
    expect(CARD).toMatch(/disabled=\{!editable\}/);
  });
  // Codex pass 22: the list is PAGED — every agent reachable, and the card says so.
  test("pages the agents: says more remain and loads them on demand — no hidden truncation", () => {
    expect(CARD).toMatch(/usePaginatedQuery\(\s*api\.knowledge\.agentKnowledgePage/);
    expect(CARD).toMatch(/status === "CanLoadMore" \|\| status === "LoadingMore"/);
    expect(CARD).toMatch(/m\.cdefaults_knowledge_more_agents\(\{ shown: withPlugin\.length \}\)/);
    expect(CARD).toMatch(/onClick=\{\(\) => loadMore\(KNOWLEDGE_ADMIN_PAGE\)\}/);
    expect(CARD).not.toMatch(/agentKnowledgeForInstance/);
  });
});
