// A SUB-AGENT'S STATUS IS ITS SESSION ROW (0.101.4).
//
// The Control UI reconstructs nothing from the event stream. It reads the child's session
// row from the gateway and renders the row's `status` (ui/src/pages/sessions/
// session-status.ts:17-37 at v2026.9.33): it lists a parent's children with
// `sessions.list { spawnedBy }` (ui/src/lib/sessions/child-session-data.ts:9-17), reads
// one with `sessions.describe { key }` (ui/src/components/app-sidebar-child-session-
// data.ts:100-117), and refreshes on `sessions.changed` (ui/src/lib/sessions/index.ts:
// 538-607) and after a reconnection (index.ts:500-515). Which run the row speaks for is
// decided by the gateway (`getDisplaySubagentRun`, src/agents/subagents/registry/
// subagent-registry-queries.ts:285-303, applied in src/gateway/session-utils-display.ts:
// 148-162). The row is the truth; this file only reads it and hands it to Convex as read.
//
// Triggers, per tracked child:
//   - `sessions.changed` naming the child, whatever its reason (the session-events
//     connection — never the conversation socket, session-events.ts);
//   - the (re)subscription of that connection (`onSubscribed`, also called when a child is
//     attached to a live subscription);
//   - the end of a child run this conversation observed (`runEnded`).
// Reads are coalesced: one in flight per child, at most one more after it. A failed read
// is tried again at the next trigger, and on a progressive capped ladder while the child is
// followed (30 s, 60 s, 120 s, then every 300 s) — one timer per child, no queue.
//
// Tracked: the children this conversation's observer knows, plus the recently finished
// ones. Bounded (MAX_TRACKED, the most recently touched kept), never shared between
// sessions: a new session (a reconnection) relists the parent's children by the upstream
// method (`relistChildren`) instead of inheriting a memory.
//
// Every attachment to the session-events connection is released by `close()` (the
// conversation socket's end) or by eviction, so an instance whose projection is `off` —
// which attaches nothing else — lets that connection close after its linger.

import type { SessionEventListener, SessionEventSource } from "./transcript-shadow.js";
import type { SubAgentRowStatusRecord, SubAgentRowStatusResult } from "../../convex-writer.js";
import { errForLog } from "../../core/log-safe-error.js";

/** How many children one conversation follows at once. */
export const MAX_TRACKED_CHILDREN = 64;
/** A finished child stays followed this long after it was last touched (a late word —
 *  a provisional kill followed by the real end — still reaches it). */
export const FINISHED_CHILD_KEEP_MS = 10 * 60_000;
/** A child the parent's list returns is FOLLOWED when it is live, or finished within
 *  this window ("recently finished"). Every returned row is applied, whatever its age. */
export const RELIST_RECENT_MS = 6 * 60 * 60_000;
/** The first deferred retry after a failed read or write (and the relist's one retry). */
export const ROW_READ_RETRY_MS = 30_000;
/** A failed read or write of a FOLLOWED child is retried on this progressive ladder,
 *  capped at its last step, until a read is applied — Convex or the network can be down
 *  longer than one retry, and after recovery no event may come to read the row again. A
 *  success or a new event starts the ladder over; an unfollowed child has no timer. */
export const ROW_READ_RETRY_LADDER_MS = [30_000, 60_000, 120_000, 300_000] as const;
/** Page size of the parent's child list (child-session-data.ts:7, the Control UI's). */
export const CHILD_LIST_PAGE_SIZE = 100;
/** Safety bound on the `sessions.list` requests one relist makes, all passes together. */
export const MAX_CHILD_LIST_PAGES = 20;
/** Passes over the pages when rows moved while they were read: upstream's
 *  MAX_SESSION_LIST_PASSES (ui/src/lib/sessions/paged-session-rows.ts:3, v2026.9.33). */
export const MAX_CHILD_LIST_PASSES = 4;
const REQUEST_TIMEOUT_MS = 10_000;

/** The request surface this needs (OpenClawConnection satisfies it). */
export interface RowRequester {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ payload?: unknown }>;
}

export interface ChildRowStatusDeps {
  chatId: string;
  /** The conversation's own session key: the children's `spawnedBy`. */
  parentSessionKey: string;
  /** The conversation socket (the Control UI reads rows on the socket that shows them). */
  gateway: RowRequester;
  write: (record: SubAgentRowStatusRecord) => Promise<SubAgentRowStatusResult>;
  /** A COMPLETE child list of this parent: the running children Convex knows that the
   *  list no longer has — candidates, each then READ (only the gateway's
   *  `{ session: null }` makes one gone). Absent ⇒ not asked. */
  missing?: (parentKey: string, presentKeys: string[]) => Promise<string[]>;
  /** The instance's session-events connection. Absent ⇒ only `runEnded` and the
   *  relist read. */
  events?: SessionEventSource;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  now?: () => number;
  log?: (line: string) => void;
  maxTracked?: number;
}

/** The query the Control UI lists a parent's children with (child-session-data.ts:9-17). */
export function childSessionListQuery(parentKey: string, offset = 0): Record<string, unknown> {
  return {
    spawnedBy: parentKey,
    limit: CHILD_LIST_PAGE_SIZE,
    includeGlobal: false,
    includeUnknown: false,
    configuredAgentsOnly: true,
    // A later page only (child-session-data.ts:42-45).
    ...(offset > 0 ? { offset } : {}),
  };
}

/** What Atrium forwards of one row — the fields the badge and the ordering need, as
 *  read; `null` when the value is not a row. */
export function rowStatusOf(
  chatId: string,
  childSessionKey: string,
  raw: unknown,
): SubAgentRowStatusRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const record: SubAgentRowStatusRecord = { chatId, childSessionKey };
  if (typeof row.status === "string" && row.status.length <= 32) record.status = row.status;
  if (typeof row.hasActiveRun === "boolean") record.hasActiveRun = row.hasActiveRun;
  if (typeof row.lastRunId === "string" && row.lastRunId.length > 0 && row.lastRunId.length <= 256) {
    record.runId = row.lastRunId;
  }
  if (typeof row.snapshotAt === "number" && Number.isFinite(row.snapshotAt)) {
    record.snapshotAt = row.snapshotAt;
  }
  const parent = row.spawnedBy ?? row.parentSessionKey;
  if (typeof parent === "string" && parent.length > 0 && parent.length <= 512) {
    record.parentKey = parent;
  }
  return record;
}

function isLive(record: SubAgentRowStatusRecord): boolean {
  return (
    record.hasActiveRun === true ||
    record.status === "running" ||
    record.status === "queued" ||
    record.status === undefined
  );
}

interface Tracked {
  readonly key: string;
  detach: (() => void) | null;
  inFlight: boolean;
  again: boolean;
  retryTimer: { cancel(): void } | null;
  /** Failed reads in the current streak: the step of the retry ladder. */
  retries: number;
  /** The last row read said the child is not running. */
  finished: boolean;
  touchedAt: number;
}

export class ChildRowStatus {
  private readonly tracked = new Map<string, Tracked>();
  private closed = false;
  private relistRetry: { cancel(): void } | null = null;
  private relistRetried = false;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTracked: number;
  /** Counters (tests, diagnostics). */
  readonly stats = { reads: 0, readFailures: 0, writes: 0, relists: 0, retries: 0, evictions: 0 };

  constructor(private readonly deps: ChildRowStatusDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      });
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
    this.maxTracked = deps.maxTracked ?? MAX_TRACKED_CHILDREN;
  }

  /** Children followed now (tests, diagnostics). */
  get trackedKeys(): string[] {
    return [...this.tracked.keys()];
  }

  /** A child this conversation knows (its observer saw it). Idempotent. */
  track(childKey: string): void {
    this.ensureTracked(childKey);
  }

  /** A run of this child, observed on the conversation socket, ended: read its row. */
  runEnded(childKey: string): void {
    // A child new to this socket reads now, then again once attached (below).
    const known = this.tracked.has(childKey);
    if (this.ensureTracked(childKey, () => this.trigger(childKey, false)) !== null && known) {
      this.trigger(childKey, false);
    }
  }

  /**
   * A new conversation socket (a reconnection, or the first one): read the parent's
   * children by the upstream method, write EVERY row returned, and follow the live and
   * recently finished ones (bounded). Nothing is inherited from an earlier socket.
   */
  async relistChildren(): Promise<void> {
    if (this.closed) return;
    this.stats.relists++;
    // EVERY page, as the Control UI reads a parent's children (`fetchChildSessionRows`,
    // ui/src/lib/sessions/child-session-data.ts:40-53, through `fetchPagedSessionRows`,
    // ui/src/lib/sessions/paged-session-rows.ts:3-82, v2026.9.33):
    //   - a pass walks the pages from offset 0: `hasMore` (else `totalCount`), to
    //     `nextOffset` (else `offset` + rows read), stopping on an offset that does not
    //     advance (:24-65);
    //   - rows are kept one per key, the last read (:47-49);
    //   - the list is sorted by `updatedAt`, so a row can move between windows while the
    //     pages are read (:73): when the distinct keys fall short of the announced
    //     `totalCount` and the pass added any, another pass runs — at most
    //     MAX_CHILD_LIST_PASSES, upstream's MAX_SESSION_LIST_PASSES (:3, :66-74).
    // Atrium reads raw pages, each holding only its own rows: that is upstream's PAGE
    // mode (the Control UI's "window" mode reads a store that already accumulates the
    // pages, :36-41). Every request counts against MAX_CHILD_LIST_PAGES. A list still
    // short after the passes is applied as read and retried once, deferred (upstream
    // refuses it: :75-81 — Atrium keeps what it read, each row ordered by `snapshotAt`).
    const byKey = new Map<string, unknown>();
    let expectedTotal: number | undefined;
    let requests = 0;
    try {
      for (let pass = 0; pass < MAX_CHILD_LIST_PASSES && requests < MAX_CHILD_LIST_PAGES; pass++) {
        const before = byKey.size;
        const seen = new Set<number>();
        let offset = 0;
        while (!seen.has(offset) && requests < MAX_CHILD_LIST_PAGES) {
          seen.add(offset);
          requests++;
          const res = await this.deps.gateway.request(
            "sessions.list",
            childSessionListQuery(this.deps.parentSessionKey, offset),
            REQUEST_TIMEOUT_MS,
          );
          const payload = res.payload as
            | {
                sessions?: unknown;
                hasMore?: unknown;
                nextOffset?: unknown;
                offset?: unknown;
                totalCount?: unknown;
              }
            | undefined;
          const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
          if (typeof payload?.totalCount === "number") {
            expectedTotal = Math.max(expectedTotal ?? 0, payload.totalCount);
          }
          for (const raw of sessions) {
            const key = (raw as { key?: unknown } | null)?.key;
            if (typeof key === "string") byKey.set(key, raw);
          }
          const hasMore =
            typeof payload?.hasMore === "boolean"
              ? payload.hasMore
              : typeof payload?.totalCount === "number" &&
                offset + sessions.length < payload.totalCount;
          if (!hasMore) break;
          const next =
            typeof payload?.nextOffset === "number"
              ? payload.nextOffset
              : (typeof payload?.offset === "number" ? payload.offset : offset) + sessions.length;
          if (next <= offset) break;
          offset = next;
        }
        if (byKey.size === before || expectedTotal === undefined || byKey.size >= expectedTotal) {
          break;
        }
      }
    } catch (err) {
      this.log(
        `[subagent-row] chat=${this.deps.chatId} child list failed (non-fatal): ${errForLog(err)}`,
      );
      this.armRelistRetry();
      return;
    }
    const incomplete = expectedTotal !== undefined && byKey.size < expectedTotal;
    // A COMPLETE list (every page, every pass, nothing short) also names the running
    // children it no longer has (a deleted child, or one this socket never heard of — a
    // reconnection inherits no memory). A list is a sample: a child spawned after it would
    // be "missing" too. So each candidate is only READ, and only the gateway's own
    // `{ session: null }` makes it gone.
    let reconciled: Promise<unknown> = Promise.resolve();
    if (!incomplete && this.deps.missing !== undefined) {
      const present = [...byKey.keys()];
      reconciled = this.deps.missing(this.deps.parentSessionKey, present).then((keys) => {
        for (const key of keys) this.runEnded(key);
      });
    }
    if (this.closed) return;
    const now = this.now();
    let taken = 0;
    const untrackedWrites: Array<Promise<unknown>> = [];
    for (const raw of byKey.values()) {
      const row = raw as Record<string, unknown> | null;
      const key = typeof row?.key === "string" ? row.key : null;
      if (key === null || key === this.deps.parentSessionKey) continue;
      // The filter is the gateway's; a row naming another parent is not ours to write.
      const owner = row?.spawnedBy ?? row?.parentSessionKey;
      if (typeof owner === "string" && owner !== this.deps.parentSessionKey) continue;
      const record = rowStatusOf(this.deps.chatId, key, row);
      if (record === null) continue;
      // EVERY returned row is applied — a correction the gateway made while no socket
      // listened (a provisional `done` turned `timeout`) holds however old it is. The
      // window and the bound only decide which children are FOLLOWED from now on.
      const updatedAt = typeof row?.updatedAt === "number" ? row.updatedAt : null;
      const recent = isLive(record) || (updatedAt !== null && now - updatedAt <= RELIST_RECENT_MS);
      if (recent && taken < this.maxTracked) {
        // The listed row is written first; the attachment then reads the row once more
        // (`describe`), so a correction published between the list and the attachment —
        // which a subscription already live for another conversation does not replay —
        // is not lost. The newer of the two wins by `snapshotAt`.
        const known = this.tracked.has(key);
        const entry = this.ensureTracked(key, () => this.trigger(key, false, record));
        if (entry !== null) {
          taken++;
          if (known) this.trigger(key, false, record);
          continue;
        }
      }
      this.stats.writes++;
      untrackedWrites.push(this.deps.write(record));
    }
    // A write that failed is retried with the whole list, once (the followed children
    // retry on their own triggers). `no_row` is an answer, not a failure: a child Convex
    // never recorded has nothing to correct.
    const failed = (await Promise.allSettled([...untrackedWrites, reconciled])).some(
      (r) => r.status === "rejected",
    );
    if (!failed && !incomplete) {
      this.relistRetried = false;
    } else {
      this.log(
        `[subagent-row] chat=${this.deps.chatId} ${
          failed ? "a relisted row write failed" : `the child list stayed short (${byKey.size}/${expectedTotal})`
        } (non-fatal)`,
      );
      this.armRelistRetry();
    }
  }

  private armRelistRetry(): void {
    if (this.closed || this.relistRetried || this.relistRetry !== null) return;
    this.relistRetried = true;
    this.relistRetry = this.setTimer(() => {
      this.relistRetry = null;
      void this.relistChildren();
    }, ROW_READ_RETRY_MS);
  }

  /** The conversation socket closed: release everything. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relistRetry?.cancel();
    this.relistRetry = null;
    for (const entry of [...this.tracked.values()]) this.untrack(entry);
  }

  /** Follow a child. A NEW entry runs `first` (its initial write or read) BEFORE it is
   *  attached; the attachment's `onSubscribed` — synchronous on a live subscription,
   *  later otherwise — then always reads the row once more. */
  private ensureTracked(childKey: string, first?: () => void): Tracked | null {
    if (this.closed || childKey === "" || childKey.startsWith("task:")) return null;
    const existing = this.tracked.get(childKey);
    if (existing !== undefined) {
      existing.touchedAt = this.now();
      return existing;
    }
    this.prune();
    const entry: Tracked = {
      key: childKey,
      detach: null,
      inFlight: false,
      again: false,
      retryTimer: null,
      retries: 0,
      finished: false,
      touchedAt: this.now(),
    };
    this.tracked.set(childKey, entry);
    first?.();
    const events = this.deps.events;
    if (events !== undefined) {
      const listener: SessionEventListener = {
        onSessionMessage: () => {},
        onSessionsChanged: () => this.trigger(childKey, false),
        onSubscribed: () => this.trigger(childKey, false),
      };
      try {
        entry.detach = events.attach(childKey, listener);
      } catch (err) {
        this.log(
          `[subagent-row] chat=${this.deps.chatId} session events unavailable (non-fatal): ${errForLog(err)}`,
        );
      }
    }
    return entry;
  }

  /** Bound the set: drop finished children past their keep window, then the least
   *  recently touched (a finished one first) while the set is full. */
  private prune(): void {
    const now = this.now();
    for (const entry of [...this.tracked.values()]) {
      if (entry.finished && !entry.inFlight && now - entry.touchedAt > FINISHED_CHILD_KEEP_MS) {
        this.untrack(entry);
      }
    }
    while (this.tracked.size >= this.maxTracked) {
      let victim: Tracked | null = null;
      for (const entry of this.tracked.values()) {
        if (
          victim === null ||
          (entry.finished && !victim.finished) ||
          (entry.finished === victim.finished && entry.touchedAt < victim.touchedAt)
        ) {
          victim = entry;
        }
      }
      if (victim === null) break;
      this.stats.evictions++;
      this.untrack(victim);
    }
  }

  private untrack(entry: Tracked): void {
    if (this.tracked.get(entry.key) === entry) this.tracked.delete(entry.key);
    entry.retryTimer?.cancel();
    entry.retryTimer = null;
    entry.again = false;
    const detach = entry.detach;
    entry.detach = null;
    try {
      detach?.();
    } catch {
      /* already detached */
    }
  }

  private alive(entry: Tracked): boolean {
    return !this.closed && this.tracked.get(entry.key) === entry;
  }

  private trigger(childKey: string, fromRetry: boolean, prefetched?: SubAgentRowStatusRecord): void {
    const entry = this.tracked.get(childKey);
    if (entry === undefined || this.closed) return;
    entry.touchedAt = this.now();
    if (!fromRetry) {
      // A new event starts the ladder over: its own failure arms the first step.
      entry.retries = 0;
      entry.retryTimer?.cancel();
      entry.retryTimer = null;
    }
    if (entry.inFlight) {
      // Coalesced: whatever this trigger brought, the read after the one in flight
      // reads the row again.
      entry.again = true;
      return;
    }
    void this.run(entry, prefetched);
  }

  private async run(entry: Tracked, prefetched?: SubAgentRowStatusRecord): Promise<void> {
    entry.inFlight = true;
    let failed = false;
    try {
      let record = prefetched ?? null;
      if (record === null) {
        this.stats.reads++;
        const res = await this.deps.gateway.request(
          "sessions.describe",
          { key: entry.key },
          REQUEST_TIMEOUT_MS,
        );
        if (!this.alive(entry)) return;
        const payload = res.payload as { session?: unknown } | undefined;
        // `{ session: null }`: the gateway STATES there is no such session any more (a
        // child deleted by `cleanup: "delete"`). The Control UI then shows no row
        // (app-sidebar-child-session-data.ts:112-120); Atrium says the row is gone, so the
        // card never keeps a live state with nothing behind it. A payload without the
        // field says nothing and writes nothing.
        record =
          payload !== null && typeof payload === "object" && "session" in payload && payload.session === null
            ? { chatId: this.deps.chatId, childSessionKey: entry.key, absent: true }
            : rowStatusOf(this.deps.chatId, entry.key, payload?.session);
      }
      if (record !== null) {
        this.stats.writes++;
        const result = await this.deps.write(record);
        // No row in Convex yet (its creation still in flight): not a status to drop.
        if (!result.applied && result.reason === "no_row") failed = true;
        else entry.finished = record.absent === true || !isLive(record);
      }
    } catch (err) {
      failed = true;
      this.log(
        `[subagent-row] chat=${this.deps.chatId} row read failed (non-fatal): ${errForLog(err)}`,
      );
    } finally {
      entry.inFlight = false;
    }
    if (!this.alive(entry)) return;
    if (failed) {
      this.stats.readFailures++;
      if (entry.retryTimer === null) {
        const ladder = ROW_READ_RETRY_LADDER_MS;
        const delay = ladder[Math.min(entry.retries, ladder.length - 1)]!;
        entry.retries++;
        entry.retryTimer = this.setTimer(() => {
          entry.retryTimer = null;
          if (!this.alive(entry)) return;
          this.stats.retries++;
          this.trigger(entry.key, true);
        }, delay);
      }
    } else {
      entry.retries = 0;
      entry.retryTimer?.cancel();
      entry.retryTimer = null;
    }
    if (entry.again) {
      entry.again = false;
      void this.run(entry);
    }
  }
}
