/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  agentRefEquals,
  resolveImportedAgentLabels,
  findAgentDisplay,
  lastRoutedAgent,
  resolveAgentSelectorGate,
  resolveDefaultSelection,
  resolveEffectiveSelection,
  resolveMessageAgents,
  resolveTurnRoute,
  type AgentRef,
  type RoutableMessage,
  type SelectableAgent,
  orderComposerAgents,
  homonymAgentKeys,
  mayRemoveRoomAgent,
  withRoomRoster,
  presenceRoster,
  roomTargets,
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

describe("resolveTurnRoute — addressing by mention, else the primary", () => {
  const alice = ref("prod", "alice"); // primary
  const bob = ref("prod", "bob");
  const carol = ref("prod", "carol");
  const base = {
    mentioned: [] as AgentRef[],
    primary: alice,
    severalAgents: true,
    perTurnRouting: false,
    canRoute: true,
  };

  test("mentioned agents → the FIRST one, in text order", () => {
    expect(resolveTurnRoute({ ...base, mentioned: [bob, carol] })).toEqual(bob);
    expect(resolveTurnRoute({ ...base, mentioned: [carol, bob] })).toEqual(carol);
  });

  test("nothing mentioned in a room of several → the PRIMARY, never the last agent used", () => {
    expect(resolveTurnRoute(base)).toEqual(alice);
    expect(resolveTurnRoute({ ...base, severalAgents: false, perTurnRouting: true })).toEqual(
      alice,
    );
  });

  test("a single-agent room not yet routed per turn → the unchanged path", () => {
    expect(resolveTurnRoute({ ...base, severalAgents: false })).toBeUndefined();
  });

  test("(P2-C) a single-agent user never routes, mention or not", () => {
    expect(resolveTurnRoute({ ...base, canRoute: false })).toBeUndefined();
    expect(resolveTurnRoute({ ...base, canRoute: false, mentioned: [bob] })).toBeUndefined();
  });

  test("no primary known → nothing to route to without a mention", () => {
    expect(resolveTurnRoute({ ...base, primary: null })).toBeUndefined();
    expect(resolveTurnRoute({ ...base, primary: null, mentioned: [bob] })).toEqual(bob);
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

// The escape hatch (production report, 2026-07-31). A chat opened on an agent whose
// gateway was down had NO way back: the composer greyed out and took the agent
// selector with it, so the conversation could only be deleted. What is pinned below
// is that the "you cannot send there" condition never closes the one control that
// changes WHERE the send goes — and that the control only ever picks the NEXT
// message's agent, never the conversation's primary.
describe("resolveAgentSelectorGate", () => {
  const gate = (o: Partial<Parameters<typeof resolveAgentSelectorGate>[0]>) =>
    resolveAgentSelectorGate({
      unavailable: false,
      readOnly: false,
      multiAgent: true,
      poolSize: 2,
      ...o,
    });

  test("an UNREACHABLE gateway does not close the selector — it is the way out", () => {
    expect(gate({ unavailable: true })).toEqual({ hidden: false, disabled: false });
  });

  test("no mode: a pick is always the next message's agent, never a rebind", () => {
    // The composer once rebound an empty chat on a pick. The primary is the
    // conversation panel's now (chatAgents.setPrimaryAgent): the verdict carries no
    // second meaning for a click.
    expect(Object.keys(gate({})).sort()).toEqual(["disabled", "hidden"]);
  });

  test("a read-only chat stays closed, and says why", () => {
    // Read-only is computed from the chat's binding: a pick would lift nothing.
    expect(gate({ readOnly: true })).toEqual({
      hidden: false,
      disabled: true,
      reason: "read-only",
    });
  });
});

// What the pure gate could not see until it owned the render decision. The first
// version of this feature let the COMPONENT hide itself on `multiAgent`, and that
// check silently discarded a gate that said "enabled". The decision lives here.
describe("resolveAgentSelectorGate — when the control is rendered at all", () => {
  const gate = (o: Partial<Parameters<typeof resolveAgentSelectorGate>[0]>) =>
    resolveAgentSelectorGate({
      unavailable: false,
      readOnly: false,
      multiAgent: true,
      poolSize: 2,
      ...o,
    });

  test("a single-agent user gets NO selector — there is only one agent to pick", () => {
    expect(gate({ multiAgent: false, poolSize: 1 }).hidden).toBe(true);
    // …an empty read-only chat included: moving it off its binding is the owner's,
    // in the conversation panel, not a pick in the composer.
    expect(gate({ multiAgent: false, poolSize: 1, readOnly: true }).hidden).toBe(true);
  });

  test("a pool of only DELETED agents renders nothing", () => {
    // `poolSize` counts SELECTABLE agents. Counting rows instead would light the
    // escape hatch up over a picker whose every option is disabled.
    expect(gate({ multiAgent: false, poolSize: 0 }).hidden).toBe(true);
    expect(gate({ poolSize: 0 }).hidden).toBe(true);
  });

  test("a multi-agent user keeps the selector", () => {
    expect(gate({}).hidden).toBe(false);
    expect(gate({ readOnly: true }).hidden).toBe(false);
  });
});


describe("imported agent labels", () => {
  test("an assistant reply inherits the label of the turn it answers", () => {
    // Same inheritance as the attribution itself: an ordinary assistant message
    // carries no agent of its own, so without this an imported reply would show
    // nothing while the user turn beside it showed the name.
    const labels = resolveImportedAgentLabels([
      { _id: "u1", role: "user", importedAgentLabel: "alice" },
      { _id: "a1", role: "assistant" },
      { _id: "u2", role: "user", importedAgentLabel: "bob" },
      { _id: "a2", role: "assistant" },
    ]);

    expect(labels.get("a1")).toBe("alice");
    expect(labels.get("a2")).toBe("bob");
  });

  test("a message with its OWN label keeps it", () => {
    const labels = resolveImportedAgentLabels([
      { _id: "u1", role: "user", importedAgentLabel: "alice" },
      { _id: "a1", role: "assistant", importedAgentLabel: "carol" },
    ]);

    expect(labels.get("a1")).toBe("carol");
  });

  test("a conversation's own label is the LAST resort, not the first", () => {
    // The ordinary single-agent case has no per-message agent at all, so the
    // conversation's is what names it. But on a multi-agent one the turn's own
    // agent must win, or every reply reads as coming from the chat's primary.
    const labels = resolveImportedAgentLabels([
      { _id: "u1", role: "user", importedAgentLabel: "bob", chatImportedAgentLabel: "alice" },
      { _id: "a1", role: "assistant", chatImportedAgentLabel: "alice" },
      { _id: "u2", role: "user", chatImportedAgentLabel: "alice" },
      { _id: "a2", role: "assistant", chatImportedAgentLabel: "alice" },
    ]);

    // The turn that named its own agent, and the reply that answers it.
    expect(labels.get("u1")).toBe("bob");
    expect(labels.get("a1")).toBe("bob");
    // The turn that named none falls back to the conversation.
    expect(labels.get("u2")).toBe("alice");
    expect(labels.get("a2")).toBe("alice");
  });

  test("history that was never imported carries no label", () => {
    // The field must stay absent on ordinary conversations, or every reply would
    // claim an agent that has nothing to do with an import.
    const labels = resolveImportedAgentLabels([
      { _id: "u1", role: "user", routedInstanceName: "primary", routedAgentId: "alice" },
      { _id: "a1", role: "assistant" },
    ]);

    expect(labels.get("u1")).toBe(null);
    expect(labels.get("a1")).toBe(null);
  });
});

describe("the agent is frozen while a voice call is in progress", () => {
  // A call is minted for the agent selected at that instant: the gateway holds the
  // session and the mid-call consult addresses THAT agent. Switching would split one
  // conversation across two agents — and on a gateway-owned call (GPT Live, the
  // OpenClaw 2026.9.5 default) it would end the call outright, since the bridge keeps
  // one live socket per chat and re-keying it closes the one the call is bound to.
  const base = {
    unavailable: false,
    readOnly: false,
    multiAgent: true,
    poolSize: 3,
  };

  test("closes the control, and says the call is why", () => {
    expect(resolveAgentSelectorGate({ ...base, callActive: true })).toEqual({
      hidden: false,
      disabled: true,
      reason: "call-active",
      onCall: null,
    });
  });

  test("carries WHO is on the line, so the locked label is the CALL's agent", () => {
    // The control's whole job while closed is to say who is on the line. Left to the
    // tab's own selection it named the wrong agent for a second tab, or for a
    // participant whose pick differs from the owner's call (codex P2, pass 5).
    const onCall = { instanceName: "lacneu", agentId: "alice" };
    expect(
      resolveAgentSelectorGate({ ...base, callActive: true, onCall }).onCall,
    ).toEqual(onCall);
    // …and it is NOT carried when no call is up: a stale name on an open control
    // would be a different lie in the same place.
    expect(
      resolveAgentSelectorGate({ ...base, callActive: false, onCall }).onCall,
    ).toBeUndefined();
  });

  test("still SHOWS which agent is on the line — closed is not hidden", () => {
    // Hiding it would leave the reader with no idea who they are talking to at the
    // exact moment that matters most.
    expect(resolveAgentSelectorGate({ ...base, callActive: true }).hidden).toBe(false);
  });

  test("outranks every other verdict, read-only included", () => {
    // The call is the reason the reader can act on (hang up); naming read-only
    // instead would send them looking for the wrong cause.
    const both = resolveAgentSelectorGate({ ...base, readOnly: true, callActive: true });
    expect(both.disabled).toBe(true);
    expect(both.reason).toBe("call-active");
  });

  test("changes nothing when no call is up", () => {
    const off = resolveAgentSelectorGate({ ...base, callActive: false });
    expect(off).toEqual({ hidden: false, disabled: false });
    // …and the flag is optional: every existing caller keeps its verdict.
    expect(resolveAgentSelectorGate(base)).toEqual(off);
  });

  test("a single-agent user still sees nothing — there was never a choice", () => {
    expect(
      resolveAgentSelectorGate({ ...base, multiAgent: false, callActive: true }).hidden,
    ).toBe(true);
  });
});

describe("everyone picks between the agents from the first turn", () => {
  const a = { instanceName: "alpha", agentId: "alice" };
  const b = { instanceName: "alpha", agentId: "bob" };
  test("the selector is open on an empty thread — for the owner as for a guest", () => {
    expect(
      resolveAgentSelectorGate({
        unavailable: false,
        readOnly: false,
        multiAgent: true,
        poolSize: 2,
      }),
    ).toEqual({ hidden: false, disabled: false });
  });

  test("turn 1 goes where the text says: the mentioned agent, else the primary", () => {
    const route = { primary: a, severalAgents: true, perTurnRouting: false, canRoute: true };
    expect(resolveTurnRoute({ ...route, mentioned: [b] })).toEqual(b);
    expect(resolveTurnRoute({ ...route, mentioned: [] })).toEqual(a);
  });
});

describe("the composer picker reads as one list", () => {
  const ag = (instanceName: string, agentId: string, displayName: string | null = agentId) => ({
    instanceName,
    agentId,
    displayName,
  });
  test("primary, then the room in the order added, then the rest by name", () => {
    const pool = [
      ag("i1", "zed"),
      ag("i2", "bench-1"),
      ag("i1", "alice", "Alice"),
      ag("i2", "hermes"),
      ag("i1", "bob", "Bob"),
      ag("i2", "bench-0"),
    ];
    const { room, others } = orderComposerAgents(
      pool,
      { instanceName: "i1", agentId: "alice" },
      [
        { instanceName: "i2", agentId: "hermes" },
        { instanceName: "i1", agentId: "bob" },
      ],
    );
    expect(room.map((a) => a.agentId)).toEqual(["alice", "hermes", "bob"]);
    expect(others.map((a) => a.agentId)).toEqual(["bench-0", "bench-1", "zed"]);
    // Natural order: a number sorts as a number.
    const natural = orderComposerAgents(
      [ag("i", "bench-10"), ag("i", "bench-2"), ag("i", "Bench-1")],
      null,
      [],
    );
    expect(natural.others.map((a) => a.agentId)).toEqual(["Bench-1", "bench-2", "bench-10"]);
  });

  test("no added agent: one list, the primary first", () => {
    const { room, others } = orderComposerAgents(
      [ag("i1", "zed"), ag("i1", "alice")],
      { instanceName: "i1", agentId: "zed" },
      [],
    );
    expect(room).toEqual([]);
    expect(others.map((a) => a.agentId)).toEqual(["zed", "alice"]);
  });

});

// The composer's list shows NO technical detail — the model and the instance live in
// the conversation panel. The one exception is correctness: two agents of the same
// name on two gateways must still read as two.
describe("homonymAgentKeys — which rows need their instance", () => {
  const ag = (instanceName: string, agentId: string, displayName: string | null) => ({
    instanceName,
    agentId,
    displayName,
  });

  test("only the agents whose name another listed agent bears", () => {
    const keys = homonymAgentKeys([
      ag("olivier", "alice", "Alice"),
      ag("jerome", "alice", "Alice"),
      ag("olivier", "bob", "Bob"),
    ]);
    expect([...keys].sort()).toEqual(["jerome\u0000alice", "olivier\u0000alice"]);
  });

  test("names compare as they read: case, spaces, and the id when unnamed", () => {
    const keys = homonymAgentKeys([
      ag("a", "x1", " Nova "),
      ag("b", "x2", "nova"),
      ag("a", "carl", null),
      ag("b", "c9", "Carl"),
    ]);
    expect(keys.size).toBe(4);
  });

  test("the same agent listed twice is not its own homonym", () => {
    const a = ag("olivier", "alice", "Alice");
    expect(homonymAgentKeys([a, { ...a }]).size).toBe(0);
  });

  test("nobody shares a name: nothing is disambiguated", () => {
    expect(homonymAgentKeys([ag("a", "x", "X"), ag("b", "y", "Y")]).size).toBe(0);
  });
});

describe("mayRemoveRoomAgent — the composer's quick removal", () => {
  const primary = ref("i", "alice");
  const added = [ref("i", "bob")];

  test("an ADDED agent, by whoever manages the room", () => {
    expect(mayRemoveRoomAgent("owner", ref("i", "bob"), primary, added)).toBe(true);
    expect(mayRemoveRoomAgent("manager", ref("i", "bob"), primary, added)).toBe(true);
  });

  test("never the primary — it changes through the panel's Make primary", () => {
    expect(mayRemoveRoomAgent("owner", primary, primary, [...added, primary])).toBe(false);
  });

  test("never an agent outside the room, never by a member or a viewer", () => {
    expect(mayRemoveRoomAgent("owner", ref("i", "carol"), primary, added)).toBe(false);
    expect(mayRemoveRoomAgent("member", ref("i", "bob"), primary, added)).toBe(false);
    expect(mayRemoveRoomAgent("viewer", ref("i", "bob"), primary, added)).toBe(false);
    expect(mayRemoveRoomAgent(undefined, ref("i", "bob"), primary, added)).toBe(false);
  });
});

describe("the picker lists the room as it is", () => {
  test("a room agent the reader cannot reach stays listed, disabled", () => {
    const pool = [{ instanceName: "i", agentId: "a", displayName: "A" }];
    const view = (agentId: string, role: "primary" | "member") => ({
      instanceName: "i",
      agentId,
      role,
      displayName: agentId.toUpperCase(),
      emoji: null,
      model: null,
      description: null,
      kind: "openclaw" as const,
    });
    const listed = withRoomRoster(pool, [view("a", "primary"), view("b", "member"), null]);
    expect(listed.map((a) => a.agentId)).toEqual(["a", "b"]);
    expect(listed[1]).toMatchObject({ state: "deleted", isDefault: false });
    // Nothing missing: the pool itself, untouched.
    expect(withRoomRoster(pool, [view("a", "primary")])).toBe(pool);
  });
});

describe("presenceRoster — the strip counts what the room control counts", () => {
  const owner = { name: "owner", isSelf: true };
  const guest = { name: "guest", isSelf: false };
  test("the reader is shown with the others, not left out", () => {
    const roster = presenceRoster([owner, guest], ["alice"]);
    expect(roster?.people).toEqual([owner, guest]);
    // Two people and one agent: the pill's 3, the strip's 3.
    expect((roster?.people.length ?? 0) + (roster?.agents.length ?? 0)).toBe(3);
  });
  test("alone with one agent is not a room", () => {
    expect(presenceRoster([owner], ["alice"])).toBeNull();
    expect(presenceRoster([owner], ["alice", "bob"])?.people).toEqual([owner]);
  });
});

describe("roomTargets — only the conversation's agents can be addressed", () => {
  const a = { instanceName: "olivier", agentId: "alice" };
  const b = { instanceName: "jerome", agentId: "bob" };
  const c = { instanceName: "lt-inst-0", agentId: "bench-0" };
  test("an agent outside the room is not a target", () => {
    expect(roomTargets([a, b, c], [a, b])).toEqual([a, b]);
  });
  test("the room not known yet: nothing is filtered away", () => {
    expect(roomTargets([a, c], null)).toEqual([a, c]);
  });
});
