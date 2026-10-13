import { describe, expect, it } from "vitest";
import { valueOrNull } from "./useQueryOrNull";

// A failed follow-up state is "no queue information", never a thrown render (codex phase 6
// pass 5: a query past the read limit used to take the whole conversation down).
describe("valueOrNull", () => {
  it("an error reads as no data", () => {
    expect(valueOrNull(new Error("Read too much data"))).toBeNull();
  });
  it("a value and a pending query pass through", () => {
    expect(valueOrNull({ projection: false })).toEqual({ projection: false });
    expect(valueOrNull(undefined)).toBeUndefined();
  });
});
