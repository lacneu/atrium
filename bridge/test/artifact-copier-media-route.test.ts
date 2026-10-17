// CODEX REVIEW 2, finding 1 — a transcript `MEDIA:` reference is resolved ONLY through the
// gateway's media route, named with the row's session (`/__openclaw__/assistant-media?
// source=…&sessionKey=…`, meta then ticket — src/gateway/control-ui.ts:429 at v2026.9.33;
// the policy is the SESSION's: control-ui-assistant-media-policy.test.ts:157, :441). Never a
// base name in a local outbound mount, even under `shared-fs`: the mount knows no session,
// so a homonym another conversation wrote there would be copied instead (Codex reproduced
// it up to `finalizeCopy` with two distinct `package.json`).

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MediaFetcherProvider } from "../src/core/media-fetcher-provider.js";
import { artifactCopyEnvOf, type InstanceBundle } from "../src/session.js";

const SK_A = "agent:alice:atrium:chat:u:conv-a";
const SOURCE_A = "/home/node/.openclaw/workspace-alice/conv-a/package.json";
const A_BYTES = '{"name":"conversation-a"}';
const B_BYTES = '{"name":"conversation-b"}';

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** The gateway's media route: the session's policy decides, the ticket is the session's. */
async function gateway(): Promise<{ base: string; seen: string[] }> {
  const seen: string[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gw");
    seen.push(url.toString());
    const source = url.searchParams.get("source");
    const session = url.searchParams.get("sessionKey");
    if (url.pathname !== "/__openclaw__/assistant-media" || source !== SOURCE_A || session !== SK_A) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("meta") === "1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ available: true, mediaTicket: "v1.ticket-a", mediaTicketExpiresAt: Date.now() + 300_000 }));
      return;
    }
    if (url.searchParams.get("mediaTicket") !== "v1.ticket-a") {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(A_BYTES)) });
    res.end(A_BYTES);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `127.0.0.1:${port}`, seen };
}

describe("a MEDIA: reference is copied through the gateway's route of ITS session, never a mount", () => {
  it("shared-fs with a homonym from conversation B in the outbound mount: A gets A's bytes", async () => {
    const { base, seen } = await gateway();
    const outbound = await mkdtemp(join(tmpdir(), "outbound-"));
    await mkdir(outbound, { recursive: true });
    await writeFile(join(outbound, "package.json"), B_BYTES);
    const config = loadConfig({
      OPENCLAW_GATEWAY_URL: `ws://${base}`,
      OPENCLAW_TOKEN: "tkn",
      OPENCLAW_DEVICE_IDENTITY: JSON.stringify({ id: "d", publicKey: "p", privateKey: "k" }),
      CONVEX_HTTP_ACTIONS_URL: "http://convex.invalid",
      BRIDGE_INGEST_SECRET: "i",
      BRIDGE_SHARED_SECRET: "s",
      OPENCLAW_MEDIA_MODE: "shared-fs",
      OPENCLAW_MEDIA_OUTBOUND_DIR: outbound,
    } as NodeJS.ProcessEnv);
    const provider = new MediaFetcherProvider(config);
    // The danger, measured: the mount fetcher reads B's homonym for A's reference.
    const viaMount = await provider.current()!.open(SOURCE_A, { sessionKey: SK_A });
    expect(viaMount.ok && (await drain(viaMount.stream))).toBe(B_BYTES);
    // What the copier uses: the route, named with A's session.
    const env = artifactCopyEnvOf({ config, mediaProvider: provider } as unknown as InstanceBundle);
    const opened = await env.mediaFetcher()!.open(SOURCE_A, { sessionKey: SK_A });
    expect(opened.ok).toBe(true);
    expect(opened.ok && (await drain(opened.stream))).toBe(A_BYTES);
    expect(seen.every((u) => u.includes(`sessionKey=${encodeURIComponent(SK_A)}`))).toBe(true);
  });

  it("no route (mode off): nothing is opened", () => {
    const config = loadConfig({
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:1",
      OPENCLAW_TOKEN: "tkn",
      OPENCLAW_DEVICE_IDENTITY: JSON.stringify({ id: "d", publicKey: "p", privateKey: "k" }),
      CONVEX_HTTP_ACTIONS_URL: "http://convex.invalid",
      BRIDGE_INGEST_SECRET: "i",
      BRIDGE_SHARED_SECRET: "s",
      OPENCLAW_MEDIA_MODE: "off",
    } as NodeJS.ProcessEnv);
    const provider = new MediaFetcherProvider(config);
    expect(artifactCopyEnvOf({ config, mediaProvider: provider } as unknown as InstanceBundle).mediaFetcher()).toBeUndefined();
  });
});
