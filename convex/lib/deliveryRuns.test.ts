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
