// @vitest-environment node
//
// The tool-payload redaction is upstream's, vendored into TWO runtimes (codex review 12):
// the bridge masks on write (bridge/src/vendor/upstream-redact), Convex masks again at
// ingest and on read (convex/lib/upstreamRedact). Two copies that drift would make a
// card's masking depend on which writer stored it, so:
//   - both trees hold exactly the same files with exactly the same bytes;
//   - every file's bytes are the ones PROVENANCE.json records (a hand edit fails here;
//     `node scripts/vendor-upstream-redact.mjs --tag <tag> --src <checkout>` is the only
//     way to change one);
//   - when an upstream checkout is reachable, each recorded `upstream` hash is the hash of
//     that file at the recorded commit, read through git objects. Without one, the test
//     says the upstream side is unverified instead of claiming it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const TREES = ["bridge/src/vendor/upstream-redact", "convex/lib/upstreamRedact"];
const UPSTREAM = process.env.OPENCLAW_UPSTREAM_SRC ?? `${process.env.HOME}/java/workspace_idea/openclaw-upstream`;

type Provenance = {
  upstreamTag: string;
  upstreamSha: string;
  files: Record<string, { upstreamPath?: string; upstream?: string; vendored: string; stub?: boolean }>;
};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

describe("vendored upstream tool-payload redaction", () => {
  const [bridgeTree, convexTree] = TREES.map((t) => path.join(REPO, t));
  const prov = JSON.parse(readFileSync(path.join(convexTree, "PROVENANCE.json"), "utf8")) as Provenance;

  it("holds the same files, byte for byte, in the bridge and in Convex", () => {
    const a = walk(bridgeTree).sort();
    const b = walk(convexTree).sort();
    expect(a).toEqual(b);
    for (const f of a) {
      expect(sha(readFileSync(path.join(bridgeTree, f))), f).toBe(sha(readFileSync(path.join(convexTree, f))));
    }
  });

  it("matches PROVENANCE.json for every file, and lists nothing that is not there", () => {
    const onDisk = walk(convexTree).filter((f) => f !== "PROVENANCE.json").sort();
    expect(Object.keys(prov.files).sort()).toEqual(onDisk);
    for (const [file, rec] of Object.entries(prov.files)) {
      expect(sha(readFileSync(path.join(convexTree, file))), file).toBe(rec.vendored);
    }
  });

  it("records upstream hashes that are the upstream files at the recorded commit", ({ skip }) => {
    if (!existsSync(path.join(UPSTREAM, ".git"))) {
      console.warn(`upstream checkout not found at ${UPSTREAM}: upstream hashes UNVERIFIED`);
      skip();
    }
    const tagSha = execFileSync("git", ["-C", UPSTREAM, "rev-parse", `${prov.upstreamTag}^{commit}`]).toString().trim();
    expect(tagSha).toBe(prov.upstreamSha);
    for (const [file, rec] of Object.entries(prov.files)) {
      if (rec.stub === true) continue;
      const bytes = execFileSync("git", ["-C", UPSTREAM, "show", `${prov.upstreamSha}:${rec.upstreamPath}`]);
      expect(sha(bytes), file).toBe(rec.upstream);
    }
  });
});
