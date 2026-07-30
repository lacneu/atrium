#!/usr/bin/env node
// VENDOR the Hermes API server's OWN published REST contract for one version (G-58, slice 1).
//
// WHY this is vendorable at all: unlike the WS JSON-RPC surface — which needs AST work to
// enumerate — the REST contract is a LITERAL dict in the upstream source, the very payload
// `GET /v1/capabilities` returns. So the gateway publishes its own contract, and Atrium can
// hold a snapshot of it without inventing a parser.
//
// WHY a script and not a hand-copy, same reason as the OpenClaw vendoring: a contract nobody
// re-derives is a contract that drifts silently. This extracts the `features` and `endpoints`
// maps and writes them beside a VERBATIM excerpt of the source lines they came from — the
// hash in PROVENANCE.json is over those upstream bytes, so it means the same thing it means
// on the OpenClaw side rather than merely proving this script's own output was not edited.
//
// Usage:
//   node scripts/vendor-hermes-rest.mjs 0.19.0 --src <checkout> [--tag v2026.7.20]
//                                       [--identical-to 0.18.2=v2026.7.7.2]
//
// The checkout must be at the tag for `version`. Hermes publishes TWO schemes for one build
// (pyproject semver + a calendar git tag), so both are recorded and neither is guessed.
//
// `--identical-to <version>=<tag>` PROVES that an older claimed version shares this exact
// contract, by re-extracting from that tag and comparing. That earns coverage for it instead
// of excusing it: a version whose contract is byte-identical has genuinely been examined,
// which is not the same as being grandfathered.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  ContractParseError,
  extractPayload,
  parseContract,
} from "./lib/hermes-rest-contract.mjs";

const API_SERVER = "gateway/platforms/api_server.py";

function fail(message) {
  console.error(`vendor-hermes-rest: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [version, ...rest] = argv;
  if (!version) fail("usage: vendor-hermes-rest.mjs <version> --src <checkout> [--tag <tag>]");
  let src = null;
  let tag = null;
  const identicalTo = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--src") src = rest[(i += 1)];
    else if (rest[i] === "--tag") tag = rest[(i += 1)];
    else if (rest[i] === "--identical-to") {
      const pair = rest[(i += 1)] ?? "";
      const [other, otherTag] = pair.split("=");
      if (!other || !otherTag) fail(`--identical-to expects <version>=<tag>, got "${pair}"`);
      identicalTo.push({ version: other, tag: otherTag });
    } else fail(`unknown argument ${rest[i]}`);
  }
  if (!src) fail("--src <path to a hermes checkout> is required");
  return { version, src, tag, identicalTo };
}

const { version, src, tag, identicalTo } = parseArgs(process.argv.slice(2));
if (!tag) fail("--tag <upstream tag> is required — provenance without it is unverifiable");

/** Read a file AT A TAG, never from the working tree. Reading the tree and recording HEAD was
 *  the first cut, and it let a dirty checkout — or a checkout at another commit invoked with
 *  `--tag` — produce an excerpt and a hash that LOOKED like they came from that tag (raised in
 *  review). The bytes and the label now come from the same place. */
function atTag(ref, file) {
  try {
    return execFileSync("git", ["-C", src, "show", `${ref}:${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    fail(`cannot read ${file} at ${ref} — is --src a hermes checkout with that tag?`);
    return "";
  }
}

/** The parsing lives in `lib/hermes-rest-contract.mjs` so the integrity test can re-derive the
 *  snapshot from the vendored excerpt with the SAME reader. A second, laxer parser on the test
 *  side would happily agree with a hand-edited JSON. */
function parseOrFail(source) {
  try {
    return parseContract(extractPayload(source));
  } catch (err) {
    if (err instanceof ContractParseError) fail(err.message);
    throw err;
  }
}

const source = atTag(tag, API_SERVER);
const payload = extractPayload(source);
const { features, endpoints } = parseOrFail(source);

let commit = null;
try {
  // The TAG's commit, not HEAD: the excerpt above was read at the tag, so the provenance has
  // to name the same object.
  commit = execFileSync("git", ["-C", src, "rev-parse", `${tag}^{commit}`], {
    encoding: "utf8",
  }).trim();
} catch {
  fail(`could not resolve ${tag} — provenance would be unverifiable`);
}

const outDir = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "protocol",
  "hermes",
  version,
);
fs.mkdirSync(outDir, { recursive: true });

// The VERBATIM upstream bytes the snapshot was read from. Hashing these is what makes
// PROVENANCE mean "this matches upstream" rather than "this matches my own extraction".
const excerptName = "rest-contract.source.py";
fs.writeFileSync(path.join(outDir, excerptName), `${payload}\n`);

/** Re-extract the payload at another tag and PROVE it is the same bytes. Refuses rather than
 *  records a difference: two versions that merely resemble each other must not be filed as
 *  one examined contract. */
const verifiedIdenticalFor = [];
const identityProofs = {};
for (const other of identicalTo) {
  const otherPayload = extractPayload(atTag(other.tag, API_SERVER));
  if (otherPayload !== payload) {
    fail(
      `${other.version} (${other.tag}) does NOT share this contract — vendor it separately ` +
        `instead of filing it under ${version}`,
    );
  }
  let otherCommit = null;
  try {
    otherCommit = execFileSync("git", ["-C", src, "rev-parse", `${other.tag}^{commit}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    fail(`could not resolve ${other.tag} — the identity claim would rest on nothing`);
  }
  verifiedIdenticalFor.push(other.version);
  // WHAT it was proven against. A claim of identity with no evidence behind it is the thing
  // `validatedVersions` was rescued from in lot 25 (raised in review).
  identityProofs[other.version] = { tag: other.tag, commit: otherCommit };
}

const contract = {
  $comment:
    "The Hermes API server's OWN published REST contract — the payload GET /v1/capabilities " +
    "returns, extracted from the upstream source literal by scripts/vendor-hermes-rest.mjs. " +
    "`features` are the gateway's self-declared feature flags; `endpoints` is the named " +
    "method+path map. This is the API SERVER's surface only: Atrium also depends on the " +
    "DASHBOARD web server (/api/files/*, /auth/*), which publishes no contract at all — see " +
    "test/hermes-rest-surface.test.ts, which classifies every path the bridge constructs.",
  version,
  upstreamTag: tag,
  // Older claimed versions PROVEN to carry byte-identical bytes (see `--identical-to`). Not a
  // convenience: one artifact genuinely covers them, so `validatedVersions` stays backed.
  verifiedIdenticalFor,
  identityProofs,
  features,
  endpoints,
};
fs.writeFileSync(
  path.join(outDir, "rest-contract.json"),
  `${JSON.stringify(contract, null, 1)}\n`,
);

const sha = createHash("sha256").update(`${payload}\n`).digest("hex");
const provenancePath = path.join(outDir, "PROVENANCE.json");
const provenance = fs.existsSync(provenancePath)
  ? JSON.parse(fs.readFileSync(provenancePath, "utf8"))
  : {};
provenance.$comment =
  "Provenance of the vendored Hermes surface. `sha256` is over the VERBATIM upstream excerpt " +
  "(rest-contract.source.py), not over the parsed JSON — so vendor-integrity recomputation " +
  "proves the snapshot still matches upstream bytes.";
provenance.restContract = {
  upstreamCommit: commit,
  upstreamTag: tag,
  source: API_SERVER,
  excerpt: excerptName,
  sha256: sha,
};
fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 1)}\n`);

console.log(
  `vendored hermes ${version}: ${Object.keys(features).length} features, ` +
    `${Object.keys(endpoints).length} endpoints (sha256 ${sha.slice(0, 12)}…)`,
);
