/**
 * Catastrophic backtracking in the media-path scanners (prod freeze, 2026-09-29).
 *
 * Both scanners carried a root prefix `(?:/[^\s…]+)*` whose class admits `/`: a
 * whitespace-free token with n slashes and no deliverable path took ~2^n steps to
 * reject. The normalizer ran its scanner on EVERY string of every tool result and on
 * every visible text (it takes no file from the live stream any more; the stripper still
 * reads every visible text), so one such token (a base64 blob, a NUL- or comma-joined path
 * list, a long URL) pegged the bridge's only thread: 100 % CPU, no I/O, /health dead,
 * no ingest, for 17 minutes, until the container was restarted.
 *
 * The inputs are synthetic (no conversation content). Each timing bound is several
 * orders of magnitude above the fixed cost and far below the old one, so they are not
 * flaky in either direction: the old form needs ~0.5 s at 30 slashes and doubles every
 * one or two slashes after that, the new one is linear.
 */

import { describe, expect, it } from "vitest";

import {
  Normalizer,
  type BridgeEvent,
} from "../src/providers/openclaw/normalizer.js";
import {
  DELIVERABLE_MEDIA_SUBDIRS,
  sanitizeText,
  stripDeliverablePathsToBasename,
} from "../src/providers/openclaw/sanitize.js";

const SESSION_KEY = "agent:main:webchat:redos-test";
const RUN = "run-redos-1";

/** The pre-fix forms, verbatim — the reference the fix must agree with. */
const SUBDIRS = DELIVERABLE_MEDIA_SUBDIRS.join("|");
const OLD_ANY_ROOT_RE = new RegExp(
  String.raw`(?:MEDIA:)?(?:/[^\s\`)>"']+)*/media/(?:${SUBDIRS})/([^\s\`)>]+)`,
  "g",
);

/** A whitespace-free token with `n` slashes and no deliverable path. */
function slashToken(n: number): string {
  return "/a".repeat(n) + "!";
}

/** base64-shaped filler (A-Z a-z 0-9 + /): deterministic, ~1 slash every 64 chars
 *  like real base64, no conversation content. */
function base64Like(chars: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let x = 0x2545f491;
  for (let i = 0; i < chars; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += alphabet[(x >>> 0) % 64];
  }
  return out;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

function feedToolResult(result: unknown): BridgeEvent[] {
  const normalizer = new Normalizer(SESSION_KEY, null);
  normalizer.beginTurn(1000);
  normalizer.noteRunStarted(RUN, 1000);
  return normalizer.feed(
    {
      type: "event",
      event: "agent",
      payload: {
        sessionKey: SESSION_KEY,
        runId: RUN,
        stream: "tool",
        data: { name: "exec", phase: "result", toolCallId: "tc-1", result },
      },
    },
    1000.01,
  );
}

describe("media-path scanners: no catastrophic backtracking", () => {
  it("a tool result holding a slash-heavy token is normalized in linear time (the prod freeze)", () => {
    // 34 slashes: seconds on the old scanner (and every further slash doubles it —
    // the prod token needed only ~45 to never return); well under a millisecond now.
    const { value: events, ms } = timed(() =>
      feedToolResult({
        content: [{ type: "text", text: `stdout: ${slashToken(34)}\nexit 0` }],
      }),
    );
    expect(ms).toBeLessThan(250);
    expect(events.some((e) => e.type === "tool.status")).toBe(true);
  });

  it("a delivery under a deep directory tree is stripped in linear time", () => {
    // Not only a REJECTED token backtracks: on the old form a genuine delivery whose
    // path goes 26 directories below the media dir took seconds to accept (each extra
    // level roughly doubles it; 30 levels measured 51 s), because every slash after the
    // directory is another place to split.
    const deep = `/home/node/.openclaw/media/outbound/${"d/".repeat(26)}f.png`;
    const { ms } = timed(() => feedToolResult(`saved ${deep}`));
    expect(ms).toBeLessThan(250);
    const stripped = timed(() => sanitizeText(`Voici ${deep}`));
    expect(stripped.ms).toBeLessThan(250);
    expect(stripped.value).toBe("Voici f.png");
  });

  it("a tool result holding a real path beside a huge base64 blob is read fast", () => {
    // 400 KB of base64 (~6000 slashes): hopeless on the old form, and quadratic
    // (seconds) with the quantifier fixed but the line scanned whole.
    const blob = base64Like(400_000);
    const { ms } = timed(() =>
      feedToolResult(
        `wrote /home/node/.openclaw/media/outbound/report.pdf\n${blob}\n` +
          `data ${blob} then /srv/state/media/outbound/chart.png done`,
      ),
    );
    expect(ms).toBeLessThan(1000);
  });

  it("sanitizeText strips a server path next to a slash-heavy token without hanging", () => {
    const text = `Voici /srv/state/media/outbound/rapport.pdf ${slashToken(34)} ${base64Like(400_000)}`;
    const { value, ms } = timed(() => sanitizeText(text));
    expect(ms).toBeLessThan(1000);
    expect(value).toContain("rapport.pdf");
    expect(value).not.toContain("/srv/state/media/outbound/");
  });

  it("stripDeliverablePathsToBasename matches the old whole-line replacement exactly", () => {
    const pieces = [
      "/", "a", "//", " ", "\"", "'", ")", ">", "`", "MEDIA:", "/media/",
      "/media/outbound/", "/media/tool-video-generation/", "f.mp4", "x",
    ];
    let seed = 11;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const basename = (p: string): string => {
      const t = p.replace(/\/+$/, "");
      const i = t.lastIndexOf("/");
      return i >= 0 ? t.slice(i + 1) : t;
    };
    for (let k = 0; k < 20_000; k++) {
      let s = "";
      const len = rnd(10);
      for (let j = 0; j < len; j++) s += pieces[rnd(pieces.length)];
      const expected = s.replace(OLD_ANY_ROOT_RE, (_m, tail: string) => basename(tail));
      expect(stripDeliverablePathsToBasename(s), JSON.stringify(s)).toBe(expected);
    }
  });
});
