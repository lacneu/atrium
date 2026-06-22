// Boot self-heal: the bridge ALWAYS starts (Mars robustness — a misconfigured instance
// must never crash the process). This loop owns ALL credential resolution: it resolves
// every per-bridge secret and registers each instance the moment Convex has a valid
// config for it, retrying the ones that are unconfigured/misconfigured until they
// resolve. So a bridge that booted with 0 (or partial) instances becomes complete
// WITHOUT a restart the instant the operator fixes the config in Convex.
//
// Scheduling is a RECURSIVE setTimeout, NOT setInterval: each resolveOne is bounded
// (AbortSignal.timeout in the resolver) and several secrets may be pending, so a slow
// Convex could make one pass run for many seconds. The next pass is scheduled only
// AFTER the current one finishes, so passes never overlap/stack. The timer is unref'd
// (never keeps the process alive) and the loop stops once nothing is pending.

import type {
  ConfigIssue,
  ResolveOneResult,
} from "./credential-resolver.js";
import type { InstanceData } from "../config.js";

/** Result of attempting to register a resolved instance. */
export type RegisterOutcome =
  // Built + added to the served map (now routable).
  | "registered"
  // Its instance is already served (a second secret for the same instance) — the
  // redundant secret is dropped, no issue raised.
  | "duplicate"
  // Its media dir clashes with an already-served instance — kept PENDING (a rename in
  // Convex changes the derived dir and clears it), surfaced as a config issue.
  | "collision";

export interface CredentialRefreshDeps {
  /** Secrets that must be resolved (all of them at boot; the loop drops each as it
   *  resolves). The array is copied — the caller's list is not mutated. */
  pending: string[];
  /** Resolve ONE secret against Convex (never throws — returns a reason on failure). */
  resolveOne: (secret: string) => Promise<ResolveOneResult>;
  /** Build + register a resolved instance (bundle + served.set + reaper). SYNCHRONOUS. */
  register: (data: InstanceData) => RegisterOutcome;
  /** Retry interval (ms) between passes over the still-pending secrets. */
  intervalMs: number;
  /** Called after EVERY pass with the CURRENT pending issues (drives /health). */
  onIssues: (issues: ConfigIssue[]) => void;
  /** Non-secret log sink. */
  log?: (message: string) => void;
  /** Injectable timer (tests). Defaults to an unref'd global setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable clear (tests). Defaults to clearTimeout. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CredentialRefresh {
  /** Run ONE pass now (boot's first pass + the unit-test entry point). Resolves when the
   *  pass finishes; it also (re)schedules the next pass while anything stays pending. */
  tick: () => Promise<void>;
  /** Stop the loop (graceful shutdown). Idempotent. */
  stop: () => void;
  /** Secrets still unresolved (test seam). */
  pendingCount: () => number;
}

const defaultSetTimer = (
  fn: () => void,
  ms: number,
): ReturnType<typeof setTimeout> => {
  const h = setTimeout(fn, ms);
  if (typeof h.unref === "function") h.unref();
  return h;
};

export function startCredentialRefresh(
  deps: CredentialRefreshDeps,
): CredentialRefresh {
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  // The still-pending secrets (dropped as each resolves). Secret VALUES live only here,
  // in memory — never logged or emitted.
  const pending = [...deps.pending];
  // Last known issue per still-pending secret, so onIssues reports an accurate reason
  // (not a placeholder) for each one.
  const reasons = new Map<string, ConfigIssue>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const emitIssues = (): void => {
    deps.onIssues(
      pending.map((s) => reasons.get(s) ?? { reason: "unreachable" }),
    );
  };

  const drop = (secret: string): void => {
    const i = pending.indexOf(secret);
    if (i >= 0) pending.splice(i, 1);
    reasons.delete(secret);
  };

  const onePass = async (): Promise<void> => {
    // Snapshot: registrations mutate `pending` mid-pass; iterate a copy so the loop is
    // well-defined. A throw in one secret never aborts the pass (Mars robustness).
    for (const secret of [...pending]) {
      if (stopped) return;
      try {
        const r = await deps.resolveOne(secret);
        if (!r.ok) {
          reasons.set(secret, { instanceName: r.instanceName, reason: r.reason });
          continue;
        }
        const outcome = deps.register(r.data);
        if (outcome === "collision") {
          reasons.set(secret, {
            instanceName: r.data.instanceName,
            reason: "media_dir_collision",
          });
          deps.log?.(
            `instance "${r.data.instanceName}" resolved but its media dir collides with an already-served instance — kept pending (rename it in Convex to fix)`,
          );
          continue;
        }
        drop(secret);
        deps.log?.(
          outcome === "registered"
            ? `instance "${r.data.instanceName}" now resolved and serving`
            : `a secret resolves to already-served instance "${r.data.instanceName}"; dropping the redundant secret`,
        );
      } catch (err) {
        // Defensive: register/buildBundle should not throw, but one bad secret must
        // never kill the pass or the loop.
        reasons.set(secret, { reason: "bad_value" });
        deps.log?.(
          `unexpected error registering a resolved instance (kept pending): ${(err as Error)?.message ?? err}`,
        );
      }
    }
  };

  const schedule = (): void => {
    if (stopped || pending.length === 0) return;
    timer = setTimer(() => {
      void tick();
    }, deps.intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await onePass();
    } finally {
      // Always reflect the latest state + (re)schedule, even if a pass threw.
      emitIssues();
      schedule();
    }
  };

  return {
    tick,
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    pendingCount: () => pending.length,
  };
}
