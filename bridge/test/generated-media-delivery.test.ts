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
import { sanitizeText } from "../src/providers/openclaw/sanitize.js";

const SESSION_KEY = "agent:alice:atrium:chat:u-repro:turn-nx797jy9g64vjv0yedbr67z3yh8envjs";
const DELIVERY_RUN = "image_generate:f21f0360-11ad-482b-a3f4-f362641459e0:ok:agent-loop";
const GENERATED =
  "/home/node/.openclaw/media/tool-image-generation/bench-async---534264af-a086-442d-a39e-054949d5dd99.png";

// The file itself reaches a bubble through the transcript row that carries it (copied by
// its identity, core/artifact-copier.ts) — never from the live stream. What the live text
// still owes is to never print the server path of a generated file.
describe("the visible text never shows a generated file's server path", () => {
  it("is stripped of the generation directories", () => {
    const out = sanitizeText(`Voici l’image : ${GENERATED}`);
    expect(out).not.toContain("/home/node/.openclaw");
  });

  it("…under ANY state dir, keeping the file's NAME", () => {
    const out = sanitizeText("Voici : /srv/openclaw/media/tool-image-generation/a.png");
    expect(out).not.toContain("/srv/openclaw");
    expect(out).toContain("a.png");
  });
});

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
      // The SAFETY property is unchanged — the homonym is never opened. What
      // changed on 2026-09-20 is the NAME of the refusal: `not_in_this_mount`,
      // because nothing is missing, the file is simply outside this mount. The
      // composite fetcher delegates to the gateway on this reason alone, so
      // calling it `not_found` here would put every generated image back in the
      // bin — which is exactly what production did for weeks.
      expect(got.ok === false && got.reason, generated).toBe("not_in_this_mount");
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

describe("a delivery run that hands over NOTHING says so", () => {
  // The second shape the bench captured, verbatim: the run named `<tool>:<taskId>:ok`
  // produced only "Je lance la génération, l'image arrivera automatiquement dès qu'elle sera
  // prête." and no media at all. Atrium cannot make the gateway attach the artifact — what
  // it owes is to deliver the file when handed one, and to NAME the gap when it is not.
  function driveDelivery(runId: string) {
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
    const { events, final } = driveDelivery(DELIVERY_RUN);
    expect(final?.mediaGeneratedUndelivered).toBe(true);
    expect(events.some((e) => e.type === "media.undelivered")).toBe(true);
  });

  it("an ordinary text-only turn is untouched", () => {
    const { final } = driveDelivery("webchat-cda569c4255330b00576676ec98ebd0c");
    expect(final?.mediaGeneratedUndelivered).toBe(false);
  });

  it("the FAILED sibling is not this class — the turn already reports it", () => {
    const { final } = driveDelivery(
      "image_generate:a3e56480-e087-4049-8576-263af03da666:error:agent-loop");
    expect(final?.mediaGeneratedUndelivered).toBe(false);
  });

  it("covers the three tools upstream runs as background tasks", () => {
    for (const tool of ["image_generate", "music_generate", "video_generate"]) {
      const { final } = driveDelivery(`${tool}:t-1:ok`);
      expect(final?.mediaGeneratedUndelivered, tool).toBe(true);
    }
  });
});
