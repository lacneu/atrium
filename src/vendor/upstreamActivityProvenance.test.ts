// @vitest-environment node
//
// The Control UI's tool-call nesting (src/chat/tool-call-grouping.ts `groupToolCalls`) is
// vendored WITH its upstream test into src/vendor/upstream-activity (the SPA's activity block,
// src/chat/InlineTurnActivity.tsx). The vendored test runs as part of this suite; this file
// pins the bytes:
//   - every file's bytes are the ones PROVENANCE.json records (a hand edit fails here;
//     `node scripts/vendor-upstream-activity.mjs --tag <tag> --src <checkout>` is the only
//     way to change one), and nothing else is in the tree;
//   - when an upstream checkout is reachable, each recorded `upstream` hash is the hash of
//     that file at the recorded commit. Without one, the test says so instead of claiming it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const TREE = path.join(REPO, "src/vendor/upstream-activity");
const UPSTREAM = process.env.OPENCLAW_UPSTREAM_SRC ?? `${process.env.HOME}/java/workspace_idea/openclaw-upstream`;

type Provenance = {
  upstreamTag: string;
  upstreamSha: string;
  files: Record<string, { upstreamPath: string; upstream: string; vendored: string }>;
};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

describe("vendored upstream tool-call nesting", () => {
  const prov = JSON.parse(readFileSync(path.join(TREE, "PROVENANCE.json"), "utf8")) as Provenance;

  it("matches PROVENANCE.json for every file, and lists nothing that is not there", () => {
    const onDisk = walk(TREE).filter((f) => f !== "PROVENANCE.json").sort();
    expect(Object.keys(prov.files).sort()).toEqual(onDisk);
    for (const [file, rec] of Object.entries(prov.files)) {
      expect(sha(readFileSync(path.join(TREE, file))), file).toBe(rec.vendored);
    }
  });

  it("vendors the module and its upstream test, unchanged", () => {
    for (const rec of Object.values(prov.files)) expect(rec.vendored).toBe(rec.upstream);
    expect(Object.keys(prov.files).sort()).toEqual(["src/chat/tool-call-grouping.test.ts", "src/chat/tool-call-grouping.ts"]);
  });

  it("records upstream hashes that are the upstream files at the recorded commit", ({ skip }) => {
    if (!existsSync(path.join(UPSTREAM, ".git"))) {
      console.warn(`upstream checkout not found at ${UPSTREAM}: upstream hashes UNVERIFIED`);
      skip();
    }
    const tagSha = execFileSync("git", ["-C", UPSTREAM, "rev-parse", `${prov.upstreamTag}^{commit}`]).toString().trim();
    expect(tagSha).toBe(prov.upstreamSha);
    for (const [file, rec] of Object.entries(prov.files)) {
      const bytes = execFileSync("git", ["-C", UPSTREAM, "show", `${prov.upstreamSha}:${rec.upstreamPath}`]);
      expect(sha(bytes), file).toBe(rec.upstream);
    }
  });
});
