import { describe, expect, it } from "vitest";
import {
  deliveryChildKey,
  isDeliveryRun,
  isRequesterSettleRun,
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
