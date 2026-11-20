/**
 * GOLDEN REPLAY (W11/G4) — real captures, replayed with no gateway and no model.
 *
 * Until now the only thing that proved Atrium still INTERPRETS a real gateway
 * conversation correctly was the live bench: minutes per run, an LLM in the loop, a
 * verdict that moves with host load. This suite replays captures promoted from a GO run
 * by `scripts/promote-capture.mjs` (anonymised on the way in) through the whole reading
 * stack — normalizer, run manager, turn sink — in milliseconds, in CI.
 *
 * It replays through the RUN MANAGER, not the normalizer alone, and pins the WRITER
 * CALLS. That is deliberate: announce fusion, the background-task engagement and the plan
 * card are all decided above the normalizer, so a normalizer-only replay would be green
 * while the three things this corpus exists to protect were broken.
 *
 * What is pinned is the interpretation, not the frames. A change that makes an OLD
 * capture mean something new turns this red, and the right reaction is a question — "did
 * I mean to change that reading?" — then updating the snapshot IN THE SAME commit.
 *
 * The clock is the CAPTURED one: `receivedAt` replays as real elapsed time, so the
 * timing-dependent paths stay reachable instead of being frozen out by a synthetic tick.
 */

import { describe, expect, it } from "vitest";

import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import {
  drainDeadlines,
  loadCorpus,
  replay,
  type RecordingWriter,
} from "./helpers/golden-corpus.js";

const CORPUS = loadCorpus();


/** A stable, diff-readable summary: WHICH writes, in what order, at what size. */
function summarise(writer: RecordingWriter): Record<string, unknown> {
  const byCall: Record<string, number> = {};
  const order: string[] = [];
  for (const c of writer.calls) {
    byCall[c.call] = (byCall[c.call] ?? 0) + 1;
    if (order[order.length - 1] !== c.call) order.push(c.call);
  }
  return {
    calls: writer.calls.length,
    byCall,
    order,
    bubbles: writer.calls
      .filter((c) => c.call === "startAssistant")
      .map((c) => c.detail?.runFamily),
    finals: writer.calls.filter((c) => c.call === "finalize").map((c) => c.detail?.status),
    tools: [
      ...new Set(
        writer.calls
          .filter((c) => c.call === "addToolPart")
          .map((c) => `${c.detail?.kind ?? "?"}:${c.detail?.name ?? "?"}`),
      ),
    ].sort(),
    engagements: writer.calls
      .filter((c) => c.call === "upsertSubAgent")
      .map((c) => `${c.detail?.kind}:${c.detail?.status}`),
  };
}

describe("golden corpus", () => {
  it("EXISTS and is non-empty", () => {
    // An absent or empty corpus satisfies every `for (const fx of CORPUS)` below while
    // proving nothing — the same vacuous-green shape as an empty vendored directory.
    expect(
      CORPUS.length,
      "no golden fixtures — run scripts/promote-capture.mjs",
    ).toBeGreaterThan(0);
    for (const fx of CORPUS) {
      expect(fx.entries.length, `${fx.file} has no frames`).toBeGreaterThan(0);
    }
  });

  it("declares a version that MATCHES the directory it sits in", () => {
    // Otherwise a 2026.6.11 capture filed under 2026.7.1 satisfies the whole suite and
    // the corpus silently claims coverage of a version it never saw.
    for (const fx of CORPUS) {
      expect(fx.header.gatewayVersion, `${fx.version}/${fx.file}`).toBe(fx.version);
      expect(fx.header.corpus).toBe("openclaw-golden");
      expect(fx.header.frames, `${fx.file} frame count`).toBe(fx.entries.length);
    }
  });

  it("carries a replay session key its own frames actually use", () => {
    for (const fx of CORPUS) {
      expect(fx.header.sessionKey, `${fx.file}`).toMatch(/:atrium:chat:/);
      const used = fx.entries.some((e) =>
        JSON.stringify(e.frame).includes(fx.header.sessionKey),
      );
      expect(used, `${fx.file}: the replay key appears in no frame`).toBe(true);
    }
  });
});

describe("golden replay — the interpretation is pinned", () => {
  for (const fx of CORPUS) {
    it(`${fx.version}/${fx.header.scenario}`, async () => {
      const writer = await replay(fx);
      // NON-VACUITY, asserted before the snapshot. The first promoter recorded the
      // session key through a second pseudonym mint, so it matched no frame, the
      // isolation gate dropped everything, and nine snapshots were written showing zero
      // events — a corpus that replays nothing passes every comparison it makes.
      expect(writer.calls.length, `${fx.file} replayed to nothing`).toBeGreaterThan(0);
      expect(
        writer.calls.some((c) => c.call === "finalize"),
        `${fx.file} never finalized a message`,
      ).toBe(true);
      expect(summarise(writer)).toMatchSnapshot();
    });
  }
});

describe("golden replay — the corpus covers what it claims", () => {
  const byScenario = new Map(CORPUS.map((fx) => [fx.header.scenario, fx]));

  it("the ANNOUNCE lane opens its own bubble", async () => {
    // What this layer decides: a late child report arrives on the PARENT session with an
    // `announce:` run and must open a turn of its own. The sub-agent ROW is written a
    // layer up (session.ts), so the bubble — and its run family — is the evidence here.
    const fx = byScenario.get("spawn-announce-merge");
    expect(fx, "the announce scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const families = writer.calls
      .filter((c) => c.call === "startAssistant")
      .map((c) => c.detail?.runFamily);
    expect(families, "the announce run opened no bubble").toContain("announce");
    expect(
      writer.calls.filter((c) => c.call === "finalize").length,
      "the announce turn never finalized",
    ).toBeGreaterThan(1);
  });

  it("a SECOND send, held behind a delivery, opens its own turn", async () => {
    // announce-reverse-hold sends the user's reply while an announce run is live; the send is
    // held and dispatched after it. The fixture records both sends, and opening only the first
    // ack left the whole reply unread while the snapshot still passed (codex).
    const fx = byScenario.get("announce-reverse-hold");
    expect(fx, "the announce-reverse-hold scenario is missing from the corpus").toBeDefined();
    expect(fx!.header.ackRunIds, "the fixture records both sends").toHaveLength(2);
    const writer = await replay(fx!);
    expect(
      writer.calls.filter((c) => c.call === "startAssistant").map((c) => c.detail?.runFamily),
      "turn, then the announce, then the held reply",
    ).toEqual(["turn", "announce", "turn"]);
    expect(writer.calls.filter((c) => c.call === "finalize").length, "each of the three turns finalized").toBe(3);
  });

  // WHY `async-task` replays a delivery that carries nothing.
  //
  // Its fixture was produced by PROMOTER 5, which pseudonymised a generated file's path
  // whole — `mediaUrls:["/id43/id44/.id19/…"]` — because the anonymiser preserved
  // `media/outbound` and `media/inbound` only. The capture DID deliver an image; the corpus
  // cannot show it. So the replay finds no media and the delivery-run sensor names the gap,
  // which is the correct reading of what this fixture contains.
  //
  // Promoter 6 preserves the generation directories, and the `promoter` stamp in each
  // fixture header is what makes the mixture visible instead of silent. Re-promoting needs a
  // bench run whose scenarios ALL produced a slice — the promoter refuses a partial capture
  // rather than deleting the fixtures it would leave behind, which is the right refusal.
  it("the BACKGROUND TASK engagement is recorded", async () => {
    const fx = byScenario.get("async-task");
    expect(fx, "the async-task scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const tasks = writer.calls.filter(
      (c) => c.call === "upsertSubAgent" && c.detail?.kind === "task",
    );
    expect(tasks.length, "no kind:task engagement — the async ack was not read").
      toBeGreaterThan(0);
    // …and the DELIVERY, not just the ack. Pseudonymising the task UUID token-by-token
    // broke the `<tool>:<taskId>:ok` grammar, so the delivery run went unrecognised and
    // this scenario proved only that the engagement OPENED (raised in review).
    expect(
      tasks.map((c) => c.detail?.status),
      "the engagement never settled — the delivery run was not correlated",
    ).toContain("done");
    expect(
      writer.calls
        .filter((c) => c.call === "startAssistant")
        .map((c) => c.detail?.runFamily),
      "the delivery opened no bubble",
    ).toContain("task-delivery");
  });

  it("MEDIA rides the transcript row: the live side delivers NO file", async () => {
    // A file reaches a bubble through the transcript row that carries it, copied by its
    // identity (core/artifact-copier.ts) — never from a live `mediaUrls` / `MEDIA:` / tool
    // result path. Every media capture of the corpus DOES carry a live delivery (checked
    // first, so the absence below is not vacuous), and none of it becomes an upload.
    const media = CORPUS.filter((fx) => fx.header.scenario === "media-outbound");
    expect(media.length, "the media scenario is missing from the corpus").toBeGreaterThan(0);
    for (const fx of media) {
      const raw = JSON.stringify(fx.entries.map((e) => e.frame));
      expect(
        raw.includes("mediaUrls") || raw.includes("MEDIA:"),
        `${fx.version}: the capture carries no live delivery`,
      ).toBe(true);
      const writer = await replay(fx);
      expect(
        writer.calls.filter((c) => c.call === "addMedia").length,
        `${fx.version}: a file was taken from the live side`,
      ).toBe(0);
      expect(writer.calls.some((c) => c.call === "finalize"), `${fx.version}: never finalized`).toBe(true);
    }
  });

  it("the PLAN card is produced", async () => {
    const fx = byScenario.get("update-plan");
    expect(fx, "the update-plan scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const plans = writer.calls.filter((c) => c.call === "addPlanPart");
    expect(plans.length, "no plan part — the plan reading is gone").toBeGreaterThan(0);
  });
});

/** The anonymiser MASKS the names of the agent `data` keys it does not allowlist
 *  (`xxxxXx`, scripts/lib/anonymize-capture.mjs): a substitution of its own, not a name
 *  any gateway sent, so the drift detector has nothing to judge in it. Only those names
 *  are removed — every stream, phase, payload field and unmasked key is still judged. */
const MASKED_NAME = /^[xX]+$/;
function withoutMaskedDataKeys(frame: unknown): { frame: unknown; judgedKeys: number } {
  if (typeof frame !== "object" || frame === null) return { frame, judgedKeys: 0 };
  const f = frame as Record<string, unknown>;
  const p = f.payload as Record<string, unknown> | undefined;
  if (f.event !== "agent" || typeof p !== "object" || p === null) return { frame, judgedKeys: 0 };
  const data = p.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { frame, judgedKeys: 0 };
  const kept = Object.fromEntries(Object.entries(data).filter(([k]) => !MASKED_NAME.test(k)));
  return { frame: { ...f, payload: { ...p, data: kept } }, judgedKeys: Object.keys(kept).length };
}

describe("golden replay — the corpus is at the vendored version", () => {
  it("produces NO protocol drift", () => {
    // The corpus was captured from the version the bridge vendors, so a single unknown
    // field means either the capture is from another version or the anonymiser mangled a
    // name — and this catches both. It is also the cheapest check of the anonymiser:
    // mangle a discriminant and the report fills with unknown states.
    //
    // Since the drift detector also judges an agent frame's `data.phase` and `data` keys
    // against the vendored emission inventory, this is the corpus-wide proof that every
    // phase and key a supported gateway was CAPTURED sending is in that inventory — for
    // every version the corpus holds, the older ones included.
    protocolDrift.resetForTests();
    let judgedKeys = 0;
    for (const fx of CORPUS) {
      for (const e of fx.entries) {
        const stripped = withoutMaskedDataKeys(e.frame);
        judgedKeys += stripped.judgedKeys;
        protocolDrift.observe(stripped.frame);
      }
    }
    expect(protocolDrift.report()).toEqual([]);
    expect(protocolDrift.overflowCount()).toBe(0);
    // Not vacuous: the corpus carries thousands of unmasked `data` keys to judge.
    expect(judgedKeys).toBeGreaterThan(10_000);
  });
});

describe("drainDeadlines", () => {
  it("advances by the REMAINING seconds, not to them", () => {
    // `nextTimeout` returns a duration. Treating it as an absolute time moved the clock a
    // millisecond per step, so a capture that ends inside a 600 s approval wait would
    // never have finalized — and the replay would have looked like it tried.
    const ticks: number[] = [];
    const remaining = [240, 600, null] as (number | null)[];
    let i = 0;
    const stub = {
      nextTimeout: (): number | null => remaining[i++] ?? null,
      tick: async (now: number): Promise<void> => {
        ticks.push(Math.round(now));
      },
    };
    return drainDeadlines(stub, 1000).then((end) => {
      expect(ticks).toEqual([1240, 1840]);
      expect(Math.round(end)).toBe(1840);
    });
  });

  it("stops at the step cap instead of spinning forever", async () => {
    const stub = {
      nextTimeout: (): number => 1,
      tick: async (): Promise<void> => {},
    };
    expect(await drainDeadlines(stub, 0, 5)).toBeCloseTo(5.005, 2);
  });
});

describe("drainDeadlines — the `until` bound", () => {
  it("fires a deadline that expires BEFORE the next frame", async () => {
    const ticks: number[] = [];
    let armed: number | null = 30;
    const stub = {
      nextTimeout: (): number | null => armed,
      tick: async (now: number): Promise<void> => {
        ticks.push(Math.round(now));
        armed = null;
      },
    };
    // Next frame lands 120 s later; a 30 s deadline expired during that silence.
    await drainDeadlines(stub, 1000, 64, 1120);
    expect(ticks).toEqual([1030]);
  });

  it("does NOT fire one that expires after it", async () => {
    const ticks: number[] = [];
    const stub = {
      nextTimeout: (): number | null => 300,
      tick: async (now: number): Promise<void> => {
        ticks.push(now);
      },
    };
    // The frame arrives 10 s later: in production the deadline has not expired yet, and
    // firing it early would replay a finalization that never happened.
    const end = await drainDeadlines(stub, 1000, 64, 1010);
    expect(ticks).toEqual([]);
    expect(end).toBe(1000);
  });
});
