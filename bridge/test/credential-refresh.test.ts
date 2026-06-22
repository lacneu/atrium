// Boot self-heal loop: the bridge ALWAYS starts and retries the per-bridge secrets that
// have not resolved, registering each instance the instant Convex has a valid config —
// no restart. These tests drive passes via refresh.tick() and assert OUTCOMES (an
// instance becomes registered / stays pending / the loop stops), not "the loop ran".
// Scheduling is checked through an injected setTimer that records but never auto-fires.

import { describe, it, expect, vi } from "vitest";
import {
  startCredentialRefresh,
  type RegisterOutcome,
} from "../src/core/credential-refresh.js";
import type {
  ConfigIssue,
  ResolveOneResult,
} from "../src/core/credential-resolver.js";
import type { InstanceData } from "../src/config.js";

const okData = (name: string): InstanceData => ({
  instanceName: name,
  gatewayUrl: "wss://gw/ws",
  token: "t",
  deviceIdentity: { id: "d", publicKey: "p", privateKey: "k" },
  gatewayVersion: null,
  gatewayHttpUrl: null,
  kind: "openclaw",
});

/** A scheduler that RECORDS calls but never auto-fires — the test drives ticks itself,
 *  so scheduling behavior (one retry per pass, stop when drained) is observable. */
function fakeScheduler() {
  let seq = 0;
  const setTimer = vi.fn((_fn: () => void, _ms: number) => {
    return ++seq as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimer = vi.fn((_h: ReturnType<typeof setTimeout>) => {});
  return { setTimer, clearTimer };
}

describe("startCredentialRefresh (boot self-heal)", () => {
  it("HEADLINE: a bad_device instance stays pending, then SERVES after the config is fixed — no restart", async () => {
    const sched = fakeScheduler();
    let issues: ConfigIssue[] = [];
    const registered: string[] = [];
    // resolveOne flips from bad_device -> ok, modeling the operator entering the device
    // identity in Convex between two retry passes.
    let result: ResolveOneResult = {
      ok: false,
      reason: "bad_device",
      instanceName: "olivier",
    };
    const refresh = startCredentialRefresh({
      pending: ["sec-olivier"],
      resolveOne: async () => result,
      register: (data): RegisterOutcome => {
        registered.push(data.instanceName);
        return "registered";
      },
      intervalMs: 30_000,
      onIssues: (i) => {
        issues = i;
      },
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    // Pass 1: still misconfigured -> NOT registered, kept pending, the surfaced reason
    // NAMES the instance (the whole point of the /health surface), a retry is scheduled.
    await refresh.tick();
    expect(registered).toEqual([]);
    expect(refresh.pendingCount()).toBe(1);
    expect(issues).toEqual([{ instanceName: "olivier", reason: "bad_device" }]);
    expect(sched.setTimer).toHaveBeenCalledTimes(1);
    expect(sched.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 30_000);

    // Operator enters the device identity; the next retry resolves.
    result = { ok: true, data: okData("olivier") };
    await refresh.tick();
    expect(registered).toEqual(["olivier"]); // now serving
    expect(refresh.pendingCount()).toBe(0);
    expect(issues).toEqual([]); // /health clean
    // Loop STOPS once nothing is pending (pass 2 schedules NO further retry).
    expect(sched.setTimer).toHaveBeenCalledTimes(1);
  });

  it("a media-dir collision keeps the instance PENDING (a rename can fix it) + surfaces the reason", async () => {
    const sched = fakeScheduler();
    let issues: ConfigIssue[] = [];
    let outcome: RegisterOutcome = "collision";
    const refresh = startCredentialRefresh({
      pending: ["s"],
      resolveOne: async () => ({ ok: true, data: okData("dup") }),
      register: () => outcome,
      intervalMs: 10_000,
      onIssues: (i) => {
        issues = i;
      },
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await refresh.tick();
    expect(refresh.pendingCount()).toBe(1); // collision -> kept pending, NOT dropped
    expect(issues).toEqual([
      { instanceName: "dup", reason: "media_dir_collision" },
    ]);
    expect(sched.setTimer).toHaveBeenCalledTimes(1); // keeps retrying

    // Operator renames in Convex so the dir no longer collides -> registers.
    outcome = "registered";
    await refresh.tick();
    expect(refresh.pendingCount()).toBe(0);
    expect(issues).toEqual([]);
  });

  it("a duplicate (a second secret -> already-served instance) is dropped with no issue", async () => {
    const sched = fakeScheduler();
    let issues: ConfigIssue[] = [];
    const refresh = startCredentialRefresh({
      pending: ["s"],
      resolveOne: async () => ({ ok: true, data: okData("olivier") }),
      register: () => "duplicate",
      intervalMs: 10_000,
      onIssues: (i) => {
        issues = i;
      },
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await refresh.tick();
    expect(refresh.pendingCount()).toBe(0); // redundant secret dropped
    expect(issues).toEqual([]);
    expect(sched.setTimer).not.toHaveBeenCalled(); // nothing pending -> no retry
  });

  it("schedules exactly ONE retry per pass (recursive setTimeout — never stacking)", async () => {
    const sched = fakeScheduler();
    const refresh = startCredentialRefresh({
      pending: ["s"],
      resolveOne: async () => ({ ok: false, reason: "unreachable" }),
      register: () => "registered",
      intervalMs: 7_000,
      onIssues: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await refresh.tick();
    await refresh.tick();
    // Two passes -> two retries scheduled, one per pass — never two stacked from one pass.
    expect(sched.setTimer).toHaveBeenCalledTimes(2);
    expect(sched.setTimer).toHaveBeenNthCalledWith(1, expect.any(Function), 7_000);
    expect(sched.setTimer).toHaveBeenNthCalledWith(2, expect.any(Function), 7_000);
  });

  it("the SCHEDULED callback actually re-runs a pass (the loop self-heals, not just tick())", async () => {
    // The wire that makes this feature self-healing: the fn handed to setTimer must
    // re-invoke tick. Every other test drives passes manually, so without this one a
    // refactor to `setTimer(() => {})` would keep all tests green while the prod bridge
    // boots, does ONE pass, and never retries — the user fixes the config and nothing
    // happens until a manual restart. Capture the scheduled fn and fire it.
    let fired: (() => void) | undefined;
    let seq = 0;
    const setTimer = vi.fn((fn: () => void, _ms: number) => {
      fired = fn;
      return ++seq as unknown as ReturnType<typeof setTimeout>;
    });
    const resolveOne = vi.fn(
      async (): Promise<ResolveOneResult> => ({ ok: false, reason: "unreachable" }),
    );
    const refresh = startCredentialRefresh({
      pending: ["s"],
      resolveOne,
      register: () => "registered",
      intervalMs: 1_000,
      onIssues: () => {},
      setTimer,
      clearTimer: vi.fn(),
    });

    await refresh.tick(); // pass 1 (manual) -> schedules the retry callback
    expect(resolveOne).toHaveBeenCalledTimes(1);
    expect(fired).toBeTypeOf("function");

    fired!(); // what setTimeout would fire -> MUST run another pass
    await vi.waitFor(() => expect(resolveOne).toHaveBeenCalledTimes(2));

    refresh.stop();
  });

  it("stop() clears the pending retry and halts further passes", async () => {
    const sched = fakeScheduler();
    const resolveOne = vi.fn(
      async (): Promise<ResolveOneResult> => ({
        ok: false,
        reason: "unreachable",
      }),
    );
    const refresh = startCredentialRefresh({
      pending: ["s"],
      resolveOne,
      register: () => "registered",
      intervalMs: 10_000,
      onIssues: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await refresh.tick(); // schedules a retry
    expect(sched.setTimer).toHaveBeenCalledTimes(1);
    const callsBefore = resolveOne.mock.calls.length;

    refresh.stop();
    expect(sched.clearTimer).toHaveBeenCalledTimes(1);

    await refresh.tick(); // stopped -> no resolution work
    expect(resolveOne.mock.calls.length).toBe(callsBefore);
  });
});
