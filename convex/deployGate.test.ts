/// <reference types="vite/client" />
//
// THE GATE THAT WAS MISSING (W10 — refuser d'échouer ouvert).
//
// `convex dev` and `npx convex deploy` typecheck `convex/**` with
// `convex/tsconfig.json` — a DIFFERENT project from the root one, and one that
// INCLUDES the test files. On 2026-07-26 a single excess-property error in
// `convex/authDomains.test.ts` blocked every push for days: `convex dev` refused to
// deploy, the local backend served code from before the error, a live bench reported
// GO against it, and `npm run typecheck` + `vitest` were both green throughout. The
// same error would have failed a production `convex deploy`.
//
// Two of the three failures were silent because nothing ASSERTED the gate. These
// tests assert it — remove the gate and they go red, which is the only way a gate
// stops being able to disappear quietly.
//
// Deliberately assertions on the CONFIG FILES, not a spawned compiler: running tsc
// from a test would double every suite's cost, and CI already runs it. What can rot
// is the wiring, and that is what is pinned here.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf-8");

describe("the Convex typecheck is wired as a gate", () => {
  test("`npm run typecheck` also checks the convex project", () => {
    // The local gate. Its absence is why the error was invisible to me for days:
    // I ran the root typecheck before every commit and it never looked at
    // convex/tsconfig.json.
    const pkg = JSON.parse(read("../package.json")) as {
      scripts: Record<string, string>;
    };
    // The command must BE tsc, not merely mention it: `echo tsc --noEmit -p convex`
    // and `true # tsc --noEmit -p convex` both satisfy a substring check and run no
    // compiler at all (raised in review).
    expect(pkg.scripts["typecheck:convex"]).toMatch(
      /^tsc\s+--noEmit\s+-p\s+convex\s*$/,
    );
    // The storage collector (deploy/gc) is its own project, checked the same way.
    expect(pkg.scripts["typecheck:gc"]).toMatch(/^tsc\s+--noEmit\s+-p\s+deploy\/gc\s*$/);
    // The EXACT chain, not a substring: `… && if false; then npm run typecheck:convex;
    // fi` mentions the script and never runs it (raised in review). Four commands is
    // short enough to pin literally, and this one's shape is the gate.
    expect(pkg.scripts.typecheck).toBe(
      "npm run paraglide:compile && tsc --noEmit && npm run typecheck:convex && npm run typecheck:gc",
    );
  });

  test("neither script SWALLOWS the failure", () => {
    // Substring assertions alone would accept `tsc --noEmit -p convex || true`
    // (raised in review): the gate would be present, named, and completely inert —
    // the most expensive kind of wrong, because it looks done.
    const pkg = JSON.parse(read("../package.json")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["typecheck", "typecheck:convex", "typecheck:gc"]) {
      const script = pkg.scripts[name] ?? "";
      expect(script, name).not.toMatch(/\|\||;\s*(true|exit\s+0)|--?force/);
    }
  });

  test("CI runs it as its own named step, with nothing appended", () => {
    // A named step so the failure reads "the deploy is broken", not "typecheck
    // failed somewhere" — and the `run:` line must be the command ALONE, or the same
    // swallowing trick moves from package.json into the workflow.
    const ci = read("../.github/workflows/ci.yml");
    const runLine = ci
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("run:") && l.includes("typecheck:convex"));
    expect(runLine, "no CI step runs npm run typecheck:convex").toBeDefined();
    expect(runLine).toBe("run: npm run typecheck:convex");
    // `continue-on-error` would neutralize the step from the outside; so would an
    // `if:` on the step or the job (`if: ${{ false }}`). The workflow uses neither
    // today, so the honest pin is "none at all" — a future legitimate conditional
    // then has to be added deliberately, with this test as the place that says why.
    expect(ci).not.toMatch(/continue-on-error/);
    expect(ci).not.toMatch(/^\s*if:/m);
  });

  test("CI is not skipped by paths-ignore for convex/ or the workflow itself", () => {
    // `paths-ignore` on both triggers means a PR touching only ignored paths runs NO
    // CI. A gate that a whole class of PR can bypass is not a gate.
    //
    // Reads the WHOLE trigger block rather than inline `[...]` lists: a block-style
    // `paths-ignore:` with `- convex/**` underneath satisfied the inline regex while
    // excluding exactly the directory this gate protects (raised in review).
    const ci = read("../.github/workflows/ci.yml");
    const start = ci.indexOf("\non:");
    const end = ci.indexOf("\njobs:");
    expect(start, "no `on:` block").toBeGreaterThan(-1);
    expect(end, "no `jobs:` block").toBeGreaterThan(start);
    const triggers = ci.slice(start, end);
    expect(triggers).toContain("paths-ignore");
    // Nothing in the trigger block may mention the two paths that must always run CI.
    expect(triggers).not.toContain("convex");
    expect(triggers).not.toContain(".github");
  });
});

describe("the convex project is checked as Convex itself checks it", () => {
  test("its tests are INCLUDED, exactly as `convex deploy` includes them", () => {
    // The trap's root cause: `include: ["./**/*"]` pulls test files into the deploy
    // typecheck. Excluding them here would make this gate pass while the real deploy
    // still failed — the gate must check what the deploy checks, not less.
    const tsconfig = read("./tsconfig.json");
    expect(tsconfig).toContain('"include": ["./**/*"]');
    expect(tsconfig).not.toMatch(/"exclude":\s*\[[^\]]*test/);
  });

  test("its `lib` is the one Convex's own template declares for its runtime", () => {
    // A fact with teeth, re-pinned (codex review 12). It was ES2021 — narrower than the
    // root's ES2023 — so built-ins the app used freely (`Array.prototype.at`) did not
    // exist for the deploy compiler. The Convex CLI in
    // use declares ES2023 "required by Convex" for its functions
    // (node_modules/convex/dist/esm/cli/codegen_templates/tsconfig.js). The project now
    // says what its runtime has — no wider: a lib past the template's would let the
    // deploy compiler accept what the runtime may lack.
    const libOf = (text: string): string => /"lib":\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "";
    const year = (s: string): number =>
      Math.max(0, ...[...s.matchAll(/ES(\d{4})/gi)].map((m) => Number(m[1])));
    const convexLib = libOf(read("./tsconfig.json"));
    const template = libOf(read("../node_modules/convex/dist/esm/cli/codegen_templates/tsconfig.js"));
    expect(year(template)).toBeGreaterThan(0);
    expect(year(convexLib)).toBe(year(template));
    expect(year(convexLib)).toBeLessThanOrEqual(year(libOf(read("../tsconfig.json"))));
  });
});

describe("every file under convex/ is a valid Convex module path", () => {
  test("no path component holds a character the deploy refuses (a hyphen, above all)", () => {
    // `convex dev` refused the whole push on 2026-10-17: a vendored
    // `lib/upstreamRedact/src/logging/redact-patterns.js` "is not a valid path to a Convex
    // module. Path component redact-patterns.js can only contain alphanumeric characters,
    // underscores, or periods" — while typecheck and every test were green.
    const root = new URL("./", import.meta.url).pathname;
    const bad: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "_generated" || e.name === "node_modules" || e.name.startsWith(".")) continue;
        const path = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(`${dir}/${e.name}`, path);
        else if (/\.(ts|js)$/.test(e.name) && !/^[A-Za-z0-9_.]+$/.test(e.name)) bad.push(path);
        if (e.isDirectory() && !/^[A-Za-z0-9_.]+$/.test(e.name)) bad.push(`${path}/`);
      }
    };
    walk(root, "");
    expect(bad).toEqual([]);
  });
});
