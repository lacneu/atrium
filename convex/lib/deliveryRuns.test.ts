import { describe, expect, it } from "vitest";
import {
  deliveryChildKey,
  deliveryPartStamp,
  followedUpChildRunIds,
  isDeliveryRun,
  isRequesterSettleRun,
  parseRequesterSettleRun,
  taskDeliveryIdentity,
  taskDeliveryOutcome,
} from "./deliveryRuns";

const TASK = "85dce36f-67dc-4c37-bc05-cf20c24e122a";

describe("task-delivery run ids across gateway generations", () => {
  it("2026.7.1 shape (pinned live 2026-07-12): <tool>:<taskId>:<ok|error>", () => {
    expect(deliveryChildKey(`image_generate:${TASK}:ok`)).toBe(`task:${TASK}`);
    expect(taskDeliveryOutcome(`image_generate:${TASK}:error`)).toBe("error");
  });
  it("2026.8.x shape (captured 2026-09-02 on 2026.8.2): the `:agent-loop` lane is appended", () => {
    const rid = `image_generate:${TASK}:error:agent-loop`;
    expect(deliveryChildKey(rid)).toBe(`task:${TASK}`);
    expect(taskDeliveryOutcome(rid)).toBe("error");
    expect(taskDeliveryIdentity(rid)).toEqual({ toolName: "image_generate", taskId: TASK });
    expect(isDeliveryRun(rid)).toBe(true);
    expect(taskDeliveryOutcome(`image_generate:${TASK}:ok:agent-loop`)).toBe("ok");
  });
  it("2026.9.7 shape (captured 2026-10-03): the task id is the media run id `tool:<tool>:<uuid>`", () => {
    const id = `tool:image_generate:${TASK}`;
    const rid = `image_generate:${id}:ok:agent-loop`;
    expect(deliveryChildKey(rid)).toBe(`task:${id}`);
    expect(taskDeliveryOutcome(rid)).toBe("ok");
    expect(taskDeliveryIdentity(rid)).toEqual({ toolName: "image_generate", taskId: id });
    expect(isDeliveryRun(rid)).toBe(true);
    expect(isDeliveryRun("image_generate:tool:image_generate:not-a-uuid:ok")).toBe(false);
  });
  it("2026.8.1+ requester-settle wake: gateway-initiated, but NO child key (captured 2026-09-02)", () => {
    const rid =
      "announce:requester-settle:alice:agent:alice:atrium:chat:u-repro:turn-nx77:5f36a848-c5f1-41f3-811e-fd5796c0c531";
    expect(isRequesterSettleRun(rid)).toBe(true);
    expect(deliveryChildKey(rid)).toBeNull();
    expect(taskDeliveryOutcome(rid)).toBeNull();
    expect(isDeliveryRun(rid)).toBe(true);
    expect(isRequesterSettleRun("announce:v1:agent:files:subagent:abc:def")).toBe(false);
  });
  it("fails closed on any lane it does not know", () => {
    for (const rid of [
      `image_generate:${TASK}:ok:other-lane`,
      `image_generate:${TASK}:ok:agent-loop:x`,
      `image_generate:${TASK}:agent-loop`,
      "webchat-0ad6c740504bd56662d39314b2ee513e994d51f9",
    ]) {
      expect(deliveryChildKey(rid)).toBeNull();
      expect(taskDeliveryOutcome(rid)).toBeNull();
      expect(isDeliveryRun(rid)).toBe(false);
    }
  });
});

// THE LANE SUFFIX, ON THE ANNOUNCE FAMILY. `TASK_DELIVERY_RE` already tolerates
// `:agent-loop` for the task family — the announce family above it never got the
// same treatment, so `seg.slice(2, -1)` eats the lane and folds the child RUN id
// into the child KEY. The row then never settles and the chat holds the child as
// `running` until the reaper. Upstream mints both suffixes:
//   subagent-announce-delivery.ts:229        -> `…:agent-loop`
//   subagent-announce-descendant-wake.ts:111 -> `…:wake`
describe("announce delivery lanes", () => {
  const CHILD = "agent:main:subagent:worker";
  const RUN = "run-1";

  it("the bare v1 form still resolves its child key", () => {
    expect(deliveryChildKey(`announce:v1:${CHILD}:${RUN}`)).toBe(CHILD);
  });

  it("an :agent-loop lane resolves the SAME child key", () => {
    expect(deliveryChildKey(`announce:v1:${CHILD}:${RUN}:agent-loop`)).toBe(CHILD);
  });

  it("a :wake lane resolves the SAME child key", () => {
    expect(deliveryChildKey(`announce:v1:${CHILD}:${RUN}:wake`)).toBe(CHILD);
  });

  it("an unknown trailing segment is NOT stripped — it may be the run id", () => {
    // Fail closed: only the two lanes upstream actually mints are removed. A
    // future suffix must be added deliberately, never guessed at.
    expect(deliveryChildKey(`announce:v1:${CHILD}:${RUN}:something-new`)).toBe(
      `${CHILD}:${RUN}`,
    );
  });
});

// THE REQUESTER-SETTLE GRAMMAR (OpenClaw v2026.9.6,
// subagent-announce.requester-settle-wake.ts:433-440 + :501-505, announce-idempotency.ts:18-20).
// The production id below is the one from prod chat mh74rj7t… (2026-09-26).
describe("requester-settle run grammar", () => {
  const PROD =
    "announce:requester-settle:meta:agent:meta:atrium:chat:olivier:mh74rj7t29mhnp7rc1yy5r9nj18f5358:5c2543ae-a10b-4bcd-a346-6e3f8ab0e70e:yield-1";

  it("reads the child run ids and the yield generation off the production id", () => {
    expect(parseRequesterSettleRun(PROD)).toEqual({
      childRunIds: ["5c2543ae-a10b-4bcd-a346-6e3f8ab0e70e"],
      yieldGeneration: 1,
    });
  });
  it("a multi-child batch is comma-joined; a retry suffix follows the yield suffix", () => {
    const rid =
      "announce:requester-settle:meta:agent:meta:atrium:chat:u:c:aaa-1,bbb-2:yield-3:retry-1";
    expect(parseRequesterSettleRun(rid)).toEqual({
      childRunIds: ["aaa-1", "bbb-2"],
      yieldGeneration: 3,
    });
  });
  it("a wake WITHOUT a yield (no rearmGeneration) parses with a null generation", () => {
    const rid = "announce:requester-settle:unknown:agent:meta:main:swarm_0123abcd,uuid-2";
    expect(parseRequesterSettleRun(rid)).toEqual({
      childRunIds: ["swarm_0123abcd", "uuid-2"],
      yieldGeneration: null,
    });
  });
  it("an unknown trailing lane is never read as a yielded continuation", () => {
    // Not a parse failure: the lane reads as the id list of a wake WITHOUT a yield
    // generation — which is exactly what keeps it out of the merge.
    expect(parseRequesterSettleRun(`${PROD}:agent-loop`)?.yieldGeneration ?? null).toBeNull();
  });
  it("fails closed on an empty id or a truncated key", () => {
    for (const rid of [
      "announce:requester-settle:meta:agent:meta:x:a,,b:yield-1",
      "announce:requester-settle:meta:5c2543ae:yield-1",
      "announce:v1:agent:files:subagent:abc:def",
      "webchat-abc",
    ]) {
      expect(parseRequesterSettleRun(rid)).toBeNull();
    }
  });
  it("every delivery family stamps its parts — the settle continuation included", () => {
    expect(deliveryPartStamp(PROD)).toBe(PROD);
    expect(deliveryPartStamp("announce:v1:agent:files:subagent:abc:def")).toBe(
      "announce:v1:agent:files:subagent:abc:def",
    );
    expect(deliveryPartStamp("webchat-abc")).toBeUndefined();
    expect(deliveryPartStamp(undefined)).toBeUndefined();
  });
});

describe("followedUpChildRunIds — a received batch is not an answered one (codex pass 1)", () => {
  const R = (ids: string[], sfx = ":yield-1") =>
    `announce:requester-settle:meta:agent:meta:atrium:chat:o:c:${ids.join(",")}${sfx}`;
  const conts = [
    { at: 0, childRunIds: ["c1"] },
    { at: 12, childRunIds: ["c2"] },
  ];

  it("text after a batch's point follows it up — and every earlier batch", () => {
    expect(followedUpChildRunIds("Je relance. Voici le PDF.", conts, [])).toEqual(["c1", "c2"]);
  });

  it("a continuation that ended on NOTHING follows nothing up", () => {
    expect(followedUpChildRunIds("", [{ at: 0, childRunIds: ["c1"] }], [])).toEqual([]);
    expect(followedUpChildRunIds("Je délègue.", [{ at: 11, childRunIds: ["c1"] }], [])).toEqual([]);
  });

  it("a file delivered by a run of that batch, or of a later one, follows it up", () => {
    expect(followedUpChildRunIds("", conts, [R(["c2"], ":yield-1:retry-1")])).toEqual(["c1", "c2"]);
    expect(followedUpChildRunIds("", conts, [R(["c1"])])).toEqual(["c1"]);
  });

  it("an unstamped file (the turn's own) or another batch's file follows nothing up", () => {
    expect(followedUpChildRunIds("", conts, [undefined, R(["zz"])])).toEqual([]);
  });
});
