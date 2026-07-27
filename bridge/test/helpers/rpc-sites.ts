import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../../src/", import.meta.url);

// Where the bridge calls the gateway — ONE derivation, shared by every gate.
//
// Extracted from rpc-scope.test.ts on 2026-07-27 because the outbound ratchet grew its
// own `"chat.send"` regex and inherited, in one line, the whole class of blindness this
// one took five review rounds to close: single quotes, optional calls, generic calls,
// bracket access, destructured aliases. Two scanners means the weaker one decides.

/** Source files of the bridge, recursively. */
export function sourceFiles(dir: URL = SRC, out: URL[] = []): URL[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) sourceFiles(child, out);
    else if (entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

/** Every `.request(` call site: the method name when it is a plain string literal,
 *  or the raw first-argument EXPRESSION when it is anything else — plus the raw text of
 *  the PARAMS argument.
 *
 *  `params` exists so a gate can check WHERE a body comes from, not just that a method is
 *  called. The outbound ratchet validates bodies built by exported pure builders; without
 *  this, a handler rewritten to build its object inline would ship an unvalidated body
 *  while the ratchet kept checking the now-unused builder (raised in review). */
export function requestCallSites(): {
  method: string | null;
  expression?: string;
  params?: string;
  file: string;
}[] {
  // Two patterns over the same anchor. The literal one extracts the name; the ANY one
  // counts call sites. A site the first matches and the second does not cannot exist;
  // a site only the second matches is an INDIRECT method name, which defeats the
  // whole derivation — reported by name rather than silently skipped (the first
  // version of this test only looked for double-quoted literals, so a constant or a
  // template literal would have added an RPC with no contract and stayed green).
  // Three call shapes the first versions missed, each raised in review and each a way
  // for an RPC to vanish from the derived surface while every size assertion stayed
  // green: an OPTIONAL call (`client.request?.(…)`), a GENERIC call
  // (`client.request<Result>(…)`), and the two combined.
  // The type-argument class must ALLOW braces (`request<{ok:boolean}>(…)` is the shape
  // the bridge would actually write) while excluding parentheses and newlines so the
  // match cannot run away. Excluding braces made the generic case silently unmatched.
  const CALL = String.raw`\.request(?:\?\.)?\s*(?:<[^()\n]*>\s*)?\(`;
  const LITERAL = new RegExp(
    `${CALL}\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)?(?://[^\\n]*\\n\\s*)*"([a-zA-Z0-9._]+)"`,
    "g",
  );
  const ANY = new RegExp(CALL, "g");
  /** The argument text starting at `from`, read with BRACE/PAREN/BRACKET BALANCE so an
   *  object or a nested call is taken whole. A plain `split(",")` would cut
   *  `{a, b}` in half and make every shape check meaningless. */
  const argAt = (
    source: string,
    from: number,
  ): { text: string; end: number } => {
    let depth = 0;
    for (let i = from; i < source.length; i += 1) {
      const c = source[i]!;
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) return { text: source.slice(from, i).trim(), end: i };
        depth -= 1;
      } else if (c === "," && depth === 0) {
        return { text: source.slice(from, i).trim(), end: i };
      }
    }
    return { text: source.slice(from).trim(), end: source.length };
  };
  /** The text of the SECOND argument of a call whose argument list starts at `end`.
   *
   *  Walks from the first argument's real END INDEX, not from `start + text.length`: the
   *  text is trimmed, so with a newline after `.request(` that arithmetic landed inside
   *  the first argument and returned "" — which made the tts assertion fail on correct
   *  code and would have made it pass on broken code just as easily. */
  const secondArg = (source: string, end: number): string => {
    let i = argAt(source, end).end;
    if (source[i] !== ",") return "";
    i += 1;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    return argAt(source, i).text;
  };
  const sites: {
    method: string | null;
    expression?: string;
    params?: string;
    file: string;
  }[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf-8");
    const name = file.pathname.split("/").pop()!;
    const literals = [...source.matchAll(LITERAL)];
    const all = [...source.matchAll(ANY)];
    // Match them by position: a literal call site starts where an ANY match starts.
    const literalStarts = new Set(literals.map((m) => m.index));
    for (const m of literals) {
      sites.push({
        method: m[1]!,
        params: secondArg(source, m.index! + m[0].length - m[1]!.length - 2),
        file: name,
      });
    }
    for (const m of all) {
      if (literalStarts.has(m.index)) continue;
      // The first argument's own text, up to the comma. Identifying an indirect site
      // by its EXPRESSION rather than by its file (raised in review): keyed by file,
      // a second indirect call in server.ts would have silently inherited the TTS
      // expansion and vanished from the derived surface.
      const expression = argAt(source, m.index! + m[0].length).text;
      sites.push({
        method: null,
        expression,
        params: secondArg(source, m.index! + m[0].length),
        file: name,
      });
    }
  }
  return sites;
}

