import { describe, expect, it } from "vitest";
import type { ConvexMessageView } from "./convexTypes";
import { handOffFactsOf, resumeIndexOf } from "./handOffFacts";

const msg = (o: Partial<ConvexMessageView> & { _id: string }): ConvexMessageView =>
  ({ chatId: "c", _creationTime: 1, role: "assistant", status: "complete", text: "", updatedAt: 1, parts: [], ...o }) as unknown as ConvexMessageView;
const SETTLE = "announce:requester-settle:alice:agent:alice:atrium:chat:u:turn-c1:248d41ff-bb53-458f-9e2c-28d676bc5fdc,11111111-1111-4111-8111-111111111111:yield-1";

describe("handOffFacts", () => {
  it("reads the child runs a resume names, the children an announce names, the reader's last turn", () => {
    const idx = resumeIndexOf([
      msg({ _id: "u1", role: "user", _creationTime: 5 }),
      msg({ _id: "a1", runId: "webchat-1", _creationTime: 6 }),
      msg({ _id: "a2", runId: SETTLE, _creationTime: 7 }),
      msg({ _id: "a3", runId: "announce:v1:agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e:9d73faa6-3d5c-4121-a37c-a62885ce5cbf", _creationTime: 8 }),
    ]);
    expect(idx.childRunIds).toEqual(["11111111-1111-4111-8111-111111111111", "248d41ff-bb53-458f-9e2c-28d676bc5fdc"]);
    expect(idx.childKeys).toEqual(["agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e"]);
    expect(idx.lastUserAt).toBe(5);
  });

  it("applies to a bubble composed from its rows only", () => {
    const idx = resumeIndexOf([msg({ _id: "u1", role: "user", _creationTime: 9 })]);
    expect(handOffFactsOf(msg({ _id: "a1", _creationTime: 2 }), idx)).toBeUndefined();
    expect(handOffFactsOf(msg({ _id: "a1", _creationTime: 2, rowLayout: [] }), idx)).toEqual({
      projected: true,
      resumedChildRunIds: [],
      resumedChildKeys: [],
      laterUserTurn: true,
    });
    expect(handOffFactsOf(msg({ _id: "a2", _creationTime: 10, rowLayout: [] }), idx)?.laterUserTurn).toBe(false);
  });
});
