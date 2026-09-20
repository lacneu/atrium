// Realtime voice ("talk") — SLICE 2: mint a gateway-owned ephemeral browser
// session for a chat's instance.
//
// Flow: the browser calls `mintTalkSession({chatId})` (public action) -> the
// prepare query resolves the target from owned state (requireOwnedChat + the chat's
// own routing) and applies the admin gate (integrationConfig.talk.enabled, default
// OFF) -> the action POSTs the instance's bridge /talk-session ->
// the bridge calls gateway `talk.client.create` -> the SHORT-LIVED provider
// clientSecret is relayed to the authenticated owner.
//
// SECURITY:
//  - the gateway holds the provider API key and mints the ephemeral secret;
//    this deployment NEVER sees a long-lived provider credential;
//  - the clientSecret is returned to the caller and NEVER logged/persisted;
//  - graceful degradation for every OPERATIONAL failure ({ok:false, code}): a throw
//    would surface to the browser as an opaque failure with no code to act on, and
//    each of these outcomes has a specific thing for the UI to say. Authorization
//    gates still REJECT the action (that is what `requireOwnedChat` does); the
//    control catches that and turns it into a generic code, so the button never
//    leaves the panel mid-connect.
//
// WHAT THE CLIENT MAY NAME. Two things, and neither is trusted: the agent it wants
// (the composer's selection — AUTHORIZED against the effective grants by
// resolveTargetForTurn, the dispatch's own boundary) and the ID of a handle for the
// session a mid-call consult belongs to (a `talkSessions` row, checked against the
// caller, the chat and the clock, and whose agent is re-authorized on every use).
// The conversation and the canonical are never named by the client: they are read
// from that row, which the SERVER wrote at mint.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  requireActive,
  requireOwnedChat,
  requireReachableChat,
  requireUserId,
} from "./lib/access";
import {
  currentTurnRouting,
  resolveGatewayUser,
  resolveTargetForTurn,
} from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { drainNextQueued } from "./lib/outboxQueue";
import { turnInFlightForOtherAgent } from "./lib/talkFreeze";
import { capabilitiesForInstance } from "./lib/compat";
import { capabilityOf } from "../src/chat/capabilities";
import { readDoc as readCompatDoc } from "./compat";
import { parseTalkSessionResponse, type TalkSession } from "./lib/talk";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Is realtime voice OFFERED on this chat? Drives the composer button's
 * VISIBILITY (the gateway-version capability alone is not enough — the admin
 * enables talk PER INSTANCE, and a disabled instance must show no button at
 * all, not a button that errors on click). Reactive: flipping the instance
 * switch adds/removes the button live. SOFT on every failure (false) — a
 * visibility probe must never crash the composer.
 */
export const talkAvailable = query({
  args: {
    chatId: v.id("chats"),
    // The agent the COMPOSER currently targets. A user can pick another agent and
    // press the voice button before sending anything — without this the session
    // would be minted for the agent the THREAD last engaged, and agents differ in
    // instructions, tools and access. Authorized server-side by resolveTargetForTurn
    // (the dispatch's own boundary), so a forged value can never reach an instance
    // the caller is not granted.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }): Promise<boolean> => {
    try {
      const { userId } = await requireActive(ctx);
      // OWNER-ONLY, like the mint (`requireOwnedChat`). A participant who saw the
      // button would get an action that refuses: the control recovers (the mint call
      // is guarded), but the button is dead, which is worse than absent.
      const chat = await requireOwnedChat(ctx, userId, chatId);
      // The SAME resolution the mint uses: on a per-turn routed chat the button
      // must reflect the instance the session would really reach, not the chat's
      // primary binding (talk is enabled per instance).
      const routing = await resolveTalkRouting(
        ctx,
        chat,
        userId,
        routedAgent ?? null,
      );
      if (routing === null) return false;
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", routing.target.instanceName))
        .first();
      if (instance?.kind === "hermes" || instance?.config?.talkEnabled !== true) {
        return false;
      }
      // …AND the gateway must actually expose the surface. This is read HERE, for the
      // instance this session would reach, because `compat.forChat` answers about the
      // chat AS IT STANDS: with no explicit selection it prefers `chat.instanceName`
      // over the resolver, so a chat whose bound agent is gone and which now falls
      // back to another instance would be described by the OLD one — hiding a button
      // that works, or offering one that cannot.
      //
      // FAIL CLOSED, the standing policy for talk: no snapshot, no target row, or no
      // capability map means NO button. A legacy bridge is assumed to have the
      // historic surface and nothing newer (LEGACY_CAPABILITIES), and a button on a
      // gateway without `talk.client.create` hard-fails at the mint.
      const compat = await readCompatDoc(ctx);
      if (compat === null) return false;
      const caps = capabilitiesForInstance(
        compat.targets,
        routing.target.instanceName,
      );
      if (caps === null) return false; // the instance is not in the snapshot
      // Through the TYPED gate, never the raw key: a capability spelled in a string
      // survives a rename by going silently false (capabilityAccess.test.ts). Note
      // that `capabilityOf` treats a null map as the LEGACY set, which does not
      // include talk — the fail-closed answer this wants.
      return capabilityOf(caps.capabilities, "talk");
    } catch {
      return false;
    }
  },
});

/**
 * WHICH agent owns this chat's voice session, and WHICH gateway conversation it
 * must land in — the two facts every Talk lane needs, resolved in ONE place.
 *
 * All three lanes previously read `resolveTargetForChat` + `chat.routingSegment`
 * side by side, which disagrees with the TYPED-turn path:
 *
 *  - the AGENT came from the chat's PRIMARY binding while the segment came from
 *    whatever the thread last routed. A chat bound to alice whose turns go to bob
 *    minted `agent:alice:…:<bob's segment>` — one agent's name over another
 *    agent's conversation, and a POST to alice's instance when bob lives on a
 *    different gateway;
 *  - on a REBIND (the bound agent GONE from the gateway — a revoked but present
 *    agent is `agent_restricted` instead, with no rebind) `chat.openclawChatId` is the
 *    OLD agent's provider conversation. convex/bridge.ts drops it for exactly that
 *    reason; carrying it would point the new agent at a session that is not its
 *    own.
 *
 * `currentTurnRouting` answers both halves from ONE source, so voice, text and the
 * capacity gauge agree — including mid-switch, after a FAILED switch, and for a
 * composer selection the user has not sent yet (`explicit`).
 *
 * WHEN THAT SOURCE HAS NO CONVERSATION (an agent nothing has run for yet), the
 * answer stays null and the bridge keys on the chat id. It is deliberately NOT
 * `chat.openclawChatId`: that id belongs to whichever agent the chat was bound to,
 * and borrowing it is the very mixing this resolution exists to prevent. DECLARED
 * LIMIT: this voice session is then its own conversation — the first typed turn to
 * that agent will mint `turn:<turnId>` through beginTurnRouting, which no read can
 * predict. Sharing a conversation with a turn that does not exist yet would require
 * the mint to allocate the segment itself, which is a routing change, not this fix.
 *
 * `null` = no routable agent (the callers answer `no_agent`).
 */
async function resolveTalkRouting(
  ctx: QueryCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
  explicit: { instanceName: string; agentId: string } | null = null,
): Promise<{
  target: { instanceName: string; agentId: string; canonical: string };
  openclawChatId: string | null;
} | null> {
  const current = await currentTurnRouting(ctx, chat, explicit);
  const res = await resolveTargetForTurn(ctx, chat, userId, current.agent);
  if (!res.target) return null;
  return {
    target: res.target,
    // The conversation THAT source named, verbatim — except on a REBIND, where it
    // is the bound id of an agent that is gone and the dispatch drops it too.
    openclawChatId: res.rebind ? null : current.conversation,
  };
}

/**
 * How long a voice handle stays valid.
 *
 * NOT the gateway's `expiresAt`: that expires the connection SECRET, and a WebRTC
 * connection already established outlives it — taking the handle down with it would
 * drop a legitimately live conversation's consult back into the thread's routing.
 * And not an end-of-call boundary either: nothing invalidates a row when the user
 * hangs up. It is a hard ceiling on how long a handle can address its session,
 * generous enough to cover a long call; expiry does not end anything, it only stops
 * the handle from answering.
 */
const TALK_HANDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Upper bound on how long a call can still be up when nobody said it ended: the
 *  gateway's own realtime session TTL (OPENAI_QUICKSILVER_SESSION_TTL_MS,
 *  v2026.9.5). A browser that crashed never sends its hangup, so "live" has to
 *  expire on its own — and this is the instant past which the gateway has dropped
 *  the call anyway. */
export const TALK_CALL_MAX_MS = 30 * 60 * 1000;
/** …and the call's clock starts when the OFFER is spent, not at the mint: the
 *  gateway arms its TTL at allocation, up to the relay handle's 60 s later. The
 *  freeze window adds that, so it can never end a minute BEFORE the call does
 *  (codex P2). It only ever over-holds, and only for a browser that crashed. */
export const TALK_CALL_WINDOW_MS = TALK_CALL_MAX_MS + 60_000;

/**
 * The call this CHAT is on right now, or null. "Live" = recorded, not ended by its
 * owner, and still inside the window the gateway could still be holding it.
 *
 * KEYED BY CHAT, not by caller. Only the owner can mint a call, but a PARTICIPANT
 * may post in the same conversation — and their turn re-keys the very socket the
 * owner's call is bound to. Filtering by the asking user found nothing for a
 * participant and let them switch the agent out from under a live call (codex P1).
 * The call belongs to the conversation; so does the freeze.
 */
export async function liveTalkCall(
  ctx: QueryCtx,
  chatId: Id<"chats">,
): Promise<Doc<"talkSessions"> | null> {
  const now = Date.now();
  // `endedAt` is part of the index KEY: this reads the chat's UNENDED rows only.
  // Reading the newest 20 of the chat and filtering afterwards was wrong — twenty
  // calls made and hung up since would push the live one out of the read and answer
  // "no call" while someone was speaking (codex P1, pass 2).
  const rows = await ctx.db
    .query("talkSessions")
    .withIndex("by_chat_live", (q) =>
      q.eq("chatId", chatId).eq("endedAt", undefined),
    )
    .order("desc")
    .take(20);
  // The newest live one wins: a second mint on the same chat supersedes the first.
  return rows.find((r) => r.createdAt + TALK_CALL_WINDOW_MS > now) ?? null;
}

/**
 * Is THIS chat on a call right now — as the SERVER sees it?
 *
 * The composer knew only what its own TalkControl told it, which is nothing after a
 * reload and nothing in a second tab. The selector then looked open, and the send
 * came back `TALK_CALL_ACTIVE`: the freeze was enforced but never explained. Read
 * here so the control is greyed out with its hint before anyone clicks.
 *
 * SOFT on every failure, like `talkAvailable`: a probe must never crash the composer.
 *
 * OWNER OR PARTICIPANT, unlike the mint. Only the owner can START a call, so the
 * BUTTON is owner-only — but the FREEZE is keyed by chat and refuses a participant's
 * send too. Answering them `{active:false}` left the selector open on the one path
 * the identity fix was written for, and handed them the raw refusal instead of the
 * sentence (codex P2, pass 4). They can already read every message in this
 * conversation; that it is being spoken in is not a smaller fact.
 */
export const chatCallState = query({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{
    active: boolean;
    instanceName?: string;
    agentId?: string;
    /** The row to hang up — FOR THE OWNER ONLY.
     *
     *  Carried so a tab that owns no call can still END the one the server sees:
     *  after a reload, or a browser that crashed mid-call, nothing in this tab knows
     *  the session, and the freeze was visible but not clearable for the whole
     *  window. Withheld from a participant because `prepareTalkHangup` authorizes by
     *  ROW ownership and would refuse them: handing it over rendered a hangup button
     *  whose every click failed silently through three retries (codex P2, pass 9).
     *  They still get `active` and the agent's name — what they need is the reason
     *  their send was refused, which the send's own message gives them. */
    sessionId?: Id<"talkSessions">;
  }> => {
    try {
      const { userId } = await requireActive(ctx);
      // Throws for a stranger; the catch below turns that into `{active:false}`.
      const { role } = await requireReachableChat(ctx, userId, chatId);
      const call = await liveTalkCall(ctx, chatId);
      return call === null
        ? { active: false }
        : {
            active: true,
            instanceName: call.instanceName,
            agentId: call.agentId,
            // Only the owner can act on it — see the field's note.
            ...(role === "owner" ? { sessionId: call._id } : {}),
          };
    } catch {
      return { active: false };
    }
  },
});

/**
 * Tell the bridge to drop a session it minted but Convex never recorded.
 *
 * The SAME wire call the hangup makes, without any of the row work: there IS no row,
 * which is the whole problem. Best-effort and silent — the caller is already failing
 * the mint, the bridge's hold expires on its own, and a bridge that cannot be reached
 * must not turn one failure into two.
 */
async function abandonMintedSession(
  prep: { instanceName: string; canonical: string; agentId: string; openclawChatId: string | null },
  chatId: Id<"chats">,
  bridgeUrl: string,
  voiceSessionId: string | null,
): Promise<void> {
  const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
  if (voiceSessionId === null || !sharedSecret) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TALK_HANGUP_TIMEOUT_MS);
  try {
    await fetch(`${bridgeUrl.replace(/\/$/, "")}/talk-hangup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: sharedSecret },
      body: JSON.stringify({
        instanceName: prep.instanceName,
        chatId,
        ...(prep.openclawChatId !== null ? { openclawChatId: prep.openclawChatId } : {}),
        canonical: prep.canonical,
        agentId: prep.agentId,
        voiceSessionId,
      }),
      signal: controller.signal,
    });
  } catch {
    // Nothing to do and nothing to say: the hold expires on its own.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is THIS call — the one this tab holds a handle for — still live?
 *
 * Keyed on the SESSION, not on the chat, and that is the whole point. Asking about
 * the chat gave an answer that could predate this tab's own mint, so a tab had to
 * first observe its call appear before it could trust its disappearance — and a tab
 * that never saw the intermediate state (suspended, reconnecting, a coalesced
 * update) could then never react to being hung up from elsewhere. On the direct lane
 * nothing else can end its media, so it kept talking to one agent while the server,
 * seeing no call, let another tab route the conversation to a second one (codex P1,
 * pass 16 — a hole opened by the very guard that closed the earlier race).
 *
 * A subscription on this id can only start once the id exists, which is after the row
 * was committed. So `false` is never "not yet": it is ended, gone, or past the window.
 *
 * SOFT on failure, but the OTHER WAY from the probes above: a false answer tears down
 * a live call, so anything unexpected answers `true` — keep talking, and let the
 * ordinary paths refuse whatever must be refused.
 */
export const talkCallLive = query({
  args: { sessionId: v.id("talkSessions") },
  handler: async (ctx, { sessionId }): Promise<boolean> => {
    try {
      const userId = await requireUserId(ctx);
      const row = await ctx.db.get(sessionId);
      if (row === null) return false;
      if (row.userId !== userId) return true; // not ours to judge
      return (
        row.endedAt === undefined &&
        row.createdAt + TALK_CALL_WINDOW_MS > Date.now()
      );
    } catch {
      return true;
    }
  },
});

/** Mark a call ended. Idempotent: a retry, or a hangup racing an unmount, must not
 *  rewrite the instant the user stopped speaking. */
export const markTalkSessionEnded = internalMutation({
  args: { sessionId: v.id("talkSessions") },
  handler: async (ctx, { sessionId }): Promise<void> => {
    const row = await ctx.db.get(sessionId);
    if (row === null || row.endedAt !== undefined) return;
    await ctx.db.patch(sessionId, { endedAt: Date.now() });
    // WAKE THE QUEUE. A turn for another agent, accepted before the call started,
    // is HELD by the drain while the call is up (lib/talkFreeze). The end of the
    // call is the moment it becomes dispatchable, and nothing else would notice:
    // the ordinary drain fires on a turn ending, and a held row has no turn to end.
    // Without this the message would wait for the next unrelated turn — or, on a
    // quiet chat, for the freeze window to expire.
    await drainNextQueued(ctx, row.chatId);
  },
});

/**
 * Record the session a successful mint opened, and hand back the only thing the
 * browser needs to hold.
 *
 * WHAT THE ROW PROVES, exactly: that a mint SUCCEEDED with this address. It does not
 * prove a call is up — the microphone, the SDP exchange or the connection can still
 * fail afterwards — and nothing invalidates it on hang-up. That is why the consult
 * re-authorizes what the row names rather than trusting it wholesale, and why the
 * row carries a hard expiry.
 *
 * `canonical` is stored with the rest because it is the THIRD component of the
 * gateway session key: a profile whose canonical changes mid-call would otherwise
 * make the consult address a different session than the one on the line.
 *
 * Expired rows are swept here, bounded; a scheduled janitor does the rest, since a
 * deployment that stops minting would otherwise keep its last expired rows forever.
 */
export const recordTalkSession = internalMutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    canonical: v.string(),
    conversation: v.string(),
    // The gateway's id for the logical voice session, and whether the bridge kept
    // the secret (GPT Live). Both come from the mint the bridge just answered; the
    // hangup reads them back off THIS row, never off the browser.
    voiceSessionId: v.optional(v.string()),
    relayed: v.optional(v.boolean()),
    bridgeUrl: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { chatId, instanceName, agentId, canonical, conversation, voiceSessionId, relayed, bridgeUrl },
  ): Promise<Id<"talkSessions">> => {
    const { userId } = await requireActive(ctx);
    // RE-CHECK EVERY AUTHORIZATION AND GATE AT THE WRITE. The prepare, the POST and
    // this mutation are three moments, and the credential is only handed to the
    // browser after this one returns. The canonical and the conversation are NOT
    // re-derived — pinning what the mint used is the whole point of the row; what is
    // re-checked is the right to be talking to this agent at all. A grant revoked, an agent deleted or retyped
    // utility-only, or talk switched off on the instance BETWEEN the prepare and
    // here would otherwise still hand out a working voice session — the consult
    // would be blocked afterwards, far too late. Throwing here fails the mint
    // closed: the caller answers `talk_session_unrecorded`, the secret is never
    // relayed, and the orphaned gateway session expires on its own.
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const still = await resolveTargetForTurn(ctx, chat, userId, {
      instanceName,
      agentId,
    });
    if (
      !still.target ||
      still.target.instanceName !== instanceName ||
      still.target.agentId !== agentId
    ) {
      throw new Error("talk target no longer authorized");
    }
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    if (instance?.kind === "hermes" || instance?.config?.talkEnabled !== true) {
      throw new Error("talk no longer enabled on this instance");
    }
    // AND RE-ASK THE FREEZE, HERE, WHERE THE WRITE HAPPENS.
    //
    // `prepareTalkSession` already refused a mint that would switch agent — but that
    // is a QUERY, taken before the POST. The bridge's own reservation closes the race
    // inside ONE bridge process; two tabs minting on two DIFFERENT instances reach two
    // different bridges, whose registries know nothing of each other, and both mints
    // succeeded. The chat then carried two live calls on two agents, and `liveTalkCall`
    // answered with the newest — so typed turns left the person still speaking to the
    // other one (codex P1, pass 6).
    //
    // This is a MUTATION, and it READS the very index range it INSERTS into
    // (`by_chat_live`, this chat's unended rows). Two concurrent records therefore
    // conflict under Convex's serializable OCC: one retries, sees the other's row, and
    // refuses. That is the serialization no bridge-local reservation can give.
    //
    // Refusing here FAILS THE MINT CLOSED, the path this handler already documents:
    // the caller answers `talk_session_unrecorded`, the secret is never relayed, and
    // the orphaned gateway session expires on its own.
    const concurrent = await liveTalkCall(ctx, chatId);
    if (
      concurrent !== null &&
      (concurrent.instanceName !== instanceName || concurrent.agentId !== agentId)
    ) {
      throw new Error("talk call already active on another agent");
    }
    // …AND THE MIRROR: a turn already on its way to another agent. The send's last
    // check and its POST cannot be one transaction, and when the two sit on different
    // instances they sit on different bridge processes — so the socket-in-hand
    // refusal that catches every same-bridge case never runs, and the turn lands on
    // one agent while this call runs on another (codex P1, pass 17). The mint gives
    // way: pressing the button again a moment later costs far less than a split
    // conversation.
    if (await turnInFlightForOtherAgent(ctx, chat, { instanceName, agentId })) {
      throw new Error("a turn is already on its way to another agent");
    }
    const now = Date.now();
    // THE SAME helper the janitor uses. This purge deleted expired rows silently, so
    // a mint in ANY chat could remove the row that was freezing another one — and the
    // janitor would never see it again, leaving that chat's queue stopped for good
    // (codex P1, pass 9). A deletion that lifts a freeze wakes its queue, wherever it
    // happens.
    await deleteExpiredHandles(ctx, 20);
    const sessionId = await ctx.db.insert("talkSessions", {
      userId,
      chatId,
      instanceName,
      agentId,
      canonical,
      conversation,
      ...(voiceSessionId !== undefined ? { voiceSessionId } : {}),
      ...(relayed !== undefined ? { relayed } : {}),
      ...(bridgeUrl !== undefined ? { bridgeUrl } : {}),
      createdAt: now,
      expiresAt: now + TALK_HANDLE_TTL_MS,
      // STAMPED HERE, because the marker is armed right below. Without it the first
      // hold saw no stamp and armed a SECOND marker a second later — idempotent, but
      // a write and a scheduled run per blocking call for nothing (codex P3, pass 10).
      windowDrainScheduled: true,
    });
    // ARM THE END OF THE WINDOW, at the mint, for every call.
    //
    // A call that is never hung up (a browser that crashed) stops being live when the
    // window runs out — but only in the eyes of a query that runs again. Nothing
    // WROTE at that instant, so two readers stayed wrong indefinitely: a turn held by
    // the drain waited for an unrelated turn that never came on a quiet chat, and the
    // composer's live subscription kept the selector greyed out on a call that ended
    // half an hour ago (codex P1 + P2, pass 3). `markTalkSessionEnded` is idempotent
    // and drains the queue, so a real hangup landing first simply makes this a no-op.
    await ctx.scheduler.runAt(
      now + TALK_CALL_WINDOW_MS,
      internal.talk.markTalkSessionEnded,
      { sessionId },
    );
    return sessionId;
  },
});

/** Scheduled sweep: the opportunistic one only runs when someone mints, so a quiet
 *  deployment would keep its last expired handles indefinitely. Bounded per run. */
/**
 * Delete expired handles, and WAKE the queues those deletions just unfroze.
 *
 * Deleting a row that was never ended lifts the freeze, so a turn held behind it has
 * to be told — otherwise it waits for an unrelated turn that never comes on a quiet
 * chat, and since a queued row makes the chat busy, every later send waits with it
 * (codex P1, pass 8). Ended rows froze nothing and are skipped.
 *
 * SCHEDULED, never drained inline. A drain promotes a row and reads up to fifty of
 * its chat's messages; doing that for two hundred chats inside the delete mutation
 * could cross Convex's per-transaction read limit, and the whole mutation — deletions
 * included — would roll back. The hourly cron would then retry the same two hundred
 * rows forever, deleting nothing and waking nobody (codex P1, pass 9). One scheduled
 * mutation per chat keeps each drain in its own transaction.
 */
async function deleteExpiredHandles(
  ctx: MutationCtx,
  limit: number,
): Promise<number> {
  const stale = await ctx.db
    .query("talkSessions")
    .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
    .take(limit);
  const unfrozen = new Set(
    stale.filter((r) => r.endedAt === undefined).map((r) => r.chatId),
  );
  for (const row of stale) await ctx.db.delete(row._id);
  for (const chatId of unfrozen) {
    await ctx.scheduler.runAfter(0, internal.talk.drainAfterCallWindow, {
      chatId,
    });
  }
  return stale.length;
}

/** The scheduled drain of a chat whose freeze a deletion just lifted. An ordinary
 *  drain, in its own transaction — which is the whole point. */
export const drainAfterCallWindow = internalMutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<void> => {
    await drainNextQueued(ctx, chatId);
  },
});

export const sweepTalkSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; ended: number }> => {
    // FIRST, end the calls whose window is over but which nobody ended.
    //
    // A call minted from this version ends itself (the marker armed at the mint), and
    // one holding a queued turn is ended by the hold's own arming. A row that predates
    // this lot on a QUIET chat has neither: nothing writes at 31 minutes, so a
    // composer already subscribed keeps its selector frozen — on a call that has been
    // over for an hour — until the handle's two-hour TTL (codex P2, pass 12). Ending
    // it here IS the write that re-evaluates that subscription.
    // BOUNDED WELL BELOW the deletion pass, because each of these costs a write AND a
    // scheduled drain, and the two passes share one transaction. Draining inline
    // already blew that budget once (codex P1, pass 9) — this is the same shape and
    // gets the same caution. The volume is tiny by construction: a call minted from
    // this version ends itself, so what lands here is a row that predates the lot or
    // one whose own marker never ran. Anything beyond the cap waits an hour.
    const cutoff = Date.now() - TALK_CALL_WINDOW_MS;
    const overdue = await ctx.db
      .query("talkSessions")
      .withIndex("by_live_created", (q) =>
        q.eq("endedAt", undefined).lt("createdAt", cutoff),
      )
      .take(50);
    const now = Date.now();
    for (const row of overdue) {
      await ctx.db.patch(row._id, { endedAt: now });
      // Same pairing as a deletion that lifts a freeze: the write re-evaluates the
      // composer's subscription, and the queue is woken in its own transaction.
      await ctx.scheduler.runAfter(0, internal.talk.drainAfterCallWindow, {
        chatId: row.chatId,
      });
    }
    const deleted = await deleteExpiredHandles(ctx, 200);
    return { deleted, ended: overdue.length };
  },
});

const TALK_MINT_TIMEOUT_MS = 50_000; // cold gateway connect (30s) + mint

type PrepareResult =
  | {
      ok: true;
      instanceName: string;
      bridgeUrl: string | null;
      transport: string;
      /** Session-key ingredients for the OWNING agent — see the prepare below. */
      agentId: string;
      canonical: string;
      openclawChatId: string | null;
      /** What the gateway calls this person, when the instance names people by
       *  something other than the routing key. The bridge opens the conversation's
       *  socket AS this person (a gateway-owned voice call runs under that identity),
       *  so it must be the SAME string a typed turn uses — the dispatch's own
       *  derivation, not a second one. */
      gatewayUser?: string;
    }
  | { ok: false; code: string };

/** Ownership + per-instance gate + routing resolution (query ctx owns the db). */
export const prepareTalkSession = internalQuery({
  args: {
    chatId: v.id("chats"),
    // The agent the COMPOSER currently targets. A user can pick another agent and
    // press the voice button before sending anything — without this the session
    // would be minted for the agent the THREAD last engaged, and agents differ in
    // instructions, tools and access. Authorized server-side by resolveTargetForTurn
    // (the dispatch's own boundary), so a forged value can never reach an instance
    // the caller is not granted.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }): Promise<PrepareResult> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const routing = await resolveTalkRouting(
      ctx,
      chat,
      userId,
      routedAgent ?? null,
    );
    if (routing === null) return { ok: false, code: "no_agent" };
    const target = routing.target;
    // A SECOND mint is a turn like any other: minting for another agent re-keys the
    // bridge's one socket for this chat and closes the socket the first call is
    // bound to — the very cut this freeze exists to prevent, reachable from a second
    // tab without touching the composer the freeze greys out (codex P1, pass 2).
    // Re-minting the SAME agent stays allowed: that is a reconnect, not a switch.
    const live = await liveTalkCall(ctx, chatId);
    if (
      live !== null &&
      (live.instanceName !== target.instanceName || live.agentId !== target.agentId)
    ) {
      return { ok: false, code: "call_active" };
    }
    // …and the MIRROR, asked early. `recordTalkSession` asks it again at the write,
    // which is where the answer is binding — but only after a session has been minted
    // on the gateway and then abandoned, and the caller learns that as the generic
    // "could not record" (codex P3, pass 18). Asking here spends nothing and lets the
    // reader be told what actually happened.
    if (await turnInFlightForOtherAgent(ctx, chat, target)) {
      return { ok: false, code: "turn_in_flight" };
    }
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    // Hermes has no talk surface (capability-gated in the UI too) — answer
    // with the honest code rather than a bridge 400.
    if (instance?.kind === "hermes") return { ok: false, code: "talk_unsupported" };
    // PER-GATEWAY opt-in (default OFF), like every voice feature: the admin
    // enables talk on the instances whose gateway is configured for it. The
    // GATEWAY owns the talk configuration (provider/model/voice defaults, API
    // key) — Atrium only consumes the surface.
    if (instance?.config?.talkEnabled !== true) {
      return { ok: false, code: "talk_disabled" };
    }
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    const gatewayUser = await resolveGatewayUser(ctx, {
      instanceName: target.instanceName,
      ownerUserId: chat.userId,
      canonical: target.canonical,
      instance,
    });
    return {
      ok: true,
      instanceName: target.instanceName,
      bridgeUrl: bridgeUrl ?? null,
      ...(gatewayUser === undefined ? {} : { gatewayUser }),
      // The browser lane — the only client-owned transport; the gateway
      // validates it regardless.
      transport: "webrtc",
      // The SESSION-KEY ingredients — the same three `prepareTalkToolCall`
      // already resolves. The canonical and the chat come from OWNED state; the
      // agent may be NAMED by the caller (the composer's selection) and is
      // AUTHORIZED here through the effective grants, which is not the same as
      // being trusted.
      // The gateway reads a Talk session's owning agent OFF an agent-scoped key;
      // without one it falls back to `config.talk.agentId`, and refuses outright
      // when several agents exist with no such fallback — which is how the voice
      // button died on both multi-agent instances (live prod 2026-09-17). The
      // fallback is no better: it answers as one arbitrary agent, not the chat's.
      agentId: target.agentId,
      canonical: target.canonical,
      openclawChatId: routing.openclawChatId,
    };
  },
});

type ToolCallPrepare =
  | {
      ok: true;
      instanceName: string;
      agentId: string;
      canonical: string;
      openclawChatId: string | null;
      bridgeUrl: string | null;
      /** From the session row, when a handle was supplied: what the hangup closes. */
      voiceSessionId?: string;
      relayed?: boolean;
    }
  | { ok: false; code: string };

/** Ownership + admin-gate + FULL routing for the agent-consult relay: the bridge
 *  needs the session-key ingredients (chatId/openclawChatId + agentId + canonical).
 *  WITH a handle — the normal case during a call — the agent, the canonical and the
 *  conversation all come from the server's own row, and only the agent is re-checked
 *  against current authorization. WITHOUT one, they are resolved from owned state,
 *  and the caller may name the agent it wants (AUTHORIZED through the effective
 *  grants, which is not the same thing as trusted). */
export const prepareTalkToolCall = internalQuery({
  args: {
    chatId: v.id("chats"),
    // The handle of the session this consult belongs to (talk.recordTalkSession,
    // returned by the mint). The ROW carries the agent, the canonical and the
    // conversation the call was opened on, so the consult reaches the session the
    // user is speaking in rather than whatever the thread has moved to since. The
    // browser holds only the id.
    sessionId: v.optional(v.id("talkSessions")),
    // Fallback when no handle is held (a session minted before this contract): the
    // agent the COMPOSER currently targets, authorized by resolveTargetForTurn.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, routedAgent, sessionId },
  ): Promise<ToolCallPrepare> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    // A handle names the address the mint succeeded with. When one is SUPPLIED it
    // decides the answer — re-resolving is exactly what would walk the consult out of
    // the live call — but it is never a bypass:
    //
    //  - a supplied handle that is unknown, expired or another chat's FAILS. Falling
    //    back to the thread's current routing would silently send the consult into a
    //    different session, which is the defect this handle exists to prevent; only
    //    the ABSENCE of a handle takes the legacy path.
    //  - its agent is re-run through the CURRENT authorization. A grant revoked, a
    //    group left, an agent retyped utility-only or deleted mid-call must stop the
    //    consult, and the re-resolution must land on THAT agent — never fall back to
    //    another one, which would answer as someone the user is not speaking to.
    //
    // The CHAT check is the load-bearing half of the ownership pair. The `userId`
    // check beside it cannot fire today, since `recordTalkSession` and this handler
    // both run `requireOwnedChat`; it stays for the day a chat can change hands.
    const live = sessionId === undefined ? null : await ctx.db.get(sessionId);
    if (sessionId !== undefined) {
      if (
        live === null ||
        live.userId !== userId ||
        live.chatId !== chatId ||
        // ENDED IS OVER. A hangup marks the row before anything else, and until now
        // only the handle's two-hour TTL stopped the consults: a call ended in one
        // place went on asking the agent questions from another. It matters most on
        // the DIRECT lane, where `talk.client.close` closes the gateway's logical
        // record and NOTHING can reach the browser↔provider media
        // (upstream client-voice-session.ts: "Transport close does not end consult
        // runs"). So a second tab's recovery hangup lifted the freeze while the first
        // tab kept talking — and could then route the conversation to another agent,
        // which is the one thing this lot exists to prevent (codex P1, pass 11).
        // `talk_session_stale` is TERMINAL, so the still-open call ends with a
        // message instead of drifting on unanswered.
        live.endedAt !== undefined ||
        live.expiresAt <= Date.now()
      ) {
        return { ok: false, code: "talk_session_stale" };
      }
      const still = await resolveTargetForTurn(ctx, chat, userId, {
        instanceName: live.instanceName,
        agentId: live.agentId,
      });
      // The EQUALITY half cannot fire against today's resolver: given an explicit
      // choice it answers that agent or nothing (not entitled → agent_restricted,
      // deleted → no_agent), never a substitute. It is written anyway because the
      // substitute is the dangerous outcome — the consult would answer as an agent
      // the user is not speaking to — and a resolver that one day falls back for an
      // explicit choice must not silently acquire that power here.
      if (
        !still.target ||
        still.target.instanceName !== live.instanceName ||
        still.target.agentId !== live.agentId
      ) {
        return { ok: false, code: "agent_restricted" };
      }
    }
    const routing = live
      ? {
          target: {
            instanceName: live.instanceName,
            agentId: live.agentId,
            // PINNED: the key's third component. A canonical that changes mid-call
            // would otherwise address a different session.
            canonical: live.canonical,
          },
          openclawChatId: live.conversation,
        }
      : await resolveTalkRouting(ctx, chat, userId, routedAgent ?? null);
    if (routing === null) return { ok: false, code: "no_agent" };
    const target = routing.target;
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    if (instance?.kind === "hermes") return { ok: false, code: "talk_unsupported" };
    // Same PER-GATEWAY opt-in as the session mint.
    if (instance?.config?.talkEnabled !== true) {
      return { ok: false, code: "talk_disabled" };
    }
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    return {
      ok: true,
      instanceName: target.instanceName,
      agentId: target.agentId,
      canonical: target.canonical,
      openclawChatId: routing.openclawChatId,
      bridgeUrl: pinnedBridgeUrl(live, bridgeUrl),
      ...(live?.voiceSessionId !== undefined ? { voiceSessionId: live.voiceSessionId } : {}),
      ...(live?.relayed !== undefined ? { relayed: live.relayed } : {}),
    };
  },
});

/** The bridge a session's requests must reach: the one PINNED at the mint when the
 *  row carries it (the relay handle and the owning socket live on that process),
 *  else the instance's current routing. */
function pinnedBridgeUrl(
  live: { bridgeUrl?: string } | null,
  resolved: string | null | undefined,
): string | null {
  return live?.bridgeUrl ?? resolved ?? null;
}

// The bridge presents the offer to the gateway within 30 s (the gateway's own
// upstream timeout); the action budget must clear that with margin.
const TALK_OFFER_TIMEOUT_MS = 45_000;
// The gateway's own cap on an offer body (OPENAI_QUICKSILVER_MAX_SDP_BYTES); a
// browser offer is a few KB, so anything near this is not an offer.
const TALK_OFFER_MAX_SDP_CHARS = 256 * 1024;
const TALK_HANGUP_TIMEOUT_MS = 20_000;

/**
 * PUBLIC entry, GPT Live lane: present the browser's SDP offer to the gateway
 * through the bridge, which kept the ephemeral secret. The handle names the session
 * the mint recorded; the row decides the instance and proves the caller may speak
 * on it (the same check the mid-call consult makes). Returns the answer SDP, or a
 * code in the handshake's own vocabulary (`talk_secret_expired` = mint again).
 */
export const relayTalkOffer = action({
  args: {
    chatId: v.id("chats"),
    sessionId: v.id("talkSessions"),
    relayId: v.string(),
    sdp: v.string(),
  },
  handler: async (
    ctx,
    { chatId, sessionId, relayId, sdp },
  ): Promise<{ ok: true; answerSdp: string } | { ok: false; code: string }> => {
    if (relayId.trim() === "" || relayId.length > 128) {
      return { ok: false, code: "invalid_args" };
    }
    if (sdp.trim() === "" || sdp.length > TALK_OFFER_MAX_SDP_CHARS) {
      return { ok: false, code: "invalid_args" };
    }
    const prep: ToolCallPrepare = await ctx.runQuery(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId },
    );
    if (!prep.ok) return prep;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_OFFER_TIMEOUT_MS);
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/talk-offer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        // The SESSION the row proved the caller on — chat, conversation, agent and
        // canonical: the bridge spends the handle for that session key and no other
        // of the same chat (codex P1, pass 2).
        body: JSON.stringify({
          instanceName: prep.instanceName,
          chatId,
          ...(prep.openclawChatId !== null ? { openclawChatId: prep.openclawChatId } : {}),
          canonical: prep.canonical,
          agentId: prep.agentId,
          relayId,
          sdp,
        }),
        signal: controller.signal,
      });
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        return { ok: false, code };
      }
      const d = data as { ok?: boolean; answerSdp?: unknown } | null;
      if (d?.ok !== true || typeof d.answerSdp !== "string") {
        return { ok: false, code: "talk_malformed" };
      }
      return { ok: true, answerSdp: d.answerSdp };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});

type HangupPrepare =
  | {
      ok: true;
      instanceName: string;
      agentId: string;
      canonical: string;
      openclawChatId: string | null;
      bridgeUrl: string | null;
      voiceSessionId: string | null;
      relayed: boolean;
    }
  | { ok: false; code: string };

/** Ownership of the ROW is the whole authorization of a hangup. Deliberately NOT the
 *  consult's prepare: that one re-runs the agent grant and the instance's talk gate,
 *  and a grant revoked or Talk switched off mid-call are exactly the moments a call
 *  MUST still be closable — refusing the close there would keep the revoked call
 *  alive on the gateway until its TTL (codex P2, pass 2). Closing a call one owns is
 *  never a capability. */
export const prepareTalkHangup = internalQuery({
  args: { chatId: v.id("chats"), sessionId: v.id("talkSessions") },
  handler: async (ctx, { chatId, sessionId }): Promise<HangupPrepare> => {
    // WHO, not WHETHER THEY MAY: `requireActive` refuses a `pending` account, and an
    // account set pending mid-call must still be able to close the call it opened —
    // otherwise the revocation itself keeps the call alive on the gateway until its
    // TTL (codex P2, pass 4). The row's ownership is the only authorization here.
    const userId = await requireUserId(ctx);
    // The ROW alone — not the chat. A chat deleted during a call takes its rows
    // with it except this one, and the unmount that follows must still be able to
    // close the gateway-owned call; `requireOwnedChat` would throw "not found"
    // first and leave the call held until its TTL (codex P2, pass 3). The row's own
    // `userId` + `chatId` are the ownership that was checked when it was written.
    const live = await ctx.db.get(sessionId);
    if (
      live === null ||
      live.userId !== userId ||
      live.chatId !== chatId ||
      live.expiresAt <= Date.now()
    ) {
      return { ok: false, code: "talk_session_stale" };
    }
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", live.instanceName))
      .first();
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: live.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    return {
      ok: true,
      instanceName: live.instanceName,
      agentId: live.agentId,
      canonical: live.canonical,
      openclawChatId: live.conversation === chatId ? null : live.conversation,
      bridgeUrl: pinnedBridgeUrl(live, bridgeUrl),
      voiceSessionId: live.voiceSessionId ?? null,
      relayed: live.relayed === true,
    };
  },
});

/**
 * PUBLIC entry, GPT Live lane: the user hung up (or left the page) — tell the
 * gateway to close the logical call it owns, on the socket that owns it. The row
 * carries everything the bridge needs; the browser sends only the handle. A session
 * that was never relayed owes the gateway nothing (its call is the browser's own),
 * and says so instead of posting.
 */
export const hangupTalkSession = action({
  args: { chatId: v.id("chats"), sessionId: v.id("talkSessions") },
  handler: async (
    ctx,
    { chatId, sessionId },
  ): Promise<{ ok: true; closed: string } | { ok: false; code: string }> => {
    const prep: HangupPrepare = await ctx.runQuery(internal.talk.prepareTalkHangup, {
      chatId,
      sessionId,
    });
    if (!prep.ok) return prep;
    // THE CALLER STOPPED SPEAKING — record it before anything else can return. Every
    // early exit below (a direct-lane call the gateway does not own, a deployment
    // with no bridge configured) used to skip the `finally` and leave the row
    // looking live, which froze the chat's agent for the rest of the call window
    // over a call that had ended (codex P1). Marking first also makes the common
    // path idempotent: the mutation ignores an already-ended row.
    await ctx.runMutation(internal.talk.markTalkSessionEnded, { sessionId });
    // THE BRIDGE IS TOLD ON BOTH LANES.
    //
    // It holds this chat's socket for the whole call window on the direct lane too
    // (server.ts — the consult is pinned to the call's agent, so a re-key hands the
    // conversation to another one mid-sentence). That hold lives in the bridge's
    // memory and nothing else releases it: skipping the POST here, as this did while
    // only the relayed lane held, would have left every agent switch refused for up
    // to thirty minutes after a call the user ended in ten seconds (codex P1, pass
    // 10). The bridge releases the hold in its own `finally`, whatever the gateway
    // answers, so a close that fails still gives the socket back.
    //
    // Only a mint with no `voiceSessionId` skips it: there is nothing to name, and an
    // old gateway that minted one placed no hold either.
    if (prep.voiceSessionId === null) {
      return { ok: true, closed: "none" };
    }
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_HANGUP_TIMEOUT_MS);
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/talk-hangup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          instanceName: prep.instanceName,
          chatId,
          ...(prep.openclawChatId !== null ? { openclawChatId: prep.openclawChatId } : {}),
          canonical: prep.canonical,
          agentId: prep.agentId,
          voiceSessionId: prep.voiceSessionId,
        }),
        signal: controller.signal,
      });
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        // A 5xx from an ingress in front of a bridge that is DOWN never reached the
        // handler, so the hold still stands and the server still owes this close.
        // A 4xx is the bridge answering — it ran, and released. Arming on the first
        // is what the chain is for; arming on the second would be noise.
        if (response.status >= 500) await armHangupRetry(ctx, chatId, sessionId);
        return { ok: false, code };
      }
      const d = data as { ok?: boolean; closed?: unknown } | null;
      if (d?.ok !== true) return { ok: false, code: "talk_malformed" };
      return { ok: true, closed: typeof d.closed === "string" ? d.closed : "closed" };
    } catch {
      // UNANSWERED, so the bridge may never have run its release. Convex has already
      // marked the row ended, so every reader sees no call while the bridge keeps
      // holding this chat's socket — the server owes that close and retries it.
      await armHangupRetry(ctx, chatId, sessionId);
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});

/**
 * When to ask the bridge again to release a hold the user has already ended.
 *
 * DENSE, not merely long. Two earlier shapes were wrong in the same way: a chain of
 * three over a minute gave up at once, and one of five whose delays kept doubling
 * reached past the hold but left a twenty-minute silence in the middle — a partition
 * healing at seventeen minutes met no attempt until after the hold had expired by
 * itself, which is the exact hole the chain exists to close (codex P2, passes 14 and
 * 15). Reaching the end is not enough; what matters is how long the chat can stay
 * frozen after the network comes back.
 *
 * So the invariant is a PAIR, and both halves are asserted against the call window
 * rather than re-added by hand: no gap longer than `TALK_HANGUP_RETRY_MAX_GAP_MS`,
 * and a reach past the hold. Past the last attempt the hold expires on its own, and
 * `requeueForCall` has been moving the message along throughout.
 */
const TALK_HANGUP_RETRY_DELAYS_MS = [
  20_000,
  60_000,
  120_000,
  300_000,
  300_000,
  300_000,
  300_000,
  300_000,
  300_000,
];

/** The longest a healed partition may wait for the next attempt. */
export const TALK_HANGUP_RETRY_MAX_GAP_MS = Math.max(
  ...TALK_HANGUP_RETRY_DELAYS_MS,
);

/** What the chain above actually reaches, from the first failure. Exported so the
 *  test can hold it against the call window rather than re-adding the numbers. */
export const TALK_HANGUP_RETRY_REACH_MS = TALK_HANGUP_RETRY_DELAYS_MS.reduce(
  (a, b) => a + b,
  0,
);

/**
 * Arm the retry chain for this session — AT MOST ONCE.
 *
 * The browser retries the hangup action up to three times of its own accord, and a
 * user with two tabs doubles that again. Each rejection used to arm a fresh chain:
 * one hangup under a lasting partition became eighteen POSTs and fifteen scheduled
 * actions, all trying to release the same hold (codex P2, pass 15). The row is the
 * natural key — it is the thing the hold belongs to — so the stamp lives there.
 */
async function armHangupRetry(
  ctx: ActionCtx,
  chatId: Id<"chats">,
  sessionId: Id<"talkSessions">,
): Promise<void> {
  const armed = await ctx.runMutation(internal.talk.claimHangupRetry, {
    sessionId,
  });
  if (!armed) return;
  try {
    await ctx.scheduler.runAfter(
      TALK_HANGUP_RETRY_DELAYS_MS[0]!,
      internal.talk.retryTalkHangup,
      { chatId, sessionId, attempt: 0 },
    );
  } catch (err) {
    // The claim and the scheduling are two operations. A claim that survives a
    // failed scheduling is worse than no claim at all: the browser's own retries
    // find the stamp already set and can no longer rebuild the chain, so nothing
    // ever releases the hold (codex P3, pass 16). Give the claim back.
    await ctx.runMutation(internal.talk.releaseHangupRetryClaim, { sessionId });
    throw err;
  }
}

/** Claim the one retry chain this session gets. Returns false when another caller
 *  (another tab, another of the browser's own attempts) already holds it. */
export const claimHangupRetry = internalMutation({
  args: { sessionId: v.id("talkSessions") },
  handler: async (ctx, { sessionId }): Promise<boolean> => {
    const row = await ctx.db.get(sessionId);
    if (row === null || row.hangupRetryArmed === true) return false;
    await ctx.db.patch(sessionId, { hangupRetryArmed: true });
    return true;
  },
});

/** Give back a claim whose scheduling failed, so the next attempt can take it. */
export const releaseHangupRetryClaim = internalMutation({
  args: { sessionId: v.id("talkSessions") },
  handler: async (ctx, { sessionId }): Promise<void> => {
    const row = await ctx.db.get(sessionId);
    if (row === null) return;
    await ctx.db.patch(sessionId, { hangupRetryArmed: undefined });
  },
});

/**
 * Ask the bridge again to release a hold whose hangup never reached it.
 *
 * THE SERVER OWES THIS CLOSE, not the browser. Convex marks the row ended BEFORE the
 * POST, so from every reader's point of view the call is over — while the bridge, on
 * the other side of a partition, keeps holding this chat's socket and refusing every
 * agent switch. The browser's own bounded retries stop long before that hold does,
 * and it then forgets the session for good: nothing was left to try (codex P2, pass
 * 12). Best-effort and idempotent — the bridge releases in its own `finally`, and an
 * exhausted chain simply lets the hold expire.
 */
export const retryTalkHangup = internalAction({
  args: {
    chatId: v.id("chats"),
    sessionId: v.id("talkSessions"),
    attempt: v.number(),
  },
  handler: async (ctx, { chatId, sessionId, attempt }): Promise<void> => {
    const row = await ctx.runQuery(internal.talk.peekTalkSession, { sessionId });
    // Gone, or never ended: nothing is owed. (A row the sweep deleted took its hold's
    // reason with it; the bridge's own TTL covers what is left.)
    if (row === null || row.endedAt === undefined) return;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = row.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret || row.voiceSessionId === undefined) return;
    let delivered = false;
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/talk-hangup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: sharedSecret },
        body: JSON.stringify({
          instanceName: row.instanceName,
          chatId,
          // THE SAME INGREDIENTS THE FIRST POST SENT. The bridge rebuilds the session
          // key from these and answers `closed:"gone"` — WITHOUT releasing anything —
          // when it does not match the socket it holds. Omitting the conversation
          // made every retry on a bound chat a polite no-op that the loop then read
          // as delivered, leaving the agent frozen for up to thirty minutes (codex
          // P2, pass 13). The row's `conversation` is exactly what the mint used.
          openclawChatId: row.conversation,
          canonical: row.canonical,
          agentId: row.agentId,
          voiceSessionId: row.voiceSessionId,
        }),
        signal: AbortSignal.timeout(TALK_HANGUP_TIMEOUT_MS),
      });
      // ONLY AN ANSWER THE BRIDGE ITSELF PRODUCED. Its `finally` releases the hold
      // whatever the gateway said — but an ingress returning 503 while the bridge is
      // down answers too, and reading that as "released" ended the chain on the one
      // failure it exists for (codex P2, pass 15). A 2xx is the bridge's own handler;
      // anything else is someone speaking for it.
      delivered = response.ok;
    } catch {
      delivered = false;
    }
    const next = TALK_HANGUP_RETRY_DELAYS_MS[attempt + 1];
    if (delivered || next === undefined) return;
    await ctx.scheduler.runAfter(next, internal.talk.retryTalkHangup, {
      chatId,
      sessionId,
      attempt: attempt + 1,
    });
  },
});

/** The row, for the retry above — it runs as the SERVER, on a call the user ended. */
export const peekTalkSession = internalQuery({
  args: { sessionId: v.id("talkSessions") },
  handler: async (ctx, { sessionId }): Promise<Doc<"talkSessions"> | null> =>
    await ctx.db.get(sessionId),
});

// The consult can run a real (long) agent turn: bridge holds up to 90s, so the
// action budget must comfortably exceed it.
const TALK_CONSULT_TIMEOUT_MS = 110_000;
const MAX_CONSULT_FIELD_CHARS = 6_000;

/**
 * PUBLIC entry: relay the voice model's `openclaw_agent_consult` tool call to
 * a real agent run on this chat's session, and wait (bounded) for its result.
 * Returns {ok:true, resultText} | {ok:true, pending:true} (still running) |
 * {ok:true, errorText} (the run failed — the voice says so) | {ok:false, code}.
 */
export const relayTalkToolCall = action({
  args: {
    chatId: v.id("chats"),
    callId: v.string(),
    args: v.object({
      question: v.string(),
      context: v.optional(v.string()),
      responseStyle: v.optional(v.string()),
    }),
    // The handle of the session this consult belongs to (from the mint). It names
    // the agent AND the conversation, so the consult reaches the call the user is
    // in rather than whatever the thread has moved to since.
    sessionId: v.optional(v.id("talkSessions")),
    // Fallback for a session minted before this contract: the composer's selection.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, callId, args, routedAgent, sessionId },
  ): Promise<
    | { ok: true; resultText?: string; errorText?: string; pending?: boolean }
    | { ok: false; code: string }
  > => {
    if (args.question.trim() === "" || callId.trim() === "") {
      return { ok: false, code: "invalid_args" };
    }
    const prep: ToolCallPrepare = await ctx.runQuery(
      internal.talk.prepareTalkToolCall,
      {
        chatId,
        ...(routedAgent ? { routedAgent } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    );
    if (!prep.ok) return prep;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    // Bound every relayed field: the voice model's args are model-generated
    // input, not trusted sizes.
    const bounded = {
      question: args.question.slice(0, MAX_CONSULT_FIELD_CHARS),
      ...(args.context
        ? { context: args.context.slice(0, MAX_CONSULT_FIELD_CHARS) }
        : {}),
      ...(args.responseStyle
        ? { responseStyle: args.responseStyle.slice(0, 500) }
        : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_CONSULT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${bridgeUrl.replace(/\/$/, "")}/talk-toolcall`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            instanceName: prep.instanceName,
            chatId,
            openclawChatId: prep.openclawChatId,
            canonical: prep.canonical,
            agentId: prep.agentId,
            callId: callId.slice(0, 200),
            args: bounded,
          }),
          signal: controller.signal,
        },
      );
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        return { ok: false, code };
      }
      const d = data as {
        ok?: boolean;
        resultText?: unknown;
        errorText?: unknown;
        pending?: unknown;
      } | null;
      if (d?.ok !== true) return { ok: false, code: "talk_malformed" };
      return {
        ok: true,
        ...(typeof d.resultText === "string" ? { resultText: d.resultText } : {}),
        ...(typeof d.errorText === "string" ? { errorText: d.errorText } : {}),
        ...(d.pending === true ? { pending: true } : {}),
      };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});

/**
 * PUBLIC entry: mint an ephemeral realtime-voice session for this chat's
 * instance. Returns `{ok:true, session, sessionId}` — the browser opens the WebRTC
 * connection with `session` and carries `sessionId` on the mid-call consult — or
 * `{ok:false, code}`; codes include talk_disabled
 * (admin gate), talk_unsupported (provider), not_configured / bridge_<status>
 * (transport), talk_malformed (unexpected gateway shape).
 */
export const mintTalkSession = action({
  args: {
    chatId: v.id("chats"),
    // The composer's voice pick (optional): forwarded to the gateway, which
    // validates against ITS allowlist (unknown -> configured default).
    voice: v.optional(v.string()),
    // Mic sensitivity (server_vad threshold 0..1) — the composer's talk
    // settings; the gateway/provider clamps and defaults.
    vadThreshold: v.optional(v.number()),
    // The agent the composer currently targets — see prepareTalkSession. Passed
    // through, never trusted: the prepare authorizes it.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, voice, vadThreshold, routedAgent },
  ): Promise<
    | { ok: true; session: TalkSession; sessionId: Id<"talkSessions"> }
    | { ok: false; code: string }
  > => {
    const prep: PrepareResult = await ctx.runQuery(
      internal.talk.prepareTalkSession,
      { chatId, ...(routedAgent ? { routedAgent } : {}) },
    );
    if (!prep.ok) return prep;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_MINT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${bridgeUrl.replace(/\/$/, "")}/talk-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Bare value (NOT Bearer-prefixed) — matches bridge.dispatch.
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            instanceName: prep.instanceName,
            transport: prep.transport,
            // Names the OWNER: the bridge builds the chat's agent-scoped session
            // key from these, and the gateway reads the agent off it.
            chatId,
            agentId: prep.agentId,
            canonical: prep.canonical,
            ...(prep.openclawChatId !== null
              ? { openclawChatId: prep.openclawChatId }
              : {}),
            ...(prep.gatewayUser !== undefined
              ? { gatewayUser: prep.gatewayUser }
              : {}),
            ...(typeof voice === "string" && voice !== ""
              ? { voice: voice.slice(0, 60) }
              : {}),
            ...(typeof vadThreshold === "number" &&
            Number.isFinite(vadThreshold) &&
            vadThreshold > 0 &&
            vadThreshold < 1
              ? { vadThreshold }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        // Surface the bridge's structured code when present (e.g. the gateway
        // has no realtime provider configured); never the body itself.
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        return { ok: false, code };
      }
      const session = parseTalkSessionResponse(data);
      if (session === null) return { ok: false, code: "talk_malformed" };
      // PROOF that the bridge actually scoped the create on the agent we named. A
      // bridge predating this contract answers the same shape while dropping the
      // ownership fields: the gateway then opens the session under its own
      // `talk.agentId` fallback — possibly an agent this user was never granted —
      // while the handle below would record the agent we ASKED for. Voice and
      // consult would run on two different agents, which is the whole defect this
      // lot exists to remove. Refuse instead; the orphaned gateway session expires.
      if ((data as { ownerScoped?: unknown } | null)?.ownerScoped !== true) {
        // COST, stated: the gateway session this POST opened is now orphaned, and a
        // user who keeps pressing the button orphans one per attempt until each
        // expires. That is the price of the skew window, and it is the cheaper side
        // — the alternative is a voice call running as an agent this user may never
        // have been granted.
        return { ok: false, code: "talk_owner_unconfirmed" };
      }
      // NEVER log `session` — it carries the ephemeral provider credential.
      // The mint SUCCEEDED. Record the address it opened BEFORE the secret is
      // relayed: the row is what tells the mid-call consult which agent, canonical
      // and conversation this call belongs to, and recording it re-checks that the
      // address is still authorized — so a right withdrawn during the POST cannot
      // hand out a working session. The browser gets an id, nothing else. The
      // EFFECTIVE conversation is `openclawChatId ?? chatId`, the same fallback the
      // bridge applies when it builds the key, so a call opened before any turn
      // existed is pinned just as firmly as one that inherited a segment.
      let sessionId: Id<"talkSessions">;
      try {
        sessionId = await ctx.runMutation(internal.talk.recordTalkSession, {
          chatId,
          instanceName: prep.instanceName,
          agentId: prep.agentId,
          canonical: prep.canonical,
          conversation: prep.openclawChatId ?? chatId,
          ...(session.voiceSessionId !== null
            ? { voiceSessionId: session.voiceSessionId }
            : {}),
          relayed: session.offerRelay !== null,
          // PIN the bridge the mint went to: the handle and the owning socket are there.
          bridgeUrl,
        });
      } catch {
        // The gateway session is OPEN and we cannot prove what it is. Fail closed —
        // the clientSecret is never handed out — and say so under its own code: the
        // broad catch below would report this as an unreachable bridge, which is the
        // one thing it is not.
        //
        // AND GIVE THE SOCKET BACK. The bridge has been holding this chat's socket
        // since the mint (the 2-minute pending window), and that hold is what refuses
        // a typed turn for another agent. With no row written there is no hangup to
        // send later, no end-of-window marker, and nothing in Convex that even knows
        // the hold exists: a message could sit queued for two minutes behind a call
        // that will never happen, with no call visible anywhere and no way for anyone
        // to release it (codex P2, pass 7). So the abandon goes out HERE, where the
        // failure is known. Best-effort by design — the hold expires on its own, and
        // a bridge that cannot be reached must not turn a mint failure into a throw.
        await abandonMintedSession(prep, chatId, bridgeUrl, session.voiceSessionId);
        return { ok: false, code: "talk_session_unrecorded" };
      }
      return { ok: true, session, sessionId };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});
