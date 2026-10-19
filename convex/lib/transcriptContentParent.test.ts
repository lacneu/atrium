// The nesting key a tool block carries (0.101.1): kept bounded, never a call's own id, absent
// when the bridge sends none (an older bridge) — bridge row-blocks.ts `RowToolBlock`.
import { describe, expect, it } from "vitest";
import { sanitizeRowBlocks } from "./transcriptContent";

describe("sanitizeRowBlocks — parentToolCallId", () => {
  it("keeps a parent, drops a self-parent and a non-string", () => {
    const out = sanitizeRowBlocks([
      { type: "tool", toolCallId: "n1", name: "message", status: "call", parentToolCallId: "e1" },
      { type: "tool", toolCallId: "e1", name: "exec", status: "call", parentToolCallId: "e1" },
      { type: "tool", toolCallId: "e2", name: "exec", status: "call", parentToolCallId: 7 },
      { type: "tool", toolCallId: "e3", name: "exec", status: "call" },
    ]);
    expect(out?.map((b) => (b as { parentToolCallId?: string }).parentToolCallId)).toEqual(["e1", undefined, undefined, undefined]);
  });
});
