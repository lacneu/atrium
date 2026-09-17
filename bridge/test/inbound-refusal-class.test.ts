// A refusal RAISED BY THE BRIDGE ITSELF, on the inbound-media path, must never be
// reported as an unrecognised GATEWAY error — the gateway never answered anything,
// because the turn was never sent (session RPCs may already have gone out; the
// staging sits before `chat.send`). Live prod 2026-09-17: every attachment send
// with `UPSTREAM_ERROR`, whose fault domain is `bridge`, so one attachment marked
// a perfectly healthy connection dead for five minutes and told the user their
// next send would fail — while text-only sends kept going through on that link.
import { describe, expect, test } from "vitest";
import {
  classifyGatewayError,
  faultDomain,
} from "../src/core/dispatch-errors.js";
import { HealthRegistry } from "../src/core/health.js";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
