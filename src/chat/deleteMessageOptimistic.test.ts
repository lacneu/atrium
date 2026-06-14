import { describe, expect, test } from "vitest";
import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName } from "convex/server";
import type { Id } from "./convexApi";
import { api } from "./convexApi";
import { deleteMessageOptimisticUpdate } from "./deleteMessageOptimistic";

// The optimistic truncation must mirror convex/messages.ts deleteMessage's
// TRUNCATE-FORWARD semantics exactly: the target message and every LATER one
// in the same chat disappear; earlier ones stay; other cached chats untouched.

type Row = { _id: Id<"messages">; _creationTime: number };

const row = (id: string, t: number): Row => ({
  _id: id as Id<"messages">,
  _creationTime: t,
});

/** Minimal fake OptimisticLocalStore: cached listByChat entries + a write log. */
function fakeStore(entries: { args: { chatId: string }; value?: Row[] }[]) {
  const writes: { args: unknown; value: Row[] }[] = [];
  const store = {
    getQuery: () => undefined,
    getAllQueries: (query: unknown) => {
      // The api proxy mints a fresh FunctionReference per property access —
      // compare by function NAME (what Convex itself keys the cache on).
      expect(getFunctionName(query as Parameters<typeof getFunctionName>[0])).toBe(
        getFunctionName(api.messages.listByChat),
      );
      return entries;
    },
    setQuery: (_query: unknown, args: unknown, value: Row[]) => {
      writes.push({ args, value });
    },
  } as unknown as OptimisticLocalStore;
  return { store, writes };
}

const run = (store: OptimisticLocalStore, id: string) =>
  deleteMessageOptimisticUpdate(store, { messageId: id as Id<"messages"> });

describe("deleteMessageOptimisticUpdate (truncate-forward, instant)", () => {
  test("drops the target AND every later message; earlier ones stay", () => {
    const { store, writes } = fakeStore([
      {
        args: { chatId: "c1" },
        value: [row("m1", 10), row("m2", 20), row("m3", 30), row("m4", 40)],
      },
    ]);
    run(store, "m2");
    expect(writes).toHaveLength(1);
    expect(writes[0].value.map((r) => r._id)).toEqual(["m1"]);
  });

  test("deleting the FIRST message empties the cached thread", () => {
    const { store, writes } = fakeStore([
      { args: { chatId: "c1" }, value: [row("m1", 10), row("m2", 20)] },
    ]);
    run(store, "m1");
    expect(writes[0].value).toEqual([]);
  });

  test("deleting the LAST message drops only it", () => {
    const { store, writes } = fakeStore([
      { args: { chatId: "c1" }, value: [row("m1", 10), row("m2", 20)] },
    ]);
    run(store, "m2");
    expect(writes[0].value.map((r) => r._id)).toEqual(["m1"]);
  });

  test("only the chat CONTAINING the target is patched", () => {
    const { store, writes } = fakeStore([
      { args: { chatId: "c1" }, value: [row("a1", 10)] },
      { args: { chatId: "c2" }, value: [row("b1", 10), row("b2", 20)] },
    ]);
    run(store, "b2");
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toEqual({ chatId: "c2" });
    expect(writes[0].value.map((r) => r._id)).toEqual(["b1"]);
  });

  test("unknown target or not-yet-loaded query -> no write (never seeds a cache)", () => {
    const { store, writes } = fakeStore([
      { args: { chatId: "c1" }, value: [row("m1", 10)] },
      { args: { chatId: "c2" }, value: undefined },
    ]);
    run(store, "ghost");
    expect(writes).toHaveLength(0);
  });
});
