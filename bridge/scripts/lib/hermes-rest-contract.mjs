// Parsing the Hermes API server's published REST contract out of its upstream source literal.
//
// Extracted so the vendoring SCRIPT and the integrity TEST share one implementation: the test
// re-derives `features` and `endpoints` from the vendored excerpt and compares them with the
// vendored JSON, which only means anything if both sides parse the same way. Two copies would
// let a hand-edited JSON agree with a second, sloppier reader.

/** The marker that identifies the capabilities payload — matched on the `object` field rather
 *  than a line number, so an upstream edit above it does not silently shift the extraction. */
export const MARKER = '"object": "hermes.api_server.capabilities"';

export class ContractParseError extends Error {}

/** The BALANCED brace span of the payload literal, found from the marker outwards. A regex
 *  over nested dicts would stop at the first inner `}`; counting braces is what makes the
 *  excerpt the whole contract rather than its first third. */
export function extractPayload(source) {
  const marker = source.indexOf(MARKER);
  if (marker < 0) {
    throw new ContractParseError(`source no longer contains ${MARKER} — the contract moved`);
  }
  const from = source.lastIndexOf("return web.json_response(", marker);
  const open = source.indexOf("{", from < 0 ? 0 : from);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new ContractParseError(
    "unbalanced braces in the capabilities payload — refusing to guess where it ends",
  );
}

/** Read one `"key": {...}` sub-map out of the payload as flat key -> value pairs.
 *
 *  Deliberately NOT a Python parser: the two maps this needs are flat, and their values are
 *  `True`/`False`, a string, or a `{"method": .., "path": ..}` pair. Anything else THROWS
 *  rather than being coerced — a contract entry this cannot read must stop the vendoring, not
 *  enter the snapshot as a guess. */
export function readSubMap(payload, name) {
  const at = payload.indexOf(`"${name}": {`);
  if (at < 0) throw new ContractParseError(`the capabilities payload has no "${name}" map`);
  const open = payload.indexOf("{", at + name.length + 3);
  let depth = 0;
  let close = -1;
  for (let i = open; i < payload.length; i += 1) {
    if (payload[i] === "{") depth += 1;
    else if (payload[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new ContractParseError(`unbalanced braces in the "${name}" map`);
  const body = payload.slice(open + 1, close);
  const out = {};
  const ENDPOINT = /^"([a-z_]+)":\s*\{"method":\s*"([A-Z]+)",\s*"path":\s*"([^"]+)"\}$/;
  const BOOL = /^"([a-z_]+)":\s*(True|False)$/;
  const STR = /^"([a-z_]+)":\s*"([^"]*)"$/;
  const DYNAMIC = /^"([a-z_]+)":\s*bool\((.+)\)$/;
  const unread = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line || line.startsWith("#")) continue;
    let m = ENDPOINT.exec(line);
    if (m) {
      out[m[1]] = { method: m[2], path: m[3] };
      continue;
    }
    m = BOOL.exec(line);
    if (m) {
      out[m[1]] = m[2] === "True";
      continue;
    }
    m = STR.exec(line);
    if (m) {
      out[m[1]] = m[2];
      continue;
    }
    m = DYNAMIC.exec(line);
    if (m) {
      // A value computed from the gateway's own runtime config (`bool(self._cors_origins)`).
      // Recorded as DYNAMIC rather than as a boolean: snapshotting one deployment's answer as
      // the contract would be fiction.
      out[m[1]] = { dynamic: m[2] };
      continue;
    }
    unread.push(line);
  }
  if (unread.length > 0) {
    throw new ContractParseError(
      `these "${name}" entries could not be read — classify them rather than letting them ` +
        `vanish from the snapshot:\n  ${unread.join("\n  ")}`,
    );
  }
  return out;
}

/** Both maps, from one payload — the shape the vendored JSON stores and the integrity test
 *  recomputes. */
export function parseContract(payload) {
  return {
    features: readSubMap(payload, "features"),
    endpoints: readSubMap(payload, "endpoints"),
  };
}
