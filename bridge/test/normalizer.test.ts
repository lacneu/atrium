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
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "running", phase: "startup", recvAt: expect.any(Number) },
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
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "done", done: true, text: "ZULU_DELTA_777", recvAt: expect.any(Number) },
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
        recvAt: expect.any(Number),
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
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "error", phase: "error", done: true, errorMessage: "boom", recvAt: expect.any(Number) },
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
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "aborted", done: true, errorMessage: "", recvAt: expect.any(Number) },
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
      { type: "agent.activity", childSessionKey: CHILD_SK, status: "done", done: true, text: "STRING_RESULT", recvAt: expect.any(Number) },
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

// The `agent.data` vocabulary the gateway actually emits — enumerated from every
// upstream emission site at v2026.7.1, not guessed. Each case below reproduces a
// real misreading of that vocabulary (the pre-1.0 code treated ANY non-start tool
// phase as a completion, and ignored the gateway's own compaction verdict).
describe("agent.data vocabulary: tool progress vs completion, compaction verdict", () => {
  const SK = SESSION_KEY;
  function toolFrame(data: Record<string, unknown>): unknown {
    return {
      type: "event",
      event: "agent",
      payload: { runId: OWN_RUN, sessionKey: SK, seq: 1, stream: "tool", ts: 0, data },
    };
  }
  function compactionFrame(data: Record<string, unknown>): unknown {
    return {
      type: "event",
      event: "agent",
      payload: { runId: OWN_RUN, sessionKey: SK, seq: 1, stream: "compaction", ts: 0, data },
    };
  }
  function driveTool(
    phases: Record<string, unknown>[],
  ): { events: BridgeEvent[]; normalizer: Normalizer } {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events: BridgeEvent[] = [];
    for (const data of phases) {
      events.push(...normalizer.feed(toolFrame(data), clock.tick()));
    }
    return { events, normalizer };
  }

  it("an `update` mid-execution does NOT complete the card and does NOT consume the args", () => {
    // The defect: `update` was read as terminal, so the card showed "completed"
    // while the tool was still running AND the buffered args were dropped — the
    // real `result` then landed with no `input` to render.
    const { events } = driveTool([
      { phase: "start", name: "exec", toolCallId: "tc1", args: { command: "ls -la /tmp" } },
      { phase: "update", name: "exec", toolCallId: "tc1", partialResult: { aggregated: "partial…" } },
      { phase: "result", name: "exec", toolCallId: "tc1", isError: false, result: { aggregated: "done" } },
    ]);
    const statuses = events.filter((e) => e.type === "tool.status");
    // Exactly ONE completion, and it is the LAST event — never on the update.
    const completions = statuses.filter((e) => e.phase === "completed");
    expect(completions).toHaveLength(1);
    expect(statuses[statuses.length - 1]?.phase).toBe("completed");
    // The completion still carries the args captured at `start`.
    expect(completions[0]?.input).toEqual({ command: "ls -la /tmp" });
  });

  it("`chunk` — the fourth phase the gateway emits on stream:\"tool\" — is progress too", () => {
    // `chunk` appears at one upstream emission site and was NEVER named in any
    // Atrium code path: it fell into the terminal branch like `update`.
    const { events } = driveTool([
      { phase: "start", name: "read", toolCallId: "tc2", args: { path: "/a" } },
      { phase: "chunk", name: "read", toolCallId: "tc2" },
    ]);
    const statuses = events.filter((e) => e.type === "tool.status");
    expect(statuses.some((e) => e.phase === "completed")).toBe(false);
    expect(statuses.some((e) => e.phase === "error")).toBe(false);
  });

  it("an UNKNOWN phase carrying a result still closes the card (no eternal spinner)", () => {
    // Multi-version safety (supported range starts at 2026.5.19): the allowlist
    // names the PROGRESS phases, so a phase we do not recognize keeps its
    // terminal behavior — a stuck card is worse than an unrecognized name.
    const { events } = driveTool([
      { phase: "start", name: "exec", toolCallId: "tc3", args: { command: "x" } },
      { phase: "finished_someday", name: "exec", toolCallId: "tc3", result: { aggregated: "ok" } },
    ]);
    const statuses = events.filter((e) => e.type === "tool.status");
    expect(statuses.some((e) => e.phase === "completed")).toBe(true);
  });

  it("a compaction the gateway could NOT complete emits a `failed` marker", () => {
    // Upstream sends `completed: hasResult && !wasAborted`; it was ignored, so a
    // failed compaction looked identical to a successful one and the next turn
    // hit the context wall with no prior signal.
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    normalizer.feed(compactionFrame({ phase: "start" }), clock.tick());
    const events = normalizer.feed(
      compactionFrame({ phase: "end", willRetry: false, completed: false }),
      clock.tick(),
    );
    const marks = events.filter((e) => e.type === "context.compaction");
    expect(marks.map((e) => e.phase)).toContain("failed");
  });

  it("a SUCCESSFUL compaction, and one that will be retried, emit no failure marker", () => {
    for (const data of [
      { phase: "end", willRetry: false, completed: true },
      // willRetry:true = the overflow replay is still in flight on this run:
      // the verdict is not final yet, so it must not be announced as a failure.
      { phase: "end", willRetry: true, completed: false },
    ]) {
      const normalizer = newNormalizer();
      const clock = new Clock();
      normalizer.beginTurn(clock.now);
      normalizer.noteRunStarted(OWN_RUN, clock.now);
      normalizer.feed(compactionFrame({ phase: "start" }), clock.tick());
      const events = normalizer.feed(compactionFrame(data), clock.tick());
      expect(
        events
          .filter((e) => e.type === "context.compaction")
          .map((e) => e.phase),
      ).not.toContain("failed");
    }
  });
});

// FRAME LOSS — the gateway's own diagnostic, which we used to discard.
// It tracks the per-run `seq` of the agent events it forwards and, on a hole,
// broadcasts `stream:"error"` with `{reason:"seq gap", expected, received}`
// (pinned upstream by server-chat.agent-events.test.ts). Atrium had NO branch for
// that stream, so the single explicit "content was lost" signal was dropped.
describe("frame loss: the gateway's seq-gap diagnostic", () => {
  function errFrame(data: Record<string, unknown>): unknown {
    return {
      type: "event",
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        seq: 9,
        stream: "error",
        ts: 0,
        data,
      },
    };
  }

  it("emits a frame.gap diagnostic and does NOT fail the turn (upstream shape, verbatim)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    // The exact payload shape upstream pins in its own unit test.
    const events = normalizer.feed(
      errFrame({ reason: "seq gap", expected: 2, received: 5 }),
      clock.tick(),
    );
    const gaps = events.filter((e) => e.type === "frame.gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      source: "gateway",
      expected: 2,
      received: 5,
      missing: 3,
    });
    // A lost frame is a DIAGNOSTIC, never a turn failure: the frames that did
    // arrive are still valid and the run continues.
    expect(events.some((e) => e.type === "run.status")).toBe(false);
    expect(events.some((e) => e.type === "message.final")).toBe(false);
  });

  it("an UNKNOWN stream:\"error\" payload is observed, never turned into a failure", () => {
    // The error stream is a diagnostic channel: a shape we do not recognize must
    // not be able to fail a turn (a lesson from every other unknown-frame path).
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      errFrame({ reason: "something we have never seen" }),
      clock.tick(),
    );
    expect(events.filter((e) => e.type === "frame.gap")).toHaveLength(0);
    expect(events.some((e) => e.type === "run.status")).toBe(false);
  });

  it("a seq-gap frame for a FOREIGN session is ignored (isolation stays strict)", () => {
    const normalizer = newNormalizer();
    const clock = new Clock();
    normalizer.beginTurn(clock.now);
    normalizer.noteRunStarted(OWN_RUN, clock.now);
    const events = normalizer.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: "someone-elses-run",
          sessionKey: "agent:bob:atrium:chat:other:mh7zzz",
          stream: "error",
          ts: 0,
          data: { reason: "seq gap", expected: 1, received: 4 },
        },
      },
      clock.tick(),
    );
    expect(events.filter((e) => e.type === "frame.gap")).toHaveLength(0);
  });
});

describe("per-turn collections are bounded (G-34)", () => {
  it("the truncation flag does not survive into the NEXT turn", () => {
    // Left set, ONE capped turn would make every later turn declare an incomplete
    // child list — quietly disabling the empty-response guard for the rest of the
    // session (codex P2).
    const n = newNormalizer();
    n.beginTurn(0);
    const errors: string[] = [];
    const realError = console.error;
    console.error = (() => {}) as never;
    try {
      for (let i = 0; i < 1_050; i++) {
        n.feed(
          {
            event: "agent",
            payload: {
              sessionKey: `agent:main:subagent:child-${i}`,
              spawnedBy: SESSION_KEY,
              runId: `child-run-${i}`,
              stream: "lifecycle",
              data: { phase: "start" },
            },
          },
          1,
        );
      }
    } finally {
      console.error = realError;
      void errors;
    }
    const capped = n.endTurn(2, "final");
    const cappedFinal = capped.find((e) => e.type === "message.final");
    expect(cappedFinal?.observedChildKeysTruncated).toBe(true);
    // A FRESH turn starts with a complete list again.
    n.beginTurn(3);
    const clean = n.endTurn(4, "final");
    const cleanFinal = clean.find((e) => e.type === "message.final");
    expect(cleanFinal?.observedChildKeysTruncated).toBe(false);
  });


  it("stops recording tool args past the cap instead of growing all turn", () => {
    // A tool loop used to grow this map for the whole turn, and the memory it cost
    // was invisible. Past the cap the entries are dropped — LOUDLY (one line per
    // episode), because a silent truncation reads as "nothing was dropped".
    const n = newNormalizer();
    n.beginTurn(0);
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((...args: unknown[]) => {
      errors.push(args.join(" "));
    }) as never;
    try {
      for (let i = 0; i < 2_100; i++) {
        n.feed(
          {
            event: "agent",
            payload: {
              sessionKey: SESSION_KEY,
              runId: OWN_RUN,
              stream: "tool",
              data: {
                phase: "start",
                name: "exec",
                toolCallId: `call-${i}`,
                args: { i },
              },
            },
          },
          1,
        );
      }
    } finally {
      console.error = realError;
    }
    // Exactly one overflow line — not one per dropped entry.
    const overflow = errors.filter((e) => e.includes("toolArgs cap reached"));
    expect(overflow).toHaveLength(1);
  });
});

// --- G-15: dedup with MEMORY, not one adjacent slot -------------------------
describe("G-15: a non-adjacent chat re-broadcast is deduplicated too", () => {
  const startTurn = (): { n: Normalizer; clock: Clock } => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };

  const delta = (seq: number, text: string) => ({
    event: "chat",
    payload: {
      runId: OWN_RUN,
      sessionKey: SESSION_KEY,
      seq,
      state: "delta",
      deltaText: text,
    },
  });

  const textsOf = (ev: BridgeEvent[]) =>
    ev.filter((e) => e.type === "message.delta").map((e) => e.text);

  it("A,B,A: the replayed A is dropped (the scalar slot only caught A,A)", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    ev.push(...n.feed(delta(1, "alpha "), clock.tick()));
    ev.push(...n.feed(delta(2, "beta "), clock.tick()));
    // Upstream replays the FIRST frame (documented `meta:{cached:true}` replay):
    // byte-identical runId/seq/state/deltaText. Nothing about it is new.
    ev.push(...n.feed(delta(1, "alpha "), clock.tick()));
    expect(textsOf(ev)).toEqual(["alpha ", "beta "]);
  });

  it("beyond the memory cap the OLDEST key is evicted, and the recent window still dedups", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    // 64 distinct frames fill the window; the 65th evicts frame #1's key.
    for (let i = 1; i <= 65; i++) ev.push(...n.feed(delta(i, `d${i} `), clock.tick()));
    const beforeReplay = textsOf(ev).length;
    // A replay INSIDE the window is still dropped...
    ev.push(...n.feed(delta(65, "d65 "), clock.tick()));
    expect(textsOf(ev)).toHaveLength(beforeReplay);
    // ...while the evicted one is re-admitted. That is the honest trade: an LRU
    // eviction can only re-admit a very old duplicate, it never drops content.
    ev.push(...n.feed(delta(1, "d1 "), clock.tick()));
    expect(textsOf(ev)).toHaveLength(beforeReplay + 1);
  });

  it("codex P1: without `seq` a legitimately REPEATED delta survives (adjacent-only rule)", () => {
    const { n, clock } = startTurn();
    const noSeq = (text: string) => ({
      event: "chat",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        state: "delta",
        deltaText: text,
      },
    });
    const ev: BridgeEvent[] = [];
    ev.push(...n.feed(noSeq("ha"), clock.tick()));
    ev.push(...n.feed(noSeq("!"), clock.tick()));
    ev.push(...n.feed(noSeq("ha"), clock.tick()));
    // Content alone is not an identity: deleting the second "ha" would silently
    // rewrite the reply. Only an ADJACENT exact repeat is a re-broadcast here.
    expect(textsOf(ev)).toEqual(["ha", "!", "ha"]);
    ev.push(...n.feed(noSeq("ha"), clock.tick()));
    expect(textsOf(ev)).toEqual(["ha", "!", "ha"]);
  });

  it("codex P2: a key REPLAYED inside the window is refreshed, so it never ages out", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    ev.push(...n.feed(delta(1, "A "), clock.tick())); // A is the OLDEST key
    for (let i = 2; i <= 64; i++) ev.push(...n.feed(delta(i, `d${i} `), clock.tick()));
    // The window is now exactly full. A is replayed: an LRU moves it to the
    // most-recent end, a FIFO leaves it first in line for eviction.
    ev.push(...n.feed(delta(1, "A "), clock.tick()));
    // One new key forces exactly one eviction.
    ev.push(...n.feed(delta(65, "d65 "), clock.tick()));
    const before = textsOf(ev).length;
    // A was seen a moment ago: it must still be recognized as a re-broadcast.
    ev.push(...n.feed(delta(1, "A "), clock.tick()));
    expect(textsOf(ev)).toHaveLength(before);
  });

  it("a new turn starts with an EMPTY memory (a key from turn N must not silence turn N+1)", () => {
    const { n, clock } = startTurn();
    const ev1 = n.feed(delta(1, "same text "), clock.tick());
    expect(textsOf(ev1)).toEqual(["same text "]);
    n.beginTurn(clock.tick());
    n.noteRunStarted(OWN_RUN, clock.now);
    // Identical frame, NEW turn: this is real content for this turn.
    const ev2 = n.feed(delta(1, "same text "), clock.tick());
    expect(textsOf(ev2)).toEqual(["same text "]);
  });
});

// --- G-12: who may become THIS turn's answer --------------------------------
// A frame of an UNKNOWN run on our own session used to be adopted whenever any
// grace window happened to be open — and the compaction grace is 900 seconds.
// The adopted run then became the user's answer and closed their turn. The
// families below can never be this turn's continuation, and each is recognized
// POSITIVELY. The two confinement tests at the end are the point of the lot:
// the legitimate replay and the legitimate follow-on must still be adopted.
describe("G-12: foreign-run admission policy", () => {
  const startTurn = () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };

  const chatFinal = (runId: string, text: string) => ({
    event: "chat",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      seq: 1,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  });

  const agentFrame = (runId: string, extra: Record<string, unknown> = {}) => ({
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "assistant",
      data: { delta: "…" },
      ...extra,
    },
  });

  /** Open the SHORT follow-on grace: a normal lifecycle end of our own run. */
  const openLifecycleGrace = (n: Normalizer, clock: Clock) =>
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop", livenessState: "working" },
        },
      },
      clock.tick(),
    );

  it("a HEARTBEAT run never becomes the answer, even inside an open grace", () => {
    const { n, clock } = startTurn();
    // The discriminant rides the AGENT payload only — learn it there…
    n.feed(agentFrame("heartbeat-run-42", { isHeartbeat: true }), clock.tick());
    openLifecycleGrace(n, clock);
    // …then refuse the run when its CHAT final tries to close our turn.
    const ev = n.feed(chatFinal("heartbeat-run-42", "unrelated heartbeat reply"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
    expect(n.ownRunIds.has("heartbeat-run-42")).toBe(false);
  });

  it("codex P2: an ACTIVE heartbeat is refreshed and never aged out by newer ones", () => {
    const { n, clock } = startTurn();
    n.feed(agentFrame("hb-live", { isHeartbeat: true }), clock.tick());
    // 63 other heartbeats fill the window exactly…
    for (let i = 0; i < 63; i++) {
      n.feed(agentFrame(`hb-other-${i}`, { isHeartbeat: true }), clock.tick());
    }
    // …then hb-live beats again (an LRU refreshes it, a FIFO does not)…
    n.feed(agentFrame("hb-live", { isHeartbeat: true }), clock.tick());
    // …and one more heartbeat forces exactly one eviction.
    n.feed(agentFrame("hb-newest", { isHeartbeat: true }), clock.tick());
    openLifecycleGrace(n, clock);
    // …and is still recognized: a FIFO would have evicted it, and its chat final
    // would then have been adopted as the user's answer.
    const ev = n.feed(chatFinal("hb-live", "heartbeat output"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("a chat.inject broadcast (`inject-<messageId>`) never becomes the answer", () => {
    const { n, clock } = startTurn();
    openLifecycleGrace(n, clock);
    // The gateway mints this runId and broadcasts a chat FINAL on our session.
    const ev = n.feed(chatFinal("inject-msg_7", "injected by an operator"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("a gateway-initiated turn (announce family) never becomes the answer", () => {
    const { n, clock } = startTurn();
    openLifecycleGrace(n, clock);
    const ev = n.feed(chatFinal("announce:child-1", "a sub-agent's own turn"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("codex P1: a replay proof is CONSUMED by the replay — a later compaction must earn its own", () => {
    const { n, clock } = startTurn();
    const compaction = (data: Record<string, unknown>) => ({
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        stream: "compaction",
        data,
      },
    });
    n.feed(compaction({ phase: "start" }), clock.tick());
    n.feed(compaction({ phase: "end", willRetry: true, completed: true }), clock.tick());
    // The announced replay ARRIVES on the same run: the proof is now spent.
    n.feed(agentFrame(OWN_RUN), clock.tick());
    // A SECOND compaction begins and has announced nothing.
    n.feed(compaction({ phase: "start" }), clock.tick());
    const ev = n.feed(chatFinal("some-background-run", "not your answer"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("codex P1: a NON-content frame of the resumed run spends the replay proof", () => {
    const { n, clock } = startTurn();
    const compaction = (data: Record<string, unknown>) => ({
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        stream: "compaction",
        data,
      },
    });
    n.feed(compaction({ phase: "start" }), clock.tick());
    n.feed(compaction({ phase: "end", willRetry: true, completed: true }), clock.tick());
    // The resumed run signals with a TOOL frame — no visible text, so the
    // content path never runs and the proof used to stay open for the whole turn.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "tool",
          data: { name: "read", phase: "completed" },
        },
      },
      clock.tick(),
    );
    const ev = n.feed(chatFinal("some-background-run", "not your answer"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("codex P1: a compaction starting inside the lifecycle grace applies the STRICTER rule", () => {
    const { n, clock } = startTurn();
    // The 10 s follow-on grace is open…
    openLifecycleGrace(n, clock);
    // …and a compaction starts on our own run without clearing it.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "compaction",
          data: { phase: "start" },
        },
      },
      clock.tick(),
    );
    // Nothing has announced a replay: the looser lifecycle rule must not decide.
    const ev = n.feed(chatFinal("some-background-run", "not your answer"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("during a compaction, an unknown run is refused until the gateway ANNOUNCES a replay", () => {
    const { n, clock } = startTurn();
    // Compaction started: the 900s window is open, but nothing says a replay is
    // coming on a new run — the door stays shut.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "compaction",
          data: { phase: "start" },
        },
      },
      clock.tick(),
    );
    const ev = n.feed(chatFinal("some-background-run", "not your answer"), clock.tick());
    expect(ev).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("every refusal is COUNTED by reason and reaches the final event", () => {
    const { n, clock } = startTurn();
    n.feed(agentFrame("hb-1", { isHeartbeat: true }), clock.tick());
    openLifecycleGrace(n, clock);
    n.feed(chatFinal("hb-1", "x"), clock.tick());
    n.feed(chatFinal("inject-a", "y"), clock.tick());
    n.feed(chatFinal("inject-b", "z"), clock.tick());
    const final = n
      .endTurn(clock.tick(), "final", null, "recv_timeout")
      .find((e) => e.type === "message.final");
    // 2 heartbeat refusals: the agent frame that TAUGHT us the run is itself a
    // frame of a foreign run, and it is refused on the same ground. Counting it
    // is the honest reading — a heartbeat frame did reach a live turn.
    expect(final?.foreignRunRejections).toEqual({
      heartbeat: 2,
      gateway_initiated: 2,
    });
  });

  it("an ADOPTED run may add and close, but never OVERWRITE the delivered answer", () => {
    const { n, clock } = startTurn();
    // Our own run delivers the answer…
    n.feed(agentFrame(OWN_RUN), clock.tick());
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "the delivered answer" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    // …then a run admitted through the grace sends unrelated content.
    const ev = n.feed(chatFinal("webchat-followon", "SOMETHING ELSE ENTIRELY"), clock.tick());
    const final = ev.find((e) => e.type === "message.final");
    // It is APPENDED, not substituted: the answer the user read survives.
    expect(String(final?.text)).toContain("the delivered answer");
    expect(String(final?.text)).toContain("SOMETHING ELSE ENTIRELY");
    // …and the turn does close (a follow-on legitimately finishes it).
    expect(n.finalized).toBe(true);
  });

  it("the demotion never SWALLOWS the follow-on when the first reply was a snapshot (codex P1)", () => {
    const { n, clock } = startTurn();
    // The first reply arrives as a SNAPSHOT, which locks snapshot precedence.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: "the delivered answer" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    const ev = n.feed(chatFinal("webchat-followon", "SOMETHING ELSE ENTIRELY"), clock.tick());
    const final = ev.find((e) => e.type === "message.final");
    expect(String(final?.text)).toContain("the delivered answer");
    expect(String(final?.text)).toContain("SOMETHING ELSE ENTIRELY");
    // …and the turn closes NOW, not on a grace timeout.
    expect(n.finalized).toBe(true);
  });

  it("codex P1: an adopted run's DELTAS are additive too, never dropped by the snapshot lock", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: "the delivered answer" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    const ev: BridgeEvent[] = [];
    // A follow-on run that STREAMS rather than snapshots.
    ev.push(
      ...n.feed(
        {
          event: "agent",
          payload: {
            runId: "webchat-followon",
            sessionKey: SESSION_KEY,
            stream: "assistant",
            data: { delta: "and one more thing" },
          },
        },
        clock.tick(),
      ),
    );
    expect(ev.filter((e) => e.type === "message.delta")).toHaveLength(1);
  });

  it("codex P2: additive text from an adopted run is SEPARATED from the previous reply", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: "the delivered answer" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    const ev = n.feed(chatFinal("webchat-followon", "Nouveau texte"), clock.tick());
    const final = ev.find((e) => e.type === "message.final");
    // Raw concatenation would read as "…answerNouveau texte" — one corrupted
    // sentence out of two independent replies.
    expect(String(final?.text)).toContain("answer\n\nNouveau texte");
  });

  it("codex P2: the boundary holds when the previous reply came from DELTAS", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "Réponse." },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    // The follow-on STREAMS onto a reply that was itself streamed: with no
    // snapshot lock, `forcedAppend` is false and the separator was being dropped.
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: "webchat-followon",
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "Ajout" },
        },
      },
      clock.tick(),
    );
    const d = ev.find((e) => e.type === "message.delta");
    expect(d?.text).toBe("\n\nAjout");
  });

  it("codex P2: TWO runs adopted in the same grace each get their own boundary", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "Réponse." },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    // BOTH runs are admitted before either writes any text — a single shared
    // flag is then armed once and consumed by whichever writes first.
    const silent = (runId: string) => ({
      event: "agent",
      payload: {
        runId,
        sessionKey: SESSION_KEY,
        stream: "assistant",
        data: { mediaUrls: [] },
      },
    });
    n.feed(silent("webchat-followon-a"), clock.tick());
    n.feed(silent("webchat-followon-b"), clock.tick());
    const first = n.feed(
      {
        event: "agent",
        payload: {
          runId: "webchat-followon-a",
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "PremierAjout" },
        },
      },
      clock.tick(),
    );
    const second = n.feed(
      {
        event: "agent",
        payload: {
          runId: "webchat-followon-b",
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "SecondAjout" },
        },
      },
      clock.tick(),
    );
    // A single shared flag let the first run consume the boundary and glued the
    // second reply straight onto it.
    expect(first.find((e) => e.type === "message.delta")?.text).toBe("\n\nPremierAjout");
    expect(second.find((e) => e.type === "message.delta")?.text).toBe("\n\nSecondAjout");
  });

  it("codex P2: no separator is injected inside an adopted run's OWN continuation", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: "réponse" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    const ev: BridgeEvent[] = [];
    // The adopted run first EXTENDS the text (a continuation snapshot)…
    ev.push(
      ...n.feed(
        {
          event: "agent",
          payload: {
            runId: "webchat-followon",
            sessionKey: SESSION_KEY,
            stream: "assistant",
            data: { text: "réponse complète" },
          },
        },
        clock.tick(),
      ),
    );
    // …then streams the rest of its OWN sentence.
    ev.push(
      ...n.feed(
        {
          event: "agent",
          payload: {
            runId: "webchat-followon",
            sessionKey: SESSION_KEY,
            stream: "assistant",
            data: { delta: "." },
          },
        },
        clock.tick(),
      ),
    );
    const last = ev.filter((e) => e.type === "message.delta").at(-1);
    expect(last?.text).toBe(".");
  });

  it("an adopted run CONTINUING the same text still replaces (the replay/follow-on case)", () => {
    const { n, clock } = startTurn();
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "the answer" },
        },
      },
      clock.tick(),
    );
    openLifecycleGrace(n, clock);
    const ev = n.feed(chatFinal("webchat-followon", "the answer, completed"), clock.tick());
    const final = ev.find((e) => e.type === "message.final");
    expect(final?.text).toBe("the answer, completed");
  });

  // --- CONFINEMENT: the behaviours this policy must NOT break ---------------

  it("CONFINEMENT: the legitimate compaction REPLAY is still adopted", () => {
    const { n, clock } = startTurn();
    n.feed(agentFrame(OWN_RUN), clock.tick());
    // The gateway abandons the run to compact — it has now TOLD us a replay is
    // coming, which is the positive proof the policy requires.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
        },
      },
      clock.tick(),
    );
    const ev = n.feed(chatFinal("webchat-replay-run", "the replayed answer"), clock.tick());
    expect(ev.some((e) => e.type === "message.snapshot")).toBe(true);
    expect(n.ownRunIds.has("webchat-replay-run")).toBe(true);
  });

  it("CONFINEMENT: a plain follow-on run in the short grace is still adopted", () => {
    const { n, clock } = startTurn();
    openLifecycleGrace(n, clock);
    const ev = n.feed(chatFinal("webchat-followon", "the continued answer"), clock.tick());
    expect(ev.some((e) => e.type === "message.snapshot")).toBe(true);
    expect(n.ownRunIds.has("webchat-followon")).toBe(true);
  });
});

// --- G-18: `chat.side_result` is content, not noise -------------------------
describe("G-18: a by-the-way reply reaches the conversation", () => {
  it("side_result text becomes the reply, and the empty final that follows closes the turn on it", () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    // Upstream shape: the agent answered without starting a run, so the text
    // rides this event and the chat final that follows carries NO message.
    const ev1 = n.feed(
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          question: "and by the way?",
          text: "By the way, the meeting moved to Thursday.",
          isError: false,
          ts: 1,
        },
      },
      clock.tick(),
    );
    expect(ev1.filter((e) => e.type === "message.delta").map((e) => e.text)).toEqual([
      "By the way, the meeting moved to Thursday.",
    ]);

    const ev2 = n.feed(
      {
        event: "chat",
        payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, seq: 1, state: "final" },
      },
      clock.tick(),
    );
    // The turn closes on REAL content instead of waiting out a 90-second grace
    // and settling as an unexplained silent-empty response.
    expect(n.finalized).toBe(true);
    const final = ev2.find((e) => e.type === "message.final");
    expect(String(final?.text)).toContain("moved to Thursday");
  });

  it("an ERROR side_result finalizes the turn as an ERROR, never as the reply", () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    const ev = n.feed(
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          text: "The lookup tool is unavailable.",
          isError: true,
          ts: 1,
        },
      },
      clock.tick(),
    );
    // Presenting an explicit upstream failure as the agent's answer would be a
    // lie the user has no way to detect (codex P2).
    expect(ev.some((e) => e.type === "message.delta")).toBe(false);
    const status = ev.find((e) => e.type === "run.status");
    expect(status?.status).toBe("error");
    const final = ev.find((e) => e.type === "message.final");
    expect(String(final?.error)).toContain("lookup tool is unavailable");
  });

  it("codex P2: an identical side_result RE-BROADCAST is not delivered twice", () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    const frame = {
      event: "chat.side_result",
      payload: {
        kind: "btw",
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        text: "By the way, the meeting moved to Thursday.",
        isError: false,
        ts: 1,
      },
    };
    const ev1 = n.feed(frame, clock.tick());
    const ev2 = n.feed(frame, clock.tick());
    expect(ev1.filter((e) => e.type === "message.delta")).toHaveLength(1);
    expect(ev2.filter((e) => e.type === "message.delta")).toHaveLength(0);
  });

  it("a side_result of ANOTHER session is still dropped (isolation unchanged)", () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    const ev = n.feed(
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "other-run",
          sessionKey: "agent:x:atrium:chat:u-y:someone-else",
          text: "not yours",
          ts: 1,
        },
      },
      clock.tick(),
    );
    expect(ev).toEqual([]);
  });
});

// --- G-17: a preamble is not the answer -------------------------------------
// The gateway emits the model's preamble on the assistant stream as
// `{text, replace:true, phase:"commentary"}` (verified in the deployed 2026.7.1
// build). We read neither field: the preamble became the reply text AND locked
// snapshot precedence, after which every delta of the real answer was dropped.
describe("G-17: assistant-stream phase and replace", () => {
  const startTurn = () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };

  const assistant = (data: Record<string, unknown>) => ({
    event: "agent",
    payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, stream: "assistant", data },
  });

  const visible = (ev: BridgeEvent[]) =>
    ev
      .filter((e) => e.type === "message.delta" || e.type === "message.snapshot")
      .map((e) => e.text);

  it("a commentary preamble stays OUT of the reply, and the real answer still streams", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    ev.push(
      ...n.feed(
        assistant({
          text: "Let me look that up for you…",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "commentary-1",
        }),
        clock.tick(),
      ),
    );
    ev.push(...n.feed(assistant({ delta: "The answer ", phase: "final_answer" }), clock.tick()));
    ev.push(...n.feed(assistant({ delta: "is 42." }), clock.tick()));
    // The preamble never entered the buffer, and the deltas were NOT swallowed
    // by a snapshot lock the preamble had no business setting.
    expect(visible(ev)).toEqual(["The answer ", "is 42."]);
  });

  it("`replace` on the assistant stream refreshes the text WITHOUT locking out later deltas", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    ev.push(...n.feed(assistant({ delta: "draft text" }), clock.tick()));
    ev.push(
      ...n.feed(
        assistant({ text: "corrected text", delta: "", replace: true, phase: "final_answer" }),
        clock.tick(),
      ),
    );
    ev.push(...n.feed(assistant({ delta: " and more" }), clock.tick()));
    expect(visible(ev)).toEqual(["draft text", "corrected text", " and more"]);
    // The refresh is a DECLARED shrink: Convex must be allowed to apply it.
    const snap = ev.find((e) => e.type === "message.snapshot");
    expect(snap?.replace).toBe(true);
  });

  it("an untagged assistant snapshot keeps its historical authority (no behaviour change)", () => {
    const { n, clock } = startTurn();
    const ev: BridgeEvent[] = [];
    ev.push(...n.feed(assistant({ text: "full answer" }), clock.tick()));
    ev.push(...n.feed(assistant({ delta: " ignored" }), clock.tick()));
    expect(visible(ev)).toEqual(["full answer"]);
  });
});

// --- G-22: the native plan stream reaches the thread ------------------------
describe("G-22: `stream:\"plan\"` becomes a plan part", () => {
  it("emits the SAME plan part the update_plan tool path would, and counts NO tool call", () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    const ev = n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "plan",
          data: {
            phase: "update",
            title: "Plan updated",
            source: "codex-app-server",
            explanation: "On commence par lire.",
            steps: [
              { step: "Lire le fichier", status: "completed" },
              { step: "Corriger", status: "in_progress" },
            ],
          },
        },
      },
      clock.tick(),
    );
    expect(ev.find((e) => e.type === "plan")?.plan).toEqual({
      kind: "plan",
      steps: [
        { step: "Lire le fichier", status: "completed" },
        { step: "Corriger", status: "in_progress" },
      ],
      explanation: "On commence par lire.",
    });
    // A plan is not a tool call: the spawn/yield gates read those counters.
    expect(ev.some((e) => e.type === "tool.status")).toBe(false);
  });
});

// --- G-20: the gateway's DEFERRED terminal ----------------------------------
// The standard embedded-agent path sets `deferTerminalLifecycle`, so the gateway
// emits `lifecycle phase:"finishing"` when it is done producing and closing the
// turn out. We had no branch: the turn went silent until the 240 s recv timeout.
describe("G-20: lifecycle `finishing` and terminal metadata", () => {
  const startTurn = () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };
  const lifecycle = (data: Record<string, unknown>) => ({
    event: "agent",
    payload: {
      runId: OWN_RUN,
      sessionKey: SESSION_KEY,
      stream: "lifecycle",
      data,
    },
  });

  it("`finishing` says what the turn is doing and arms a wait WELL under the 240 s silence", () => {
    const { n, clock } = startTurn();
    const ev = n.feed(lifecycle({ phase: "finishing", startedAt: 1, endedAt: 2 }), clock.tick());
    expect(ev.find((e) => e.type === "turn.phase")?.phase).toBe("post_processing");
    expect(n.finalized).toBe(false);
    const wait = n.nextTimeout(clock.now);
    expect(wait).not.toBeNull();
    expect(wait!).toBeLessThan(BASE_RECV_TIMEOUT);
  });

  it("the real `end` cancels that wait (no double terminal)", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "finishing" }), clock.tick());
    n.feed(lifecycle({ phase: "end", stopReason: "stop", livenessState: "working" }), clock.tick());
    // Only the normal 10 s follow-on grace remains — the finishing wait is gone.
    const ev = n.tick(clock.now + 61);
    expect(ev.some((e) => e.type === "message.final")).toBe(true);
  });

  it("codex P2: a new run CLEARS the \"finishing\" label (nothing else does)", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "finishing" }), clock.tick());
    const ev = n.feed(lifecycle({ phase: "start" }), clock.tick());
    // Deltas never clear a phase: without this the resumed run would show
    // "Finishing up…" for its whole life.
    expect(ev.find((e) => e.type === "turn.phase")?.phase).toBe("generating");
  });

  it("a `finishing` that never becomes an `end` still closes the turn", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "finishing" }), clock.tick());
    const ev = n.tick(clock.now + 61);
    expect(n.finalized).toBe(true);
    expect(ev.find((e) => e.type === "message.final")).toMatchObject({
      diagnosticFinalizeCause: "lifecycle_finishing_timeout",
    });
  });

  it("the terminal METADATA reaches the diagnostics (a provider-timeout kill reads as one)", () => {
    const { n, clock } = startTurn();
    // Exactly what `buildLifecycleTerminalMeta` ships on a timed-out run.
    n.feed(
      lifecycle({
        phase: "end",
        aborted: true,
        status: "timed_out",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "working",
      }),
      clock.tick(),
    );
    const final = n
      .tick(clock.now + 11)
      .find((e) => e.type === "message.final");
    expect(final).toMatchObject({
      diagnosticTimeoutPhase: "provider",
      diagnosticProviderStarted: true,
      diagnosticAborted: true,
    });
  });

  it("`yielded` is the PRIMARY hand-off signal, reported without any sessions_yield tool", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "end", yielded: true, livenessState: "working" }), clock.tick());
    const final = n.tick(clock.now + 11).find((e) => e.type === "message.final");
    expect(final).toMatchObject({ gatewayYielded: true });
  });

  it("`yielded` on the TERMINAL itself is believed, with no lifecycle frame (codex)", () => {
    // 2026.9.1 puts the hand-off signal on `ChatFinalEvent` too. Reading it only off the
    // lifecycle meant that losing that one frame turned a legitimate hand-off into an
    // EMPTY response — and the empty-response guard retries, repeating the sub-agent's
    // work and any external effect it had.
    const { n, clock } = startTurn();
    // The terminal carries the signal; the lifecycle that follows does NOT (it is the
    // frame that went missing).
    const emitted = n.feed(
      {
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          yielded: true,
          message: { role: "assistant", content: [] },
        },
      },
      clock.tick(),
    );
    // NO lifecycle at all — that frame is the one that went missing. The previous
    // version of this test fed one anyway, so it proved nothing about the case its own
    // title claimed, and hid that an empty terminal then waited out the 90s empty-final
    // grace with the turn still showing as active (codex).
    const final =
      emitted.find((e) => e.type === "message.final") ??
      n.tick(clock.now + 1).find((e) => e.type === "message.final");
    expect(final, "the hand-off must finalize at once, not after the grace").toBeDefined();
    expect(final).toMatchObject({ gatewayYielded: true });
    expect((final as { diagnosticFinalizeCause?: string }).diagnosticFinalizeCause).not.toBe(
      "empty_final",
    );
  });

  it("codex P2: a compaction REPLAY does not inherit the abandoned attempt's terminal metadata", () => {
    const { n, clock } = startTurn();
    // The abandoned attempt was killed by the provider timeout…
    n.feed(
      lifecycle({
        phase: "end",
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "abandoned",
        replayInvalid: true,
      }),
      clock.tick(),
    );
    // …and the replay finishes cleanly. The turn the user keeps is the replay's.
    const ev = n.feed(
      {
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          seq: 2,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "la réponse" }] },
        },
      },
      clock.tick(),
    );
    const final = ev.find((e) => e.type === "message.final");
    expect(final).toMatchObject({
      diagnosticTimeoutPhase: null,
      diagnosticProviderStarted: null,
      diagnosticAborted: false,
    });
  });

  it("codex P1: an unknown `timeoutPhase` is BUCKETED, never forwarded verbatim (SOC2)", () => {
    const { n, clock } = startTurn();
    n.feed(
      lifecycle({
        phase: "end",
        aborted: true,
        // The wire type is a free string: a gateway variant could put anything
        // here, and this rides a metadata-ONLY trace.
        timeoutPhase: "waiting on user request: transférer 4000 EUR à Jean",
        livenessState: "working",
      }),
      clock.tick(),
    );
    const final = n.tick(clock.now + 11).find((e) => e.type === "message.final");
    expect(final?.diagnosticTimeoutPhase).toBe("other");
  });

  it("a known `timeoutPhase` keeps its own name", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "end", aborted: true, timeoutPhase: "queue" }), clock.tick());
    const final = n.tick(clock.now + 11).find((e) => e.type === "message.final");
    expect(final?.diagnosticTimeoutPhase).toBe("queue");
  });

  it("a NOMINAL end reports no terminal metadata (the gateway ships none)", () => {
    const { n, clock } = startTurn();
    n.feed(lifecycle({ phase: "end", stopReason: "stop", livenessState: "working" }), clock.tick());
    const final = n.tick(clock.now + 11).find((e) => e.type === "message.final");
    expect(final).toMatchObject({
      diagnosticTimeoutPhase: null,
      diagnosticProviderStarted: null,
      diagnosticAborted: false,
      gatewayYielded: false,
    });
  });
});

// --- G-21: a command approval nobody can grant ------------------------------
describe("G-21: `stream:\"approval\"`", () => {
  const startTurn = () => {
    const n = newNormalizer();
    const clock = new Clock();
    n.beginTurn(clock.now);
    n.noteRunStarted(OWN_RUN, clock.now);
    return { n, clock };
  };
  const approval = (data: Record<string, unknown>) => ({
    event: "agent",
    payload: {
      runId: OWN_RUN,
      sessionKey: SESSION_KEY,
      stream: "approval",
      data,
    },
  });

  it("`requested` says what the turn waits for and suspends the SILENCE clock", () => {
    const { n, clock } = startTurn();
    const ev = n.feed(
      approval({
        phase: "requested",
        kind: "exec",
        status: "pending",
        title: "Command approval requested",
        itemId: "cmd-1",
        toolCallId: "call-1",
        approvalId: "ap-1",
        command: "rm -rf /tmp/x",
      }),
      clock.tick(),
    );
    expect(ev.find((e) => e.type === "turn.phase")?.phase).toBe("awaiting_approval");
    // The run is ALIVE and deliberately waiting: the 240 s silence budget is the
    // wrong clock, and letting it fire produced an unexplained empty response.
    n.tick(clock.now + BASE_RECV_TIMEOUT + 1);
    expect(n.finalized).toBe(false);
  });

  it("codex P2: keep-alive traffic cannot re-arm the 240 s silence under an approval", () => {
    const { n, clock } = startTurn();
    n.feed(approval({ phase: "requested", kind: "exec", status: "pending" }), clock.tick());
    // A heartbeat of our own run lands while the human is still deciding.
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "start" },
        },
      },
      clock.tick(),
    );
    // Re-armed, the 240 s budget would fire long before the 900 s approval wait
    // and close the turn as a recv_timeout instead of naming the cause.
    n.tick(clock.now + BASE_RECV_TIMEOUT + 1);
    expect(n.finalized).toBe(false);
    expect(n.takeRecvSilence()).toBe(false);
  });

  it("content that RESUMES releases the approval wait (the answer came through)", () => {
    const { n, clock } = startTurn();
    n.feed(approval({ phase: "requested", kind: "exec", status: "pending" }), clock.tick());
    n.feed(
      {
        event: "agent",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { delta: "la suite" },
        },
      },
      clock.tick(),
    );
    // Back on the normal clock: an approval that resolved out of band must not
    // hold the turn for 900 s.
    n.tick(clock.now + BASE_RECV_TIMEOUT + 1);
    expect(n.takeRecvSilence()).toBe(true);
  });

  it("`resolved` releases the wait and clears the phase", () => {
    const { n, clock } = startTurn();
    n.feed(approval({ phase: "requested", kind: "exec", status: "pending" }), clock.tick());
    const ev = n.feed(
      approval({ phase: "resolved", kind: "exec", status: "denied" }),
      clock.tick(),
    );
    expect(ev.find((e) => e.type === "turn.phase")?.phase).toBe("generating");
    // …and the normal silence budget is back in charge.
    n.tick(clock.now + BASE_RECV_TIMEOUT + 1);
    expect(n.takeRecvSilence()).toBe(true);
  });

  it("an approval nobody answers ends the turn with a NAMED cause, never a silent timeout", () => {
    const { n, clock } = startTurn();
    n.feed(approval({ phase: "requested", kind: "exec", status: "pending" }), clock.tick());
    const ev = n.tick(clock.now + 901);
    expect(n.finalized).toBe(true);
    const final = ev.find((e) => e.type === "message.final");
    expect(final).toMatchObject({
      errorKind: "awaiting_approval",
      diagnosticFinalizeCause: "approval_timeout",
    });
    // The persisted error IS the code: the UI prints the localized headline and
    // suppresses a detail identical to it, so no untranslated English sentence
    // ends up under the French label (codex P2).
    expect(final?.error).toBe("awaiting_approval");
  });
});
