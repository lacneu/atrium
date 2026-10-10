// ADDRESSING BY @MENTION in a room of several agents — the composer's half.
//
// The agents a message is for are the agents it mentions (each answers in turn,
// in text order); none mentioned = the primary. There is no hidden selection. The
// decisions are pure helpers (perTurnAgent.resolveTurnRoute, pendingMention); what
// is pinned here is the React wiring that no runtime test in this repo reaches (no
// DOM runner), on COMMENT-STRIPPED source so prose cannot satisfy a guard.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { m } from "@/paraglide/messages.js";
import { agentAddressFailure, commandWithFilesRefused } from "./useConvexChatRuntime";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));
const RUNTIME = read("src/chat/useConvexChatRuntime.ts");
const CHAT = read("src/chat/ConvexChat.tsx");

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `missing ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a);
  expect(b, `missing ${to} after ${from}`).toBeGreaterThan(-1);
  return src.slice(a, b);
}

describe("a send is addressed by what its text mentions", () => {
  test("BOTH send paths carry the agents the text mentions — and nothing else routes", () => {
    const onNew = slice(RUNTIME, "onNew: async", "const queueSend");
    const queueSend = slice(RUNTIME, "const queueSend", "\n  );");
    for (const body of [onNew, queueSend]) {
      expect(body).toMatch(
        /const \{\s*staged: stagedMentions,\s*mentions: resolved,\s*agentMentions,\s*\} = takeMentionsForSend\(chatId, text\);/,
      );
      expect(body).toMatch(/const address = computeTurnAddress\(agentMentions\);/);
      expect(body).toMatch(/\.\.\.address,/);
      // No other route: the hidden selection is gone.
      expect(body).not.toMatch(/routedAgent\s*\?/);
    }
  });

  test("the address: the mentions when there are any, else the primary's route", () => {
    const fn = slice(RUNTIME, "const computeTurnAddress = useCallback(", "\n    [],\n  );");
    expect(fn).toMatch(/if \(agentMentions\.length > 0 && r\.canRoute\) \{\s*return \{\s*agentMentions:/);
    expect(fn).toMatch(/resolveTurnRoute\(\{\s*mentioned: \[\],\s*primary: r\.primary,/);
  });

  test("the next target (availability, usage, capabilities, voice) follows the staged agents", () => {
    const next = slice(RUNTIME, "const nextTarget = useMemo<AgentRef | null>(", ");\n");
    expect(next).toMatch(/resolveTurnRoute\(\{\s*mentioned: stagedAgents\(staged\),/);
    expect(RUNTIME).toMatch(/useSyncExternalStore\(\s*subscribePendingMentions,/);
    expect(RUNTIME).not.toMatch(/useState<AgentRef \| null>/);
    // Each projection of the next send reads it.
    expect(CHAT.match(/routing\?\.nextTarget \?\? null/g)?.length).toBe(2);
    expect(CHAT).toMatch(/const composerTarget = composerRouting\?\.nextTarget \?\? null;/);
  });
});

describe("the composer says who answers when nobody is mentioned", () => {
  test("in a room of several agents: the primary, named as such", () => {
    expect(CHAT).toMatch(
      /const composerAmongSeveral = \(composerRouting\?\.roomAgents\.length \?\? 0\) > 0;/,
    );
    expect(CHAT).toMatch(
      /composerAmongSeveral\s*\?\s*m\.chat_composer_placeholder_primary\(\{ name: composerName \}\)\s*:\s*m\.chat_composer_placeholder\(\{ name: composerName \}\)/,
    );
    expect(CHAT).toMatch(
      /composerAmongSeveral && composerPrimary\s*\?\s*\(findAgentDisplay\(composerRouting\?\.pool \?\? \[\], composerPrimary\)/,
    );
  });

  test("the room control's title names the primary, never a selection", () => {
    expect(CHAT).toMatch(/const shown = gate\.onCall \?\? routing\.primary;/);
  });
});

describe("the thread shows who a message was addressed to", () => {
  test("an agent mention is highlighted like a person's", () => {
    const text = slice(CHAT, "function MentionedText(", "\nconst plainComponents");
    expect(text).toMatch(/className=\{`oc-mention\$\{mention\.isViewer \? " oc-mention--self" : ""\}\$\{\s*mention\.isAgent === true \? " oc-mention--agent" : ""\s*\}`\}/);
  });
});

describe("a refused address is said, not swallowed", () => {
  test("too many agents / an agent the message can no longer reach", () => {
    expect(agentAddressFailure(new Error("[CONVEX] agent_mentions_invalid:too_many_agents"))).toBe(
      "too_many",
    );
    expect(agentAddressFailure(new Error("agent_mentions_invalid:overlapping"))).toBe("invalid");
    expect(
      agentAddressFailure(new Error("Forbidden: agent is not part of this conversation")),
    ).toBe("invalid");
    expect(agentAddressFailure(new Error("QUEUE_FULL"))).toBeNull();
    expect(agentAddressFailure("nothing")).toBeNull();
  });

  test("both send paths toast it", () => {
    const onNew = slice(RUNTIME, "onNew: async", "const queueSend");
    const queueSend = slice(RUNTIME, "const queueSend", "\n  );");
    for (const body of [onNew, queueSend]) {
      expect(body).toMatch(/const addressing = agentAddressFailure\(e\);/);
      expect(body).toMatch(/m\.chat_send_agents_too_many\(\)/);
      expect(body).toMatch(/m\.chat_send_agents_invalid\(\)/);
    }
  });
});

describe("a command sent with files is named to the writer", () => {
  test("recognizes the server's refusal, and nothing else", () => {
    expect(commandWithFilesRefused(new Error("Uncaught Error: COMMAND_WITH_ATTACHMENTS"))).toBe(true);
    expect(commandWithFilesRefused(new Error("QUEUE_FULL"))).toBe(false);
    expect(commandWithFilesRefused(undefined)).toBe(false);
    for (const locale of ["en", "fr"] as const) {
      expect(m.chat_send_command_with_files({}, { locale })).toMatch(/\//);
    }
  });
});
