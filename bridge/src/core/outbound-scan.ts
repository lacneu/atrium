// DETERMINISTIC outbound media (the reliability fix). Relying on the agent to emit
// a `MEDIA:<path>` line is non-deterministic — the LLM sometimes generates the file
// but omits the directive (or writes a filename with a space that broke the path
// parse), so NO downloadable attachment appears even though the file is right there
// in the shared outbound dir. This scans that dir AFTER each turn and hosts every
// file the agent produced DURING the turn, INDEPENDENT of the agent's text.
//
// Only runs in shared-fs outbound mode (the bridge has a local mount to scan; in
// gateway-http there is no local dir). Dedupes against files already hosted via a
// MEDIA: directive this turn. Bounded by mtime (this turn only) + size.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConvexWriter } from "../convex-writer.js";

export interface OutboundScanDeps {
  writer: ConvexWriter;
  /** The bridge's outbound READ dir (its mount of the shared volume). */
  dir: string;
  /** Per-file cap; a file above it is skipped (the fetcher would skip it too). */
  maxBytes: number;
  /** Gate: only scan when the CURRENT (hot) outbound mode is shared-fs. */
  enabled: () => boolean;
}

// Clock-skew grace between the host bridge (Date.now) and the container-written
// file mtime. Small enough not to catch a PRIOR turn's file, big enough for skew.
const MTIME_GRACE_MS = 2_000;

// Dirs we've already warned about being unreadable, so the runtime backstop logs
// the misconfig ONCE per dir instead of every turn (keyed by dir so a hot config
// change to a new bad dir still surfaces).
const warnedUnreadableDirs = new Set<string>();

/**
 * Host every NEW top-level file in the outbound dir (mtime within this turn, not
 * already hosted, a regular file under the size cap) via `writer.addMedia` — the
 * SAME path the MEDIA: directive uses, so it streams to Convex storage and renders
 * as a download chip. `hosted` is the set of basenames already delivered this turn;
 * newly-hosted names are added to it. Best-effort: a per-file error is skipped, the
 * scan never throws (it must never break finalize).
 */
export async function scanAndHostOutbound(
  deps: OutboundScanDeps,
  messageId: string,
  sinceMs: number,
  hosted: Set<string>,
): Promise<void> {
  if (!deps.enabled()) return;
  let entries: string[];
  try {
    entries = await readdir(deps.dir);
  } catch (e) {
    // In shared-fs mode (the only mode we reach here) the outbound dir MUST be
    // readable by the bridge. A failure — typically OPENCLAW_MEDIA_OUTBOUND_DIR
    // pointing at the gateway's CONTAINER path instead of the bridge's own mount —
    // makes EVERY generated file silently undeliverable: exactly the "no link, no
    // error" the user hits. Surface it ONCE per dir (structural; errno only, never
    // the path) so the misconfig is visible at runtime. The form's "Vérifier les
    // chemins" button is the proactive guard; this is the backstop.
    if (!warnedUnreadableDirs.has(deps.dir)) {
      warnedUnreadableDirs.add(deps.dir);
      const code = (e as NodeJS.ErrnoException)?.code ?? "unknown";
      console.warn(
        `[outbound-scan] shared-fs outbound dir unreadable (${code}) — generated ` +
          `files cannot be hosted. Verify OPENCLAW_MEDIA_OUTBOUND_DIR is the bridge's ` +
          `mount of the shared dir, not the gateway container path.`,
      );
    }
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue; // dotfiles + validate markers
    if (hosted.has(name)) continue; // already delivered via a MEDIA: directive
    try {
      const s = await stat(join(deps.dir, name));
      if (!s.isFile()) continue; // skip subdirs (converted/, …)
      if (s.mtimeMs < sinceMs - MTIME_GRACE_MS) continue; // not from this turn
      if (s.size > deps.maxBytes) continue; // absurd
      // The fetcher basename-resolves under its baseDir (== deps.dir), so the
      // basename IS the path it opens.
      await deps.writer.addMedia(messageId, { filename: name, path: name });
      hosted.add(name);
    } catch {
      // racing delete / unreadable entry — skip; the turn still finalizes.
    }
  }
}
