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

describe("deleteMessageOptimisticUpdate — a delegation's display group (codex phase 5 pass 1 #4)", () => {
  test("deleting the group's LAST bubble truncates from its FIRST, like the server", () => {
    const g = (id: string, t: number, role: string, displayGroupId?: string) => ({
      ...row(id, t),
      role,
      ...(displayGroupId !== undefined ? { displayGroupId } : {}),
    });
    const { store, writes } = fakeStore([
      {
        args: { chatId: "c1" },
        value: [g("q", 10, "user"), g("p", 20, "assistant", "p"), g("d", 30, "assistant", "p")] as unknown as Row[],
      },
    ]);
    run(store, "d");
    expect(writes[0].value.map((r) => r._id)).toEqual(["q"]);
  });
});

describe("deleteMessageOptimisticUpdate — a head placed before the cached window (codex phase 5 pass 9 #1)", () => {
  test("P and D recent but placed around an old question X outside the window: deleting D removes D only", () => {
    // The window holds messages created since t=100; P (created 300) is placed at 50,
    // before the window starts — X, displayed between them, is not in the cache.
    const P = { ...row("p", 300), role: "assistant", displayGroupId: "p", orderTime: 50 };
    const D = { ...row("d", 310), role: "assistant", displayGroupId: "p", orderTime: 60 };
    const older = { ...row("o", 100), role: "assistant" };
    const { store, writes } = fakeStore([{ args: { chatId: "c1" }, value: [P, D, older] as unknown as Row[] }]);
    run(store, "d");
    expect(writes[0].value.map((r) => r._id).sort()).toEqual(["o", "p"]);
  });
});
