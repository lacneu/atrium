// The admin card "Raisonnement" (reasoningDefaultsView.ts, pure): the instance's default and
// the agents that are exceptions to it — which rows the card lists, what it offers to add,
// the value a new exception starts with, the filter, the order and the keyboard moves. Plus
// the per-conversation knob's provenance wording (sessionKnobs.ts `reasoningProvenance`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { m } from "@/paraglide/messages.js";
import { reasoningProvenance } from "../sessionKnobs";
import {
  activeCandidateIndex,
  addCandidates,
  agentName,
  compareAgents,
  enterPick,
  EXCEPTION_FILTER_THRESHOLD,
  exceptionFilterShown,
  exceptionsOf,
  foldForSearch,
  matchesAgent,
  newExceptionValue,
  nextActiveIndex,
  showsAgentId,
  visibleExceptions,
  type ReasoningAgentRow,
} from "./reasoningDefaultsView";

const agent = (agentId: string, over: Partial<ReasoningAgentRow> = {}): ReasoningAgentRow => ({
  agentId,
  displayName: null,
  enabled: true,
  showReasoningDefault: null,
  ...over,
});
const ids = (rows: Array<{ agentId: string } | { agent: { agentId: string } }>) =>
  rows.map((r) => ("agent" in r ? r.agent.agentId : r.agentId));

describe("the exceptions the card lists", () => {
  const agents = [
    agent("agent-10", { showReasoningDefault: true }),
    agent("agent-2", { showReasoningDefault: false }),
    agent("agent-3"),
    agent("zoe", { displayName: "Zoé", showReasoningDefault: true }),
  ];

  test("only the agents with an exception, in natural order, each with its value", () => {
    const rows = exceptionsOf(agents, false);
    expect(ids(rows)).toEqual(["agent-2", "agent-10", "zoe"]);
    expect(rows.map((r) => r.show)).toEqual([false, true, true]);
  });

  test("an exception equal to the instance's default is flagged, and kept", () => {
    expect(exceptionsOf(agents, false).map((r) => [r.agent.agentId, r.sameAsDefault])).toEqual([
      ["agent-2", true],
      ["agent-10", false],
      ["zoe", false],
    ]);
    expect(exceptionsOf(agents, true).map((r) => r.sameAsDefault)).toEqual([false, true, true]);
  });

  test("the filter appears beyond the threshold, and filters by name or id, accents and case aside", () => {
    expect(EXCEPTION_FILTER_THRESHOLD).toBe(8);
    expect(exceptionFilterShown(8)).toBe(false);
    expect(exceptionFilterShown(9)).toBe(true);
    const few = exceptionsOf(agents, false);
    // Below the threshold there is no field: a stale filter never hides a row.
    expect(ids(visibleExceptions(few, "zz"))).toEqual(ids(few));
    const many = exceptionsOf(
      [...Array.from({ length: 9 }, (_, i) => agent(`a-${i}`, { showReasoningDefault: true })), agent("zoe", { displayName: "Zoé", showReasoningDefault: false })],
      false,
    );
    expect(ids(visibleExceptions(many, "ZOE"))).toEqual(["zoe"]);
    expect(ids(visibleExceptions(many, "  zoé "))).toEqual(["zoe"]);
    expect(ids(visibleExceptions(many, "a-1"))).toEqual(["a-1"]);
    expect(visibleExceptions(many, "")).toHaveLength(10);
  });
});

describe("what \"Ajouter une exception\" offers", () => {
  const agents = [
    agent("bob", { showReasoningDefault: true }),
    agent("agent-10"),
    agent("agent-9", { enabled: false }),
    agent("agent-2"),
    agent("gone", { presentInLastOk: false }),
    agent("helene", { displayName: "Hélène" }),
    agent("agent-1", { enabled: false }),
  ];

  test("only agents WITHOUT an exception, never one gone from the gateway", () => {
    const offered = ids(addCandidates(agents, ""));
    expect(offered).not.toContain("bob");
    expect(offered).not.toContain("gone");
  });

  test("enabled agents first, then disabled ones, each in natural order", () => {
    expect(ids(addCandidates(agents, ""))).toEqual(["agent-2", "agent-10", "helene", "agent-1", "agent-9"]);
  });

  test("searched by name or id, accents and case aside", () => {
    expect(ids(addCandidates(agents, "HELENE"))).toEqual(["helene"]);
    expect(ids(addCandidates(agents, "hél"))).toEqual(["helene"]);
    expect(ids(addCandidates(agents, "agent-1"))).toEqual(["agent-10", "agent-1"]);
    expect(addCandidates(agents, "nobody")).toEqual([]);
  });

  test("everything excepted: nothing left to offer", () => {
    expect(addCandidates([agent("a", { showReasoningDefault: false })], "")).toEqual([]);
  });

  test("a new exception starts OPPOSITE to the instance's default", () => {
    expect(newExceptionValue(false)).toBe(true);
    expect(newExceptionValue(true)).toBe(false);
  });

  test("120 agents: the search narrows at once, in natural order", () => {
    const many = Array.from({ length: 120 }, (_, i) => agent(`agent-${i + 1}`, { displayName: `Agent ${i + 1}` }));
    expect(addCandidates(many, "")).toHaveLength(120);
    expect(ids(addCandidates(many, "agent 11"))).toEqual(["agent-11", "agent-110", "agent-111", "agent-112", "agent-113", "agent-114", "agent-115", "agent-116", "agent-117", "agent-118", "agent-119"]);
  });
});

describe("names, search key, order", () => {
  test("the id is shown only when it tells the agent apart", () => {
    expect(agentName(agent("bob"))).toBe("bob");
    expect(showsAgentId(agent("bob"))).toBe(false);
    expect(showsAgentId(agent("bob", { displayName: "Bob" }))).toBe(false);
    expect(showsAgentId(agent("bob", { displayName: "Robert" }))).toBe(true);
  });

  test("the search key folds accents and case", () => {
    expect(foldForSearch("  Éléonore ")).toBe("eleonore");
    expect(matchesAgent(agent("x", { displayName: "Éléonore" }), "ELEO")).toBe(true);
    expect(matchesAgent(agent("x-éa"), "XEA")).toBe(false);
  });

  test("natural order, the id breaking a tie of names", () => {
    const rows = [agent("b", { displayName: "Same" }), agent("a", { displayName: "Same" }), agent("n-10"), agent("n-9")];
    expect([...rows].sort(compareAgents).map((r) => r.agentId)).toEqual(["n-9", "n-10", "a", "b"]);
  });
});

describe("the keyboard in the list", () => {
  test("arrows, Home, End, clamped; nothing to move in an empty list", () => {
    expect(nextActiveIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextActiveIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextActiveIndex(-1, "ArrowUp", 3)).toBe(0);
    expect(nextActiveIndex(2, "ArrowUp", 3)).toBe(1);
    expect(nextActiveIndex(1, "Home", 3)).toBe(0);
    expect(nextActiveIndex(0, "End", 3)).toBe(2);
    expect(nextActiveIndex(5, "x", 3)).toBe(2);
    expect(nextActiveIndex(1, "ArrowDown", 0)).toBe(-1);
  });

  // Codex pass 4: the list is recomputed while it is open (a save lands). The choice follows
  // the AGENT, never its position, and a chosen agent that left the list adds nothing.
  test("a save landing while the list is open never moves the choice to another agent", () => {
    const before = addCandidates([agent("a"), agent("b"), agent("c")], "");
    expect(ids(before)).toEqual(["a", "b", "c"]);
    const chosen = before[1]!.agentId;
    // `a` became an exception meanwhile: the list is now b, c.
    const after = addCandidates([agent("a", { showReasoningDefault: true }), agent("b"), agent("c")], "");
    expect(activeCandidateIndex(after, chosen)).toBe(0);
    expect(enterPick(after, chosen)?.agentId).toBe("b");
    // `b` itself became one: the choice is gone, Enter adds nothing (not `c`).
    const gone = addCandidates([agent("a", { showReasoningDefault: true }), agent("b", { showReasoningDefault: false }), agent("c")], "");
    expect(activeCandidateIndex(gone, chosen)).toBe(-1);
    expect(enterPick(gone, chosen)).toBeNull();
    // Nothing chosen: Enter takes the first match, as typing then Enter does.
    expect(enterPick(gone, null)?.agentId).toBe("c");
    expect(enterPick([], null)).toBeNull();
  });
});

describe("the conversation's knob says where its default comes from", () => {
  test("the agent's exception, the instance's default, or the generic wording", () => {
    expect(reasoningProvenance("agent", true)).toEqual({
      inheritedLabel: m.conf_reasoning_inherited_agent(),
      resetLabel: m.conf_reasoning_reset_agent({ value: m.conf_reasoning_display_on() }),
    });
    expect(reasoningProvenance("instance", false)).toEqual({
      inheritedLabel: m.conf_reasoning_inherited_instance(),
      resetLabel: m.conf_reasoning_reset_instance({ value: m.conf_reasoning_display_off() }),
    });
    expect(reasoningProvenance("none", false)).toEqual({});
    expect(reasoningProvenance(undefined, false)).toEqual({});
  });
});

describe("the card's wiring (comment-stripped source pins)", () => {
  const src = readFileSync(join(__dirname, "ReasoningDefaultsCard.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("a pick creates the exception with the opposite value; ↺ sends null", () => {
    expect(src).toContain("const show = newExceptionValue(instanceDefault);");
    expect(src).toMatch(/saveAgent\(a, null,/);
  });

  test("the keyboard's choice is an agent id, never a position in the recomputed list", () => {
    expect(src).toContain("useState<string | null>(null)");
    expect(src).toContain("activeCandidateIndex(candidates, activeId)");
    expect(src).toContain("enterPick(candidates, activeId)");
    expect(src).not.toMatch(/candidates\[active/);
  });

  test("the offer and the list come from the view module, never rebuilt in the card", () => {
    expect(src).toContain("addCandidates(agents, query)");
    expect(src).toContain("exceptionsOf(agents, instanceDefault)");
    expect(src).not.toMatch(/showReasoningDefault\s*===\s*null/);
  });

  test("accessible: a labelled switch, a combobox driving a listbox, an alert on failure, a polite announcement", () => {
    expect(src).toMatch(/<label htmlFor=\{switchId\}/);
    expect(src).toContain('role="combobox"');
    expect(src).toContain('role="listbox"');
    expect(src).toContain('role="option"');
    expect(src).toContain("aria-activedescendant=");
    expect(src).toContain('role="alert"');
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain("m.cdefaults_reasoning_remove_aria({ agent: name })");
  });
});
