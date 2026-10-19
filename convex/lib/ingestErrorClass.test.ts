// The class of a rejected ingest write, read from the Convex runtime's own sentences
// (0.101.2) — and only the class: the message never reaches the trace.
import { describe, expect, test } from "vitest";
import { hashedChatRef, ingestErrorClass } from "./ingestErrorClass";

describe("ingestErrorClass", () => {
  test("a mutation that lost its optimistic-concurrency retries is a conflict", () => {
    expect(
      ingestErrorClass(
        new Error('Documents read from or written to the table "messages" changed while this mutation was being run and on every subsequent retry.'),
      ),
    ).toBe("occ_conflict");
  });
  test("transaction and value limits", () => {
    for (const m of [
      "Too many reads in a single function execution (limit: 4096).",
      "Too many bytes read in a single function execution (limit: 16777216 bytes).",
      "Too many documents written in a single function execution",
      "Value is too large (1.2 MiB > maximum size 1 MiB)",
      "Array length is too long (9000 > maximum length 8192)",
    ]) {
      expect(ingestErrorClass(new Error(m))).toBe("limit_exceeded");
    }
  });
  test("a refused argument or value", () => {
    expect(ingestErrorClass(new Error("ArgumentValidationError: Value does not match validator."))).toBe("validator");
    expect(ingestErrorClass(new Error("Object is missing the required field `rows`."))).toBe("validator");
  });
  test("anything else", () => {
    expect(ingestErrorClass(new Error("finalize: message not found"))).toBe("other");
    expect(ingestErrorClass("boom")).toBe("other");
  });
  test("the chat reference is a short, stable hash, never the id", async () => {
    const a = await hashedChatRef("mh73rk45k15s54vgtr6m761wsd8gh5fg");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashedChatRef("mh73rk45k15s54vgtr6m761wsd8gh5fg")).toBe(a);
    expect(await hashedChatRef(undefined)).toBeNull();
  });
});
