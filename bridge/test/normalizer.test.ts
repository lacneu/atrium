/**
 * Regression tests for the streaming normalizer (TypeScript port).
 *
 * Mirror of backend/tests/test_normalizer.py. Each test replays real OpenClaw
 * frame shapes through the normalizer with an INJECTED clock and asserts the
 * stable events a correct bridge must emit. The fixtures are REUSED VERBATIM
 * from backend/tests/fixtures/openclaw_frames.json (read relatively), so the
 * same 12 real-frame scenarios that guard the Python normalizer guard this one.
 *
 * Two assertions are adapted for the Convex media shape (filtering + no path
 * leak preserved); the other 10 scenarios assert identical behavior.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASE_RECV_TIMEOUT,
  EMPTY_FINAL_GRACE,
  LIFECYCLE_END_GRACE,
  PRIVATE_ACK_GRACE,
  Normalizer,
  type BridgeEvent,
} from "../src/providers/openclaw/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// CANONICAL frame fixtures (real OpenClaw frames) — the single source of truth
// for the normalizer spec, vendored into this repo at test/fixtures/. (Originally
// mirrored from the now-removed Python backend's test_normalizer.py.)
const FIXTURES_PATH = resolve(
  __dirname,
  "./fixtures/openclaw_frames.json",
);
const FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
  session_key: string;
  run_id: string;
  scenarios: Record<string, { description: string; frames: unknown[] }>;
};

const SESSION_KEY = FIXTURES.session_key;
const OWN_RUN = FIXTURES.run_id;

function newNormalizer(): Normalizer {
  return new Normalizer(SESSION_KEY);
}

function frames(scenario: string): unknown[] {
  const s = FIXTURES.scenarios[scenario];
  if (!s) {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  return s.frames;
}

class Clock {
  now = 1000.0;
  tick(seconds = 0.01): number {
    this.now += seconds;
    return this.now;
  }
}

function drive(
  scenario: string,
  opts: { seedRun?: string | null; advanceToFinalize?: boolean } = {},
): { events: BridgeEvent[]; normalizer: Normalizer; clock: Clock } {
  const seedRun = opts.seedRun === undefined ? OWN_RUN : opts.seedRun;
  const advanceToFinalize = opts.advanceToFinalize ?? false;
  const normalizer = newNormalizer();
  const clock = new Clock();
  const events: BridgeEvent[] = [];
  normalizer.beginTurn(clock.now);
  if (seedRun) {
    normalizer.noteRunStarted(seedRun, clock.now);
  }
  for (const frame of frames(scenario)) {
    events.push(...normalizer.feed(frame, clock.tick()));
  }
  if (advanceToFinalize && !normalizer.finalized) {
    // Jump past every armed grace so any pending turn finalizes.
    clock.tick(BASE_RECV_TIMEOUT + 1);
    events.push(...normalizer.tick(clock.now));
    // NEW CONTRACT: a pure recv-silence no longer self-finalizes (the session
    // queries the gateway instead). Mirror the session's no-fetcher settle so
    // finalize-time behavior stays observable in these normalizer-level tests.
    if (!normalizer.finalized && normalizer.takeRecvSilence()) {
      events.push(...normalizer.endTurn(clock.now, "final", null, "recv_timeout"));
    }
  }
  return { events, normalizer, clock };
}

function visibleText(events: BridgeEvent[]): string {
  let text = "";
  for (const event of events) {
    const kind = event.type;
    if (kind === "message.delta") {
      text += String(event.text);
    } else if (kind === "message.snapshot" || kind === "message.final") {
      text = String(event.text);
    } else if (kind === "run.status" && event.status === "compacting") {
      text = "";
    }
  }
  return text;
}

function finalText(events: BridgeEvent[]): string | null {
  const finals = events.filter((e) => e.type === "message.final");
  return finals.length ? String(finals[finals.length - 1]!.text) : null;
}

function statuses(events: BridgeEvent[]): unknown[] {
  return events.filter((e) => e.type === "run.status").map((e) => e.status);
}

function mediaItems(events: BridgeEvent[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === "media") {
      items.push(...(event.items as Array<Record<string, unknown>>));
    }
  }
  return items;
}

// --- core text scenarios -----------------------------------------------------

describe("core text scenarios", () => {
  it("chat final content list parts", () => {
    const { events } = drive("chat-final-content");
    expect(finalText(events)).toBe("Bonjour !");
    expect(visibleText(events)).toBe("Bonjour !");
  });

  it("chat final content string", () => {
    const { events } = drive("chat-final-content-string");
    expect(finalText(events)).toBe("Réponse en texte simple.");
  });

  it("empty final then content is not lost", () => {
    const { events, normalizer } = drive("chat-final-empty-then-content");
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("Réponse arrivée après final vide.");
    // The sessionless 'health' broadcast must never reach the browser.
    const leaked = events.some(
      (e) =>
        e.type === "openclaw.frame" &&
        (e.frame as Record<string, unknown> | undefined)?.event === "health",
    );
    expect(leaked).toBe(false);
  });

  it("duplicate final is deduped", () => {
    const { events } = drive("duplicate-final");
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => e.text);
    expect(deltas).toEqual(["Hello ", "Hello ", "world!"]); // exact re-broadcast dropped
    expect(finalText(events)).toBe("Hello Hello world!");
  });

  it("chat deltaText preserves spaces", () => {
    const { events } = drive("chat-deltatext-spaces");
    expect(finalText(events)).toBe("Voici l'image générée !");
    expect(visibleText(events)).toBe("Voici l'image générée !");
  });

  it("agent assistant delta legacy accumulates", () => {
    const { events, normalizer } = drive("agent-assistant-delta-legacy", {
      advanceToFinalize: true,
    });
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("Hello world");
  });

  it("duplicate empty final finalizes gracefully", () => {
    const { events, normalizer } = drive("duplicate-empty-final", {
      advanceToFinalize: true,
    });
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("");
    // The duplicate empty final emitted no normalized message event.
    const msgs = events.filter(
      (e) => e.type === "message.delta" || e.type === "message.snapshot",
    );
    expect(msgs).toEqual([]);
  });
});

// --- multi-run / lifecycle ---------------------------------------------------

describe("multi-run / lifecycle", () => {
  it("lifecycle end then follow-on run", () => {
    const { events, normalizer } = drive("lifecycle-end-then-followon-run");
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("Réponse de suivi.");
    expect(statuses(events)).toContain("working");
    expect(statuses(events)).toContain("running");
  });

  it("compaction abandoned resets buffer", () => {
    const { events } = drive("compaction-abandoned-replay", {
      advanceToFinalize: true,
    });
    expect(statuses(events)).toContain("compacting");
    // part1 was invalidated by the abandoned marker; only part2 survives.
    expect(finalText(events)).toBe("part2");
    expect(visibleText(events)).toBe("part2");
    // P2 (Codex): the abandon must emit an EMPTY SNAPSHOT so the real sink clears
    // the already-persisted liveText (turn-sink drops the intermediate
    // "compacting" run.status — only a snapshot/delta/final mutates the writer).
    // Without it, a replay yielding no text would finalize on the stale prefix.
    const emptySnapshotBeforePart2 = events.some(
      (e, i) =>
        e.type === "message.snapshot" &&
        String(e.text) === "" &&
        events.slice(i + 1).some((later) => String((later as { text?: unknown }).text ?? "").includes("part2")),
    );
    expect(emptySnapshotBeforePart2).toBe(true);
  });

  it("normal end working replayInvalid does not reset", () => {
    const { events } = drive("normal-end-working-replayinvalid", {
      advanceToFinalize: true,
    });
    expect(statuses(events)).not.toContain("compacting");
    expect(finalText(events)).toBe("complete answer");
  });
});

// --- private acks ------------------------------------------------------------

describe("private acks", () => {
  it("private ack then visible message wins", () => {
    const { events, normalizer } = drive("private-ack-then-visible");
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("L'identifiant visible.");
    // The ack was never emitted as a message.
    expect(visibleText(events)).not.toContain("Envoyé.");
  });

  it("private ack only finalizes gracefully", () => {
    // No follow-on ever arrives; after the grace the turn must finalize.
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    for (const frame of frames("private-ack-only")) {
      events.push(...normalizer.feed(frame, clock.tick()));
    }
    expect(normalizer.finalized).toBe(false); // still waiting for the visible message
    // Nearest deadline is the private-ack grace.
    const t = normalizer.nextTimeout(clock.now);
    expect(t).not.toBeNull();
    expect(t as number).toBeLessThanOrEqual(PRIVATE_ACK_GRACE);
    clock.tick(PRIVATE_ACK_GRACE + 1);
    events.push(...normalizer.tick(clock.now));
    expect(normalizer.finalized).toBe(true);
    expect(finalText(events)).toBe("Envoyé."); // best-effort fallback, never blank hang
  });
});

// --- tool message delivery ---------------------------------------------------

describe("tool message delivery", () => {
  it("message tool visible beats private ack", () => {
    const { events } = drive("tool-message-visible");
    expect(finalText(events)).toBe("Réponse visible complète.");
    expect(
      events.some((e) => e.type === "tool.status" && e.name === "message"),
    ).toBe(true);
  });

  it("message tool external target is ignored", () => {
    const { events } = drive("tool-message-external-target-ignored");
    expect(finalText(events)).toBe("Réponse réelle.");
  });
});

// --- sessions_spawn success flagged isError (OpenClaw quirk) ------------------

describe("sessions_spawn result status", () => {
  // Feed one `sessions_spawn` tool result frame (with an explicit isError) + return
  // the tool.status event it emits.
  function spawnStatus(result: unknown, isError: boolean) {
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    events.push(
      ...normalizer.feed(
        {
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: OWN_RUN,
            stream: "tool",
            data: {
              name: "sessions_spawn",
              phase: "result",
              toolCallId: "tc-spawn",
              isError,
              result,
            },
          },
        },
        clock.tick(),
      ),
    );
    return events.find(
      (e) => e.type === "tool.status" && e.name === "sessions_spawn",
    ) as { phase: string } | undefined;
  }

  // OpenClaw marks a SUCCESSFUL spawn's result isError:true; the child IS created
  // (its childSessionKey is in the result). The card must NOT read "error".
  const acceptedResult = {
    content: [
      {
        type: "text",
        text: '{"status":"accepted","childSessionKey":"agent:alice:subagent:1234"}',
      },
    ],
  };

  it("isError:true WITH a childSessionKey renders completed (spawn succeeded)", () => {
    expect(spawnStatus(acceptedResult, true)?.phase).toBe("completed");
  });

  it("isError:true WITHOUT a childSessionKey stays error (real spawn failure)", () => {
    const rejected = {
      content: [{ type: "text", text: '{"status":"rejected","reason":"quota"}' }],
    };
    // Delete-the-guard check: a genuine failure (no childSessionKey) MUST stay error,
    // else the fix would mask real spawn failures.
    expect(spawnStatus(rejected, true)?.phase).toBe("error");
  });

  it("a non-spawn tool with isError:true is unaffected (still error)", () => {
    // The override is scoped to sessions_spawn only — childSessionKey text in some
    // OTHER tool's output must not flip it to completed.
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    events.push(
      ...normalizer.feed(
        {
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: OWN_RUN,
            stream: "tool",
            data: {
              name: "web_fetch",
              phase: "result",
              toolCallId: "tc-wf",
              isError: true,
              result: acceptedResult,
            },
          },
        },
        clock.tick(),
      ),
    );
    const s = events.find(
      (e) => e.type === "tool.status" && e.name === "web_fetch",
    ) as { phase: string } | undefined;
    expect(s?.phase).toBe("error");
  });
});

// --- media (adapted to the Convex {filename, path} shape) ---------------------

describe("media", () => {
  it("mediaUrls list is filtered (Convex shape: filename + path, no signed url)", () => {
    const { events } = drive("mediaurls-list", { advanceToFinalize: true });
    const items = mediaItems(events);
    // Same filtering as Python: dup collapsed, empty/int/https/../inbound rejected.
    expect(items.map((i) => i.filename)).toEqual(["a.pdf", "c.pdf"]);
    // ADAPTATION: no signed url. Instead each item carries the outbound
    // absolute path the bridge fetches later. No path leak to a query/scheme.
    for (const i of items) {
      expect(typeof i.path).toBe("string");
      expect(i.path as string).toMatch(/^\/home\/node\/\.openclaw\/media\/outbound\//);
      expect(i).not.toHaveProperty("url");
    }
    expect(items.map((i) => i.path)).toEqual([
      "/home/node/.openclaw/media/outbound/a.pdf",
      "/home/node/.openclaw/media/outbound/c.pdf",
    ]);
  });

  it("media directive: emits a media part + drops the directive line (no dead link)", () => {
    const { events } = drive("media-directive", { advanceToFinalize: true });
    const text = finalText(events);
    expect(text).not.toBeNull();
    // The raw /home/node path must never reach the browser.
    expect(text!).not.toContain("/home/node/.openclaw");
    // The MEDIA: directive line is DROPPED (no dead `./media/` markdown link —
    // the attachment is the canonical media part); surrounding prose is kept.
    expect(text!).not.toContain("MEDIA:");
    expect(text!).not.toContain("](./media/");
    expect(text!).toContain("voir");
    expect(text!).toContain("fin");
    // It IS surfaced as a real downloadable attachment.
    expect(mediaItems(events).map((i) => i.filename)).toContain("r.pdf");
  });

  it("exec tool result: outbound path embedded in multi-line stdout emits a media item", () => {
    // The write-md-file skill (and any `exec`-produced file) surfaces its path
    // ONLY as a "MEDIA:/home/node/.../outbound/<f>" line inside the tool RESULT
    // -- never as a `mediaUrls` array nor in the visible reply. Before the fix,
    // collectMedia required each candidate to BE a bare path, so a path buried in
    // multi-line stdout was dropped and the attachment never reached the webchat.
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const result =
      "+ ./write.sh fruits\nwrote 3 lines\n" +
      "MEDIA:/home/node/.openclaw/media/outbound/fruits---f998f47f.md\n" +
      // A traversal path and an inbound path in the same transcript must NOT leak:
      "note /home/node/.openclaw/media/outbound/../secret.pdf\n" +
      "src /home/node/.openclaw/media/inbound/x.pdf\nexit 0";
    events.push(
      ...normalizer.feed(
        {
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: OWN_RUN,
            stream: "tool",
            data: { name: "exec", phase: "result", toolCallId: "tc-exec-1", result },
          },
        },
        clock.tick(),
      ),
    );
    events.push(
      ...normalizer.feed(
        {
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: OWN_RUN,
            stream: "lifecycle",
            data: { phase: "end" },
          },
        },
        clock.tick(),
      ),
    );
    // Only the valid outbound path is emitted; traversal + inbound are rejected.
    expect(mediaItems(events)).toEqual([
      {
        filename: "fruits---f998f47f.md",
        path: "/home/node/.openclaw/media/outbound/fruits---f998f47f.md",
        explicit: true, // MEDIA: directive line = a deliberate delivery
      },
    ]);
  });

  // Feed one `agent`/tool `result` frame + a lifecycle end; return its events.
  function feedToolResult(result: unknown, name = "exec"): BridgeEvent[] {
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    events.push(
      ...normalizer.feed(
        {
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: OWN_RUN,
            stream: "tool",
            data: { name, phase: "result", toolCallId: "tc-1", result },
          },
        },
        clock.tick(),
      ),
    );
    return events;
  }

  it("MEDIA: directive with SPACES in the filename keeps the WHOLE path (gateway-http bug)", () => {
    // The reported prod failure: a pptx->pdf produced "IFOA Presentation.pdf" and
    // the agent emitted `MEDIA:/.../IFOA Presentation.pdf`. The OLD bare-token scan
    // (`[^\s...]+`) truncated at the first space -> the bridge tried to fetch
    // ".../IFOA" (not found) -> NO media part, while sanitize stripped the line
    // correctly. The directive now yields the rest-of-line path, spaces intact.
    const events = feedToolResult(
      "done\nMEDIA:/home/node/.openclaw/media/outbound/IFOA Presentation.pdf\nexit 0",
    );
    expect(mediaItems(events)).toEqual([
      {
        filename: "IFOA Presentation.pdf",
        path: "/home/node/.openclaw/media/outbound/IFOA Presentation.pdf",
        explicit: true, // MEDIA: directive line = a deliberate delivery
      },
    ]);
    // Discriminating: delete the directive handling and this regresses to the
    // truncated "IFOA" basename — assert the full multi-word name explicitly.
    expect(mediaItems(events)[0]!.filename).not.toBe("IFOA");
  });

  it("structured tool-result path (apply_patch changes[].path) is hosted, spaces included", () => {
    // A file-edit tool reports its target as a STRUCTURED JSON field, not free
    // text. flattenStrings yields that path as a standalone string, so it is
    // hosted WITHOUT the regex (hence spaces are safe) — the gateway-http
    // deterministic signal that needs no MEDIA: narration. Pins that behavior.
    const events = feedToolResult(
      {
        status: "completed",
        changes: [
          {
            path: "/home/node/.openclaw/media/outbound/Mon Rapport Final.pdf",
            kind: { type: "add" },
          },
        ],
      },
      "apply_patch",
    );
    expect(mediaItems(events)).toEqual([
      {
        filename: "Mon Rapport Final.pdf",
        path: "/home/node/.openclaw/media/outbound/Mon Rapport Final.pdf",
        explicit: true, // a structured tool-result field that IS the path
      },
    ]);
  });

  it("a bare outbound path embedded in PROSE (no MEDIA: prefix, with a space) stays conservative", () => {
    // Documents the boundary: outside the explicit MEDIA: convention, a space in
    // free prose is ambiguous (filename char vs path/word separator), so the
    // bare-token scan still stops at the space. This is why the bridge INJECTS the
    // MEDIA: convention ([LIVRAISON]) rather than relying on prose mentions.
    const events = feedToolResult(
      "I saved it to /home/node/.openclaw/media/outbound/My File.pdf for you.",
    );
    expect(mediaItems(events).map((i) => i.path)).toEqual([
      "/home/node/.openclaw/media/outbound/My",
    ]);
  });

  it("a path MENTIONED in prose (memory note read by a tool) is tagged NON-explicit", () => {
    // The exports bug: the agent read its memory citing last week's deliveries;
    // those paths must ride as mention-only so the fetcher freshness-gates them.
    const events = feedToolResult(
      "- 2026-06-29: Bilan livre sous /home/node/.openclaw/media/outbound/bilan-news-ia-2026-06-28---c18b07b9.md (12 295 bytes)",
    );
    const items = mediaItems(events);
    expect(items).toHaveLength(1);
    expect(items[0]!.explicit).toBe(false);
  });

  it("an explicit MEDIA: in a LATER frame re-emits a path first seen as a mention (cross-call upgrade)", () => {
    // The intentional re-send case: an earlier tool result MENTIONS an old path
    // (emitted mention-only, possibly stale-dropped by the fetcher), then the
    // agent explicitly delivers the SAME path via MEDIA:. The turn-level dedupe
    // must NOT swallow the explicit delivery — it re-emits explicit:true.
    const normalizer = newNormalizer();
    const clock = new Clock();
    const events: BridgeEvent[] = [];
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const feed = (result: string) =>
      events.push(
        ...normalizer.feed(
          {
            event: "agent",
            payload: {
              sessionKey: SESSION_KEY,
              runId: OWN_RUN,
              stream: "tool",
              data: { name: "exec", phase: "result", toolCallId: `t${events.length}`, result },
            },
          },
          clock.tick(),
        ),
      );
    feed("note: /home/node/.openclaw/media/outbound/old-bilan.md was delivered last week");
    feed("MEDIA:/home/node/.openclaw/media/outbound/old-bilan.md");
    const items = mediaItems(events);
    expect(items).toHaveLength(2); // the mention, then the explicit re-emission
    expect(items[0]!.explicit).toBe(false);
    expect(items[1]!.explicit).toBe(true);
  });

  it("the SAME path mentioned in prose AND delivered via MEDIA: reads explicit (upgrade)", () => {
    const events = feedToolResult(
      "note /home/node/.openclaw/media/outbound/report.md\n" +
        "MEDIA:/home/node/.openclaw/media/outbound/report.md",
    );
    const items = mediaItems(events);
    expect(items).toHaveLength(1); // deduped
    expect(items[0]!.explicit).toBe(true); // the directive wins
  });
});

// --- upstream error ----------------------------------------------------------

describe("upstream error", () => {
  it("lifecycle error finalizes as error with partial", () => {
    const { events, normalizer } = drive("lifecycle-error");
    expect(normalizer.finalized).toBe(true);
    expect(statuses(events)).toContain("error");
    expect(finalText(events)).toBe("moitié"); // partial content preserved
    const finals = events.filter((e) => e.type === "message.final");
    const final = finals[finals.length - 1]!;
    expect(String(final.error ?? "")).toContain("Context overflow");
  });
});

// --- isolation ---------------------------------------------------------------

describe("isolation", () => {
  it("foreign session frame is dropped", () => {
    const { events } = drive("isolation-foreign-session");
    expect(events).toEqual([]);
  });

  it("same session foreign run is dropped", () => {
    const { events } = drive("isolation-same-session-foreign-run");
    expect(events).toEqual([]); // sessionKey match alone is not enough
  });

  it("sessionless frame is dropped", () => {
    const { events } = drive("isolation-sessionless");
    expect(events).toEqual([]);
  });

  it("passthrough openclaw.frame emitted for own frames", () => {
    const { events } = drive("chat-final-content");
    const passthroughs = events.filter((e) => e.type === "openclaw.frame");
    expect(passthroughs.length).toBeGreaterThan(0);
  });
});

// --- timing model ------------------------------------------------------------

describe("timing model", () => {
  it("next timeout is null when idle", () => {
    const normalizer = newNormalizer();
    expect(normalizer.nextTimeout(1000.0)).toBeNull(); // no turn -> wait forever
  });

  it("recv budget armed during active turn", () => {
    const normalizer = newNormalizer();
    normalizer.beginTurn(1000.0);
    const timeout = normalizer.nextTimeout(1000.0);
    expect(timeout).not.toBeNull();
    expect(timeout as number).toBeLessThanOrEqual(BASE_RECV_TIMEOUT);
  });
});

// --- native media generation without delivery (the C3 gap, live-found 2026-06-18) -
// OpenClaw 2026.6.5 emits a codex `imageGeneration` item ({stream:
// "codex_app_server.item", data:{type:"imageGeneration", phase}}) that carries NO
// path/url/bytes. When the agent generates media this way but emits NO
// MEDIA:/mediaUrls delivery directive, there is nothing for the bridge to fetch.
// finalize must surface a SOC2-safe `media.undelivered` diagnostic so the gap (the
// agent's missing delivery directive) is visible — and must NOT false-positive when
// the agent DID deliver, nor on a plain turn. These guard the behaviour across
// future OpenClaw compat versions.
describe("native media generation without delivery", () => {
  const imgGen = (phase: string) => ({
    event: "agent",
    payload: {
      sessionKey: SESSION_KEY,
      runId: OWN_RUN,
      stream: "codex_app_server.item",
      data: { type: "imageGeneration", phase, itemId: "ig_test" },
    },
  });
  const assistantText = (text: string) => ({
    event: "agent",
    payload: { sessionKey: SESSION_KEY, runId: OWN_RUN, stream: "assistant", data: { text } },
  });
  function run(feedFrames: unknown[]): BridgeEvent[] {
    const n = newNormalizer();
    const c = new Clock();
    n.beginTurn(c.now);
    n.noteRunStarted(OWN_RUN, c.now);
    const ev: BridgeEvent[] = [];
    for (const f of feedFrames) ev.push(...n.feed(f, c.tick()));
    c.tick(BASE_RECV_TIMEOUT + 1);
    ev.push(...n.tick(c.now));
    // New contract: pure recv-silence signals instead of finalizing — settle
    // explicitly (as the session's degraded fallback does) so finalize-time
    // diagnostics (media.undelivered) stay observable here.
    if (!n.finalized && n.takeRecvSilence()) {
      ev.push(...n.endTurn(c.now, "final", null, "recv_timeout"));
    }
    return ev;
  }

  it("imageGeneration completed + NO media -> emits media.undelivered (no media part)", () => {
    const ev = run([imgGen("started"), imgGen("completed"), assistantText("Voici l'image.")]);
    expect(ev.some((e) => e.type === "media.undelivered")).toBe(true);
    expect(ev.some((e) => e.type === "media")).toBe(false);
  });

  it("imageGeneration completed BUT delivered via MEDIA: -> NO diagnostic (media wins)", () => {
    const ev = run([
      imgGen("completed"),
      assistantText("Voici.\nMEDIA:/home/node/.openclaw/media/outbound/red.png"),
    ]);
    expect(ev.some((e) => e.type === "media")).toBe(true);
    expect(ev.some((e) => e.type === "media.undelivered")).toBe(false);
  });

  it("plain turn (no imageGeneration) -> never emits the diagnostic (no false positive)", () => {
    const ev = run([assistantText("just text, no media")]);
    expect(ev.some((e) => e.type === "media.undelivered")).toBe(false);
  });
});

// Silence unused-import lint when EMPTY_FINAL_GRACE / LIFECYCLE_END_GRACE are
// only referenced for documentation parity with the Python suite.
void EMPTY_FINAL_GRACE;
void LIFECYCLE_END_GRACE;

// SUB-AGENT observation (Track B): a child run spawned inside THIS chat (`sessions_spawn`)
// emits on `agent:<id>:subagent:<uuid>` but every frame carries `spawnedBy` = the PARENT
// sessionKey. We admit it for OBSERVATION ONLY, keyed on `spawnedBy === this.sessionKey`
// (contamination-proof — the chatId is in the parent key), emitting `agent.activity` and NEVER
// touching the parent's run-state or reply text.
describe("sub-agent observation (spawnedBy admission)", () => {
  const CHILD_SK = "agent:alice:subagent:test-uuid";
  const start = (): { n: Normalizer; clock: Clock } => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };

  it("a child lifecycle frame (spawnedBy === this session) → agent.activity, NEVER message.*", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          stream: "codex_app_server.lifecycle",
          data: { phase: "startup" },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "running", phase: "startup" },
    ]);
    expect(ev.some((e) => String(e.type).startsWith("message."))).toBe(false);
  });

  it("a child chat:final → agent.activity carries the result text + done", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "chat",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "ZULU_DELTA_777" }] },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "done", done: true, text: "ZULU_DELTA_777" },
    ]);
  });

  it("a child chat:error → agent.activity status error + errorMessage (the failure signal)", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "chat",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          state: "error",
          errorMessage: "codex app-server turn idle timed out waiting for turn/completed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Error: codex app-server turn idle timed out waiting for turn/completed" }],
          },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      {
        type: "agent.activity",
        childSessionKey: CHILD_SK,
        status: "error",
        done: true,
        errorMessage: "codex app-server turn idle timed out waiting for turn/completed",
      },
    ]);
  });

  it("a child lifecycle phase:error → agent.activity status error + errorMessage", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "error", error: "boom", endedAt: 1 },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "error", phase: "error", done: true, errorMessage: "boom" },
    ]);
  });

  it("a child chat:aborted → agent.activity status aborted (stopped/cancelled)", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "chat",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          state: "aborted",
          message: { role: "assistant", content: [] },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "aborted", done: true, errorMessage: "" },
    ]);
  });

  it("a child of ANOTHER chat (different spawnedBy) is DROPPED — contamination-proof", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: "x",
          sessionKey: "agent:alice:subagent:other",
          spawnedBy: "agent:alice:atrium:chat:olivier:OTHER-CHAT",
          stream: "codex_app_server.lifecycle",
          data: { phase: "startup" },
        },
      },
      clock.tick(),
    );
    expect(ev).toEqual([]); // foreign spawnedBy → not admitted; the isolation gate drops it
  });

  it("a child's output NEVER pollutes the parent reply (run-state stays isolated)", () => {
    const { n, clock } = start();
    const out: BridgeEvent[] = [];
    out.push(
      ...n.feed(
        { event: "chat", payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "delta", deltaText: "parent-answer" } },
        clock.tick(),
      ),
    );
    // The child interleaves its OWN final mid-parent-turn.
    out.push(
      ...n.feed(
        {
          event: "chat",
          payload: {
            runId: "child-run",
            sessionKey: CHILD_SK,
            spawnedBy: SESSION_KEY,
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "ZULU_DELTA_777" }] },
          },
        },
        clock.tick(),
      ),
    );
    out.push(
      ...n.feed(
        {
          event: "chat",
          payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "final", message: { role: "assistant", content: [{ type: "text", text: "parent-answer" }] } },
        },
        clock.tick(),
      ),
    );
    const finalText = out
      .filter((e) => e.type === "message.final")
      .map((e) => String((e as Record<string, unknown>).text ?? ""))
      .join("");
    expect(finalText).toContain("parent-answer");
    expect(finalText).not.toContain("ZULU_DELTA_777"); // child output is never the parent's reply
  });

  it("a child final with STRING content still yields the result (reuses textFromMessage)", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "chat",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: "STRING_RESULT" },
        },
      },
      clock.tick(),
    );
    expect(ev.filter((e) => e.type === "agent.activity")).toEqual([
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "done", done: true, text: "STRING_RESULT" },
    ]);
  });

  it("a child TOOL frame (stream:tool with data.phase) is NOT surfaced as a lifecycle phase", () => {
    const { n, clock } = start();
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: "child-run",
          sessionKey: CHILD_SK,
          spawnedBy: SESSION_KEY,
          stream: "tool", // a tool frame ALSO carries data.phase — must not become lifecycle
          data: { phase: "completed" },
        },
      },
      clock.tick(),
    );
    expect(ev).toEqual([]); // only true `…lifecycle` streams emit a phase
  });

  it("child observation does NOT touch the parent's recv timer (full isolation)", () => {
    // A child frame is fed at T; if it (wrongly) re-armed the parent, the parent turn would
    // survive past its own recv deadline. With full isolation it does not — the parent's
    // timeout is governed solely by PARENT-lane activity (here: none after the seed).
    const { n, clock } = start();
    clock.tick(BASE_RECV_TIMEOUT * 0.5);
    n.feed(
      {
        event: "agent",
        payload: { runId: "child-run", sessionKey: CHILD_SK, spawnedBy: SESSION_KEY, stream: "codex_app_server.lifecycle", data: { phase: "running" } },
      },
      clock.now,
    );
    clock.tick(BASE_RECV_TIMEOUT * 0.6); // now past the parent's recv deadline since beginTurn
    n.tick(clock.now);
    // The child did NOT extend the parent: the parent's silence deadline elapsed
    // ON TIME (new contract: it raises the gateway-query signal instead of
    // self-finalizing — a re-armed timer would leave the signal unraised here).
    expect(n.finalized).toBe(false);
    expect(n.takeRecvSilence()).toBe(true);
  });
});

describe("main-lane chat error/aborted terminalization (ChatErrorEventSchema)", () => {
  // Shapes pinned on the OFFICIAL protocol schema (gateway-protocol
  // logs-chat.ts): ChatErrorEventSchema = { state:"error", errorMessage?,
  // errorKind? (refusal|timeout|rate_limit|context_length|unknown), message? },
  // ChatAbortedEventSchema = { state:"aborted", stopReason? }. Previously these
  // frames fell through handleChat (only "final" was recognized) — the turn
  // hung until the 180s recv timeout and the failure class was lost.
  function chatFrame(payload: Record<string, unknown>): unknown {
    return {
      type: "event",
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, seq: 5, ...payload },
    };
  }

  it("EVERY documented overflow phrasing (no errorKind) classifies to context_length (fallback RE)", () => {
    // The OpenClaw-documented provider overflow patterns (docs/concepts/compaction)
    // + Atrium's UI phrasing — each must reach the actionable card, not a generic
    // error. Real gateways send these as BARE text (no errorKind).
    const phrasings = [
      "Context overflow: prompt too large for the model.",
      "request_too_large: 300000 tokens > 272000",
      "This model's maximum context length is 272000 tokens",
      "context length exceeded",
      "input exceeds the maximum number of tokens",
      "input token count exceeds the maximum number of input tokens",
      "input is too long for the model",
      "ollama error: context length exceeded",
    ];
    for (const text of phrasings) {
      const normalizer = newNormalizer();
      const clock = new Clock();
      normalizer.beginTurn(clock.now);
      normalizer.noteRunStarted(OWN_RUN, clock.now);
      const events = normalizer.feed(
        {
          type: "event",
          event: "chat",
          payload: {
            runId: OWN_RUN,
            sessionKey: SESSION_KEY,
            state: "error",
            errorMessage: text, // NO errorKind — the text fallback must fire
          },
        },
        clock.tick(),
      );
      const final = events.find((e) => e.type === "message.final");
      expect(final?.errorKind, `phrasing: ${text}`).toBe("context_length");
    }
  });

  it("TRANSIENT provider failures (gateway wraps, raw 5xx, network cuts) classify to provider_internal", () => {
    // The gateway's own vendored wraps (dist assistant-error-format, read
    // 2026-07-20) + raw transport markers (the VPN-flip family).
    const transient = [
      "The AI service returned an internal error. Please try again in a moment.",
      "The AI service returned an error. Please try again.",
      "The AI service is temporarily overloaded. Please try again in a moment.",
      "The AI service is temporarily unavailable (HTTP 522). Please try again in a moment.",
      "LLM streaming response contained a malformed fragment. Please try again.",
      "HTTP 500: An error occurred while processing your request.",
      "All models failed (1): openai/gpt-5.6-sol: 502 Bad Gateway",
      "fetch failed",
      "read ECONNRESET",
      "socket hang up",
    ];
    for (const error of transient) {
      const n = newNormalizer();
      const c = new Clock();
      n.beginTurn(c.now);
      n.noteRunStarted(OWN_RUN, c.now);
      const events = n.feed(
        chatFrame({ state: "error", errorMessage: error }),
        c.tick(),
      );
      const final = events.find((e) => e.type === "message.final");
      expect(final?.errorKind, error).toBe("provider_internal");
    }
  });

  it("NEVER-transient failures are NOT classified provider_internal (no retry on auth/quota/4xx/rate-limit)", () => {
    const nonTransient = [
      "The AI service is temporarily rate-limited. Please try again in a moment.",
      "HTTP 401: Unauthorized",
      "HTTP 429: Too Many Requests",
      "invalid_api_key: Incorrect API key provided",
      "HTTP 404: model not found",
      "insufficient_quota: You exceeded your current quota",
      "All models failed (1): openai/gpt-5.5: 403 Forbidden",
    ];
    for (const error of nonTransient) {
      const n = newNormalizer();
      const c = new Clock();
      n.beginTurn(c.now);
      n.noteRunStarted(OWN_RUN, c.now);
      const events = n.feed(
        chatFrame({ state: "error", errorMessage: error }),
        c.tick(),
      );
      const final = events.find((e) => e.type === "message.final");
      expect(final?.errorKind ?? null, error).toBeNull();
    }
  });

  it("the SPECIFIC classes keep priority over provider_internal (overflow, conflict)", () => {
    // "Context overflow … try again" must stay context_length even though it
    // contains no transient marker; a session conflict stays its own class.
    const n = newNormalizer();
    const c = new Clock();
    n.beginTurn(c.now);
    n.noteRunStarted(OWN_RUN, c.now);
    const events = n.feed(
      chatFrame({
        state: "error",
        errorMessage:
          "Context overflow: prompt too large for the model. Try /reset (or /new).",
      }),
      c.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.errorKind).toBe("context_length");
  });

  it("the gateway session-init OCC conflict (no errorKind) classifies to session_init_conflict", () => {
    // The exact live-incident message (2026-07-09): the gateway's
    // commitReplySessionInitialization threw after its one internal retry.
    // Upstream (Telegram channel) retries on this same message — the stable
    // code lets Convex's bounded auto-retry (turnRetry.ts) key on it.
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        errorMessage:
          "Error: reply session initialization conflicted for agent:jerome:atrium:chat:jnl:mh7abc",
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    const status = events.find((e) => e.type === "run.status");
    expect(final?.errorKind).toBe("session_init_conflict");
    expect(status?.status).toBe("error");
    // A DIFFERENT bare error must NOT classify (the code is regex-specific).
    const n2 = newNormalizer();
    const c2 = new Clock();
    n2.beginTurn(c2.now);
    n2.noteRunStarted(OWN_RUN, c2.now);
    const evs2 = n2.feed(
      chatFrame({ state: "error", errorMessage: "some other gateway failure" }),
      c2.tick(),
    );
    const final2 = evs2.find((e) => e.type === "message.final");
    expect(final2?.errorKind ?? null).toBeNull();
  });

  it("the embedded prompt-lock conflict AFTER a streamed reply closes COMPLETE (live 2026-07-21)", () => {
    // The gateway preempted a queued follow-up turn to run an announce
    // delivery; the announce streamed its FULL report, then the lock check
    // found the (aborted) follow-up's session write and errored the run.
    // The reply is intact — an error badge on it misread as a failed turn
    // (prod report ms746b01…). The class survives on the trace-only channel.
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    normalizer.feed(
      chatFrame({ state: "delta", deltaText: "Le rapport complet livré." }),
      clock.tick(),
    );
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        errorMessage:
          "session file changed while embedded prompt lock was released: /home/node/.openclaw/agents/fabien/sessions/0c32.jsonl",
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(events.find((e) => e.type === "run.status")?.status).toBe("complete");
    expect(final?.text).toContain("Le rapport complet livré.");
    expect(final?.error ?? null).toBeNull();
    expect(final?.errorKind ?? null).toBeNull();
    expect(final?.diagnosticErrorKind).toBe("session_init_conflict");
  });

  it("the embedded prompt-lock conflict with NO content keeps the error card (auto-retry path)", () => {
    // Zero content = the init flavor's territory: the honest error card stays
    // and carries the stable code Convex's bounded auto-retry keys on.
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        errorMessage:
          "session file changed while embedded prompt lock was released: /tmp/x.jsonl",
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(events.find((e) => e.type === "run.status")?.status).toBe("error");
    expect(final?.errorKind).toBe("session_init_conflict");
  });

  it("the session-init OCC conflict WITH streamed content keeps the error card (no structural proof)", () => {
    // Codex P1: only the embedded-lock flavor proves the generation ended
    // ("…lock was RELEASED"). The init flavor with content is anomalous —
    // keep the honest error card rather than bless possibly-truncated text.
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    normalizer.feed(
      chatFrame({ state: "delta", deltaText: "Réponse peut-être tronquée" }),
      clock.tick(),
    );
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        errorMessage:
          "Error: reply session initialization conflicted for agent:jerome:atrium:chat:jnl:mh7abc",
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(events.find((e) => e.type === "run.status")?.status).toBe("error");
    expect(final?.errorKind).toBe("session_init_conflict");
  });

  it("chat error with errorKind context_length finalizes the turn as a classified error", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        errorMessage: "Context window exceeded for this model",
        errorKind: "context_length",
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    const status = events.find((e) => e.type === "run.status");
    expect(final?.error).toBe("Context window exceeded for this model");
    expect(final?.errorKind).toBe("context_length");
    expect(status?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
  });

  it("an UNLISTED wire errorKind is never persisted as a code (allowlist)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({ state: "error", errorMessage: "boom", errorKind: "totally_new_kind" }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.error).toBe("boom");
    expect(final?.errorKind).toBeUndefined();
  });

  it("chat error with errorKind unknown carries NO kind (nothing actionable to classify)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({ state: "error", errorMessage: "boom", errorKind: "unknown" }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.error).toBe("boom");
    expect(final?.errorKind).toBeUndefined();
  });

  it("chat error without errorMessage falls back to the message text, never applyVisible", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({
        state: "error",
        message: { role: "assistant", content: [{ type: "text", text: "Error: provider 500" }] },
      }),
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    // The description became the ERROR, not the reply text.
    expect(final?.error).toBe("Error: provider 500");
    expect(final?.text).toBe(""); // no streamed reply — the error text is not the answer
  });

  it("chat aborted from the USER stop (stopReason rpc) finalizes as aborted", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      chatFrame({ state: "aborted", stopReason: "rpc" }),
      clock.tick(),
    );
    const status = events.find((e) => e.type === "run.status");
    expect(status?.status).toBe("aborted");
    expect(normalizer.finalized).toBe(true);
  });

  it("a foreign-run chat error is still dropped (isolation unchanged)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "some-other-run",
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "not ours",
          errorKind: "context_length",
        },
      },
      clock.tick(),
    );
    expect(events.filter((e) => e.type === "message.final")).toHaveLength(0);
    expect(normalizer.finalized).toBe(false);
  });
});

describe("errorKind fallback + replace delta (gateway 6.11 realities)", () => {
  it("a bare-text overflow error (no wire errorKind — live-verified) still classifies context_length", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage:
            "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
        },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.errorKind).toBe("context_length");
  });

  it("a non-overflow bare error stays unclassified", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "error", errorMessage: "boom" },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.errorKind).toBeUndefined();
  });

  it("deltas AFTER a replace keep streaming (replace never locks snapshot precedence)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const mk = (deltaText: string, extra: Record<string, unknown> = {}) => ({
      type: "event",
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "delta", deltaText, seq: 1, ...extra },
    });
    normalizer.feed(mk("brouillon"), clock.tick());
    normalizer.feed(mk("Refresh complet", { replace: true }), clock.tick());
    normalizer.feed(mk(" + la suite"), clock.tick()); // must NOT be dropped
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "final", seq: 9 },
      },
      clock.tick(),
    );
    expect(events.find((e) => e.type === "message.final")?.text).toBe(
      "Refresh complet + la suite",
    );
  });

  it("replace:true on a bare deltaText REPLACES the accumulated text (never appends)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const mk = (deltaText: string, extra: Record<string, unknown> = {}) => ({
      type: "event",
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "delta", deltaText, seq: 1, ...extra },
    });
    normalizer.feed(mk("Bonjour"), clock.tick());
    normalizer.feed(mk("Bonjour, monde corrigé", { replace: true }), clock.tick());
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "final", seq: 3 },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.text).toBe("Bonjour, monde corrigé");
  });
});

describe("compaction abandon must not read as a user stop (live report 2026-07-04)", () => {
  it("chat:aborted DURING compactionPending keeps the turn open (the run resumes)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    // The gateway abandons the run to compact (the pinned mid-turn signal).
    normalizer.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "end", livenessState: "abandoned" },
        },
      },
      clock.tick(),
    );
    // A chat:aborted rides along with the abandon — it is NOT a user stop.
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "aborted" },
      },
      clock.tick(),
    );
    expect(events.filter((e) => e.type === "message.final")).toHaveLength(0);
    expect(normalizer.finalized).toBe(false);
    // The RESUMED run then finishes normally in the same turn.
    const final = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "DONE_AFTER_COMPACT" }] },
        },
      },
      clock.tick(),
    );
    expect(final.find((e) => e.type === "message.final")?.text).toBe(
      "DONE_AFTER_COMPACT",
    );
  });

  it("a chat:error AFTER a streamed reply finalizes COMPLETE (post-reply compaction failure, live 2026-07-04)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    // The reply streams fully...
    normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "delta",
          deltaText: "La réponse complète livrée au user.",
        },
      },
      clock.tick(),
    );
    // ...the run ENDS (lifecycle end arms the follow-on grace)...
    normalizer.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          sessionId: "sess-1",
          stream: "lifecycle",
          data: { phase: "end" },
        },
      },
      clock.tick(),
    );
    // ...then the gateway's post-turn compaction fails on the SAME run.
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "Context overflow: prompt too large for the model.",
        },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(events.find((e) => e.type === "run.status")?.status).toBe("complete");
    expect(final?.text).toContain("La réponse complète livrée");
    expect(final?.error ?? null).toBeNull();
    // The error CLASS still reaches diagnostics — through the trace-only
    // channel, never the message's errorCode.
    expect(final?.diagnosticErrorKind).toBe("context_length");
    expect(final?.errorKind ?? null).toBeNull();
  });

  it("a chat:error RIGHT AFTER a delta (mid-generation failure) keeps the honest error card", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "delta",
          deltaText: "Un début de réponse tron",
        },
      },
      clock.tick(),
    );
    // The failure lands while the run is STILL generating (no lifecycle end).
    clock.tick(1);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "Context overflow: prompt too large for the model.",
        },
      },
      clock.tick(),
    );
    expect(events.find((e) => e.type === "run.status")?.status).toBe("error");
  });

  it("a chat:error with NO streamed content keeps the honest error card", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "Context overflow: prompt too large for the model.",
        },
      },
      clock.tick(),
    );
    expect(events.find((e) => e.type === "run.status")?.status).toBe("error");
  });

  it("a chat:aborted terminalizes as aborted (Interrompu) regardless of stopReason", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, state: "aborted", stopReason: "rpc" },
      },
      clock.tick(),
    );
    expect(events.find((e) => e.type === "run.status")?.status).toBe("aborted");
  });

});

describe("protocol-matrix gaps closed: stopReason + agent usage reach the diagnostics", () => {
  it("an UNKNOWN free-string stopReason buckets to 'other' (never raw into traces)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          stopReason: "patient Jean Dupont demande un rappel",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      },
      clock.tick(),
    );
    // The final may be held by a short grace — expire it.
    const flushed = normalizer.tick(clock.tick(30));
    const final = [...events, ...flushed].find((e) => e.type === "message.final");
    expect(final?.diagnosticStopReason).toBe("other");
  });

  it("terminal stopReason and flattened agent usage ride message.final as diagnostics", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    // The gateway flattens session metadata onto an agent event (dev 2026-07-04).
    normalizer.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "start" },
          totalTokens: 120_000,
          inputTokens: 100_000,
          outputTokens: 20_000,
          estimatedCostUsd: 1.23,
        },
      },
      clock.tick(),
    );
    const events = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          stopReason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: "réponse" }] },
        },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final");
    expect(final?.diagnosticStopReason).toBe("stop");
    // SOC2: a free-string stopReason never reaches traces raw — it buckets.
    // (pinned in the dedicated test below via the "other" bucket)
    expect(final?.diagnosticUsage).toEqual({
      totalTokens: 120_000,
      inputTokens: 100_000,
      outputTokens: 20_000,
      estimatedCostUsd: 1.23,
    });

    // NEXT turn without those frames: diagnostics must NOT leak (codex P2).
    normalizer.beginTurn(clock.tick());
    normalizer.noteRunStarted("run-suivant", clock.now);
    const events2 = normalizer.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "run-suivant",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      },
      clock.tick(),
    );
    const final2 = events2.find((e) => e.type === "message.final");
    expect(final2?.diagnosticStopReason ?? null).toBeNull();
    expect(final2?.diagnosticUsage ?? null).toBeNull();
  });
});


describe("finalizeCause diagnostic (report ms7b5j — which close fired)", () => {
  it("a PURE recv-silence does NOT finalize — it signals the gateway-status query (new contract)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    // an own delta, then silence past the recv budget
    normalizer.feed(
      {
        event: "agent",
        payload: {
          sessionKey: SESSION_KEY,
          runId: OWN_RUN,
          data: { delta: "working" },
        },
      },
      clock.tick(),
    );
    clock.tick(BASE_RECV_TIMEOUT + 1);
    const events = normalizer.tick(clock.now);
    // NO finalize — the turn stays OPEN (report ms7b5j: the gateway was still
    // reasoning; closing here is what produced the silent blank bubble).
    expect(normalizer.finalized).toBe(false);
    expect(events.find((e) => e.type === "message.final")).toBeUndefined();
    // The one-shot silence signal is raised for the session to query the gateway.
    expect(normalizer.takeRecvSilence()).toBe(true);
    expect(normalizer.takeRecvSilence()).toBe(false); // one-shot
    // A LATE real frame still finalizes the turn normally afterwards.
    const late = normalizer.feed(
      {
        event: "chat",
        payload: {
          sessionKey: SESSION_KEY,
          runId: OWN_RUN,
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Réponse tardive complète." }],
          },
        },
      },
      clock.tick(),
    );
    const final = late.find((e) => e.type === "message.final") as
      | { text?: string }
      | undefined;
    expect(normalizer.finalized).toBe(true);
    expect(String(final?.text)).toContain("Réponse tardive complète");
  });

  it("an explicit settle after the silence stamps finalizeCause=recv_timeout (degraded fallback)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    clock.tick(BASE_RECV_TIMEOUT + 1);
    normalizer.tick(clock.now);
    expect(normalizer.takeRecvSilence()).toBe(true);
    const events = normalizer.endTurn(clock.now, "final", null, "recv_timeout");
    const final = events.find((e) => e.type === "message.final") as
      | { diagnosticFinalizeCause?: string }
      | undefined;
    expect(final?.diagnosticFinalizeCause).toBe("recv_timeout");
  });

  it("a real gateway chat:final stamps a gateway_* cause (NOT a silence timeout)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        event: "chat",
        payload: {
          sessionKey: SESSION_KEY,
          runId: OWN_RUN,
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Voici la réponse." }],
          },
        },
      },
      clock.tick(),
    );
    const final = events.find((e) => e.type === "message.final") as
      | { diagnosticFinalizeCause?: string }
      | undefined;
    expect(final?.diagnosticFinalizeCause).toBeDefined();
    expect(final?.diagnosticFinalizeCause).not.toBe("recv_timeout");
    expect(String(final?.diagnosticFinalizeCause)).toMatch(/gateway/);
  });
});
