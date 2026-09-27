/**
 * Who may act on a session, and with what permissions — read from the describe Atrium
 * already makes, SHOWN, never enforced here (providers/openclaw/session-access.ts).
 * Plus the one guard Atrium does send: the permission mode the reader saw.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeOpenClawAgent, parseSendBody, performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import {
  readSessionAccess,
  readSessionSharingKey,
} from "../src/providers/openclaw/session-access.js";
import { attachSharingRefresh } from "../src/providers/openclaw/models-roster.js";
import { fakeGateway, modelsConnSpy } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readSessionAccess — the row as materializeSessionRow projects it (2026.9.6)", () => {
  it("reads visibility, the reader's role, the mode, its pending flag and root", () => {
    expect(
      readSessionAccess({
        visibility: "read-only",
        sharingRole: "member",
        permissionMode: "guarded",
        permissionModePending: true,
        sessionRoot: "/work",
      }),
    ).toEqual({
      visibility: "read-only",
      sharingRole: "member",
      permissionMode: "guarded",
      permissionModePending: true,
      sessionRoot: "/work",
    });
  });

  it("a row that projects permissions but sets no mode: `null` (a default applies)", () => {
    expect(readSessionAccess({ visibility: "shared", permissionModePending: false })).toEqual({
      visibility: "shared",
      permissionMode: null,
      permissionModePending: false,
    });
  });

  it("a row that projects nothing of it: nothing reported, never `null`", () => {
    expect(readSessionAccess({ model: "m" })).toEqual({});
  });

  it("a value outside the vendored enums is dropped, not passed on as a mode", () => {
    expect(
      readSessionAccess({ visibility: "secret", sharingRole: "god", permissionMode: "yolo" }),
    ).toEqual({});
  });
});

describe("readSessionSharingKey", () => {
  it("names the session of either sharing notice, and nothing else", () => {
    const ev = (event: string, payload: unknown) => ({ type: "event", event, payload });
    expect(readSessionSharingKey(ev("session.sharing", { sessionKey: "k", action: "visibility" }))).toBe("k");
    expect(readSessionSharingKey(ev("session.sharing.evidence", { sessionKey: "k" }))).toBe("k");
    expect(readSessionSharingKey(ev("sessions.changed", { sessionKey: "k" }))).toBeNull();
    expect(readSessionSharingKey(ev("session.sharing", {}))).toBeNull();
    expect(readSessionSharingKey({ type: "res", event: "session.sharing" })).toBeNull();
  });
});

describe("a sharing notice for THIS session re-describes and publishes it", () => {
  it("its own key: one publish carrying the new visibility; another key: nothing", async () => {
    const { conn } = modelsConnSpy((method) =>
      method === "sessions.describe"
        ? { session: { key: "k", visibility: "draft", permissionModePending: false } }
        : { models: [] },
    );
    const metas: Record<string, unknown>[] = [];
    const writer = {
      reportSessionMeta: async (_chatId: string, meta: Record<string, unknown>) => {
        metas.push(meta);
      },
      reportSessionRoster: async () => {},
    } as unknown as Parameters<typeof attachSharingRefresh>[1];
    const policy = attachSharingRefresh(
      { connection: conn as never, sessionKey: "k", chatId: "c1", agentId: "alice" },
      writer,
    );
    (conn as unknown as { emitSessionSharing(k: string): void }).emitSessionSharing("other");
    await sleep(5);
    expect(metas).toEqual([]);
    (conn as unknown as { emitSessionSharing(k: string): void }).emitSessionSharing("k");
    await sleep(5);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ visibility: "draft", permissionMode: null });
    policy.dispose();
  });
});

describe("the agent's default mode, as agents.list states it", () => {
  it("kept when stated, null when upstream omits it (sandbox, non-canonical policy)", () => {
    expect(normalizeOpenClawAgent({ id: "a", defaultPermissionMode: "full" })?.defaultPermissionMode).toBe("full");
    expect(normalizeOpenClawAgent({ id: "a" })?.defaultPermissionMode).toBeNull();
    expect(normalizeOpenClawAgent({ id: "a", defaultPermissionMode: "odd" })?.defaultPermissionMode).toBeNull();
  });
});

describe("chat.send carries the permission mode the reader saw", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "primary",
  } as unknown as BridgeConfig;
  const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "olivier", instanceName: "primary" };
  const body = (extra: Record<string, unknown>) =>
    ({
      ...ROUTING,
      text: "bonjour",
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
      ...extra,
    }) as unknown as Parameters<typeof performSend>[1];
  const sent = async (version: string, extra: Record<string, unknown>) => {
    const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }] });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = version;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
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
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      emitRehydrateTrace: () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body(extra), w, null, null, null, Date.now(), config).catch(() => {});
    const call = gw.calls.find(([m]) => m === "chat.send");
    return call?.[1] as Record<string, unknown> | undefined;
  };

  it("the mode shown, or null for 'none set', rides the send", async () => {
    expect((await sent("2026.9.6", { expectedPermissionMode: "guarded" }))?.expectedPermissionMode).toBe("guarded");
    const params = await sent("2026.9.6", { expectedPermissionMode: null });
    expect(params && "expectedPermissionMode" in params).toBe(true);
    expect(params?.expectedPermissionMode).toBeNull();
  });

  it("nothing known, nothing sent: no guard", async () => {
    const params = await sent("2026.9.6", {});
    expect(params && "expectedPermissionMode" in params).toBe(false);
  });

  it("never to a gateway whose closed params object does not know the field", async () => {
    const params = await sent("2026.8.1", { expectedPermissionMode: "guarded" });
    expect(params).toBeDefined();
    expect("expectedPermissionMode" in params!).toBe(false);
  });
});

describe("the send body's guard is parsed strictly", () => {
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({
      chatId: "c1",
      text: "x",
      clientMessageId: "cm",
      agentId: "alice",
      canonical: "olivier",
      ...extra,
    });
  it("a mode, or null, is kept; anything else means no guard", () => {
    expect(parseSendBody(raw({ expectedPermissionMode: "workspace" }))?.expectedPermissionMode).toBe("workspace");
    const nulled = parseSendBody(raw({ expectedPermissionMode: null }));
    expect(nulled !== null && "expectedPermissionMode" in nulled && nulled.expectedPermissionMode === null).toBe(true);
    const odd = parseSendBody(raw({ expectedPermissionMode: "sudo" }));
    expect(odd !== null && "expectedPermissionMode" in odd).toBe(false);
    const none = parseSendBody(raw({}));
    expect(none !== null && "expectedPermissionMode" in none).toBe(false);
  });
});

// Codex pass 4 (2026-09-26), P2 — a session gone from under the key. The gateway STATES
// it (`{ session: null }`); the session this send creates holds no mode. The guard in
// flight was read before, from the gone session: sent as is, the gateway refuses the
// person's turn for a change they never made. Only a DEFINITE absence counts — a failed
// or unreadable describe changes nothing.
describe("a session absent under the key: no stale guard, and the meta says so", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "primary",
  } as unknown as BridgeConfig;
  const ROUTING = { chatId: "c1", openclawChatId: null, agentId: "alice", canonical: "olivier", instanceName: "primary" };
  const run = async (opts: {
    version?: string;
    describe: Array<Record<string, unknown> | null>;
    absentAsNull?: boolean;
    describeFails?: boolean;
    omitGuard?: boolean;
  }) => {
    const gw = fakeGateway({
      describe: opts.describe as never,
      ...(opts.absentAsNull ? { describeAbsentAsNull: true } : {}),
      ...(opts.describeFails ? { describeFailures: 5 } : {}),
    });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = opts.version ?? "2026.9.6";
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const reports: Array<Record<string, unknown>> = [];
    const w = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async (_chatId: string, meta: Record<string, unknown>) => {
        reports.push(meta);
      },
      reportSessionRoster: async () => {},
      recordGatewayPressure: async () => {},
      clearSessionState: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      emitRehydrateTrace: () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(
      session,
      {
        ...ROUTING,
        text: "bonjour",
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
        // The guard read in Convex before this send: the gone session's mode.
        ...(opts.omitGuard ? {} : { expectedPermissionMode: "guarded" }),
      } as unknown as Parameters<typeof performSend>[1],
      w,
      null,
      null,
      null,
      Date.now(),
      config,
    ).catch(() => {});
    await sleep(5);
    const send = gw.calls.find(([m]) => m === "chat.send")?.[1] as Record<string, unknown> | undefined;
    return { send, access: reports.filter((m) => "permissionMode" in m) };
  };

  it("stated absent: this send's guard is `null`, and the meta reports the mode `null`, stamped", async () => {
    const { send, access } = await run({ describe: [null], absentAsNull: true });
    expect(send && "expectedPermissionMode" in send).toBe(true);
    expect(send?.expectedPermissionMode).toBeNull();
    expect(access).toHaveLength(1);
    expect(access[0]!.permissionMode).toBeNull();
    expect(typeof access[0]!.observedAt).toBe("number");
  });

  it("no guard in the body stays no guard", async () => {
    const { send } = await run({ describe: [null], absentAsNull: true, omitGuard: true });
    expect(send).toBeDefined();
    expect("expectedPermissionMode" in send!).toBe(false);
  });

  it("an unreadable answer is not evidence: the guard goes as read, nothing is reported", async () => {
    const { send, access } = await run({ describe: [null] });
    expect(send?.expectedPermissionMode).toBe("guarded");
    expect(access).toEqual([]);
  });

  it("a failed describe is not evidence either", async () => {
    const { send, access } = await run({ describe: [null], absentAsNull: true, describeFails: true });
    expect(send?.expectedPermissionMode).toBe("guarded");
    expect(access).toEqual([]);
  });

  it("a session that exists: its own mode is reported, the guard goes as read", async () => {
    const { send, access } = await run({
      describe: [{ sessionId: "s-1", systemSent: true, permissionMode: "workspace", permissionModePending: false }],
    });
    expect(send?.expectedPermissionMode).toBe("guarded");
    expect(access.map((m) => m.permissionMode)).toEqual(["workspace"]);
  });

  it("a gateway with no modes: nothing reported, no guard sent", async () => {
    const { send, access } = await run({ version: "2026.8.1", describe: [null], absentAsNull: true });
    expect(send && "expectedPermissionMode" in send).toBe(false);
    expect(access).toEqual([]);
  });
});
