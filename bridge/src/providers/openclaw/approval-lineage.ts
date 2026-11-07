// WHOSE APPROVAL IS IT? A conversation answers for its own session AND its descendants.
//
// Upstream addresses an approval to a LINEAGE, not to one session: the raising session,
// then every ancestor, walked through the sub-agent registry (controller / requester) and,
// failing that, the session's stored `parentSessionKey` / `spawnedBy`
// (src/gateway/approval-session-audience.ts:52-107 at v2026.9.36). The Control UI shows a
// descendant's request in the parent's pane, marked "requested by session …"
// (ui/src/pages/chat/session-approval-projection.ts:31-49,96-116,
// ui/src/components/exec-approval-card.ts:400-408). Atrium reads the operator broadcast,
// whose `request.sessionKey` names the RAISING session (server-methods/approval-shared.ts:
// 133-147, 340-368) — a sub-agent's own key — so a conversation that accepts only its own
// key never shows the approval its sub-agent waits on: the child then stays blocked until
// the gateway's timeout (30 min for exec).
//
// This file decides membership, fail-closed, and never by name alone:
//   1. the conversation's own key (exact, or differing only in case — the gateway
//      canonicalizes stored keys);
//   2. a child this conversation KNOWS: its sub-agent observer registered it (spawn result
//      on the parent's own lane, or `spawnedBy` = the parent on its frames) or its row
//      follower listed it (`sessions.list { spawnedBy: parent }`). Both are the gateway's
//      own lineage: a session row's `spawnedBy` IS the registry owner, else the stored
//      parent (src/gateway/session-utils-row.ts:618);
//   3. otherwise, for a sub-agent session only (the keys upstream gives a lineage to,
//      server-chat.ts:401-411), the gateway's row of that session, walked up
//      (`sessions.describe` → `spawnedBy`, else `parentSessionKey`) until it reaches this
//      conversation (a descendant) or anything else (not ours). This covers what the
//      first two cannot know yet: a broadcast that beats the child's first frame, the
//      replay after a reconnection (the new socket's observer starts empty), a grandchild.
// Anything not proven is not ours: another conversation's request is never shown here.

/** What a session is to this conversation. */
export type LineageMatch =
  | { relation: "self" }
  | {
      relation: "descendant";
      /** The bubble the descendant was spawned from, when this conversation knows it. */
      anchorMessageId: string | null;
    };

export interface ApprovalLineageDeps {
  /** The conversation's own session key. */
  sessionKey: string;
  /** A child this conversation knows (sub-agent observer, row follower), with its anchor. */
  knownChild: (key: string) => { anchorMessageId: string | null } | null;
  /** `sessions.describe { key }` on the conversation's socket: the gateway's row of `key`,
   *  or null when it has none. Throws on a transport failure (nothing is cached then). */
  describe: (key: string) => Promise<Record<string, unknown> | null>;
  nowMs: () => number;
}

/** The deepest walk up a lineage. Upstream bounds a whole audience at 64 sessions
 *  (operator-approval-store.rows.ts:32); a sub-agent tree is far shallower in practice,
 *  and each step here is one gateway read. */
export const MAX_LINEAGE_DEPTH = 8;
/** How long a session proven NOT ours stays refused without asking again. A foreign
 *  sub-agent's approval reaches every conversation socket, so each would otherwise ask the
 *  gateway once per sighting. */
export const REFUSED_LINEAGE_TTL_MS = 5 * 60_000;
const MAX_REMEMBERED = 256;

/** Upstream `isSubagentSessionKey` (src/sessions/session-key-utils.ts:83-93): `subagent:`
 *  as the key, or as the rest of an `agent:<id>:` key. */
export function isSubagentSessionKey(key: string): boolean {
  const raw = key.trim().toLowerCase();
  if (raw === "") return false;
  if (raw.startsWith("subagent:")) return true;
  const m = /^agent:[^:]+:(.*)$/.exec(raw);
  return m !== null && m[1]!.startsWith("subagent:");
}

function sameKey(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

function parentOfRow(row: Record<string, unknown> | null): string | null {
  if (row === null) return null;
  for (const field of ["spawnedBy", "parentSessionKey"] as const) {
    const v = row[field];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

export class ApprovalLineage {
  /** Descendants the gateway's rows proved, with the anchor inherited from the known
   *  ancestor the walk reached. */
  private readonly proven = new Map<string, { anchorMessageId: string | null }>();
  /** Sessions proven not ours, until when (epoch ms). */
  private readonly refused = new Map<string, number>();

  constructor(private readonly deps: ApprovalLineageDeps) {}

  /** Synchronous membership: self, a known child, or a descendant already proven. */
  known(key: string | null | undefined): LineageMatch | null {
    if (typeof key !== "string" || key === "") return null;
    if (sameKey(key, this.deps.sessionKey)) return { relation: "self" };
    const child = this.deps.knownChild(key);
    if (child !== null) return { relation: "descendant", anchorMessageId: child.anchorMessageId };
    const proven = this.proven.get(key);
    if (proven !== undefined) return { relation: "descendant", anchorMessageId: proven.anchorMessageId };
    return null;
  }

  /** Membership, asking the gateway's rows when nothing local can tell (see the header). */
  async resolve(key: string | null | undefined): Promise<LineageMatch | null> {
    const local = this.known(key);
    if (local !== null || typeof key !== "string" || key === "") return local;
    if (!isSubagentSessionKey(key)) return null;
    const refusedUntil = this.refused.get(key);
    if (refusedUntil !== undefined && refusedUntil > this.deps.nowMs()) return null;
    const chain: string[] = [key];
    let current = key;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      let row: Record<string, unknown> | null;
      try {
        row = await this.deps.describe(current);
      } catch {
        return null; // transient: not ours for now, and nothing remembered
      }
      const parent = parentOfRow(row);
      if (parent === null) break;
      const reached = this.known(parent);
      if (reached !== null) {
        const anchorMessageId = reached.relation === "descendant" ? reached.anchorMessageId : null;
        for (const k of chain) this.remember(this.proven, k, { anchorMessageId });
        return { relation: "descendant", anchorMessageId };
      }
      if (!isSubagentSessionKey(parent) || chain.some((k) => sameKey(k, parent))) break;
      chain.push(parent);
      current = parent;
    }
    const until = this.deps.nowMs() + REFUSED_LINEAGE_TTL_MS;
    for (const k of chain) this.remember(this.refused, k, until);
    return null;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_REMEMBERED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
