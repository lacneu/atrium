// ONE BUBBLE PER DELEGATION CHAIN, AS A DISPLAY GROUP (transcript redesign, phase 5 —
// projection `on`; design §7 and §14).
//
// On a projected instance every run keeps its OWN bubble (phase 4: a bubble is a pure
// function of the rows of its run). Atrium's product choice — a delegation chain reads as
// one answer — is a DISPLAY GROUPING on top of that, computed here from identities only and
// stored as `messages.displayGroupId`, a cache `displayGroups.regroup` recomputes at will.
// Nothing here reads a time, the words of an answer, or the state of a bubble.
//
// THE FACTS (each an identity the gateway writes):
//  - a LAUNCH: run P's `sessions_spawn` result names {childSessionKey, runId}
//    (src/agents/tools/sessions-spawn-tool.ts:670 at v2026.9.8, read from the transcript
//    row — table `transcriptSpawns`);
//  - a TASK START: run P's async tool result names `taskId` (structured, on the live tool
//    frame — `subAgents.startRunId`; chat.history strips the details, design §14.1);
//  - a DELIVERY run's own id: `announce:v1:<childSessionKey>:<childRunId>`
//    (src/agents/announce-idempotency.ts:13-19), `announce:requester-settle:…:<childRunIds>
//    [:yield-N][:retry-N]` (src/agents/subagents/registry/subagent-requester-settle-
//    identity.ts:4-25), `<tool>:<taskId>:ok|error[:agent-loop]`.
//
// THE RULES:
//  - parentOf(announce)  = the unique launcher of its child (run id AND session key match);
//  - parentOf(settle)    = the one chain root every named child's unique launcher has — with
//                          or without `yield-N`: upstream wakes the requester in both cases,
//                          and the no-yield wake is the run spawn-parallel-merge lost;
//  - parentOf(task)      = the unique run that started the task;
//  - chainRoot(R)        = R when it has no parent, else chainRoot(parentOf(R));
//  - a GROUP is a maximal run of CONSECUTIVE displayed assistant bubbles of one session with
//    one chain root (the Control UI groups consecutive items of one run,
//    ui/src/pages/chat/chat-thread-grouping.ts:117-130 — Atrium widens "one run" to "one
//    chain"). Anything displayed between two of them — a message of the user (product
//    decision Q2: the delivery then gets its own bubble under it, transcript order
//    prevails), another run's answer — starts a new group.
//
// FAIL CLOSED (a wrong merge is worse than a separate bubble): a missing fact, an ambiguous
// launcher (two different runs name one child), children of different roots, a cycle or a
// chain deeper than MAX_CHAIN_DEPTH make the run its own root.

import { CHILD_RUN_ID_RE, parseRequesterSettleRun, taskDeliveryIdentity } from "./deliveryRuns";

/** Deepest delegation chain followed (a child launched inside a delivery, inside a
 *  delivery…). Deeper reads as no chain: the run is its own root. */
export const MAX_CHAIN_DEPTH = 8;

/** The lanes upstream appends to an announce identity (lib/deliveryRuns.ts names them). */
const ANNOUNCE_LANES: readonly string[] = ["agent-loop", "wake"];

export type DeliveryParentRef =
  | { kind: "announce"; childSessionKey: string; childRunId: string }
  | { kind: "settle"; childRunIds: string[] }
  | { kind: "task"; taskId: string };

/** What a delivery run's own id says about where it comes from, or null for a run that
 *  delivers nothing (a turn, a cron run, a heartbeat…). */
export function deliveryParentRef(runId: string): DeliveryParentRef | null {
  if (runId.startsWith("announce:requester-settle:")) {
    const settle = parseRequesterSettleRun(runId);
    return settle === null ? null : { kind: "settle", childRunIds: [...settle.childRunIds] };
  }
  if (runId.startsWith("announce:v1:")) {
    const seg = runId.split(":");
    if (ANNOUNCE_LANES.includes(seg[seg.length - 1] ?? "")) seg.pop();
    // announce, v1, at least one key segment, the child run id.
    if (seg.length < 4) return null;
    const childRunId = seg[seg.length - 1]!;
    const childSessionKey = seg.slice(2, -1).join(":");
    if (!CHILD_RUN_ID_RE.test(childRunId) || childSessionKey === "") return null;
    return { kind: "announce", childSessionKey, childRunId };
  }
  const task = taskDeliveryIdentity(runId);
  return task === null ? null : { kind: "task", taskId: task.taskId };
}

/** One launch fact (a `transcriptSpawns` row, as identities). */
export type LaunchFact = {
  parentRunId: string;
  childSessionKey: string;
  sessionKey: string;
  /** The instance whose bridge read the row (absent only in pure tests). */
  instanceName?: string;
};

/** One task start (a `subAgents` task row's `startRunId`, with the instance that wrote it). */
export type TaskStart = { startRunId: string; instanceName?: string };

/** Every fact the rules read, as the loader found them. A key absent from a map means
 *  "no fact" — the loader reads every key the rules may ask for, or marks it unknown (its
 *  facts could not all be read within the bounds, codex phase 5 pass 1 #5): no chain. */
export type ChainFacts = {
  launchesOfChild: ReadonlyMap<string, readonly LaunchFact[]>;
  taskStarts: ReadonlyMap<string, readonly (TaskStart | string)[]>;
  /** Runs whose facts the loader could not finish reading: never chained. */
  unknown?: ReadonlySet<string>;
  /** Child runs / task ids with MORE facts than the loader reads: never a proof. */
  overflow?: ReadonlySet<string>;
};

/** Where a run is resolved: its session and the instance that projects it. A fact of
 *  another session or another instance is never a proof (codex phase 5 pass 1 #1). */
export type ChainScope = { sessionKey: string; instanceName?: string };

/** Most walk steps one resolver takes (each run is walked at most once, memoized). Past
 *  it every run not yet resolved is its own root: fail closed (codex phase 5 pass 1 #3). */
export const MAX_WALK_STEPS = 256;

const distinct = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const sameInstance = (a: string | undefined, b: string | undefined) => (a ?? null) === (b ?? null);

/** A resolved run: its root and its HEIGHT (links up to the root) — memoized by run, so
 *  the result never depends on where the walk entered. */
type Walk = { root: string; height: number } | "fail" | "exhausted";

/**
 * chainRoot over one set of facts, memoized: every run is walked at most ONCE whatever the
 * shape of the chains (a settle wake naming many children of one launcher, many settle
 * levels…), and the number of steps is capped. Cycles, chains taller than MAX_CHAIN_DEPTH
 * and an exhausted step budget fail closed: the run is its own root.
 */
export class ChainResolver {
  private readonly memo = new Map<string, Walk>();
  private readonly active = new Set<string>();
  /** Runs actually walked (memo misses) — what the step cap bounds. */
  steps = 0;

  constructor(
    private readonly facts: ChainFacts,
    private readonly maxSteps = MAX_WALK_STEPS,
  ) {}

  /** The run a chain starts from: the run itself when it continues nothing it can prove. */
  root(runId: string, scope: ChainScope): string {
    const w = this.walk(runId, scope);
    return w === "fail" || w === "exhausted" ? runId : w.root;
  }

  private key(runId: string, scope: ChainScope): string {
    return `${scope.instanceName ?? ""}\u0000${scope.sessionKey}\u0000${runId}`;
  }

  /** The unique launcher of a child run in this scope, or null (none, ambiguous, or more
   *  facts than were read). */
  private launcherOf(childRunId: string, scope: ChainScope, childSessionKey?: string): string | null {
    if (this.facts.overflow?.has(childRunId) === true) return null;
    const launches = (this.facts.launchesOfChild.get(childRunId) ?? []).filter(
      (f) =>
        f.sessionKey === scope.sessionKey &&
        sameInstance(f.instanceName, scope.instanceName) &&
        (childSessionKey === undefined || f.childSessionKey === childSessionKey),
    );
    const parents = distinct(launches.map((f) => f.parentRunId));
    return parents.length === 1 ? parents[0]! : null;
  }

  private startOf(taskId: string, scope: ChainScope): string | null {
    if (this.facts.overflow?.has(taskId) === true) return null;
    const starts = distinct(
      (this.facts.taskStarts.get(taskId) ?? []).flatMap((s) => {
        const start = typeof s === "string" ? { startRunId: s } : s;
        return sameInstance(start.instanceName, scope.instanceName) ? [start.startRunId] : [];
      }),
    );
    return starts.length === 1 ? starts[0]! : null;
  }

  private up(parent: string, scope: ChainScope): Walk {
    const w = this.walk(parent, scope);
    // The step budget ran out somewhere above: nothing below may be resolved from it.
    if (w === "exhausted") return "exhausted";
    if (w === "fail" || w.height + 1 > MAX_CHAIN_DEPTH) return "fail";
    return { root: w.root, height: w.height + 1 };
  }

  private walk(runId: string, scope: ChainScope): Walk {
    const key = this.key(runId, scope);
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    // A run met again while its own walk is open: a cycle.
    if (this.active.has(key)) return "fail";
    if (++this.steps > this.maxSteps) {
      this.memo.set(key, "exhausted");
      return "exhausted";
    }
    this.active.add(key);
    const result = this.resolve(runId, scope);
    this.active.delete(key);
    this.memo.set(key, result);
    return result;
  }

  private resolve(runId: string, scope: ChainScope): Walk {
    const self: Walk = { root: runId, height: 0 };
    if (this.facts.unknown?.has(runId) === true) return self;
    const ref = deliveryParentRef(runId);
    if (ref === null) return self;
    if (ref.kind === "announce") {
      const launcher = this.launcherOf(ref.childRunId, scope, ref.childSessionKey);
      return launcher === null ? self : this.up(launcher, scope);
    }
    if (ref.kind === "task") {
      const start = this.startOf(ref.taskId, scope);
      return start === null ? self : this.up(start, scope);
    }
    // A settle wake: the ONE root its children's launchers share. Launchers are
    // deduplicated before any walk (eight children of one run walk that run once).
    const launchers = new Set<string>();
    for (const child of ref.childRunIds) {
      const launcher = this.launcherOf(child, scope);
      if (launcher === null) return self;
      launchers.add(launcher);
    }
    let joined: { root: string; height: number } | null = null;
    for (const launcher of launchers) {
      const w = this.up(launcher, scope);
      if (w === "exhausted") return "exhausted";
      if (w === "fail") return self;
      if (joined !== null && joined.root !== w.root) return self;
      joined = joined === null ? w : { root: w.root, height: Math.max(joined.height, w.height) };
    }
    return joined ?? self;
  }
}

const scopeOf = (scope: ChainScope | string): ChainScope =>
  typeof scope === "string" ? { sessionKey: scope } : scope;

/** The run a chain starts from: the run itself when it continues nothing it can prove. */
export function chainRoot(runId: string, scope: ChainScope | string, facts: ChainFacts): string {
  return new ChainResolver(facts).root(runId, scopeOf(scope));
}

/** A displayed message, as the grouping reads it (display order is the caller's). */
export type GroupUnit = {
  id: string;
  role: string;
  /** Assistant bubbles of a projected run: their run and session. */
  runId?: string;
  sessionKey?: string;
  /** The instance that owns the bubble (`messages.boundInstance`). */
  instanceName?: string;
  /** The cached group (`messages.displayGroupId`). */
  current?: string;
};

/**
 * The display group of each message of a window, in display order. The first unit's
 * predecessor is outside the window: its cached group is kept as the context the next
 * units join (its own value is only ever SET to its own id, when a group now starts
 * there). Returns the groups that differ from the cache: id → new value (undefined =
 * shown alone).
 */
export function groupMessages(
  units: readonly GroupUnit[],
  rootOf: (runId: string, scope: ChainScope) => string,
): Map<string, string | undefined> {
  const desired = new Map<string, string | undefined>();
  type Open = { key: string; root: string; sessionKey: string; instanceName?: string; members: string[] };
  let open: Open | null = null;
  const closed: Open[] = [];
  const rootFor = (u: GroupUnit): string | null =>
    u.role === "assistant" && u.runId !== undefined && u.sessionKey !== undefined
      ? rootOf(u.runId, { sessionKey: u.sessionKey, ...(u.instanceName !== undefined ? { instanceName: u.instanceName } : {}) })
      : null;
  units.forEach((u, i) => {
    const root = rootFor(u);
    if (
      root !== null &&
      open !== null &&
      open.root === root &&
      open.sessionKey === u.sessionKey &&
      sameInstance(open.instanceName, u.instanceName)
    ) {
      open.members.push(u.id);
      return;
    }
    if (open !== null) closed.push(open);
    open =
      root === null
        ? null
        : {
            // The window's first unit carries the group it already belongs to.
            key: i === 0 && u.current !== undefined ? u.current : u.id,
            root,
            sessionKey: u.sessionKey!,
            ...(u.instanceName !== undefined ? { instanceName: u.instanceName } : {}),
            members: [u.id],
          };
  });
  if (open !== null) closed.push(open);
  const valueOf = new Map<string, string | undefined>();
  for (const g of closed) {
    for (const id of g.members) valueOf.set(id, g.members.length > 1 || g.key !== g.members[0] ? g.key : undefined);
  }
  // The first unit's group was taken from its cache above: its value can only stay, or —
  // when it had none — become the head of a group that now starts with it.
  for (const u of units) {
    const next = valueOf.get(u.id);
    if (next !== u.current) desired.set(u.id, next);
  }
  return desired;
}
