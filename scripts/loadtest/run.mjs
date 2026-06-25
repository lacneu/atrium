// Atrium load harness (Phase 1) — characterize headroom under concurrency.
//
// Provisions a seeded agent catalogue across M instances, spawns R authed
// ConvexClient "browsers" (each subscribing to the hot reactive queries
// listChats / getChatAgent / listByChat / getStreamingText on its C chats), then
// drives synthetic /bridge/ingest streams (startAssistant -> K deltas -> finalize)
// concurrently across every chat. NO gateway, NO model tokens -- it hits the ingest
// contract, so it is OpenClaw/Hermes-agnostic.
//
// Measures: end-to-end first-delta + finalize latency percentiles, reactive re-runs
// per subscriber during the write burst, and ingest errors. The first run is a
// hypothesis test (the emergent suspects: re-run fan-out, scheduler/queue, OCC) --
// finding "nothing dramatic" at a target scale is a PASS (headroom characterization).
//
// Usage (local dev stack from `bash dev.sh`):
//   node scripts/loadtest/run.mjs --users 5 --chats 3 --agents 300 --instances 2 --deltas 20
import {
  api,
  parseArgs,
  authedClient,
  ingest,
  nowMs,
  sleep,
  summarize,
} from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const CFG = {
  apiUrl: a.url || process.env.CONVEX_URL || "http://127.0.0.1:3212",
  siteUrl: a.site || process.env.CONVEX_SITE_URL || "http://127.0.0.1:3213",
  secret: a.secret || process.env.BRIDGE_INGEST_SECRET || "devingest",
  users: Number(a.users ?? 5),
  chats: Number(a.chats ?? 3),
  agents: Number(a.agents ?? 300),
  instances: Number(a.instances ?? 2),
  deltas: Number(a.deltas ?? 20),
  // Pad each delta to N chars (0 = the ~6-char `tokK `). Amplifies the streaming
  // TEXT growth toward realistic response sizes (e.g. --deltas 120 --deltaChars 12
  // ≈ a ~1.4k-char reply) so the O(n^2) write/push shows clearly.
  deltaChars: Number(a.deltaChars ?? 0),
  deltaMs: Number(a.deltaMs ?? 40),
  settleMs: Number(a.settleMs ?? 1500),
};

const log = (...m) => console.log(...m);
// Shared metrics (single process: subscriber callbacks + driver share these).
const turns = new Map(); // chatId -> { startAt, finalizeAt, firstDeltaAt, finalSeenAt, cumBytes, lastLen, updates }
const reruns = new Map(); // userId -> count (onUpdate callbacks during the drive)
// Per-appendDelta WRITE latency tagged by its position in the turn (0..1). A late
// delta slower than an early one = O(n)-per-delta write growth -> O(n^2) per turn
// (the streamingText row is rewritten in full each delta in the pre-fix code).
const appendLat = []; // [{ pos, ms }]
let driving = false; // only count re-runs once the write burst starts
const errors = [];

async function provision(admin) {
  // Seed the agent catalogue across M instances so a groupless user's listChats /
  // getChatAgent resolve the all-pool (the path the Phase-0 fix made single-collect).
  // Clean each instance FIRST (seedAgentCatalogue blind-inserts) so re-runs don't
  // accumulate a growing catalogue that would skew the headroom numbers.
  const perInstance = Math.ceil(CFG.agents / CFG.instances);
  for (let m = 0; m < CFG.instances; m++) {
    const instanceName = `lt-inst-${m}`;
    for (let guard = 0; guard < 50; guard++) {
      const r = await admin.mutation(api.dev.deleteAgentsByInstance, {
        instanceName,
        max: 2000,
      });
      if (!r.moreLikely) break;
    }
    let remaining = perInstance;
    let offset = 0;
    while (remaining > 0) {
      const count = Math.min(remaining, 2000); // under the 16k-writes / 4096-read caps
      await admin.mutation(api.dev.seedAgentCatalogue, {
        instanceName,
        count,
        offset,
      });
      remaining -= count;
      offset += count;
    }
  }
  log(`provisioned ${CFG.agents} agents across ${CFG.instances} instance(s)`);
}

async function spawnSubscriber(i) {
  const { client, userId } = await authedClient(CFG.apiUrl);
  reruns.set(userId, 0);
  const bump = () => {
    if (driving) reruns.set(userId, (reruns.get(userId) ?? 0) + 1);
  };
  const instanceName = `lt-inst-${i % CFG.instances}`;
  const { chatIds } = await client.mutation(api.dev.seedChatsForUser, {
    userId,
    count: CFG.chats,
    instanceName,
    agentId: "bench-0",
  });
  for (const chatId of chatIds) {
    turns.set(chatId, {});
  }

  // User-level hot queries (re-run when any chat in the window bumps updatedAt).
  client.onUpdate(api.messages.listChats, {}, bump);
  if (chatIds[0]) client.onUpdate(api.agents.getChatAgent, { chatId: chatIds[0] }, bump);

  // Per-chat: getStreamingText catches the FIRST delta; listByChat catches finalize.
  for (const chatId of chatIds) {
    client.onUpdate(api.messages.getStreamingText, { chatId }, (rows) => {
      bump();
      const t = turns.get(chatId);
      if (!t) return;
      // Total live-text length THIS push delivered (sum across rows). Convex re-pushes
      // the full query result on every change, so cumBytes = Σ(growing length) over
      // updates. cumBytes / finalLen ≈ 1 means incremental delivery; ≈ K/2 means the
      // full growing text is re-sent each delta (the O(n^2) the fix must kill).
      const len = (rows ?? []).reduce((s, r) => s + (r.text ?? "").length, 0);
      t.cumBytes = (t.cumBytes ?? 0) + len;
      t.updates = (t.updates ?? 0) + 1;
      // maxLen, NOT lastLen: finalize deletes the streamingText row, so the final
      // push delivers len=0 — using it as the denominator would zero the ratio.
      t.maxLen = Math.max(t.maxLen ?? 0, len);
      if (t.firstDeltaAt == null && len > 0) t.firstDeltaAt = nowMs();
    });
    client.onUpdate(api.messages.listByChat, { chatId }, (msgs) => {
      bump();
      const t = turns.get(chatId);
      if (t && t.finalSeenAt == null) {
        const done = msgs?.some((m) => m.role === "assistant" && m.status === "complete");
        if (done) t.finalSeenAt = nowMs();
      }
    });
  }
  return { client, userId, chatIds };
}

async function driveTurn(chatId) {
  const t = turns.get(chatId);
  try {
    t.startAt = nowMs();
    const { messageId } = await ingest(CFG.siteUrl, CFG.secret, {
      op: "startAssistant",
      chatId,
      runId: `lt-${chatId}`,
    });
    for (let k = 0; k < CFG.deltas; k++) {
      const base = `tok${k} `;
      const text =
        CFG.deltaChars > 0 ? base.padEnd(CFG.deltaChars, "x") : base;
      const a0 = nowMs();
      await ingest(CFG.siteUrl, CFG.secret, {
        op: "appendDelta",
        messageId,
        text,
      });
      appendLat.push({ pos: k / CFG.deltas, ms: nowMs() - a0 });
      if (CFG.deltaMs) await sleep(CFG.deltaMs);
    }
    // Stamp BEFORE the await (same convention as startAt): the mutation commits and
    // pushes the reactive listByChat update BEFORE the HTTP Response returns, so
    // finalSeenAt (set by that push) can PRECEDE a post-await timestamp -> negative /
    // underestimated finalize latency. Measure from request-sent -> reflected.
    t.finalizeAt = nowMs();
    await ingest(CFG.siteUrl, CFG.secret, {
      op: "finalize",
      messageId,
      status: "complete",
      text: Array.from({ length: CFG.deltas }, (_, k) => `tok${k}`).join(" "),
    });
  } catch (e) {
    errors.push(String(e?.message ?? e).slice(0, 160));
  }
}

async function main() {
  log("=== Atrium load harness ===", JSON.stringify(CFG));
  const t0 = nowMs();

  // An admin client for provisioning (first anon user usually bootstraps admin; any
  // active user can call the dev-gated seeders).
  const admin = await authedClient(CFG.apiUrl);
  await provision(admin.client);

  log(`spawning ${CFG.users} subscribers (${CFG.chats} chats each)…`);
  const subs = [];
  for (let i = 0; i < CFG.users; i++) subs.push(await spawnSubscriber(i));
  const allChats = subs.flatMap((s) => s.chatIds);
  log(`subscribed: ${subs.length} users, ${allChats.length} chats, settling…`);
  await sleep(CFG.settleMs); // let initial query results land before counting re-runs

  // The write burst: every chat's turn fired CONCURRENTLY.
  log(`driving ${allChats.length} concurrent turns × ${CFG.deltas} deltas…`);
  driving = true;
  const driveStart = nowMs();
  await Promise.all(allChats.map(driveTurn));
  await sleep(CFG.settleMs); // let the final reactive updates propagate
  const driveMs = nowMs() - driveStart;

  // Metrics.
  const firstDelta = [];
  const finalize = [];
  let firstDeltaSeen = 0;
  let finalizeSeen = 0;
  for (const t of turns.values()) {
    if (t.firstDeltaAt != null && t.startAt != null) {
      firstDelta.push(t.firstDeltaAt - t.startAt);
      firstDeltaSeen++;
    }
    if (t.finalSeenAt != null && t.finalizeAt != null) {
      finalize.push(t.finalSeenAt - t.finalizeAt);
      finalizeSeen++;
    }
  }
  const rerunVals = [...reruns.values()];

  log("\n================ REPORT ================");
  log(`scale: ${CFG.users} users × ${CFG.chats} chats = ${allChats.length} concurrent turns`);
  log(`catalogue: ${CFG.agents} agents × ${CFG.instances} instances; ${CFG.deltas} deltas/turn @ ${CFG.deltaMs}ms`);
  log(`drive wall-clock: ${Math.round(driveMs)}ms; total: ${Math.round(nowMs() - t0)}ms`);
  log(`first-delta latency (ms), n=${firstDeltaSeen}/${allChats.length}:`, JSON.stringify(summarize(firstDelta)));
  log(`finalize  latency (ms), n=${finalizeSeen}/${allChats.length}:`, JSON.stringify(summarize(finalize)));
  log(`reactive re-runs/subscriber during burst:`, JSON.stringify(summarize(rerunVals)), `(total ${rerunVals.reduce((x, y) => x + y, 0)})`);

  // WRITE O(n^2): appendDelta latency early (<25% of the turn) vs late (>=75%).
  const early = appendLat.filter((x) => x.pos < 0.25).map((x) => x.ms);
  const late = appendLat.filter((x) => x.pos >= 0.75).map((x) => x.ms);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const em = mean(early);
  const lm = mean(late);
  log(
    `appendDelta WRITE latency early(<25%)=${em.toFixed(1)}ms vs late(>=75%)=${lm.toFixed(1)}ms` +
      ` -> ×${(lm / (em || 1)).toFixed(2)} (≈1 flat=O(1)/delta; >>1=O(n)/delta -> O(n^2)/turn)`,
  );

  // PUSH O(n^2): cumulative live-text bytes a subscriber received / final length.
  const amp = [];
  for (const t of turns.values()) {
    if (t.cumBytes != null && t.maxLen) amp.push(t.cumBytes / t.maxLen);
  }
  log(
    `push amplification (cum bytes / final len), n=${amp.length}:`,
    JSON.stringify(summarize(amp)),
    `(≈1=incremental; ~K/2=full text re-sent each delta)`,
  );
  log(`ingest errors: ${errors.length}`);
  if (errors.length) log("  sample:", errors.slice(0, 5));
  log("========================================");

  await Promise.all([admin.client.close(), ...subs.map((s) => s.client.close())]);
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e);
  process.exit(1);
});
