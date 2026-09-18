// A refusal RAISED BY THE BRIDGE ITSELF, on the inbound-media path, must never be
// reported as an unrecognised GATEWAY error — the gateway never answered anything,
// because the turn was never sent (session RPCs may already have gone out; the
// staging sits before `chat.send`). Live prod 2026-09-17: every attachment send
// with `UPSTREAM_ERROR`, whose fault domain is `bridge`, so one attachment marked
// a perfectly healthy connection dead for five minutes and told the user their
// next send would fail — while text-only sends kept going through on that link.
import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyGatewayError,
  faultDomain,
} from "../src/core/dispatch-errors.js";
import { HealthRegistry } from "../src/core/health.js";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOUND_CLEANUP_FAILED,
  INBOUND_NAME_TOO_LONG,
  INBOUND_COLLISION,
  INBOUND_FETCH_FAILED,
  INBOUND_PATH_REFUSED,
  INBOUND_STAGE_FAILED,
  INBOUND_TOO_LARGE,
  InboundMediaRefusal,
  logInboundRefusal,
  stageInboundReferences,
} from "../src/core/inbound-media.js";

describe("an inbound-media refusal is OURS, and says so", () => {
  const CASES: Array<[string, string]> = [
    [INBOUND_PATH_REFUSED, "attachment_path_refused"],
    [INBOUND_NAME_TOO_LONG, "attachment_name_too_long"],
    [INBOUND_STAGE_FAILED, "attachment_staging_failed"],
    [INBOUND_CLEANUP_FAILED, "attachment_cleanup_unconfirmed"],
    // Dropped per file in practice; mapped so the size answer can never regress
    // into "unrecognised upstream error".
    [INBOUND_TOO_LARGE, "ATTACHMENT_TOO_LARGE"],
    [INBOUND_COLLISION, "attachment_staging_failed"],
    [INBOUND_FETCH_FAILED, "attachment_staging_failed"],
  ];

  test("each refusal gets its own class, never the gateway catch-all", () => {
    for (const [code, expected] of CASES) {
      expect(
        classifyGatewayError(new InboundMediaRefusal(code), {
          hasAttachments: true,
        }),
        code,
      ).toBe(expected);
    }
  });

  test("and NONE of them touches the connectivity verdict — either way", () => {
    // Through the REAL registry, because `faultDomain` alone proved only half of
    // it: `downstream` would have been just as wrong as `bridge`, since
    // `recordDownstreamReject` forces `state = "connected"` — a local refusal
    // would then have ERASED a real network incident and reported the instance
    // green (codex). The only truthful answer is to leave the state alone.
    const ref = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    for (const [code, expected] of CASES) {
      if (expected === "ATTACHMENT_TOO_LARGE") continue; // a real gateway class
      const cls = classifyGatewayError(new InboundMediaRefusal(code), {
        hasAttachments: true,
      });
      expect(faultDomain(cls), code).toBe("local");

      // A link that is genuinely DOWN stays down.
      const down = new HealthRegistry(1000, () => 2000);
      down.recordError(ref, "GATEWAY_TIMEOUT");
      down.recordLocalRefusal(ref, cls);
      expect(down.snapshot().targets[0]!.state, `${code}: erased an outage`).toBe(
        "error",
      );

      // A link that is genuinely UP stays up.
      const up = new HealthRegistry(1000, () => 2000);
      up.recordOk(ref);
      up.recordLocalRefusal(ref, cls);
      expect(up.snapshot().targets[0]!.state, `${code}: killed a live link`).toBe(
        "connected",
      );
      // …and the refusal is still VISIBLE: recorded, counted, named — in a field
      // of its OWN, because the admin card renders `lastDownstreamReject` as
      // "rejected by the gateway", about a gateway that never saw the request.
      const t = up.snapshot().targets[0]!;
      expect(t.lastLocalRefusal?.code, code).toBe(cls);
      expect(t.localRefusalCount, code).toBe(1);
      // The send WAS attempted, and the admin line counts attempts — a refused
      // attachment must not read as "nothing happened" (codex).
      expect(t.attempts, `${code}: the attempt went uncounted`).toBe(2);
      expect(t.lastDownstreamReject, `${code}: borrowed the gateway's note`).toBeNull();
      expect(t.lastError, `${code}: minted a bridge error`).toBeNull();
    }
  });

  test("the refusal NAMES the clause that refused, not just the code", async () => {
    // WHAT THIS IS FOR. `inbound_media_path_refused` covers a dozen clauses, and the
    // message named none of them: a live incident spent two hours discovering that
    // two sibling directories were missing, and the bench spent two more on a
    // `/home` symlink and then a world-writable ancestor. The code stays the wire
    // contract; the reason is the sentence the operator needs, and it is STRUCTURAL
    // — the rule and the directory, never a filename.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-reason-")));
    try {
      const thrown = (await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "secret-invoice.pdf" }],
        "cmid",
        {
          // The production shape of the failure: the root is there, the published
          // directory beside it is not.
          inboundDir: join(root, "published"),
          stagingDir: join(root, ".staging"),
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      )) as InboundMediaRefusal | null;
      expect(thrown, "the staging did not refuse").toBeInstanceOf(
        InboundMediaRefusal,
      );
      // STAGE_FAILED, not PATH_REFUSED: an absent directory is "the place to write
      // is gone", the same fact as a mount vanishing mid-batch, and the existing
      // suite pins that classification. A first version of this change turned the
      // absence into a path refusal and moved a wire-visible code — the rollback
      // test caught it.
      expect(thrown!.code).toBe("inbound_media_stage_failed");
      expect(thrown!.reason, "the refusal carries no reason").toBeTruthy();
      // It says WHICH directory and WHY, so the next step is obvious.
      expect(thrown!.reason).toContain(join(root, "published"));
      expect(thrown!.reason).toMatch(/does not exist/);
      // …and it does NOT carry the user's filename into a log line.
      expect(thrown!.reason).not.toContain("secret-invoice");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("NO reason anywhere interpolates the user's filename", () => {
    // The assertion above covers ONE early failure, and sampling cannot cover the
    // rest: the leaf rules work on the composed disk name, which contains the
    // filename, and a reason added there later would slip past any single fixture.
    // (Those clauses do not throw — a bad file is DROPPED best-effort — so there is
    // no thrown reason to inspect for them at all.) The invariant is total, so it is
    // asserted at the source: no `refused(...)` reason may interpolate a name.
    const src = readFileSync(
      new URL("../src/core/inbound-media.ts", import.meta.url),
      "utf8",
    );
    // Every `refused(` call's arguments, comments stripped.
    const calls = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .split("refused(")
      .slice(1)
      // BALANCED parens, not a window or the first `);`. Two heuristics in a row ran
      // past the call and flagged code that has nothing to do with a refusal — a
      // guard that cries wolf gets its allowlist padded until it guards nothing.
      .map((chunk) => {
        let depth = 1;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === "(") depth++;
          else if (chunk[i] === ")" && --depth === 0) return chunk.slice(0, i);
        }
        return chunk;
      });
    // TOTAL by construction, not by a list of spellings: a reason may only
    // interpolate from an allowlist of structural expressions. An alias, another
    // property or a helper carrying the name would fail this, where naming four
    // forbidden spellings would not.
    const ALLOWED = [
      "current",
      "path",
      "real",
      "root",
      "config.inboundDir",
      "config.stagingDir",
      "config.maxBytes",
      "expectedUid",
      "metadata.uid",
      "opened.uid",
      "opened.nlink",
      "(opened.mode & 0o777).toString(8)",
      "PRIVATE_FILE_MODE.toString(8)",
      "PRIVATE_FILE_MODE",
      "MAX_LEAF_BYTES",
      "process.geteuid?.()",
      "publishedStat.dev",
      "stagingStat.dev",
      "expectedLinks",
      "Buffer.byteLength(diskName)", // a LENGTH, not the name
      '(error as NodeJS.ErrnoException)?.code ?? "unknown"',
      "(error as NodeJS.ErrnoException)?.code",
      // A local holding "it does not exist" or an errno phrase — structural, and the
      // allowlist caught it the moment it was written, which is the point: a name
      // enters this list only when someone has looked at what it holds.
      "why",
    ];
    for (const call of calls) {
      for (const m of call.matchAll(/\$\{([^}]*)\}/g)) {
        const expr = m[1] ?? "";
        expect(
          ALLOWED.includes(expr.trim()),
          `a refusal reason interpolates \`${expr.trim()}\`, which is not in the ` +
            "structural allowlist — if it carries no user data, add it there",
        ).toBe(true);
      }
    }
  });

  test("the REAL staging path produces a class, not the catch-all", async () => {
    // Through `stageInboundReferences` itself, exactly as `/send` calls it — the
    // constructed-error tests above prove the mapping, this one proves the module
    // actually raises something the mapping can see. Without it, turning the
    // refusal back into a bare `Error` left every test green while production
    // went on reporting an unrecognised gateway error.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-refusal-")));
    try {
      const published = join(root, "published");
      await mkdir(published, { mode: 0o700 });
      const thrown = await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "v.pdf" }],
        "cmid",
        {
          inboundDir: published,
          // The private staging dir may not be the published one — the refusal
          // this instance's misconfiguration would hit.
          stagingDir: published,
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown, "the staging did not refuse").toBeInstanceOf(Error);
      expect(classifyGatewayError(thrown, { hasAttachments: true })).toBe(
        "attachment_path_refused",
      );
      expect(
        faultDomain(classifyGatewayError(thrown, { hasAttachments: true })),
      ).toBe("local");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a local refusal does not RESURRECT an error that was decaying", () => {
    // `decayedState` projects a stale `error` down to `idle` after five minutes of
    // no attempt, so `lastAttemptAt` is the decay clock for the LINK. A local
    // refusal never touched the link: bumping that clock would let a user
    // re-sending an attachment hold the admin header red, the instance degraded
    // and the chat banner up for ever, on a link nothing had tested (codex P1).
    let now = 1_000_000;
    const reg = new HealthRegistry(1000, () => now);
    const ref = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    reg.recordError(ref, "GATEWAY_TIMEOUT");
    now += 6 * 60 * 1000; // past ERROR_DECAY_MS with no further attempt
    expect(reg.snapshot().targets[0]!.state).toBe("idle");
    reg.recordLocalRefusal(ref, "attachment_path_refused");
    expect(
      reg.snapshot().targets[0]!.state,
      "a local refusal restarted the connectivity decay clock",
    ).toBe("idle");
  });

  test("a REBIND forgets the previous agent's refusal", () => {
    // The per-agent reset clears the story when the canonical rebinds to another
    // agent. Left out of it, the new agent's row still showed the old one's
    // refusal and its count (codex) — the same attribution bug the reset exists
    // to prevent for errors and downstream rejects.
    const reg = new HealthRegistry(1000, () => 2000);
    const a = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    reg.recordLocalRefusal(a, "attachment_path_refused");
    reg.recordOk({ ...a, agentId: "b" });
    const t = reg.snapshot().targets[0]!;
    expect(t.agentId).toBe("b");
    expect(t.lastLocalRefusal, "carried over the other agent's refusal").toBeNull();
    expect(t.localRefusalCount).toBe(1 - 1 + 0);
  });

  test("a LONG FILE NAME is the reader's to fix, not the operator's", async () => {
    // The composed disk name (turn id + index + the user's name) must fit one
    // filesystem leaf. Wearing the path-contract class, this sent an operator to
    // inspect volumes that were perfectly fine, while the person who could fix it
    // in five seconds — by renaming — was told the shared space was broken
    // (codex). Driven through the REAL staging, with a healthy directory pair.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-longname-")));
    try {
      const published = join(root, "published");
      const staging = join(root, ".staging");
      await mkdir(published, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const thrown = await stageInboundReferences(
        [
          {
            url: "u",
            mimeType: "application/pdf",
            fileName: `${"n".repeat(250)}.pdf`,
          },
        ],
        "7b3216bf-90ac-405f-826e-e72ab7de71e7",
        {
          inboundDir: published,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown, "a 250-byte name was staged").toBeInstanceOf(Error);
      expect(classifyGatewayError(thrown, { hasAttachments: true })).toBe(
        "attachment_name_too_long",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the class survives a REWORDING of the refusal", () => {
    // Recognised by TYPE, like `ContextBlockedError`: a decision we made may not
    // depend on how we phrased it. A plain Error carrying the same text is not
    // one of ours and keeps falling to the catch-all.
    class Reworded extends InboundMediaRefusal {
      constructor() {
        super(INBOUND_PATH_REFUSED);
        this.message = "staging refused: /var/media is outside the allowed root";
      }
    }
    expect(classifyGatewayError(new Reworded())).toBe("attachment_path_refused");
    expect(classifyGatewayError(new Error(INBOUND_PATH_REFUSED))).toBe(
      "UPSTREAM_ERROR",
    );
  });
});

describe("logInboundRefusal — the line the operator reads", () => {
  // The refusal carrying a reason proves nothing if nothing prints it. WHAT THIS
  // DOES NOT COVER, said plainly: it calls the function directly, so removing the
  // call from `/send` would leave it green. The source guard below is what pins
  // that the route still makes the call.
  test("a refused staging writes the clause to the bridge log", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-log-")));
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
    try {
      // Straight through the module the route calls, then the route's own branch:
      // booting the whole server for one log line would test the HTTP stack, not
      // this. What is pinned is that the branch exists and says the reason.
      const thrown = (await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "v.pdf" }],
        "cmid",
        {
          inboundDir: join(root, "published"),
          stagingDir: join(root, ".staging"),
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      )) as InboundMediaRefusal;
      logInboundRefusal(thrown);
      expect(
        errors.some((line) => line.includes("[inbound-media] refused because")),
        `nothing named the clause; logged: ${JSON.stringify(errors)}`,
      ).toBe(true);
      expect(errors.join(" ")).toContain("does not exist");
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failure that is NOT ours logs nothing extra", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
    try {
      logInboundRefusal(new Error("some gateway error"));
      // A refusal with no reason is also silent: an empty "refused because" line
      // would be worse than none.
      logInboundRefusal(new InboundMediaRefusal("inbound_media_stage_failed"));
      expect(errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the /send route still calls it", () => {
  // The tests above drive `logInboundRefusal` directly; only this says the route
  // uses it. Reading the source is a weaker instrument than exercising the route —
  // which would need a live gateway — and it is named as such rather than dressed up.
  test("the failure path passes the error to logInboundRefusal", () => {
    const src = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    expect(src).toMatch(/bridge \/send failed[\s\S]{0,300}logInboundRefusal\(err\)/);
  });
});
