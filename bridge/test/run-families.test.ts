// THE ANNOUNCE GRAMMAR HAS LANES, AND SLICING BLINDLY LOSES THE CHILD.
//
// `announce:v1:<childKey>:<childRunId>` used to be the whole story, so both
// readers took the key with `split(":").slice(2, -1)`. Upstream now composes a
// delivery LANE on top of that identity — `:agent-loop` (subagent-announce-
// delivery.ts:229) and `:wake` (subagent-announce-descendant-wake.ts:111) — so
// the child run id is no longer the last segment. Dropping the last segment then
// folds the run id INTO the key, `settleAnnouncedChild` matches no row, and a
// finished child holds the chat as `running` until the reaper.
//
// convex/lib/deliveryRuns.ts reads the same grammar for the same rows and carries
// the same lane list; the two must stay in lockstep.

import { describe, expect, it } from "vitest";
import { announcedChildKey } from "../src/providers/openclaw/run-families.js";

const CHILD = "agent:main:subagent:worker";
const RUN = "run-1";

describe("announcedChildKey", () => {
  it("resolves the bare v1 identity", () => {
    expect(announcedChildKey(`announce:v1:${CHILD}:${RUN}`)).toBe(CHILD);
  });

  it("resolves the SAME key through an :agent-loop lane", () => {
    expect(announcedChildKey(`announce:v1:${CHILD}:${RUN}:agent-loop`)).toBe(CHILD);
  });

  it("resolves the SAME key through a :wake lane", () => {
    expect(announcedChildKey(`announce:v1:${CHILD}:${RUN}:wake`)).toBe(CHILD);
  });

  it("leaves an UNKNOWN trailing segment in the key rather than guessing", () => {
    // Fail visible, not silent: a lane upstream adds later must be listed
    // deliberately. Eating any suffix would mis-correlate to a real row.
    expect(announcedChildKey(`announce:v1:${CHILD}:${RUN}:brand-new`)).toBe(
      `${CHILD}:${RUN}`,
    );
  });

  it("refuses every non-announce identity", () => {
    for (const runId of [
      "webchat-abc",
      "announce:requester-settle:main:agent:main:k:r1",
      "image_generate:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:ok:agent-loop",
      "",
      null,
      undefined,
    ]) {
      expect(announcedChildKey(runId), String(runId)).toBeNull();
    }
  });

  it("refuses a truncated identity instead of returning an empty key", () => {
    expect(announcedChildKey("announce:v1:only")).toBeNull();
    expect(announcedChildKey("announce:v1:only:wake")).toBeNull();
  });
});

// THE LIMIT OF THE GRAMMAR, pinned so it is deliberate and not accidental.
//
// Upstream builds the identity by CONCATENATION, unescaped
// (`announce-idempotency.ts:13`: `v1:${childSessionKey}:${childRunId}`), and a child run
// id may itself contain a colon — upstream's own suite has one ending in `:wake`
// (`subagent-announce.format.e2e.test.ts:1103`). So `…:<lane>` and `…:<runId ending in a
// lane word>` are not distinguishable from the string alone. Stripping a trailing lane is
// still STRICTLY better than not: before it, EVERY lane run folded the run id into the
// key and settled nothing. What remains wrong is one pathological shape — a child run id
// that IS exactly a lane word — and the fix for it is not more parsing but ground truth
// (the row lookup), which only the Convex side can do.
describe("the lane grammar is ambiguous by construction — pin what we chose", () => {
  it("a run id that merely ENDS in a lane word still resolves correctly", () => {
    // Upstream's own case: two segments of run id, the last of which is `wake`.
    expect(
      announcedChildKey("announce:v1:agent:main:subagent:test:run-no-reply:wake"),
    ).toBe("agent:main:subagent:test");
  });

  it("a run id that IS a lane word is mis-parsed — the known, accepted residue", () => {
    // Documented, not desired: the key loses its last segment. Nothing in the string can
    // tell this apart from a real lane. If upstream ever mints such a run id, the settle
    // misses and the child waits for the reaper — the SAME outcome as before the lane fix
    // existed, never a wrong child (the shortened key matches no row).
    expect(announcedChildKey("announce:v1:agent:main:subagent:worker:wake")).toBe(
      "agent:main:subagent",
    );
  });

  it("a generation other than v1 is refused HERE — and deliberately NOT in convex", () => {
    // The two readers answer different questions and their breadths differ on purpose.
    // This one only SETTLES rows it can name, so refusing an unknown generation costs a
    // reaper wait and never a wrong write. convex/lib/deliveryRuns.ts stays broad
    // (`announce:`) because it sits on the INGEST AUTHORIZATION path: narrowing it to
    // `v1:` was tried on 2026-09-12 and let a FORGED `announce:1:spy-child:done` through
    // with 200 instead of 403 — recognising an announce-SHAPED identity is what lets it
    // be refused. Do not "align" these two without reading that test.
    expect(announcedChildKey("announce:v2:agent:main:subagent:worker:run-1")).toBeNull();
  });
});
