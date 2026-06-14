// DEV PROOF: drive the REAL writer -> media fetcher -> Convex ingest -> storage
// -> media part, with NO gateway access. Proves bug #2 + the frontend chain.
//   OPENCLAW_MEDIA_OUTBOUND_DIR=/tmp/oc-media-test \
//   node --env-file=.env dev-prove-media.mjs <chatId> <filename>
import { loadConfig } from "./dist/config.js";
import { HttpConvexWriter } from "./dist/convex-writer.js";
import { LocalDirMediaFetcher } from "./dist/core/media-fetcher.js";

const cfg = loadConfig();
console.log("mediaOutboundDir:", cfg.mediaOutboundDir);
const chatId = process.argv[2];
const filename = process.argv[3];
const fetcher = new LocalDirMediaFetcher({ baseDir: cfg.mediaOutboundDir, maxBytes: cfg.mediaMaxBytes });
const writer = new HttpConvexWriter({
  convexHttpActionsUrl: cfg.convexHttpActionsUrl,
  ingestSecret: cfg.convexIngestSecret,
  mediaFetcher: fetcher,
});
const mid = await writer.startAssistant(chatId, "prove-media-run");
await writer.appendDelta(mid, "Voici le fichier généré (preuve de la chaîne média) :");
await writer.addMedia(mid, {
  filename,
  path: `/home/node/.openclaw/media/outbound/${filename}`,
});
await writer.finalize(mid, "complete", "Voici le fichier généré (preuve de la chaîne média).", null);
console.log("OK messageId:", mid);
process.exit(0);
