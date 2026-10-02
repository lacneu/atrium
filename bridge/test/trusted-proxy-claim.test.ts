/**
 * The trusted-proxy ownership CLAIM creates the conversation's gateway session and
 * says so (`claimCreatedSession`), which makes that first turn "fresh" and
 * re-hydrates the thread into the brand-new session. That verdict belongs to ONE
 * send. Left set on the socket, every later turn read as fresh and re-prepended the
 * whole thread — measured live on the trusted-proxy bench (2026-09-25).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { performPatch, performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
  openclawAuthMode: "trusted-proxy",
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
} as unknown as Parameters<typeof performSend>[1];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the claim's 'created' verdict is one send's", () => {
  it("is consumed by the send that carried it", async () => {
    // The probe finds NO session (so the claim creates it), then the session exists.
    const gw = fakeGateway({
      describe: [
        null,
        { sessionId: "s-1", systemSent: true, contextTokens: 200_000 },
      ],
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
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
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      emitRehydrateTrace: (t: Record<string, unknown>) => {
        traces.push(t);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);

    await performSend(session, body, writer, null, null, null, Date.now(), config);

    const conn = session.connection as unknown as FakeGateway & {
      claimCreatedSession: boolean;
    };
    expect(conn.countOf("sessions.create")).toBe(1);
    // The first turn WAS fresh — the claim created the session…
    expect(traces[0]?.freshSession).toBe(true);
    // …and that verdict does not outlive it.
    expect(conn.claimCreatedSession).toBe(false);
  });
});

describe("an unproven claim does not mark the socket as the owner's", () => {
  it("neither seen nor created: the socket stays unclaimed (a participant may not send)", async () => {
    // No session seen (describe answers none), and the create is refused.
    const gw = fakeGateway({
      answers: {
        "sessions.create": { throws: new Error("UNAVAILABLE: busy") },
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
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
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, writer, null, null, null, Date.now(), config).catch(() => {});
    const conn = session.connection as unknown as { sessionClaimed?: boolean };
    expect(conn.sessionClaimed).not.toBe(true);
  });
});

describe("a session pruned after the claim", () => {
  it("drops the proof: the participant's turn goes out from the owner's socket", async () => {
    // The socket claimed long ago; the gateway has since pruned the session.
    const gw = fakeGateway({ describe: [null] });
    (gw as unknown as { sessionClaimed: boolean }).sessionClaimed = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
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
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const acquire = vi.fn();
    await performSend(
      session,
      { ...body, speakerGatewayUser: "bob" } as typeof body,
      writer,
      null,
      null,
      null,
      Date.now(),
      config,
      { acquire, route: () => true, unroute: () => {}, abandon: () => {} },
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(gw.countOf("chat.send")).toBe(1);
  });
});

describe("a claim is proven by the gateway naming its creator, not by existence", () => {
  const human = (id: string) => ({
    type: "human",
    id,
    identity: { type: "profile", id },
    label: id,
  });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
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

  async function claimedAfterOneSend(gw: FakeGateway): Promise<boolean | undefined> {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, writer, null, null, null, Date.now(), config).catch(() => {});
    return (session.connection as unknown as { sessionClaimed?: boolean }).sessionClaimed;
  }

  it("a session someone else created is not the owner's, however visible", async () => {
    // A participant spoke first into this key (or the system created it): the owner
    // socket describes it fine — and must still not let participants send.
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", createdActor: human("p-bob") }],
      answers: self,
    });
    expect(await claimedAfterOneSend(gw)).not.toBe(true);
  });

  it("a session this socket's profile created is proven", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", createdActor: human("p-owner") }],
      answers: self,
    });
    expect(await claimedAfterOneSend(gw)).toBe(true);
  });

  it("a fresh key: proven by reading the creator back after the create", async () => {
    const gw = fakeGateway({
      describe: [null, { sessionId: "s-1", createdActor: human("p-owner") }],
      answers: self,
    });
    expect(await claimedAfterOneSend(gw)).toBe(true);
  });

  it("a create that answered on another profile's session does not pour the thread into it", async () => {
    // The probe saw nothing (hidden), the create answered, the read-back names bob.
    const gw = fakeGateway({
      describe: [null, { sessionId: "s-1", createdActor: human("p-bob") }],
      answers: self,
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
    const w = {
      ...(writer as unknown as Record<string, unknown>),
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.freshSession).toBe(false);
  });

  it("a known other creator and an unreadable own profile: no history poured in", async () => {
    const gw = fakeGateway({
      describe: [null, { sessionId: "s-1", createdActor: human("p-bob") }],
      answers: { "users.self": { throws: new Error("FORBIDDEN") } },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
    const w = {
      ...(writer as unknown as Record<string, unknown>),
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.freshSession).toBe(false);
  });

  it("a create that answers but a session still unseen: unproven", async () => {
    // describe null can mean "hidden from this socket": the create then succeeds on
    // somebody else's session without making it ours.
    const gw = fakeGateway({
      describe: [null, null, { sessionId: "s-1", createdActor: human("p-bob") }],
      answers: self,
    });
    expect(await claimedAfterOneSend(gw)).not.toBe(true);
  });

  it("an unreadable own profile leaves the claim unproven", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", createdActor: human("p-owner") }],
      answers: { "users.self": { throws: new Error("FORBIDDEN") } },
    });
    expect(await claimedAfterOneSend(gw)).not.toBe(true);
  });
});

describe("the claim's probe has three states", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const writerWith = (traces: Record<string, unknown>[]) =>
    ({
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
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    }) as unknown as ConvexWriter;

  it("a probe that fails once is asked again — a session it then finds absent and creates is fresh", async () => {
    const gw = fakeGateway({
      describeFailures: 1,
      describe: [null, { sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
    const w = writerWith(traces);
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(gw.countOf("sessions.create")).toBe(1);
    // Created by this claim: the first turn re-hydrates, even though the new
    // session reads systemSent.
    expect(traces[0]?.freshSession).toBe(true);
  });

  it("a probe that stays unknown creates nothing and claims nothing", async () => {
    const gw = fakeGateway({ describeFailures: 2, describe: [null], answers: self });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
    const w = writerWith(traces);
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(gw.countOf("sessions.create")).toBe(0);
    expect((session.connection as unknown as { sessionClaimed?: boolean }).sessionClaimed).not.toBe(true);
  });
});

describe("a create whose outcome was not confirmed", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const run = async (gw: FakeGateway) => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
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
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    return { traces, conn: session.connection as unknown as { sessionClaimed?: boolean } };
  };

  it("an unanswered create that landed: the read-back names us — fresh and claimed", async () => {
    const gw = fakeGateway({
      describe: [null, { sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: { ...self, "sessions.create": { throws: new Error("timeout") } },
    });
    const { traces, conn } = await run(gw);
    // The read-back ran although the create never answered…
    expect(gw.countOf("sessions.describe")).toBeGreaterThanOrEqual(3);
    // …and the new session, systemSent and all, gets the thread.
    expect(traces[0]?.freshSession).toBe(true);
    expect(conn.sessionClaimed).toBe(true);
  });

  it("a read-back that fails: the send's own describe settles it", async () => {
    const gw = fakeGateway({
      // Probe (0) absent; read-back (1) fails; the send's describe (2) sees the
      // session this socket's profile created.
      describeFailAt: [1],
      describe: [null, { sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    const { traces, conn } = await run(gw);
    expect(traces[0]?.freshSession).toBe(true);
    expect(conn.sessionClaimed).toBe(true);
  });

  it("…but a session another profile created stays warm and unclaimed", async () => {
    const gw = fakeGateway({
      describeFailAt: [1],
      describe: [null, { sessionId: "s-1", systemSent: true, createdActor: human("p-other") }],
      answers: self,
    });
    const { traces, conn } = await run(gw);
    expect(traces[0]?.freshSession).toBe(false);
    expect(conn.sessionClaimed).not.toBe(true);
  });
});

describe("no administrative write reaches a session whose existence is not established", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const settingsBody = {
    ...body,
    sessionSettings: { thinkingLevel: "high" },
  } as unknown as Parameters<typeof performSend>[1];
  const patchesBeforeSend = async (gw: FakeGateway) => {
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
    await performSend(session, settingsBody, w, null, null, null, Date.now(), config).catch(
      () => {},
    );
    const sendAt = gw.calls.findIndex(([m]) => m === "chat.send");
    const upTo = sendAt === -1 ? gw.calls : gw.calls.slice(0, sendAt);
    return upTo.filter(([m]) => m === "sessions.patch").length;
  };

  it("a probe that stays unknown: no patch before the owner's send", async () => {
    const gw = fakeGateway({ describeFailures: 2, describe: [null], answers: self });
    expect(await patchesBeforeSend(gw)).toBe(0);
  });

  it("absent, the create unconfirmed and the read-back still empty: no patch", async () => {
    const gw = fakeGateway({
      describe: [null],
      answers: { ...self, "sessions.create": { throws: new Error("timeout") } },
    });
    expect(await patchesBeforeSend(gw)).toBe(0);
  });

  it("control: a session that exists gets its knobs before the send", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    expect(await patchesBeforeSend(gw)).toBeGreaterThan(0);
  });
});

describe("a knob set before the first message does not create the session", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const patchCalls = async (gw: FakeGateway) => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = {
      reportSessionMeta: async () => {},
      clearSessionState: async () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performPatch(
      session,
      {
        ...ROUTING,
        sessionSettings: { thinkingLevel: "high", model: null },
      } as unknown as Parameters<typeof performPatch>[1],
      w,
      config,
    ).catch(() => {});
    return gw.countOf("sessions.patch");
  };

  it("existence unknown: no patch", async () => {
    const gw = fakeGateway({ describeFailures: 2, describe: [null], answers: self });
    expect(await patchCalls(gw)).toBe(0);
  });

  it("control: an existing session is patched", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    expect(await patchCalls(gw)).toBeGreaterThan(0);
  });
});

describe("a claim proven once is asked again before anything writes", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const run = async (gw: FakeGateway) => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
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
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    // Claimed on an earlier turn, and the gateway pruned the session since.
    (session.connection as unknown as { sessionClaimed: boolean }).sessionClaimed = true;
    await performSend(
      session,
      { ...body, sessionSettings: { thinkingLevel: "high" } } as unknown as Parameters<
        typeof performSend
      >[1],
      w,
      null,
      null,
      null,
      Date.now(),
      config,
    ).catch(() => {});
    return traces;
  };

  it("pruned since: no admin patch before the owner re-creates it, and the turn re-hydrates", async () => {
    const gw = fakeGateway({
      // re-check (absent), the claim's probe (absent), then the created session.
      describe: [null, null, { sessionId: "s-2", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    const traces = await run(gw);
    const createAt = gw.calls.findIndex(([m]) => m === "sessions.create");
    expect(createAt).toBeGreaterThan(-1);
    expect(gw.calls.slice(0, createAt).some(([m]) => m === "sessions.patch")).toBe(false);
    expect(traces[0]?.freshSession).toBe(true);
  });

  it("the re-check fails: nothing administrative this time", async () => {
    const gw = fakeGateway({
      describeFailures: 1,
      describe: [{ sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    await run(gw);
    const sendAt = gw.calls.findIndex(([m]) => m === "chat.send");
    const upTo = sendAt === -1 ? gw.calls : gw.calls.slice(0, sendAt);
    expect(upTo.some(([m]) => m === "sessions.patch")).toBe(false);
  });
});

describe("a first send that failed keeps the claim's 'created' verdict for its retry", () => {
  const mk = () => {
    const traces: Record<string, unknown>[] = [];
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
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    return { traces, w };
  };

  it("created (no creator shown, own profile unreadable), send refused, retried: still fresh", async () => {
    const gw = fakeGateway({
      // The probe sees nothing; the created session reads systemSent with no creator.
      describe: [null, { sessionId: "s-1", systemSent: true }],
      answers: { "users.self": { throws: new Error("UNAVAILABLE") } },
      sequences: {
        "chat.send": [{ throws: new Error("UNAVAILABLE: busy") }, { payload: { runId: "r-2" } }],
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const { traces, w } = mk();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    await performSend(
      session,
      { ...body, clientMessageId: "cm-1" } as unknown as Parameters<typeof performSend>[1],
      w,
      null,
      null,
      null,
      Date.now(),
      config,
    ).catch(() => {});
    expect(traces[0]?.freshSession).toBe(true);
    expect(traces[1]?.freshSession).toBe(true);
  });

  it("…but not onto a session another profile created meanwhile", async () => {
    const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
    const gw = fakeGateway({
      describe: [null, { sessionId: "s-1", systemSent: true }, { sessionId: "s-1", systemSent: true }, { sessionId: "s-9", systemSent: true, createdActor: human("p-other") }],
      answers: { "users.self": { payload: { profile: { id: "p-owner" } } } },
      sequences: {
        "chat.send": [{ throws: new Error("UNAVAILABLE: busy") }, { payload: { runId: "r-2" } }],
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const { traces, w } = mk();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(traces.at(-1)?.freshSession).toBe(false);
  });
});

describe("verboseLevel goes with the session it was applied to", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
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
  const verboseBeforeSend = (gw: FakeGateway) => {
    const sendAt = gw.calls.findIndex(([m]) => m === "chat.send");
    const upTo = sendAt === -1 ? gw.calls : gw.calls.slice(0, sendAt);
    return upTo.some(([m, p]) => m === "sessions.patch" && p.verboseLevel === "full");
  };

  it("trusted-proxy: claimed and verbose once, pruned since — re-created by the owner, verbose again", async () => {
    const gw = fakeGateway({
      describe: [null, null, { sessionId: "s-2", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const conn = session.connection as unknown as { sessionClaimed: boolean; verboseFullApplied: boolean };
    conn.sessionClaimed = true;
    conn.verboseFullApplied = true;
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    expect(verboseBeforeSend(gw)).toBe(true);
  });

  it("token mode: a session found gone is given verbose again before the send", async () => {
    const tokenConfig = { ...config, openclawAuthMode: "token" } as unknown as BridgeConfig;
    const gw = fakeGateway({ describe: [null] });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const reg = new SessionRegistry(servedMap(tokenConfig, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    (session.connection as unknown as { verboseFullApplied: boolean }).verboseFullApplied = true;
    await performSend(session, body, w, null, null, null, Date.now(), tokenConfig).catch(() => {});
    expect(verboseBeforeSend(gw)).toBe(true);
  });
});

describe("a claimed session replaced under its key is not ours any more", () => {
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
  const run = async (gw: FakeGateway) => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const traces: Record<string, unknown>[] = [];
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
      emitRehydrateTrace: (tr: Record<string, unknown>) => {
        traces.push(tr);
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const conn = session.connection as unknown as {
      sessionClaimed: boolean;
      verboseFullApplied: boolean;
    };
    // Claimed on an earlier turn: session s-1, created by this socket's profile.
    conn.sessionClaimed = true;
    conn.verboseFullApplied = true;
    await performSend(session, body, w, null, null, null, Date.now(), config).catch(() => {});
    return { traces, conn };
  };

  it("re-created by a participant: proof dropped, the thread re-hydrated", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-2", systemSent: true, createdActor: human("p-guest") }],
      answers: self,
    });
    const { traces, conn } = await run(gw);
    expect(conn.sessionClaimed).toBe(false);
    expect(traces[0]?.freshSession).toBe(true);
  });

  it("compacted since (the id rotated, the creator did not): still ours, warm, no re-hydration", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-2", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    const { traces, conn } = await run(gw);
    expect(conn.sessionClaimed).toBe(true);
    expect(traces[0]?.freshSession).toBe(false);
  });

  it("re-created with no creator shown: not the session this socket proved", async () => {
    const gw = fakeGateway({ describe: [{ sessionId: "s-3", systemSent: true }], answers: self });
    const { traces, conn } = await run(gw);
    expect(conn.sessionClaimed).toBe(false);
    expect(traces[0]?.freshSession).toBe(true);
  });

  it("control: the same session, still ours, stays claimed and warm", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", systemSent: true, createdActor: human("p-owner") }],
      answers: self,
    });
    const { traces, conn } = await run(gw);
    expect(conn.sessionClaimed).toBe(true);
    expect(traces[0]?.freshSession).toBe(false);
  });
});

describe("a participant's socket declares what the conversation's socket ACTUALLY holds", () => {
  // A widget switch deferred by a live call keeps the conversation socket — and its
  // normalizer — on the old declaration. The participant's socket must follow THAT,
  // not the body's wish: otherwise the gateway answers with widgets the receiving
  // normalizer drops, and a widget-only answer is lost (codex pass 4).
  const human = (id: string) => ({ type: "human", id, identity: { type: "profile", id }, label: id });
  const self = { "users.self": { payload: { profile: { id: "p-owner" } } } };
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

  for (const [kept, wish] of [
    [false, true],
    [true, false],
  ] as const) {
    it(`kept socket widgets=${kept}, body wish=${wish}: the participant's socket is asked with widgets=${kept}`, async () => {
      const gw = fakeGateway({
        describe: [{ sessionId: "s-1", createdActor: human("p-owner") }],
        answers: self,
      });
      (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
      vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
      const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
      const session = await reg.acquire(ROUTING);
      await sleep(5);
      // The conversation's socket as it actually stands after a deferred switch.
      session.runManager.setWidgetsEnabled(kept);
      const bob = fakeGateway({ answers: self });
      const acquire = vi.fn(async () => bob as never);
      await performSend(
        session,
        { ...body, speakerGatewayUser: "bob", inlineWidgets: wish } as typeof body,
        writer,
        null,
        null,
        null,
        Date.now(),
        config,
        { acquire, route: () => true, unroute: () => {}, abandon: () => {} },
      ).catch(() => {});
      expect(acquire).toHaveBeenCalledWith(config, "bob", { inlineWidgets: kept });
    });
  }
});
