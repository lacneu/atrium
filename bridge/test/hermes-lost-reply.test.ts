/// <reference types="vitest" />
//
// Harvesting a reply the gateway finished, WITHOUT resuming the session for anything else
// (lot 48 — G-47, the last gap of W7).
//
// The two guards are upstream's own signals, not inferences of ours, and the difference
// matters because lot 30 forbids CONTINUING on a session whose run may be alive:
//
//   * `session.resume` on a LIVE session returns the live payload — `running: true`,
//     `status: "streaming"` — through `_reuse_live_payload`, WITHOUT re-attaching anything.
//     So the flag is a gate that fires before we have done any harm, not a fact observed
//     after a mutation (checked in the restored upstream before this was designed).
//   * `inflight.streaming` says whether the turn is still being produced. A turn still
//     streaming has a PARTIAL text; only a finished one is the reply the user is owed.
//
// The session is READ, never continued: whatever the outcome, the turn that follows mints a
// fresh session and carries the rehydrated history.

import { describe, expect, it } from "vitest";

import {
  harvestLostReply,
  HermesTurnRegistry,
  performHermesSend,
} from "../src/providers/hermes/dispatch.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import { parseSendBody } from "../src/server.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const SESSION = "20260706_212939_aee24e";

/** A gateway whose `session.resume` answers with `payload`. */
function resumingWith(
  payload: Record<string, unknown>,
  calls: string[] = [],
): HermesWsClient {
  return {
    call: async (method: string) => {
      calls.push(method);
      if (method === "session.resume") return payload;
      return {};
    },
  } as unknown as HermesWsClient;
}

describe("a finished reply is harvested", () => {
  it("the text the gateway completed comes back", async () => {
    const got = await harvestLostReply(
      resumingWith({
        session_id: "rt-9",
        stored_session_id: SESSION,
        running: false,
        inflight: {
          assistant: "Voici la réponse que la passerelle avait terminée.",
          streaming: false,
          user: "explique-moi",
        },
      }),
      SESSION,
    );
    expect(got).toContain("avait terminée");
  });
});

describe("nothing is harvested from a turn that is still alive", () => {
  it("a RUNNING session is left alone — that is lot 30's own risk", async () => {
    const calls: string[] = [];
    const got = await harvestLostReply(
      resumingWith(
        {
          stored_session_id: SESSION,
          running: true,
          // NOT streaming: the session is live on a NEW turn while the old snapshot has
          // settled. The two flags are independent, and this is the state that isolates the
          // `running` guard — a neutralization proved the first version of this test leaned
          // on `streaming` and could not fail without it.
          inflight: { assistant: "une réponse settled", streaming: false },
        },
        calls,
      ),
      SESSION,
    );
    expect(got).toBeNull();
    // Read once, and nothing else: no interrupt, no prompt, no second call.
    expect(calls).toEqual(["session.resume"]);
  });

  it("a turn still STREAMING is a partial, not the reply owed", async () => {
    // `running` can be false while the snapshot still says the turn was mid-production.
    // Taking that text would hand the user a truncated answer presented as complete — the
    // failure lot 34 exists to prevent, arriving by another door.
    const got = await harvestLostReply(
      resumingWith({
        stored_session_id: SESSION,
        running: false,
        inflight: { assistant: "une phrase coupée en", streaming: true },
      }),
      SESSION,
    );
    expect(got).toBeNull();
  });
});

describe("what is not a harvest", () => {
  it("an empty `assistant` yields nothing", async () => {
    const got = await harvestLostReply(
      resumingWith({
        stored_session_id: SESSION,
        running: false,
        inflight: { assistant: "   ", streaming: false },
      }),
      SESSION,
    );
    expect(got).toBeNull();
  });

  it("no `inflight` at all yields nothing", async () => {
    const got = await harvestLostReply(
      resumingWith({ stored_session_id: SESSION, running: false }),
      SESSION,
    );
    expect(got).toBeNull();
  });

  it("a resume that answers about ANOTHER session is refused", async () => {
    // The gateway rotated, or the handle is stale: harvesting then would attribute one
    // conversation's text to another. Matched by id, like every session decision here.
    const got = await harvestLostReply(
      resumingWith({
        stored_session_id: "20260706_999999_ffffff",
        running: false,
        inflight: { assistant: "du texte d'ailleurs", streaming: false },
      }),
      SESSION,
    );
    expect(got).toBeNull();
  });

  it("a resume that FAILS is not a recovery, and never a thrown turn", async () => {
    // The handle points at a session the gateway has since forgotten — the ordinary case
    // after a restart. It must cost the next turn nothing at all.
    const client = {
      call: async () => {
        throw new Error("no such session");
      },
    } as unknown as HermesWsClient;
    await expect(harvestLostReply(client, SESSION)).resolves.toBeNull();
  });
});

// ── A reset during the harvest must still stop the send ──
//
// Raised in review, and it was a window this lot OPENED. The chat's turn seat is claimed
// before the harvest, but no run is bound to it yet — so a `/reset` landing during the
// harvest's network wait has nothing to abort. Reading the reset generation AFTER that await
// read the NEW one, and the guard then passed: the prompt the reset meant to stop went
// through. The generation is now captured before the harvest and re-checked after.

describe("a /reset during the harvest cancels the send", () => {
  it("no prompt is submitted when the chat was reset mid-read", async () => {
    const calls: string[] = [];
    let releaseResume!: () => void;
    const held = new Promise<void>((res) => {
      releaseResume = res;
    });
    const registry = new HermesTurnRegistry();
    const client = {
      call: async (method: string) => {
        calls.push(method);
        if (method === "session.resume") {
          await held;
          return { stored_session_id: SESSION, running: false };
        }
        if (method === "session.create") {
          return { session_id: "rt-1", stored_session_id: SESSION };
        }
        if (method === "prompt.submit") return { status: "streaming" };
        return {};
      },
    } as unknown as HermesWsClient;
    class Reg extends HermesTurnRegistry {
      override wsClientFor(): HermesWsClient {
        return client;
      }
    }
    const reg = new Reg();
    void registry;
    const cfg = {
      transport: "ws",
      instanceName: "primary",
      gatewayHttpBase: "http://127.0.0.1:1",
      openclawGatewayUrl: "http://127.0.0.1:1",
      openclawToken: "t",
    } as unknown as BridgeConfig;
    const writer = {
      recoverLostReply: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      startAssistant: async () => "msg-1",
      finalize: async () => {},
    } as unknown as ConvexWriter;

    const sending = performHermesSend(
      cfg,
      writer,
      {
        chatId: "c1",
        agentId: "hermes-agent",
        canonical: "alice",
        openclawChatId: null,
        text: "bonjour",
        recoverableSession: { session: SESSION, messageId: "m1" },
      } as never,
      reg,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    // The reset lands while the harvest is still on the wire.
    await new Promise((r) => setTimeout(r, 0));
    reg.forgetChat("c1");
    releaseResume();
    const err = await sending;
    expect((err as Error)?.message).toMatch(/reset during dispatch/);
    expect(
      calls,
      "the prompt the reset meant to stop must never reach the gateway",
    ).not.toContain("prompt.submit");
  });
});

// ── The hop that decides whether any of this runs at all ──
//
// Raised in review, and it is the same failure that cancelled v1 of this lot: `convex/bridge.ts`
// put the handle in the POST body, and `parseSendBody` rebuilt a `SendBody` WITHOUT it. So
// `performHermesSend` always saw `undefined`, the harvest never ran, and every test above
// passed by calling the function directly — bypassing the very boundary production goes
// through. A feature that only works in tests is not a feature.

describe("the handle survives the HTTP boundary", () => {
  const base = {
    chatId: "c1",
    agentId: "hermes-agent",
    canonical: "alice",
    instanceName: "primary",
    text: "bonjour",
    clientMessageId: "cmid-1",
  };

  it("a well-formed handle is parsed out of the POST body", () => {
    const body = parseSendBody(
      JSON.stringify({
        ...base,
        recoverableSession: {
          session: SESSION,
          messageId: "m1",
          instanceName: "primary",
        },
      }),
    );
    expect(body?.recoverableSession?.session).toBe(SESSION);
    expect(body?.recoverableSession?.messageId).toBe("m1");
  });

  it("a body without one parses to null, not to a broken handle", () => {
    expect(parseSendBody(JSON.stringify(base))?.recoverableSession ?? null).toBeNull();
  });

  it("a HALF-FORMED handle is refused rather than half-used", () => {
    // Either id missing is unusable: a session with no message to write back to, or a
    // message with no session to read. Both must leave the turn exactly as it was.
    for (const bad of [
      { session: SESSION },
      { messageId: "m1" },
      { session: "", messageId: "m1" },
      { session: SESSION, messageId: "" },
      "not-an-object",
    ]) {
      const body = parseSendBody(
        JSON.stringify({ ...base, recoverableSession: bad }),
      );
      expect(body?.recoverableSession ?? null, JSON.stringify(bad)).toBeNull();
    }
  });
});
