// THE SEVEN-DAY WALL, ON THE REAL SEND PATH.
//
// The unit tests beside this one pin the restore decision. What they cannot show is
// the only thing that mattered to the person who reported it: a conversation older
// than a week accepted their message again, without them ever learning that
// "archived" is a thing.
//
// Upstream auto-archives an idle dashboard session after 7 days and then refuses
// `chat.send` outright (lifecycle.ts:124-125 via agent-admission-controller.ts:172).
// Before this lot the bridge sent anyway, the gateway refused, and Atrium showed
// nothing at all — the conversation simply stopped answering (prod 2026-09-20).

import { afterEach, describe, expect, it, vi } from "vitest";

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

const body = {
  ...ROUTING,
  text: "et pour l'image ?",
  clientMessageId: "cm-1",
  messageId: "um-1",
  providerResetCount: null,
  outboxId: "ob-1",
  dispatchAgeMs: 0,
  switchedFromAgentId: null,
  switchedFromInstanceName: null,
  sessionSettings: null,
  referenceAttachments: [],
  config: null,
} as unknown as Parameters<typeof performSend>[1];

const writer = {
  startAssistant: async () => "msg-1",
  appendDelta: async () => {},
  setSnapshot: async () => true,
  addToolPart: async () => {},
  addMedia: async () => {},
  finalize: async () => {},
  reportSessionMeta: async () => {},
  recordGatewayPressure: async () => {},
  clearSessionState: async () => {},
  getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  emitRehydrateTrace: () => {},
} as unknown as ConvexWriter;

async function harness(script: Parameters<typeof fakeGateway>[0]) {
  const gw = fakeGateway(script);
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  return { gw: session.connection as unknown as FakeGateway, session };
}

/** A live session, as the describe presents one. */
const LIVE = { sessionId: "s-live", systemSent: true, archived: false };
/** The same conversation after the maintenance window closed on it. */
const ARCHIVED = { sessionId: "s-arch", systemSent: true, archived: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a week-old conversation answers again", () => {
  it("restores the archived session, THEN sends — the person types and it works", async () => {
    const { gw, session } = await harness({
      // Archived when the turn arrives; live once the restore has landed.
      describe: [ARCHIVED, LIVE],
    });
    await performSend(session, body, writer, null, null);

    const patch = gw.calls.find(
      ([m, p]) => m === "sessions.patch" && (p as { archived?: unknown }).archived === false,
    )?.[1] as Record<string, unknown> | undefined;
    expect(patch, "the archived session must be restored").toBeDefined();
    // The optimistic lock upstream REQUIRES, carrying the id from the describe that
    // found it archived (sessions-patch.ts:193-195).
    expect(patch).toMatchObject({ archived: false, expectedSessionId: "s-arch" });
    // …and the whole point: the turn goes out.
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("re-reads the session after restoring it — the turn runs on the live row", async () => {
    // Every figure the pre-send guard and the freshness rule use comes from the
    // describe. Left on the pre-restore read, the turn would be measured against a
    // session that no longer exists in that state.
    const { gw, session } = await harness({ describe: [ARCHIVED, LIVE] });
    await performSend(session, body, writer, null, null);
    expect(gw.countOf("sessions.describe")).toBe(2);
  });

  it("a re-read that ANSWERS NOTHING keeps the pre-restore read — the session we just saved is not thrown away", async () => {
    // `describeSession` RESOLVES null when the payload carries no session
    // (models-roster.ts:493); it does not throw, so the try/catch around the
    // re-read never covered this and the assignment replaced a good read with
    // nothing. The session we had just restored then looked BRAND NEW: the
    // freshness verdict re-injects and re-bills the whole history, the stored
    // state is cleared, and the turn is dispatched with `expectedSessionId: null`
    // — the exact loss the restore exists to prevent, caused by the restore.
    const cleared: unknown[] = [];
    const watchful = {
      ...writer,
      clearSessionState: async (...a: unknown[]) => {
        cleared.push(a);
      },
    } as unknown as ConvexWriter;
    const { gw, session } = await harness({ describe: [ARCHIVED, null] });
    await performSend(session, body, watchful, null, null);

    // The restore happened and the turn still goes out — fail-open is unchanged.
    expect(gw.countOf("chat.send")).toBe(1);
    // …and the empty answer did NOT make the conversation look fresh.
    expect(
      cleared,
      "an unlucky RPC is not evidence that the session is gone",
    ).toHaveLength(0);
    const send = gw.calls.find(([m]) => m === "chat.send")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(
      JSON.stringify(send ?? {}),
      "the history must not be re-injected on a session that already holds it",
    ).not.toContain("<conversation-history>");
  });

  it("a LIVE conversation pays NOTHING — no patch, one describe", async () => {
    // This is every turn of every conversation younger than a week. A repair that
    // taxed the happy path would be the wrong trade.
    const { gw, session } = await harness({ describe: [LIVE] });
    await performSend(session, body, writer, null, null);

    expect(
      gw.calls.some(([m, p]) => m === "sessions.patch" && "archived" in (p as object)),
    ).toBe(false);
    expect(gw.countOf("sessions.describe")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a restore the gateway REFUSES still lets the send go — the gateway speaks, not us", async () => {
    // Fail-open by design: the repair must never cost the turn it exists to save.
    // The send then carries the gateway's own refusal, which the classifier names
    // (`session_archived`) — a real card instead of the silence users reported.
    const { gw, session } = await harness({
      describe: [ARCHIVED],
      // The FIRST patch is the once-per-connection `verboseLevel`; the archive
      // restore is the second. Scoped to it so the refusal under test is the one
      // this case is about.
      sequences: {
        "sessions.patch": [
          {},
          { throws: new Error("FORBIDDEN: missing scope: operator.write") },
        ],
      },
    });
    await performSend(session, body, writer, null, null);
    expect(gw.countOf("chat.send")).toBe(1);
  });
});
