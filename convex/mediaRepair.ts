// OPERATOR REPAIR of a lost outbound delivery.
//
// WHY THIS EXISTS. A file an agent produces reaches the conversation through a
// `MEDIA:` directive on a frame. A frame is not replayed: if the delivery is
// lost, it is lost, and no later code change repairs the past. Prod 2026-09-09
// (report prod-ms7bybmm…): a delegated agent wrote a DOCX and a PDF, the parent
// verified both on the host (16 796 and 85 496 bytes), and the bubble stayed
// empty. The live path is fixed; this is how the bubble that already went out
// gets what it should have carried.
//
// It is deliberately NOT automatic and NOT inferred. The operator names the
// message and the files: Atrium has no record of those filenames (the answer
// that carried them was sanitised to nothing, which was the defect), so nothing
// here could guess them, and guessing at a shared outbound directory is how one
// conversation ends up with another's documents.
//
// Every safety property that matters lives on the BRIDGE side (basenames only,
// the path built from the instance's own outbound root — see server.ts
// `/deliver-media`). This module owns what Convex owns: that the message exists,
// that it belongs to the named chat, and that the repair is audited.
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { postBridge, type BridgeFailure } from "./agentFiles";
import type { InstanceConfig } from "./lib/instanceConfig";
import { isFilePart } from "./lib/files";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";

// The bridge fetches and uploads each file SEQUENTIALLY and the transfer has no
// overall deadline of its own (a single file may be up to the configured cap), so
// this bound can be reached on a slow link or a big batch.
//
// It stays under a Convex ACTION's own ~600 s ceiling with room to spare, and
// deliberately: at exactly 600 s the platform would kill this action before the
// AbortController fired, which would take with it both the structured
// `bridge_timeout` answer and the closing audit event — the caller would be told
// nothing and the trail would show only an attempt.
const BRIDGE_TIMEOUT_MS = 420_000;

/** The repair's target, resolved and checked: the message, its chat, and the
 *  instance whose bridge holds the outbound directory the files live in. */
export const resolveTarget = internalQuery({
  args: { chatId: v.string(), messageId: v.string() },
  handler: async (ctx, { chatId, messageId }) => {
    const cid = ctx.db.normalizeId("chats", chatId);
    const mid = ctx.db.normalizeId("messages", messageId);
    if (cid === null || mid === null) {
      return { ok: false as const, error: "not_found" as const };
    }
    const chat = await ctx.db.get(cid);
    const message = await ctx.db.get(mid);
    if (chat === null || message === null) {
      return { ok: false as const, error: "not_found" as const };
    }
    // The message must belong to the NAMED chat. Without this a caller could
    // attach a file to any message by pairing it with a chat they can name —
    // the two ids would each be valid and the pair would not be.
    if (String(message.chatId) !== String(cid)) {
      return { ok: false as const, error: "message_not_in_chat" as const };
    }
    // ONLY a settled ASSISTANT reply can be repaired. Two reasons, and both are
    // load-bearing: this is a lost REPLY delivery, so a user bubble is never the
    // target; and the attach deliberately states no generation, which on a turn
    // that is still streaming would slip past the guard that protects it.
    if (message.role !== "assistant") {
      return { ok: false as const, error: "not_an_assistant_reply" as const };
    }
    if (message.status === "streaming") {
      return { ok: false as const, error: "turn_still_running" as const };
    }
    // PROVENANCE, AND ONLY PROVENANCE. The one field that says which instance
    // actually produced this reply is `boundInstance` — the durable owner stamp
    // `startAssistant` writes on every bridge-authenticated turn (since
    // 2026-07-18, when the per-bridge secret became mandatory) and which survives
    // finalize.
    //
    // FALLING BACK TO THE CHAT'S CURRENT INSTANCE IS A GUESS, and a dangerous
    // one: A produces the reply, A is later decommissioned and the chat is
    // rebound to B, and the repair then reads B's outbound directory — where a
    // file of the same name belongs to someone else's work. That is exactly the
    // failure this module's header refuses ("guessing at a shared outbound
    // directory is how one conversation ends up with another's documents"), so
    // an unstamped reply is REFUSED instead of resolved. It costs the repair of
    // replies older than that date, whose outbound files left the disk long ago.
    const instanceName = message.boundInstance ?? null;
    if (instanceName === null) {
      return { ok: false as const, error: "no_provenance" as const };
    }
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    // AN INSTANCE ATRIUM NO LONGER KNOWS IS NOT A TARGET. A message keeps its
    // owner stamp after the instance row is deleted, and an absent row made every
    // check below vacuous: `instance?.kind` skipped the Hermes refusal, and a
    // null `bridgeUrl` falls back to the DEPLOYMENT DEFAULT bridge — so the
    // repair was sent to whichever bridge that is, to read a directory belonging
    // to something else.
    if (instance === null) {
      return { ok: false as const, error: "instance_unknown" as const };
    }
    // HERMES IS REFUSED, explicitly. Its agents write under their own working
    // directory (`<cwd>/atrium-out`), not the OpenClaw outbound mount the bridge
    // composes the path from — so the repair would look in the wrong place and
    // report a file that exists as gone. Refusing names the limit; guessing a
    // second layout would hide it.
    if (instance.kind === "hermes") {
      return { ok: false as const, error: "provider_not_supported" as const };
    }
    // The parts ALREADY on this message: the persistent half of the idempotency.
    // The bridge's own dedup is per-process, so a retry after a bridge restart
    // would attach a second copy — and the promise made to the operator is that
    // retrying is safe.
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", mid))
      .collect();
    // BOTH blob-carrying kinds, which is what `isFilePart` exists to say. A
    // repair writes `media`, but the bubble may already carry the same name as a
    // `file` part: `addPart` takes the whole part union from the bridge, and
    // `chatFork` copies both kinds onto the forked reply. Matching only `media`
    // let the same document land a second time and render twice.
    // ...AND THE OBJECT MUST STILL BE THERE. A part whose blob is gone renders
    // as nothing — `filePartToContent` drops a part without a resolved URL — so
    // counting its name as attached made this route answer "already there" about
    // a bubble that shows no file, and the one tool built to restore a missing
    // file refused to act on the very case it exists for.
    const alreadyAttached: string[] = [];
    for (const row of parts) {
      if (!isFilePart(row.part)) continue;
      if ((await ctx.storage.getUrl(row.part.storageId)) === null) continue;
      alreadyAttached.push(row.part.filename);
    }
    // The STORED media overrides — only what an admin actually set, never a
    // resolved view. The dispatch path states the rule and it applies here for
    // the same reason: an UNSET field must leave the bridge on its OWN env
    // default. Sending Convex's defaults as explicit overrides would reconfigure
    // an env-configured `shared-fs` bridge to `gateway-http` for this call, and
    // would RE-ENABLE media on an instance where it is deliberately off.
    // THE SAME SHAPE THE DISPATCH PATH SENDS, so the bridge can run it through the
    // SAME parser (`parseInboundConfig`). A second shape — the cap pre-converted
    // to bytes — meant a second, unvalidated code path on the bridge for the one
    // call that reconfigures a shared provider.
    const stored: InstanceConfig | undefined | null = instance.config;
    const mediaConfig: {
      mediaMode?: string;
      mediaMaxMb?: number;
      outboundAgentMount?: string;
    } = {
      ...(stored?.mediaMode !== undefined ? { mediaMode: stored.mediaMode } : {}),
      ...(stored?.mediaMaxMb !== undefined
        ? { mediaMaxMb: stored.mediaMaxMb }
        : {}),
      // WHERE the agent writes, when the instance overrides it. The dispatch
      // path already carries this, and the fetcher asks the gateway for the
      // EXACT path it is given — so composing from the bridge's boot value made
      // a repair on an instance with a custom mount answer `not_found` for a
      // file that exists.
      ...(stored?.outboundAgentMount !== undefined
        ? { outboundAgentMount: stored.outboundAgentMount }
        : {}),
    };
    // A cheap take(2) decides "sole" without a full count — the same test dispatch
    // makes.
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    if (bridgeUrl === undefined) {
      return { ok: false as const, error: "bridge_not_configured" as const };
    }
    return {
      ok: true as const,
      instanceName,
      // THE DISPATCH PATH'S OWN RESOLVER, not a second reading of the same rule.
      // `instance.bridgeUrl ?? null` let `postBridge` fall back to the deployment
      // `BRIDGE_URL` unconditionally — so on a multi-instance deployment a repair
      // for an instance without its own URL went to whichever bridge that env var
      // names. `resolveBridgeUrlForDispatch` permits that fallback only when the
      // attribution is unambiguous (sole instance, or the explicitly served one)
      // and returns undefined otherwise, which is a refusal, not a wrong delivery.
      bridgeUrl: bridgeUrl ?? null,
      // Carried so the bridge applies the instance's overrides before reading the
      // directory: its provider only re-reads config on `/send`, so a repair that
      // is the first call after a restart ran on boot values — an instance set to
      // `shared-fs` would be read over `gateway-http`, and a file sitting right
      // there reported as not delivered.
      mediaConfig,
      // The message's CURRENT generation, threaded to the attach so the write is
      // checked against it. Without it the bridge had to omit the generation
      // entirely, and a delegated delivery reopening this bubble between the
      // check above and the transfer would have taken the file into the LIVE
      // turn — exactly what refusing a running turn exists to prevent.
      runId: message.runId ?? null,
      alreadyAttached,
    };
  },
});

/**
 * Attach named outbound files to a message that should already carry them.
 *
 * Returns which files landed and which the host no longer has — the second list
 * is the honest answer to "are they still there?", and this call is the only way
 * to ask: the bridge is the one process that can read that directory.
 */
export const deliverOutboundFiles = internalAction({
  args: {
    chatId: v.string(),
    messageId: v.string(),
    filenames: v.array(v.string()),
    /** The API principal, for the audit event. */
    principalId: v.string(),
  },
  handler: async (
    ctx,
    { chatId, messageId, filenames, principalId },
  ): Promise<
    | {
        ok: true;
        attached: string[];
        /** Requested and NOT attached — absent OR untransferable; see the trace. */
        notDelivered: string[];
        /** Already on the bubble, so never requested again (idempotency). */
        skipped: string[];
      }
    | { ok: false; error: string; note?: string }
  > => {
    const target = await ctx.runQuery(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId,
    });
    if (!target.ok) return { ok: false as const, error: target.error };

    // PERSISTENT idempotency: a file already on this bubble is not requested
    // again, whatever happened to the bridge process in between.
    const already = new Set(target.alreadyAttached);
    const skipped = filenames.filter((n) => already.has(n));
    const toDeliver = filenames.filter((n) => !already.has(n));
    if (toDeliver.length === 0) {
      // AUDITED, even though nothing moves. This is the answer a retry gets after
      // a timeout that actually attached the files, and returning here silently
      // left that outcome recorded nowhere: the first call had logged only its
      // ATTEMPT, and the retry — the call that establishes the files are there —
      // emitted no result at all.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "media.repair",
        direction: "outbound",
        principalType: "service",
        principalId,
        chatId,
        // The SAME shape as the result below: an audit reader should not have
        // two shapes to know for one event kind.
        meta: JSON.stringify({
          instanceName: target.instanceName,
          messageId,
          requested: filenames.length,
          attached: 0,
          notDelivered: 0,
          skipped: skipped.length,
        }),
      });
      return { ok: true as const, attached: [], notDelivered: [], skipped };
    }

    // AUDIT THE ATTEMPT, before the remote call. The bridge has the request the
    // moment it answers 200 and keeps writing on its own chain: if this action
    // then loses its connection, conversation content changes with no event at
    // all. The attempt is recorded first, the outcome after.
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "media.repair.attempt",
      direction: "outbound",
      principalType: "service",
      principalId,
      chatId,
      meta: JSON.stringify({
        instanceName: target.instanceName,
        messageId,
        requested: toDeliver.length,
        skipped: skipped.length,
      }),
    });

    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await postBridge(
        "/deliver-media",
        {
          instanceName: target.instanceName,
          chatId,
          messageId,
          filenames: toDeliver,
          config: target.mediaConfig,
          // The generation to write under: `stream.addPart` refuses a part whose
          // generation no longer owns the message, which is what stops this
          // repair from landing in a turn that reopened while it transferred.
          runId: target.runId,
        },
        BRIDGE_TIMEOUT_MS,
        target.bridgeUrl,
      ));
    } catch (err) {
      // A TIMEOUT is not "unreachable", and saying so would be a lie the caller
      // acts on: the bridge may still be attaching, so the files can land after
      // this answer. Name it for what it is, and say the safe thing — retrying
      // cannot duplicate, because the writer refuses a file already on that
      // message (convex-writer `attachedByMessage`).
      // postBridge marks its OWN timeout (its message is deliberately identical
      // for every failure, so the marker is the only way to tell them apart).
      const aborted = (err as BridgeFailure)?.aborted === true;
      // A DEPLOYMENT THAT NEVER TRIED. `postBridge` throws this BEFORE any
      // network call when the bridge URL or the shared secret is unset — folding
      // it into "unreachable" sent an operator hunting a network fault for a
      // missing environment variable.
      const unconfigured =
        !aborted &&
        String((err as Error)?.message ?? "").startsWith("bridge_unconfigured");
      return {
        ok: false as const,
        error: aborted
          ? "bridge_timeout"
          : unconfigured
            ? "bridge_unconfigured"
            : "bridge_unreachable",
        ...(aborted
          ? {
              note:
                "the bridge may still be attaching; re-run to see the result — " +
                "a file already on this message is never attached twice",
            }
          : {}),
      };
    }
    if (status !== 200) {
      return { ok: false as const, error: `bridge_${status}` };
    }
    // A 200 IS NOT A RESULT. A misconfigured proxy, or a bridge that diverged,
    // can answer 200 with a non-JSON body or without these arrays — and reading
    // them optimistically turned that into `ok: true` with nothing accounted
    // for: the operator would be told the call succeeded while not one requested
    // file was reported either way. Validate the shape AND the partition.
    const body = (data ?? {}) as {
      ok?: unknown;
      attached?: unknown;
      notDelivered?: unknown;
    };
    const strings = (v: unknown): string[] | null =>
      Array.isArray(v) && v.every((n) => typeof n === "string")
        ? (v as string[])
        : null;
    const rawAttached = strings(body.attached);
    const rawNotDelivered = strings(body.notDelivered);
    if (body.ok !== true || rawAttached === null || rawNotDelivered === null) {
      return { ok: false as const, error: "bridge_malformed_response" };
    }
    // The two lists must PARTITION exactly what was asked for: every requested
    // name once, and nothing else. A bridge that answered about other files, or
    // lost some silently, is not a bridge whose verdict can be relayed.
    const requested = new Set(toDeliver);
    const answered = [...rawAttached, ...rawNotDelivered];
    if (
      answered.length !== toDeliver.length ||
      new Set(answered).size !== answered.length ||
      answered.some((n) => !requested.has(n))
    ) {
      return { ok: false as const, error: "bridge_malformed_response" };
    }
    const attached = rawAttached;
    // NOT "missing": the bridge cannot tell an absent file from a transfer it
      // could not complete (media mode off, over the size cap, upload error).
      // Claiming the file is gone would send an operator to recreate a document
      // that is sitting right there — the reason is in the `openclaw.media`
      // trace this attach emits.
    const notDelivered = rawNotDelivered;

    // AUDIT (SOC2): who repaired WHICH message, and how many files landed.
    // COUNTS, never the filenames — a document's name is content, and this
    // trace is read by administrators of every conversation.
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "media.repair",
      direction: "outbound",
      principalType: "service",
      principalId,
      chatId,
      meta: JSON.stringify({
        instanceName: target.instanceName,
        // WHICH message was repaired. The comment above promised it and the
        // event did not carry it: in a chat with many replies the audit could
        // not say what had been changed. An opaque id, never a filename.
        messageId,
        requested: filenames.length,
        attached: attached.length,
        notDelivered: notDelivered.length,
        skipped: skipped.length,
      }),
    });
    return { ok: true as const, attached, notDelivered, skipped };
  },
});
