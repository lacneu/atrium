// THE HAND-OFF EXEMPTION MUST BELONG TO ONE RUN.
//
// A delivery run that brings neither text nor file is named `empty_response` so
// the reader gets a cause and the anomaly plane gets a count. One shape is
// legitimately exempt: the gateway's REQUESTER-SETTLE wake, which closes a turn
// whose agent deliberately handed the work to a child and answered nothing
// (`announce:requester-settle:…[:yield-N]`, upstream
// subagent-announce.requester-settle-wake.ts:443-447).
//
// The exemption was keyed on the PARTS alone — "is there a completed
// sessions_yield on this bubble?" — and `messageParts` carry no runId. An
// announce merge reopens the parent's bubble, rotates its runId and KEEPS its
// parts, so the yield written in an earlier run stays attached forever. Any later
// child-announce merge that delivered nothing then matched that stale part and
// was exempted: a silent empty bubble, no card, no cause, nothing counted.
//
// Production shape (2026-08-02, ataraxis): a `sessions_yield` with a private
// `message` and NO acknowledgment leaves the parent bubble EMPTY, and the child's
// announce merges onto it. That is the exact pair below.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const CHILD_KEY = "agent:files:subagent:c45f64c2-243c-453e-b31c-543cc2ce1998";
const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:74aaf10b-b77e-4726-9f78-cfd3baa1429b`;
const SETTLE_RUN =
  "announce:requester-settle:fabien:agent:fabien:atrium:chat:u:c:6ae80ea0-395f-41bb-81e0-10f171ab7c83:yield-1";

/** A parent turn that handed off and said NOTHING: empty bubble + a completed
 *  `sessions_yield` part, which is what a yield with no acknowledgment leaves. */
async function seedYieldedEmptyParent(
  t: ReturnType<typeof convexTest>,
  opts?: { withSubAgentRow?: boolean },
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
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "fais moi un vade mecum imprimable",
      updatedAt: 1000,
    });
    const parentId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "",
      runId: "webchat-parent-run",
      finalizedAt: 2000,
      updatedAt: 2000,
    });
    await ctx.db.insert("messageParts", {
      messageId: parentId,
      order: 0,
      // NO `announceRun`: this yield was written by the parent's OWN webchat run,
      // which is what makes it stale for any later delivery that merges in.
      part: {
        kind: "tool" as const,
        name: "sessions_yield",
        phase: "completed",
        input: { message: "Attendre la livraison du vade-mecum." },
        output: { details: { status: "yielded" } },
      },
    });
    if (opts?.withSubAgentRow !== false) {
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: parentId,
        anchorExact: true,
        childSessionKey: CHILD_KEY,
        status: "done" as const,
        createdAt: 1500,
        updatedAt: 2500,
      });
    }
    return { userId, chatId, parentId };
  });
}

describe("the hand-off exemption is scoped to the run that handed off", () => {
  test("a CHILD-ANNOUNCE merge that delivers nothing is NAMED, despite the parent's stale yield part", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedEmptyParent(t);

    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(reopened, "the merge must reopen the parent bubble").toBe(parentId);

    // The child announced and brought NOTHING — no text, no file. This is the
    // defect a user is still waiting on: the deliverable never arrived and the
    // conversation never said so.
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(
      settled?.status,
      "a delivery that delivered nothing must be an error, not a silent bubble",
    ).toBe("error");
    expect(settled?.errorCode).toBe("empty_response");
  });

  test("a yield written BY the announce run is still exempt — the healthy chain must not be reclassified", async () => {
    // A delivery turn can legitimately delegate again and yield: captured on the
    // wire in golden/2026.7.1/spawn-parallel-merge.jsonl, where `sessions_yield`
    // COMPLETES on an `announce:v1:` run. Keying the exemption on the run FAMILY
    // refused exactly this turn and turned it into a red `empty_response` card —
    // and a parent left in `error` then fails the merge gate, so the child's real
    // answer lands in a NEW bubble with the false card stranded above it.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedEmptyParent(t);

    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(reopened).toBe(parentId);

    // THIS run's own yield, stamped with its provenance exactly as addPart writes it.
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 1,
        part: {
          kind: "tool" as const,
          name: "sessions_yield",
          phase: "completed",
          output: { details: { status: "yielded" } },
        },
        announceRun: ANNOUNCE_RUN,
      });
    });

    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(
      settled?.status,
      "this delivery handed off again; it did not fail to deliver",
    ).toBe("complete");
    expect(settled?.errorCode).toBeUndefined();
  });

  test("a yield that ERRORED on this run handed nothing to anyone", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedEmptyParent(t);
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(reopened).toBe(parentId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 1,
        part: {
          kind: "tool" as const,
          name: "sessions_yield",
          phase: "error",
          output: { details: { status: "error" } },
        },
        announceRun: ANNOUNCE_RUN,
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("error");
    expect(settled?.errorCode).toBe("empty_response");
  });

  test("the REQUESTER-SETTLE run that closes the hand-off is still exempt", async () => {
    const t = convexTest(schema, modules);
    // No subAgents row: this wake names no child key (deliveryChildKey returns
    // null for a requester-settle), so it settles the parent's own bubble.
    const { chatId, parentId } = await seedYieldedEmptyParent(t, {
      withSubAgentRow: false,
    });
    // STREAMING, or `finalize` short-circuits on "already terminal" and the
    // assertion below would pass without the verdict ever running.
    await t.run((ctx) =>
      ctx.db.patch(parentId, { runId: SETTLE_RUN, status: "streaming" }),
    );

    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(
      settled?.status,
      "the parent chose to answer nothing and the child replies in its own run",
    ).toBe("complete");
    expect(settled?.errorCode).toBeUndefined();
  });

  test("a requester-settle with NO yield part is still named — the exemption needs both", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedEmptyParent(t, {
      withSubAgentRow: false,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, { runId: SETTLE_RUN, status: "streaming" });
      for (const row of await ctx.db.query("messageParts").collect()) {
        await ctx.db.delete(row._id);
      }
    });

    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });

    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("error");
    expect(settled?.errorCode).toBe("empty_response");
  });
});
