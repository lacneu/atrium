// Parsing the Hermes API server's published REST contract out of its upstream source literal.
//
// Extracted so the vendoring SCRIPT and the integrity TEST share one implementation: the test
// re-derives `features` and `endpoints` from the vendored excerpt and compares them with the
// vendored JSON, which only means anything if both sides parse the same way. Two copies would
// let a hand-edited JSON agree with a second, sloppier reader.
//
// From Hermes 0.21 the payload is no longer ONE literal: its flags are spread in from a
// module-level dict (`**_STATIC_FEATURE_FLAGS`) and its endpoints are a comprehension over a
// module-level tuple (`for name, (m, p) in _CAPABILITY_ENDPOINTS`). The excerpt therefore
// carries the payload FOLLOWED BY the verbatim source of every module constant it references,
// so the hash still covers every upstream byte the snapshot was read from.

/** The marker that identifies the capabilities payload — matched on the `object` field rather
 *  than a line number, so an upstream edit above it does not silently shift the extraction. */
export const MARKER = '"object": "hermes.api_server.capabilities"';

export class ContractParseError extends Error {}

/** Index just past the string literal opening at `i` (a `"` or `'`), escapes honoured. */
function skipString(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === quote) return j + 1;
  }
  throw new ContractParseError("unterminated string literal in the capabilities source");
}

/** The index of the bracket closing the one at `open`, skipping strings and comments — a
 *  brace inside `"/v1/runs/{run_id}"` or a `#` comment is not structure. */
function matchingClose(text, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i) - 1;
    } else if (c === "#") {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? text.length : eol;
    } else if (pairs[c] !== undefined) {
      stack.push(pairs[c]);
    } else if (c === "}" || c === ")" || c === "]") {
      if (stack.pop() !== c) {
        throw new ContractParseError("unbalanced brackets in the capabilities source");
      }
      if (stack.length === 0) return i;
    }
  }
  throw new ContractParseError(
    "unbalanced braces in the capabilities payload — refusing to guess where it ends",
  );
}

/** The module constants a payload pulls in: `**NAME` spreads and `... in NAME}` sources. */
function referencedConstants(payload) {
  const names = [];
  for (const m of payload.matchAll(/\*\*([A-Z_][A-Z0-9_]*)\b/g)) names.push(m[1]);
  for (const m of payload.matchAll(/\bin\s+([A-Z_][A-Z0-9_]*)\s*\}/g)) names.push(m[1]);
  return [...new Set(names)];
}

/** The verbatim `NAME = {...}` / `NAME = (...)` span of a module-level constant, or null. */
function constantSpan(text, name) {
  const re = new RegExp(`(^|\\n)(${name} = )([{(])`);
  const m = re.exec(text);
  if (m === null) return null;
  const start = m.index + m[1].length;
  const open = start + m[2].length;
  return text.slice(start, matchingClose(text, open) + 1);
}

/** The payload literal, from the marker outwards, followed by the verbatim source of every
 *  module constant it references. IDEMPOTENT: applied to its own output it returns the same
 *  text, which is what lets the integrity test re-derive the snapshot from the excerpt. */
export function extractPayload(source) {
  const marker = source.indexOf(MARKER);
  if (marker < 0) {
    throw new ContractParseError(`source no longer contains ${MARKER} — the contract moved`);
  }
  const from = source.lastIndexOf("return web.json_response(", marker);
  const open = source.indexOf("{", from < 0 ? 0 : from);
  const payload = source.slice(open, matchingClose(source, open) + 1);
  const constants = [];
  for (const name of referencedConstants(payload)) {
    const span = constantSpan(source, name);
    if (span === null) {
      throw new ContractParseError(
        `the payload references ${name}, which is not a module-level literal in this source`,
      );
    }
    constants.push(span);
  }
  return constants.length === 0 ? payload : `${payload}\n\n${constants.join("\n\n")}`;
}

/** Split a dict/tuple BODY at its top-level commas (strings, brackets and comments aware). */
function topLevelEntries(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const entry = body
      .slice(start, end)
      .split("\n")
      .map((l) => l.replace(/^\s*#.*$/, ""))
      .join("\n")
      .trim();
    if (entry !== "") out.push(entry);
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'") i = skipString(body, i) - 1;
    else if (c === "#") {
      const eol = body.indexOf("\n", i);
      i = eol < 0 ? body.length : eol;
    } else if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

/** The text between the brackets of the `"name": {...}` value inside `payload`. */
function subMapBody(payload, name) {
  const at = payload.indexOf(`"${name}": {`);
  if (at < 0) throw new ContractParseError(`the capabilities payload has no "${name}" map`);
  const open = payload.indexOf("{", at + name.length + 3);
  return payload.slice(open, matchingClose(payload, open) + 1);
}

/** A constant's literal (`NAME = {...}`) body, from the excerpt. */
function constantBody(excerpt, name) {
  const span = constantSpan(excerpt, name);
  if (span === null) throw new ContractParseError(`${name} is not in the excerpt`);
  const open = span.indexOf("=") + 1;
  const bracket = span.slice(open).search(/[{(]/) + open;
  return span.slice(bracket + 1, span.length - 1);
}

const KEY = /^"([a-z_]+)":\s*([\s\S]+)$/;
const ENDPOINT_VALUE = /^\{"method":\s*"([A-Z]+)",\s*"path":\s*"([^"]+)"\}$/;

/** One entry value, classified. Deliberately NOT a Python evaluator: a literal is read, and
 *  anything computed is recorded as DYNAMIC with its expression — snapshotting one
 *  deployment's answer as the contract would be fiction. Nothing is dropped: every key enters
 *  the snapshot, and the features registry then makes someone classify it. */
function readValue(raw) {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "True" || value === "False") return value === "True";
  const str = /^"([^"]*)"$/.exec(value);
  if (str) return str[1];
  const endpoint = ENDPOINT_VALUE.exec(value);
  if (endpoint) return { method: endpoint[1], path: endpoint[2] };
  const bool = /^bool\((.+)\)$/.exec(value);
  // `bool(self._cors_origins)`: computed from the gateway's own runtime config.
  if (bool) return { dynamic: bool[1] };
  if (value.startsWith("{")) {
    // A nested object (Hermes 0.21 `browser_extension_control`): its presence is the
    // contract; its sub-keys are recorded so a change there is visible too.
    const keys = topLevelEntries(value.slice(1, -1)).map((e) => {
      const k = KEY.exec(e);
      if (k === null) throw new ContractParseError(`unreadable nested entry: ${e}`);
      return k[1];
    });
    return { object: keys.sort() };
  }
  return { dynamic: value };
}

/** A flat `key -> value` map from a dict body, resolving `**CONSTANT` spreads. */
function readMap(body, excerpt, name) {
  const out = {};
  const unread = [];
  for (const entry of topLevelEntries(body)) {
    const spread = /^\*\*([A-Z_][A-Z0-9_]*)$/.exec(entry);
    if (spread) {
      Object.assign(out, readMap(constantBody(excerpt, spread[1]), excerpt, name));
      continue;
    }
    const m = KEY.exec(entry);
    if (m === null) {
      unread.push(entry);
      continue;
    }
    out[m[1]] = readValue(m[2]);
  }
  if (unread.length > 0) {
    throw new ContractParseError(
      `these "${name}" entries could not be read — classify them rather than letting them ` +
        `vanish from the snapshot:\n  ${unread.join("\n  ")}`,
    );
  }
  return out;
}

/** The comprehension Hermes 0.21 builds its endpoints with — accepted in exactly this shape,
 *  refused in any other. */
const ENDPOINTS_COMPREHENSION =
  /^\{\s*name:\s*\{"method":\s*m,\s*"path":\s*p\}\s+for\s+name,\s*\(m,\s*p\)\s+in\s+([A-Z_][A-Z0-9_]*)\s*\}$/;

/** Read one sub-map of the payload (`features` or `endpoints`). */
export function readSubMap(excerpt, name) {
  const payload = extractPayload(excerpt);
  if (name === "endpoints") {
    const at = payload.indexOf('"endpoints": ');
    if (at >= 0 && payload[at + '"endpoints": '.length] === "{") {
      const open = at + '"endpoints": '.length;
      const value = payload.slice(open, matchingClose(payload, open) + 1);
      const comp = ENDPOINTS_COMPREHENSION.exec(value.replace(/\s+/g, " "));
      if (comp) {
        const out = {};
        for (const entry of topLevelEntries(constantBody(excerpt, comp[1]))) {
          const e = /^\("([a-z_]+)",\s*\("([A-Z]+)",\s*"([^"]+)"\)\)$/.exec(
            entry.replace(/\s+/g, " "),
          );
          if (e === null) {
            throw new ContractParseError(`unreadable ${comp[1]} entry: ${entry}`);
          }
          out[e[1]] = { method: e[2], path: e[3] };
        }
        return out;
      }
    }
  }
  const body = subMapBody(payload, name);
  return readMap(body.slice(1, -1), excerpt, name);
}

/** Both maps, from one excerpt — the shape the vendored JSON stores and the integrity test
 *  recomputes. */
export function parseContract(excerpt) {
  return {
    features: readSubMap(excerpt, "features"),
    endpoints: readSubMap(excerpt, "endpoints"),
  };
}
