// THE PRIMARY AGENT is chosen in the conversation panel, and marked with a crown.
//
// The composer used to REBIND an empty conversation when an agent was picked in it,
// so the same click meant "the next message" on one chat and "the conversation's
// agent" on another. It now only ever ADDRESSES an agent in the next message (its
// "@Name" token — there is no hidden selection any more); the primary
// changes in the conversation panel, from a room agent's own menu, for the owner.
// These are React wiring decisions with no pure function to call, so what is pinned
// is the wiring itself, comment-stripped (commenting a call out is exactly how it
// would come back or disappear).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));
const CHAT = read("src/chat/ConvexChat.tsx");
const PANEL = read("src/chat/ConversationPanel.tsx");

/** The body of the composer's agent control. */
function composerSelect(): string {
  const start = CHAT.indexOf("function ComposerAgentSelect(");
  expect(start, "ComposerAgentSelect moved").toBeGreaterThan(-1);
  const end = CHAT.indexOf("\nfunction ", start + 1);
  return CHAT.slice(start, end === -1 ? undefined : end);
}

describe("the composer never changes the conversation's primary", () => {
  test("no rebind, no primary mutation, anywhere in the chat view", () => {
    expect(CHAT.includes("rebindChatAgent")).toBe(false);
    expect(CHAT.includes("setPrimaryAgent")).toBe(false);
  });

  test("a pick mentions the agent in the message — and nothing else", () => {
    const body = composerSelect();
    expect(body).toMatch(
      /const address = \(a: AgentRef & \{ displayName: string \| null \}\) => \{\s*const next = nameAgentInComposer\(\s*String\(chatId\),\s*composer\.getState\(\)\.text,\s*\{ instanceName: a\.instanceName, agentId: a\.agentId \},\s*mentionTokenFor\(a\.displayName \?\? a\.agentId\),\s*\);\s*if \(next !== null\) composer\.setText\(next\);\s*\};/,
    );
    // The room rows call it; no selection state survives anywhere.
    expect(body).toMatch(/onClick=\{\(\) => \{\s*address\(a\);/);
    expect(CHAT).not.toMatch(/setSelected|routing\??\.selected\b/);
  });

  test("the primary is crowned in the composer's list, with its explanation", () => {
    const body = composerSelect();
    expect(body).toMatch(
      /<Crown\s+size=\{12\}\s+className="oc-agentrow__primary"\s+aria-label=\{m\.conversation_primary_title\(\)\}/,
    );
    expect(CHAT).not.toMatch(/<Star\b/);
  });
});

describe("the conversation panel is where the primary changes", () => {
  test("a room agent's menu offers it — to the owner, for an agent that can answer", () => {
    expect(PANEL).toMatch(/useMutation\(api\.chatAgents\.setPrimaryAgent\)/);
    expect(PANEL).toMatch(
      /\{isOwner && a\.usable && !a\.gone \? \(\s*<DropdownMenuItem onSelect=\{\(\) => makePrimary\(a\)\}>/,
    );
  });

  test("the primary is crowned in the agents tab and on the presence strip", () => {
    expect(PANEL).toMatch(
      /\{primary \? \(\s*<Crown\s+size=\{12\}\s+className="oc-convpanel__crown"\s+aria-label=\{m\.conversation_primary_title\(\)\}/,
    );
    expect(PANEL).toMatch(
      /\{f\.primary \? \(\s*<Crown size=\{8\} className="oc-presence__crown" aria-hidden \/>/,
    );
  });
});
