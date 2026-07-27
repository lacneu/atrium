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
// CAPTURED from the real code paths, so what gets validated is what the bridge actually
// builds. Three capture mechanisms, by what the code allows:
//   - the SEND path, driven end to end through the scriptable fake gateway;
//   - the OPERATOR lanes (`/config-defaults`, `/agent-files`) and `cron.*`, whose
//     handlers already take a connection — a recording requester is enough;
//   - bodies built inside an HTTP handler (`tasks.*`, `talk.*`), extracted as pure
//     exported builders exactly as lot 17 did for the two out-of-band `chat.send` sites.
// Scope was `chat.send` alone until 2026-07-27. It is now every lane the bridge calls
// except `sessions.reset` and `sessions.compact`, which are inline on the turn path.
// Two earlier versions of this sentence were wrong in the same direction — first while
// `chat.abort`, `agents.list` and `models.list` were uncaptured, then while
// `sessions.get`, the three `tts.*` and `sessions.compaction.list` were. A claim of
// completeness is worth exactly the list that backs it, which is EXPECTED_CAPTURED.
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
  applySessionSettings,
  discoverAgents,
  ensureAvailableModels,
  fetchCompactionHistory,
  fetchCronJobs,
  lcmSendParams,
  performOpenClawCronManage,
  performSend,
  subAgentSendParams,
} from "../src/server.js";
import {
  chatAbortParams,
  sessionsGetParams,
  talkClientCreateParams,
  talkToolCallParams,
  taskGetParams,
  taskListParams,
  ttsParams,
} from "../src/core/rpc-params.js";
import {
  performAgentFilesOp,
  performConfigDefaultsOp,
  type GatewayRequester,
} from "../src/conf.js";
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

/** Every CRON body, captured by driving the real handlers with a recorder.
 *
 *  `performOpenClawCronManage` and `fetchCronJobs` already take a connection, so the
 *  bodies come from the code that ships. The `update` op reads the job first to learn its
 *  payload kind, so the reply has to carry one — otherwise the patch is refused and the
 *  most interesting body of the six is never built. */
async function captureCronBodies(): Promise<[string, Record<string, unknown>][]> {
  const out: [string, Record<string, unknown>][] = [];
  const job = {
    id: "job-1",
    payload: { kind: "agentTurn", message: "ping" },
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Paris" },
    state: { lastStatus: "ok" },
  };
  const reply = (method: string): Record<string, unknown> =>
    method === "cron.list" ? { jobs: [job] } : { ...job, ran: true };

  const list = recorder(reply);
  await fetchCronJobs(list.conn as never);
  out.push(...list.calls);

  for (const body of [
    { op: "get", jobId: "job-1" },
    { op: "runs", jobId: "job-1", limit: 20 },
    { op: "remove", jobId: "job-1" },
    { op: "run", jobId: "job-1" },
    // EVERY constructible `update` branch, not one. `cron.update` is the only body here
    // whose shape depends on user input, so exercising a single branch left the others —
    // the `systemEvent` payload above all — never validated (raised in review).
    { op: "update", jobId: "job-1", patch: { name: "matin" } },
    { op: "update", jobId: "job-1", patch: { enabled: false } },
    {
      op: "update",
      jobId: "job-1",
      patch: { schedule: { kind: "cron" as const, expr: "0 9 * * *", tz: "Europe/Paris" } },
    },
    {
      op: "update",
      jobId: "job-1",
      patch: { schedule: { kind: "at" as const, at: "2026-08-01T09:00:00.000Z" } },
    },
    {
      op: "update",
      jobId: "job-1",
      patch: { message: "pong", schedule: { kind: "every" as const, everyMs: 60_000 } },
    },
  ]) {
    const r = recorder(reply);
    await performOpenClawCronManage(r.conn as never, body as never);
    out.push(...r.calls);
  }

  // The `systemEvent` payload branch: the patch's shape is chosen from the job's CURRENT
  // kind, so it only appears when the read says so.
  const sysReply = (): Record<string, unknown> => ({
    ...job,
    payload: { kind: "systemEvent", text: "ping" },
  });
  const sys = recorder(sysReply);
  await performOpenClawCronManage(sys.conn as never, {
    op: "update",
    jobId: "job-1",
    patch: { message: "pong" },
  } as never);
  out.push(...sys.calls);

  // `sessions.compaction.list`, captured here rather than declared absent: CORRECTED
  // after review — `fetchCompactionHistory` is a helper OUTSIDE the turn path that
  // already takes a connection, so it needs the same recorder as the cron handlers and no
  // production change at all. Only `sessions.reset` and `sessions.compact` are genuinely
  // inline on the turn path.
  const hist = recorder(() => ({ checkpoints: [] }));
  await fetchCompactionHistory(hist.conn as never, "agent:alice:atrium:chat:olivier:c1");
  out.push(...hist.calls);
  return out;
}

/** The `sessions.patch` UNSET bodies: `{key, <field>: null}`, one call per cleared field.
 *
 *  The send fixture carries no `clears`, so this dynamically-keyed shape was never
 *  captured (raised in review) — and it is a DIFFERENT object from the set-a-value patch,
 *  one a schema can reject on its own. `applySessionSettings` is already exported and
 *  takes a connection, so the real construction is reachable. */
async function captureUnsetBodies(): Promise<[string, Record<string, unknown>][]> {
  const r = recorder(() => ({ ok: true }));
  await applySessionSettings(r.conn, "agent:alice:atrium:chat:olivier:c1", {
    clears: ["model", "thinkingLevel", "fastMode"],
  } as never);
  return r.calls;
}

/** The DISCOVERY lane: `models.list` and `agents.list` (plus the `usage.status` that
 *  rides the same short-lived connection). `discoverAgents` opens its own connection, so
 *  the mocked `connect` is what makes it capturable — the same seam the send path uses. */
async function captureDiscoveryBodies(): Promise<
  [string, Record<string, unknown>][]
> {
  const out: [string, Record<string, unknown>][] = [];

  const models = recorder(() => ({ models: [{ id: "opus", name: "Opus" }] }));
  await ensureAvailableModels({
    ...models.conn,
    availableModels: null,
  } as never);
  out.push(...models.calls);

  const gw = fakeGateway({});
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(
    async () => gw as never,
  );
  await discoverAgents(config);
  out.push(...(gw as unknown as FakeGateway).calls);
  return out;
}

/** Bodies built by exported PURE builders — the same treatment lot 17 gave the two
 *  out-of-band `chat.send` sites. These live inside HTTP handlers, so the alternative is
 *  transcribing them here, which tests the transcription. */
function builtBodies(): [string, Record<string, unknown>][] {
  return [
    // `chat.abort` in BOTH shapes: the named run and the "whatever is active" form.
    ["chat.abort", chatAbortParams("agent:alice:atrium:chat:olivier:c1", "run-9")],
    ["chat.abort", chatAbortParams("agent:alice:atrium:chat:olivier:c1", null)],
    // Unvalidatable by construction (no upstream schema) but CAPTURED, so a change to
    // the body is at least visible — raised in review, and the reason NO_PARAMS_SCHEMA
    // exists rather than a silent skip.
    ["sessions.get", sessionsGetParams("agent:alice:atrium:chat:olivier:c1")],
    ["tts.convert", ttsParams("convert", "bonjour")],
    ["tts.status", ttsParams("status", "")],
    ["tts.providers", ttsParams("providers", "")],
    ["tasks.get", taskGetParams("task-7")],
    ["tasks.list", taskListParams("agent:alice:atrium:chat:olivier:c1")],
    // All FOUR talk create shapes. The two optionals are built independently, so
    // voice-only and threshold-only are really sendable — capturing the empty and the
    // both-set cases alone left two valid bodies unvalidated (raised in review).
    ["talk.client.create", talkClientCreateParams("webrtc", null, null)],
    ["talk.client.create", talkClientCreateParams("webrtc", "cedar", null)],
    ["talk.client.create", talkClientCreateParams("webrtc", null, 0.6)],
    ["talk.client.create", talkClientCreateParams("webrtc", "cedar", 0.6)],
    [
      "talk.client.toolCall",
      talkToolCallParams("agent:alice:atrium:chat:olivier:c1", "call-1", {
        question: "où en est le lot ?",
      }),
    ],
  ];
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

/** Captured methods for which upstream publishes NO params schema, so there is nothing to
 *  validate against. Everything else MUST validate.
 *
 *  `usage.status` takes no parameters at all (its handler is `async ({respond}) => …`);
 *  upstream parses `sessions.get` by hand and publishes no schema; and it schematizes only
 *  `tts.speak`, which Atrium never calls. They are captured anyway, so a change to one of
 *  those bodies is at least VISIBLE. */
const NO_PARAMS_SCHEMA = [
  "sessions.get",
  "tts.convert",
  "tts.providers",
  "tts.status",
  "usage.status",
];

/** Validate a set of captured bodies against one version — ONE rule, shared.
 *
 *  Two loops with two different rigours is how the send path kept a silent
 *  `continue`-on-missing-schema after the operator lanes had been tightened (raised in
 *  review): `SessionsPatchParamsSchema` disappearing from a vendored version would have
 *  stayed green there. A guarantee that holds in one loop and not the other is not a
 *  guarantee, so there is now one function and no second opinion. */
async function expectBodiesValid(
  version: string,
  bodies: [string, Record<string, unknown>][],
  label: string,
): Promise<void> {
  const schemas = await schemasOf(version);
  const problems: string[] = [];
  const checked: string[] = [];
  const unschemad = new Set<string>();
  for (const [method, params] of bodies) {
    const schema = schemas.get(paramsSchemaName(method));
    if (schema === undefined) {
      unschemad.add(method);
      continue;
    }
    checked.push(method);
    if (Value.Check(schema as never, params)) continue;
    const first = [...Value.Errors(schema as never, params)][0] as
      | { instancePath?: string; message?: string }
      | undefined;
    problems.push(
      `${method} rejected by ${version}: ${first?.instancePath || "(root)"} ` +
        `${first?.message ?? ""}`,
    );
  }
  // A MISSING schema is LOUD: only the methods upstream gives no schema for may be
  // skipped, and they are NAMED. `continue` alone let a renamed schema leave a body
  // uninspected under a green light.
  expect(
    [...unschemad].sort(),
    `${label}: no params schema in ${version} for these captured bodies — a schema was ` +
      `renamed or dropped, or the method belongs in NO_PARAMS_SCHEMA deliberately`,
  ).toEqual(
    NO_PARAMS_SCHEMA.filter((m) => bodies.some(([x]) => x === m)).sort(),
  );
  // …and every OTHER captured method must actually have been validated. Naming a few was
  // a sample; this is the set.
  expect(
    [...new Set(checked)].sort(),
    `${label}: captured but not validated against ${version}`,
  ).toEqual(
    [...new Set(bodies.map(([m]) => m))]
      .filter((m) => !NO_PARAMS_SCHEMA.includes(m))
      .sort(),
  );
  expect(
    problems,
    `${label}: the bridge sends what ${version} refuses:\n${problems.join("\n")}`,
  ).toEqual([]);
}

/** A `GatewayRequester` that RECORDS every call and answers from a script.
 *
 *  The operator lanes (`/config-defaults`, `/agent-files`) already take this interface,
 *  so their real bodies are capturable without touching production code — the same
 *  discipline as the send path, which is captured through the fake gateway rather than
 *  transcribed. */
function recorder(
  reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
): { conn: GatewayRequester; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    conn: {
      request: async (method, params) => {
        calls.push([method, params]);
        return { payload: reply(method, params) };
      },
    },
  };
}

/** Every OPERATOR-lane body the bridge builds, captured from the real functions.
 *
 *  Each entry drives one op to the point where it SENDS. The scripted replies are the
 *  shapes those paths require to get that far — a config read that carries a hash and
 *  says the file exists, a file read that carries string content — because after lots 20
 *  and 21 both lanes REFUSE to send when the read is unusable, and a refusal captures
 *  nothing. */
async function captureOperatorBodies(): Promise<
  [string, Record<string, unknown>][]
> {
  const out: [string, Record<string, unknown>][] = [];

  // config.get x2 + config.patch (the set path re-reads to confirm), in BOTH shapes.
  //
  // `{raw, baseHash}` on an existing config, and `{raw}` alone when the gateway says the
  // file does not exist yet — the first-run branch the bridge mirrors from the gateway's
  // own `requireConfigBaseHash`. Capturing only the guarded shape left the unguarded one
  // unvalidated (raised in review), and the method-name equality cannot tell two shapes
  // of one RPC apart.
  for (const exists of [true, false]) {
    const cfg = recorder(() => ({
      exists,
      ...(exists ? { hash: "h1" } : {}),
      config: { agents: { defaults: { thinkingDefault: "high", fastModeDefault: true } } },
    }));
    await performConfigDefaultsOp(cfg.conn, {
      op: "set",
      instanceName: null,
      thinkingDefault: "high",
      fastModeDefault: true,
    });
    out.push(...cfg.calls);
  }

  // agents.files.list
  const list = recorder(() => ({
    files: [{ name: "AGENTS.md", path: "/w/AGENTS.md", missing: false, size: 3 }],
  }));
  await performAgentFilesOp(list.conn, {
    op: "list",
    instanceName: null,
    agentId: "alice",
  });
  out.push(...list.calls);

  // agents.files.get
  const file = { name: "AGENTS.md", missing: false, size: 3, updatedAtMs: 42, content: "abc" };
  const get = recorder(() => ({ file }));
  await performAgentFilesOp(get.conn, {
    op: "get",
    instanceName: null,
    agentId: "alice",
    name: "AGENTS.md",
  });
  out.push(...get.calls);

  // agents.files.get (pre-read) + agents.files.set + agents.files.get (confirm)
  const set = recorder((method) =>
    method === "agents.files.set" ? { ok: true } : { file: { ...file, content: "def" } },
  );
  await performAgentFilesOp(set.conn, {
    op: "set",
    instanceName: null,
    agentId: "alice",
    name: "AGENTS.md",
    content: "def",
    baseUpdatedAtMs: 42,
  });
  out.push(...set.calls);

  return out;
}

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
        if (attachments) {
          const sent = calls.find(([m]) => m === "chat.send")?.[1];
          expect(
            Array.isArray(sent?.attachments),
            "the attachment branch did not run — this case validates nothing",
          ).toBe(true);
        }
        // The body this gate exists for, NAMED: `checked.length > 0` was satisfiable by
        // two incidental `sessions.*` calls while `chat.send` went unchecked.
        expect(
          calls.map(([m]) => m),
          `chat.send was never captured for ${version}`,
        ).toContain("chat.send");
        await expectBodiesValid(version, calls, `send path (${shape})`);
      });
    }
  }

  /** Every method this suite is expected to have CAPTURED a body for.
   *
   *  Asserted as an EQUALITY, not a `toContain` list. A builder that stops being
   *  exercised — a handler refactor, a refusal path taken earlier than intended — would
   *  otherwise leave the suite green while validating nothing: the same lesson as
   *  `MUST_BE_ENUMERATED` in the scope test, applied to captures. A method leaving this
   *  list must be a decision.
   *
   *  DECLARED ABSENCES, and why. `sessions.reset` and `sessions.compact` build their
   *  bodies inline on the TURN path (server.ts). Extracting them means editing the turn
   *  path, which every lot of this wave has refused to do for a test's convenience — so
   *  those two bodies are unvalidated, and that is stated here rather than left to be
   *  discovered. They are also the simplest bodies the bridge sends (`{key}`, plus a
   *  reason literal), which is why the trade is acceptable and not merely convenient.
   *
   *  CORRECTED after review: this list also named `sessions.compaction.list`, which is
   *  NOT on the turn path — `fetchCompactionHistory` is a helper taking a connection, so
   *  it captures like the cron handlers. An absence declared out of habit is still an
   *  absence nobody checked. */
  const EXPECTED_CAPTURED = [
    "agents.files.get",
    "agents.files.list",
    "agents.files.set",
    "agents.list",
    "chat.abort",
    "chat.send",
    "config.get",
    "config.patch",
    "cron.get",
    "cron.list",
    "cron.remove",
    "cron.run",
    "cron.runs",
    "cron.update",
    "models.list",
    "sessions.compaction.list",
    "sessions.describe",
    "sessions.get",
    "sessions.patch",
    "talk.client.create",
    "talk.client.toolCall",
    "tasks.get",
    "tasks.list",
    "tts.convert",
    "tts.providers",
    "tts.status",
    "usage.status",
  ];

  it("every lane this gate claims to cover really produced a body", async () => {
    const captured = new Set<string>();
    for (const [m] of await captureOutboundBodies()) captured.add(m);
    for (const [m] of await captureOperatorBodies()) captured.add(m);
    for (const [m] of await captureCronBodies()) captured.add(m);
    for (const [m] of await captureDiscoveryBodies()) captured.add(m);
    for (const [m] of await captureUnsetBodies()) captured.add(m);
    for (const [m] of builtBodies()) captured.add(m);
    expect(
      [...captured].sort(),
      "the set of captured methods changed — a builder stopped being exercised, or a " +
        "new lane needs adding to EXPECTED_CAPTURED deliberately",
    ).toEqual([...EXPECTED_CAPTURED].sort());
  });

  it("every builder-backed call site still USES its builder", () => {
    // The residual hole in the whole builder approach, and the last one review found: this
    // suite validates what the BUILDERS produce, and nothing tied a builder to the handler
    // that is supposed to call it. A handler rewritten to assemble its object inline —
    // with one extra field — would ship an invalid body while the ratchet went on checking
    // a function nobody calls.
    //
    // So the source is swept: every call site of a builder-backed method must pass the
    // BUILDER's result as its params, not an object literal. FAIL-CLOSED — an unrecognised
    // params expression is a failure, not a pass, because "it doesn't look like an object
    // literal" is not the same as "it comes from the builder".
    const BUILDER_BACKED: Record<string, string> = {
      "chat.abort": "chatAbortParams",
      "sessions.get": "sessionsGetParams",
      "tasks.get": "taskGetParams",
      "tasks.list": "taskListParams",
      "talk.client.create": "talkClientCreateParams",
      "talk.client.toolCall": "talkToolCallParams",
    };
    const offenders: string[] = [];
    let seen = 0;
    for (const site of requestCallSites()) {
      const builder = site.method === null ? null : BUILDER_BACKED[site.method];
      if (!builder) continue;
      seen += 1;
      if (!(site.params ?? "").startsWith(`${builder}(`)) {
        offenders.push(
          `${site.file}: ${site.method} params are \`${site.params}\`, not ${builder}(…)`,
        );
      }
    }
    // Every builder must actually BE called somewhere, or it is dead code the ratchet is
    // proudly validating.
    const called = new Set(
      requestCallSites()
        .map((x) => x.method)
        .filter((m): m is string => m !== null && m in BUILDER_BACKED),
    );
    expect(
      [...called].sort(),
      "a builder-backed method is no longer called anywhere — remove the builder or the " +
        "entry, deliberately",
    ).toEqual(Object.keys(BUILDER_BACKED).sort());
    expect(seen, "no builder-backed call site was found at all").toBeGreaterThanOrEqual(
      Object.keys(BUILDER_BACKED).length,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("EVERY indirect call site is builder-backed, and there is exactly one", () => {
    // Indirect sites are keyed by EXPRESSION, not by method name, so the sweep above
    // cannot see them. The first version of this check used `.find()` — it inspected the
    // FIRST matching site, so a second `` conn.request(`tts.${method}`, {…}) `` built
    // inline would have been silently skipped while the first, correct one satisfied it
    // (raised in review). That is the very hole the builder sweep exists to close, so:
    // ALL indirect sites, and their COUNT.
    //
    // And each is bound to ITS builder BY NAME. A regex accepting any `*Params(` call was
    // the same mistake one level down (raised in review): swapping the production call to
    // `otherParams(method, text)` — a builder that adds an invalid field — would have
    // satisfied it while the ratchet went on validating `ttsParams`. The pairing is the
    // point, so the pairing is what is asserted.
    const INDIRECT_BUILDER: Record<string, string> = {
      "server.ts: `tts.${method}`": "ttsParams",
    };
    const indirect = requestCallSites().filter((x) => x.method === null);
    // One today: the `/tts` passthrough. A new one is a decision — it needs a builder and
    // an entry in the rpc-scope expansion map, so it must not slip in unnoticed.
    expect(
      indirect.map((x) => `${x.file}: ${x.expression}`).sort(),
      "the set of INDIRECT gateway calls changed",
    ).toEqual(Object.keys(INDIRECT_BUILDER).sort());
    const offenders = indirect.filter((x) => {
      const builder = INDIRECT_BUILDER[`${x.file}: ${x.expression}`];
      return !builder || !(x.params ?? "").startsWith(`${builder}(`);
    });
    expect(
      offenders.map(
        (x) =>
          `${x.file}: ${x.expression} params are \`${x.params}\`, not ` +
          `${INDIRECT_BUILDER[`${x.file}: ${x.expression}`] ?? "(undeclared)"}(…)`,
      ),
      "an indirect call site does not build its params through ITS declared builder",
    ).toEqual([]);
  });

  it("every body with OPTIONAL fields is captured in each of its shapes", async () => {
    // The method-name equality cannot tell two shapes of one RPC apart, and three
    // separate review findings were exactly that: a cron patch branch, a config patch
    // without its hash, a talk create with one optional. So the variants are asserted
    // here, together, by the KEY SETS actually captured.
    const keysFor = (
      bodies: [string, Record<string, unknown>][],
      method: string,
    ): string[] =>
      bodies
        .filter(([m]) => m === method)
        .map(([, p]) => Object.keys(p).sort().join("+"));

    const operator = await captureOperatorBodies();
    const patchShapes = new Set(keysFor(operator, "config.patch"));
    expect(
      [...patchShapes].sort(),
      "config.patch must be captured guarded AND unguarded (the first-run branch)",
    ).toEqual(["raw", "baseHash+raw"].sort());

    const talkShapes = new Set(keysFor(builtBodies(), "talk.client.create"));
    expect(
      [...talkShapes].sort(),
      "talk.client.create builds its two optionals independently — all four shapes must " +
        "be captured",
    ).toEqual(
      [
        "transport",
        "transport+voice",
        "transport+vadThreshold",
        "transport+vadThreshold+voice",
      ].sort(),
    );

    // `chat.abort` has one optional: with and without the named run.
    expect(
      new Set(keysFor(builtBodies(), "chat.abort")).size,
      "chat.abort must be captured with AND without runId",
    ).toBe(2);
  });

  it("the sessions.patch UNSET branch really ran", async () => {
    // Like the cron branches: a `{key, model: null}` body is as valid as a
    // `{key, model: "opus"}` one, so the methods-captured equality cannot see the unset
    // shape going missing. Assert the shape itself.
    const unsets = await captureUnsetBodies();
    expect(unsets.map(([m]) => m)).toEqual([
      "sessions.patch",
      "sessions.patch",
      "sessions.patch",
    ]);
    for (const field of ["model", "thinkingLevel", "fastMode"]) {
      expect(
        unsets.some(([, p]) => p[field] === null),
        `the unset of ${field} was never sent`,
      ).toBe(true);
    }
  });

  it("the cron.update BRANCHES really ran", async () => {
    // `cron.update` is the only captured body whose shape depends on user input, so the
    // methods-captured equality above cannot see a branch going missing: both payload
    // families produce a VALID body, and neutralising one left the suite green. The
    // branch coverage therefore needs its own assertion — the same treatment the
    // attachment branch of `chat.send` already gets.
    const patches = (await captureCronBodies())
      .filter(([m]) => m === "cron.update")
      .map(([, p]) => p.patch as Record<string, unknown>);
    const kinds = patches
      .map((p) => (p.payload as { kind?: unknown } | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
    expect(kinds, "the agentTurn payload branch did not run").toContain("agentTurn");
    expect(kinds, "the systemEvent payload branch did not run").toContain("systemEvent");
    const scheduleKinds = patches
      .map((p) => (p.schedule as { kind?: unknown } | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
    for (const k of ["cron", "at", "every"]) {
      expect(scheduleKinds, `the ${k} schedule branch did not run`).toContain(k);
    }
    // …and the two scalar edits, which take neither branch.
    expect(
      patches.some((p) => typeof p.name === "string"),
      "the name edit did not run",
    ).toBe(true);
    expect(
      patches.some((p) => typeof p.enabled === "boolean"),
      "the enabled edit did not run",
    ).toBe(true);
  });

  for (const version of vendoredVersions()) {
    it(`the operator, cron and built bodies validate against ${version}`, async () => {
      const bodies = [
        ...(await captureOperatorBodies()),
        ...(await captureCronBodies()),
        ...(await captureDiscoveryBodies()),
        ...(await captureUnsetBodies()),
        ...builtBodies(),
      ];
      // The WRITE bodies, named: an incidental read would otherwise satisfy the loop.
      for (const m of [
        "config.patch",
        "cron.update",
        "agents.files.set",
        "talk.client.create",
        "sessions.compaction.list",
      ]) {
        expect(
          bodies.map(([x]) => x),
          `${m} was never captured for ${version}`,
        ).toContain(m);
      }
      await expectBodiesValid(version, bodies, "operator/cron/built");
    });
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
