// A FINISHED CHECKLIST IS NOT A DELIVERY.
//
// A delivery run that brings neither text nor file is named `empty_response`, so
// the reader gets a cause and the anomaly plane gets a count. A plan part counts
// as content — deliberately: a checklist on screen tells the reader that work is
// under way, which is something.
//
// It stopped being true at the end. Production 2026-09-22 (prod-ms75p66z…,
// ataraxis): a `requester-settle` delivery whose ONLY part was a plan reading
// "2/2 complete", its last step "check the final render and deliver the image" —
// and no image, no text, no media trace at all. The bubble settled `complete`
// with a green checklist and nothing in it. The verdict that exists to name an
// empty delivery never fired, because the checklist had been counted as the
// delivery.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const SETTLE_RUN =
  "announce:requester-settle:fabien:agent:fabien:atrium:chat:u:c:39f0e6c4-1c4e-45c2-838e-9afcd5bed51c:yield-1";

type Step = { step: string; status: "pending" | "in_progress" | "completed" };

/** A delivery bubble whose only part is a plan in the given state. */
async function seedDeliveryWithPlan(
  t: ReturnType<typeof convexTest>,
  steps: Step[],
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "fabien",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: SETTLE_RUN,
      updatedAt: 2000,
    });
    await ctx.db.insert("messageParts", {
      messageId,
      order: 0,
      part: { kind: "plan" as const, steps, stamp: 1000 },
    });
    return { chatId, messageId };
  });
}

describe("a plan is content while there is work left in it", () => {
  test("a delivery whose checklist is ALL DONE, with nothing else, is named", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedDeliveryWithPlan(t, [
      { step: "Modifier l'arrière-plan et élargir le cadre", status: "completed" },
      { step: "Contrôler le rendu final et livrer l'image", status: "completed" },
    ]);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(messageId));
    expect(
      settled?.status,
      "the checklist says delivered and nothing was: that is the silence this verdict exists to end",
    ).toBe("error");
    expect(settled?.errorCode).toBe("empty_response");
  });

  test("a delivery still working through its checklist is NOT named", async () => {
    // The original rule, and it stays: a plan with work left tells the reader
    // something true. Naming it a failed delivery would put a red card on a turn
    // that is visibly progressing.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDeliveryWithPlan(t, [
      { step: "Modifier l'arrière-plan et élargir le cadre", status: "completed" },
      { step: "Contrôler le rendu final et livrer l'image", status: "in_progress" },
    ]);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(messageId));
    expect(settled?.status).toBe("complete");
    expect(settled?.errorCode ?? null).toBeNull();
  });

  test("a delivery that actually delivered TEXT is untouched by any of this", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedDeliveryWithPlan(t, [
      { step: "Tout faire", status: "completed" },
    ]);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "Voici l'image demandée.",
    });

    const settled = await t.run((ctx) => ctx.db.get(messageId));
    expect(settled?.status).toBe("complete");
    expect(settled?.errorCode ?? null).toBeNull();
  });
});
