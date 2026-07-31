// The vendored schemas must BE what they claim to be (W10 / G0).
//
// Every file under `protocol/openclaw/<version>/` says "VENDORED VERBATIM from
// openclaw/openclaw @ v<version>" in its header, and the whole ratchet rests on that
// sentence being true: the coverage manifest classifies fields against these files,
// so a hand-edited "verbatim" copy turns the entire examination into fiction — and
// the more convincing the edit, the quieter the failure.
//
// `PROVENANCE.json` records the upstream commit SHA plus a sha256 per file. This test
// recomputes them. A file touched by hand fails here; re-running
// `scripts/vendor-protocol.mjs` is the only way to change one.
//
// THE LIMIT OF THIS FILE, and the DECIDED reason it stays (raised in review three
// times, the last time asking for CI to close it):
//
// Every hash here is recorded BY US. Someone who changes a schema and updates
// `vendored`, `upstream` and `rewrites` together passes this file, and in CI — where
// no upstream checkout exists — passes the tag comparison too, which only warns.
//
// That is deliberate. This lot's purpose is to stop protocol changes and regressions
// from landing UNNOTICED; it is not an insider-tampering control, and making every PR
// depend on cloning another organization's repository from GitHub buys protection
// against a threat this program is not defending against, at the cost of a CI that
// fails when github.com is slow. What the record buys instead is that the claim is
// FALSIFIABLE and cheap to check:
//
//     node scripts/vendor-protocol.mjs <version> --src <a v<version> checkout>
//     git diff --exit-code bridge/protocol/openclaw/<version>
//
// The script is deterministic (no timestamps), refuses a dirty tree, and refuses a
// checkout whose remote is not `openclaw/openclaw` — so that one command reproduces
// the directory byte-for-byte or names the discrepancy. The test below runs the
// equivalent comparison automatically whenever a checkout IS reachable (locally, the
// bench keeps one), and says so out loud when it is not, rather than reporting a
// success it has not earned.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { vendoredVersions } from "./helpers/vendored.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { deriveSnapshotFields } from "../scripts/lib/derive-snapshot.mjs";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { deriveEventCatalogue } from "../scripts/lib/derive-event-catalogue.mjs";

const PROTOCOL = new URL("../protocol/openclaw/", import.meta.url);

interface FileHashes {
  /** Path inside the tag these bytes were copied from, repo-root relative. The
   *  vendored layout is FLAT, so the location is not recoverable from the filename —
   *  it has to be recorded, and the upstream watchlist derives from it. */
  upstreamPath: string;
  /** sha256 of the vendored file AS WRITTEN (our header included). Self-attested. */
  vendored: string;
  /** sha256 of the RAW upstream bytes. A claim about a PUBLIC tag: recomputable by
   *  anyone, so it cannot be quietly adjusted to cover an edit. */
  upstream: string;
  /** The import lines our rewrite changed, with their ORIGINAL upstream text and
   *  0-based line index. Empty when the file was copied untouched. Recorded so the
   *  upstream bytes can be RECONSTRUCTED and checked — `primitives.ts` is rewritten,
   *  and it is a walked schema module, so exempting rewritten files from the check
   *  would have exempted a third of the reviewed surface. */
  rewrites: { line: number; upstream: string }[];
}

interface Provenance {
  version: string;
  upstreamRepo: string;
  upstreamTag: string;
  upstreamSha: string;
  files: Record<string, FileHashes>;
  /** Artifacts DERIVED from upstream rather than copied from it (W9 / G-68): the field
   *  names of a return shape, not bytes. Attributed by the sha256 of the source file they
   *  were read from, so "this list came from that source" stays checkable. */
  derived?: Record<
    string,
    {
      upstreamPath: string;
      upstream: string;
      fields?: number;
      events?: number;
      constantsPath?: string;
      constants?: string;
    }
  >;
}

/** The header the vendoring script prepends. Derived from the file itself rather than
 *  hardcoded: a miscount would silently shift every body comparison (the first
 *  version of this test used 6 and failed four files that were in fact identical). */
function stripHeader(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith("// ")) i += 1;
  // The header is OUR block; upstream's own first line is also a comment, so stop at
  // the marker line the script always writes last.
  const end = lines.findIndex((l) =>
    l.startsWith("// (Only change vs upstream:"),
  );
  if (end === -1) throw new Error("vendored file has no provenance header");
  return lines.slice(end + 1).join("\n");
}

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

describe("vendored protocol integrity", () => {
  it("there is at least one vendored version (an empty ratchet checks nothing)", () => {
    expect(vendoredVersions().length).toBeGreaterThan(0);
  });

  for (const version of vendoredVersions()) {
    describe(version, () => {
      // A version with no PROVENANCE.json is UNVERIFIABLE — which for the older
      // hand-vendored directories is a fact, not a pass. It is reported as a
      // skipped-with-reason rather than silently tolerated.
      const provPath = new URL(`${version}/PROVENANCE.json`, PROTOCOL);
      let prov: Provenance | null = null;
      try {
        prov = JSON.parse(readFileSync(provPath, "utf-8")) as Provenance;
      } catch {
        prov = null;
      }

      it("carries a provenance record naming its upstream tag and commit", () => {
        expect(
          prov,
          `protocol/openclaw/${version}/PROVENANCE.json is missing — this directory ` +
            `was vendored before the script existed and cannot be verified. Re-run ` +
            `scripts/vendor-protocol.mjs ${version} to make it checkable.`,
        ).not.toBeNull();
        expect(prov!.version).toBe(version);
        expect(prov!.upstreamTag).toBe(`v${version}`);
        // A 40-hex commit id, not a branch name or "HEAD": the point is that the
        // exact upstream tree is nameable years later.
        expect(prov!.upstreamSha).toMatch(/^[0-9a-f]{40}$/);
      });

      it("names WHERE inside the tag each file came from, and the file agrees", () => {
        if (prov === null) return; // reported by the test above
        // Checkable WITHOUT a checkout: the vendoring script writes the same path
        // into the file's own header, so the record and the bytes must corroborate
        // each other. A record that no one cross-checks is a comment.
        const wrong: string[] = [];
        for (const [file, hashes] of Object.entries(prov.files)) {
          if (!/^packages\/gateway-protocol\/src\/.+\.ts$/.test(hashes.upstreamPath ?? "")) {
            wrong.push(`${file}: implausible upstreamPath ${hashes.upstreamPath}`);
            continue;
          }
          if (!hashes.upstreamPath.endsWith(`/${file}`)) {
            wrong.push(`${file}: upstreamPath ${hashes.upstreamPath} names another file`);
            continue;
          }
          const header = readFileSync(
            new URL(`${version}/${file}`, PROTOCOL),
            "utf-8",
          ).slice(0, 400);
          if (!header.includes(hashes.upstreamPath)) {
            wrong.push(`${file}: header does not cite ${hashes.upstreamPath}`);
          }
        }
        expect(wrong, wrong.join("\n")).toEqual([]);
      });

      it("every recorded file still hashes to its recorded sha256", () => {
        if (prov === null) return; // reported by the test above
        const mismatched: string[] = [];
        for (const [file, hashes] of Object.entries(prov.files)) {
          const actual = sha256(
            readFileSync(new URL(`${version}/${file}`, PROTOCOL), "utf-8"),
          );
          if (actual !== hashes.vendored) mismatched.push(file);
        }
        expect(
          mismatched,
          `hand-edited vendored file(s): ${mismatched.join(", ")} — the header says ` +
            `VERBATIM, so an edit makes the coverage manifest classify fields that ` +
            `upstream never had. Re-run the vendoring script instead.`,
        ).toEqual([]);
      });

      it("EVERY vendored body reconstructs the upstream bytes it claims", () => {
        // The check that survives a determined editor. The `vendored` hash above is
        // SELF-ATTESTED: change a schema, change the hash, everything stays green
        // (raised in review). This one strips our header, undoes the recorded import
        // rewrites, and compares against `upstream` — the sha256 of a PUBLIC tag's
        // file, which anyone can recompute from openclaw/openclaw. Covering an edit
        // now means publishing a falsifiable claim about someone else's repository
        // instead of adjusting a private bookkeeping number.
        if (prov === null) return;
        const wrong: string[] = [];
        for (const [file, hashes] of Object.entries(prov.files)) {
          const text = readFileSync(
            new URL(`${version}/${file}`, PROTOCOL),
            "utf-8",
          );
          const lines = stripHeader(text).split("\n");
          for (const r of hashes.rewrites) lines[r.line] = r.upstream;
          if (sha256(lines.join("\n")) !== hashes.upstream) wrong.push(file);
        }
        expect(
          wrong,
          `vendored body does not reconstruct the upstream bytes for: ${wrong.join(", ")}`,
        ).toEqual([]);
      });

      it("each recorded rewrite IS the documented import substitution", () => {
        // The header promises the sole change is rebasing `../x/y.js` imports. The
        // first version of this test accepted any line starting with `export` or `}`
        // as an "import rewrite" (raised in review) — so a code change on such a
        // line, recorded as a rewrite with the hashes updated, survived even the
        // real-bytes comparison, since reconstruction restored the upstream text.
        //
        // Now the substitution itself is applied: rewriting the recorded upstream
        // line must yield EXACTLY the line sitting in the vendored file. Any other
        // edit fails, whatever the hashes say.
        if (prov === null) return;
        const REWRITE = /from "\.\.?\/(?:[^"]*\/)?([^/"]+\.js)"/g;
        const suspicious: string[] = [];
        for (const [file, hashes] of Object.entries(prov.files)) {
          if (hashes.rewrites.length === 0) continue;
          const body = stripHeader(
            readFileSync(new URL(`${version}/${file}`, PROTOCOL), "utf-8"),
          ).split("\n");
          for (const r of hashes.rewrites) {
            const expected = r.upstream.replace(REWRITE, 'from "./$1"');
            if (expected === r.upstream) {
              suspicious.push(`${file}:${r.line} not an import line: ${r.upstream.trim()}`);
              continue;
            }
            if (body[r.line] !== expected) {
              suspicious.push(
                `${file}:${r.line} the vendored line is not the rewritten upstream line`,
              );
            }
          }
        }
        expect(suspicious, suspicious.join("\n")).toEqual([]);
      });

      it("matches the real upstream bytes when a checkout is reachable", () => {
        if (prov === null) return;
        // The only true verification: read the tag's own files. Reachable locally (the
        // bench keeps shallow clones) and absent in CI — so it VERIFIES where it can
        // and states the gap where it cannot, rather than implying coverage it has
        // not got. `OPENCLAW_SRC_DIR` overrides the conventional cache location.
        const roots = [
          process.env.OPENCLAW_SRC_DIR,
          `${process.env.HOME}/java/workspace_idea/openclaw-notes/atrium/upstream-src/openclaw-${version}`,
        ].filter((r): r is string => typeof r === "string" && r.length > 0);
        const root = roots.find((r) =>
          existsSync(`${r}/packages/gateway-protocol/src`),
        );
        if (root === undefined) {
          console.warn(
            `[vendor-integrity] ${version}: upstream bytes UNVERIFIED — no checkout ` +
              `found. The recorded hashes are self-attested here; set ` +
              `OPENCLAW_SRC_DIR to a v${version} checkout to verify them.`,
          );
          return;
        }
        const wrong: string[] = [];
        for (const [file, hashes] of Object.entries(prov.files)) {
          // The RECORDED path, not a guess between two candidates. Guessing verified
          // whichever file happened to exist: had a schema module ever appeared at
          // both locations, or moved between them across tags, the check would have
          // gone green against the wrong bytes while claiming the right ones.
          const declared = hashes.upstreamPath;
          if (typeof declared !== "string" || declared.length === 0) {
            wrong.push(`${file} (provenance records no upstream path)`);
            continue;
          }
          const found = `${root}/${declared}`;
          if (!existsSync(found)) {
            wrong.push(`${file} (absent upstream at ${declared})`);
            continue;
          }
          if (sha256(readFileSync(found, "utf-8")) !== hashes.upstream) {
            wrong.push(file);
          }
        }
        expect(
          wrong,
          `the recorded upstream hash does not match v${version}'s real bytes for: ` +
            `${wrong.join(", ")}`,
        ).toEqual([]);
      });

      it("attributes every DERIVED artifact to the upstream file it was read from", () => {
        if (prov === null) return;
        const derived = prov.derived ?? {};
        // Present at all: the artifact exists on disk, so the record must exist too — an
        // unattributed derived file is the same hole as an unrecorded copied one.
        const onDisk = readdirSync(new URL(`${version}/`, PROTOCOL)).filter(
          // BENCH.json is an ATTESTATION of a live run, not an artifact derived from
          // upstream source: `bench-attestation.test.ts` owns it, and it is checked
          // there against a re-hash of this very directory. Excluded here so the two
          // ratchets stay about different things.
          (f) =>
            f.endsWith(".json") && f !== "PROVENANCE.json" && f !== "BENCH.json",
        );
        expect(Object.keys(derived).sort(), "derived artifacts vs the record").toEqual(
          onDisk.sort(),
        );
        for (const [name, rec] of Object.entries(derived)) {
          // A repo-root path, NOT under packages/gateway-protocol: this one is derived
          // from gateway implementation, which is exactly why it is derived and not copied.
          expect(rec.upstreamPath, name).toMatch(/^src\/.+\.ts$/);
          expect(rec.upstream, name).toMatch(/^[0-9a-f]{64}$/);
          // The count key names WHAT was derived (`fields` of a return shape, `events` of
          // a catalogue). Exactly one must be present: reading a fixed key meant a second
          // artifact silently compared `undefined` and the whole assertion evaporated.
          const body = JSON.parse(
            readFileSync(new URL(`${version}/${name}`, PROTOCOL), "utf-8"),
          ) as Record<string, unknown>;
          const countKeys = (["fields", "events"] as const).filter(
            (k) => typeof rec[k] === "number",
          );
          expect(countKeys, `${name}: exactly one count key expected`).toHaveLength(1);
          const key = countKeys[0] as "fields" | "events";
          expect(rec[key], `${name} derived an empty list`).toBeGreaterThan(0);
          // The artifact must AGREE with its record, so a hand-edited list is caught
          // without needing a checkout.
          expect(body.derivedFrom, name).toBe(rec.upstreamPath);
          expect(body.derivedFromSha256, name).toBe(rec.upstream);
          expect((body[key] as unknown[] | undefined)?.length, name).toBe(rec[key]);
        }
      });

      it("verifies a DERIVED artifact against the real upstream file when reachable", () => {
        if (prov === null) return;
        const roots = [
          process.env.OPENCLAW_SRC_DIR,
          `${process.env.HOME}/java/workspace_idea/openclaw-notes/atrium/upstream-src/openclaw-${version}`,
        ].filter((r): r is string => typeof r === "string" && r.length > 0);
        const root = roots.find((r) => existsSync(`${r}/package.json`));
        if (root === undefined) {
          console.warn(
            `[vendor-integrity] ${version}: derived artifacts UNVERIFIED — no checkout.`,
          );
          return;
        }
        const wrong: string[] = [];
        for (const [name, rec] of Object.entries(prov.derived ?? {})) {
          const at = `${root}/${rec.upstreamPath}`;
          if (!existsSync(at)) {
            wrong.push(`${name}: ${rec.upstreamPath} absent upstream`);
            continue;
          }
          const raw = readFileSync(at, "utf-8");
          if (sha256(raw) !== rec.upstream) {
            wrong.push(`${name}: source sha mismatch`);
            continue;
          }
          // RE-DERIVE and compare the LIST, not the count.
          //
          // Checking the field COUNT was the hole: replacing every name with another name
          // and aligning KNOWN_AGENT_FIELDS to match stayed green — which is exactly the
          // hand-built list this whole lot exists to abolish, restored under a passing
          // gate. The only honest check is to run the derivation again and compare.
          const body = JSON.parse(
            readFileSync(new URL(`${version}/${name}`, PROTOCOL), "utf-8"),
          ) as { fields?: string[]; events?: string[] };
          // Dispatch on the ARTIFACT, never one hardcoded deriver. There are two derived
          // artifacts now and they read different upstream modules; running the snapshot
          // deriver over the event catalogue reported "buildSessionEventSnapshot not
          // found", which reads as an upstream rename and is nothing of the sort. An
          // artifact this test does not know how to re-derive must FAIL here rather than
          // be skipped, or adding a third one would silently opt out of verification.
          let rederived: string[];
          let stored: string[];
          if (name === "session-event-snapshot.json") {
            rederived = (deriveSnapshotFields as (s: string) => string[])(raw);
            stored = body.fields ?? [];
          } else if (name === "event-catalogue.json") {
            const constantsAt = `${root}/${rec.constantsPath ?? ""}`;
            if (rec.constantsPath === undefined || !existsSync(constantsAt)) {
              wrong.push(`${name}: constants source absent upstream`);
              continue;
            }
            const constRaw = readFileSync(constantsAt, "utf-8");
            if (sha256(constRaw) !== rec.constants) {
              wrong.push(`${name}: constants sha mismatch`);
              continue;
            }
            rederived = (
              deriveEventCatalogue as (r: string, c: string) => string[]
            )(raw, constRaw);
            stored = body.events ?? [];
          } else {
            wrong.push(`${name}: no re-derivation is wired for this artifact`);
            continue;
          }
          if (JSON.stringify(rederived) !== JSON.stringify(stored)) {
            wrong.push(
              `${name}: the stored list is not what the derivation produces ` +
                `(+${rederived.filter((f) => !stored.includes(f)).join(",")} ` +
                `-${stored.filter((f) => !rederived.includes(f)).join(",")})`,
            );
          }
        }
        expect(
          wrong,
          `a derived artifact does not match v${version}'s real source: ${wrong.join(", ")}`,
        ).toEqual([]);
      });

      it("records every schema file present in the directory", () => {
        if (prov === null) return;
        const onDisk = readdirSync(new URL(`${version}/`, PROTOCOL))
          .filter((f) => f.endsWith(".ts"))
          .sort();
        // An UNRECORDED file is the same hole from the other side: it would be
        // walked by the ratchet while nothing vouches for its contents.
        expect(Object.keys(prov.files).sort()).toEqual(onDisk);
      });
    });
  }
});
