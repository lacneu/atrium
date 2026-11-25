import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The root `tsc` program (tsconfig.json, `include: ["src"]`) follows a test's imports into
 * `bridge/src`. A bridge module that imports `ws` then needs `@types/ws`, which only the
 * bridge's own install provides: locally it is found next to the bridge, in CI (root install
 * only) it is not, and the release stops at the type check. A root file that reaches such a
 * module must be listed in tsconfig.json `exclude` (vitest still runs it).
 */

const ROOT = resolve(__dirname, "..");
const TS_EXTENSIONS = [".ts", ".tsx"];
const NODE_ONLY_MODULES = new Set(["ws"]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "paraglide") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else if (TS_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(path);
  }
  return out;
}

function importsOf(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((ref) => ref.fileName);
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const stripped = base.replace(/\.(m?js)$/, "");
  const candidates = [base, ...TS_EXTENSIONS.map((ext) => stripped + ext), ...TS_EXTENSIONS.map((ext) => join(base, "index" + ext))];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** The chain from `file` to a bridge module importing a node-only package, if any. */
function chainToNodeOnly(file: string, seen = new Set<string>()): string[] | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  for (const specifier of importsOf(file)) {
    if (NODE_ONLY_MODULES.has(specifier)) return [file];
    if (!specifier.startsWith(".")) continue;
    const target = resolveRelative(file, specifier);
    if (!target || !target.startsWith(join(ROOT, "bridge", "src"))) continue;
    const rest = chainToNodeOnly(target, seen);
    if (rest) return [file, ...rest];
  }
  return undefined;
}

describe("root typecheck × bridge boundary", () => {
  it("excludes every root file whose imports reach a bridge module that needs a node-only package", () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
      exclude?: string[];
    };
    const excluded = new Set(tsconfig.exclude ?? []);
    const offenders = listFiles(join(ROOT, "src"))
      .map((file) => ({ file: relative(ROOT, file), chain: chainToNodeOnly(file) }))
      .filter(({ file, chain }) => chain && !excluded.has(file))
      .map(({ file, chain }) => `${file}: ${chain!.map((step) => relative(ROOT, step)).join(" → ")}`);
    expect(offenders).toEqual([]);
  });

  it("finds the chain it guards against (the guard is not blind)", () => {
    const chain = chainToNodeOnly(join(ROOT, "src/chat/subAgentRunTimeout1033.e2e.test.ts"));
    expect(chain?.at(-1)).toBe(join(ROOT, "bridge/src/providers/openclaw/openclaw-client.ts"));
  });
});
