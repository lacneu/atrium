/**
 * In a room of several agents, each agent must get what the others said — named —
 * and a history too long for its window is CUT, never dropped whole.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter, RehydrationRequest } from "../src/convex-writer.js";
import {
  composedPromptFits,
  historyCharsThatFit,
} from "../src/core/context-budget.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import {
  promptWithFreshSessionHistory,
  type HermesSendBody,
} from "../src/providers/hermes/dispatch.js";
import { fakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("historyCharsThatFit — composedPromptFits solved for the history", () => {
  it("the size it returns fits; one character more does not", () => {
    for (const windowTokens of [1_000, 8_192, 200_000]) {
      const userChars = 321;
      const room = historyCharsThatFit({ userChars, separatorChars: 2, windowTokens })!;
      expect(composedPromptFits({ historyChars: room, userChars, separatorChars: 2, windowTokens })).toBe(true);
      expect(
        composedPromptFits({ historyChars: room + 3, userChars, separatorChars: 2, windowTokens }),
      ).toBe(false);
    }
    expect(historyCharsThatFit({ userChars: 1, separatorChars: 2, windowTokens: null })).toBeNull();
  });
});

describe("OpenClaw: the history is asked FOR the agent, and cut to fit rather than dropped", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "a",
  } as unknown as BridgeConfig;
  const ROUTING = { chatId: "c1", openclawChatId: "turn:x", agentId: "bob", canonical: "olivier", instanceName: "b" };
  const body = {
    ...ROUTING,
    text: "et toi ?",
    clientMessageId: "cm-1",
    messageId: "um-1",
    providerResetCount: null,
    outboxId: "ob-1",
    dispatchAgeMs: 0,
    switchedFromAgentId: null,
    switchedFromInstanceName: null,
    sessionSettings: null,
    referenceAttachments: [],
    config: { rehydration: true, routedSwitch: true },
  } as unknown as Parameters<typeof performSend>[1];

  it("a history over the new session's window comes back shorter, and is sent", async () => {
    // A fresh session with a SMALL window: 1000 tokens → about 830 characters in all.
    const gw = fakeGateway({ describe: [{ sessionId: "s", systemSent: false, contextTokens: 1_000 }] });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const asked: RehydrationRequest[] = [];
    const w = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      recordGatewayPressure: async () => {},
      clearSessionState: async () => {},
      getRehydrationContext: async (_c: string, _m: string | null, opts: RehydrationRequest = {}) => {
        asked.push(opts);
        return opts.maxChars === undefined
          ? { history: "H".repeat(5_000), turnCount: 9 }
          : { history: "short history", turnCount: 2 };
      },
      emitRehydrateTrace: () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(asked[0]?.forAgent).toEqual({ instanceName: "b", agentId: "bob" });
    expect(asked[1]?.maxChars).toBeGreaterThan(0);
    expect(asked[1]?.maxChars).toBeLessThan(900);
    const sent = gw.calls.find(([m]) => m === "chat.send")?.[1] as { message?: string } | undefined;
    expect(sent?.message).toBe("short history\n\net toi ?");
  });
});

describe("Hermes: a warm session is told what the other agents said since its last reply", () => {
  const base = {
    chatId: "c1",
    agentId: "hermes-agent",
    instanceName: "hermes",
    canonical: "olivier",
    openclawChatId: null,
    text: "ton avis ?",
    messageId: "um-9",
  } as HermesSendBody;
  const writerWith = (answer: { history: string | null; turnCount: number; sinceFound?: boolean }) => {
    const asked: RehydrationRequest[] = [];
    const w = {
      getRehydrationContext: async (_c: string, _m: string | null, opts: RehydrationRequest = {}) => {
        asked.push(opts);
        return answer;
      },
    } as unknown as ConvexWriter;
    return { w, asked };
  };

  it("warm, another agent spoke: only what it missed is carried, named for it", async () => {
    const { w, asked } = writerWith({ history: "[depuis] Alice: 42", turnCount: 1, sinceFound: true });
    const text = await promptWithFreshSessionHistory(
      w,
      { ...base, config: { routedSwitch: true } },
      false,
    );
    expect(text).toBe("[depuis] Alice: 42\n\nton avis ?");
    expect(asked[0]).toEqual({
      forAgent: { instanceName: "hermes", agentId: "hermes-agent" },
      sinceLastReplyOf: { instanceName: "hermes", agentId: "hermes-agent" },
    });
  });

  it("warm, same agent again: nothing asked, nothing carried", async () => {
    const { w, asked } = writerWith({ history: "x", turnCount: 1, sinceFound: true });
    expect(await promptWithFreshSessionHistory(w, { ...base, config: {} }, false)).toBe("ton avis ?");
    expect(asked).toEqual([]);
  });

  it("warm, but its last reply was not found: the whole thread is NOT poured into the session", async () => {
    const { w } = writerWith({ history: "tout le fil", turnCount: 12, sinceFound: false });
    expect(
      await promptWithFreshSessionHistory(w, { ...base, config: { routedSwitch: true } }, false),
    ).toBe("ton avis ?");
  });

  it("fresh: the history is asked FOR this agent", async () => {
    const { w, asked } = writerWith({ history: "fil", turnCount: 3 });
    expect(await promptWithFreshSessionHistory(w, { ...base, config: {} }, true)).toBe("fil\n\nton avis ?");
    expect(asked[0]).toEqual({ forAgent: { instanceName: "hermes", agentId: "hermes-agent" } });
  });
});
