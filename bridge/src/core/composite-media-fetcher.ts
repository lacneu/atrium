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

import { sep } from "node:path";
import {
  GENERATED_MEDIA_SUBDIRS,
  type MediaFetcher,
  type OpenResult,
} from "./media-fetcher.js";

// WHAT THIS FETCHER IS ALLOWED TO ASK THE GATEWAY FOR.
//
// The primary can only ever serve `<mount>/<basename>`: it keeps the basename and
// joins it under the mounted `media/outbound`, so no path it accepts can name a
// subdirectory. Handing the fallback the RAW path would have made the composite
// strictly wider than either fetcher alone — the gateway route validates against
// the gateway's own localRoots, which contain far more than one directory, so a
// path the primary would never have opened becomes deliverable merely by taking
// the other road.
//
// The normalizer accepts `/media/<generated dir>/` ANYWHERE in the path (it must:
// testing the immediate parent refused legitimate nested staging paths on the
// primary's side). So `…/media/tool-image-generation/jobs/result.png` reaches
// here, and delegating it would ask the gateway to open a path under a directory
// we never inspected.
//
// The delegation is therefore restricted to the shape the generation tools
// actually write: the generated directory as the IMMEDIATE parent, and a plain
// basename. Anything deeper is refused without a round trip and keeps the
// primary's own verdict.
//
// The cost is stated rather than hidden: if upstream ever nests its output, that
// file stops being delivered and the trace says `not_in_this_mount` — visible,
// not silent.
function isDelegableGeneratedPath(path: string): boolean {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return false;
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes(sep)
  ) {
    return false;
  }
  return GENERATED_MEDIA_SUBDIRS.some((d) => dir.endsWith(`/media/${d}`));
}

export class CompositeMediaFetcher implements MediaFetcher {
  private readonly primary: MediaFetcher;
  private readonly fallback: MediaFetcher;
  /** Counted so a deployment can see the fallback is load-bearing (or dead). */
  private delegated = 0;
  /** Generated paths refused BEFORE the round trip for not being a plain
   *  `<media>/<generated dir>/<file>` — a containment refusal, not a transport
   *  failure. Read by TESTS today, not by any observability surface: the operator's
   *  actual signal is the one-shot warning below. Said plainly so nobody plans
   *  against a counter nothing publishes. */
  private refusedShape = 0;
  /** The gateway has no media route at all — an OPERATOR fact, logged once and
   *  deliberately kept out of the per-file reason code. */
  private routeAbsent = 0;

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
    if (!isDelegableGeneratedPath(path)) {
      this.refusedShape += 1;
      if (this.refusedShape === 1) {
        // Structural only (no path, no filename): SOC2-safe, like every other
        // media log on this seam.
        console.warn(
          "[media] generated media path is not a plain <media>/<generated dir>/<file> — not asking the gateway for it",
        );
      }
      // The primary's verdict, verbatim: this fetcher cannot see the file, and we
      // are deliberately not widening containment to go and find it.
      return first;
    }
    this.delegated += 1;
    if (this.delegated === 1) {
      console.log(
        "[media] generated media is outside the shared-fs mount — served through the gateway media route",
      );
    }
    // The SAME opts, freshness bound included: a mention-only path must not
    // become deliverable merely because it took the other road.
    const second = await this.fallback.open(path, opts);
    // A FALLBACK THAT CANNOT EXIST MUST NOT REWRITE THE DIAGNOSIS.
    //
    // `route_absent` means the gateway serves no `/__openclaw__/assistant-media`
    // route at all (a pre-6.x gateway). Surfaced verbatim, it reached the operator
    // as its own actionable advice — "switch to shared-fs" — on an instance that IS
    // shared-fs. A refusal that tells you to do the thing you are already doing is
    // worse than no refusal: it sends the reader looking for a misconfiguration
    // that is not there.
    //
    // The honest verdict is the primary's, unchanged: the file is not in this
    // mount. The route's absence is an OPERATOR fact, not a per-file one, so it is
    // logged once and kept out of the reason code.
    if (!second.ok && second.reason === "route_absent") {
      this.routeAbsent += 1;
      if (this.routeAbsent === 1) {
        console.warn(
          "[media] this gateway serves no media route — generated media cannot be " +
            "fetched on a shared-fs instance. Mount the sibling generation " +
            "directories beside media/outbound, or upgrade the gateway.",
        );
      }
      return first;
    }
    return second;
  }

  /** For diagnostics/tests: how many opens the primary could not serve. */
  delegatedCount(): number {
    return this.delegated;
  }

  /** For diagnostics/tests: how many generated paths were refused for shape. */
  refusedShapeCount(): number {
    return this.refusedShape;
  }

  /** For diagnostics/tests: how many opens found no media route on the gateway. */
  routeAbsentCount(): number {
    return this.routeAbsent;
  }
}
