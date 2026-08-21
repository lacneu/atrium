import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { HealthRegistry } from "../src/core/health.js";
import { createBridgeServer } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://gateway.example.org:18789",
  openclawToken: "credential",
  openclawCredentialSource: "device",
  deviceIdentity: { id: "d", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  mediaOutboundDir: "/tmp/out",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  mediaMaxBytes: 1024,
  mediaMode: "gateway-http",
  gatewayHttpBase: "http://gw.invalid:18790",
  mediaFetchTimeoutMs: 60_000,
  inboundMediaDir: "/tmp/in",
  inboundAgentMount: "/tmp/in",
  inboundTtlMs: 1000,
  convexHttpActionsUrl: "http://convex.invalid",
  convexIngestSecret: "ingest",
  deltaFlushMs: 150,
  bridgeSharedSecret: "shared-secret",
  port: 0,
  maxBodyBytes: 4096,
};

const discoveryResult = { agents: [], rawCount: 0, usage: null };

describe("GET /rotation-readiness", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    vi.restoreAllMocks();
  });

  async function start(
    config: BridgeConfig,
    discoverGatewayAgents = vi.fn(async () => discoveryResult),
    readPersistedCredential?: (
      secret: string | null,
    ) => Promise<{ token: string; source: string | null } | null>,
  ) {
    const served = servedMap(config);
    // The served map COPIES the config, so anything modelling "what this process
    // holds" has to read the copy the route actually mutates.
    const live = [...served.values()][0]!.config;
    server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: new SessionRegistry(served),
      health: new HealthRegistry(1000, () => 2000),
      discoverGatewayAgents,
      // By DEFAULT the persisted credential agrees with this process's memory — the
      // single-bridge case. Tests modelling a second process override it.
      readPersistedCredential:
        readPersistedCredential ??
        (async () =>
          live.openclawToken === null
            ? null
            : { token: live.openclawToken, source: "device" }),
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      discoverGatewayAgents,
    };
  }

  async function readiness(baseUrl: string, secret = CONFIG.bridgeSharedSecret) {
    return fetch(`${baseUrl}/rotation-readiness?instance=primary`, {
      headers: { Authorization: secret },
    });
  }

  it("rejects unauthorized callers before opening a gateway connection", async () => {
    const { baseUrl, discoverGatewayAgents } = await start(CONFIG);
    const response = await readiness(baseUrl, "wrong");

    expect(response.status).toBe(401);
    expect(discoverGatewayAgents).not.toHaveBeenCalled();
  });

  it("rejects unknown and non-OpenClaw instances", async () => {
    const { baseUrl, discoverGatewayAgents } = await start({
      ...CONFIG,
      kind: "hermes",
    });
    const missing = await fetch(`${baseUrl}/rotation-readiness?instance=missing`, {
      headers: { Authorization: CONFIG.bridgeSharedSecret },
    });
    const hermes = await readiness(baseUrl);

    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      ok: false,
      error: { code: "instance_not_served" },
    });
    expect(hermes.status).toBe(409);
    expect(await hermes.json()).toEqual({
      ok: false,
      error: { code: "instance_not_openclaw" },
    });
    expect(discoverGatewayAgents).not.toHaveBeenCalled();
  });

  /** A config holding a device token that DIFFERS from the credential the instance
   *  was enrolled with — the only shape that can be attested. */
  const READY: BridgeConfig = {
    ...CONFIG,
    openclawToken: "device-token",
    openclawEnrollmentCredential: "enrollment-secret",
  };
  /** Registered while still holding the enrollment credential. */
  const ENROLLED: BridgeConfig = {
    ...CONFIG,
    openclawCredentialSource: "provisioner",
    openclawEnrollmentCredential: "credential",
  };

  it("fails closed when active discovery still uses a provisioner credential", async () => {
    const { baseUrl, discoverGatewayAgents } = await start(ENROLLED);
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "device_credential_unavailable" },
    });
    expect(discoverGatewayAgents).toHaveBeenCalledTimes(1);
  });

  it("refuses when the enrollment credential is not knowable here", async () => {
    // Registered already holding a device token: there is nothing to compare the
    // credential in use against. Only the platform holds both values. Attesting
    // anyway is the whole failure mode.
    const { baseUrl } = await start(CONFIG);
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "device_credential_unproven" },
    });
  });

  it("refuses a promotion that ECHOED the enrollment credential back", async () => {
    // The gateway answered `auth.deviceToken` with the very string presented. The
    // promotion records `device` — correctly, it is now this device's token — but
    // the shared enrollment secret is still in use, so rotating it WOULD lock the
    // bridge out. A proof that reports ready here is worse than no proof at all.
    const discoverGatewayAgents = vi.fn(async (observed: BridgeConfig) => {
      observed.openclawCredentialSource = "device";
      return discoveryResult;
    });
    const started = await start(ENROLLED, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "device_credential_shared_with_enrollment" },
    });
    // Refused BEFORE spending a second connection on a credential we already know
    // is the enrollment secret.
    expect(discoverGatewayAgents).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a credential that came back round to the enrollment secret", async () => {
    // A gateway is free to re-issue an earlier value. Anything that merely
    // remembered "the credential changed once" still reads as changed after it has
    // changed back — which is why the proof is a comparison against the enrollment
    // value, not a recorded history. Here the instance holds that value again.
    const { baseUrl } = await start({
      ...CONFIG,
      openclawToken: "enrollment-secret",
      openclawEnrollmentCredential: "enrollment-secret",
    });
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "device_credential_shared_with_enrollment" },
    });
  });

  it("proves an already-promoted, DISTINCT device credential with one discovery", async () => {
    const { baseUrl, discoverGatewayAgents } = await start(READY);
    const response = await readiness(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      instanceName: "primary",
      credentialSource: "device",
    });
    expect(discoverGatewayAgents).toHaveBeenCalledTimes(1);
  });

  it("re-proves with the PROMOTED credential, never the one it replaced", async () => {
    // The reason this endpoint exists. Counting two discoveries proves nothing —
    // a second pass that still presents the enrollment secret attests to exactly
    // the opposite of what the response says. So the credential handed to the
    // second connection is asserted, not the call count.
    // Captured AT CALL TIME: the mock is handed a live object, so reading it after
    // the fact would only ever show the final value — and would pass however stale
    // the credential the second connection actually presented.
    const presented: (string | null)[] = [];
    const discoverGatewayAgents = vi.fn(async (observed: BridgeConfig) => {
      presented.push(observed.openclawToken);
      if (observed.openclawCredentialSource !== "device") {
        observed.openclawToken = "promoted-device-token";
        observed.openclawCredentialSource = "device";
              }
      return discoveryResult;
    });
    const started = await start(ENROLLED, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);

    expect(response.status).toBe(200);
    expect(presented).toEqual(["credential", "promoted-device-token"]);
  });

  it("re-proves again when a DEPTH-1 chain persists a token it never authenticated with", async () => {
    // The promotion chain is allowed to receive a second token at depth 1, persist
    // it, and deliberately keep the socket it already has — so the stored
    // credential was never authenticated with. Reading the provenance back would
    // report ready on a token no connection ever presented.
    const presented: (string | null)[] = [];
    const issued = ["T1", "T2"];
    const discoverGatewayAgents = vi.fn(async (observed: BridgeConfig) => {
      presented.push(observed.openclawToken);
      const next = issued.shift();
      if (next !== undefined) {
        observed.openclawToken = next;
        observed.openclawCredentialSource = "device";
              }
      return discoveryResult;
    });
    const started = await start(ENROLLED, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);

    expect(response.status).toBe(200);
    // T2 is only attested because a connection actually presented it.
    expect(presented).toEqual(["credential", "T1", "T2"]);
  });

  it("refuses when a promoter OUTSIDE this route brings the enrollment value back", async () => {
    // The lock only holds other proofs off; a conversation or an agent listing can
    // still be mid-handshake. If one of them lands during the proof's own discovery
    // and re-issues the enrollment value — a gateway may re-issue an earlier token —
    // the credential in use is the shared secret again. Answering ready here is the
    // failure this endpoint exists to prevent, and no lock held during the proof
    // could stop the promotion: only comparing what was actually presented does.
    const presented: (string | null)[] = [];
    let call = 0;
    const discoverGatewayAgents = vi.fn(async (observed: BridgeConfig) => {
      presented.push(observed.openclawToken);
      call += 1;
      if (call === 1) {
        observed.openclawToken = "T1";
        observed.openclawCredentialSource = "device";
      } else if (call === 2) {
        // The concurrent promoter completes while THIS discovery is in flight.
        observed.openclawToken = "credential";
      }
      return discoveryResult;
    });
    const started = await start(ENROLLED, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "device_credential_shared_with_enrollment" },
    });
    // The proof followed the credential rather than reporting the one it hoped for.
    expect(presented).toEqual(["credential", "T1", "credential"]);
  });

  it("refuses rather than chase a credential another writer keeps moving", async () => {
    // A session or an `/agents` call promoting at the same moment moves the value
    // under the proof, and this route's lock cannot stop it. Retrying for ever
    // would hold a socket-opening endpoint open indefinitely.
    let n = 0;
    const discoverGatewayAgents = vi.fn(async (observed: BridgeConfig) => {
      observed.openclawToken = `moving-${(n += 1)}`;
      observed.openclawCredentialSource = "device";
            return discoveryResult;
    });
    const started = await start(ENROLLED, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "credential_moved_during_proof" },
    });
    expect(discoverGatewayAgents).toHaveBeenCalledTimes(3);
  });

  it("refuses when ANOTHER bridge process has already put the enrollment secret back", async () => {
    // Replicas, or simply the overlap of a rolling update: each process holds its
    // own copy of the credential. This one proved a distinct device token, but what
    // a restart reads is what the platform holds — and another process has promoted
    // the enrollment value back into it. Attesting from local memory alone would
    // authorise a rotation that locks the instance out at its next start.
    const { baseUrl } = await start(READY, undefined, async () => ({
      token: "enrollment-secret",
      source: "device",
    }));
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "persisted_credential_differs" },
    });
  });

  it("refuses when the PLATFORM still files the credential as an enrollment one", async () => {
    // This process believing it holds a device token is not what governs a rotation.
    // If the platform still records the value as an enrollment credential — a
    // promotion that never reached it, or a rotation this process never saw — then
    // revoking that credential is exactly what would lock the gateway out.
    const { baseUrl } = await start(READY, undefined, async () => ({
      token: "device-token",
      source: "provisioner",
    }));
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "persisted_credential_not_device" },
    });
  });

  it("refuses when the persisted credential cannot be read at all", async () => {
    // No per-bridge secret, no resolver yet, or the platform unreachable. A proof
    // that cannot see the durable state cannot speak for it.
    const { baseUrl } = await start(READY, undefined, async () => null);
    const response = await readiness(baseUrl);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "persisted_credential_unreadable" },
    });
  });

  it("runs ONE proof per instance at a time", async () => {
    // Each proof opens gateway connections and can promote a credential; concurrent
    // callers would multiply sockets and interleave promotions on the same live
    // config. A second caller is told, not served a second proof.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discoverGatewayAgents = vi.fn(async () => {
      await gate;
      return discoveryResult;
    });
    const started = await start(READY, discoverGatewayAgents);
    const first = readiness(started.baseUrl);
    // The second call lands while the first is still inside its discovery.
    await vi.waitFor(() => expect(discoverGatewayAgents).toHaveBeenCalled());
    const second = await readiness(started.baseUrl);

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      ok: false,
      error: { code: "proof_in_progress" },
    });
    release();
    expect((await first).status).toBe(200);
    // And the lock is released, so a later caller is served normally.
    expect((await readiness(started.baseUrl)).status).toBe(200);
  });

  it("neither the response NOR the log carries gateway-authored failure text", async () => {
    // The client builds its connect error from `frame.error.message` — text the
    // gateway wrote. Echoing it into the log hands whatever it put there, a
    // credential included, to the log sink.
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const discoverGatewayAgents = vi.fn(async () => {
      throw new Error(`gateway said: ${READY.openclawToken} is invalid`);
    });
    const started = await start(READY, discoverGatewayAgents);
    const response = await readiness(started.baseUrl);
    const body = JSON.stringify(await response.json());
    const log = JSON.stringify(logged);

    expect(response.status).toBe(502);
    expect(body).not.toContain("gateway said");
    expect(body).not.toContain(READY.openclawToken!);
    expect(log).not.toContain("gateway said");
    expect(log).not.toContain(READY.openclawToken!);
    // Still diagnosable: the classified cause and which instance.
    expect(log).toContain("primary");
  });
});
