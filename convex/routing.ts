// Routing resolver (multi-agent). Maps a CHAT to an OpenClaw target from the
// user's `userAgents` (M:N). The target returned is ALWAYS one the user is
// authorized for (∈ userAgents) — this is the dispatch-time authorization (IDOR
// defense). Legacy group/override routing has been REMOVED (single user, no
// migration); no userAgents => a clear "no_agent" failure, never a silent target.
//
// SECURITY: emits ONLY non-secret names — instanceName, agentId, canonical.
// Gateway tokens / device identities live in the bridge env, never here.

import { resolveAgentTypes } from "./lib/agentTypes";
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { getProfile } from "./lib/access";
import { normalizeEmail } from "./lib/authDomains";
import { getEffectiveGrants } from "./agents";

export interface ResolvedTarget {
  instanceName: string;
  agentId: string;
  canonical: string;
  /** The string that NAMES this person to the gateway, when it differs from the
   *  routing key. Absent ⇒ the canonical, which is what every instance sent before
   *  `instances.identitySource` existed. Never a session-key segment: the key must
   *  not move when an operator changes how people are named. */
  gatewayUser?: string;
  source: "chat-binding" | "user-default";
}

export interface ChatResolution {
  target: ResolvedTarget | null;
  /** When set, persist this binding onto the chat (unbound chat resolved to the
   *  default, OR the bound agent was deleted on the gateway → re-bind). */
  rebind: { instanceName: string; agentId: string } | null;
  /** `no_agent`: the user has no usable agent at all. `agent_restricted`: the
   *  chat is bound to an agent the user is NO LONGER entitled to (admin narrowed
   *  their set) — the chat is READ-ONLY, never silently re-routed to a different
   *  agent (the user's explicit choice). */
  failReason: "no_agent" | "agent_restricted" | null;
}

/** Is this (instance, agent) DELETED on the gateway? `agents.presentInLastOk` is
 *  set false ONLY by a SUCCESSFUL poll that omitted the agent (applyDiscovery,
 *  guarded on a non-empty result); a failed or never-run poll NEVER touches it
 *  (recordDiscoveryFailure leaves rows + presence intact). So `presentInLastOk
 *  === false` is reliable last-good knowledge of deletion that a later discovery
 *  outage must NOT erase (Codex P2): a blip must not resurrect a known-deleted
 *  agent. An ABSENT row = never discovered (unknown) => NOT deleted (serve the
 *  binding; the gateway arbitrates) — assignment only ever grants discovered
 *  agents anyway, and a present agent during a blip keeps presentInLastOk===true
 *  (so it is served, the stale-blip case). */
async function readAgentRow(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
) {
  return await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

async function isDeleted(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<boolean> {
  const agent = await readAgentRow(ctx, instanceName, agentId);
  return agent !== null && agent.presentInLastOk === false;
}

/** A UTILITY-ONLY agent (e.g. type "summarizer"/"documentary" without
 *  "conversational") must never be routable for user chats: the admin granted it
 *  for a dedicated Atrium action, not for conversation. An UNKNOWN row keeps the
 *  legacy default (conversational). */
async function isNonConversational(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<boolean> {
  const agent = await readAgentRow(ctx, instanceName, agentId);
  return (
    agent !== null && !resolveAgentTypes(agent.types).includes("conversational")
  );
}

/** The user's OpenClaw canonical (profile slug, or the stable u-<id> fallback) —
 *  the identity segment session keys AND health targets are scoped by. ONE source
 *  for the fallback expression (was duplicated across the two resolvers). */
export async function canonicalForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const profile = await getProfile(ctx, userId);
  return profile?.canonical ?? `u-${userId.slice(0, 10)}`;
}

export async function resolveTargetForChat(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
): Promise<ChatResolution> {
  // TWO different people can be involved in one dispatch, and they answer two
  // different questions.
  //
  //   WHOSE SESSION is this?  The chat OWNER's. `canonical` is a segment of the
  //   gateway session key, so resolving the SENDER's here would give a
  //   participant's turn a different key: the gateway would open a SECOND session
  //   and the group conversation would silently split in two, each half unaware of
  //   the other's messages.
  //
  //   WHO IS ALLOWED to dispatch?  The SENDER. Grants are checked against them
  //   below, unchanged. Being invited into a conversation must not hand anyone an
  //   agent an administrator never granted them — that is the same IDOR boundary
  //   this function has always been, and membership is not a grant.
  const canonical = await canonicalForUser(ctx, chat.userId);

  // Candidate set = the EFFECTIVE union (direct userAgents ∪ group agents), the
  // dispatch-time authorization boundary (IDOR defense). With NO groups this is
  // the direct `by_user` rows in the same order with the same effective default,
  // so the resolution below is byte-identical to pre-P2; a group-only user can
  // now dispatch, and a group-bound chat is honored by the membership check.
  // Deletion is applied here via isDeleted() (NOT via the enriched `state`),
  // preserving the exact pre-P2 "absent row + successful poll => still served"
  // semantics that `state` cannot reconstruct.
  const uas = await getEffectiveGrants(ctx, userId);
  // The conversational-type requirement protects USER chats from routing to a
  // utility-only agent. HIDDEN utility chats (documentary/summarizer) are bound to
  // exactly such agents BY DESIGN — exempt them (codex P1: the filter would mark
  // every dedicated documentary/summarizer dispatch agent_restricted).
  const requireConversational = chat.kind === undefined;
  // NOTE: no early `uas.length === 0 -> no_agent` shortcut. A chat bound to a
  // PRESENT agent the user is no longer entitled to must classify as
  // agent_restricted (read-only) EVEN when the admin removed the user's last grant
  // (uas empty) -- so the dispatch reason matches the UI's read-only state. The
  // bound block below handles that; pickFallback returns null for an empty uas, so
  // an unbound/gone chat still ends in `no_agent`.

  const asTarget = (
    u: { instanceName: string; agentId: string },
    source: ResolvedTarget["source"],
  ): ResolvedTarget => ({
    instanceName: u.instanceName,
    agentId: u.agentId,
    canonical,
    source,
  });

  // Pick a PRESENT fallback agent (Codex P2 — never route to a deleted agent):
  // the default if it isn't deleted, else the first non-deleted assigned agent.
  // null when ALL assigned agents are deleted → fail no_agent (never dispatch to
  // an absent agent, which is the prod "Agent X no longer exists" bug).
  const pickFallback = async (): Promise<(typeof uas)[number] | null> => {
    const ordered = [...uas].sort((a, b) =>
      a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1,
    );
    for (const u of ordered) {
      if (await isDeleted(ctx, u.instanceName, u.agentId)) continue;
      if (
        requireConversational &&
        (await isNonConversational(ctx, u.instanceName, u.agentId))
      )
        continue;
      return u;
    }
    return null;
  };

  // Bound chat: honor the binding unless membership was revoked or the agent was
  // deleted on the gateway.
  if (chat.instanceName && chat.agentId) {
    const member = uas.find(
      (u) => u.instanceName === chat.instanceName && u.agentId === chat.agentId,
    );
    if (member) {
      if (!(await isDeleted(ctx, member.instanceName, member.agentId))) {
        if (
          requireConversational &&
          (await isNonConversational(ctx, member.instanceName, member.agentId))
        ) {
          // Present but retyped UTILITY-ONLY: read-only, never silently re-routed
          // (the agent_restricted semantics).
          return { target: null, rebind: null, failReason: "agent_restricted" };
        }
        return {
          target: asTarget(member, "chat-binding"),
          rebind: null,
          failReason: null,
        };
      }
      // In the effective set but DELETED on the gateway → fall through to a
      // present fallback (the agent is gone, not restricted).
    } else {
      // NOT in the user's effective set. RESTRICTION (the agent is still PRESENT --
      // an admin narrowed the user's access -> READ-ONLY, never silently re-routed)
      // vs GONE: a purge (removeInstanceAgent deleted the row) OR a gateway deletion
      // (the row survives with presentInLastOk:false until a manual purge). Both
      // "gone" cases fall through to the fallback/rebind like any deleted agent, so
      // the restriction applies ONLY when the agent is present.
      const boundInstance = chat.instanceName;
      const boundAgent = chat.agentId;
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", boundInstance).eq("agentId", boundAgent),
        )
        .first();
      if (row !== null && row.presentInLastOk !== false) {
        return { target: null, rebind: null, failReason: "agent_restricted" };
      }
      // Gone (purged or gateway-deleted) -> fall through to a present fallback.
    }
  }

  // HIDDEN utility chats (documentary/summarizer) never fall back: their binding
  // IS the content boundary (the prompt carries conversation excerpts targeted at
  // THAT agent on THAT instance). A deleted/purged bound agent fails the job —
  // re-routing to an arbitrary remaining grant would cross an agent/instance
  // boundary the engine guarantees it never crosses (codex P2). The dispatch-fail
  // path releases the job lock with backoff.
  if (chat.kind !== undefined) {
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  const fb = await pickFallback();
  if (fb === null) {
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  const alreadyBound =
    chat.instanceName === fb.instanceName && chat.agentId === fb.agentId;
  return {
    target: asTarget(fb, "user-default"),
    rebind: alreadyBound
      ? null
      : { instanceName: fb.instanceName, agentId: fb.agentId },
    failReason: null,
  };
}

/**
 * Per-TURN routing for the multi-agent router: the user picks the agent for THIS turn.
 * `chosen === null` → byte-identical legacy chat routing (`resolveTargetForChat`), so a
 * single-agent chat — including a chat bound to a now-revoked agent — keeps its exact
 * read-only / fallback semantics. When a turn-agent IS chosen, it is validated against the
 * user's EFFECTIVE grants (the same dispatch-time IDOR boundary): not entitled →
 * `agent_restricted` (per-OPTION — the chat itself is not bound/read-only); deleted on the
 * gateway → `no_agent`; else → the target with NEVER a rebind (a per-turn chat has no
 * single binding to persist). The client-supplied `chosen` is therefore authorized here at
 * the trust boundary, not merely filtered in the composer.
 */
export async function resolveTargetForTurn(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<ChatResolution> {
  if (chosen === null) return resolveTargetForChat(ctx, chat, userId);

  // The chat OWNER's canonical — the session's identity. See resolveTargetForChat.
  const canonical = await canonicalForUser(ctx, chat.userId);
  const uas = await getEffectiveGrants(ctx, userId);
  const member = uas.find(
    (u) => u.instanceName === chosen.instanceName && u.agentId === chosen.agentId,
  );
  if (!member) {
    // The user is NOT entitled to the picked agent (admin never granted / revoked it).
    // Per-option restriction — never silently re-routed to a different agent.
    return { target: null, rebind: null, failReason: "agent_restricted" };
  }
  if (await isDeleted(ctx, member.instanceName, member.agentId)) {
    // Entitled but gone on the gateway (the composer should have filtered it out).
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  if (
    chat.kind === undefined &&
    (await isNonConversational(ctx, member.instanceName, member.agentId))
  ) {
    // A forged/stale pick of a utility-only agent — same per-option restriction.
    // (Hidden utility chats never route per-turn, but keep the exemption aligned.)
    return { target: null, rebind: null, failReason: "agent_restricted" };
  }
  return {
    target: {
      instanceName: member.instanceName,
      agentId: member.agentId,
      canonical,
      source: "user-default",
    },
    rebind: null,
    failReason: null,
  };
}

/**
 * WHICH STRING names this conversation's owner to their gateway.
 *
 * `undefined` means "the canonical", which is what every instance sent before
 * `instances.identitySource` existed — so a deployment that does not ask for
 * anything keeps a byte-identical send body and a byte-identical handshake.
 *
 * ONE derivation, deliberately: this value decides how a gateway attributes a
 * person, and every door that opens a person's socket must answer it the same
 * way. Two doors answering differently would name the same human two ways
 * depending on which request happened to open the socket first — the gateway
 * would hold two profiles for them, and which one you got would depend on
 * whether you compacted before you sent.
 *
 * The address is read ONLY when the operator asked for it: it leaves Atrium in a
 * request header, which is a deliberate choice about naming, never a default. A
 * profile with no address falls back to the canonical rather than naming nobody.
 *
 * WHICH copy of the address, and why it matters here specifically. Atrium keeps two:
 * the `users` row, which the auth library rewrites from the provider's claims on
 * EVERY sign-in, and `profiles.email`, which `ensureProfile` fills only when MISSING
 * and never overwrites (the display value an administrator sees, deliberately stable).
 * For every other purpose the profile copy is the right one. Not for this one: the
 * proxy in front of the gateway injects whatever the provider says TODAY, so reading
 * the frozen copy would name a person by an address they no longer have — and
 * recreate the very second profile this setting exists to prevent, silently, for
 * exactly the people who changed their name.
 */
export async function resolveGatewayUser(
  ctx: QueryCtx | MutationCtx,
  args: {
    instanceName: string;
    ownerUserId: Id<"users">;
    canonical: string;
    /** The already-read instance row, when the caller holds one (the dispatch
     *  path does) — avoids a second read of the same document. */
    instance?: Doc<"instances"> | null;
  },
): Promise<string | undefined> {
  const instance =
    args.instance !== undefined
      ? args.instance
      : ((await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", args.instanceName))
          .first()) ?? null);
  if (
    instance?.authMode !== "trusted-proxy" ||
    instance.identitySource !== "email"
  ) {
    return undefined;
  }
  const user = await ctx.db.get(args.ownerUserId);
  const current = typeof user?.email === "string" ? user.email : undefined;
  const profile = current === undefined ? await getProfile(ctx, args.ownerUserId) : null;
  // NORMALIZED, so the two sources cannot disagree with each other. The providers
  // normalize what they write to the `users` row; `profiles.email` keeps whatever
  // its issuer stated, because it is the display value. Emitting one or the other
  // raw would make the same person's name depend on which copy happened to be
  // available — different strings in the header, in a log, in an operator's head.
  //
  // Not a duplicate-profile fix: the gateway lowercases an identity before
  // resolving it (upstream `normalizeEmail`, reached from `ensureProfileForEmail`
  // on both the WS connect and HTTP paths, v2026.9.2), so `Alice@Example.org` and
  // `alice@example.org` already land on ONE profile. This is about Atrium stating
  // one string, not about repairing a split.
  return (
    normalizeEmail(current ?? profile?.email ?? undefined) ?? args.canonical
  );
}

/**
 * WHICH agent is this chat engaged with RIGHT NOW, and on WHICH gateway
 * conversation — the per-turn precedence, stated ONCE.
 *
 * A per-turn routed chat has no single binding, so every consumer that must name
 * "the agent the next/current turn talks to" has to reconstruct it. Two of them
 * did, separately, and they disagreed: the health/capacity read consulted the
 * OUTBOX, while the Talk lanes read only the last CONFIRMED tuple — so during a
 * switch (or after a failed one) voice addressed the previous agent while text
 * addressed the new one.
 *
 * THE EVIDENCE, newest first. Each entry names an agent (or `null` = the chat's
 * primary binding) together with the conversation THAT agent is on. It is read as a
 * statement about the chat's CURRENT addressee, not as history: an entry naming no
 * agent is re-read against the binding in force NOW, which is what the dispatch does
 * with a null choice. (`bindChatTarget` clears `openclawChatId` when it moves a
 * binding, so a new agent cannot inherit the previous one's conversation that way.)
 *
 *   1. the LAST SEND: `pending` (being dispatched now) outranks the newest of
 *      `sent`/`failed` — a failed switch is exactly the window where `lastRouted*`
 *      never advanced while the composer and the retry stayed on the new agent.
 *      NOT `queued`: a queued follow-up describes a FUTURE turn. Its conversation
 *      is the EPHEMERAL segment `beginTurnRouting` stamps on that very row
 *      (`dispatchSegment`), because the chat's confirmed segment must not advance
 *      before the ack;
 *   2. the last CONFIRMED tuple, on `chat.routingSegment`;
 *   3. the primary binding, on `chat.openclawChatId`.
 *
 * `explicit` — a caller that already knows which agent it means (the composer's
 * current selection) — does NOT replace that chain: it SELECTS from it. The agent
 * is the caller's, and the conversation is the newest evidence naming that SAME
 * agent. Replacing the chain instead was a real defect: the composer's selection is
 * the thread's effective agent, not "a pick never sent", so passing it hid the very
 * outbox row that knew the conversation — the voice session then opened
 * `<agent>:<chatId>` while the turn in flight used `<agent>:turn:<n>`.
 *
 * Equally, a row whose `dispatchSegment` is not stamped yet does not mean the agent
 * has NO conversation: if an older piece of evidence names the same agent, that is
 * its conversation. `null` is answered only when nothing in the chain knows one —
 * an agent this chat has genuinely never run.
 *
 * `agent` is a CANDIDATE, not an authorization: hand it to `resolveTargetForTurn`,
 * which validates it against the user's effective grants.
 */
export interface CurrentTurnRouting {
  /** null = this turn addresses the chat's primary binding. */
  agent: { instanceName: string; agentId: string } | null;
  /** The gateway conversation THAT agent is on; null when it has none yet. */
  conversation: string | null;
}

type AgentRef = { instanceName: string; agentId: string };

export async function currentTurnRouting(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  explicit: AgentRef | null = null,
): Promise<CurrentTurnRouting> {
  const bound = chat.openclawChatId ?? null;
  // WHICH SEND IS THE LATEST is a question about DISPATCH, not about insertion, and
  // `pendingSince` is the moment a row entered dispatch — so that is what this
  // orders by. Rows without one fall back to their creation.
  //
  // WHAT THIS IS NOT: a fix for a defect anyone can reach today. `outboxQueue` keeps
  // ONE send in flight per chat and drains the rest FIFO, so for a single chat the
  // two orderings currently agree, and every producer stamps `pendingSince` when it
  // promotes a row to `pending`. This states the rule the answer actually depends on
  // instead of relying on that coincidence: the day the queue gains a priority lane,
  // a retry that re-dispatches an older row, or an import writes rows without the
  // stamp, insertion order would quietly start answering the wrong agent — and the
  // failure would look like a routing bug, not a sort.
  const DISPATCH_WINDOW = 10;
  const dispatchedAt = (r: Doc<"outbox">): number =>
    r.pendingSince ?? r._creationTime;
  const newestByDispatch = (rows: Doc<"outbox">[]): Doc<"outbox"> | null =>
    rows.length === 0
      ? null
      : rows.reduce((a, b) => (dispatchedAt(b) > dispatchedAt(a) ? b : a));
  const [pendingRows, sentRows, failedRows] = await Promise.all(
    (["pending", "sent", "failed"] as const).map((status) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chat._id).eq("status", status),
        )
        .order("desc")
        .take(DISPATCH_WINDOW),
    ),
  );
  const pendingRow = newestByDispatch(pendingRows);
  const lastAttempt = newestByDispatch([...sentRows, ...failedRows]);
  const lastSend = pendingRow ?? lastAttempt;

  const evidence: CurrentTurnRouting[] = [];
  if (lastSend) {
    evidence.push(
      lastSend.routedAgent
        ? {
            agent: lastSend.routedAgent,
            conversation: lastSend.dispatchSegment ?? null,
          }
        : { agent: null, conversation: bound },
    );
  }
  if (chat.lastRoutedInstanceName && chat.lastRoutedAgentId) {
    evidence.push({
      agent: {
        instanceName: chat.lastRoutedInstanceName,
        agentId: chat.lastRoutedAgentId,
      },
      conversation: chat.routingSegment ?? null,
    });
  }
  evidence.push({ agent: null, conversation: bound });

  const agent = explicit ?? evidence[0].agent;
  // `null` (the primary binding) matches evidence that names no agent AND evidence
  // that names the bound agent explicitly — they are the same addressee.
  const isBinding = (a: AgentRef | null): boolean =>
    a === null ||
    (a.instanceName === chat.instanceName && a.agentId === chat.agentId);
  const names = (e: CurrentTurnRouting): boolean =>
    agent === null
      ? isBinding(e.agent)
      : e.agent === null
        ? isBinding(agent)
        : e.agent.instanceName === agent.instanceName &&
          e.agent.agentId === agent.agentId;
  const known = evidence.find((e) => names(e) && e.conversation !== null);
  return { agent, conversation: known?.conversation ?? null };
}
