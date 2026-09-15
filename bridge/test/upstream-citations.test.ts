/**
 * Every `file:line` citation of the upstream interpretation document and of the upstream
 * frames fixture points at code that shows what the citation claims (defect 12).
 *
 * `docs/UPSTREAM_INTERPRETATION.md` cites upstream OpenClaw source by `file:line`, and so do
 * the scenario descriptions of `fixtures/openclaw_upstream_frames.json`. Upstream line numbers
 * move with every release: a review of 2026-09-12 found about thirty citations pointing at
 * unrelated code, and nothing failed, because nothing read them — `upstream-frames.test.ts`
 * replays the frames and never opens a `description`. A stale anchor is worse than none: a
 * contract change can be "verified" against lines that have nothing to do with it.
 *
 * THE RECORD. `protocol/openclaw/citations.json` holds one entry per citation: the full path,
 * the line ranges, and one LITERAL PER RANGE — a verbatim fragment of the cited code that
 * embodies the claim, chosen by reading it. Everything that selects what verifies an entry is
 * taken from the TEXT or from the tag itself, never from the record alone: the ranges are the
 * ones written; the repository is this one only for a citation written from `bridge/`,
 * upstream otherwise; the tag is the fixture's `upstream_tag`, or the document's reference tag
 * unless the citation's own line dates it; and the FILE is the only one of the tag's tree the
 * written path resolves to. A record that can choose its own verifier verifies nothing (codex,
 * three times: the tag, the repository, then a `../` path read from another checkout).
 *
 * WHAT RUNS WHERE — the pattern `vendor-integrity.test.ts` decided and documents:
 *  - always (CI included): coverage of both texts, the record's agreement with them, and the
 *    citations of Atrium's own code, read in this repository;
 *  - when the bench's checkout of a cited tag is reachable: its tag must be the commit the
 *    vendored `PROVENANCE.json` records, and the citations are resolved in THAT commit's tree
 *    and read through git objects, never the worktree (which an uncommitted edit changes
 *    without moving the tag). Without it the test says the citations are unverified instead of
 *    reporting a verification it has not done.
 *
 * THE LIMIT, stated: a literal proves its range contains that fragment, chosen by a reader to
 * embody the claim. It does not prove the prose around it is right, and a range wider than the
 * claim still passes as long as it contains the fragment.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../", import.meta.url).pathname;
const DOC = "docs/UPSTREAM_INTERPRETATION.md";
const FIXTURE = "bridge/test/fixtures/openclaw_upstream_frames.json";
const RECORD = "bridge/protocol/openclaw/citations.json";

interface Citation {
  source: string;
  cite: string;
  /** "atrium" exactly when the citation is written from `bridge/`, "upstream" otherwise. */
  repo: "upstream" | "atrium";
  /** The upstream tag the TEXT reads it at; null for Atrium code. */
  tag: string | null;
  path: string;
  lines: [number, number][];
  /** One per range, in the same order. */
  literals: string[];
}

/** A citation as written: an optional `$UP/` prefix, a source file, a line or range, and any
 *  further comma-separated lines or ranges of the same file. */
const CITE = /(?:\$UP\/)?([A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;

function parseRanges(spec: string): [number, number][] {
  return spec.split(",").map((part) => {
    const [a, b] = part.split("-").map(Number);
    return [a!, b ?? a!];
  });
}

const citedFile = (cite: string): string => [...cite.matchAll(CITE)][0]![1]!;

const readDoc = () => readFileSync(`${REPO}${DOC}`, "utf8");
const readFixture = () =>
  JSON.parse(readFileSync(`${REPO}${FIXTURE}`, "utf8")) as {
    upstream_tag: string;
    scenarios: Record<string, { description: string }>;
  };

/** Every citation of both texts, with the text it was read from. */
function citationsInTexts(): { source: string; cite: string }[] {
  const found: { source: string; cite: string }[] = [];
  const scan = (source: string, text: string) => {
    for (const m of text.matchAll(CITE)) found.push({ source, cite: m[0] });
  };
  scan(DOC, readDoc());
  for (const scenario of Object.values(readFixture().scenarios)) scan(FIXTURE, scenario.description);
  return found;
}

const record = JSON.parse(readFileSync(`${REPO}${RECORD}`, "utf8")) as { citations: Citation[] };
const key = (source: string, cite: string) => `${source} :: ${cite}`;

const git = (dir: string, args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }).toString();

/** The tree of `tag`, from the bench's checkout, authenticated against the commit the vendored
 *  PROVENANCE.json records for that version — or why it cannot be. */
function tagTree(tag: string): { root: string; sha: string; files: string[] } | { unverified: string } {
  const parent =
    process.env.OPENCLAW_UPSTREAM_SRC_ROOT ??
    `${process.env.HOME}/java/workspace_idea/openclaw-notes/atrium/upstream-src`;
  const root = `${parent}/openclaw-${tag}`;
  const provenance = `${REPO}bridge/protocol/openclaw/${tag}/PROVENANCE.json`;
  if (!existsSync(provenance)) return { unverified: `no vendored PROVENANCE.json records the commit of v${tag}` };
  const recorded = (JSON.parse(readFileSync(provenance, "utf8")) as { upstreamSha?: string }).upstreamSha;
  if (!existsSync(`${root}/.git`)) return { unverified: `no git checkout at ${root}` };
  let sha: string;
  try {
    sha = git(root, ["rev-parse", "--verify", `v${tag}^{commit}`]).trim();
  } catch {
    return { unverified: `${root} has no tag v${tag}` };
  }
  if (sha !== recorded) {
    return { unverified: `v${tag} in ${root} is ${sha}, not the commit PROVENANCE.json records (${recorded})` };
  }
  return { root, sha, files: git(root, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean) };
}

/** Why an entry's literals are not where it says, read from `text`; null when they are. */
function literalProblem(entry: Citation, text: string): string | null {
  const lines = text.split("\n");
  const wrong: string[] = [];
  entry.lines.forEach(([a, b], i) => {
    if (a < 1 || b > lines.length) {
      wrong.push(`range ${a}-${b} outside the file (${lines.length} lines)`);
      return;
    }
    // EACH range holds ITS literal: a literal found in one range said nothing about the
    // others, and a citation of three ranges ratcheted only one of them (codex).
    if (!lines.slice(a - 1, b).join("\n").includes(entry.literals[i]!)) {
      wrong.push(`literal ${JSON.stringify(entry.literals[i])} is not inside ${a}-${b}`);
    }
  });
  return wrong.length === 0 ? null : wrong.join("; ");
}

describe("upstream citations are recorded, and the record matches the texts", () => {
  it("every citation of the document and of the fixture descriptions is recorded", () => {
    const recorded = new Set(record.citations.map((c) => key(c.source, c.cite)));
    const unrecorded = [...new Set(citationsInTexts().map((c) => key(c.source, c.cite)))].filter((k) => !recorded.has(k));
    expect(unrecorded, "cited in a text but absent from citations.json").toEqual([]);
  });

  it("no citation is written without its file name", () => {
    // `used at :258` named no file, and two such shorthands of the announce section meant a
    // DIFFERENT file than the one cited just before them — nothing can check a line number
    // whose file is only implied. The pattern skips a colon that follows a word, a path or a
    // digit (`file.ts:12`, `seq:3`, `12:30`), so what is left is a bare line reference.
    const bare = /(?<![A-Za-z0-9_.\/$-]):\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*(?![A-Za-z0-9_])/g;
    const found: string[] = [];
    const scan = (source: string, text: string) => {
      for (const m of text.matchAll(bare)) {
        if (/\d$/.test(text.slice(0, m.index))) continue;
        found.push(`${source}: …${text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length)}`);
      }
    };
    scan(DOC, readDoc());
    for (const [id, scenario] of Object.entries(readFixture().scenarios)) scan(`${FIXTURE} ${id}`, scenario.description);
    expect(found).toEqual([]);
  });

  it("nothing is recorded that its text no longer cites, and nothing twice", () => {
    const cited = new Set(citationsInTexts().map((c) => key(c.source, c.cite)));
    const keys = record.citations.map((c) => key(c.source, c.cite));
    expect(keys.filter((k) => !cited.has(k)), "recorded but no longer in its text").toEqual([]);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), "recorded twice").toEqual([]);
  });

  it("every entry is well formed, and its path, ranges and literals are the citation's own", () => {
    const wrong: string[] = [];
    for (const c of record.citations) {
      const m = [...c.cite.matchAll(CITE)][0];
      if (m === undefined || m[0] !== c.cite) {
        wrong.push(`${c.cite}: not a single citation`);
        continue;
      }
      // A path is a plain repository path: a `..` segment walked out of the checkout into
      // another version's copy of the same file (codex).
      if (c.path.startsWith("/") || c.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
        wrong.push(`${c.cite}: path ${c.path} is not a plain repository path`);
      }
      if (!(c.path === m[1] || (!m[1]!.startsWith("bridge/") && c.path.endsWith(`/${m[1]}`)))) {
        wrong.push(`${c.cite}: path ${c.path} is not the cited file`);
      }
      if (JSON.stringify(c.lines) !== JSON.stringify(parseRanges(m[2]!))) {
        wrong.push(`${c.cite}: recorded lines ${JSON.stringify(c.lines)} are not the lines the text shows`);
      }
      if (c.lines.some(([a, b]) => !(a >= 1 && b >= a))) wrong.push(`${c.cite}: malformed range`);
      if (!Array.isArray(c.literals) || c.literals.length !== c.lines.length) {
        wrong.push(`${c.cite}: needs exactly one literal per range`);
      } else if (c.literals.some((l) => typeof l !== "string" || l.length < 6)) {
        wrong.push(`${c.cite}: a literal too short to mean anything`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("each citation is verified where its TEXT says — repository and tag — never where the record chose", () => {
    // A tag only the record stated selected the checkout that verified it: set to a tag with
    // no checkout, the citation went UNVERIFIED and everything stayed green. A repository only
    // the record stated did the same: an unprefixed upstream citation recorded as Atrium code
    // was read in a vendored copy of another version (codex). Both now come from the texts.
    const bareTag = (tag: string) => tag.replace(/^v/, "");
    const doc = readDoc();
    const reference = doc.match(/Reference source: `github\.com\/openclaw\/openclaw` at tag \*\*`(v[0-9][^`]*)`\*\*/);
    expect(reference, "the document no longer states its reference tag").not.toBeNull();
    const fixture = readFixture();
    const byKey = new Map(record.citations.map((c) => [key(c.source, c.cite), c]));
    const wrong: string[] = [];
    const expectAt = (source: string, text: string, tag: string) => {
      for (const m of text.matchAll(CITE)) {
        const entry = byKey.get(key(source, m[0]));
        if (entry === undefined) continue; // reported by the coverage test
        const atrium = m[1]!.startsWith("bridge/") && !m[0].startsWith("$UP/");
        if (atrium && source !== DOC) wrong.push(`${source} ${m[0]}: the fixture cites upstream code only`);
        const repo = atrium ? "atrium" : "upstream";
        if (entry.repo !== repo) wrong.push(`${source} ${m[0]}: recorded as ${entry.repo}, the text makes it ${repo}`);
        const expected = atrium ? null : tag;
        if (entry.tag !== expected) wrong.push(`${source} ${m[0]}: recorded at ${entry.tag}, the text reads it at ${expected}`);
      }
    };
    for (const line of doc.split("\n")) {
      const dated = line.match(/\bat v(\d{4}\.\d+\.\d+)\b/);
      expectAt(DOC, line, dated ? dated[1]! : bareTag(reference![1]!));
    }
    for (const scenario of Object.values(fixture.scenarios)) {
      expectAt(FIXTURE, scenario.description, bareTag(fixture.upstream_tag));
    }
    expect(wrong).toEqual([]);
  });

  it("citations of Atrium's own code show their literals in this repository", () => {
    const wrong: string[] = [];
    for (const c of record.citations.filter((e) => e.repo === "atrium")) {
      const file = `${REPO}${c.path}`;
      if (!existsSync(file)) {
        wrong.push(`${c.cite}: ${c.path} does not exist`);
        continue;
      }
      const problem = literalProblem(c, readFileSync(file, "utf8"));
      if (problem !== null) wrong.push(`${c.cite}: ${problem}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("upstream citations show their literals at their tag", () => {
  const tags = [...new Set(record.citations.filter((c) => c.repo === "upstream").map((c) => c.tag!))].sort();
  for (const tag of tags) {
    it(`v${tag}: each citation resolves to exactly one file of the tag's tree, and every range holds its literal`, () => {
      const tree = tagTree(tag);
      if ("unverified" in tree) {
        console.warn(
          `[upstream-citations] v${tag}: citations UNVERIFIED — ${tree.unverified}. ` +
            `Set OPENCLAW_UPSTREAM_SRC_ROOT to a directory holding openclaw-${tag}/ to verify them.`,
        );
        return;
      }
      const wrong: string[] = [];
      for (const c of record.citations.filter((e) => e.repo === "upstream" && e.tag === tag)) {
        // The FILE comes from the tag's tree and the written path, not from the record: a
        // bare name several files share must be spelled out in the text until it is unique.
        const cited = citedFile(c.cite);
        const matches = tree.files.filter((f) => f === cited || f.endsWith(`/${cited}`));
        if (matches.length !== 1) {
          wrong.push(`${c.source} ${c.cite}: resolves to ${matches.length} files at v${tag} — spell the path out`);
          continue;
        }
        if (matches[0] !== c.path) {
          wrong.push(`${c.source} ${c.cite}: recorded path ${c.path} is not the file it resolves to (${matches[0]})`);
          continue;
        }
        const problem = literalProblem(c, git(tree.root, ["show", `${tree.sha}:${c.path}`]));
        if (problem !== null) wrong.push(`${c.source} ${c.cite}: ${problem}`);
      }
      expect(wrong).toEqual([]);
    });
  }
});
