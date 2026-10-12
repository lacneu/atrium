// THE DELEGATION CHAIN AS A DISPLAY GROUP — the pure rules (transcript redesign phase 5,
// design §14.2). Truth tables for `parentOf` / `chainRoot` (proof present, absent,
// ambiguous, children of different roots, cycle, depth) and for `groupMessages` (a message
// of the user in between, another run's answer in between, another session, the window's
// first unit), then property tests over random chains: replay, permutation of the facts,
// retry-N, yield-N, interleaved user messages, injected ambiguity.

import { describe, expect, test } from "vitest";
import {
  chainRoot,
  deliveryParentRef,
  groupMessages,
  MAX_CHAIN_DEPTH,
  ChainResolver,
  type ChainFacts,
  type ChainScope,
  type GroupUnit,
  type LaunchFact,
} from "./delegationChain";
import { deliveryIdentityKey } from "./deliveryRuns";

const SK = "agent:alice:atrium:chat:u:c1";
const P = "webchat-" + "a".repeat(64);
const childKey = (n: string) => `agent:files:subagent:${n}`;
const announce = (n: string, run: string) => `announce:v1:${childKey(n)}:${run}`;
const settle = (runs: string[], suffix = "") =>
  `announce:requester-settle:alice:${SK}:${[...runs].sort().join(",")}${suffix}`;

function facts(
  launches: Array<[parent: string, child: string, run: string, session?: string]>,
  tasks: Array<[taskId: string, run: string]> = [],
): ChainFacts {
  const launchesOfChild = new Map<string, LaunchFact[]>();
  for (const [parentRunId, child, run, session] of launches) {
    const list = launchesOfChild.get(run) ?? [];
    list.push({ parentRunId, childSessionKey: childKey(child), sessionKey: session ?? SK });
    launchesOfChild.set(run, list);
  }
  const taskStarts = new Map<string, string[]>();
  for (const [taskId, run] of tasks) taskStarts.set(taskId, [...(taskStarts.get(taskId) ?? []), run]);
  return { launchesOfChild, taskStarts };
}

describe("deliveryParentRef — the delivery grammars", () => {
  test.each([
    [announce("a", "run-a"), { kind: "announce", childSessionKey: childKey("a"), childRunId: "run-a" }],
    [`${announce("a", "run-a")}:agent-loop`, { kind: "announce", childSessionKey: childKey("a"), childRunId: "run-a" }],
    [`${announce("a", "run-a")}:wake`, { kind: "announce", childSessionKey: childKey("a"), childRunId: "run-a" }],
    [settle(["r2", "r1"], ":yield-1"), { kind: "settle", childRunIds: ["r1", "r2"] }],
    [settle(["r1"]), { kind: "settle", childRunIds: ["r1"] }],
    [settle(["r1"], ":yield-2:retry-3"), { kind: "settle", childRunIds: ["r1"] }],
    ["image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok", { kind: "task", taskId: "bf66f802-e5a6-4394-9815-40c4bcd28dae" }],
    [
      "image_generate:tool:image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok:agent-loop",
      { kind: "task", taskId: "tool:image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae" },
    ],
  ])("%s", (runId, expected) => {
    expect(deliveryParentRef(runId)).toEqual(expected);
  });

  test.each([P, "announce:v1:", "announce:v1:k", "announce:v2:k:run", "announce:v1:k:bad run", "cron:abc", "heartbeat"])(
    "%s delivers nothing",
    (runId) => {
      expect(deliveryParentRef(runId)).toBeNull();
    },
  );
});

describe("chainRoot — truth table", () => {
  const A = announce("a", "run-a");
  test("an announce whose launch the transcript shows: its launcher", () => {
    expect(chainRoot(A, SK, facts([[P, "a", "run-a"]]))).toBe(P);
  });
  test("no launch row: its own root", () => {
    expect(chainRoot(A, SK, facts([]))).toBe(A);
  });
  test("a launch of the same run under ANOTHER child key: not this child — own root", () => {
    expect(chainRoot(A, SK, facts([[P, "other", "run-a"]]))).toBe(A);
  });
  test("two different launchers name the child (ambiguous): own root", () => {
    expect(chainRoot(A, SK, facts([[P, "a", "run-a"], ["webchat-q", "a", "run-a"]]))).toBe(A);
  });
  test("the same launcher named twice (a replayed row): still that launcher", () => {
    expect(chainRoot(A, SK, facts([[P, "a", "run-a"], [P, "a", "run-a"]]))).toBe(P);
  });
  test("a launch in ANOTHER session: own root", () => {
    expect(chainRoot(A, SK, facts([[P, "a", "run-a", "agent:bob:atrium:chat:u:c1"]]))).toBe(A);
  });
  test("a chain: a child launched inside an announce reaches the turn", () => {
    const f = facts([[P, "a", "run-a"], [A, "b", "run-b"]]);
    expect(chainRoot(announce("b", "run-b"), SK, f)).toBe(P);
  });
  test("a settle wake WITH yield: the root its children share", () => {
    const f = facts([[P, "a", "r1"], [P, "b", "r2"]]);
    expect(chainRoot(settle(["r1", "r2"], ":yield-1"), SK, f)).toBe(P);
  });
  test("a settle wake WITHOUT yield (spawn-parallel-merge's): the same root", () => {
    // B and C launched inside A's announce, A inside the turn.
    const f = facts([[P, "a", "run-a"], [A, "b", "r-b"], [A, "c", "r-c"]]);
    expect(chainRoot(settle(["r-b", "r-c"]), SK, f)).toBe(P);
  });
  test("retry-N and yield-N name the same children: the same root", () => {
    const f = facts([[P, "a", "r1"]]);
    for (const suffix of ["", ":yield-1", ":yield-4", ":retry-2", ":yield-1:retry-9"]) {
      expect(chainRoot(settle(["r1"], suffix), SK, f)).toBe(P);
    }
  });
  test("a settle naming children of DIFFERENT roots: own root", () => {
    const f = facts([[P, "a", "r1"], ["webchat-q", "b", "r2"]]);
    const R = settle(["r1", "r2"], ":yield-1");
    expect(chainRoot(R, SK, f)).toBe(R);
  });
  test("a settle with one child whose launch is unknown: own root", () => {
    const f = facts([[P, "a", "r1"]]);
    const R = settle(["r1", "r2"], ":yield-1");
    expect(chainRoot(R, SK, f)).toBe(R);
  });
  test("a task delivery: the run that started the task", () => {
    const T = "image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok";
    expect(chainRoot(T, SK, facts([], [["bf66f802-e5a6-4394-9815-40c4bcd28dae", P]]))).toBe(P);
    expect(chainRoot(T, SK, facts([]))).toBe(T);
    expect(
      chainRoot(T, SK, facts([], [["bf66f802-e5a6-4394-9815-40c4bcd28dae", P], ["bf66f802-e5a6-4394-9815-40c4bcd28dae", "webchat-q"]])),
    ).toBe(T);
  });
  test("a task started inside an announce: the turn", () => {
    const T = "image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok";
    const f = facts([[P, "a", "run-a"]], [["bf66f802-e5a6-4394-9815-40c4bcd28dae", A]]);
    expect(chainRoot(T, SK, f)).toBe(P);
  });
  test("a cycle: own root", () => {
    const X = announce("x", "run-x");
    const Y = announce("y", "run-y");
    const f = facts([[Y, "x", "run-x"], [X, "y", "run-y"]]);
    expect(chainRoot(X, SK, f)).toBe(X);
    expect(chainRoot(Y, SK, f)).toBe(Y);
  });
  test(`a chain deeper than ${MAX_CHAIN_DEPTH}: own root; at the bound: the turn`, () => {
    const build = (depth: number) => {
      const launches: Array<[string, string, string]> = [];
      let parent = P;
      let last = P;
      for (let i = 0; i < depth; i++) {
        launches.push([parent, `c${i}`, `run-${i}`]);
        last = announce(`c${i}`, `run-${i}`);
        parent = last;
      }
      return { f: facts(launches), last };
    };
    const ok = build(MAX_CHAIN_DEPTH);
    expect(chainRoot(ok.last, SK, ok.f)).toBe(P);
    const deep = build(MAX_CHAIN_DEPTH + 2);
    expect(chainRoot(deep.last, SK, deep.f)).toBe(deep.last);
  });
  test("runs whose facts could not be read are never chained", () => {
    const f = { ...facts([[P, "a", "run-a"]]), unknown: new Set([A]) };
    expect(chainRoot(A, SK, f)).toBe(A);
  });
  test("an ordinary run is its own root", () => {
    expect(chainRoot(P, SK, facts([[P, "a", "run-a"]]))).toBe(P);
  });
});

const u = (id: string): GroupUnit => ({ id, role: "user" });
const a = (id: string, runId: string, current?: string, sessionKey = SK): GroupUnit => ({
  id,
  role: "assistant",
  runId,
  sessionKey,
  ...(current !== undefined ? { current } : {}),
});

describe("groupMessages — truth table", () => {
  const A = announce("a", "run-a");
  const root = (f: ChainFacts) => (runId: string, sk: ChainScope) => chainRoot(runId, sk, f);
  const f = facts([[P, "a", "run-a"]]);
  test("the turn and its delivery, consecutive: one group keyed by the turn's bubble", () => {
    const out = groupMessages([u("u1"), a("mP", P), a("mA", A)], root(f));
    expect(Object.fromEntries(out)).toEqual({ mP: "mP", mA: "mP" });
  });
  test("Q2 — a message of the user in between: the delivery stands alone under it", () => {
    const out = groupMessages([u("u1"), a("mP", P), u("u2"), a("mA", A)], root(f));
    expect(out.size).toBe(0);
  });
  test("another run's answer in between: alone (a group never jumps a message)", () => {
    const out = groupMessages([u("u1"), a("mP", P), a("mX", "cron-run"), a("mA", A)], root(f));
    expect(out.size).toBe(0);
  });
  test("another session: alone", () => {
    const out = groupMessages([u("u1"), a("mP", P), a("mA", A, undefined, "agent:bob:atrium:chat:u:c1")], root(f));
    expect(out.size).toBe(0);
  });
  test("no proof: alone", () => {
    const out = groupMessages([u("u1"), a("mP", P), a("mA", A)], root(facts([])));
    expect(out.size).toBe(0);
  });
  test("a chain of three: one group", () => {
    const B = announce("b", "run-b");
    const out = groupMessages([u("u1"), a("mP", P), a("mA", A), a("mB", B)], root(facts([[P, "a", "run-a"], [A, "b", "run-b"]])));
    expect(Object.fromEntries(out)).toEqual({ mP: "mP", mA: "mP", mB: "mP" });
  });
  test("the window's first unit carries its cached group, and is never cleared", () => {
    const out = groupMessages([a("mP", P, "mOld"), a("mA", A)], root(f));
    expect(Object.fromEntries(out)).toEqual({ mA: "mOld" });
    const alone = groupMessages([a("mP", P, "mOld"), u("u2")], root(f));
    expect(alone.size).toBe(0);
  });
  test("the window's first unit becomes the head of a group that now starts with it", () => {
    const out = groupMessages([a("mP", P), a("mA", A)], root(f));
    expect(Object.fromEntries(out)).toEqual({ mP: "mP", mA: "mP" });
  });
  test("a stale cache is corrected: a member left alone is cleared", () => {
    const out = groupMessages([u("u1"), a("mP", P, "mP"), u("u2"), a("mA", A, "mP")], root(f));
    expect(Object.fromEntries(out)).toEqual({ mP: undefined, mA: undefined });
  });
  test("idempotent: applying the changes then grouping again changes nothing", () => {
    const units = [u("u1"), a("mP", P), a("mA", A)];
    const out = groupMessages(units, root(f));
    const applied = units.map((x) => (out.has(x.id) ? { ...x, current: out.get(x.id) } : x));
    expect(groupMessages(applied, root(f)).size).toBe(0);
  });
});

// ── Properties over random chains ────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type World = {
  launches: Array<[string, string, string]>;
  /** Every delivery run and the chain root it truly belongs to. */
  truth: Map<string, string>;
  /** Display order of the bubbles (and user messages). */
  units: GroupUnit[];
  /** Runs made ambiguous on purpose (a second launcher injected). */
  ambiguous: Set<string>;
};

function randomWorld(seed: number): World {
  const r = rng(seed);
  const launches: Array<[string, string, string]> = [];
  const truth = new Map<string, string>();
  const ambiguous = new Set<string>();
  const units: GroupUnit[] = [];
  let id = 0;
  const turns = 1 + Math.floor(r() * 3);
  for (let t = 0; t < turns; t++) {
    const turn = `webchat-${seed}-${t}`;
    truth.set(turn, turn);
    units.push(u(`u${id++}`));
    units.push(a(`m${id++}`, turn));
    // Runs of this chain able to launch, and the children launched so far.
    const launchers = [turn];
    const children: string[] = [];
    const steps = 1 + Math.floor(r() * 6);
    for (let s = 0; s < steps; s++) {
      const kind = r();
      if (kind < 0.5 || children.length === 0) {
        // a launch then its announce
        const parent = launchers[Math.floor(r() * launchers.length)]!;
        const n = `c${seed}x${t}x${s}`;
        const run = `run-${seed}-${t}-${s}`;
        launches.push([parent, n, run]);
        children.push(run);
        const A = announce(n, run);
        truth.set(A, turn);
        launchers.push(A);
        if (r() < 0.15) {
          // ambiguity injected: a foreign run names the same child
          launches.push([`webchat-foreign-${seed}-${s}`, n, run]);
          ambiguous.add(A);
        }
        if (r() < 0.25) units.push(u(`u${id++}`)); // the user writes in between
        if (r() < 0.8) units.push(a(`m${id++}`, A));
      } else {
        // a settle wake over some children of this chain (yield-N / retry-N variants)
        const pick = children.filter(() => r() < 0.6);
        if (pick.length === 0) continue;
        const suffix = [":yield-1", "", ":retry-2", ":yield-3:retry-1"][Math.floor(r() * 4)]!;
        const R = settle(pick, suffix);
        truth.set(R, turn);
        if (r() < 0.25) units.push(u(`u${id++}`));
        units.push(a(`m${id++}`, R));
      }
    }
  }
  return { launches, truth, units, ambiguous };
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("properties over random chains", () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  test("a root is ON the run's own chain (itself, an ancestor, the turn) — never another chain's", () => {
    for (const seed of SEEDS) {
      const w = randomWorld(seed);
      const f = facts(w.launches);
      for (const [run, root] of w.truth) {
        const got = chainRoot(run, SK, f);
        // Every root a run of a chain can get is a run of THAT chain: the same true root.
        expect(w.truth.get(got) ?? got).toBe(root);
      }
    }
  });

  test("an announce with a unique launch chain is joined to its turn", () => {
    for (const seed of SEEDS) {
      const w = randomWorld(seed);
      const f = facts(w.launches);
      for (const [run, root] of w.truth) {
        if (!run.startsWith("announce:v1:")) continue;
        // Every launch on the way up must be unambiguous.
        let cur = run;
        let clean = true;
        while (cur !== root) {
          if (w.ambiguous.has(cur)) clean = false;
          const ref = deliveryParentRef(cur);
          if (ref?.kind !== "announce") break;
          cur = w.launches.find(([, , r]) => r === ref.childRunId)![0];
        }
        if (clean) expect(chainRoot(run, SK, f)).toBe(root);
        // An ambiguous link stops the walk there: the root is that link or below it,
        // never the turn it cannot prove.
        else expect(chainRoot(run, SK, f)).not.toBe(root);
      }
    }
  });

  test("the groups do not depend on the order the facts arrived in (replay included)", () => {
    for (const seed of SEEDS) {
      const w = randomWorld(seed);
      const base = groupMessages(w.units, (run, sk) => chainRoot(run, sk, facts(w.launches)));
      const replayed = [...w.launches, ...w.launches.slice(0, Math.floor(w.launches.length / 2))];
      const again = groupMessages(w.units, (run, sk) => chainRoot(run, sk, facts(shuffled(replayed, seed * 7))));
      expect(Object.fromEntries(again)).toEqual(Object.fromEntries(base));
    }
  });

  test("a group never spans a message of the user, and holds one root, maximally", () => {
    for (const seed of SEEDS) {
      const w = randomWorld(seed);
      const f = facts(w.launches);
      const out = groupMessages(w.units, (run, sk) => chainRoot(run, sk, f));
      const group = (x: GroupUnit) => (out.has(x.id) ? out.get(x.id) : x.current);
      for (let i = 1; i < w.units.length; i++) {
        const prev = w.units[i - 1]!;
        const cur = w.units[i]!;
        const g = group(cur);
        if (cur.role === "assistant" && prev.role === "assistant") {
          const same = chainRoot(prev.runId!, SK, f) === chainRoot(cur.runId!, SK, f);
          // Maximal: consecutive bubbles of one root ARE grouped; others never are.
          if (same) expect(g).toBeDefined();
          if (same) expect(g).toBe(group(prev));
          else if (g !== undefined) expect(g).not.toBe(group(prev));
        }
        if (cur.role === "assistant" && g !== undefined && prev.role === "user") {
          // A group starts right under a user message: the bubble heads it.
          expect(g).toBe(cur.id);
        }
      }
    }
  });

  test("idempotent: grouping again over the applied cache changes nothing", () => {
    for (const seed of SEEDS) {
      const w = randomWorld(seed);
      const rootOf = (run: string, sk: ChainScope) => chainRoot(run, sk, facts(w.launches));
      const out = groupMessages(w.units, rootOf);
      const applied = w.units.map((x) => (out.has(x.id) ? { ...x, current: out.get(x.id) } : x));
      expect(groupMessages(applied, rootOf).size).toBe(0);
    }
  });
});

describe("codex phase 5 pass 1 — bounded, scoped, complete proofs", () => {
  /** 8 settle levels, each naming 8 children all launched by the level above. */
  function wideTallChain(levels: number, width: number) {
    const launches: Array<[string, string, string]> = [];
    let launcher = P;
    let last = P;
    for (let l = 0; l < levels; l++) {
      const runs: string[] = [];
      for (let c = 0; c < width; c++) {
        const run = `r${l}x${c}`;
        launches.push([launcher, `l${l}c${c}`, run]);
        runs.push(run);
      }
      last = settle(runs, ":yield-1");
      launcher = last;
    }
    return { f: facts(launches), last };
  }

  test("#3 an 8-level × 8-children settle chain is resolved in one walk per run (steps counted, not time)", () => {
    const { f, last } = wideTallChain(8, 8);
    const resolver = new ChainResolver(f);
    expect(resolver.root(last, { sessionKey: SK })).toBe(P);
    // One step per distinct run: the 8 settle wakes and the turn.
    expect(resolver.steps).toBe(9);
    // Asked again (another bubble of the window): memoized, no step.
    resolver.root(last, { sessionKey: SK });
    expect(resolver.steps).toBe(9);
  });

  test("#3 the step cap fails closed: an unresolved run is its own root", () => {
    const { f, last } = wideTallChain(8, 8);
    const capped = new ChainResolver(f, 4);
    expect(capped.root(last, { sessionKey: SK })).toBe(last);
    expect(capped.steps).toBeLessThanOrEqual(5);
  });

  test("#5 more launch facts than were read is never a proof", () => {
    const A = announce("a", "run-a");
    expect(chainRoot(A, SK, { ...facts([[P, "a", "run-a"]]), overflow: new Set(["run-a"]) })).toBe(A);
    const T = "image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok";
    const tf = facts([], [["bf66f802-e5a6-4394-9815-40c4bcd28dae", P]]);
    expect(chainRoot(T, SK, { ...tf, overflow: new Set(["bf66f802-e5a6-4394-9815-40c4bcd28dae"]) })).toBe(T);
  });

  test("#1 a launch stated by ANOTHER instance is never a proof", () => {
    const A = announce("a", "run-a");
    const f: ChainFacts = {
      launchesOfChild: new Map([["run-a", [{ parentRunId: P, childSessionKey: childKey("a"), sessionKey: SK, instanceName: "intruder" }]]]),
      taskStarts: new Map(),
    };
    expect(chainRoot(A, { sessionKey: SK, instanceName: "prod" }, f)).toBe(A);
    expect(chainRoot(A, { sessionKey: SK, instanceName: "intruder" }, f)).toBe(P);
    const tf: ChainFacts = { launchesOfChild: new Map(), taskStarts: new Map([["t1", [{ startRunId: P, instanceName: "intruder" }]]]) };
    expect(chainRoot("image_generate:t1:ok", { sessionKey: SK, instanceName: "prod" }, tf)).toBe("image_generate:t1:ok");
  });

  test("#1 bubbles of two instances never share a group", () => {
    const A = announce("a", "run-a");
    const f: ChainFacts = {
      launchesOfChild: new Map([["run-a", [{ parentRunId: P, childSessionKey: childKey("a"), sessionKey: SK, instanceName: "prod" }]]]),
      taskStarts: new Map(),
    };
    const units: GroupUnit[] = [
      { id: "mP", role: "assistant", runId: P, sessionKey: SK, instanceName: "prod" },
      { id: "mA", role: "assistant", runId: A, sessionKey: SK, instanceName: "other" },
    ];
    expect(groupMessages(units, (run, scope) => chainRoot(run, scope, f)).size).toBe(0);
  });
});

describe("deliveryIdentityKey — what makes two delivery runs the SAME delivery (codex phase 5 pass 6 #1)", () => {
  test.each([
    // [a, b, same delivery?]
    [settle(["r1", "r2"], ":yield-1"), settle(["r2", "r1"], ":yield-1:retry-1"), true],
    [settle(["r1"], ""), settle(["r1"], ":retry-3"), true],
    [settle(["r1"], ":yield-1"), settle(["r1"], ":yield-2"), true],
    [settle(["r1"], ":yield-1"), settle(["r1", "r2"], ":yield-1"), false],
    [announce("a", "run-a"), announce("a", "run-a"), true],
    [announce("a", "run-a"), `${announce("a", "run-a")}:agent-loop`, false],
    [announce("a", "run-a"), announce("a", "run-b"), false],
    ["image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok", "image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok", true],
    ["image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:ok", "image_generate:bf66f802-e5a6-4394-9815-40c4bcd28dae:error", false],
  ])("%s ~ %s → %s", (a, b, same) => {
    expect(deliveryIdentityKey(a) === deliveryIdentityKey(b)).toBe(same);
  });
  test("a run that delivers nothing has no identity", () => {
    expect(deliveryIdentityKey(P)).toBeNull();
    expect(deliveryIdentityKey(undefined)).toBeNull();
  });
});
