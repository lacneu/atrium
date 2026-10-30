// WHETHER A CONVERSATION SHOWS THE MODEL'S REASONING (0.103.0) — the one place it is
// decided, read by everything that stores, sends or shows reasoning.
//
// The decision is Atrium's, first answer wins:
//   1. the conversation's own choice (`chats.sessionSettings.showReasoning`);
//   2. its agent's EXCEPTION (`agents.showReasoningDefault`: true = shown, false = hidden,
//      absent = none);
//   3. its instance's DEFAULT (`instances.showReasoningDefault`, a top-level property never
//      dispatched to the bridge — the instance looked up by name, `.first()` as routing);
//   4. no.
// Levels 2-3 are admin settings (Settings ▸ chat defaults) and are READ at every decision,
// never copied: a changed instance default holds for the next turn and the next view of
// every conversation that inherits it. It is NOT the gateway's `reasoningDefault`: that one
// applies to every channel of an OpenClaw agent, and Hermes has none. What follows from it:
//   - OpenClaw: the bridge sets the session's `reasoningLevel` to it (sessions.patch,
//     convex/bridge.ts) — the Control UI's own condition for showing reasoning
//     (ui/src/pages/chat/components/chat-transcript-projection.ts:120 at v2026.9.33);
//   - Hermes: nothing is written to the gateway (its only setter, `config.set reasoning`,
//     rewrites the global config.yaml — tui_gateway/methods_config_set.py:20-31, 317-326 at
//     71d34bad); Atrium keeps or drops what the gateway emits;
//   - both: reasoning reaches the store only while it is true (transcriptProjection.ts,
//     stream.ts), and the view shows it only while it is true.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildOpenClawThreadId } from "./openclawThread";

/** The agent a conversation's next turn goes to: the bound one, or the last routed one on a
 *  per-turn routed conversation (the same reading as messages.ts `describedAgentDefaultMode`). */
export function currentAgentOf(
  chat: Pick<Doc<"chats">, "perTurnRouting" | "lastRoutedInstanceName" | "lastRoutedAgentId" | "instanceName" | "agentId">,
): { instanceName: string; agentId: string } | null {
  const instanceName = chat.perTurnRouting === true ? (chat.lastRoutedInstanceName ?? chat.instanceName) : chat.instanceName;
  const agentId = chat.perTurnRouting === true ? (chat.lastRoutedAgentId ?? chat.agentId) : chat.agentId;
  return instanceName === undefined || agentId === undefined ? null : { instanceName, agentId };
}

/** The agent that PRODUCED `message`, the one its reasoning is kept or dropped by (codex
 *  pass 4 on 0.103.0). A chained reply carries its agent (`routed*`); an ordinary reply names
 *  its outbox row, whose `routedAgent` is the agent the turn was sent to (absent: the
 *  conversation's primary, the thread's attribution rule). Not the conversation's CURRENT
 *  agent: a Hermes reply can complete before `confirmTurnRouting` moves it, and would then be
 *  judged by the previous turn's agent. Only a reply without provenance falls back to it. */
export async function producingAgentOf(
  ctx: Pick<QueryCtx, "db">,
  chat: Pick<Doc<"chats">, "_id" | "perTurnRouting" | "lastRoutedInstanceName" | "lastRoutedAgentId" | "instanceName" | "agentId">,
  message: Pick<Doc<"messages">, "routedInstanceName" | "routedAgentId" | "dispatchOutboxId">,
): Promise<{ instanceName: string; agentId: string } | null> {
  if (message.routedInstanceName !== undefined && message.routedAgentId !== undefined) {
    return { instanceName: message.routedInstanceName, agentId: message.routedAgentId };
  }
  if (message.dispatchOutboxId !== undefined) {
    const rowId = ctx.db.normalizeId("outbox", message.dispatchOutboxId);
    const row = rowId === null ? null : await ctx.db.get(rowId);
    // A row of another conversation is no provenance (startAssistant reads it the same way).
    if (row !== null && row.chatId === chat._id) {
      if (row.routedAgent !== undefined) {
        return { instanceName: row.routedAgent.instanceName, agentId: row.routedAgent.agentId };
      }
      return chat.instanceName === undefined || chat.agentId === undefined
        ? null
        : { instanceName: chat.instanceName, agentId: chat.agentId };
    }
  }
  return currentAgentOf(chat);
}

/** Where a conversation's inherited value comes from: its agent's exception, its
 *  instance's default, or neither (hidden). */
export type ReasoningDefaultSource = "agent" | "instance" | "none";
export type ReasoningDefault = { show: boolean; source: ReasoningDefaultSource };

const NO_DEFAULT: ReasoningDefault = { show: false, source: "none" };

/** What a conversation that chose nothing inherits from `agent`: the agent's exception,
 *  else its instance's default, else hidden. An agent without a row (unknown, purged) has
 *  no exception; its instance still decides. */
export async function inheritedReasoning(
  ctx: Pick<QueryCtx, "db">,
  agent: { instanceName: string; agentId: string } | null,
): Promise<ReasoningDefault> {
  if (agent === null) return NO_DEFAULT;
  const row = await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) => q.eq("instanceName", agent.instanceName).eq("agentId", agent.agentId))
    .first();
  if (row?.showReasoningDefault !== undefined) return { show: row.showReasoningDefault, source: "agent" };
  const instance = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", agent.instanceName))
    .first();
  if (instance?.showReasoningDefault !== undefined) return { show: instance.showReasoningDefault, source: "instance" };
  return NO_DEFAULT;
}

/** The conversation's own choice, when it made one. */
export function chatReasoningChoice(chat: Pick<Doc<"chats">, "sessionSettings">): boolean | undefined {
  return chat.sessionSettings?.showReasoning;
}

/** The effective decision for one of the conversation's agents (its current one by default). */
export async function showsReasoning(
  ctx: Pick<QueryCtx, "db">,
  chat: Pick<
    Doc<"chats">,
    "sessionSettings" | "perTurnRouting" | "lastRoutedInstanceName" | "lastRoutedAgentId" | "instanceName" | "agentId"
  >,
  agent: { instanceName: string; agentId: string } | null = currentAgentOf(chat),
): Promise<boolean> {
  return chatReasoningChoice(chat) ?? (await inheritedReasoning(ctx, agent)).show;
}

/** The agent an OpenClaw session key names (`agent:<agentId>:…`, bridge session-keys.ts). */
export function agentIdOfSessionKey(sessionKey: string): string | null {
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m === null ? null : m[1]!;
}

/** The non-reversible name of one gateway session (its instance and session key): what
 *  `sessionMeta.describedSession` holds, so a turn can tell whether the conversation's one
 *  meta describes the session it goes to, without storing the key (it embeds the owner's
 *  canonical and the chat id). */
export async function sessionDigest(instanceName: string, sessionKey: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${instanceName}\n${sessionKey}`)));
  return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `reasoningLevel` the bridge applies to an OpenClaw session for this conversation,
 *  or nothing. `on` whenever the conversation shows reasoning; `off` only when the
 *  conversation CHOSE to hide it, or the session is known to show it while the decision is
 *  no — a conversation that never touched the setting costs no administrative patch.
 *  "Known" needs `metaDescribesTarget`: the conversation keeps ONE `sessionMeta` while its
 *  turns can go to several sessions (per-turn routing, a rebind, persisted or not), so the
 *  meta speaks for the target only when its `describedSession` names it (codex passes 6
 *  and 7 on 0.103.0: a refused attempt to B, or a rebind A→B, left A's or B's session `on`
 *  unpatched on the other's `off`). Unknown: `off`. */
export function reasoningLevelToApply(
  shows: boolean,
  chat: Pick<Doc<"chats">, "sessionSettings" | "sessionMeta">,
  metaDescribesTarget = true,
): "on" | "off" | undefined {
  if (shows) return "on";
  if (chat.sessionSettings?.showReasoning === false) return "off";
  if (!metaDescribesTarget) return "off";
  const live = chat.sessionMeta?.reasoningLevel;
  return live !== undefined && live !== "off" ? "off" : undefined;
}

/** Does the conversation's meta describe the OpenClaw session these ingredients key (the
 *  bridge's `buildSessionKey`, the same string as `buildOpenClawThreadId`)? */
export async function metaDescribesSession(
  chat: Pick<Doc<"chats">, "sessionMeta">,
  instanceName: string,
  key: { agentId: string; canonical: string | null | undefined; chatId: string },
): Promise<boolean> {
  const described = chat.sessionMeta?.describedSession;
  const sessionKey = buildOpenClawThreadId(key);
  return described !== undefined && sessionKey !== null && described === (await sessionDigest(instanceName, sessionKey));
}

type StoredSessionSettings = NonNullable<Doc<"chats">["sessionSettings"]>;
/** The knob intent the bridge receives: the stored one without Atrium's own display choice,
 *  plus the `reasoningLevel` to apply (OpenClaw only). Null when there is nothing to apply —
 *  the bridge's "no intent". */
export type BridgeSessionSettings = Omit<StoredSessionSettings, "showReasoning"> & { reasoningLevel?: "on" | "off" };
export function bridgeSessionSettings(
  stored: Doc<"chats">["sessionSettings"],
  reasoningLevel: "on" | "off" | undefined,
): BridgeSessionSettings | null {
  const { showReasoning: _choice, ...rest } = stored ?? {};
  const out: BridgeSessionSettings = { ...rest, ...(reasoningLevel !== undefined ? { reasoningLevel } : {}) };
  return Object.keys(out).length > 0 ? out : null;
}

/** The reasoning a MESSAGE may hold in its parts, in UTF-8 bytes (codex pass 1 on 0.103.0):
 *  the view reads every part of a window of messages, so what a message stores there is
 *  bounded. A row's reasoning is not a part (read one row at a time, messages.ts
 *  `getRowReasoning`). */
export const MESSAGE_THINKING_BYTES = 16 * 1024;

/** `text` cut to `budget` UTF-8 bytes on a character boundary; `capped` when cut. */
export function capReasoningText(text: string, budget: number): { text: string; capped: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= budget) return { text, capped: false };
  if (budget <= 0) return { text: "", capped: true };
  // `fatal: false` drops a trailing partial character; strip the replacement it leaves.
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, budget)).replace(/�+$/, "");
  return { text: cut, capped: true };
}

/** The work notes a bubble's rows already hold: the item key of each `…:segment:<itemKey>`
 *  row (the Control UI retires a live segment once its keyed row is in the history,
 *  tool-stream-preamble.ts at v2026.9.33). Their parts are not served — the row shows the
 *  note — so no reader, a 0.102.1 frontend after a rollback included, shows it twice (codex
 *  pass 9 on 0.103.0). */
export function persistedNoteKeys(layout: ReadonlyArray<{ entryId: string }> | undefined): Set<string> {
  const keys = new Set<string>();
  for (const r of layout ?? []) {
    const at = r.entryId.lastIndexOf(":segment:");
    if (at >= 0) keys.add(r.entryId.slice(at + ":segment:".length));
  }
  return keys;
}

/** A row layout without its reasoning marks: what a copy of the bubble carries (a fork, an
 *  archive — the reasoning stays in the original rows), and what a conversation that hides
 *  reasoning is shown. The same layout object when it marks nothing. */
export function layoutWithoutReasoning<R extends { thinking?: boolean }>(layout: R[]): R[] {
  if (!layout.some((r) => r.thinking === true)) return layout;
  return layout.map((r) => {
    if (r.thinking !== true) return r;
    const { thinking: _mark, ...rest } = r;
    return rest as R;
  });
}
