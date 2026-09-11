// POST /deliver-media — the OPERATOR REPAIR of a lost outbound delivery.
//
// A file reaches a conversation through a `MEDIA:` directive on a frame, and a
// frame is never replayed: a delivery that was lost stays lost, whatever the
// live path is fixed to. Prod 2026-09-09 (report prod-ms7bybmm…): a delegated
// agent produced a DOCX and a PDF, both verified on the host, and the bubble
// stayed empty. This route is how that bubble gets what it should have carried.
//
// The property this file exists to hold: the caller supplies BASENAMES and the
// path is built here, from the instance's own outbound root. Traversal is
// impossible by construction rather than by a filter someone has to keep right.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://gateway.example.org:18789",
  openclawToken: "test-token",
  deviceIdentity: { id: "device-test", publicKey: "pk", privateKey: "sk" },
  bridgeInstanceSecret: null,
  instanceName: "ataraxis",
  bridgeSharedSecret: "test-shared-secret",
  mediaOutboundDir: "/tmp/media-outbound",
  // The GATEWAY-visible root: the path the agent writes to and names in its
  // directive, which is what the media fetcher resolves.
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
} as unknown as BridgeConfig;

/** Records every addMedia call and answers from a set of files that "exist". */
function recordingWriter(present: Set<string>) {
  const calls: Array<{
    messageId: string;
    filename: string;
    path: string;
    explicit?: boolean;
    hasRunIdKey: boolean;
    runId?: string | null;
  }> = [];
  const writer = {
    async addMedia(
      messageId: string,
      media: {
        chatId: string;
        filename: string;
        path: string;
        explicit?: boolean;
        runId?: string | null;
      },
    ) {
      calls.push({
        messageId,
        filename: media.filename,
        path: media.path,
        explicit: media.explicit,
        // PRESENCE of the key, not just its value: addMedia keys the generation
        // on `"runId" in media`, so a stated `null` is a REAL generation.
        hasRunIdKey: "runId" in media,
        runId: media.runId,
      });
      return present.has(media.filename);
    },
  } as unknown as ConvexWriter;
  return { writer, calls };
}

describe("POST /deliver-media", () => {
  let server: Server;
  let baseUrl = "";
  const present = new Set(["vade-mecum.docx"]);
  const { writer, calls } = recordingWriter(present);
  const shared = sharedFromConfig(CONFIG);
  const served = servedMap(CONFIG, writer);

  beforeAll(async () => {
    server = createBridgeServer({
      shared,
      served,
      registry: new SessionRegistry(served),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((res) => server.listen(0, res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  // NULL, not undefined, is the "send no Authorization" sentinel: a default
  // parameter fires on `undefined`, so `post(body, undefined)` would quietly
  // send the VALID secret and the 401 test would assert nothing.
  const post = (body: unknown, auth: string | null = "test-shared-secret") =>
    fetch(`${baseUrl}/deliver-media`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth !== null ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });

  const ok = {
    instanceName: "ataraxis",
    chatId: "chat-1",
    messageId: "msg-1",
    filenames: ["vade-mecum.docx"],
  };

  test("401 without the shared secret", async () => {
    expect((await post(ok, null)).status).toBe(401);
    // ...and a WRONG secret is refused too, not just an absent one.
    expect((await post(ok, "not-the-secret")).status).toBe(401);
  });

  test("the path is BUILT from the instance's outbound root, and the generation is left off", async () => {
    calls.length = 0;
    const res = await post(ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      attached: ["vade-mecum.docx"],
      notDelivered: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      messageId: "msg-1",
      filename: "vade-mecum.docx",
      path: "/home/node/.openclaw/media/outbound/vade-mecum.docx",
      // An operator asking for the file IS the delivery intent — never
      // freshness-gated, exactly like an agent's own directive.
      explicit: true,
      // A repair names its target message: no generation may filter it out.
      hasRunIdKey: false,
    });
  });

  test("a stated generation is FORWARDED, so a reopened bubble refuses the part", async () => {
    // Convex reads the message's current runId and passes it. `addPart` then
    // refuses a part whose generation no longer owns the message — which is what
    // stops this repair from landing inside a turn that reopened mid-transfer.
    calls.length = 0;
    const res = await post({ ...ok, runId: "webchat-abc" });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ hasRunIdKey: true, runId: "webchat-abc" });

    // A message with NO generation is a real case (a turn opened without an ack
    // runId): an explicit null must reach the writer as a null, not vanish.
    calls.length = 0;
    await post({ ...ok, runId: null });
    expect(calls[0]).toMatchObject({ hasRunIdKey: true, runId: null });
  });

  test("the instance's OWN outbound mount wins over the bridge's boot value", async () => {
    // The fetcher hands the gateway this path verbatim. Composing from the boot
    // value on an instance that overrides the mount asked for a file under a
    // path it is not at, and reported an existing document as not delivered.
    calls.length = 0;
    const res = await post({
      ...ok,
      config: { outboundAgentMount: "/srv/ataraxis/out/" },
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      // Trailing slash normalised, no double separator.
      path: "/srv/ataraxis/out/vade-mecum.docx",
    });
  });

  test("a MALFORMED config does not poison the provider the live path shares", async () => {
    // `applyConfig` replaces a provider SHARED with this instance's ordinary
    // deliveries. Handing it an unparsed body meant an out-of-range mode or a
    // negative cap did not just fail this repair — it kept failing the live
    // deliveries until the next `/send` restored a valid config. `/send` has
    // always gone through `parseInboundConfig`; so does this route.
    calls.length = 0;
    const res = await post({
      ...ok,
      config: { mediaMode: "not-a-mode", mediaMaxMb: -1, outboundAgentMount: "relative" },
    });
    expect(res.status).toBe(200);
    // Every bad field was DROPPED, so the mount stays the bridge's boot value.
    expect(calls[0]).toMatchObject({
      path: "/home/node/.openclaw/media/outbound/vade-mecum.docx",
    });
  });

  test("a file that did NOT reach the bubble is reported as such, not as absent", async () => {
    // `addMedia` answers false for an absent file AND for a transfer it could
    // not complete, so the field says only "did not reach the bubble". Claiming
    // "gone" would send an operator to recreate a document that is right there.
    calls.length = 0;
    const res = await post({
      ...ok,
      filenames: ["vade-mecum.docx", "vade-mecum.pdf"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      attached: ["vade-mecum.docx"],
      notDelivered: ["vade-mecum.pdf"],
    });
  });

  test("a filename that is not a plain basename is REFUSED, never sanitised", async () => {
    // Silently repairing a suspicious input is how a filter gets bypassed: the
    // answer is a refusal, and nothing reaches the writer.
    for (const name of [
      "../../etc/passwd",
      "/home/node/.openclaw/media/outbound/x.pdf",
      "sub/dir/x.pdf",
      "..",
      ".hidden",
      "back\\slash.pdf",
      "",
    ]) {
      calls.length = 0;
      const res = await post({ ...ok, filenames: [name] });
      expect(res.status, `refused: ${JSON.stringify(name)}`).toBe(400);
      expect(calls, `no write for ${JSON.stringify(name)}`).toHaveLength(0);
    }
  });

  test("the batch is bounded, and an empty batch is a bad request", async () => {
    expect((await post({ ...ok, filenames: [] })).status).toBe(400);
    const many = Array.from({ length: 17 }, (_, i) => `f${i}.pdf`);
    expect((await post({ ...ok, filenames: many })).status).toBe(400);
  });

  test("a JSON body that is not an object is a 400, not a crash", async () => {
    // `JSON.parse("null")` SUCCEEDS and the cast does not change the value: the
    // next property read threw, and the global handler turned this route's
    // announced 400 into a 500.
    calls.length = 0;
    for (const body of ["null", '"a string"', "[1,2]", "42"]) {
      const res = await fetch(`${baseUrl}/deliver-media`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "test-shared-secret",
        },
        body,
      });
      expect(res.status, `body ${body}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("409 for an instance this bridge does not serve", async () => {
    const res = await post({ ...ok, instanceName: "somewhere-else" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "instance_not_served" },
    });
  });

  test("400 when the target is not fully named", async () => {
    expect((await post({ ...ok, messageId: "" })).status).toBe(400);
    expect((await post({ ...ok, chatId: "" })).status).toBe(400);
  });
});
