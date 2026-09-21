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
    //
    // Written with `route_absent` at first, which made this test pin a DEFECT: that
    // reason carries its own operator advice ("switch to shared-fs") and this is a
    // shared-fs instance, so surfacing it verbatim sent the reader after a
    // misconfiguration that does not exist. The invariant it was really protecting
    // — a real refusal from the fetcher that tried is never replaced by a
    // synthesised one — holds on every other reason, and the one exception is
    // carved out by name below.
    const f = new CompositeMediaFetcher({
      primary: new Stub(refuse("not_in_this_mount")),
      fallback: new Stub(refuse("too_large")),
    });
    const r = await f.open("/srv/openclaw/media/tool-image-generation/x.png");
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });
});

// CONTAINMENT: the composite must never be WIDER than either fetcher alone.
//
// The primary can only ever serve `<mount>/<basename>` — it keeps the basename and
// joins it under the mount, so no path it accepts names a subdirectory. The
// gateway route, by contrast, validates against the gateway's own localRoots. So
// forwarding the RAW path made a path the primary would never have opened
// deliverable merely by taking the other road. The delegation is restricted to the
// shape the generation tools write: generated directory as the IMMEDIATE parent,
// plain basename.
describe("the delegation is restricted to a plain basename", () => {
  it("a NESTED generated path is refused WITHOUT asking the gateway", async () => {
    // The normalizer accepts `/media/<generated dir>/` anywhere in the path, so
    // this reaches the composite. Asking the gateway for it would open a path
    // under a directory neither fetcher ever inspected.
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open(
      "/srv/openclaw/media/tool-image-generation/jobs/poster.png",
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("not_in_this_mount");
    expect(fallback.calls, "the gateway must NOT be asked").toHaveLength(0);
    expect(f.refusedShapeCount()).toBe(1);
    expect(f.delegatedCount()).toBe(0);
  });

  it("a generated directory that is NOT the immediate parent is refused", async () => {
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open(
      "/srv/openclaw/media/tool-video-generation/a/b/clip.mp4",
    );
    expect(r.ok).toBe(false);
    expect(fallback.calls).toHaveLength(0);
  });

  it("a path whose generated segment is not under `media/` is refused", async () => {
    // A custom agent mount literally called `/srv/atrium/tool-image-generation`
    // is not the gateway's generated directory and must not be fetched from it.
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(bytes());
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open("/srv/atrium/tool-image-generation/poster.png");
    expect(r.ok).toBe(false);
    expect(fallback.calls).toHaveLength(0);
  });

  it("every generated directory keeps working in its PLAIN form", async () => {
    for (const dir of [
      "tool-image-generation",
      "tool-music-generation",
      "tool-video-generation",
    ]) {
      const primary = new Stub(refuse("not_in_this_mount"));
      const fallback = new Stub(bytes());
      const f = new CompositeMediaFetcher({ primary, fallback });
      const r = await f.open(`/home/node/.openclaw/media/${dir}/out.bin`);
      expect(r.ok, `${dir} must still be delegated`).toBe(true);
      expect(fallback.calls).toHaveLength(1);
      expect(f.refusedShapeCount()).toBe(0);
    }
  });

  it("the refusal is counted separately from a transport failure", async () => {
    // An operator reading the counters must be able to tell "we would not ask"
    // from "we asked and it failed".
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(refuse("fetch_error"));
    const f = new CompositeMediaFetcher({ primary, fallback });
    await f.open("/m/media/tool-image-generation/deep/x.png");
    await f.open("/m/media/tool-image-generation/x.png");
    expect(f.refusedShapeCount()).toBe(1);
    expect(f.delegatedCount()).toBe(1);
  });
});

describe("a fallback that cannot exist does not rewrite the diagnosis", () => {
  it("route_absent keeps the primary's verdict — it must not tell a shared-fs instance to use shared-fs", async () => {
    // `route_absent` carries its own operator advice: "this gateway is too old for
    // gateway-http, switch to shared-fs". Surfaced verbatim from here it reached an
    // operator who IS on shared-fs, sending them after a misconfiguration that does
    // not exist. The route's absence is an instance-level fact, logged once, not a
    // per-file reason code.
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(refuse("route_absent"));
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open("/srv/openclaw/media/tool-image-generation/poster.png");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("not_in_this_mount");
    expect(fallback.calls, "it was still asked — the fact is learned, not assumed").toHaveLength(1);
    expect(f.routeAbsentCount()).toBe(1);
  });

  it("a real TRANSPORT failure is surfaced as itself", async () => {
    // `fetch_error` is what actually happened and is actionable on its own: the
    // route exists and the read failed. Only the impossible-route case is folded.
    const primary = new Stub(refuse("not_in_this_mount"));
    const fallback = new Stub(refuse("fetch_error"));
    const f = new CompositeMediaFetcher({ primary, fallback });
    const r = await f.open("/srv/openclaw/media/tool-image-generation/poster.png");
    expect(r.ok === false && r.reason).toBe("fetch_error");
    expect(f.routeAbsentCount()).toBe(0);
  });
})
