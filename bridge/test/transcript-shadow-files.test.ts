// The reconciler's part of the final design's steps 1-2: in `on`, a read's rows carry their
// blocks AHEAD of the read (in the `textsOnly` posts, under the same bounds as their text),
// the read itself carries identities only, and the files Convex answers with are handed to
// the copier the moment they are stored. In `shadow`, none of it.

import { describe, expect, it } from "vitest";

import type { TranscriptFileToCopy } from "../src/convex-writer.js";
import {
  readFilesToCopy,
  TranscriptShadow,
  type TranscriptApply,
} from "../src/providers/openclaw/transcript-shadow.js";

const KEY = "agent:alice:atrium:chat:u-1:c1";
const mirror = {
  role: "assistant",
  provider: "openclaw",
  model: "delivery-mirror",
  content: [
    { type: "text", text: "Voici le fichier." },
    {
      type: "attachment",
      attachment: {
        artifactId: "artifact_managed_media_1",
        url: "/api/chat/media/outgoing/k/1/full",
        kind: "document",
        label: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    },
  ],
  __openclaw: { id: "e16", seq: 16, runId: "run-1", transcriptPosition: { source: "S", rawSeq: 27 } },
};
const FILE: TranscriptFileToCopy = {
  fileId: "f1",
  sessionKey: KEY,
  artifactId: "artifact_managed_media_1",
  kind: "document",
  attempts: 0,
};

function rig(mode: "on" | "shadow") {
  const applies: TranscriptApply[] = [];
  const handed: TranscriptFileToCopy[][] = [];
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    readHistory: async () => ({
      sessionKey: KEY,
      sessionId: "s-1",
      messages: [mirror],
      deltaCursor: "c:1",
      sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
    }),
    // Convex answers every apply with the file it recorded (whatever the mode: the
    // reconciler must not hand it over outside `on`).
    apply: async (p) => {
      applies.push(p);
      return { ok: true, filesToCopy: [FILE] };
    },
    copyFiles: (files) => handed.push([...files]),
    sleep: async () => {},
    log: () => {},
  });
  shadow.configure({ mode });
  return { shadow, applies, handed };
}

describe("projection `on`: blocks ride ahead of the read, files go to the copier", () => {
  it("the texts-only post carries the row's blocks; the read carries its identity only", async () => {
    const r = rig("on");
    await r.shadow.idle();
    const [texts, read] = r.applies;
    expect(texts?.textsOnly).toBe(true);
    expect(texts?.rows[0]?.blocks?.map((b) => b.type)).toEqual(["text", "file"]);
    expect(read?.textsOnly).toBeUndefined();
    expect(read?.rows[0]).not.toHaveProperty("blocks");
    expect(read?.rows[0]).toMatchObject({ entryId: "e16", deliveryMirror: true, transcriptPosition: { rawSeq: 27 } });
  });

  it("the files Convex names are handed to the copier after each apply", async () => {
    const r = rig("on");
    await r.shadow.idle();
    expect(r.handed.length).toBeGreaterThanOrEqual(1);
    expect(r.handed[0]).toEqual([FILE]);
  });
});

describe("projection `shadow`: unchanged", () => {
  it("no blocks, no display facts, no texts-only post, and nothing handed to a copier", async () => {
    const r = rig("shadow");
    await r.shadow.idle();
    expect(r.applies).toHaveLength(1);
    expect(r.applies[0]?.textsOnly).toBeUndefined();
    expect(Object.keys(r.applies[0]!.rows[0]!).sort()).toEqual(["entryId", "hidden", "role", "runId", "seq", "visible"]);
    expect(r.handed).toEqual([]);
  });
});

describe("readFilesToCopy — Convex's answer read defensively", () => {
  it("a file names exactly one source; anything else is dropped", () => {
    expect(
      readFilesToCopy([
        FILE,
        { fileId: "f2", sessionKey: KEY, kind: "image", attempts: 0 },
        { fileId: "f3", sessionKey: KEY, kind: "image", artifactId: "a", mediaSource: "/x", attempts: 0 },
        { fileId: "f4", sessionKey: KEY, kind: "image", mediaSource: "/x/y.png", attempts: 2 },
        "junk",
      ]),
    ).toEqual([FILE, { fileId: "f4", sessionKey: KEY, kind: "image", mediaSource: "/x/y.png", attempts: 2 }]);
    expect(readFilesToCopy(undefined)).toEqual([]);
  });
});
