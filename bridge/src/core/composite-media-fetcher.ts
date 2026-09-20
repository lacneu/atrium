// THE GENERATED IMAGE THAT WAS ANNOUNCED AND NEVER ARRIVED.
//
// `shared-fs` mounts ONE directory: the gateway's `media/outbound`. Upstream's
// generation tools write beside it — `media/tool-image-generation`,
// `-music-`, `-video-` — and the normalizer accepts all four as deliverable
// (`DELIVERABLE_MEDIA_SUBDIRS`). So on a shared-fs instance Atrium ACCEPTED the
// announcement of a generated image and then could not open the file, every
// time, by construction.
//
// Production, 2026-09-20: a user asked for a poster edit six times and got
// "voici la nouvelle version" six times with nothing attached, writing back "Tu
// n'as rien livré." The trace said `dropped: not_found`, which reads as a lost
// file — the file was never lost, it was on the gateway all along.
//
// This composes the two fetchers we already have instead of asking the operator
// to change a bind mount: shared-fs keeps serving `outbound` (a local read, no
// round trip), and ONLY the sibling directories it structurally cannot see are
// asked of the gateway's own media route — the same route `gateway-http` mode
// uses, with the same authorization.
//
// NARROW ON PURPOSE. The fallback fires on exactly one reason,
// `not_in_this_mount`. A real `not_found` under the mount still fails as it did:
// that one means a broken mount or a vanished file, and turning it into a
// gateway round-trip on every turn would both hide the breakage and pay for it.

import type { MediaFetcher, OpenResult } from "./media-fetcher.js";

export class CompositeMediaFetcher implements MediaFetcher {
  private readonly primary: MediaFetcher;
  private readonly fallback: MediaFetcher;
  /** Counted so a deployment can see the fallback is load-bearing (or dead). */
  private delegated = 0;

  constructor(params: { primary: MediaFetcher; fallback: MediaFetcher }) {
    this.primary = params.primary;
    this.fallback = params.fallback;
  }

  async open(
    path: string,
    opts?: { rejectOlderThanMs?: number | null },
  ): Promise<OpenResult> {
    const first = await this.primary.open(path, opts);
    if (first.ok || first.reason !== "not_in_this_mount") return first;
    this.delegated += 1;
    if (this.delegated === 1) {
      console.log(
        "[media] generated media is outside the shared-fs mount — served through the gateway media route",
      );
    }
    // The SAME opts, freshness bound included: a mention-only path must not
    // become deliverable merely because it took the other road.
    return await this.fallback.open(path, opts);
  }

  /** For diagnostics/tests: how many opens the primary could not serve. */
  delegatedCount(): number {
    return this.delegated;
  }
}
