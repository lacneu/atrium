// AN APPROVAL'S IDENTITY — its id AND its generation, everywhere.
//
// The generation is the gateway's creation time of the request (`createdAtMs`: on its
// broadcast, on each pending-list entry, on its `approval.get` snapshot), the key Convex
// gives a card (convex/agentRequests.ts).
//
// UPSTREAM, AN ID NAMES ONE REQUEST (v2026.9.36). Each is minted at random for its request —
// src/agents/bash-tools.exec-host-shared.ts:209 (`crypto.randomUUID()`),
// src/agents/bash-tools.exec-host-node.ts:329, src/gateway/node-invoke-plugin-approval.ts:184
// (`plugin:${randomUUID()}`) — and the durable registry refuses a second record under an
// existing id (src/gateway/operator-approval-store.kernel.ts:140, `onConflict(approval_id)
// .doNothing()`, then `conflict`). So an id never comes back with another generation, and the
// generation adds nothing to WHICH request an id names: what it is needed for is to date a
// verdict that reaches Convex before its card (convex/agentRequests.ts keepResolution), and to
// check that an `approval.get` snapshot is the announced request's. Keying every mark by the
// full identity costs nothing while ids are unique, and keeps one rule everywhere.
//
// One rule for every memory of a decided approval (the observer's, the run manager's, the
// normalizer's): a mark names an identity, and blocks only that identity. A resolution
// broadcast names no generation (src/gateway/server-methods/approval-shared.ts:59-65 at
// v2026.9.36), nor does a run's own frame: each is about the generation announced for its id
// — the one still waiting when exactly one is, else the only one known —
// `ApprovalGenerations.attach`.

/** A generation; `null` when it is not known. */
export type ApprovalGeneration = number | null;

/** The gateway's creation time as a generation: a finite, non-negative number, else none. */
export function readApprovalGeneration(value: unknown): ApprovalGeneration {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One key per identity. An unknown generation is its own value, never a wildcard. */
export function approvalIdentity(id: string, generation: ApprovalGeneration | undefined): string {
  return `${id}\u0000${generation === null || generation === undefined ? "?" : String(generation)}`;
}

/** A bounded, insertion-ordered set of identities (the oldest is forgotten first). */
export class ApprovalIdentitySet {
  private readonly keys = new Set<string>();
  constructor(private readonly max: number) {}
  add(id: string, generation: ApprovalGeneration | undefined): void {
    const key = approvalIdentity(id, generation);
    this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.max) {
      const oldest = this.keys.values().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
  }
  has(id: string, generation: ApprovalGeneration | undefined): boolean {
    return this.keys.has(approvalIdentity(id, generation));
  }
  delete(id: string, generation: ApprovalGeneration | undefined): void {
    this.keys.delete(approvalIdentity(id, generation));
  }
}

/**
 * The generations announced for each approval id, each marked once seen resolved. Bounded
 * (ids, and generations per id). What names no generation is about the one announced and
 * still waiting when there is exactly one, else about the only one known (`attach`).
 */
export class ApprovalGenerations {
  private readonly byId = new Map<string, Map<number, boolean>>();
  private static readonly PER_ID = 8;
  constructor(private readonly max: number) {}

  announce(id: string, generation: ApprovalGeneration | undefined): void {
    if (generation === null || generation === undefined) return;
    const known = this.byId.get(id) ?? new Map<number, boolean>();
    this.byId.delete(id);
    this.byId.set(id, known);
    if (!known.has(generation)) known.set(generation, false);
    while (known.size > ApprovalGenerations.PER_ID) {
      const oldest = known.keys().next().value;
      if (oldest === undefined) break;
      known.delete(oldest);
    }
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  resolve(id: string, generation: ApprovalGeneration | undefined): void {
    if (generation === null || generation === undefined) return;
    this.announce(id, generation);
    this.byId.get(id)?.set(generation, true);
  }

  /** The generation of `id` announced here and not seen resolved, when exactly one is;
   *  else the only one known (a late repeat of its decision); else none. */
  attach(id: string): ApprovalGeneration {
    const known = this.byId.get(id);
    if (known === undefined) return null;
    const waiting = [...known].filter(([, resolved]) => !resolved).map(([generation]) => generation);
    if (waiting.length === 1) return waiting[0]!;
    if (waiting.length === 0 && known.size === 1) return known.keys().next().value ?? null;
    return null;
  }
}
