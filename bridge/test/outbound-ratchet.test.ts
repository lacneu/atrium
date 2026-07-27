// The OUTBOUND ratchet (W10 / G2): every parameter body the bridge SENDS is validated
// against the vendored gateway schemas, offline.
//
// WHY this is the most valuable gate of the lot. `ChatSendParams` and friends are
// declared `additionalProperties: false`. Adding one field to an outbound body — the
// most natural change in the world when a new gateway feature appears — makes EVERY
// `chat.send` fail `INVALID_REQUEST` on every gateway that predates the field. Not a
// degraded feature: no turns at all, for every user on an older gateway. Nothing in
// the repo could see that coming, and the programme names it the most direct
// regression hole in the process.
//
// The bodies are not transcribed by hand — that would test the transcription. They are
// CAPTURED from the real code paths through the scriptable fake gateway, so what gets
// validated is what the bridge actually builds.
//
// THE FLOOR, precisely (established 2026-07-27): the supported range starts at
// 2026.5.19, and that tag has NO `packages/gateway-protocol` at all — the schema
// package did not exist yet. There is therefore nothing to validate the floor against,
// and no amount of test-writing changes that. The oldest schema this repo can check is
// the oldest VENDORED one; a field that 2026.6.11 accepts and 2026.5.19 would have
// refused stays invisible. That is a declared limit, not an oversight.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { Value } from "typebox/value";

import {
  lcmSendParams,
  performSend,
  subAgentSendParams,
} from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { oldestVendored, vendoredVersions } from "./helpers/vendored.js";
import { requestCallSites } from "./helpers/rpc-sites.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// `import.meta.glob` is Vite's; it is not on the Node `ImportMeta` type this package
// compiles against. Narrowed here rather than pulling vite's client types in for one
// test (same treatment as protocol-coverage.test.ts).
const SCHEMA_MODULES = (
  import.meta as unknown as {
    glob: (p: string) => Record<string, () => Promise<Record<string, unknown>>>;
  }
).glob("../protocol/openclaw/*/*.ts");

/** Upstream's mechanical naming: `sessions.compaction.list` ->
 *  `SessionsCompactionListParamsSchema`. */
function paramsSchemaName(method: string): string {
  return `${method
    .split(".")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")}ParamsSchema`;
}

/** Every exported schema of one vendored version, by export name. */
async function schemasOf(version: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const file of readdirSync(
    new URL(`../protocol/openclaw/${version}/`, import.meta.url),
  ).filter((f) => f.endsWith(".ts"))) {
    const loader = SCHEMA_MODULES[`../protocol/openclaw/${version}/${file}`];
    if (loader === undefined) continue;
    for (const [name, value] of Object.entries(await loader())) {
      if (name.endsWith("Schema")) out.set(name, value);
    }
  }
  return out;
}

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

function writerStub() {
  return {
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
}

const sendBody = {
  ...ROUTING,
  text: "bonjour",
  clientMessageId: "cm-1",
  messageId: "um-1",
  providerResetCount: null,
  outboxId: "ob-1",
  dispatchAgeMs: 0,
  switchedFromAgentId: null,
  switchedFromInstanceName: null,
  sessionSettings: { model: "opus", thinkingLevel: "high", fastMode: false },
  referenceAttachments: [],
  config: null,
} as unknown as Parameters<typeof performSend>[1];

/** Drive the REAL send path and return every `[method, params]` it sent.
 *
 *  `withAttachments` exercises the branch that sets `params.attachments` — a separate
 *  shape from the plain send, and one a schema can reject on its own (raised in
 *  review: the first version only ever captured the attachment-free body). */
async function captureOutboundBodies(
  withAttachments = false,
): Promise<[string, Record<string, unknown>][]> {
  const gw = fakeGateway({
    describe: [
      {
        sessionId: "s-1",
        systemSent: true,
        contextTokens: 200_000,
        promptBudgetBeforeReserve: 100_000,
        estimatedPromptTokens: 40_000,
        totalTokensFresh: true,
      },
    ],
  });
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(
    async () => gw as never,
  );
  const reg = new SessionRegistry(servedMap(config, writerStub()), () => 1000);
  const session = await reg.acquire(ROUTING);
  await tick();
  const body = withAttachments
    ? ({
        ...(sendBody as object),
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "note.txt",
            content: Buffer.from("hello").toString("base64"),
          },
        ],
      } as unknown as Parameters<typeof performSend>[1])
    : sendBody;
  await performSend(session, body, writerStub(), null, null);
  return (session.connection as unknown as FakeGateway).calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound ratchet — what the bridge SENDS fits the vendored contract", () => {
  it("captures real bodies from the send path (not hand-written ones)", async () => {
    const calls = await captureOutboundBodies();
    const methods = calls.map(([m]) => m);
    // A capture that stopped capturing would make every assertion below vacuous.
    expect(methods).toContain("chat.send");
    expect(methods).toContain("sessions.describe");
    expect(methods).toContain("sessions.patch");
  });

  for (const version of vendoredVersions()) {
    for (const attachments of [false, true]) {
      const shape = attachments ? "with an attachment" : "plain";
      it(`every captured body (${shape}) validates against ${version}`, async () => {
        const calls = await captureOutboundBodies(attachments);
        const schemas = await schemasOf(version);
        const problems: string[] = [];
        const checkedMethods: string[] = [];
        for (const [method, params] of calls) {
          const schema = schemas.get(paramsSchemaName(method));
          // No schema for this method at this version: nothing to check here. The
          // rpc-scope suite is what refuses an UNDECLARED absence; this one only
          // validates what can be validated.
          if (schema === undefined) continue;
          checkedMethods.push(method);
          if (Value.Check(schema as never, params)) continue;
          const first = [...Value.Errors(schema as never, params)][0] as
            | { instancePath?: string; message?: string }
            | undefined;
          problems.push(
            `${method} rejected by ${version}: ${first?.instancePath || "(root)"} ` +
              `${first?.message ?? ""}`,
          );
        }
        // Naming the method, not counting bodies (raised in review): `checked > 1`
        // was satisfiable by two `sessions.*` calls while `chat.send` — the body this
        // gate exists for — went unchecked.
        expect(
          checkedMethods,
          `chat.send was never validated against ${version}`,
        ).toContain("chat.send");
        if (attachments) {
          const sent = calls.find(([m]) => m === "chat.send")?.[1];
          expect(
            Array.isArray(sent?.attachments),
            "the attachment branch did not run — this case validates nothing",
          ).toBe(true);
        }
        expect(
          problems,
          `the bridge sends what ${version} refuses:\n${problems.join("\n")}`,
        ).toEqual([]);
      });
    }
  }

  for (const version of vendoredVersions()) {
    it(`the OTHER two chat.send bodies validate against ${version}`, async () => {
      // The inventory below pins how MANY call sites exist; it cannot see what they
      // send (raised in review). These two build their body in an HTTP handler, so the
      // builders were extracted as pure functions — the test validates the real
      // construction, not a copy of it.
      const chatSend = (await schemasOf(version)).get("ChatSendParamsSchema");
      expect(chatSend, `no ChatSendParamsSchema in ${version}`).toBeDefined();

      const attachment = {
        type: "file",
        mimeType: "text/plain",
        fileName: "note.txt",
        content: Buffer.from("hello").toString("base64"),
      };
      const bodies: [string, Record<string, unknown>][] = [
        [
          "/subagent-send",
          subAgentSendParams(
            "agent:alice:subagent:641258d3",
            "continue please",
            "interaction-7",
          ),
        ],
        [
          "/subagent-send with an attachment",
          subAgentSendParams(
            "agent:alice:subagent:641258d3",
            "look at this",
            "interaction-8",
            [attachment],
          ),
        ],
        [
          "/lossless",
          lcmSendParams("agent:alice:atrium:chat:olivier:c1", "/lcm status", 1),
        ],
      ];
      // The attachment-bearing shape must really differ, or this case validates the
      // same body twice and proves nothing.
      const withAtt = bodies.find(([w]) => w.includes("attachment"))?.[1];
      expect(Array.isArray(withAtt?.attachments)).toBe(true);

      const problems: string[] = [];
      for (const [where, params] of bodies) {
        if (Value.Check(chatSend as never, params)) continue;
        const first = [...Value.Errors(chatSend as never, params)][0] as
          | { instancePath?: string; message?: string }
          | undefined;
        problems.push(
          `${where} rejected by ${version}: ${first?.instancePath || "(root)"} ` +
            `${first?.message ?? ""}`,
        );
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }

  it("the chat.send call sites are an INVENTORY, not an assumption", () => {
    // What this gate covers, said out loud. The captured path is `performSend`; the
    // other two build small static bodies inside HTTP handlers and are NOT captured
    // (raised in review). Rather than imply coverage it does not have, the test pins
    // the inventory: a FOURTH site — or a move of an existing one — fails here and
    // forces the decision to capture it or declare it.
    //
    // Counted with the SHARED derivation, not a local regex (raised in review): a
    // bespoke `"chat.send"` scanner would have inherited every blindness rpc-scope
    // spent five rounds closing — single quotes, optional calls, generic calls,
    // bracket access, destructured aliases.
    const sites = requestCallSites().filter((s) => s.method === "chat.send");
    expect(
      sites.length,
      "a chat.send call site was added or removed: capture its body here, or say " +
        "why it cannot be — an uncaptured body is a field addition this gate misses",
    ).toBe(3);
    // The two non-performSend sites must go through the exported builders the test
    // above validates — inlining a body again would put it out of reach.
    //
    // Counted, not merely present: `toContain("subAgentSendParams(")` was satisfied by
    // the DECLARATION alone, so re-inlining the handler's body left the test green
    // (caught by neutralisation). Two occurrences = the export and its call site.
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf-8");
    for (const builder of ["subAgentSendParams(", "lcmSendParams("]) {
      const uses = src.split(builder).length - 1;
      expect(
        uses,
        `${builder} is declared but not called — a chat.send body was inlined back ` +
          `into its handler and is no longer validated against the vendored schemas`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("REFUSES an added field — the regression this gate exists for", async () => {
    // The programme's own example: `expectedSessionRoutingContract` is the upstream
    // remedy for mis-routing and is tempting to send. It arrived in 2026.7.1, so
    // 2026.6.11 rejects it — and `additionalProperties: false` means the gateway
    // returns INVALID_REQUEST for EVERY chat.send, not just a degraded feature.
    const oldest = oldestVendored();
    const schemas = await schemasOf(oldest);
    const chatSend = schemas.get("ChatSendParamsSchema");
    expect(chatSend, `no ChatSendParamsSchema in ${oldest}`).toBeDefined();

    // A body the schema accepts. `idempotencyKey` is REQUIRED at 6.11 — discovered by
    // running this very check, which is a small proof that it reads the real contract
    // rather than a remembered one.
    const legal = {
      sessionKey: "agent:alice:atrium:chat:olivier:c1",
      message: "hi",
      idempotencyKey: "k-1",
    };
    expect(Value.Check(chatSend as never, legal)).toBe(true);
    expect(
      Value.Check(chatSend as never, {
        ...legal,
        expectedSessionRoutingContract: "whatever",
      }),
      `${oldest} accepted a field it does not declare — additionalProperties is not ` +
        `doing its job, and this whole gate is worthless`,
    ).toBe(false);
  });

  it("states the FLOOR limit rather than implying coverage", () => {
    // `supportedRange.min` is 2026.5.19 and that tag has no
    // `packages/gateway-protocol` at all — verified 2026-07-27 against a clone of the
    // tag. So the oldest thing this gate can check is the oldest VENDORED version, and
    // the gap between them is real: a field 2026.6.11 accepts and 2026.5.19 would
    // refuse is invisible here. If the vendored floor ever reaches the declared floor,
    // this expectation flips and the limit can be deleted.
    expect(oldestVendored()).toBe("2026.6.11");
    // Stated as an assertion so it cannot rot silently into a false claim of coverage.
    expect(oldestVendored()).not.toBe("2026.5.19");
  });
});
