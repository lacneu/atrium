// THE GENERATED IMAGE THAT WAS ANNOUNCED AND NEVER ARRIVED (prod, 2026-09-20).
//
// A shared-fs instance mounts `media/outbound` alone. Upstream's generation tools
// write to `media/tool-image-generation` beside it, and the normalizer accepts all
// four deliverable directories — so every generated image was accepted as
// deliverable and then dropped, reported as `not_found`. Six exchanges of "voici
// la nouvelle version" with nothing attached, and a user writing back "Tu n'as rien
// livré." The file was never lost: it was on the gateway the whole time.

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";

import { CompositeMediaFetcher } from "../src/core/composite-media-fetcher.js";
import type {
  MediaFetcher,
  MediaSkipReason,
  OpenResult,
} from "../src/core/media-fetcher.js";

const bytes = (): OpenResult => ({
  ok: true,
  stream: Readable.from([Buffer.from("png")]),
  mimeType: "image/png",
  size: 3,
});

class Stub implements MediaFetcher {
  readonly calls: { path: string; opts: unknown }[] = [];
  constructor(private readonly result: OpenResult) {}
  async open(path: string, opts?: { rejectOlderThanMs?: number | null }) {
    this.calls.push({ path, opts });
    return this.result;
  }
}

const refuse = (reason: MediaSkipReason): OpenResult => ({ ok: false, reason });

describe("shared-fs + the gateway route, composed", () => {
  it("a generated image the mount cannot see is served by the GATEWAY", () => {
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary, fallback });
    return f
      .open("/srv/openclaw/media/tool-image-generation/poster.png")
      .then((r) => {
        expect(r.ok, "the image must be delivered, not dropped").toBe(true);
        expect(fallback.calls).toHaveLength(1);
      });
  });

  it("a REAL not_found under the mount still fails — it is a broken mount, not a detour", async () => {
    // The narrow trigger is the point. Falling back on every miss would pay a
    // gateway round-trip per turn AND hide exactly the breakage this reason
    // exists to report.
    const primary = new Stub(refuse("not_found"));
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open("/srv/openclaw/media/outbound/report.pdf");
    expect(r.ok).toBe(false);
    expect(fallback.calls, "the gateway must NOT be asked").toHaveLength(0);
  });

  it("no other refusal is a detour either — each names a different operator fix", async () => {
    for (const reason of [
      "too_large",
      "path_escape",
      "symlink_rejected",
      "not_a_file",
      "invalid_filename",
      "stale_mention",
    ] as const) {
      const fallback = new Stub(bytes());
      const f = new CompositeMediaFetcher({
        primary: new Stub(refuse(reason)),
        fallback,
      });
      const r = await f.open("/srv/openclaw/media/outbound/x");
      expect(r.ok, `${reason} must not be retried elsewhere`).toBe(false);
      expect(fallback.calls, `${reason} must not reach the gateway`).toHaveLength(0);
    }
  });

  it("a file the mount CAN serve never touches the gateway", async () => {
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary: new Stub(bytes()), fallback });
    const r = await f.open("/srv/openclaw/media/outbound/report.pdf");
    expect(r.ok).toBe(true);
    expect(fallback.calls).toHaveLength(0);
  });

  it("the freshness bound travels with the delegation", async () => {
    // A path merely MENTIONED in tool output must not become deliverable just
    // because it took the other road — that is the stale re-delivery defect.
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({
      primary: new Stub(refuse("not_in_this_mount")),
      fallback,
    });
    await f.open("/srv/openclaw/media/tool-video-generation/clip.mp4", {
      rejectOlderThanMs: 1234,
    });
    expect(fallback.calls[0]?.opts).toEqual({ rejectOlderThanMs: 1234 });
  });

  it("the gateway's own refusal is surfaced as itself, not rewritten", async () => {
    // If the gateway cannot serve it either, the operator must read WHY from the
    // fetcher that actually tried — never a synthesised `not_found`.
    const f = new CompositeMediaFetcher({
      primary: new Stub(refuse("not_in_this_mount")),
      fallback: new Stub(refuse("route_absent")),
    });
    const r = await f.open("/srv/openclaw/media/tool-image-generation/x.png");
    expect(r).toEqual({ ok: false, reason: "route_absent" });
  });
});
