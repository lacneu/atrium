/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  agentRefEquals,
  findAgentDisplay,
  isFirstTurn,
  lastRoutedAgent,
  resolveDefaultSelection,
  resolveEffectiveSelection,
  resolveMessageAgents,
  resolveRoutedAgentToSend,
  type AgentRef,
  type RoutableMessage,
  type SelectableAgent,
} from "./perTurnAgent";

const ref = (instanceName: string, agentId: string): AgentRef => ({
  instanceName,
  agentId,
});

// Build a message; `to` stamps the routed agent (user turns + explicitly-routed
// assistant turns). Omit `to` for an unrouted (primary) turn.
const msg = (
  _id: string,
  role: RoutableMessage["role"],
  to?: AgentRef,
): RoutableMessage => ({
  _id,
  role,
  ...(to ? { routedInstanceName: to.instanceName, routedAgentId: to.agentId } : {}),
});

describe("agentRefEquals", () => {
  test("same instance + id are equal", () => {
    expect(agentRefEquals(ref("prod", "alice"), ref("prod", "alice"))).toBe(true);
  });
  test("different id (or instance) are not equal", () => {
    expect(agentRefEquals(ref("prod", "alice"), ref("prod", "bob"))).toBe(false);
    expect(agentRefEquals(ref("prod", "alice"), ref("staging", "alice"))).toBe(
      false,
    );
  });
  test("null handling: both null equal, one null not", () => {
    expect(agentRefEquals(null, null)).toBe(true);
    expect(agentRefEquals(ref("prod", "alice"), null)).toBe(false);
    expect(agentRefEquals(null, ref("prod", "alice"))).toBe(false);
  });
});

describe("resolveMessageAgents (per-message attribution + inheritance)", () => {
  test("assistant INHERITS the preceding user turn's routed agent", () => {
    const alice = ref("prod", "alice");
    const map = resolveMessageAgents([
      msg("u1", "user", alice),
      msg("a1", "assistant"), // no own routing → inherits alice
    ]);
    expect(map.get("u1")).toEqual(alice);
    expect(map.get("a1")).toEqual(alice);
  });

  test("assistant's OWN routed agent wins over inheritance", () => {
    const alice = ref("prod", "alice");
    const bob = ref("prod", "bob");
    const map = resolveMessageAgents([
      msg("u1", "user", alice),
      msg("a1", "assistant", bob),
    ]);
    expect(map.get("a1")).toEqual(bob);
  });

  test("unrouted user turn → null (caller falls back to primary), not the prior turn's agent", () => {
    const alice = ref("prod", "alice");
    const map = resolveMessageAgents([
      msg("u1", "user", alice),
      msg("a1", "assistant"),
      msg("u2", "user"), // unrouted → primary
      msg("a2", "assistant"), // inherits u2 → null
    ]);
    expect(map.get("u2")).toBeNull();
    expect(map.get("a2")).toBeNull();
  });

  test("each turn attributes independently in a mixed thread", () => {
    const alice = ref("prod", "alice");
    const bob = ref("prod", "bob");
    const map = resolveMessageAgents([
      msg("u1", "user", alice),
      msg("a1", "assistant"),
      msg("u2", "user", bob),
      msg("a2", "assistant"),
    ]);
    expect(map.get("a1")).toEqual(alice);
    expect(map.get("a2")).toEqual(bob);
  });
});

describe("lastRoutedAgent (composer default)", () => {
  test("returns the most-recent explicitly-routed agent", () => {
    const alice = ref("prod", "alice");
    const bob = ref("prod", "bob");
    expect(
      lastRoutedAgent([
        msg("u1", "user", alice),
        msg("a1", "assistant"),
        msg("u2", "user", bob),
      ]),
    ).toEqual(bob);
  });
  test("returns null when no turn was ever routed", () => {
    expect(lastRoutedAgent([msg("u1", "user"), msg("a1", "assistant")])).toBeNull();
  });
});

describe("findAgentDisplay", () => {
  const pool = [
    { instanceName: "prod", agentId: "alice", displayName: "Alice", emoji: "🅰" },
    { instanceName: "prod", agentId: "bob", displayName: null, emoji: null },
  ];
  test("resolves name/emoji for a ref in the pool", () => {
    expect(findAgentDisplay(pool, ref("prod", "alice"))).toEqual({
      displayName: "Alice",
      emoji: "🅰",
    });
  });
  test("null for a ref not in the pool (entitlement narrowed)", () => {
    expect(findAgentDisplay(pool, ref("prod", "carol"))).toBeNull();
  });
  test("null for a null ref", () => {
    expect(findAgentDisplay(pool, null)).toBeNull();
  });
});

describe("resolveDefaultSelection (default filtered against the current pool)", () => {
  const sel = (
    instanceName: string,
    agentId: string,
    extra: Partial<SelectableAgent> = {},
  ): SelectableAgent => ({ instanceName, agentId, ...extra });

  const alice = ref("prod", "alice"); // primary
  const bob = ref("prod", "bob"); // a specialist
  const carol = ref("prod", "carol"); // the user's default in the pool below

  test("last-routed agent still in the pool → keeps it as the default", () => {
    const pool = [sel("prod", "alice"), sel("prod", "bob")];
    expect(
      resolveDefaultSelection({ lastRouted: bob, primary: alice, pool }),
    ).toEqual(bob);
  });

  test("(a) last-routed REVOKED (absent from pool) → falls back to primary", () => {
    const pool = [sel("prod", "alice"), sel("prod", "carol", { isDefault: true })];
    // bob is no longer entitled → must NOT be returned.
    const out = resolveDefaultSelection({ lastRouted: bob, primary: alice, pool });
    expect(out).toEqual(alice);
    expect(agentRefEquals(out, bob)).toBe(false);
  });

  test("last-routed GATEWAY-DELETED (in pool but state deleted) → not returned", () => {
    const pool = [
      sel("prod", "alice"),
      sel("prod", "bob", { state: "deleted" }),
    ];
    expect(
      resolveDefaultSelection({ lastRouted: bob, primary: alice, pool }),
    ).toEqual(alice);
  });

  test("(b) last-routed AND primary both absent → first available (prefers the user default)", () => {
    const pool = [sel("prod", "bob"), sel("prod", "carol", { isDefault: true })];
    expect(
      resolveDefaultSelection({ lastRouted: alice, primary: alice, pool }),
    ).toEqual(carol);
  });

  test("(b) no default flagged → first available in pool order", () => {
    const pool = [sel("prod", "bob"), sel("prod", "carol")];
    expect(
      resolveDefaultSelection({ lastRouted: alice, primary: alice, pool }),
    ).toEqual(bob);
  });

  test("(c) empty pool → null (no agent available)", () => {
    expect(
      resolveDefaultSelection({ lastRouted: bob, primary: alice, pool: [] }),
    ).toBeNull();
  });

  test("all pool agents deleted → null (none usable)", () => {
    const pool = [sel("prod", "bob", { state: "deleted" })];
    expect(
      resolveDefaultSelection({ lastRouted: bob, primary: bob, pool }),
    ).toBeNull();
  });
});

describe("resolveRoutedAgentToSend (single-agent-path rule)", () => {
  const alice = ref("prod", "alice"); // primary
  const bob = ref("prod", "bob"); // a different specialist

  test("no selection → undefined (unchanged path)", () => {
    expect(
      resolveRoutedAgentToSend({
        selected: null,
        primary: alice,
        perTurnRouting: false,
        isFirstTurn: false,
        canRoute: true,
      }),
    ).toBeUndefined();
  });

  test("very first turn → undefined even when the selection differs from primary", () => {
    expect(
      resolveRoutedAgentToSend({
        selected: bob,
        primary: alice,
        perTurnRouting: false,
        isFirstTurn: true,
        canRoute: true,
      }),
    ).toBeUndefined();
  });

  test("selection === primary on a single-agent chat → undefined (no routedAgent)", () => {
    expect(
      resolveRoutedAgentToSend({
        selected: alice,
        primary: alice,
        perTurnRouting: false,
        isFirstTurn: false,
        canRoute: true,
      }),
    ).toBeUndefined();
  });

  test("selection !== primary on a single-agent chat → routes (flips to multi)", () => {
    expect(
      resolveRoutedAgentToSend({
        selected: bob,
        primary: alice,
        perTurnRouting: false,
        isFirstTurn: false,
        canRoute: true,
      }),
    ).toEqual(bob);
  });

  test("already perTurnRouting → ALWAYS stamps, even when selection === primary", () => {
    expect(
      resolveRoutedAgentToSend({
        selected: alice,
        primary: alice,
        perTurnRouting: true,
        isFirstTurn: false,
        canRoute: true,
      }),
    ).toEqual(alice);
  });

  test("(P2-C) canRoute false (single-agent user) → undefined even if a selection differs from a null primary", () => {
    // The single-agent-user shape: lone pool agent selected, primary null. Without
    // the canRoute guard this would stamp (bob !== null) and implicitly route.
    expect(
      resolveRoutedAgentToSend({
        selected: bob,
        primary: null,
        perTurnRouting: false,
        isFirstTurn: false,
        canRoute: false,
      }),
    ).toBeUndefined();
  });
});

describe("isFirstTurn (loading-aware first-turn detection)", () => {
  test("messages LOADING (undefined) → NOT first turn (don't suppress routing)", () => {
    expect(isFirstTurn(undefined)).toBe(false);
  });
  test("messages loaded EMPTY ([]) → first turn (a genuinely new chat)", () => {
    expect(isFirstTurn([])).toBe(true);
  });
  test("messages with a user turn → not first turn", () => {
    expect(isFirstTurn([msg("u1", "user"), msg("a1", "assistant")])).toBe(false);
  });
  test("assistant-only (no user turn yet) → still first turn", () => {
    expect(isFirstTurn([msg("a1", "assistant")])).toBe(true);
  });
});

describe("resolveEffectiveSelection (canRoute gate + loading preservation)", () => {
  const sel = (
    instanceName: string,
    agentId: string,
    extra: Partial<SelectableAgent> = {},
  ): SelectableAgent => ({ instanceName, agentId, ...extra });
  const alice = ref("prod", "alice");
  const bob = ref("prod", "bob");

  test("(P2-C) single-agent user (canRoute false) → null, never the lone pool agent", () => {
    const out = resolveEffectiveSelection({
      selected: null,
      lastRouted: null,
      primary: null,
      pool: [sel("prod", "alice")], // the user's one agent
      poolLoading: false,
      messagesLoading: false,
      canRoute: false,
    });
    expect(out).toBeNull();
  });

  test("(P2-D) pool LOADING in a perTurnRouting chat → preserves the last-routed agent (not dropped)", () => {
    const loaded = resolveEffectiveSelection({
      selected: null,
      lastRouted: bob,
      primary: alice,
      pool: [], // not yet known
      poolLoading: true,
      messagesLoading: false,
      canRoute: true,
    });
    expect(loaded).toEqual(bob);
    // Discriminating contrast: with the pool KNOWN-empty (not loading), bob is
    // genuinely gone → it must be dropped, NOT preserved.
    const empty = resolveEffectiveSelection({
      selected: null,
      lastRouted: bob,
      primary: alice,
      pool: [],
      poolLoading: false,
      messagesLoading: false,
      canRoute: true,
    });
    expect(empty).toBeNull();
    expect(agentRefEquals(empty, bob)).toBe(false);
  });

  test("(P2-E) MESSAGES LOADING in a perTurnRouting chat → preserves the last-routed agent (not dropped to primary)", () => {
    const loading = resolveEffectiveSelection({
      selected: null,
      lastRouted: bob, // the chat-level last-routed (from getSessionMeta), known during load
      primary: alice,
      pool: [sel("prod", "alice"), sel("prod", "bob")],
      poolLoading: false,
      messagesLoading: true,
      canRoute: true,
    });
    expect(loading).toEqual(bob);
    expect(agentRefEquals(loading, alice)).toBe(false); // NOT silently the primary
    // Discriminating contrast: a genuinely empty NEW chat (messages loaded, no
    // last-routed) → the default is the primary (and isFirstTurn → no routing).
    const newChat = resolveEffectiveSelection({
      selected: null,
      lastRouted: null,
      primary: alice,
      pool: [sel("prod", "alice"), sel("prod", "bob")],
      poolLoading: false,
      messagesLoading: false,
      canRoute: true,
    });
    expect(newChat).toEqual(alice);
  });

  test("loading + no last-routed → falls back to primary (never null while routable)", () => {
    expect(
      resolveEffectiveSelection({
        selected: null,
        lastRouted: null,
        primary: alice,
        pool: [],
        poolLoading: true,
        messagesLoading: false,
        canRoute: true,
      }),
    ).toEqual(alice);
  });

  test("both loaded → explicit pick wins when still entitled", () => {
    expect(
      resolveEffectiveSelection({
        selected: bob,
        lastRouted: alice,
        primary: alice,
        pool: [sel("prod", "alice"), sel("prod", "bob")],
        poolLoading: false,
        messagesLoading: false,
        canRoute: true,
      }),
    ).toEqual(bob);
  });

  test("both loaded → a revoked explicit pick falls back to primary", () => {
    expect(
      resolveEffectiveSelection({
        selected: bob, // no longer entitled
        lastRouted: bob,
        primary: alice,
        pool: [sel("prod", "alice")],
        poolLoading: false,
        messagesLoading: false,
        canRoute: true,
      }),
    ).toEqual(alice);
  });
});
