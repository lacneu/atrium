import { describe, expect, test } from "vitest";

import {
  addressedChain,
  MAX_ADDRESSED_AGENTS,
  reanchorAddressedAgents,
  rejectAgentMentions,
} from "./lib/agentMentions";
import { CHAIN_REPLIES_MAX_CHARS, composeChainedPrompt, REHYDRATION_STRINGS } from "./lib/rehydration";

// Addressing agents by "@Name": the span rules are the people's, applied to the
// UNION of both kinds; the chain's order is the text's.

const at = (text: string, token: string, from = 0) => {
  const start = text.indexOf(token, from);
  return { start, end: start + token.length };
};
const nova = { instanceName: "alpha", agentId: "nova" };
const bob = { instanceName: "alpha", agentId: "bob" };

describe("rejectAgentMentions", () => {
  test("accepts agents in text order, alongside people", () => {
    const text = "@Nova puis @Bob, cc @alice";
    expect(
      rejectAgentMentions(
        text,
        [
          { ...nova, ...at(text, "@Nova") },
          { ...bob, ...at(text, "@Bob") },
        ],
        [at(text, "@alice")],
      ),
    ).toBeNull();
  });

  test("the order IS the reply order: an out-of-order list is refused, not re-sequenced", () => {
    const text = "@Nova puis @Bob";
    expect(
      rejectAgentMentions(text, [
        { ...bob, ...at(text, "@Bob") },
        { ...nova, ...at(text, "@Nova") },
      ]),
    ).toBe("overlapping");
  });

  test("an agent span and a person span may not claim the same characters", () => {
    const text = "@Nova";
    expect(rejectAgentMentions(text, [{ ...nova, start: 0, end: 5 }], [{ start: 0, end: 5 }])).toBe(
      "overlapping",
    );
  });

  test("the span rules of a mention apply (an agent token starts with @)", () => {
    expect(rejectAgentMentions("Nova !", [{ ...nova, start: 0, end: 4 }])).toBe(
      "not_a_mention_token",
    );
    expect(rejectAgentMentions("@Nova", [{ ...nova, start: 0, end: 9 }])).toBe("out_of_bounds");
  });

  test("one agent once; at most MAX_ADDRESSED_AGENTS", () => {
    const text = "@Nova @Nova-2";
    expect(
      rejectAgentMentions(text, [
        { ...nova, ...at(text, "@Nova") },
        { ...nova, ...at(text, "@Nova-2") },
      ]),
    ).toBe("duplicate_agent");
    const many = Array.from({ length: MAX_ADDRESSED_AGENTS + 1 }, (_, i) => `@a${i}`).join(" ");
    const spans = Array.from({ length: MAX_ADDRESSED_AGENTS + 1 }, (_, i) => ({
      instanceName: "alpha",
      agentId: `a${i}`,
      ...at(many, `@a${i}`),
    }));
    expect(rejectAgentMentions(many, spans)).toBe("too_many_agents");
    expect(rejectAgentMentions(many, spans.slice(0, MAX_ADDRESSED_AGENTS))).toBeNull();
  });

  test("the chain is the agents, in the order given", () => {
    expect(addressedChain([{ ...nova, start: 0, end: 5 }, { ...bob, start: 6, end: 10 }])).toEqual([
      nova,
      bob,
    ]);
  });
});

describe("reanchorAddressedAgents — a queued message rewritten", () => {
  const before = "@Nova puis @Bob, cc @alice";
  const agents = [
    { ...nova, ...at(before, "@Nova") },
    { ...bob, ...at(before, "@Bob") },
  ];
  const people = [{ userId: "u-alice", ...at(before, "@alice") }];

  test("same agents, same order: spans follow the words; a person may be dropped", () => {
    const after = "Bon. @Nova puis @Bob.";
    const found = reanchorAddressedAgents(before, after, agents, people)!;
    expect(found.agents).toEqual([
      { ...nova, ...at(after, "@Nova") },
      { ...bob, ...at(after, "@Bob") },
    ]);
    expect(found.people).toEqual([]);
    expect(found.droppedPeople).toEqual(people);
  });

  test("an agent dropped, or the order changed: null (the chain would lie)", () => {
    expect(reanchorAddressedAgents(before, "@Nova seul", agents, people)).toBeNull();
    expect(reanchorAddressedAgents(before, "@Bob puis @Nova", agents, people)).toBeNull();
  });
});

describe("composeChainedPrompt", () => {
  const FR = REHYDRATION_STRINGS.fr;
  test("the question first, once; then the earlier replies, in order, signed", () => {
    expect(
      composeChainedPrompt("Q ?", [
        { agent: "Bob", text: "réponse B" },
        { agent: "Nova", text: "  " },
        { agent: "Nova", text: "réponse N" },
      ]),
    ).toBe(
      [
        "Q ?",
        "",
        FR.chainIntro,
        `${FR.assistantLabel} (Bob) : réponse B`,
        `${FR.assistantLabel} (Nova) : réponse N`,
        FR.chainOutro,
      ].join("\n"),
    );
  });

  test("no earlier reply with text: the bare question", () => {
    expect(composeChainedPrompt("Q ?", [])).toBe("Q ?");
    expect(composeChainedPrompt("Q ?", [{ agent: "Bob", text: "" }])).toBe("Q ?");
  });

  test("bounded: each reply keeps a share of the ceiling", () => {
    const long = "x".repeat(CHAIN_REPLIES_MAX_CHARS);
    const out = composeChainedPrompt("Q", [
      { agent: "A", text: long },
      { agent: "B", text: "court" },
    ]);
    expect(out).toContain(`${FR.assistantLabel} (B) : court`);
    // The whole block after the question is within the ceiling (pass 11), and the
    // reply cut to fit says so.
    expect(out.length - "Q\n\n".length).toBeLessThanOrEqual(CHAIN_REPLIES_MAX_CHARS);
    expect(out).toContain(FR.truncatedMark);
  });

  test("every reply over its share: the block after the question still fits the ceiling", () => {
    const long = "x".repeat(CHAIN_REPLIES_MAX_CHARS);
    const out = composeChainedPrompt("Q", [
      { agent: "A", text: long },
      { agent: "B", text: long },
      { agent: "C", text: long },
    ]);
    expect(out.length - "Q\n\n".length).toBeLessThanOrEqual(CHAIN_REPLIES_MAX_CHARS);
    expect(out.split(FR.truncatedMark).length - 1).toBe(3);
  });

  test("the framing follows the instance's content locale", () => {
    const EN = REHYDRATION_STRINGS.en;
    expect(composeChainedPrompt("Q", [{ agent: "Bob", text: "b" }], "en")).toContain(EN.chainIntro);
  });
});
