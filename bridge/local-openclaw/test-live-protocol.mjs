#!/usr/bin/env node
// LIVE-PROTOCOL suite (task LIVE-CI, local runner): deterministic, no-LLM
// regression net over the bridge<->gateway protocol surface, against a REAL
// pinned OpenClaw gateway. Complements the unit suites: units pin parsing and
// policy in isolation; THIS pins the actual wire behavior per gateway version,
// so a gateway/bridge upgrade cannot silently regress a user-visible feature.
//
// Expectations are DERIVED FROM THE COMPAT MANIFEST (dist/compat.js): for the
// version under test, every capability the manifest declares true must work on
// the wire and every capability declared false must fail GRACEFULLY (bounded
// error, bridge alive). The manifest is therefore CI-tested, not declarative.
//
// Usage (the .sh wrapper boots the bench + bridge then runs this):
//   node test-live-protocol.mjs --version 2026.6.5
// Env: BRIDGE_URL (default http://127.0.0.1:18901), SHARED_SECRET, expects the
// bridge ALREADY RUNNING against the bench gateway (wrapper's job).
//
// No LLM: the gateway runs UNCONFIGURED (no model/auth), so agent turns fail
// deterministically — the suite asserts the protocol pipeline (session open,
// version capture, ingest ops, error classification), never model output.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const VERSION = args.version;
if (!VERSION) {
  console.error("usage: test-live-protocol.mjs --version <openclaw-version>");
  process.exit(2);
}
const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:18901";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "proto-shared-secret";
const STUB_FILE = process.env.INGEST_LOG ?? "/tmp/proto-ingest.jsonl";

// The compat manifest is the oracle: capability expectations per version.
const compat = await import(new URL("../dist/compat.js", import.meta.url));
const { BRIDGE_VERSION, PROTOCOL_VERSION, COMPAT_MANIFEST, resolveCapabilities } =
  compat;
const resolved = resolveCapabilities("openclaw", VERSION);
const can = (key) => resolved.capabilities[key] === true;

// --- tiny harness ------------------------------------------------------------
let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failures++;
    results.push(`  ❌ ${name}\n     ${err?.message ?? err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: got ${a}, want ${e}`);
}
async function http(method, path, { body, auth } = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(auth !== undefined ? { Authorization: auth } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON tolerated; callers assert on status first */
  }
  return { status: res.status, json };
}
const get = (path, opts) => http("GET", path, opts);
const post = (path, body, auth = SHARED_SECRET) =>
  http("POST", path, { body, auth });

/** Ingest ops the stub recorded (one JSON per line, written by the stub). */
function ingestOps() {
  try {
    return readFileSync(STUB_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// --- the suite ---------------------------------------------------------------
const CHAT = "proto-chat-1";
const CANONICAL = "proto-user";
let agentId = null; // discovered in C3, used by every routed call after

console.log(`════ live-protocol — OpenClaw ${VERSION} — bridge ${BRIDGE_URL} ════`);
console.log(
  `manifest: bridge ${BRIDGE_VERSION} proto ${PROTOCOL_VERSION} — resolved caps: ` +
    Object.entries(resolved.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(",") +
    (resolved.versionBeyondValidated ? " [BEYOND VALIDATED]" : ""),
);

await check("C1 /health: shape + bridge/protocol versions", async () => {
  const { status, json } = await get("/health");
  assert(status === 200, `status ${status}`);
  assertEq(json.bridgeVersion, BRIDGE_VERSION, "bridgeVersion");
  assertEq(json.protocolVersion, PROTOCOL_VERSION, "protocolVersion");
  assert(Array.isArray(json.targets), "targets must be an array");
});

await check("C2 /capabilities cold: legacy verbatim + manifest + no targets", async () => {
  const { status, json } = await get("/capabilities");
  assert(status === 200, `status ${status}`);
  // Legacy fields VERBATIM (the Convex health poller contract).
  assertEq(
    Object.keys(json.capabilities).sort(),
    ["abort", "agentDiscovery", "attachments", "history", "kind", "media", "streaming"],
    "legacy capability keys",
  );
  assertEq(json.capabilities.kind, "openclaw", "kind");
  // Additive contract: the manifest ships verbatim.
  assertEq(json.compat, COMPAT_MANIFEST, "compat manifest");
  assertEq(json.targets, [], "targets before any session");
});

await check("C3 /agents: discovery returns >=1 normalized agent", async () => {
  const { status, json } = await get("/agents", { auth: SHARED_SECRET });
  assert(status === 200, `status ${status}`);
  assert(json.ok === true, `ok ${JSON.stringify(json)}`);
  assert(json.count >= 1, `count ${json.count}`);
  const def = json.agents.find((a) => a.isDefaultOnInstance) ?? json.agents[0];
  assert(typeof def.agentId === "string" && def.agentId.length > 0, "agentId");
  agentId = def.agentId;
});

await check("C3b /capabilities: served-instance target present after discovery, NO chat session (BUG-1)", async () => {
  // Discovery (C3) connected to the gateway and the bridge captured its
  // version at handshake. The served instance must now appear in
  // /capabilities WITHOUT any live chat session — otherwise a supported
  // gateway gates AgentFiles/ChatDefaults as "unknown version".
  const { json } = await get("/capabilities");
  const served = (json.targets ?? []).find(
    (t) => t.gatewayVersion === VERSION,
  );
  assert(
    served !== undefined,
    `no served-instance target carrying gatewayVersion ${VERSION} (targets: ${JSON.stringify(json.targets)})`,
  );
  // Capabilities resolve to the manifest's verdict for THIS version (no live
  // session needed). E.g. on 2026.6.5 agentFiles/configDefaults are true; on
  // 2026.5.19 they are false — the point is the version is KNOWN, not unknown.
  assertEq(served.capabilities, resolved.capabilities, "resolved caps for served instance");
});

await check("C4 auth: wrong secret -> 401 on /agents and /send", async () => {
  const a = await get("/agents", { auth: "nope" });
  assertEq(a.status, 401, "/agents status");
  const s = await http("POST", "/send", { body: {}, auth: "nope" });
  assertEq(s.status, 401, "/send status");
});

await check("C5 /send: routed send opens the session (turn may fail, no LLM)", async () => {
  const { status, json } = await post("/send", {
    chatId: CHAT,
    openclawChatId: null,
    text: "ping (live-protocol, deterministic no-LLM turn)",
    clientMessageId: "proto-msg-1",
    agentId,
    canonical: CANONICAL,
  });
  // Without a configured model the TURN fails, but the protocol must stay
  // bounded: either the ack path succeeded (200) or a classified 502 — never
  // a hang, never a crash.
  assert(
    status === 200 || status === 502,
    `status ${status} ${JSON.stringify(json)}`,
  );
  if (status === 502) {
    assert(typeof json?.error?.code === "string", "classified error code");
  }
});

await check("C6 /capabilities: live target with captured version + resolved caps", async () => {
  await waitFor("session target", async () => {
    const { json } = await get("/capabilities");
    return (json.targets ?? []).length > 0;
  });
  const { json } = await get("/capabilities");
  assertEq(json.targets.length, 1, "one deduped target");
  const t = json.targets[0];
  assertEq(t.key, CANONICAL, "target key = canonical");
  assertEq(t.agentId, agentId, "target agentId");
  assertEq(t.provider, "openclaw", "provider");
  // THE version oracle: the gateway must report the exact pinned version and
  // the projected capabilities must equal the manifest resolution for it.
  assertEq(t.gatewayVersion, VERSION, "captured gatewayVersion");
  assertEq(t.capabilities, resolved.capabilities, "resolved capabilities");
  if (!resolved.versionBeyondValidated) {
    assert(
      !("versionBeyondValidated" in t),
      "versionBeyondValidated key must be OMITTED when false",
    );
  } else {
    assertEq(t.versionBeyondValidated, true, "versionBeyondValidated flag");
  }
});

await check("C7 /health: live target carries the gateway version", async () => {
  const { json } = await get("/health");
  const t = (json.targets ?? []).find((x) => x.gatewayVersion !== null);
  assert(t !== undefined, "a /health target with gatewayVersion");
  assertEq(t.gatewayVersion, VERSION, "health gatewayVersion");
});

await check("C8 ingest: send produced startAssistant + finalize (stub)", async () => {
  // 60s window: on 2026.6.5 the codex app-server lifecycle (startup -> idle
  // watchdog) takes ~20-25s to error out a no-LLM turn — observed live.
  await waitFor(
    "finalize op",
    async () => ingestOps().some((o) => o.op === "finalize"),
    60_000,
  );
  const ops = ingestOps();
  const start = ops.find((o) => o.op === "startAssistant");
  assert(start !== undefined, "startAssistant recorded");
  assertEq(start.chatId, CHAT, "startAssistant chatId");
  const fin = ops.find((o) => o.op === "finalize");
  // No-LLM turn: terminal status must be bounded (error is the expected
  // outcome on an unconfigured gateway; complete would mean a model ran).
  assert(
    ["error", "complete", "aborted"].includes(fin.status),
    `finalize status ${fin.status}`,
  );
});

await check("C9 /patch: set thinkingLevel (capability knobThinkingLevel)", async () => {
  const { status, json } = await post("/patch", {
    chatId: CHAT,
    agentId,
    canonical: CANONICAL,
    sessionSettings: { thinkingLevel: "low" },
  });
  if (can("knobThinkingLevel")) {
    assertEq(status, 200, `status (caps say supported) ${JSON.stringify(json)}`);
    assertEq(json.ok, true, "ok");
  } else {
    assert(status !== 200, "must not claim success below the floor");
  }
});

await check("C10 /patch: unset via clears (capability knobUnset)", async () => {
  const { status, json } = await post("/patch", {
    chatId: CHAT,
    agentId,
    canonical: CANONICAL,
    sessionSettings: { clears: ["thinkingLevel"] },
  });
  if (can("knobUnset")) {
    assertEq(status, 200, `status (caps say supported) ${JSON.stringify(json)}`);
  } else {
    // Below the capability floor: graceful bounded outcome, bridge must
    // survive (checked by the final health probe).
    assert([200, 502].includes(status), `bounded status, got ${status}`);
  }
});

await check("C11 /patch: clears outside the allowlist -> 400", async () => {
  const { status } = await post("/patch", {
    chatId: CHAT,
    agentId,
    canonical: CANONICAL,
    sessionSettings: { clears: ["notAKnob"] },
  });
  assertEq(status, 400, "status");
});

await check("C12 instance guard: foreign instanceName -> 409 instance_mismatch", async () => {
  const p = await post("/patch", {
    chatId: CHAT,
    agentId,
    canonical: CANONICAL,
    instanceName: "not-this-bridge",
    sessionSettings: { thinkingLevel: "low" },
  });
  assertEq(p.status, 409, "/patch status");
  assertEq(p.json.error.code, "instance_mismatch", "/patch code");
  const c = await post("/config-defaults", {
    op: "get",
    instanceName: "not-this-bridge",
  });
  assertEq(c.status, 409, "/config-defaults status");
});

await check("C13 /send: missing routing -> 400 invalid body", async () => {
  const { status } = await post("/send", {
    chatId: CHAT,
    text: "x",
    clientMessageId: "proto-bad-1",
  });
  assertEq(status, 400, "status");
});

await check(`C14 /agent-files: ${can("agentFiles") ? "CAS round-trip + 409" : "graceful below floor"}`, async () => {
  const fileBody = (op, extra = {}) => ({
    op,
    agentId,
    name: "AGENTS.md",
    ...extra,
  });
  if (!can("agentFiles")) {
    const { status } = await post("/agent-files", fileBody("get"));
    assert(status !== 200 || true, "reachable"); // bounded; alive checked at the end
    assert([200, 404, 502].includes(status), `bounded status, got ${status}`);
    return;
  }
  const before = await post("/agent-files", fileBody("get"));
  assertEq(before.status, 200, `get status ${JSON.stringify(before.json)}`);
  assert(!("path" in (before.json.file ?? {})), "path must NEVER leak");
  const baseMs = before.json.file?.updatedAtMs ?? null;
  // Stale CAS base -> 409 CONFLICT (the concurrent-edit guard).
  const stale = await post(
    "/agent-files",
    fileBody("set", { content: "# proto", baseUpdatedAtMs: 1 }),
  );
  assertEq(stale.status, 409, "stale CAS status");
  assertEq(stale.json.error.code, "CONFLICT", "stale CAS code");
  // baseUpdatedAtMs:null on an EXISTING file -> 409 too (review #14 P2: null means
  // "I expect it still MISSING" = the create path, NOT "skip CAS / overwrite").
  // Per-version guard against the concurrent-create clobber regression.
  // Side-effect-free: 409 returns BEFORE any agents.files.set.
  const nullOnExisting = await post(
    "/agent-files",
    fileBody("set", { content: "# must-not-write", baseUpdatedAtMs: null }),
  );
  assertEq(nullOnExisting.status, 409, "null-on-existing CAS status");
  assertEq(nullOnExisting.json.error.code, "CONFLICT", "null-on-existing CAS code");
  // Fresh CAS -> write goes through; then restore the original content.
  const marker = `# live-protocol marker ${Date.now()}\n`;
  const write = await post(
    "/agent-files",
    fileBody("set", { content: marker, baseUpdatedAtMs: baseMs }),
  );
  assertEq(write.status, 200, `set status ${JSON.stringify(write.json)}`);
  const after = await post("/agent-files", fileBody("get"));
  assertEq(after.json.file?.content, marker, "round-trip content");
  const restore = await post(
    "/agent-files",
    fileBody("set", {
      content: before.json.file?.content ?? "",
      baseUpdatedAtMs: after.json.file?.updatedAtMs ?? null,
    }),
  );
  assertEq(restore.status, 200, "restore status");
});

await check(`C15 /config-defaults: ${can("configDefaults") ? "get/set round-trip" : "graceful below floor"}`, async () => {
  if (!can("configDefaults")) {
    const { status } = await post("/config-defaults", { op: "get" });
    assert([200, 404, 502].includes(status), `bounded status, got ${status}`);
    return;
  }
  const before = await post("/config-defaults", { op: "get" });
  assertEq(before.status, 200, `get status ${JSON.stringify(before.json)}`);
  const set = await post("/config-defaults", {
    op: "set",
    thinkingDefault: "low",
  });
  assertEq(set.status, 200, `set status ${JSON.stringify(set.json)}`);
  const after = await post("/config-defaults", { op: "get" });
  assertEq(after.json.defaults?.thinkingDefault, "low", "round-trip value");
  // Restore (null base value when it was unset is fine: set only what existed).
  if (before.json.defaults?.thinkingDefault) {
    await post("/config-defaults", {
      op: "set",
      thinkingDefault: before.json.defaults.thinkingDefault,
    });
  }
});

await check(`C16 /compact: ${can("sessionCompact") ? "bounded outcome on a live session" : "graceful below floor"}`, async () => {
  const { status, json } = await post("/compact", {
    chatId: CHAT,
    agentId,
    canonical: CANONICAL,
  });
  // A near-empty no-LLM session may legitimately refuse to compact; the
  // contract under test is BOUNDED behavior (200 or classified 502), not
  // compaction success — that needs an LLM-bearing session (stability bench).
  assert(
    [200, 502].includes(status),
    `bounded status, got ${status} ${JSON.stringify(json)}`,
  );
  if (status === 502) {
    assert(typeof json?.error?.code === "string", "classified error code");
  }
});

await check("C18 provenance contract: plugin reports become kind:provenance ingest parts", async () => {
  // The provenance-probe plugin (installed by the wrapper) emits TWO
  // deterministic provenance/v1 reports per turn on its gateway-scoped stream
  // "provenance-probe.provenance" — the EXACT contract real memory/document
  // plugins implement. The bridge must turn them into addPart ops with
  // kind:"provenance" on this turn's assistant message.
  let gatewayLog = "";
  try {
    gatewayLog = execSync("docker logs oc-local-gateway --since 10m 2>&1", {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    /* docker unavailable: fall through to the data assertion below */
  }
  const probeEmitted = gatewayLog.includes("[provenance-probe] emitted");
  const sdkLacks = gatewayLog.includes("[provenance-probe] sdk-lacks-emitAgentEvent");
  const provParts = ingestOps()
    .filter((o) => o.op === "addPart" && o.part?.kind === "provenance")
    .map((o) => o.part);
  if (sdkLacks) {
    // Old plugin SDK: the contract DEGRADES to silence — no parts, no error.
    assertEq(provParts.length, 0, "no parts on a no-emit gateway");
    return;
  }
  assert(probeEmitted, "probe never emitted (plugin not loaded?)");
  await waitFor(
    "provenance ingest parts",
    async () =>
      ingestOps().filter((o) => o.op === "addPart" && o.part?.kind === "provenance")
        .length >= 2,
    15_000,
  );
  const parts = ingestOps()
    .filter((o) => o.op === "addPart" && o.part?.kind === "provenance")
    .map((o) => o.part);
  const groups = parts.map((p) => p.group).sort();
  assertEq(groups, ["documents", "memory"], "one part per probe report group");
  for (const p of parts) {
    assertEq(p.v, 1, "contract version");
    assertEq(p.pluginId, "provenance-probe", "gateway-stamped emitter");
    assert(Array.isArray(p.items) && p.items.length > 0, "items present");
  }
  const memory = parts.find((p) => p.group === "memory");
  assertEq(memory.items[0].id, "mem_bench_001", "deterministic memory item");
  const docs = parts.find((p) => p.group === "documents");
  assertEq(docs.items[0].file_name, "bench-compliance-report.pdf", "deterministic doc item");
  assertEq(docs.retrieval?.lightragMode, "mix", "lightrag mode lifted");
});

await check("C17 final: bridge alive and consistent after the whole run", async () => {
  const { status, json } = await get("/health");
  assertEq(status, 200, "health status");
  assertEq(json.bridgeVersion, BRIDGE_VERSION, "bridgeVersion stable");
  const caps = await get("/capabilities");
  assertEq(caps.json.compat, COMPAT_MANIFEST, "manifest stable");
});

// --- report ------------------------------------------------------------------
console.log(results.join("\n"));
console.log(
  failures === 0
    ? `════ ✅ live-protocol PASS — ${results.length} checks, OpenClaw ${VERSION} ════`
    : `════ ❌ live-protocol FAIL — ${failures}/${results.length} checks failed, OpenClaw ${VERSION} ════`,
);
process.exit(failures === 0 ? 0 : 1);
