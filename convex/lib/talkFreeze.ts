// THE CHAT'S AGENT IS FROZEN WHILE SOMEONE IS SPEAKING — one rule, one place.
//
// A voice call is minted for the agent selected at that instant: the gateway holds
// the session and the mid-call consult addresses THAT agent. A typed turn routed
// elsewhere would split one conversation across two agents, and on a gateway-owned
// call (GPT Live, the OpenClaw 2026.9.5 default) it ends the call outright — the
// bridge keeps ONE live socket per chat, and re-keying it closes the socket the
// gateway bound the call to.
//
// Three entry points reach this: a send that names an agent, a send that names none
// (it still routes somewhere), and the queue drain that dispatches a turn accepted
// BEFORE the call started. Written once here because three spellings of one rule is
// how they drift — and two of the three were found missing by review, not by design.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveTargetForTurn } from "../routing";
import { liveTalkCall, TALK_CALL_WINDOW_MS } from "../talk";

/**
 * The agent a turn would actually reach, or null when nothing is dispatchable.
 *
 * Resolved against the CHAT'S OWNER, which is what the dispatch itself resolves
 * against (`bridge.ts` — `chatOwnerId`), never whoever sent this particular turn. A
 * participant granted the agent on the line but NOT the chat's bound agent resolved
 * to nothing here, the rule read "not a switch", and the dispatch then resolved as
 * the owner, landed on the bound agent and cut the call (codex P1, pass 3). Two
 * identities answering one question is how a guard and the thing it guards drift.
 */
async function effectiveAgent(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<{ instanceName: string; agentId: string } | null> {
  const resolved = await resolveTargetForTurn(ctx, chat, chat.userId, chosen);
  return resolved.target
    ? {
        instanceName: resolved.target.instanceName,
        agentId: resolved.target.agentId,
      }
    : null;
}

/** The live call this turn would move the conversation off, or null. */
export async function blockingCallForTurn(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<Doc<"talkSessions"> | null> {
  const call = await liveTalkCall(ctx, chat._id);
  if (call === null) return null;
  const target = await effectiveAgent(ctx, chat, chosen);
  // Nothing dispatchable is not a switch — that turn fails on its own terms.
  if (target === null) return null;
  return target.instanceName !== call.instanceName ||
    target.agentId !== call.agentId
    ? call
    : null;
}

/** Would this turn move the conversation off the agent on the line? */
export async function switchesAgentDuringCall(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<boolean> {
  return (await blockingCallForTurn(ctx, chat, chosen)) !== null;
}

/**
 * Arm the ONE wake-up that ends a hold nobody else would end.
 *
 * `recordTalkSession` arms `markTalkSessionEnded` for every call it writes, and that
 * mutation drains — so for anything minted from this version on, this is a no-op the
 * stamp makes cheap. It exists for the call that was ALREADY live when this shipped:
 * no armed marker, nothing writing at the end of the window, and a 2-hour sweep that
 * deletes the row without telling the queue. A turn held behind such a call waited
 * indefinitely, and every later send queued behind IT (codex P1, pass 8).
 *
 * Dropped a second past the window, so the drain that then runs sees no live call.
 */
export async function scheduleCallWindowDrain(
  ctx: MutationCtx,
  call: Doc<"talkSessions">,
): Promise<void> {
  if (call.windowDrainScheduled === true) return;
  await ctx.db.patch(call._id, { windowDrainScheduled: true });
  await ctx.scheduler.runAt(
    call.createdAt + TALK_CALL_WINDOW_MS + 1_000,
    internal.talk.markTalkSessionEnded,
    { sessionId: call._id },
  );
}

/**
 * Is a turn ALREADY ON ITS WAY to an agent other than this one?
 *
 * THE MIRROR OF THE FREEZE, and the only answer to the cross-bridge race. Every other
 * guard here refuses a SEND while a call is live; this refuses a CALL while a send is
 * live. It exists because the send's last check and its POST cannot be one
 * transaction: the dispatch re-asks with the POST in hand, then the request travels.
 * A call minted in that interval is recorded here — and when the two sit on different
 * instances they sit on different BRIDGE PROCESSES, whose registries know nothing of
 * each other, so the socket-in-hand refusal that catches every same-bridge case never
 * runs. The turn then reaches one agent while the call runs on another (codex P1,
 * pass 17).
 *
 * TWO SHAPES OF "IN FLIGHT", because the outbox stops telling the truth halfway. A
 * `pending` row is "a POST may be in flight right now" — but the bridge answers 200
 * as soon as the gateway accepts the prompt, so the row flips to `sent` while the RUN
 * keeps going. Watching only the outbox therefore left the whole streaming half of
 * every turn unguarded, which is most of its life (codex P1, pass 18). The answer
 * being written is the other shape, and it carries its own agent.
 *
 * So the mint gives way: the user presses the button again a moment later, which is a
 * far smaller cost than a conversation split in two. Minting for the SAME agent stays
 * allowed — there is nothing to split.
 *
 * KNOWN LIMIT, stated rather than papered over: a `pending` row abandoned by a dead
 * action is cleared by `outboxReconcile`, not by a timeout, so voice can be refused
 * for as long as that takes. It is the same row that already holds every typed send
 * on the chat; unblocking voice alone would mean letting a call start on a
 * conversation whose previous turn may still be running.
 */
export async function turnInFlightForOtherAgent(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  target: { instanceName: string; agentId: string },
): Promise<boolean> {
  const differs = (a: { instanceName: string; agentId: string } | null): boolean =>
    a !== null &&
    (a.instanceName !== target.instanceName || a.agentId !== target.agentId);

  // HOW MANY ROWS EACH SHAPE READS, and what a full page means.
  //
  // `first()` was wrong for every shape but the outbox: a chat can hold several
  // running children (the parallel-spawn case), several pending interactions across
  // different children, and more than one streaming bubble. Reading one row answered
  // about an arbitrary one of them, so a harmless first row hid a dangerous second.
  //
  // So each of those reads a PAGE, and a page that comes back FULL is treated as
  // blocking: "there may be more I did not look at" is not a reason to let a call
  // start, it is a reason not to. Fail closed, and bounded either way.
  const PAGE = 50;

  // 1. A send whose POST may be on the wire.
  const pending = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chat._id).eq("status", "pending"),
    )
    .first();
  if (pending !== null) {
    if (pending.routedAgent !== undefined) {
      // TAKEN AS WRITTEN, not re-resolved. The dispatch captures its target once and
      // POSTs that; re-resolving here against CURRENT grants answered a different
      // question. A grant withdrawn mid-flight made the re-resolution return nothing,
      // the mirror read "nothing differs", a call elsewhere was allowed — and the
      // dispatch posted its captured target all the same (codex P1, pass 21).
      if (
        differs({
          instanceName: pending.routedAgent.instanceName,
          agentId: pending.routedAgent.agentId,
        })
      ) {
        return true;
      }
    } else {
      // No named agent: the turn goes wherever the chat routes. Resolve it — and if
      // that answers nothing, BLOCK. "I cannot tell where this is going" is not a
      // reason to let a call start somewhere else.
      const going = await effectiveAgent(ctx, chat, null);
      if (going === null || differs(going)) return true;
    }
  }

  // 2. An answer being written RIGHT NOW — attributed through the SEND IT ANSWERS,
  //    not through its own routing fields. `stream.startAssistant` does not write
  //    those, so reading them found nothing and fell back to the chat's primary
  //    agent: a per-turn reply from another agent was then read as the primary's, and
  //    a call for the primary was allowed while that other agent kept writing (codex
  //    P1, pass 19). The reply carries `dispatchOutboxId`; the row it names carries
  //    the routing the dispatch actually used.
  const streamingRows = await ctx.db
    .query("messages")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chat._id).eq("status", "streaming"),
    )
    .take(PAGE);
  if (streamingRows.length >= PAGE) return true;
  for (const streaming of streamingRows) {
    const dispatched =
      streaming.dispatchOutboxId === undefined
        ? null
        : await ctx.db.get(
            streaming.dispatchOutboxId as unknown as Id<"outbox">,
          );
    const chosen =
      dispatched?.routedAgent === undefined || dispatched === null
        ? null
        : {
            instanceName: dispatched.routedAgent.instanceName,
            agentId: dispatched.routedAgent.agentId,
          };
    if (chosen !== null) {
      // AS WRITTEN, exactly like the pending branch above. Passing it back through
      // the resolver asked today's grants about a turn that was routed yesterday: a
      // grant withdrawn mid-stream made the answer `null`, which read as "nothing
      // differs", and a call elsewhere was allowed while that agent kept writing
      // (codex P1, pass 22 — the same defect as pass 21, one branch over).
      if (differs(chosen)) return true;
    } else {
      // NO DISPATCH ROW means a SPONTANEOUS turn — an announce, a cron. Nobody chose
      // an agent for it, but it is not therefore the chat's primary: it opened on
      // whatever session was actually ACTIVE, which the reply records as its
      // `turnSessionKey`. Reading the absence as "the primary" let an announce from
      // one agent authorise a call with another, whose acquire then closed the socket
      // that announce was still writing on (codex P2, pass 20).
      // The instance it is PROVEN to be on (`startAssistant` stamps it), then the
      // agent its own session key names. Comparing the agent alone let a spontaneous
      // reply on one gateway authorise a call on another, both called `alice`
      // (codex P2, pass 21).
      // AN ABSENT CAPTURED FIELD BLOCKS. `undefined` is "I was not told", not "it
      // matches": a reply written before this stamp existed would otherwise let a
      // call on another gateway through (codex P1, pass 22). Same rule as a page
      // that comes back full — what I could not see is a reason to refuse.
      //
      // And it does not make voice unusable: `boundInstance` is derived from the
      // PER-BRIDGE ingest secret (`bridge_ingest.ts`), which has been the only
      // accepted credential since per-bridge isolation stopped being configurable.
      // A row without it therefore comes from a build that can no longer write one,
      // so the refusal is bounded by that row's own life — checked before relying on
      // it, because a fail-closed rule on a field production legitimately omits would
      // have refused every call during every turn.
      if (streaming.boundInstance !== target.instanceName) return true;
      // UNREADABLE BLOCKS. Old bridges omit `turnSessionKey` (stream.ts says so),
      // and falling back to the chat's current route read a spontaneous reply from
      // one agent as the route's — which allowed a call with another while it wrote
      // (codex P1, pass 24). A name I cannot read is not the name being asked for.
      const speaking = sessionKeyAgentId(streaming.turnSessionKey);
      if (speaking === null || speaking !== target.agentId) return true;
    }
  }

  // 3. A SUB-AGENT still running. `chatHasActivityBlockers` already counts one as
  //    activity for the queue; the mirror ignored it, so a mint could start a call
  //    on another agent and the bridge would then close the socket the child's
  //    observations ride on — losing the delegated result, not merely reordering it
  //    (codex P2, pass 19). The child's owning agent is in its session key, whose
  //    shape the schema pins: `agent:<id>:subagent:<uuid>`.
  const runningRows = await ctx.db
    .query("subAgents")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chat._id).eq("status", "running"),
    )
    .take(PAGE);
  if (runningRows.length >= PAGE) return true;
  // 4. A message already on its way to a SUB-AGENT. `prepareInteraction` refuses one
  //    while a call is live, but it writes its row and POSTs afterwards — so a call
  //    minted in that gap saw nothing, and `/subagent-send` then acquired the
  //    PARENT's socket, which during a call already matches and is never checked
  //    against the hold (codex P1, pass 20). Reading this range is also what makes
  //    the two writes conflict rather than interleave.
  const interactions = await ctx.db
    .query("subAgentInteractions")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chat._id).eq("status", "pending"),
    )
    .take(PAGE);
  if (interactions.length >= PAGE) return true;
  for (const interacting of interactions) {
    // Instance first, from what the row CAPTURED — the action POSTs to that gateway
    // whatever the chat resolves to now. Comparing ids alone let a child on one
    // gateway and a call on another, both called `alice`, read as the same agent
    // (codex P1, pass 21).
    // Absent BLOCKS: a row written before this field existed is one the deployment
    // cannot vouch for, and the schema keeps that legacy shape on purpose.
    if (interacting.instanceName !== target.instanceName) return true;
    const owner = subAgentOwnerAgentId(interacting.childSessionKey);
    if (owner === null || owner !== target.agentId) return true;
  }

  for (const running of runningRows) {
    // Instance first, then agent — an agent id is not an identity on its own, two
    // gateways can expose the same one.
    // `?? target.instanceName` would have made an unstamped row agree with whatever
    // is asking — the same fail-open, spelled as a default.
    const owner = subAgentOwnerAgentId(running.childSessionKey);
    if (running.instanceName !== target.instanceName) return true;
    // Unparseable BLOCKS: the key's shape is pinned in prose only (`v.string()`).
    if (owner === null || owner !== target.agentId) return true;
  }
  return false;
}

/** The agent a gateway SESSION key names. Built by the bridge as
 *  `agent:<id>:<channel>:chat:<canonical>:<chatId>` (session-keys.ts), and kept on a
 *  reply as its `turnSessionKey`. Null for anything that does not parse — a name we
 *  could not read must not be taken for anyone in particular. */
export function sessionKeyAgentId(key: string | undefined): string | null {
  if (key === undefined) return null;
  const m = /^agent:([^:]+):/.exec(key);
  return m === null ? null : (m[1] ?? null);
}

/** The agent a child session belongs to, from the key shape the schema pins:
 *  `agent:<id>:subagent:<uuid>`. Null for anything else — an unparsed key must not
 *  be read as "belongs to whoever is asking". */
export function subAgentOwnerAgentId(childSessionKey: string): string | null {
  const m = /^agent:([^:]+):subagent:/.exec(childSessionKey);
  return m === null ? null : (m[1] ?? null);
}

/** Refuse the turn, with the code the composer explains. */
export async function assertNoAgentSwitchDuringCall(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<void> {
  if (await switchesAgentDuringCall(ctx, chat, chosen)) {
    throw new Error("TALK_CALL_ACTIVE");
  }
}
