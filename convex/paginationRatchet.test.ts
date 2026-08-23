/// <reference types="vite/client" />
//
// ONE PAGINATED QUERY PER FUNCTION.
//
// Convex enforces this at RUNTIME and the test harness does not, so a paginated
// read inside a loop passes every unit test and then fails on the first real
// call. That is exactly how it happened: a composite cursor added to stop a
// silent truncation walked messages AND their parts, and the export threw for
// every conversation until a real backend was asked.
//
// Derived from the source, because the rule is about SHAPE — there is nothing to
// observe in a harness that does not implement it.

import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

/**
 * Every `.paginate()` that runs inside a loop.
 *
 * PARSED, not scanned. A line-based reader was wrong seven times over: wrapped
 * headers, `for await`, `do … while`, loops written without braces, a terminal
 * `while` re-arming the next ordinary block, sub-directories. Each patch bought
 * one shape and missed the next — which is what a guard must never do, because a
 * check that is quietly blind teaches everyone to trust it.
 *
 * The compiler already knows what a loop is. Asking it removes the whole class,
 * and costs no false positives on text that merely looks like one.
 */
export function paginatesInsideLoops(source: string): number[] {
  const file = ts.createSourceFile(
    "probe.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const offending: number[] = [];
  const isLoop = (node: ts.Node): boolean =>
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node);

  const walk = (node: ts.Node, insideLoop: boolean): void => {
    if (
      insideLoop &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "paginate"
    ) {
      offending.push(
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      );
    }
    ts.forEachChild(node, (child) => walk(child, insideLoop || isLoop(node)));
  };
  walk(file, false);
  return offending.sort((a, b) => a - b);
}

/** Convex function declarations, and the body of each. */
function handlers(source: string): { name: string; body: string }[] {
  const starts = [
    ...source.matchAll(
      /export const ([A-Za-z0-9_]+) = (?:internal)?(?:query|mutation|action)\(/g,
    ),
  ];
  return starts.map((match, index) => ({
    name: match[1]!,
    body: source.slice(
      match.index!,
      index + 1 < starts.length ? starts[index + 1]!.index! : source.length,
    ),
  }));
}

function convexSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  // RECURSIVE. A function added under a sub-directory was never examined, so a
  // loop around a paginated read there would have left this green — exactly the
  // violation it exists to catch, in the place nobody thinks to look.
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "_generated" || entry.name === "node_modules") {
          continue;
        }
        walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push({
        file: `${prefix}${entry.name}`,
        source: readFileSync(new URL(entry.name, dir), "utf8"),
      });
    }
  };
  walk(new URL(".", import.meta.url), "");
  return out;
}

/**
 * Places that already do this, recorded rather than hidden.
 *
 * Both are real: each loops a paginated read and fails as soon as one page is
 * not enough. Neither is part of the change that introduced this check, and each
 * deserves its own fix and its own verification — so they are listed here, where
 * they cannot be forgotten, and no NEW one can appear beside them.
 *
 * anomalies.ts — the heartbeat's open-anomaly tally, up to HEARTBEAT_MAX_PAGES.
 * feedback.ts  — the report listing's scan, up to MAX_SCAN rows.
 *
 * The line is where the CALL begins — the start of the `ctx.db.query(…)` chain,
 * not the `.paginate(` further down it.
 */
const KNOWN_OFFENDERS: ReadonlyArray<string> = [
  "anomalies.ts:1638",
  "feedback.ts:922",
];

describe("Convex's one-paginated-query rule", () => {
  test("no NEW paginated query runs inside a loop", () => {
    const offenders: string[] = [];
    for (const { file, source } of convexSources()) {
      for (const at of paginatesInsideLoops(source)) {
        offenders.push(`${file}:${at}`);
      }
    }

    // SORTED. `readdirSync` gives no guaranteed order, so comparing an exact
    // sequence could fail on another filesystem with nothing having changed.
    expect([...offenders].sort()).toEqual([...KNOWN_OFFENDERS].sort());
  });

  test("every loop shape counts, whatever its punctuation", () => {
    // Each of these was a blind spot of the line-based reader it replaced.
    const wrapped = [
      "while (",
      "  a &&",
      "  b",
      ") {",
      "  await ctx.db.query('x').paginate({ cursor });",
      "}",
    ].join("\n");
    const forAwait =
      "for await (const row of stream) {\n  await q.paginate({ cursor });\n}";
    const doWhile =
      "do {\n  await q.paginate({ cursor });\n} while (!page.isDone);";
    const braceless = "for (let i = 0; i < 3; i++) await q.paginate({ cursor });";
    const inCondition =
      "while ((await q.paginate({ cursor })).isDone === false) {\n  n += 1;\n}";

    expect(paginatesInsideLoops(wrapped)).toEqual([5]);
    expect(paginatesInsideLoops(forAwait)).toEqual([2]);
    expect(paginatesInsideLoops(doWhile)).toEqual([2]);
    expect(paginatesInsideLoops(braceless)).toEqual([1]);
    expect(paginatesInsideLoops(inCondition)).toEqual([1]);
  });

  test("what is NOT a loop is not flagged", () => {
    // Two paginated reads in mutually exclusive branches are correct — only one
    // ever runs. And a terminal `while` must not turn the next ordinary block
    // into a loop: flagging either would teach everyone to ignore this check.
    const branches = [
      "if (section === 'a') {",
      "  await q.paginate({ cursor });",
      "} else {",
      "  await q.paginate({ cursor });",
      "}",
    ].join("\n");
    const afterDoWhile = [
      "do { n += 1; } while (n < 3);",
      "if (ready) {",
      "  await q.paginate({ cursor });",
      "}",
    ].join("\n");
    const lookalikes = [
      "// for (const x of y) { q.paginate({}) }",
      "const label = 'while (true) paginate';",
      "await q.paginate({ cursor });",
    ].join("\n");

    expect(paginatesInsideLoops(branches)).toEqual([]);
    expect(paginatesInsideLoops(afterDoWhile)).toEqual([]);
    expect(paginatesInsideLoops(lookalikes)).toEqual([]);
  });

  test("the baseline is a record, not a blindfold", () => {
    // A baseline that stopped matching the source would quietly excuse whatever
    // moved into its place. Each entry must still name a real paginated read
    // inside a loop.
    for (const entry of KNOWN_OFFENDERS) {
      const [file, line] = entry.split(":");
      const source = convexSources().find((s) => s.file === file);
      expect(source, `${file} no longer exists`).toBeDefined();
      expect(paginatesInsideLoops(source!.source)).toContain(Number(line));
    }
  });

  test("the scan reads real functions, not an empty list", () => {
    // A parse that silently found nothing would make the checks above pass for
    // ever — the failure mode of every derived test.
    const named = convexSources().flatMap(({ file, source }) =>
      handlers(source).map((handler) => `${file}:${handler.name}`),
    );

    // SUB-DIRECTORIES ARE READ. A scan that only saw the root would leave a loop
    // around a paginated read in `convex/<anything>/` unexamined.
    expect(
      convexSources().filter((entry) => entry.file.includes("/")).length,
    ).toBeGreaterThan(0);
    expect(named.length).toBeGreaterThan(50);
    expect(named).toContain("archiveExport.ts:exportChatSection");
  });
});
