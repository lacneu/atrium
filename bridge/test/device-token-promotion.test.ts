import { describe, expect, test, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { deviceTokenPromotion } from "../src/core/device-token-promotion.js";

function config(): BridgeConfig {
  return {
    openclawGatewayUrl: "wss://gateway.example.test",
    openclawToken: "bootstrap-token",
    openclawCredentialSource: "provisioner",
    kind: "openclaw",
    deviceIdentity: {
      id: "a".repeat(64),
      publicKey: "A".repeat(43),
      privateKey: "private",
    },
    bridgeInstanceSecret: "bridge-secret",
    instanceName: "operations",
    mediaOutboundDir: "/tmp/out",
    mediaOutboundAgentMount: "/tmp/out",
    mediaMaxBytes: 1,
    mediaMode: "off",
    gatewayHttpBase: "https://gateway.example.test",
    mediaFetchTimeoutMs: 1,
    inboundMediaDir: "/tmp/in",
    inboundMediaStagingDir: "/tmp/in-staging",
    inboundAgentMount: "/tmp/in",
    inboundTtlMs: 1,
    convexHttpActionsUrl: "https://convex.example.test/",
    convexIngestSecret: "ingest",
    deltaFlushMs: 1,
    bridgeSharedSecret: "shared",
    port: 8787,
    maxBodyBytes: 1024,
  };
}

describe("device token promotion", () => {
  /** A Convex that always answers with the given outcome. */
  const answering = (outcome: string) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, outcome }), { status: 200 }),
    ) as unknown as typeof fetch;

  test("a LOST answer, once repaired, still knows the credential CHANGED", async () => {
    // The provisioning path this endpoint exists for: the gateway issues a device
    // token, Convex is briefly unreachable, the bridge adopts the token anyway and
    // repairs later. Deciding distinctness only on the repair would compare the
    // token against itself — the enrollment secret HAS been left behind, and a
    // rotation proof that refuses for ever afterwards is a false refusal.
    const value = config();
    const pending: (() => void)[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(JSON.stringify({ ok: true, outcome: "stored" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const promote = deviceTokenPromotion(value, fetchImpl, (run) => {
      pending.push(run);
    })!;

    await expect(promote("issued-token")).rejects.toThrow("unreachable");
    // Adopted in memory, but nothing is attested yet: the answer is unknown.
    expect(value.openclawToken).toBe("issued-token");
    expect(value.openclawCredentialSource).toBe("provisioner");

    pending[0]!();
    await vi.waitFor(() =>
      expect(value.openclawCredentialSource).toBe("device"),
    );
  });

  test("persists the token through the instance-bound endpoint before switching memory", async () => {
    const value = config();
    const fetchImpl = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(JSON.stringify({ ok: true, outcome: "stored" }), {
          status: 200,
        }),
    );
    const promote = deviceTokenPromotion(value, fetchImpl as typeof fetch)!;

    await promote("device-token");

    expect(value.openclawToken).toBe("device-token");
    expect(value.openclawCredentialSource).toBe("device");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://convex.example.test/bridge/device-token");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer bridge-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      deviceId: "a".repeat(64),
      publicKey: "A".repeat(43),
      token: "device-token",
    });
  });

  test("keeps the bootstrap token when persistence is rejected", async () => {
    const value = config();
    const promote = deviceTokenPromotion(
      value,
      vi.fn(async () => new Response("{}", { status: 409 })) as typeof fetch,
    )!;

    await expect(promote("device-token")).rejects.toThrow(
      "device token promotion was rejected",
    );
    expect(value.openclawToken).toBe("bootstrap-token");
  });

  test("a LOST response still adopts the token in memory; a refusal does not", async () => {
    // Two failures that look alike and are not. A transport error leaves us unable
    // to know whether the write landed, and the gateway has ALREADY issued this
    // token — keeping the superseded bootstrap is what left the bridge unable to
    // reconnect once the gateway stopped accepting it. An explicit refusal is an
    // answer: nothing was stored, so nothing changes here.
    const lost = config();
    await expect(
      deviceTokenPromotion(lost, (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch)!("issued-token"),
    ).rejects.toThrow("unreachable");
    expect(lost.openclawToken).toBe("issued-token");
    expect(lost.openclawCredentialSource).toBe("provisioner");

    // A 2xx whose body makes no sense (a proxy page, a truncated answer) carries
    // the same uncertainty as an unreadable one — the write may have landed.
    const garbled = config();
    await expect(
      deviceTokenPromotion(
        garbled,
        vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch,
      )!("issued-token"),
    ).rejects.toThrow("invalid response");
    expect(garbled.openclawToken).toBe("issued-token");

    const refused = config();
    await expect(
      deviceTokenPromotion(
        refused,
        vi.fn(async () => new Response("{}", { status: 409 })) as typeof fetch,
      )!("issued-token"),
    ).rejects.toThrow("rejected");
    expect(refused.openclawToken).toBe("bootstrap-token");
  });

  test("a SUPERSEDED answer is explicit: the in-memory token does not move", async () => {
    // Convex kept a token issued after ours, from an overlapping handshake. This is
    // a successful answer, not a malformed one — adopting our older value would put
    // memory out of step with what is stored, and every reconnect and media request
    // would then present a credential Convex no longer knows.
    const value = config();
    const promote = deviceTokenPromotion(
      value,
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, outcome: "superseded" }), {
            status: 200,
          }),
      ) as typeof fetch,
    )!;

    expect(await promote("our-older-token", 1_000)).toBe("superseded");
    expect(value.openclawToken).toBe("bootstrap-token");
    expect(value.openclawCredentialSource).toBe("provisioner");
  });

  test("a LOST persistence is retried, not merely hoped for", async () => {
    // Adopting the token in memory keeps the LIVE connection working, but Convex is
    // what a restarted bridge reads back — so a promotion whose answer was lost has
    // to be re-attempted. Assuming the next handshake will do it is not enough:
    // `auth.deviceToken` is optional, and a successful reconnect may re-issue
    // nothing at all.
    const value = config();
    const pending: Array<() => void> = [];
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ ok: true, outcome: "stored" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const promote = deviceTokenPromotion(value, impl, (run) => {
      pending.push(run);
    })!;
    await expect(promote("issued-token", 7)).rejects.toThrow("unreachable");
    expect(calls).toBe(1);
    expect(pending).toHaveLength(1);

    // Run the scheduled repair.
    pending[0]!();
    await vi.waitFor(() =>
      expect(value.openclawCredentialSource).toBe("device"),
    );
    expect(calls).toBe(2);
    expect(value.openclawToken).toBe("issued-token");
  });

  test("a retry is abandoned once a NEWER token has been promoted", async () => {
    const value = config();
    const pending: Array<() => void> = [];
    let attempted: string[] = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { token: string };
      attempted.push(body.token);
      if (body.token === "first") throw new Error("socket hang up");
      return new Response(JSON.stringify({ ok: true, outcome: "stored" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const promote = deviceTokenPromotion(value, impl, (run) => {
      pending.push(run);
    })!;
    await expect(promote("first", 1)).rejects.toThrow("unreachable");
    await promote("second", 2);
    attempted = [];

    // The queued repair for "first" must not resurrect a token already replaced.
    pending[0]!();
    expect(attempted).toEqual([]);
    expect(value.openclawToken).toBe("second");
  });

  test("is disabled when the instance-bound bridge secret is unavailable", () => {
    const value = config();
    value.bridgeInstanceSecret = null;
    expect(deviceTokenPromotion(value)).toBeUndefined();
  });

  // CADENCE (prod anomaly jh7fkb54…, 2026-10-18): every new gateway connection hands the
  // device token back, and the bridge asked Convex again each time — one promotion per
  // instance every two minutes. Once Convex confirmed the token, the same token is not
  // asked again; a new one, and a failed or unconfirmed one, still are.
  test("a token Convex confirmed is not promoted again by the same process", async () => {
    const value = config();
    const fetchImpl = answering("stored");
    const promote = deviceTokenPromotion(value, fetchImpl)!;
    expect(await promote("device-token")).toBe("stored");
    for (let i = 0; i < 180; i++) expect(await promote("device-token")).toBe("unchanged");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await promote("rotated-token")).toBe("stored");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Codex review 1 of 0.101.1 [high]: the cache keyed on the token alone. A promoted without
  // `issuedAtMs`, then A presented WITH its issuance time, was answered locally — so Convex
  // never recorded the time, and B (issued later) was refused as `superseded` for ever.
  test("the same token with a NEW issuance time goes to Convex, then B rotates", async () => {
    const value = config();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true, outcome: "stored" }), { status: 200 });
    }) as unknown as typeof fetch;
    const promote = deviceTokenPromotion(value, fetchImpl)!;
    expect(await promote("token-a")).toBe("stored");
    expect(await promote("token-a", 1000)).toBe("stored");
    expect(await promote("token-a", 1000)).toBe("unchanged");
    expect(await promote("token-b", 2000)).toBe("stored");
    expect(bodies.map((b) => [b.token, b.issuedAtMs])).toEqual([
      ["token-a", undefined],
      ["token-a", 1000],
      ["token-b", 2000],
    ]);
    expect(value.openclawToken).toBe("token-b");
  });

  // NOTHING THE REQUEST CARRIES IS HIDDEN BY THE CACHE: over random sequences, Convex is
  // asked exactly when the body differs from the last one it confirmed.
  test("the cache answers locally only for a body identical to the last confirmed one", async () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let run = 0; run < 50; run++) {
      const value = config();
      const sent: string[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        sent.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true, outcome: "unchanged" }), { status: 200 });
      }) as unknown as typeof fetch;
      const promote = deviceTokenPromotion(value, fetchImpl)!;
      let lastConfirmed: string | null = null;
      for (let step = 0; step < 20; step++) {
        const token = ["t1", "t2"][next() % 2]!;
        const issued = [undefined, 1000, 2000][next() % 3];
        const body = JSON.stringify({
          deviceId: value.deviceIdentity!.id,
          publicKey: value.deviceIdentity!.publicKey,
          token,
          ...(issued === undefined ? {} : { issuedAtMs: issued }),
        });
        const before = sent.length;
        await promote(token, issued);
        expect(sent.length - before).toBe(body === lastConfirmed ? 0 : 1);
        if (sent.length > before) expect(sent.at(-1)).toBe(body);
        lastConfirmed = body;
      }
    }
  });

  test("a refusal, or a superseded answer, leaves the next promotion to Convex", async () => {
    const value = config();
    const refused = vi.fn(async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
    const promote = deviceTokenPromotion(value, refused)!;
    await expect(promote("device-token")).rejects.toThrow();
    await expect(promote("device-token")).rejects.toThrow();
    expect(refused).toHaveBeenCalledTimes(2);
    const superseded = answering("superseded");
    const again = deviceTokenPromotion(config(), superseded)!;
    expect(await again("older-token")).toBe("superseded");
    expect(await again("older-token")).toBe("superseded");
    expect(superseded).toHaveBeenCalledTimes(2);
  });
});
