/// <reference types="vite/client" />
//
// The read meter charges EVERY document a helper reads through the wrapped context —
// whichever reader it uses — and, armed, stops the read that crosses its ceiling.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { meteredCtx, ReadBudgetExceeded, type ArmedReadMeter } from "./meteredReads";
import { docReadBytes } from "./transcriptProjection";

const modules = import.meta.glob("../**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: "x".repeat(1000 * (i + 1)),
          updatedAt: i,
        }),
      );
    }
    const storageId = await ctx.storage.store(new Blob(["abc"]));
    return { chatId, ids, storageId };
  });
}

describe("meteredCtx", () => {
  test("charges get, system.get, take/first/collect and async iteration, by docReadBytes", async () => {
    const t = convexTest(schema, modules);
    const { chatId, ids, storageId } = await seed(t);
    await t.run(async (raw) => {
      const meter: ArmedReadMeter = { bytes: 0, ceiling: Infinity };
      const ctx = meteredCtx(raw, meter);
      const byChat = () => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId));

      const one = await ctx.db.get(ids[0]!);
      expect(meter.bytes).toBe(docReadBytes(one));

      let before = meter.bytes;
      const meta = await ctx.db.system.get(storageId);
      expect(meta).not.toBeNull();
      expect(meter.bytes - before).toBe(docReadBytes(meta));

      before = meter.bytes;
      const all = await byChat().collect();
      expect(meter.bytes - before).toBe(all.reduce((n, d) => n + docReadBytes(d), 0));

      before = meter.bytes;
      const first = await byChat().order("desc").first();
      expect(meter.bytes - before).toBe(docReadBytes(first));

      before = meter.bytes;
      const two = await byChat().take(2);
      expect(meter.bytes - before).toBe(two.reduce((n, d) => n + docReadBytes(d), 0));

      before = meter.bytes;
      let seen = 0;
      for await (const d of byChat()) {
        seen += docReadBytes(d);
      }
      expect(meter.bytes - before).toBe(seen);

      // A miss weighs nothing.
      before = meter.bytes;
      await ctx.db.delete(ids[2]!);
      expect(await ctx.db.get(ids[2]!)).toBeNull();
      expect(meter.bytes).toBe(before);
    });
  });

  test("armed: the read that crosses the ceiling throws, lazily — nothing past it is read", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await t.run(async (raw) => {
      const meter: ArmedReadMeter = { bytes: 0, ceiling: 1500 };
      const ctx = meteredCtx(raw, meter);
      const read: number[] = [];
      await expect(
        (async () => {
          for await (const d of ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId))) {
            read.push(d.text.length);
          }
        })(),
      ).rejects.toBeInstanceOf(ReadBudgetExceeded);
      // The first (≈1 KB) fits; the second crosses the line and is abandoned.
      expect(read).toEqual([1000]);
      expect(meter.bytes).toBeGreaterThan(1500);
      expect(meter.bytes).toBeLessThan(1500 + 2100);
    });
  });

  test("the original context is untouched", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seed(t);
    await t.run(async (raw) => {
      const meter: ArmedReadMeter = { bytes: 0, ceiling: 0 };
      meteredCtx(raw, meter);
      expect(await raw.db.get(ids[0]!)).not.toBeNull();
      expect(meter.bytes).toBe(0);
    });
  });
});
