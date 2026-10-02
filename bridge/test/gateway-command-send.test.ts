/**
 * A GATEWAY COMMAND leaves exactly as typed (prod 2026-09-27).
 *
 * `/knowledge` answered "unknown subcommand: [livraison]" and `/knowledge once graph`
 * received dozens of extra words: the bridge appended its media-delivery instruction to
 * every message, and could also prepend re-hydrated history and append the received-files
 * block. The gateway reads a command from the trimmed text's first word and takes the
 * rest as arguments (upstream src/auto-reply/command-detection.ts). These tests drive the
 * real send path against a scripted gateway and read what `chat.send` actually carried.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import type { InboundMediaConfig } from "../src/core/inbound-media.js";
import { isGatewayCommandText } from "../src/core/gateway-command.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { promptWithFreshSessionHistory } from "../src/providers/hermes/dispatch.js";
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
  openclawChatId: "turn:x",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

function bodyFor(text: string, extra: Record<string, unknown> = {}) {
  return {
    ...ROUTING,
    text,
    clientMessageId: "cm-1",
    messageId: "um-1",
    providerResetCount: null,
    outboxId: "ob-1",
    dispatchAgeMs: 0,
    switchedFromAgentId: null,
    switchedFromInstanceName: null,
    sessionSettings: null,
    referenceAttachments: [],
    // Re-hydration on, and a routed switch: the session reads FRESH, so an ordinary
    // message gets the history in front of it.
    config: { rehydration: true, routedSwitch: true },
    ...extra,
  } as unknown as Parameters<typeof performSend>[1];
}

/** An inbound config that FAILS on any read: a command must never stage a file. */
const untouchableInbound = new Proxy({} as InboundMediaConfig, {
  get() {
    throw new Error("inbound staging was attempted for a command");
  },
});

async function harness(describe: Record<string, unknown>) {
  const gw = fakeGateway({ describe: [describe] });
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const asked: unknown[] = [];
  const traces: Record<string, unknown>[] = [];
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
    getRehydrationContext: async (...args: unknown[]) => {
      asked.push(args);
      return { history: "[history] Bob: earlier turn", turnCount: 1 };
    },
    emitRehydrateTrace: (t: Record<string, unknown>) => {
      traces.push(t);
    },
  } as unknown as ConvexWriter;
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  // A version the media quarantine does not withhold the delivery instruction on: an
  // ordinary message must show it, so its absence on a command means something.
  (session.connection as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
  return { gw: session.connection as unknown as FakeGateway, session, writer, asked, traces };
}

function sentMessage(gw: FakeGateway): string | undefined {
  const sent = gw.calls.find(([m]) => m === "chat.send")?.[1] as { message?: string } | undefined;
  return sent?.message;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isGatewayCommandText", () => {
  it("is the gateways' token grammar: `/name`, then whitespace, `:` or the end", () => {
    for (const t of [
      "/knowledge",
      "/knowledge once graph",
      "/new",
      "  /compact\n",
      "\n/think high",
      "/compact: keep the decisions",
      "/export-session",
      "/my_skill run",
      "/2fa_helper",
      "/Status",
    ]) {
      expect(isGatewayCommandText(t), JSON.stringify(t)).toBe(true);
    }
    for (const t of [
      "bonjour",
      "a /path in the middle",
      // A PATH: a second `/` in the first token (Hermes cli.py `_looks_like_slash_command`;
      // OpenClaw's matcher needs whitespace, `:` or the end after the name).
      "/tmp/x.txt regarde ce fichier",
      "/Users/olivier/report.md:45-46 can you fix this?",
      "/tmp/",
      "/new.md",
      "/-x",
      "/ new",
      "/",
      "",
      "  ",
      null,
      undefined,
    ]) {
      expect(isGatewayCommandText(t), JSON.stringify(t)).toBe(false);
    }
  });
});

describe("a gateway command reaches chat.send byte-identical", () => {
  for (const text of [
    "/knowledge",
    "/knowledge once graph",
    "/new",
    "  /compact  ",
    "/knowledge once graph\nsecond line",
  ]) {
    it(JSON.stringify(text), async () => {
      const { gw, session, writer, asked, traces } = await harness({
        sessionId: "s-1",
        systemSent: false,
      });
      // A shared-fs file on the turn too: an older Convex could still send one.
      await performSend(
        session,
        bodyFor(text, {
          referenceAttachments: [{ storageId: "st", url: "http://x", filename: "f.txt", mimeType: "text/plain" }],
        }),
        writer,
        untouchableInbound,
        "/media/outbound",
      );
      expect(sentMessage(gw)).toBe(text);
      // No history was even asked for, and the trace says why.
      expect(asked).toHaveLength(0);
      expect(traces[0]?.decision).toBe("skip_command");
      // The session stays FRESH for the next ordinary turn, which carries the history.
      expect(session.firstSendPending).toBe(true);
    });
  }

  it("a command on a FULL session is neither compacted first nor withheld", async () => {
    const { gw, session, writer } = await harness({
      sessionId: "s-1",
      systemSent: true,
      contextTokens: 200_000,
      promptBudgetBeforeReserve: 100_000,
      estimatedPromptTokens: 99_000,
      totalTokensFresh: true,
    });
    await performSend(session, bodyFor("/compact"), writer, null, "/media/outbound");
    expect(gw.countOf("sessions.compact")).toBe(0);
    expect(sentMessage(gw)).toBe("/compact");
  });
});

describe("an ordinary message keeps everything Atrium adds", () => {
  it("history in front, the delivery instruction behind", async () => {
    const { gw, session, writer, asked } = await harness({ sessionId: "s-1", systemSent: false });
    await performSend(session, bodyFor("bonjour"), writer, null, "/media/outbound");
    const message = sentMessage(gw) ?? "";
    expect(asked).toHaveLength(1);
    expect(message.startsWith("[history] Bob: earlier turn\n\nbonjour")).toBe(true);
    expect(message).toContain("[LIVRAISON]");
    expect(session.firstSendPending).toBe(false);
  });

  it("a message OPENING with a path keeps its history and its delivery instruction", async () => {
    const { gw, session, writer, asked } = await harness({ sessionId: "s-1", systemSent: false });
    const text = "/tmp/x.txt regarde ce fichier";
    await performSend(session, bodyFor(text), writer, null, "/media/outbound");
    const message = sentMessage(gw) ?? "";
    expect(asked).toHaveLength(1);
    expect(message.startsWith(`[history] Bob: earlier turn\n\n${text}`)).toBe(true);
    expect(message).toContain("[LIVRAISON]");
  });

  it("a path in the middle of a sentence is not a command", async () => {
    const { gw, session, writer } = await harness({ sessionId: "s-1", systemSent: true });
    await performSend(session, bodyFor("lis /tmp/x.txt"), writer, null, "/media/outbound");
    expect(sentMessage(gw)).toContain("[LIVRAISON]");
  });
});

describe("Hermes: a command is not put behind history either", () => {
  it("a fresh session sends the command bare", async () => {
    let asked = 0;
    const w = {
      getRehydrationContext: async () => {
        asked += 1;
        return { history: "[history]", turnCount: 1 };
      },
    } as unknown as ConvexWriter;
    const body = {
      chatId: "c1",
      agentId: "h",
      instanceName: "hermes",
      canonical: "olivier",
      openclawChatId: null,
      messageId: "um-1",
    };
    expect(
      await promptWithFreshSessionHistory(w, { ...body, text: "/new" } as never, true),
    ).toBe("/new");
    expect(asked).toBe(0);
    expect(
      await promptWithFreshSessionHistory(w, { ...body, text: "salut" } as never, true),
    ).toBe("[history]\n\nsalut");
    // A message opening with a path is not a command: the history goes in front of it.
    expect(
      await promptWithFreshSessionHistory(w, { ...body, text: "/tmp/a.md lis-le" } as never, true),
    ).toBe("[history]\n\n/tmp/a.md lis-le");
  });
});
