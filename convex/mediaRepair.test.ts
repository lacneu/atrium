/// <reference types="vite/client" />
//
// mediaRepair.resolveTarget — what Convex owns in an operator repair.
//
// The bridge owns path safety (basenames only, path built from the instance's
// outbound root). Convex owns the TARGET: that the message exists, that it
// belongs to the chat the caller named, and which instance's outbound directory
// its files live in. Without the pairing check, two individually valid ids would
// authorize a write the pair does not.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("mediaRepair.resolveTarget", () => {
  async function seed() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "ws://gw",
        bridgeUrl: "http://bridge.ataraxis",
      });
      await ctx.db.insert("instances", {
        name: "lacneu",
        gatewayUrl: "ws://gw2",
        bridgeUrl: "http://bridge.lacneu",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "ataraxis",
      });
      const otherChatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        // What `startAssistant` writes on every bridge-authenticated turn: the
        // durable owner stamp. A fixture without it models a reply the bridge
        // never produces.
        boundInstance: "ataraxis",
        updatedAt: 2,
      });
      // A reply that RAN on another instance. `startAssistant` stamps
      // `boundInstance` — the durable owner stamp — NOT `routedInstanceName`,
      // which is written on the USER turn. Reading the routed field first sent
      // every such repair at the chat primary's directory instead.
      const boundId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        boundInstance: "lacneu",
        updatedAt: 3,
      });
      const userTurnId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "une question",
        updatedAt: 4,
      });
      const streamingId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "streaming",
        text: "",
        boundInstance: "ataraxis",
        updatedAt: 5,
      });
      return {
        chatId,
        otherChatId,
        messageId,
        boundId,
        userTurnId,
        streamingId,
      };
    });
    return { t, ...ids };
  }

  test("resolves the chat's instance and its bridge", async () => {
    const { t, chatId, messageId } = await seed();
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId,
    });
    expect(got).toEqual({
      ok: true,
      instanceName: "ataraxis",
      bridgeUrl: "http://bridge.ataraxis",
      // The message's CURRENT generation, threaded to the attach so a bubble
      // reopened mid-transfer refuses the part.
      runId: null,
      // The persistent half of the idempotency: nothing on this bubble yet.
      alreadyAttached: [],
      // The instance's CURRENT media configuration, carried so the bridge
      // applies it before reading the directory — its provider otherwise keeps
      // whatever it booted with.
      // EMPTY: this instance stores no media override, so the bridge must keep
      // its OWN env default. Materialising Convex's defaults here would force an
      // env-configured `shared-fs` bridge to `gateway-http` — and would
      // RE-ENABLE media on an instance where it is deliberately off.
      mediaConfig: {},
    });
  });

  test("a reply that RAN elsewhere resolves to ITS instance, not the chat primary", async () => {
    // The field that carries this is `boundInstance` (the owner stamp
    // `startAssistant` writes and finalize preserves). Resolving from
    // `routedInstanceName` — written on the USER turn — silently sent every
    // routed repair at the chat primary's outbound directory.
    const { t, chatId, boundId } = await seed();
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId: boundId,
    });
    expect(got).toMatchObject({
      ok: true,
      instanceName: "lacneu",
      bridgeUrl: "http://bridge.lacneu",
    });
  });

  test("only a SETTLED ASSISTANT reply can be repaired", async () => {
    // A user bubble is never the target of a lost REPLY delivery; and the
    // attach states no generation on purpose, which on a live turn would slip
    // past the guard protecting it.
    const { t, chatId, userTurnId, streamingId } = await seed();
    expect(
      await t.query(internal.mediaRepair.resolveTarget, {
        chatId,
        messageId: userTurnId,
      }),
    ).toEqual({ ok: false, error: "not_an_assistant_reply" });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, {
        chatId,
        messageId: streamingId,
      }),
    ).toEqual({ ok: false, error: "turn_still_running" });
  });

  test("files ALREADY on the bubble are reported, so a retry cannot duplicate", async () => {
    // The bridge's own dedup is per-process: after a restart it is empty, and a
    // retried repair would attach a second copy. `addPart` is append-only for a
    // settled message, so the durable half of the promise lives here.
    const { t, chatId, messageId } = await seed();
    await t.run(async (ctx) => {
      // A REAL storage id: the part validator requires one, so a placeholder
      // string would fail the insert rather than the assertion.
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "media",
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
          storageId,
        },
      });
    });
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId,
    });
    expect(got).toMatchObject({ ok: true, alreadyAttached: ["vade-mecum.pdf"] });
  });

  test("a name already on the bubble as a `file` part counts as attached", async () => {
    // The two blob-carrying part kinds are ONE family (`isFilePart`): a repair
    // writes `media`, but the same document may already be there as a `file` —
    // `addPart` takes the whole part union from the bridge, and `chatFork` copies
    // both kinds onto a forked reply. Matching only `media` re-requested the file
    // and the bubble rendered it twice.
    const { t, chatId, messageId } = await seed();
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "file",
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
          storageId,
        },
      });
    });
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId,
    });
    expect(got).toMatchObject({ ok: true, alreadyAttached: ["vade-mecum.pdf"] });
  });

  test("a reply with NO provenance is refused, never resolved to the chat's current instance", async () => {
    // `boundInstance` is the only field that says who PRODUCED this reply. The
    // chat's current instance is a guess: A produces the reply, A is
    // decommissioned, the chat is rebound to B — and the repair would then read
    // B's outbound directory, where a file of the same name is someone else's
    // work. That is the header's own refusal ("guessing at a shared outbound
    // directory is how one conversation ends up with another's documents").
    const { t, chatId } = await seed();
    const messageId = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      return ctx.db.insert("messages", {
        chatId, // chat.instanceName is "ataraxis" — and it is NOT evidence
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        // A reply predating the durable stamp. `routedInstanceName` is written on
        // the USER turn and rides here only through a fork: not provenance.
        routedInstanceName: "lacneu",
        updatedAt: 6,
      });
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, { chatId, messageId }),
    ).toEqual({ ok: false, error: "no_provenance" });
  });

  test("a part whose BLOB is gone does not count as attached", async () => {
    // The bubble shows nothing for it — the renderer drops a part with no
    // resolved URL — so answering "already there" made the one tool built to
    // restore a missing file refuse the very case it exists for.
    const { t, chatId, messageId } = await seed();
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "media",
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
          storageId,
        },
      });
      await ctx.storage.delete(storageId); // the object goes, the row stays
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, { chatId, messageId }),
    ).toMatchObject({ ok: true, alreadyAttached: [] });
  });

  test("an instance with no bridge of its own is REFUSED, not sent to the env bridge", async () => {
    // The dispatch path resolves this with `resolveBridgeUrlForDispatch`: the env
    // `BRIDGE_URL` may serve an instance without its own URL only when the
    // attribution is unambiguous — the sole instance, or the explicitly served
    // one. Reading `instance.bridgeUrl ?? null` and letting `postBridge` fall back
    // was a SECOND reading of that rule, and it sent a repair for one instance at
    // another instance's bridge, to read another instance's outbound directory.
    const { t } = await seed(); // seeds TWO instances -> not sole
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("instances", { name: "urlless", gatewayUrl: "ws://u" });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "urlless",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        boundInstance: "urlless",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    const saved = process.env.BRIDGE_URL;
    process.env.BRIDGE_URL = "http://bridge.someone-else";
    const savedServed = process.env.BRIDGE_INSTANCE_NAME;
    delete process.env.BRIDGE_INSTANCE_NAME;
    try {
      expect(
        await t.query(internal.mediaRepair.resolveTarget, { chatId, messageId }),
      ).toEqual({ ok: false, error: "bridge_not_configured" });
    } finally {
      if (saved === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = saved;
      if (savedServed !== undefined)
        process.env.BRIDGE_INSTANCE_NAME = savedServed;
    }
  });

  test("a HERMES instance is refused rather than sent at the wrong directory", async () => {
    // Hermes agents write under their own working directory, not the OpenClaw
    // outbound mount the path is composed from — the repair would look in the
    // wrong place and report a file that exists as not delivered.
    const { t } = await seed();
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("instances", {
        name: "hermes-one",
        gatewayUrl: "ws://h",
        kind: "hermes",
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "hermes-one",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        boundInstance: "hermes-one",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, { chatId, messageId }),
    ).toEqual({ ok: false, error: "provider_not_supported" });
  });

  test("a STORED media override is carried; an unset one is left to the bridge", async () => {
    const { t } = await seed();
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("instances", {
        name: "shared",
        gatewayUrl: "ws://s",
        // Its OWN bridge: a multi-instance deployment refuses the env fallback
        // for an instance it cannot attribute (see bridgeRouting).
        bridgeUrl: "http://bridge.shared",
        // The MODE and the MOUNT are set; the cap must stay the bridge's own.
        config: {
          mediaMode: "shared-fs",
          outboundAgentMount: "/srv/ataraxis/out",
        },
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "shared",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        boundInstance: "shared",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId,
      messageId,
    });
    expect(got).toMatchObject({
      ok: true,
      mediaConfig: {
        mediaMode: "shared-fs",
        // WHERE the agent writes. The fetcher hands the gateway this path
        // verbatim, so composing from the bridge's boot value would ask for a
        // file under a path it is not at.
        outboundAgentMount: "/srv/ataraxis/out",
      },
    });
    expect(
      (got as { mediaConfig: Record<string, unknown> }).mediaConfig,
    ).not.toHaveProperty("mediaMaxMb");

    // ...and when it IS stored, it travels in the DISPATCH PATH'S OWN shape —
    // megabytes, the key `parseInboundConfig` reads. A second shape here (the cap
    // pre-converted to bytes) meant the bridge had to hand this route's config to
    // `applyConfig` unparsed, on the one call that reconfigures a provider shared
    // with live deliveries.
    const capped = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("instances", {
        name: "capped",
        gatewayUrl: "ws://c",
        // Its OWN bridge: a multi-instance deployment refuses the env fallback
        // for an instance it cannot attribute (see bridgeRouting).
        bridgeUrl: "http://bridge.capped",
        config: { mediaMaxMb: 7 },
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "capped",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        boundInstance: "capped",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, capped),
    ).toMatchObject({ ok: true, mediaConfig: { mediaMaxMb: 7 } });
  });

  test("an instance Atrium no longer knows is REFUSED, not sent to the default bridge", async () => {
    // A message keeps its owner stamp after the instance row is deleted. With no
    // row, every check below it went vacuous: `instance?.kind` skipped the Hermes
    // refusal, and a null `bridgeUrl` falls back to the DEPLOYMENT DEFAULT bridge
    // — so the repair asked whichever bridge that is to read a directory
    // belonging to something else.
    const { t, chatId } = await seed();
    const messageId = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      return ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        boundInstance: "decommissioned",
        updatedAt: 7,
      });
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, { chatId, messageId }),
    ).toEqual({ ok: false, error: "instance_unknown" });
  });

  test("a message that does not belong to the named chat is REFUSED", async () => {
    // Both ids are valid on their own; the PAIR is not. Without this, naming any
    // chat you can reach would authorize attaching a file to any message.
    const { t, otherChatId, messageId } = await seed();
    const got = await t.query(internal.mediaRepair.resolveTarget, {
      chatId: otherChatId,
      messageId,
    });
    expect(got).toEqual({ ok: false, error: "message_not_in_chat" });
  });

  test("an unknown or malformed id is not_found, never a throw", async () => {
    const { t, chatId, messageId } = await seed();
    expect(
      await t.query(internal.mediaRepair.resolveTarget, {
        chatId: "not-an-id",
        messageId,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, {
        chatId,
        messageId: "not-an-id",
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  test("the STAMP decides even when the chat names no instance at all", async () => {
    // The chat is no longer consulted: provenance is a property of the REPLY.
    // A chat with a null primary (legacy, or one whose binding was cleared) used
    // to make the repair unresolvable even though the reply says plainly who
    // produced it.
    const { t, otherChatId } = await seed();
    const messageId = await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      return ctx.db.insert("messages", {
        chatId: otherChatId, // inserted with NO instanceName
        userId,
        role: "assistant",
        status: "complete",
        text: "",
        boundInstance: "lacneu",
        updatedAt: 4,
      });
    });
    expect(
      await t.query(internal.mediaRepair.resolveTarget, {
        chatId: otherChatId,
        messageId,
      }),
    ).toMatchObject({
      ok: true,
      instanceName: "lacneu",
      bridgeUrl: "http://bridge.lacneu",
    });
  });
});

describe("mediaRepair.deliverOutboundFiles — the audit of a no-op", () => {
  test("a retry that finds everything already there STILL records a result", async () => {
    // The realistic sequence: the first call times out AFTER the bridge attached
    // the files, so only its ATTEMPT is on record. The retry is the call that
    // establishes the files are there — and it returned early, before both the
    // attempt and the result events, so that outcome was recorded nowhere.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "ws://gw",
        bridgeUrl: "http://bridge.ataraxis",
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "ataraxis",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        boundInstance: "ataraxis",
        updatedAt: 2,
      });
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 0,
        part: {
          kind: "media" as const,
          filename: "v.pdf",
          mimeType: "application/pdf",
          storageId,
        },
      });
      return { chatId: cid, messageId: mid };
    });

    const out = await t.action(internal.mediaRepair.deliverOutboundFiles, {
      chatId,
      messageId,
      filenames: ["v.pdf"],
      principalId: "svc-1",
    });
    expect(out).toEqual({
      ok: true,
      attached: [],
      notDelivered: [],
      skipped: ["v.pdf"],
    });

    const events = await t.run(async (ctx) =>
      (await ctx.db.query("traceEvents").collect()).filter(
        (e) => e.kind === "media.repair",
      ),
    );
    expect(events).toHaveLength(1);
    // The SAME shape as an ordinary result — one event kind, one shape.
    expect(JSON.parse(String(events[0].meta))).toMatchObject({
      instanceName: "ataraxis",
      messageId,
      requested: 1,
      attached: 0,
      notDelivered: 0,
      skipped: 1,
    });
  });
});

// The DURABLE half of the audit. `media.repair` carries the counts but lives in
// traceEvents, purged after 14 days — well inside an audit period. The 90-day
// accessLog has no `meta`, so the message id rides its own column.
describe("a timeout DURING the body is still a timeout", () => {
  test("a stalled 200 body answers bridge_timeout, not bridge_malformed_response", async () => {
    // The headers can arrive and the body then stall until the action's own
    // deadline fires. Swallowing that abort turned a 504 "the bridge may still
    // be attaching" into a 502 "malformed response" — the opposite of the truth,
    // and the note telling the operator a retry is safe disappeared with it.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "ws://gw",
        bridgeUrl: "http://bridge.ataraxis",
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "ataraxis",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        boundInstance: "ataraxis",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    const savedSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_SHARED_SECRET = "s";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      // The body read aborts, exactly as it does when the action's controller
      // fires while the response streams.
      json: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    })) as unknown as typeof fetch;
    try {
      expect(
        await t.action(internal.mediaRepair.deliverOutboundFiles, {
          chatId,
          messageId,
          filenames: ["v.pdf"],
          principalId: "svc-1",
        }),
      ).toMatchObject({ ok: false, error: "bridge_timeout" });
    } finally {
      globalThis.fetch = realFetch;
      if (savedSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = savedSecret;
    }
  });
});

describe("a deployment that never tried is not a network fault", () => {
  test("a missing bridge secret answers bridge_unconfigured, not bridge_unreachable", async () => {
    // `postBridge` throws this BEFORE any network call. Folding it into
    // "unreachable" sent an operator hunting a network fault for an unset
    // environment variable.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "ws://gw",
        bridgeUrl: "http://bridge.ataraxis",
      });
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "ataraxis",
      });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        boundInstance: "ataraxis",
        updatedAt: 2,
      });
      return { chatId: cid, messageId: mid };
    });
    const saved = process.env.BRIDGE_SHARED_SECRET;
    delete process.env.BRIDGE_SHARED_SECRET;
    try {
      expect(
        await t.action(internal.mediaRepair.deliverOutboundFiles, {
          chatId,
          messageId,
          filenames: ["v.pdf"],
          principalId: "svc-1",
        }),
      ).toMatchObject({ ok: false, error: "bridge_unconfigured" });
    } finally {
      if (saved !== undefined) process.env.BRIDGE_SHARED_SECRET = saved;
    }
  });
});

describe("the repair's audit survives the trace retention", () => {
  test("accessLog keeps WHICH message an api.call targeted", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: "svc-1",
        roleKey: "admin",
        route: "/api/v1/deliver-media",
        method: "POST",
        chatId: "chat-1",
        messageId: "msg-1",
        status: 200,
      });
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("accessLog").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "/api/v1/deliver-media",
      chatId: "chat-1",
      messageId: "msg-1",
    });
    // AND THE DOCUMENTED READER RETURNS IT. Persisting the id without exposing
    // it here left the promise half-kept: `listAccessLog` IS the way an operator
    // reads the 90-day log, so after the trace purge the answer to "which
    // message" would still be nowhere.
    const as = await t.withIdentity({ subject: `${await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "admin" as const });
      return userId;
    })}|session` });
    const view = await as.query(api.observability.listAccessLog, {});
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      route: "/api/v1/deliver-media",
      messageId: "msg-1",
    });

    // ...and the trace row keeps its stated shape: no messageId column on it.
    const traces = await t.run(async (ctx) =>
      ctx.db.query("traceEvents").collect(),
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]).not.toHaveProperty("messageId");
  });
});
