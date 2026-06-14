#!/usr/bin/env node
// Convex-ingest STUB for the live-protocol suite: accepts the bridge's
// /bridge/ingest ops, records each one (JSONL) for the suite's assertions, and
// answers the minimal shapes the writer consumes — so a full /send pipeline
// runs against a REAL gateway with NO Convex deployment in the loop.
//   node ingest-stub.mjs --port 18902 --secret proto-ingest-secret --log /tmp/proto-ingest.jsonl

import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const PORT = Number(args.port ?? 18902);
const SECRET = args.secret ?? "proto-ingest-secret";
const LOG = args.log ?? "/tmp/proto-ingest.jsonl";

writeFileSync(LOG, ""); // fresh log per run
let msgSeq = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url !== "/bridge/ingest") {
      // Upload-URL target and anything else: accept and ignore.
      reply(200, {});
      return;
    }
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      reply(401, { error: "bad ingest secret" });
      return;
    }
    let op;
    try {
      op = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      reply(400, { error: "bad json" });
      return;
    }
    appendFileSync(LOG, JSON.stringify(op) + "\n");
    switch (op.op) {
      case "startAssistant":
        reply(200, { messageId: `stub-msg-${++msgSeq}` });
        return;
      case "getRehydrationContext":
        reply(200, { history: null, turnCount: 0 });
        return;
      case "getUploadUrl":
        reply(200, { uploadUrl: `http://127.0.0.1:${PORT}/upload` });
        return;
      default:
        reply(200, {});
    }
  });
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`ingest-stub listening on :${PORT} (log: ${LOG})`);
});
