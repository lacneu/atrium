// THE v0.96.0 `batchAnswered`, VERBATIM — extracted from the tag (`git show
// v0.96.0:convex/stream.ts`: `blobStillResolves`, `batchAnswered`, `batchKey`) so the
// phase 5 predicate is compared against the REAL old code, not against itself (codex
// phase 5 pass 11). Exported under a `legacy` name only; never imported by production code.
// A `.test.ts` file so the Convex bundle never includes it; the one test below checks the
// extraction is the tag's text.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { parseRequesterSettleRun } from "../lib/deliveryRuns";

/* eslint-disable */
// ---- verbatim from v0.96.0 ----
async function blobStillResolves(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  onFailure = false,
): Promise<boolean> {
  try {
    return (await ctx.storage.getUrl(storageId)) !== null;
  } catch {
    return onFailure;
  }
}

async function batchAnswered(
  ctx: MutationCtx,
  parent: Doc<"messages">,
  parentId: Id<"messages">,
  batch: { at: number; childRunIds: string[] },
): Promise<boolean> {
  if (parent.text.slice(batch.at).trim() !== "") return true;
  const key = batchKey(batch.childRunIds);
  const parts = (
    await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", parentId))
      .collect()
  ).filter(
    (row) =>
      row.announceRun !== undefined &&
      batchKey(parseRequesterSettleRun(row.announceRun)?.childRunIds ?? []) === key,
  );
  for (const row of parts) {
    const part = row.part;
    if (part.kind === "cron") return true;
    // A widget the batch showed is an answer; a rerun would show it again.
    if (part.kind === "widget") return true;
    if (
      (part.kind === "file" || part.kind === "media") &&
      (await blobStillResolves(ctx, part.storageId, true))
    ) {
      return true;
    }
  }
  return false;
}

function batchKey(childRunIds: readonly string[]): string {
  return [...childRunIds].sort().join(",");
}
// ---- end verbatim ----

export const legacyV096BatchAnswered = batchAnswered;

describe("the v0.96.0 extraction", () => {
  test("is unchanged since it was taken from the tag (pinned digest of the verbatim block)", async () => {
    const here = readFileSync(new URL(import.meta.url), "utf8");
    const block = here.slice(here.indexOf("// ---- verbatim from v0.96.0 ----"), here.indexOf("// ---- end verbatim ----"));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(block))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(digest).toBe("ce76bb52e60e522d38137094319c5bfdb3d0f21a80184d7cca34af6a2a857bf0");
  });
});
