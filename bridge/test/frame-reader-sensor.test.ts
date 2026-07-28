/**
 * Every READER of an inbound frame reports what it could not read (W9/C4).
 *
 * The unit tests next door prove the sensor works when called. This one exists because
 * knowing WHERE to call it turned out to be the hard part, and getting it wrong is
 * invisible: a report that covers three readers of five looks exactly like a report that
 * covers all of them.
 *
 * The count went 2 → 3 → 5 in one sitting. The programme named two catch sites. The file
 * had a third (anchor propagation, same arrived frame). Then two readers turned out to
 * bypass that loop entirely — the pre-ack replay, and the voice relay in `server.ts` —
 * both reaching a bare `console.error`. And Hermes had its own reader, silent to the
 * operator on a second provider.
 *
 * So the sensor moved ONTO the readers and this test pins that placement:
 *   - every `normalizer.feed(` call goes through a guard that reports;
 *   - every declared `ExceptionSite` is wired exactly once, somewhere;
 *   - no frame-path catch in the session loop reports a frame twice, or not at all.
 *
 * It is a source scan on purpose. Driving a real `Session` needs a socket, a writer and a
 * gateway; the property under test is structural, and a structural property is better
 * pinned by reading the structure than by one lucky end-to-end case.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

const DRIFT = "providers/openclaw/protocol-drift.ts";
const RUN_MANAGER = "providers/openclaw/run-manager.ts";
const SESSION = "session.ts";
const HERMES_TURN = "providers/hermes/turn.ts";
const HERMES_WS = "providers/hermes/ws-turn.ts";

/** Files that hand a frame to a reader. Adding one to the bridge without adding it here
 *  is the gap this test cannot close on its own — which is why the site-wiring check
 *  below scans them as a SET against the declared vocabulary. */
const HERMES_WS_CLIENT = "providers/hermes/ws-client.ts";
const OPENCLAW_CLIENT = "providers/openclaw/openclaw-client.ts";
const HERMES_NORMALIZER = "providers/hermes/normalizer.ts";
const READER_FILES = [
  RUN_MANAGER,
  SESSION,
  HERMES_TURN,
  HERMES_WS,
  HERMES_WS_CLIENT,
  OPENCLAW_CLIENT,
  HERMES_NORMALIZER,
  "server.ts",
];

/** Brace-matched body of every `catch` in a source. Handlers in these files are short and
 *  contain no string with an unbalanced brace — a hand-rolled scanner earned its scars in
 *  lot 23 and is kept to this narrow job on purpose. */
function catchBodies(source: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  const re = /\}\s*catch\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      body: source.slice(m.index + m[0].length, i),
    });
  }
  return out;
}

/** The site literal of every call that WIRES one — its LAST string argument.
 *
 *  Two functions take a site: the sensor itself, and the shared decoder that reports on
 *  its caller's behalf. Counting only the first said `hermes-ws-parse` was unwired while
 *  it was wired through the decoder.
 *
 *  Paren-matched so a nested `new TypeError("…")` does not end the argument list early. */
function observeExceptionSites(source: string): string[] {
  const out: string[] = [];
  const re = /(?:observeException|decodeInboundFrame)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    const args = source.slice(m.index + m[0].length, i - 1);
    const strings = [...args.matchAll(/"([^"]*)"/g)].map((s) => s[1]);
    const last = strings[strings.length - 1];
    if (last !== undefined) out.push(last);
  }
  return out;
}

describe("no reader can fail on a frame in silence", () => {
  it("the sensor sits on RunManager.feed, so every caller is covered", () => {
    const rm = read(RUN_MANAGER);
    // The public entry delegates to an inner body inside a guard that reports AND
    // rethrows — swallowing here would change what a failed /send means.
    expect(rm).toMatch(/async feed\([\s\S]{0,1200}?observeException\(frame, err, "feed"\)/);
    expect(rm).toMatch(/observeException\(frame, err, "feed"\);\s*\n\s*throw err;/);
    expect(rm).toContain("private async feedInner(");
  });

  it("every normalizer.feed call is inside a reporting guard", () => {
    // The pre-ack replay reaches the normalizer WITHOUT going through `feed()`; the rest
    // are inside `feedInner`, which the guard above wraps. Any new call site outside both
    // is a reader nobody watches.
    const rm = read(RUN_MANAGER);
    const calls = [...rm.matchAll(/normalizer\.feed\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    const guardedRegions = [
      rm.slice(rm.indexOf("private async feedInner("), rm.length),
      // the replay closure, identified by its own site literal
      rm.slice(
        Math.max(0, rm.indexOf('observeException(frame, err, "pre-ack-replay")') - 1500),
        rm.indexOf('observeException(frame, err, "pre-ack-replay")') + 200,
      ),
    ];
    for (const c of calls) {
      const at = c.index ?? 0;
      const covered = guardedRegions.some((region) => {
        const start = rm.indexOf(region);
        return at >= start && at <= start + region.length;
      });
      const line = rm.slice(0, at).split("\n").length;
      expect(covered, `${RUN_MANAGER}:${line} feeds the normalizer outside any guard`).toBe(
        true,
      );
    }
  });

  it("the session loop reports its OWN readers, and not the feed twice", () => {
    const session = read(SESSION);
    const bodies = catchBodies(session);
    const reporting = bodies.filter((b) => b.body.includes("observeException"));
    // The two sub-agent readers — independent of the turn, reading the same frame.
    expect(reporting).toHaveLength(2);
    // …and the feed catch must NOT report: RunManager already did, and counting one
    // unreadable frame twice would inflate the only number an operator has.
    const feedCatch = bodies.find((b) => b.body.includes("session feed error"));
    expect(feedCatch).toBeDefined();
    expect(feedCatch?.body).not.toContain("observeException");
  });

  it("both providers are instrumented — on EVERY transport, not just one file", () => {
    // A sensor that sees one provider is a sensor an operator reads as "the other one is
    // healthy". This test asserted exactly that and was green for the wrong reason: it
    // read the REST file while `performHermesSend` picks the WEBSOCKET path by default,
    // where nothing reported at all. Both are checked now, and the DEFAULT one first.
    expect(read(HERMES_WS)).toContain('"hermes-ws-event"');
    expect(read(HERMES_TURN)).toContain('observeException(null, err, "hermes-stream")');
  });

  it("every Hermes transport module reports", () => {
    // The real rule, so a THIRD transport cannot repeat the story: every module under
    // providers/hermes that reads a stream of events must name a site.
    const dir = join(SRC, "providers/hermes");
    const readers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => {
        const body = readFileSync(join(dir, f), "utf8");
        // "CONSUMES a stream of events" — passes a per-event callback, feeds a
        // normalizer, or reads the socket itself. That last form was missing and it cost
        // a real blind spot: the WS client parses every message and dropped an
        // unparseable one with a bare `return`, upstream of the instrumented handler.
        // Not the module that merely DECLARES a transport primitive: `client.ts` exports
        // `readStream` and never sees an event, and a throw inside its parser surfaces in
        // the caller's guard, where the frame is known.
        return /norm\.feed\(|onEvent\s*=\s*\(|readStream\([^)]*,\s*\(|\.on\(\s*"message"/.test(
          body,
        );
      });
    expect(readers.length).toBeGreaterThanOrEqual(2);
    for (const f of readers) {
      expect(
        readFileSync(join(dir, f), "utf8"),
        `${f} reads events but never reports what it could not read`,
      ).toContain("observeException");
    }
  });

  it("NO transport decodes a wire frame on its own", () => {
    // The rule that closes the class, rather than the two instances of it. Both providers
    // parsed their own frames with a cast that validates nothing at runtime, so a frame
    // that parses to `null` threw out of the socket callback — reported by nobody, and on
    // OpenClaw's SHARED connection it takes every conversation with it. Hermes was fixed
    // first and the review found OpenClaw still open: one decoder, or this happens again.
    for (const rel of [OPENCLAW_CLIENT, HERMES_WS_CLIENT]) {
      const body = read(rel);
      const parses = [...body.matchAll(/JSON\.parse\(/g)];
      expect(
        parses,
        `${rel} parses a frame itself — route it through decodeInboundFrame instead`,
      ).toHaveLength(0);
      expect(body).toContain("decodeInboundFrame");
    }
  });

  it("every declared site is wired exactly once, across all reader files", () => {
    const union = /export type ExceptionSite =([\s\S]*?);/.exec(read(DRIFT))?.[1] ?? "";
    const sites = [...union.matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(5);
    const corpus = READER_FILES.map(read).join("\n");
    // The sites ACTUALLY passed to the sensor, read out of the calls themselves. Two
    // simpler rules failed first, and both failures are instructive: matching
    // `, "<site>")` missed a call whose arguments prettier had wrapped, and counting the
    // bare literal counted the word `feed` wherever it appeared in prose. A lint a
    // formatter or a comment can silence is not a lint.
    const wired = observeExceptionSites(corpus);
    for (const site of sites) {
      // AT LEAST once, not exactly once. "Exactly one" was itself a proxy — for "wired,
      // and only where intended" — and it broke the moment one reader gained a second
      // legitimate report (the WS envelope and its nested members are two distinct
      // failures at the same site). What the rule is actually about is dead vocabulary in
      // one direction and an undeclared site in the other; both are asserted, neither
      // needs a count.
      const uses = wired.filter((w) => w === site).length;
      expect(uses, `site "${site}" is declared but never wired`).toBeGreaterThanOrEqual(1);
    }
    expect(
      wired.filter((w) => !sites.includes(w)),
      "a call passes a site the contract does not declare",
    ).toEqual([]);
  });
});
