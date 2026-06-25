// Drive ONE synthetic streaming turn on an EXISTING chat (no provisioning, no
// subscribers). Companion to run.mjs for the browser/perf-trace repro: open the
// chat in a real browser, then drive deltas here while a performance trace runs to
// see the CLIENT render cost (vs the server/network cost run.mjs measures).
//
// Usage:  node scripts/loadtest/drive-one.mjs <chatId> [deltas=150] [deltaChars=12] [deltaMs=40] [mode=plain|md]
//   mode=md streams MARKDOWN-rich accumulating content (headings/lists/code/quotes)
//   to exercise the client's markdown re-parse cost — the realistic render case.
import { ingest, sleep } from "./lib.mjs";

const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: drive-one.mjs <chatId> [deltas] [deltaChars] [deltaMs] [mode]");
  process.exit(1);
}
const K = Number(process.argv[3] ?? 150);
const chars = Number(process.argv[4] ?? 12);
const ms = Number(process.argv[5] ?? 40);
const mode = process.argv[6] ?? "plain";
const site = process.env.CONVEX_SITE_URL || "http://127.0.0.1:3213";
const secret = process.env.BRIDGE_INGEST_SECRET || "devingest";

// One markdown fragment per delta; accumulated they form a realistic rich reply
// (the whole growing doc is re-parsed by the client on every push in the O(n^2) path).
const mdFragment = (k) => {
  switch (k % 5) {
    case 0: return `\n## Section ${k}\n`;
    case 1: return `- list item **${k}** with \`inline code ${k}\` and _emphasis_\n`;
    case 2: return `Paragraph ${k} with a [link](http://example.com/${k}) and some prose to parse. `;
    case 3: return `\n\`\`\`js\nconst x${k} = ${k};\n\`\`\`\n`;
    default: return `> blockquote ${k} — more text to re-tokenize\n\n`;
  }
};

console.error(`START=${Date.now()}`);
const { messageId } = await ingest(site, secret, {
  op: "startAssistant",
  chatId,
  runId: `drive-${chatId}`,
});
let full = "";
for (let k = 0; k < K; k++) {
  const text = mode === "md" ? mdFragment(k) : `tok${k} `.padEnd(chars, "x");
  full += text;
  await ingest(site, secret, { op: "appendDelta", messageId, text });
  if (ms) await sleep(ms);
}
console.error(`END=${Date.now()}`);
// Finalize with the SAME accumulated text so the persisted message matches what
// streamed (otherwise the final render would differ from the streamed content).
await ingest(site, secret, {
  op: "finalize",
  messageId,
  status: "complete",
  text: full,
});
console.log(`drove ${K} deltas (${chars} chars @ ${ms}ms) on ${chatId} -> ${messageId}`);
