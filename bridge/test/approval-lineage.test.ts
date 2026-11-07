// WHOSE APPROVAL IS IT? (N1, lot « trames 1 ») — approval-lineage.ts.
//
// Upstream addresses an approval to the raising session AND its ancestors
// (src/gateway/approval-session-audience.ts:52-107 at v2026.9.36): a sub-agent's request
// belongs to the conversation that spawned it. The membership is proven — by the
// conversation's own key, a child it knows, or the gateway's rows walked up (`spawnedBy`,
// which IS the registry owner else the stored parent, session-utils-row.ts:618) — and
// anything unproven is not ours.
import { describe, expect, it } from "vitest";

import {
  ApprovalLineage,
  MAX_LINEAGE_DEPTH,
  REFUSED_LINEAGE_TTL_MS,
  isSubagentSessionKey,
} from "../src/providers/openclaw/approval-lineage.js";

const SELF = "agent:alice:atrium:chat:u-1:c1";
const OTHER_CONVERSATION = "agent:alice:atrium:chat:u-2:c2";
const CHILD = "agent:files:subagent:11111111-1111-4111-8111-111111111111";
const GRANDCHILD = "agent:files:subagent:22222222-2222-4222-8222-222222222222";

function lineage(opts: {
  known?: Record<string, string | null>;
  rows?: Record<string, Record<string, unknown> | null>;
  failing?: Set<string>;
}) {
  let now = 1_000_000;
  const asked: string[] = [];
  const l = new ApprovalLineage({
    sessionKey: SELF,
    knownChild: (key) =>
      opts.known !== undefined && key in opts.known ? { anchorMessageId: opts.known[key]! } : null,
    describe: async (key) => {
      asked.push(key);
      if (opts.failing?.has(key)) throw new Error("socket closed");
      return opts.rows?.[key] ?? null;
    },
    nowMs: () => now,
  });
  return { l, asked, advance: (ms: number) => (now += ms) };
}

describe("isSubagentSessionKey — upstream's predicate (session-key-utils.ts:83-93)", () => {
  it.each([
    ["subagent:abc", true],
    [CHILD, true],
    ["AGENT:FILES:SUBAGENT:X", true],
    [SELF, false],
    ["agent:alice:main", false],
    ["", false],
  ])("%s → %s", (key, expected) => {
    expect(isSubagentSessionKey(key)).toBe(expected);
  });
});

describe("membership without the gateway", () => {
  it("the conversation's own key, exactly or differing only in case", async () => {
    const { l, asked } = lineage({});
    expect(l.known(SELF)).toEqual({ relation: "self" });
    expect(l.known(SELF.toUpperCase())).toEqual({ relation: "self" });
    expect(await l.resolve(SELF)).toEqual({ relation: "self" });
    expect(asked).toEqual([]);
  });

  it("a child the conversation knows, with the bubble it was spawned from", async () => {
    const { l, asked } = lineage({ known: { [CHILD]: "msg-spawn" } });
    expect(l.known(CHILD)).toEqual({ relation: "descendant", anchorMessageId: "msg-spawn" });
    expect(await l.resolve(CHILD)).toEqual({ relation: "descendant", anchorMessageId: "msg-spawn" });
    expect(asked).toEqual([]);
  });

  it("another conversation's session is never asked about, never ours", async () => {
    const { l, asked } = lineage({});
    expect(l.known(OTHER_CONVERSATION)).toBeNull();
    expect(await l.resolve(OTHER_CONVERSATION)).toBeNull();
    expect(asked, "only a sub-agent session has a lineage upstream (server-chat.ts:401-411)").toEqual([]);
    expect(l.known(null)).toBeNull();
    expect(await l.resolve(undefined)).toBeNull();
  });
});

describe("membership proven by the gateway's rows", () => {
  it("an unknown sub-agent whose row names THIS conversation is a descendant — then known", async () => {
    const { l, asked } = lineage({ rows: { [CHILD]: { key: CHILD, spawnedBy: SELF } } });
    expect(l.known(CHILD)).toBeNull();
    expect(await l.resolve(CHILD)).toEqual({ relation: "descendant", anchorMessageId: null });
    expect(asked).toEqual([CHILD]);
    expect(l.known(CHILD)).toEqual({ relation: "descendant", anchorMessageId: null });
  });

  it("`parentSessionKey` stands in when the row names no `spawnedBy`", async () => {
    const { l } = lineage({ rows: { [CHILD]: { parentSessionKey: SELF } } });
    expect(await l.resolve(CHILD)).toEqual({ relation: "descendant", anchorMessageId: null });
  });

  it("a grandchild, through a known child — the child's anchor is inherited", async () => {
    const { l, asked } = lineage({
      known: { [CHILD]: "msg-spawn" },
      rows: { [GRANDCHILD]: { spawnedBy: CHILD } },
    });
    expect(await l.resolve(GRANDCHILD)).toEqual({ relation: "descendant", anchorMessageId: "msg-spawn" });
    expect(asked).toEqual([GRANDCHILD]);
  });

  it("a grandchild, through an unknown child, up to this conversation", async () => {
    const { l, asked } = lineage({
      rows: { [GRANDCHILD]: { spawnedBy: CHILD }, [CHILD]: { spawnedBy: SELF } },
    });
    expect(await l.resolve(GRANDCHILD)).toEqual({ relation: "descendant", anchorMessageId: null });
    expect(asked).toEqual([GRANDCHILD, CHILD]);
    // Both are proven now.
    expect(l.known(CHILD)).not.toBeNull();
  });

  it("another conversation's sub-agent is NOT ours — and is not asked about again soon", async () => {
    const { l, asked, advance } = lineage({ rows: { [CHILD]: { spawnedBy: OTHER_CONVERSATION } } });
    expect(await l.resolve(CHILD)).toBeNull();
    expect(await l.resolve(CHILD)).toBeNull();
    expect(asked).toEqual([CHILD]);
    advance(REFUSED_LINEAGE_TTL_MS + 1);
    expect(await l.resolve(CHILD)).toBeNull();
    expect(asked).toEqual([CHILD, CHILD]);
  });

  it("a session the gateway has no row for is not ours", async () => {
    const { l } = lineage({ rows: { [CHILD]: null } });
    expect(await l.resolve(CHILD)).toBeNull();
  });

  it("a failed read proves nothing and is not remembered", async () => {
    const { l, asked } = lineage({ failing: new Set([CHILD]) });
    expect(await l.resolve(CHILD)).toBeNull();
    expect(await l.resolve(CHILD)).toBeNull();
    expect(asked).toEqual([CHILD, CHILD]);
  });

  it("a cycle, or a walk deeper than the bound, ends in a refusal", async () => {
    const cyc = lineage({ rows: { [CHILD]: { spawnedBy: GRANDCHILD }, [GRANDCHILD]: { spawnedBy: CHILD } } });
    expect(await cyc.l.resolve(CHILD)).toBeNull();
    const rows: Record<string, Record<string, unknown>> = {};
    const key = (i: number) => `agent:files:subagent:deep-${i}`;
    for (let i = 0; i <= MAX_LINEAGE_DEPTH; i += 1) rows[key(i)] = { spawnedBy: key(i + 1) };
    rows[key(MAX_LINEAGE_DEPTH + 1)] = { spawnedBy: SELF };
    const deep = lineage({ rows });
    expect(await deep.l.resolve(key(0))).toBeNull();
    expect(deep.asked).toHaveLength(MAX_LINEAGE_DEPTH);
  });
});
