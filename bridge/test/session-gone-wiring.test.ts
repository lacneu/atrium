/**
 * The PRODUCTION wiring of the gone-conversation clear: Session -> RunManager ->
 * Normalizer -> writer.finalize.
 *
 * The class-level tests inject the stored session straight into `new Normalizer(...)`,
 * which proves the normalizer and nothing else. The value actually comes from Convex,
 * down two constructors that each default it to `null` — a hop that silently kept its
 * default would produce an UNNAMED clear, and Convex refuses those on the owning path,
 * so the dead conversation would stay bound with every unit test still green (codex).
 *
 * This drives the real Session constructor with the routing Convex sends, feeds the real
 * gateway sentence, and asserts the id arrives in the finalize options.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { servedMap } from "./helpers/served.js";

const OWN_RUN = "run-1";
const STORED = "000b1aae-99f1-4836-ae45-ab9ebba7d8e8"; // a real OpenClaw session id

/** The gateway's own preflight-compaction wrapper, verbatim. */
const GONE =
  "⚠️ Context is too large and auto-compaction could not recover this turn. " +
  "Reason: no conversation found for session. " +
  "Try again, use /compact, or use /new to start a fresh session.";

function fakeWriter() {
  const finalized: unknown[][] = [];
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    addProvenancePart: async () => {},
    finalize: async (...args: unknown[]) => {
      finalized.push(args);
    },
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  return { writer, finalized };
}

/** The gateway never sends anything on its own here: every frame is fed directly. */
function fakeConn() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    get isClosed() {
      return false;
    },
    close() {
      release();
    },
    async request() {
      return { payload: {} };
    },
    onConfigChanged: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      await gate;
    },
  };
}

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
} as unknown as BridgeConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

/** The production path: the registry builds the Session from the routing Convex sent. */
async function sessionFor(openclawChatId: string | null) {
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(
    async () => fakeConn() as never,
  );
  const { writer, finalized } = fakeWriter();
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire({
    chatId: "c1",
    agentId: "a",
    canonical: "alice",
    openclawChatId,
  });
  return { session, finalized, reg };
}

/** The terminal error frame, driven through the session's own run manager. */
async function driveGone(session: {
  sessionKey: string;
  runManager: {
    beginTurn: (now: number, runId: string) => Promise<void>;
    feed: (frame: unknown, now: number) => Promise<unknown>;
  };
}): Promise<void> {
  let now = 1_000_000; // RunManager drives on milliseconds
  await session.runManager.beginTurn(now, OWN_RUN);
  await session.runManager.feed(
    {
      type: "event",
      event: "chat",
      payload: {
        runId: OWN_RUN,
        sessionKey: session.sessionKey,
        state: "error",
        errorMessage: GONE,
      },
    },
    (now += 10),
  );
}

/** finalize(messageId, status, text, error, errorKind, opts) — opts is the last arg. */
function clearedSession(finalized: unknown[][]): string | undefined {
  const call = finalized.at(-1);
  const opts = call?.at(-1) as { clearProviderSession?: string } | undefined;
  return opts?.clearProviderSession;
}

describe("session_gone: the stored session travels Session -> RunManager -> Normalizer", () => {
  it("names the session Convex stored for this chat", async () => {
    const { session, finalized, reg } = await sessionFor(STORED);
    await driveGone(session);
    expect(finalized.length).toBe(1);
    expect(clearedSession(finalized)).toBe(STORED);
    reg.closeAll();
  });

  it("names nothing when the chat has no stored session", async () => {
    const { session, finalized, reg } = await sessionFor(null);
    await driveGone(session);
    expect(finalized.length).toBe(1);
    expect(clearedSession(finalized)).toBeUndefined();
    reg.closeAll();
  });
});
