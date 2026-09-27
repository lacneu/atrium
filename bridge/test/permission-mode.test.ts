/**
 * The conversation owner's permission-mode CHOICE, applied to the gateway session
 * (providers/openclaw/permission-mode.ts): decided on the describe in hand, patched
 * before `chat.send`, held by the send guard, refused loudly — never a turn under a mode
 * nobody chose.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parsePermissionModeBody,
  parseSendBody,
  performPermissionModeChange,
  performSend,
} from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
} from "../src/providers/openclaw/openclaw-client.js";
import {
  PermissionModeNotAppliedError,
  classifyPermissionPatchError,
  enforcePermissionMode,
} from "../src/providers/openclaw/permission-mode.js";
import { classifyGatewayError, faultDomain } from "../src/core/dispatch-errors.js";
import { COMPAT_MANIFEST } from "../src/compat.js";
import { fakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const answered = (text: string) => new GatewayAnsweredError(text);

describe("enforcePermissionMode — the decision", () => {
  const base = {
    fullAuthorized: false,
    gatewayVersion: "2026.9.6",
    sessionKey: "k",
    sessionAbsent: false,
    sessionConfirmed: true,
    mayCreateSession: true,
  };
  const patcher = () => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      patch: async (p: Record<string, unknown>) => {
        calls.push(p);
        return {};
      },
    };
  };

  it("a session already holding the choice costs nothing", async () => {
    const p = patcher();
    const out = await enforcePermissionMode({ ...base, ...p, choice: "guarded", described: "guarded" });
    expect(out).toEqual({ mode: "guarded", patched: false });
    expect(p.calls).toEqual([]);
  });

  it("a different mode is patched; 'default' patches null (clears the override)", async () => {
    const p = patcher();
    expect(await enforcePermissionMode({ ...base, ...p, choice: "read-only", described: null })).toEqual({
      mode: "read-only",
      patched: true,
    });
    expect(await enforcePermissionMode({ ...base, ...p, choice: "default", described: "workspace" })).toEqual({
      mode: null,
      patched: true,
    });
    expect(p.calls).toEqual([
      { key: "k", permissionMode: "read-only" },
      { key: "k", permissionMode: null },
    ]);
  });

  it("an unknown current mode is patched (idempotent upstream)", async () => {
    const p = patcher();
    await enforcePermissionMode({ ...base, ...p, choice: "workspace", described: undefined });
    expect(p.calls).toEqual([{ key: "k", permissionMode: "workspace" }]);
  });

  it("full without Convex's authorization is refused and never sent", async () => {
    const p = patcher();
    await expect(
      enforcePermissionMode({ ...base, ...p, choice: "full", described: null }),
    ).rejects.toMatchObject({ reason: "full_not_authorized" });
    expect(p.calls).toEqual([]);
    const ok = await enforcePermissionMode({ ...base, ...p, fullAuthorized: true, choice: "full", described: null });
    expect(ok).toEqual({ mode: "full", patched: true });
  });

  it("a gateway without modes: 'default' is already true, anything else cannot be honoured", async () => {
    const p = patcher();
    expect(
      await enforcePermissionMode({ ...base, ...p, gatewayVersion: "2026.8.1", choice: "default", described: undefined }),
    ).toEqual({ mode: null, patched: false });
    await expect(
      enforcePermissionMode({ ...base, ...p, gatewayVersion: "2026.8.1", choice: "guarded", described: undefined }),
    ).rejects.toMatchObject({ reason: "unsupported_gateway" });
    await expect(
      enforcePermissionMode({ ...base, ...p, gatewayVersion: null, choice: "guarded", described: undefined }),
    ).rejects.toMatchObject({ reason: "unsupported_gateway" });
    expect(p.calls).toEqual([]);
  });

  it("no session yet: 'default' needs nothing; a mode is patched only where creating it is harmless", async () => {
    const p = patcher();
    expect(
      await enforcePermissionMode({ ...base, ...p, sessionAbsent: true, sessionConfirmed: false, choice: "default", described: null }),
    ).toEqual({ mode: null, patched: false });
    await expect(
      enforcePermissionMode({
        ...base,
        ...p,
        fullAuthorized: true,
        sessionAbsent: true,
        sessionConfirmed: false,
        mayCreateSession: false,
        choice: "full",
        described: null,
      }),
    ).rejects.toMatchObject({ reason: "session_not_established" });
    expect(p.calls).toEqual([]);
    await enforcePermissionMode({ ...base, ...p, sessionAbsent: true, sessionConfirmed: false, choice: "guarded", described: null });
    expect(p.calls).toEqual([{ key: "k", permissionMode: "guarded" }]);
  });

  // Codex pass 3 (2026-09-27): a FAILED describe left `sessionAbsent` false and the mode
  // unknown, and `full` was patched on the administrative socket into a key whose
  // session was never established — creating it under the bridge's identity.
  it("an undecidable read is no proof the session exists: where creating it would be harmful, nothing is patched", async () => {
    const p = patcher();
    await expect(
      enforcePermissionMode({
        ...base,
        ...p,
        fullAuthorized: true,
        sessionAbsent: false,
        sessionConfirmed: false,
        mayCreateSession: false,
        choice: "full",
        described: undefined,
      }),
    ).rejects.toMatchObject({ reason: "session_not_established" });
    expect(p.calls).toEqual([]);
    // Where creating it is harmless (the owner's own socket), the patch goes.
    await enforcePermissionMode({
      ...base,
      ...p,
      sessionAbsent: false,
      sessionConfirmed: false,
      mayCreateSession: true,
      choice: "guarded",
      described: undefined,
    });
    expect(p.calls).toEqual([{ key: "k", permissionMode: "guarded" }]);
  });

  it("a gateway refusal is named; a saved-but-not-applied answer is a save; no answer is rethrown as is", async () => {
    const refusing = (err: Error) => async () => {
      throw err;
    };
    await expect(
      enforcePermissionMode({
        ...base,
        fullAuthorized: true,
        choice: "full",
        described: null,
        patch: refusing(answered("FORBIDDEN: missing scope: operator.admin")),
      }),
    ).rejects.toMatchObject({ reason: "scope_refused" });
    await expect(
      enforcePermissionMode({
        ...base,
        choice: "guarded",
        described: null,
        patch: refusing(
          answered("INVALID_REQUEST: This run cannot apply permissions while active. Stop the run, then change permissions."),
        ),
      }),
    ).rejects.toMatchObject({ reason: "active_run" });
    await expect(
      enforcePermissionMode({ ...base, choice: "guarded", described: null, patch: refusing(answered("INVALID_REQUEST: nope")) }),
    ).rejects.toMatchObject({ reason: "rejected" });
    expect(
      await enforcePermissionMode({
        ...base,
        choice: "guarded",
        described: null,
        patch: refusing(
          answered(
            "UNAVAILABLE: Permissions were saved, but could not be applied to the active run. Stop the run and continue to use the saved permissions.",
          ),
        ),
      }),
    ).toEqual({ mode: "guarded", patched: true, savedNotApplied: true });
    const lost = new Error("sessions.patch timed out");
    await expect(
      enforcePermissionMode({ ...base, choice: "guarded", described: null, patch: refusing(lost) }),
    ).rejects.toBe(lost);
  });

  it("the upstream wordings, classified", () => {
    expect(classifyPermissionPatchError(new Error("FORBIDDEN: missing scope: operator.admin"))).toBe("scope_refused");
    expect(classifyPermissionPatchError(new Error("whatever"))).toBe("rejected");
  });
});

describe("the refusal is a dispatch code of its own, raised by the bridge", () => {
  it("classified by type, local fault domain", () => {
    const err = new PermissionModeNotAppliedError("scope_refused", "FORBIDDEN: missing scope: operator.admin");
    expect(classifyGatewayError(err)).toBe("permission_mode_not_applied");
    expect(faultDomain("permission_mode_not_applied")).toBe("local");
  });

  it("the capability is declared from 2026.8.2 on OpenClaw, never on Hermes", () => {
    expect(COMPAT_MANIFEST.providers.openclaw!.capabilities.permissionModes).toBe("2026.8.2");
    expect(COMPAT_MANIFEST.providers.hermes!.capabilities.permissionModes).toBeUndefined();
  });
});

describe("the send body carries the choice, strictly", () => {
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({ chatId: "c1", text: "x", clientMessageId: "cm", agentId: "alice", canonical: "olivier", ...extra });
  it("a choice in the vocabulary is kept; anything else means none", () => {
    expect(parseSendBody(raw({ permissionModeChoice: "default" }))?.permissionModeChoice).toBe("default");
    expect(parseSendBody(raw({ permissionModeChoice: "guarded" }))?.permissionModeChoice).toBe("guarded");
    const odd = parseSendBody(raw({ permissionModeChoice: "sudo" }));
    expect(odd !== null && "permissionModeChoice" in odd).toBe(false);
  });
  it("the full authorization and the managed flag are only ever a literal true", () => {
    expect(parseSendBody(raw({ permissionModesManaged: true }))?.permissionModesManaged).toBe(true);
    const managedOdd = parseSendBody(raw({ permissionModesManaged: 1 }));
    expect(managedOdd !== null && "permissionModesManaged" in managedOdd).toBe(false);
    expect(parseSendBody(raw({ permissionModeFullAuthorized: true }))?.permissionModeFullAuthorized).toBe(true);
    const truthy = parseSendBody(raw({ permissionModeFullAuthorized: "yes" }));
    expect(truthy !== null && "permissionModeFullAuthorized" in truthy).toBe(false);
  });
  it("/permission-mode refuses a body without a valid choice", () => {
    const pm = (extra: Record<string, unknown>) =>
      parsePermissionModeBody(JSON.stringify({ chatId: "c1", agentId: "alice", canonical: "olivier", instanceName: "primary", ...extra }));
    expect(pm({ choice: "workspace" })).toMatchObject({ choice: "workspace", fullAuthorized: false, managed: false });
    expect(pm({ choice: "workspace", managed: true })).toMatchObject({ managed: true });
    expect(pm({ choice: "full", fullAuthorized: true })).toMatchObject({ choice: "full", fullAuthorized: true });
    expect(pm({ choice: "root" })).toBeNull();
    expect(pm({})).toBeNull();
  });
});

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;
const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "olivier", instanceName: "primary" };

function writerSpy() {
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
  return { w, reports };
}

describe("performSend puts the owner's choice on the session before chat.send", () => {
  const run = async (opts: {
    extra: Record<string, unknown>;
    describe: Array<Record<string, unknown> | null>;
    absentAsNull?: boolean;
    patchThrows?: Error;
    version?: string;
  }) => {
    const gw = fakeGateway({
      describe: opts.describe as never,
      ...(opts.absentAsNull ? { describeAbsentAsNull: true } : {}),
      ...(opts.patchThrows ? { answers: { "sessions.patch": { throws: opts.patchThrows } } } : {}),
    });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = opts.version ?? "2026.9.6";
    // The once-per-connection verboseLevel patch is another `sessions.patch`: already
    // applied here, so a scripted patch refusal can only be the permission one.
    gw.verboseFullApplied = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const { w, reports } = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    let error: unknown = null;
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
        // Convex's per-instance opt-in (instances.managePermissionModes), ON unless the
        // test says otherwise.
        permissionModesManaged: true,
        ...opts.extra,
      } as unknown as Parameters<typeof performSend>[1],
      w,
      null,
      null,
      null,
      Date.now(),
      config,
    ).catch((e) => {
      error = e;
    });
    await sleep(5);
    const methods = gw.calls.map(([m]) => m);
    const permissionPatches = gw.calls
      .filter(([m, p]) => m === "sessions.patch" && "permissionMode" in p)
      .map(([, p]) => p);
    const send = gw.calls.find(([m]) => m === "chat.send")?.[1] as Record<string, unknown> | undefined;
    const patchIndex = gw.calls.findIndex(([m, p]) => m === "sessions.patch" && "permissionMode" in p);
    return { methods, permissionPatches, send, patchIndex, sendIndex: methods.indexOf("chat.send"), error, reports };
  };
  const existing = (mode?: string) => ({
    sessionId: "s-1",
    systemSent: true,
    ...(mode === undefined ? {} : { permissionMode: mode }),
    permissionModePending: false,
  });

  it("a different mode: patched BEFORE the send, and the guard is the mode applied", async () => {
    const r = await run({ extra: { permissionModeChoice: "read-only" }, describe: [existing()] });
    expect(r.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: "read-only" }]);
    expect(r.patchIndex).toBeGreaterThanOrEqual(0);
    expect(r.patchIndex).toBeLessThan(r.sendIndex);
    expect(r.send?.expectedPermissionMode).toBe("read-only");
  });

  it("the applied mode wins over any guard Convex might still carry", async () => {
    const r = await run({
      extra: { permissionModeChoice: "guarded", expectedPermissionMode: "full" },
      describe: [existing("workspace")],
    });
    expect(r.send?.expectedPermissionMode).toBe("guarded");
  });

  it("the session already holds it: no patch, the guard still says it", async () => {
    const r = await run({ extra: { permissionModeChoice: "workspace" }, describe: [existing("workspace")] });
    expect(r.permissionPatches).toEqual([]);
    expect(r.send?.expectedPermissionMode).toBe("workspace");
  });

  it("'default' over a set mode clears it, and the guard is null", async () => {
    const r = await run({ extra: { permissionModeChoice: "default" }, describe: [existing("guarded")] });
    expect(r.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: null }]);
    const send = r.send!;
    expect("expectedPermissionMode" in send && send.expectedPermissionMode === null).toBe(true);
  });

  it("a session absent under the key (token mode): the mode goes on before the send creates the turn", async () => {
    const r = await run({ extra: { permissionModeChoice: "guarded" }, describe: [null], absentAsNull: true });
    expect(r.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: "guarded" }]);
    expect(r.patchIndex).toBeLessThan(r.sendIndex);
    // NOT null: the session the turn lands on now holds the chosen mode.
    expect(r.send?.expectedPermissionMode).toBe("guarded");
  });

  it("a refused patch withholds the turn: no chat.send, named error", async () => {
    const r = await run({
      extra: { permissionModeChoice: "guarded" },
      describe: [existing()],
      patchThrows: answered("INVALID_REQUEST: Session-scoped writes are not allowed"),
    });
    expect(r.sendIndex).toBe(-1);
    expect(r.error).toBeInstanceOf(PermissionModeNotAppliedError);
    expect(classifyGatewayError(r.error)).toBe("permission_mode_not_applied");
  });

  it("full without authorization: no patch, no send", async () => {
    const r = await run({ extra: { permissionModeChoice: "full" }, describe: [existing()] });
    expect(r.permissionPatches).toEqual([]);
    expect(r.sendIndex).toBe(-1);
    expect((r.error as PermissionModeNotAppliedError).reason).toBe("full_not_authorized");
  });

  it("full authorized by Convex: patched, guarded", async () => {
    const r = await run({
      extra: { permissionModeChoice: "full", permissionModeFullAuthorized: true },
      describe: [existing()],
    });
    expect(r.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: "full" }]);
    expect(r.send?.expectedPermissionMode).toBe("full");
  });

  it("an instance NOT managed by Atrium: a stored choice is never applied, the meta guard rides as before", async () => {
    const r = await run({
      extra: { permissionModeChoice: "read-only", permissionModesManaged: false, expectedPermissionMode: "workspace" },
      describe: [existing("workspace")],
    });
    expect(r.permissionPatches).toEqual([]);
    expect(r.send?.expectedPermissionMode).toBe("workspace");
    // Only a literal `true` counts.
    const odd = await run({
      extra: { permissionModeChoice: "read-only", permissionModesManaged: "yes" },
      describe: [existing("workspace")],
    });
    expect(odd.permissionPatches).toEqual([]);
  });

  it("managed, the Control UI set a mode behind Atrium's back, owner chose nothing (= default): cleared before the turn", async () => {
    const r = await run({ extra: { permissionModeChoice: "default" }, describe: [existing("full")] });
    expect(r.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: null }]);
    expect(r.patchIndex).toBeLessThan(r.sendIndex);
    expect(r.send && "expectedPermissionMode" in r.send && r.send.expectedPermissionMode === null).toBe(true);
  });

  it("no choice: no permission patch, the send exactly as before", async () => {
    const r = await run({ extra: {}, describe: [existing("guarded")] });
    expect(r.permissionPatches).toEqual([]);
    expect(r.send).toBeDefined();
    expect("expectedPermissionMode" in r.send!).toBe(false);
  });

  it("a failing describe is no reason to skip: the mode is patched anyway (unknown ≠ equal)", async () => {
    const gwRun = await run({ extra: { permissionModeChoice: "guarded" }, describe: [null] });
    expect(gwRun.permissionPatches).toEqual([{ key: expect.any(String), permissionMode: "guarded" }]);
    expect(gwRun.send?.expectedPermissionMode).toBe("guarded");
  });
});

describe("trusted-proxy: a describe that fails establishes nothing", () => {
  const tpConfig = {
    ...(config as unknown as Record<string, unknown>),
    openclawAuthMode: "trusted-proxy",
    openclawToken: "",
  } as unknown as BridgeConfig;
  const sendWith = async (choice: string, fullAuthorized: boolean) => {
    // Every describe fails: the claim cannot settle, the pre-send read is undecidable.
    const gw = fakeGateway({ describe: [null], describeFailures: 50 });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const { w } = writerSpy();
    const reg = new SessionRegistry(servedMap(tpConfig, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING,
        text: "bonjour",
        clientMessageId: "cm-tp",
        messageId: "um-tp",
        providerResetCount: null,
        outboxId: "ob-tp",
        dispatchAgeMs: 0,
        switchedFromAgentId: null,
        switchedFromInstanceName: null,
        sessionSettings: null,
        referenceAttachments: [],
        config: null,
        permissionModesManaged: true,
        permissionModeChoice: choice,
        ...(fullAuthorized ? { permissionModeFullAuthorized: true } : {}),
      } as unknown as Parameters<typeof performSend>[1],
      w,
      null,
      null,
      null,
      Date.now(),
      tpConfig,
    ).catch((e) => {
      error = e;
    });
    const patches = gw.calls.filter(([m, p]) => m === "sessions.patch" && "permissionMode" in p);
    return { patches, sent: gw.countOf("chat.send"), error };
  };

  it("full: not patched, the turn withheld by name (never run unapplied)", async () => {
    const r = await sendWith("full", true);
    expect(r.patches).toEqual([]);
    expect(r.sent).toBe(0);
    expect((r.error as PermissionModeNotAppliedError).reason).toBe("session_not_established");
    expect(classifyGatewayError(r.error)).toBe("permission_mode_not_applied");
  });

  it("a write-scoped mode rides the OWNER's socket: a session it creates is theirs — patched, then sent", async () => {
    const r = await sendWith("guarded", false);
    expect(r.patches.length).toBe(1);
    expect(r.sent).toBe(1);
  });
});

describe("/permission-mode applies the choice NOW, or says why not", () => {
  const change = async (opts: {
    describe: Array<Record<string, unknown> | null>;
    absentAsNull?: boolean;
    patchThrows?: Error;
    choice: string;
    fullAuthorized?: boolean;
    managed?: boolean;
  }) => {
    const gw = fakeGateway({
      describe: opts.describe as never,
      ...(opts.absentAsNull ? { describeAbsentAsNull: true } : {}),
      ...(opts.patchThrows ? { answers: { "sessions.patch": { throws: opts.patchThrows } } } : {}),
    });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const { w, reports } = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const body = parsePermissionModeBody(
      JSON.stringify({
        ...ROUTING,
        choice: opts.choice,
        fullAuthorized: opts.fullAuthorized === true,
        managed: opts.managed !== false,
      }),
    )!;
    const outcome = await performPermissionModeChange(session, body, w, config);
    const patches = gw.calls.filter(([m]) => m === "sessions.patch").map(([, p]) => p);
    return { outcome, patches, reports };
  };

  it("an existing session: patched, re-described, published", async () => {
    const r = await change({
      describe: [
        { sessionId: "s-1", permissionModePending: false },
        { sessionId: "s-1", permissionMode: "read-only", permissionModePending: false },
      ],
      choice: "read-only",
    });
    expect(r.outcome).toEqual({ ok: true, result: "applied", mode: "read-only" });
    expect(r.patches).toEqual([{ key: expect.any(String), permissionMode: "read-only" }]);
    expect(r.reports.some((m) => m.permissionMode === "read-only")).toBe(true);
  });

  it("an unreadable describe: refused by name, nothing patched", async () => {
    // A `null` describe entry without describeAbsentAsNull answers `{}` — unreadable.
    const r = await change({ describe: [null], choice: "guarded" });
    expect(r.outcome).toEqual({ ok: false, reason: "session_not_established" });
    expect(r.patches).toEqual([]);
  });

  it("no session yet: deferred to the first turn, nothing created here", async () => {
    const r = await change({ describe: [null], absentAsNull: true, choice: "guarded" });
    expect(r.outcome).toEqual({ ok: true, result: "deferred", mode: null });
    expect(r.patches).toEqual([]);
  });

  it("a refusal is returned, not swallowed", async () => {
    const r = await change({
      describe: [{ sessionId: "s-1", permissionModePending: false }],
      choice: "full",
      fullAuthorized: true,
      patchThrows: answered("FORBIDDEN: missing scope: operator.admin"),
    });
    expect(r.outcome).toEqual({ ok: false, reason: "scope_refused" });
  });

  it("an instance NOT managed by Atrium: refused without a single RPC to the session", async () => {
    const r = await change({ describe: [{ sessionId: "s-1", permissionModePending: false }], choice: "guarded", managed: false });
    expect(r.outcome).toEqual({ ok: false, reason: "not_managed" });
    expect(r.patches).toEqual([]);
  });

  it("full not authorized by Convex: refused without a patch", async () => {
    const r = await change({ describe: [{ sessionId: "s-1", permissionModePending: false }], choice: "full" });
    expect(r.outcome).toEqual({ ok: false, reason: "full_not_authorized" });
    expect(r.patches).toEqual([]);
  });
});
