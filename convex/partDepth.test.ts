/// <reference types="vite/client" />
//
// A tool payload nested past Convex's document limit is STORED, bounded — never refused
// (OpenClaw 2026.9.6 bench, 2026-09-25: a code-mode tool search returned a tool's full JSON
// Schema, 19 levels deep; the insert threw, `addPart` answered 500, the card was lost).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { PART_VALUE_MAX_DEPTH, boundPartDepth } from "./lib/partDepth";

const modules = import.meta.glob("./**/*.ts");

/** `{a:{a:{…{leaf:"x"}}}}`, `levels` objects deep. */
const nested = (levels: number): Record<string, unknown> => {
  let v: Record<string, unknown> = { leaf: "x" };
  for (let i = 1; i < levels; i++) v = { a: v };
  return v;
};

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    return await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant",
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
  });
}

describe("a deep tool payload", () => {
  test("19 levels (the 2026.9.6 tool-search result) is stored, its deep subtree as JSON text", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t);
    const output = { result: nested(19) };
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "c1", output },
    });
    const parts = await t.run(async (ctx) =>
      (await ctx.db.query("messageParts").collect()).filter((p) => p.messageId === messageId),
    );
    expect(parts).toHaveLength(1);
    // Nothing dropped: the text of the bounded subtree still holds the leaf.
    expect(JSON.stringify(parts[0]!.part)).toContain("leaf");
    // …and the STORED document is within Convex's limit. convex-test does not enforce the
    // 16-level rule itself, so the depth is measured here: row -> part -> output -> …
    const depth = (v: unknown): number =>
      v !== null && typeof v === "object"
        ? 1 + Math.max(0, ...Object.values(v as Record<string, unknown>).map(depth))
        : 0;
    expect(1 + depth(parts[0]!.part)).toBeLessThanOrEqual(16);
  });

  test("a shallow payload is untouched, and only tool parts are touched", () => {
    const shallow = { kind: "tool", name: "exec", phase: "done", output: { a: { b: [1, { c: "d" }] } } };
    expect(boundPartDepth(shallow)).toEqual(shallow);
    const reasoning = { kind: "reasoning", text: "x" };
    expect(boundPartDepth(reasoning)).toBe(reasoning);
  });

  test("the bound turns exactly the subtree at the limit into its JSON", () => {
    const out = boundPartDepth({ kind: "tool", name: "x", phase: "done", output: nested(PART_VALUE_MAX_DEPTH + 3) }) as {
      output: Record<string, unknown>;
    };
    let v: unknown = out.output;
    for (let i = 1; i < PART_VALUE_MAX_DEPTH; i++) v = (v as { a: unknown }).a;
    expect(typeof v).toBe("string");
    expect(JSON.parse(v as string)).toEqual(nested(4));
  });
});
