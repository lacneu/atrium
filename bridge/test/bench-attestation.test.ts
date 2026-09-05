/**
 * WHAT EARNS A VERSION CLAIM (W11/G6).
 *
 * `validatedVersions` decides real behaviour: `withinSupport` returns true for every
 * version at or above `maxValidated`, so a bump nobody earned declares support the bench
 * never gave. Until now the evidence was a prose comment beside the list.
 *
 * This suite makes the claim rest on a file: `bridge/protocol/openclaw/<version>/
 * BENCH.json`, written by the live bench on a GO run over the complete catalogue.
 *
 * It is deliberately NOT a signature. The same hand runs the bench, writes the file and
 * makes the commit, so authenticity is out of reach — claiming otherwise would be the
 * self-attested-hash trap this program has already paid for. What is checked is that the
 * claim, the vendored surface and the repository AGREE:
 *
 *   * the attestation sits in the directory it names;
 *   * its `vendoredSha256` matches a hash RE-COMPUTED here from that directory;
 *   * the run was a GO, over the whole catalogue, with no skip flags;
 *   * its `atriumSha` is a real commit — when the checkout can answer that at all.
 *
 * And the exemption cannot grow: the grandfathered set and the enforced set must be
 * disjoint, so a new failure can never be silenced by adding a name to the list.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A plain .mjs helper, shared VERBATIM with the live-bench harness so the number the
// bench writes and the number this test re-computes cannot drift.
// @ts-expect-error -- untyped .mjs
import * as supportDigest from "../scripts/lib/support-digest.mjs";

const { canonicalize, computeSupportDigest, listSupportFiles } = supportDigest as {
  canonicalize: (rel: string, bytes: Buffer) => Buffer;
  computeSupportDigest: (repoRoot: string) => string | null;
  listSupportFiles: (repoRoot: string) => string[];
};
import {
  BENCH_GRANDFATHERED,
  COMPAT_MANIFEST,
  compareVersions,
  parseVersion,
} from "../src/compat.js";

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_ROOT = join(BRIDGE, "protocol/openclaw");
const CORPUS_ROOT = join(BRIDGE, "test/fixtures/golden");

interface Attestation {
  kind: string;
  version: number;
  gatewayVersion: string;
  verdict: string;
  at: string;
  scenarios: string[];
  providers: Record<string, string>;
  flags: string[];
  atriumSha: string | null;
  bridgeVersion: string | null;
  vendoredSha256: string;
  worktree?: { dirty: boolean | null; deltaSha256: string | null };
  openclawRuns?: { id: string; ok: boolean; chat: string }[];
  supportDigest?: string | null;
}

/** The same hash the bench computes, RE-COMPUTED from the directory. A number an artifact
 *  carries about itself proves nothing; this one is only load-bearing because it is
 *  recomputed here — the same reason `vendor-integrity.test.ts` re-derives its snapshot. */
function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name === "BENCH.json") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else {
        hash.update(rel);
        hash.update("\0");
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

function readAttestation(version: string): Attestation | null {
  const file = join(PROTOCOL_ROOT, version, "BENCH.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Attestation;
}

/** OpenClaw scenario ids the golden corpus holds for a version — the catalogue floor. */
function corpusScenarios(version: string): string[] {
  const dir = join(CORPUS_ROOT, version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

const OPENCLAW = COMPAT_MANIFEST.providers.openclaw!;
const GRANDFATHERED = new Set(BENCH_GRANDFATHERED.openclaw);
/** Every claim that must be earned: `maxValidated` plus anything not grandfathered. */
const ENFORCED = OPENCLAW.validatedVersions.filter((v) => !GRANDFATHERED.has(v));

/** The exemption, PINNED. `ENFORCED` is `validatedVersions` minus the grandfather set, so
 *  asserting the two are disjoint proves nothing at all — it is true by construction, and
 *  adding a name to the exemption silently removed the obligation with it (raised in
 *  review). The only thing that actually freezes the list is a second copy, here, that a
 *  reviewer sees change. */
const FROZEN_GRANDFATHER = [
  "2026.5.19",
  "2026.6.1",
  "2026.6.5",
  "2026.6.10",
  "2026.6.11",
  "2026.7.1-beta.2",
  "2026.7.1-beta.5",
];

describe("the support digest covers what a version claim depends on", () => {
  // The first cut of this list was hand-picked and MISSED the two files this very lot
  // edits for 2026.8.1+ (codex). Named here one by one so a future narrowing of
  // SUPPORT_ROOTS fails loudly instead of quietly shrinking what a GO is about.
  const MUST_COVER = [
    "bridge/package-lock.json", // the resolved dependency tree the artifact loads
    "bridge/tsconfig.build.json", // how the sources become that artifact
    "bridge/src/compat.ts", // the support window and capability table
    "bridge/src/server.ts", // per-version request shapes (models.list owner)
    "bridge/src/convex-writer.ts", // every write the wire produces, plan clear included
    "bridge/src/session.ts", // session lifecycle across gateway generations
    "bridge/src/providers/openclaw/normalizer.ts", // the wire dialect itself
    "bridge/src/providers/openclaw/protocol-drift.ts", // the known-surface ledger
    "bridge/src/core/turn-sink.ts", // the turn state machine the frames drive
    "bridge/src/core/failure-classifier.ts", // failure text -> stable codes
  ];
  const covered = listSupportFiles(resolve(BRIDGE, "..")) as string[];
  for (const file of MUST_COVER) {
    it(`covers ${file}`, () => {
      expect(covered, `${file} is outside the digest: an edit there cannot go red`).toContain(file);
    });
  }
  it("SURVIVES the version stamping release CI performs before `npm test`", () => {
    // `scripts/set-version.mjs` rewrites bridge/package.json and its lockfile on every
    // tagged build, BEFORE the suite runs. A byte-for-byte digest went red there while
    // nothing the bench exercised had changed (codex).
    //
    // Exercised on BUFFERS, never on the real manifests: an earlier version of this
    // test rewrote them in place, which a parallel worker reading `package.json` at
    // import time could observe half-written — and an interrupted run left the checkout
    // stamped `9.9.9` (codex).
    const pkg = (version: string, extra: Record<string, unknown> = {}) =>
      Buffer.from(
        JSON.stringify({ name: "bridge", version, dependencies: { ws: "8.18.0" }, ...extra }),
      );
    const digest = (b: Buffer) =>
      createHash("sha256").update(canonicalize("bridge/package.json", b)).digest("hex");
    expect(digest(pkg("0.76.0")), "stamping a version must not move it").toBe(
      digest(pkg("9.9.9-dev.1.gdeadbee")),
    );
    expect(
      digest(pkg("0.76.0", { dependencies: { ws: "9.0.0" } })),
      "a dependency change MUST move it",
    ).not.toBe(digest(pkg("0.76.0")));

    // The lockfile's nested copy of the version is dropped too.
    const lock = (version: string) =>
      Buffer.from(
        JSON.stringify({ name: "bridge", version, packages: { "": { version, deps: 1 } } }),
      );
    const lockDigest = (b: Buffer) =>
      createHash("sha256")
        .update(canonicalize("bridge/package-lock.json", b))
        .digest("hex");
    expect(lockDigest(lock("0.76.0"))).toBe(lockDigest(lock("9.9.9-dev.1.gdeadbee")));

    // A file that is not a manifest is hashed verbatim, version-looking or not.
    const src = Buffer.from('export const version = "0.76.0";');
    expect(canonicalize("bridge/src/compat.ts", src)).toEqual(src);
  });

  it("excludes tests, which do not change what the bridge reads at runtime", () => {
    expect(covered.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});

describe("the exemption is finite and CANNOT grow", () => {
  it("is exactly the list frozen when the rule was introduced", () => {
    // Widening the exemption in `compat.ts` now requires editing this list too — which is
    // exactly the visibility the rule needs. Narrowing it (validating an old version for
    // real) also lands here, deliberately: shrinking an exemption is a claim too.
    expect([...GRANDFATHERED].sort()).toEqual([...FROZEN_GRANDFATHER].sort());
  });

  it("holds nothing at or above maxValidated", () => {
    // The exemption is for the PAST. A version at or above the one that decides support
    // cannot be exempt, whatever the list says.
    const max = OPENCLAW.supportedRange?.maxValidated;
    expect(max, "the manifest declares no maxValidated").toBeTruthy();
    const ceiling = parseVersion(max!);
    expect(ceiling, `maxValidated ${max} is unparseable`).not.toBeNull();
    for (const version of GRANDFATHERED) {
      const parsed = parseVersion(version);
      expect(parsed, `${version} is unparseable`).not.toBeNull();
      expect(
        compareVersions(parsed!, ceiling!) < 0,
        `${version} is exempt but not below maxValidated`,
      ).toBe(true);
    }
  });

  it("maxValidated is ENFORCED, and something is", () => {
    const max = OPENCLAW.supportedRange?.maxValidated;
    expect(ENFORCED, `maxValidated ${max} must rest on an attestation`).toContain(max!);
    expect(ENFORCED.length, "nothing is enforced — the rule would be vacuous").
      toBeGreaterThan(0);
  });

  it("every grandfathered entry is a REAL claim", () => {
    // A name in the exemption that is not in the manifest is dead weight nobody prunes.
    for (const version of GRANDFATHERED) {
      expect(
        OPENCLAW.validatedVersions,
        `${version} is exempt but not claimed`,
      ).toContain(version);
    }
  });
});

describe("an enforced claim rests on a GO attestation", () => {
  for (const version of ENFORCED) {
    it(`${version}`, () => {
      const att = readAttestation(version);
      expect(
        att,
        `${version} is claimed with no BENCH.json — run the live bench for it`,
      ).not.toBeNull();
      expect(att!.kind).toBe("atrium-bench-attestation");
      expect(att!.gatewayVersion, "the attestation names another version").toBe(version);
      expect(att!.verdict, "only a GO earns a claim").toBe("GO");
      expect(att!.flags, "a GO over a SUBSET is not a GO over the catalogue").toEqual([]);
    });
  }
});

describe("the attestation agrees with the repository", () => {
  for (const version of ENFORCED) {
    it(`${version}: the vendored hash is RE-COMPUTED, not trusted`, () => {
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const actual = hashDirectory(join(PROTOCOL_ROOT, version));
      expect(
        att!.vendoredSha256,
        "the vendored surface changed after the bench ran — re-run it",
      ).toBe(actual);
    });

    it(`${version}: a corpus EXISTS for it`, () => {
      // Without this, a brand-new version with no golden directory passes every check
      // below with `scenarios: []` — a GO declared over nothing at all (raised in
      // review). The corpus is what the catalogue is measured against; no corpus, no
      // claim.
      expect(
        corpusScenarios(version).length,
        `${version} is claimed but has no golden corpus — promote a run for it`,
      ).toBeGreaterThan(0);
      const att = readAttestation(version);
      expect(att!.scenarios.length, "an empty catalogue is not a catalogue").
        toBeGreaterThan(0);
    });

    it(`${version}: the catalogue covers the corpus`, () => {
      // The corpus names the OpenClaw scenarios a run must have exercised. A `--skip-*`
      // run either omits one of them (caught here) or records the flag (caught above).
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const ran = new Set(att!.scenarios);
      for (const scenario of corpusScenarios(version)) {
        expect(ran, `${scenario} is in the corpus but not in the run`).toContain(scenario);
      }
    });

    it(`${version}: the commit is not alone — the TREE it ran on is named`, () => {
      // `atriumSha` is HEAD, and a bench necessarily runs BEFORE the commit it earns:
      // the attested support is in the working tree, absent from that commit. Schema 2
      // records `worktree` so the GO names something reconstructible, and a dirty run
      // hashes its delta. Enforced on `maxValidated` only — the earlier attestations
      // predate the field and cannot be re-earned without re-running their gateway, so
      // the debt is bounded to history instead of being waived forever (codex).
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      if (version !== OPENCLAW.supportedRange?.maxValidated) return;
      expect(att!.version, "the newest claim must use the current schema").toBeGreaterThanOrEqual(2);
      const wt = att!.worktree;
      expect(wt, "schema 2 must record the worktree state").toBeDefined();
      expect([true, false, null]).toContain(wt!.dirty);
      if (wt!.dirty === true) {
        expect(wt!.deltaSha256, "a dirty run must hash its delta").toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(wt!.deltaSha256, "a clean or unknown run hashes nothing").toBeNull();
      }
    });

    it(`${version}: the support digest is RE-COMPUTED, not trusted`, () => {
      // `worktree` records provenance but cannot be re-derived — it hashes a diff
      // against a HEAD that moves. This one can, and it is the only thing tying the GO
      // to OUR side of the contract: the manifest, the frame readers and the
      // normalizer. Edit them after the bench and the claim goes red until a new run
      // earns it, which is what "a version claim rests on a live run" has to mean
      // (codex: the worktree hash alone is self-attested).
      // WHY ONLY THE CEILING, asked in review and answered here so it is not re-asked:
      // an older enforced version is protected by a DIFFERENT net, and a better one for
      // this purpose. `golden-replay.test.ts` replays that version's real captures
      // through the whole reading stack on every test run, in milliseconds — so a
      // regression in an old dialect goes red at once, with no gateway and no model.
      // The two enforced versions each have such a corpus, and the test above
      // ("a corpus EXISTS for it") keeps that true. Requiring a fresh live GO per
      // version on every bridge edit would demand N live runs per commit; the gate
      // would be removed, not honoured. The live digest pins the ceiling; the corpus
      // pins the rest (codex).
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      if (version !== OPENCLAW.supportedRange?.maxValidated) return;
      const here = computeSupportDigest(resolve(BRIDGE, ".."));
      expect(here, "no support file found — the digest cannot mean anything").not.toBeNull();
      expect(
        att!.supportDigest,
        "the newest claim must carry a support digest",
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(
        att!.supportDigest,
        "the gateway-reading code changed since the run that attested it: re-run the bench",
      ).toBe(here);
    });

    it(`${version}: the GO proves the session SURVIVES a delivered file`, () => {
      // The defect this version claims to fix does not show on the delivery — it shows
      // on the NEXT turn, when transcript-transform meets the persisted attachment
      // block. The bench proves it structurally: every OpenClaw scenario shares ONE
      // chat, so the runs after `media-outbound` are turns on a session that has a
      // delivered file in its history. That is exactly how 2026.8.1's poison was found —
      // every scenario after the delivery failed.
      //
      // RE-DERIVED here, not taken on trust: a bare count was a claim the repository
      // could not check, and an edited number would have kept this green with no
      // post-delivery turn at all (codex). The ordered records carry the evidence.
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      if (version !== OPENCLAW.supportedRange?.maxValidated) return;
      const runs = att!.openclawRuns;
      expect(runs, "the attestation must carry the ordered OpenClaw runs").toBeDefined();
      // VALIDATE the records before reading them. A cast is not a check: with every
      // `chat` absent the Set below still held one value and the "one session" proof
      // passed on nothing at all (codex).
      for (const [i, r] of runs!.entries()) {
        expect(typeof r, `run ${i} is not an object`).toBe("object");
        expect(typeof r?.id, `run ${i} has no id`).toBe("string");
        expect(typeof r?.ok, `run ${i} has no outcome`).toBe("boolean");
        expect(r?.chat, `run ${i} carries no chat identity`).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(new Set(runs!.map((r) => r.id)).size, "duplicate run ids").toBe(runs!.length);
      // A GO means EVERY OpenClaw scenario was clean, not merely the ones after the
      // delivery: a failure before it would say the run itself was not a GO.
      expect(
        runs!.every((r) => r.ok),
        "an OpenClaw scenario failed, yet the verdict claims GO",
      ).toBe(true);
      const at = runs!.findIndex((r) => r.id === "media-outbound");
      expect(at, "no file delivery in the run").toBeGreaterThanOrEqual(0);
      expect(
        runs!.length - at - 1,
        "nothing ran after the delivery: the run proves nothing about the NEXT turn",
      ).toBeGreaterThan(0);
      // One session throughout, or the later turns say nothing about this one.
      expect(new Set(runs!.map((r) => r.chat)).size, "runs must share ONE chat").toBe(1);
      // And the ordered records must agree with the scenario list the run attests.
      expect(runs!.map((r) => r.id).sort()).toEqual(
        att!.scenarios.filter((id) => att!.providers[id] !== "hermes").sort(),
      );
    });

    it(`${version}: the post-delivery proof REJECTS a hollow record set`, () => {
      // The checks above are only worth their words if they fail on a record set that
      // looks fine and proves nothing. Exercised on synthetic inputs, so a real
      // attestation is never rewritten to test its own guard (codex).
      const validate = (
        runs: { id: string; ok: boolean; chat?: string }[],
      ): string | null => {
        for (const r of runs) {
          if (typeof r?.id !== "string" || typeof r?.ok !== "boolean") return "shape";
          if (!/^[0-9a-f]{16}$/.test(r.chat ?? "")) return "chat";
        }
        if (new Set(runs.map((r) => r.id)).size !== runs.length) return "duplicate";
        if (!runs.every((r) => r.ok)) return "failed";
        const at = runs.findIndex((r) => r.id === "media-outbound");
        if (at < 0) return "no-delivery";
        if (runs.length - at - 1 <= 0) return "nothing-after";
        if (new Set(runs.map((r) => r.chat)).size !== 1) return "many-chats";
        return null;
      };
      const CHAT = "0123456789abcdef";
      const ok = [
        { id: "basic-turn", ok: true, chat: CHAT },
        { id: "media-outbound", ok: true, chat: CHAT },
        { id: "cron-tool", ok: true, chat: CHAT },
      ];
      expect(validate(ok)).toBeNull();
      // …and each way it can be hollow:
      expect(validate(ok.map((r) => ({ ...r, chat: undefined })))).toBe("chat");
      expect(validate(ok.map((r) => ({ ...r, chat: "" })))).toBe("chat");
      expect(validate([{ ...ok[0]!, ok: false }, ...ok.slice(1)])).toBe("failed");
      expect(validate(ok.slice(0, 2))).toBe("nothing-after");
      expect(validate([ok[0]!, ok[2]!])).toBe("no-delivery");
      expect(
        validate([ok[0]!, ok[1]!, { ...ok[2]!, chat: "fedcba9876543210" }]),
      ).toBe("many-chats");
      expect(validate([ok[0]!, ok[0]!, ok[1]!, ok[2]!])).toBe("duplicate");
    });

    it(`${version}: the Atrium commit is well-formed, and real when knowable`, () => {
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const sha = att!.atriumSha ?? "";
      expect(sha, "no commit recorded").toMatch(/^[0-9a-f]{40}$/);
      // Resolution needs the object, and CI clones SHALLOW (`actions/checkout` with no
      // fetch-depth), so a historical commit is genuinely unresolvable there. The check
      // therefore distinguishes "this commit does not exist" from "this checkout cannot
      // tell" — and says which, out loud, rather than passing silently either way.
      let shallow = true;
      try {
        shallow =
          execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: BRIDGE })
            .toString()
            .trim() === "true";
      } catch {
        console.warn(`[bench-attestation] ${version}: no git checkout — commit unverified`);
        return;
      }
      const known = (() => {
        try {
          // ANCESTOR of HEAD, not merely an object that exists: a detached or
          // other-branch commit satisfies `cat-file` while having nothing to do with the
          // code under test (raised in review).
          execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
            cwd: BRIDGE,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (known) return;
      if (shallow) {
        console.warn(
          `[bench-attestation] ${version}: commit ${sha.slice(0, 12)} is not in ` +
            "this SHALLOW clone — well-formed but unverified here",
        );
        return;
      }
      throw new Error(
        `${version}: commit ${sha} is not an ancestor of HEAD — the attestation ` +
          "names a commit that is not part of the code being tested",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// HERMES — the same rule, on the provider that now serves a client.
// ---------------------------------------------------------------------------
//
// `providers.hermes.validatedVersions` decides real behaviour exactly like OpenClaw's:
// `withinSupport` reads it, and beyond `maxValidated` the capability profile FREEZES at
// it. Yet nothing could be pointed at to justify a Hermes claim — the bench gated on the
// runtime version and then left no trace, so a promotion rested on someone's memory of a
// terminal session. The note in `compat.ts` even said Hermes "will not get" an
// attestation, on the premise that no Hermes instance served a client. One does.
//
// ONE ASYMMETRY, and it is the honest one: OpenClaw's attestation is checked against a
// RE-HASHED vendored directory. Hermes has no vendored surface in this repo, so there is
// nothing to re-hash and this suite must not pretend otherwise. What it checks instead is
// that the run NAMED the runtime version it claims and actually EXERCISED Hermes — a GO
// whose catalogue contains no Hermes scenario proves nothing about Hermes.
const HERMES = COMPAT_MANIFEST.providers.hermes!;
const HERMES_GRANDFATHERED = new Set(BENCH_GRANDFATHERED.hermes);
const HERMES_ENFORCED = HERMES.validatedVersions.filter(
  (v) => !HERMES_GRANDFATHERED.has(v),
);

/** The Hermes exemption, PINNED — same reasoning as `FROZEN_GRANDFATHER` above: the
 *  disjointness of the two sets is true by construction, so only a second copy a reviewer
 *  sees change actually freezes the list. */
const FROZEN_HERMES_GRANDFATHER = ["0.18.0", "0.18.2"];

const HERMES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../protocol/hermes");

function readHermesAttestation(version: string): Record<string, unknown> | null {
  const f = join(HERMES_ROOT, version, "BENCH.json");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
}

describe("the Hermes exemption cannot grow", () => {
  it("is exactly the pre-attestation pair", () => {
    expect([...HERMES_GRANDFATHERED].sort()).toEqual(
      [...FROZEN_HERMES_GRANDFATHER].sort(),
    );
  });

  it("every grandfathered Hermes version is actually claimed", () => {
    // An exemption for a version nobody claims is dead weight that hides the real list.
    for (const version of HERMES_GRANDFATHERED) {
      expect(HERMES.validatedVersions, `${version} is exempt but not claimed`).toContain(
        version,
      );
    }
  });

  it("maxValidated is ENFORCED once anything is", () => {
    // The teeth: the highest claim is the one that grants `withinSupport` to everything
    // above it, so it is the one that must be earned. While only the grandfathered pair
    // exists this is vacuous by design — and it stops being vacuous the moment a version
    // is added, which is exactly when it matters.
    const max = HERMES.supportedRange?.maxValidated ?? null;
    expect(max, "hermes must declare a maxValidated").not.toBeNull();
    if (HERMES_ENFORCED.length > 0) {
      expect(
        HERMES_ENFORCED,
        `maxValidated ${max} must rest on an attestation`,
      ).toContain(max!);
    }
  });
});

describe("an enforced Hermes claim rests on a GO attestation", () => {
  for (const version of HERMES_ENFORCED) {
    it(`${version}`, () => {
      const att = readHermesAttestation(version);
      expect(
        att,
        `${version} is claimed with no BENCH.json — run the live bench with ` +
          `--expect-hermes-version ${version}`,
      ).not.toBeNull();
      expect(att!.kind).toBe("atrium-bench-attestation");
      expect(att!.provider, "an OpenClaw attestation cannot vouch for Hermes").toBe(
        "hermes",
      );
      // The RUNTIME version, and it must be the one the directory names: an attestation
      // filed under the wrong version is the one mistake this whole file exists to catch.
      expect(att!.hermesVersion, "the attestation names another runtime").toBe(version);
      expect(att!.verdict, "only a GO earns a claim").toBe("GO");
      expect(att!.flags, "a GO over a SUBSET is not a GO over the catalogue").toEqual([]);
    });

    it(`${version}: the run actually EXERCISED Hermes`, () => {
      // Without this, a GO whose catalogue happened to contain no Hermes scenario would
      // attest Hermes — the same empty claim the OpenClaw corpus check refuses.
      const att = readHermesAttestation(version);
      expect(att).not.toBeNull();
      const exercised = att!.hermesScenarios as string[] | undefined;
      expect(
        exercised?.length ?? 0,
        `${version} is claimed by a run that touched no Hermes scenario`,
      ).toBeGreaterThan(0);
    });
  }
});
