/**
 * The file an agent GENERATES, and where the gateway actually puts it.
 *
 * Five production reports say the same thing in the user's own words — "manque une partie de
 * la réponse (image)", "Pas d'affichage de la réponse", "Image non délivrée", "Pas de fichier
 * bien que annoncé faisant partie de la réponse" — and every one of them was invisible: the
 * turn ends `complete`, so it carries no failure class at all.
 *
 * The cause is not the agent. Upstream's media-generation tools write their artifact to
 * `media/tool-{image,music,video}-generation/` (GENERATED_*_MEDIA_SUBDIR in
 * `src/agents/tools/*-generate-tool.execution.ts` @ v2026.9.4) and the delivery run names
 * that path in `assistant/final_answer.mediaUrls`. Atrium accepted `media/outbound/` and
 * nothing else, so it REFUSED the file the gateway had just handed it.
 *
 * The path below is verbatim from the live bench (run 2026-09-18T21-05-03-957Z, scenario
 * `async-task`, run id `image_generate:f21f0360-…:ok:agent-loop`).
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirMediaFetcher } from "../src/core/media-fetcher.js";
import {
  maskFreeText,
  // @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
} from "../scripts/lib/anonymize-capture.mjs";

import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import {
  outboundMediaDeliveries,
  sanitizeText,
} from "../src/providers/openclaw/sanitize.js";

const SESSION_KEY = "agent:alice:atrium:chat:u-repro:turn-nx797jy9g64vjv0yedbr67z3yh8envjs";
const DELIVERY_RUN = "image_generate:f21f0360-11ad-482b-a3f4-f362641459e0:ok:agent-loop";
const GENERATED =
  "/home/node/.openclaw/media/tool-image-generation/bench-async---534264af-a086-442d-a39e-054949d5dd99.png";

/** Feed a delivery run whose final_answer carries `mediaUrls`, as the gateway sends it. */
function mediaItemsFor(url: string): Array<{ filename: string; path: string }> {
  const n = new Normalizer(SESSION_KEY);
  let now = 1_000_000;
  n.beginTurn(now);
  n.noteRunStarted(DELIVERY_RUN, (now += 10));
  const events = n.feed(
    {
      type: "event",
      event: "agent",
      payload: {
        runId: DELIVERY_RUN,
        sessionKey: SESSION_KEY,
        stream: "assistant",
        data: {
          text: "Voici l’image générée.",
          delta: "",
          phase: "final_answer",
          mediaUrls: [url],
        },
      },
    },
    (now += 10),
  );
  const media = events.find((e) => e.type === "media") as
    | { items: Array<{ filename: string; path: string }> }
    | undefined;
  return media?.items ?? [];
}

describe("a generated file is taken from the directory the gateway wrote it to", () => {
  it("the image an async image_generate run delivers is attached", () => {
    const items = mediaItemsFor(GENERATED);
    expect(items.length).toBe(1);
    expect(items[0]!.path).toBe(GENERATED);
    expect(items[0]!.filename).toBe(
      "bench-async---534264af-a086-442d-a39e-054949d5dd99.png",
    );
  });

  it("music and video generation are the same two directories", () => {
    for (const dir of ["tool-music-generation", "tool-video-generation"]) {
      const url = `/home/node/.openclaw/media/${dir}/a.bin`;
      expect(mediaItemsFor(url).length, dir).toBe(1);
    }
  });

  it("the staging directory still works — this widens, it does not move", () => {
    expect(mediaItemsFor("/home/node/.openclaw/media/outbound/report.pdf").length).toBe(1);
  });

  it("a NAMED set, not every directory under media/", () => {
    // Upstream keeps caches and other material under the same root. Taking a file from a
    // directory whose purpose is not delivery is how one conversation ends up with
    // another's documents.
    for (const url of [
      "/home/node/.openclaw/media/playback-transcode/cached.mp4",
      "/home/node/.openclaw/media/outgoing/other.png",
      "/home/node/.openclaw/media/inbound/received.png",
      "/home/node/.openclaw/media/x.png",
    ]) {
      expect(mediaItemsFor(url).length, url).toBe(0);
    }
  });

  it("the gateway's state dir is NOT assumed to be /home/node", () => {
    // It follows the account or OPENCLAW_STATE_DIR, and `gateway-http` — the default
    // transport — serves whatever path the gateway itself minted a ticket for. Anchoring
    // this reader on one home directory silently dropped every delivery from such a
    // gateway (codex P1).
    for (const url of [
      "/home/alice/.openclaw/media/outbound/report.pdf",
      "/srv/openclaw/media/tool-image-generation/a.png",
    ]) {
      expect(mediaItemsFor(url).length, url).toBe(1);
    }
  });

  it("the traversal and query guards are unchanged", () => {
    for (const url of [
      "/home/node/.openclaw/media/tool-image-generation/../../etc/passwd",
      "/home/node/.openclaw/media/tool-image-generation/a.png?x=1",
    ]) {
      expect(mediaItemsFor(url).length, url).toBe(0);
    }
  });

  it("a scheme-prefixed candidate behaves EXACTLY as it does for the staging dir", () => {
    // `file://<abs path>` is not itself a path, so it falls to the embedded scan, which
    // extracts the absolute path inside it — the same for both directories. Pinned as a
    // COMPARISON, not as a number: this lot widens which directories are deliverable and
    // must not quietly change what a scheme prefix does.
    const generated = mediaItemsFor(
      "file:///home/node/.openclaw/media/tool-image-generation/a.png",
    );
    const staging = mediaItemsFor("file:///home/node/.openclaw/media/outbound/a.png");
    expect(generated.length).toBe(staging.length);
  });

  it("a path in PROSE is found and hidden under ANY state dir", () => {
    // This used to be written as a KNOWN LIMIT, and the test DEMANDED the leak: under a
    // non-canonical state dir the reader accepted the path from `mediaUrls` while the
    // stripper left the same path printed in the reply — the file attached AND the server
    // path published (codex). Discovery and stripping now accept the same language.
    const alien = "/srv/openclaw/media/tool-image-generation/a.png";
    const n = new Normalizer(SESSION_KEY);
    let now = 1_000_000;
    n.beginTurn(now);
    n.noteRunStarted(DELIVERY_RUN, (now += 10));
    const events = n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: DELIVERY_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: `Voici : ${alien}`, delta: "", phase: "final_answer" },
        },
      },
      (now += 10),
    );
    expect(events.some((e) => e.type === "media")).toBe(true);
    const out = sanitizeText(`Voici : ${alien}`);
    expect(out).not.toContain("/srv/openclaw");
    expect(out).toContain("a.png"); // the NAME stays; the server path does not
  });

  it("the visible text is stripped of the new paths too", () => {
    // DISCOVERY and STRIPPING must agree: attaching the file while its absolute path stays
    // printed in the reply is the half-fix.
    const out = sanitizeText(`Voici l’image : ${GENERATED}`);
    expect(out).not.toContain("/home/node/.openclaw");
  });
});
// The shared-fs fetcher is NOT part of this lot, deliberately. It mounts `media/outbound`
// and resolves a basename inside it — and the deterministic outbound scan hands it a bare
// filename, so any stricter directory rule there regresses that path. It reports
// `not_found` for a generated file: no delivery, and no wrong file either. `gateway-http`,
// the default transport and the one production runs, asks the gateway for the path itself.

describe("the shared-fs mount refuses what it cannot serve", () => {
  it("never opens a HOMONYM from the staging dir for a generated path", async () => {
    // This fetcher keeps only the basename and joins it under the mount. Accepting a
    // generated path without teaching it that would have opened `outbound/result.png` —
    // a different, older file — and delivered it as this turn's (codex P1).
    const mediaRoot = await mkdtemp(join(tmpdir(), "atrium-media-"));
    const outbound = join(mediaRoot, "outbound");
    await mkdir(outbound);
    await writeFile(join(outbound, "result.png"), "an OLDER file, someone else's");

    const fetcher = new LocalDirMediaFetcher({
      baseDir: outbound,
      maxBytes: 1024,
      onSkip: () => {},
    });
    for (const generated of [
      "/home/node/.openclaw/media/tool-image-generation/result.png",
      // …and any DESCENDANT of it, or a `./` form: testing only the immediate parent let
      // both through to the basename join (codex).
      "/home/node/.openclaw/media/tool-image-generation/jobs/result.png",
      "/home/node/.openclaw/media/tool-image-generation/./result.png",
      "/home/node/.openclaw/media/tool-video-generation/result.png",
    ]) {
      const got = await fetcher.open(generated);
      expect(got.ok, generated).toBe(false);
      expect(got.ok === false && got.reason, generated).toBe("not_found");
    }

    // …and everything this mount DOES serve is untouched: a staging file, a NESTED staging
    // path, a bare name from the deterministic outbound scan, and a custom agent mount —
    // including one whose own directory happens to carry a generation name.
    for (const served of [
      "/home/node/.openclaw/media/outbound/result.png",
      "/home/node/.openclaw/media/outbound/jobs/result.png",
      "result.png",
      "/srv/atrium/out/result.png",
      "/srv/atrium/tool-image-generation/result.png",
    ]) {
      expect((await fetcher.open(served)).ok, served).toBe(true);
    }
  });
});

describe("the branches this lot added are exercised, not merely written", () => {
  it("a MEDIA: directive split by a Unicode line separator is still a directive", () => {
    // The normalizer split on fewer separators than the visible-text stripper, so a
    // `MEDIA:<path>\u2028rest` line was read as ONE line: the directive was missed and the
    // path demoted to a mention, while the stripper DID see it and removed the line — the
    // file unattached and its only trace gone (codex).
    const n = new Normalizer(SESSION_KEY);
    let now = 1_000_000;
    n.beginTurn(now);
    n.noteRunStarted(DELIVERY_RUN, (now += 10));
    const events = n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: DELIVERY_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: {
            text: `MEDIA:${GENERATED}\u2028et voilà`,
            delta: "",
            phase: "final_answer",
          },
        },
      },
      (now += 10),
    );
    const media = events.find((e) => e.type === "media") as
      | { items: Array<{ path: string; explicit?: boolean }> }
      | undefined;
    expect(media?.items.length).toBe(1);
    expect(media!.items[0]!.path).toBe(GENERATED);
    // …and EXPLICIT: a directive is the agent delivering, not an incidental mention.
    expect(media!.items[0]!.explicit).toBe(true);
  });

  it("a capture keeps a generated path in FREE TEXT, so the corpus can replay it", () => {
    // `MEDIA_ROOTS` covers structured fields; free text goes through its own pattern, which
    // stayed pinned to `outbound` — so a captured directive or tool-result path naming a
    // generated file was masked whole and the corpus could never exercise these readers
    // (codex).
    const masked = maskFreeText(`MEDIA:${GENERATED}`);
    expect(masked).toContain("/media/tool-image-generation/");
    expect(masked.startsWith("MEDIA:")).toBe(true);
  });

  it("…and NOTHING below that root survives, directory names included", () => {
    // The mask kept everything up to the last `/`, so every intermediate directory was
    // published verbatim — and a delivery may legitimately be nested, so a folder named
    // after a person or a case would have reached the corpus intact (codex P1).
    const masked = maskFreeText(
      "MEDIA:/home/node/.openclaw/media/tool-image-generation/jobs/patient-alice/result.png",
    );
    expect(masked).not.toContain("patient-alice");
    expect(masked).not.toContain("jobs");
    expect(masked).not.toContain("result.png");
    // The root the reading stack scans for is still there, and so is the sentinel.
    expect(masked.startsWith("MEDIA:/home/node/.openclaw/media/tool-image-generation/")).toBe(
      true,
    );
  });
});

describe("a DELEGATED agent's generated file", () => {
  it("is delivered too — the sub-agent lane has no other extraction", () => {
    // A sub-agent's final goes through `outboundMediaDeliveries` and nothing else: the
    // parent is explicitly not trusted to re-deliver it. Gated on the staging mount alone,
    // a delegated agent's generated image was never delivered at all — the same defect one
    // lane over (codex).
    const got = outboundMediaDeliveries(
      `Voici le visuel.\nMEDIA:${GENERATED}`,
    );
    expect(got.length).toBe(1);
    expect(got[0]!.path).toBe(GENERATED);
  });

  it("…and under a non-canonical state dir as well", () => {
    const alien = "/srv/openclaw/media/tool-video-generation/clip.mp4";
    const got = outboundMediaDeliveries(`MEDIA:${alien}`);
    expect(got.length).toBe(1);
    expect(got[0]!.filename).toBe("clip.mp4");
  });

  it("…and with a CUSTOM outbound mount configured, which production passes", () => {
    // The observer hands the child's mount to this function. Built for that mount alone, the
    // regex recognised no generated delivery at all — and the test that missed it called the
    // function with no mount, taking the canonical short-circuit (codex P1).
    const got = outboundMediaDeliveries(
      "MEDIA:/srv/openclaw/media/tool-image-generation/a.png",
      "/srv/openclaw/media/outbound",
    );
    expect(got.length).toBe(1);
    expect(got[0]!.filename).toBe("a.png");
    // …and the custom mount's OWN deliveries still work.
    expect(
      outboundMediaDeliveries(
        "MEDIA:/srv/openclaw/media/outbound/r.pdf",
        "/srv/openclaw/media/outbound",
      ).length,
    ).toBe(1);
  });

  it("a root-level media path is a path too", () => {
    // The `ANY ROOT` patterns required a component before `/media/`, so `/media/<dir>/x`
    // was accepted by the reader and neither found as a directive nor masked (codex P1).
    const rooted = "/media/tool-image-generation/a.png";
    expect(outboundMediaDeliveries(`MEDIA:${rooted}`).length).toBe(1);
    expect(sanitizeText(`Voici : ${rooted}`)).not.toContain("/media/tool-image-generation");
  });

  it("a root with SPACES is delivered through the directive, which owns the whole line", () => {
    // The config parser requires only a leading `/`, so such a mount is valid. A path in
    // PROSE stays out of reach — it has no delimiter, which is why the bare-token scan has
    // always stopped at whitespace, `outbound` included — and the directive is the supported
    // way to deliver one: it takes the rest of the line (codex).
    const spaced = "/srv/open claw/media/tool-image-generation/a b.png";
    const got = outboundMediaDeliveries(`MEDIA:${spaced}`);
    expect(got.length).toBe(1);
    expect(got[0]!.filename).toBe("a b.png");
    expect(sanitizeText(`MEDIA:${spaced}`)).not.toContain("/srv/open claw");
    // …and in the branch PRODUCTION uses for a sub-agent, which keeps the file NAME because
    // nothing downstream will carry the file. Re-scanning the line there left a piece of the
    // server path beside the name (codex).
    const named = sanitizeText(`MEDIA:${spaced}`, { mediaPartsEmitted: false });
    expect(named).not.toContain("/srv/open claw");
    expect(named).not.toContain("/media/");
    expect(named.trim()).toBe("a b.png");
  });

  it("a staging delivery on that lane is unchanged", () => {
    const got = outboundMediaDeliveries(
      "MEDIA:/home/node/.openclaw/media/outbound/report.pdf",
    );
    expect(got.length).toBe(1);
    expect(got[0]!.filename).toBe("report.pdf");
  });
});

describe("a delivery run that hands over NOTHING says so", () => {
  // The second shape the bench captured, verbatim: the run named `<tool>:<taskId>:ok`
  // produced only "Je lance la génération, l'image arrivera automatiquement dès qu'elle sera
  // prête." and no media at all. Atrium cannot make the gateway attach the artifact — what
  // it owes is to deliver the file when handed one, and to NAME the gap when it is not.
  function driveDelivery(runId: string, withMedia: boolean) {
    const n = new Normalizer(SESSION_KEY);
    let now = 1_000_000;
    n.beginTurn(now);
    n.noteRunStarted(runId, (now += 10));
    n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: {
            text: "Je lance la génération, l’image arrivera automatiquement.",
            delta: "",
            phase: "final_answer",
            ...(withMedia ? { mediaUrls: [GENERATED] } : {}),
          },
        },
      },
      (now += 10),
    );
    const events = n.feed(
      {
        event: "chat",
        payload: {
          runId,
          sessionKey: SESSION_KEY,
          seq: 3,
          state: "final",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Je lance la génération, l’image arrivera automatiquement." },
            ],
          },
        },
      },
      (now += 10),
    );
    const final = events.find((e) => e.type === "message.final") as
      | { mediaGeneratedUndelivered?: boolean }
      | undefined;
    return { events, final };
  }

  it("flags the gap, on the run's NAME alone — no prose is read", () => {
    const { events, final } = driveDelivery(DELIVERY_RUN, false);
    expect(final?.mediaGeneratedUndelivered).toBe(true);
    expect(events.some((e) => e.type === "media.undelivered")).toBe(true);
  });

  it("stays silent when the file DID arrive", () => {
    const { events, final } = driveDelivery(DELIVERY_RUN, true);
    expect(final?.mediaGeneratedUndelivered).toBe(false);
    expect(events.some((e) => e.type === "media.undelivered")).toBe(false);
  });

  it("an ordinary text-only turn is untouched", () => {
    const { final } = driveDelivery("webchat-cda569c4255330b00576676ec98ebd0c", false);
    expect(final?.mediaGeneratedUndelivered).toBe(false);
  });

  it("the FAILED sibling is not this class — the turn already reports it", () => {
    const { final } = driveDelivery(
      "image_generate:a3e56480-e087-4049-8576-263af03da666:error:agent-loop",
      false,
    );
    expect(final?.mediaGeneratedUndelivered).toBe(false);
  });

  it("covers the three tools upstream runs as background tasks", () => {
    for (const tool of ["image_generate", "music_generate", "video_generate"]) {
      const { final } = driveDelivery(`${tool}:t-1:ok`, false);
      expect(final?.mediaGeneratedUndelivered, tool).toBe(true);
    }
  });
});
