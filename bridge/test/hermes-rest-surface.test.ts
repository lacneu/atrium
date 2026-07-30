/// <reference types="vitest" />
//
// Every HTTP path the bridge builds for Hermes is accounted for (lot 47 — G-58, slice 1).
//
// THE FINDING THIS TEST WAS BUILT ON, and it came before a line of it was written: Atrium
// depends on TWO upstream HTTP surfaces, and only one of them publishes a contract.
//
//   * The API SERVER (`gateway/platforms/api_server.py`) publishes its own contract — the
//     `GET /v1/capabilities` payload, a literal dict of `features` flags and a named
//     `endpoints` method+path map. That is what `protocol/hermes/<version>/` now vendors.
//   * The DASHBOARD web server (`hermes_cli/web_server.py`, `hermes_cli/dashboard_auth/`)
//     serves `/api/files/upload`, `/api/files/download` and `/auth/password-login`. It
//     publishes NOTHING, and upstream supervises it only "if HERMES_DASHBOARD is set"
//     (`hermes_cli/gateway.py:6607`) — so it is opt-in, and Atrium's agent-files feature
//     rides it.
//
// So this is not a fixture-shaped test. It is the ratchet that turned three silent
// dependencies into recorded ones, and it fails the day a fourth appears.
//
// DERIVED from the source, never a hand-kept list — the same rule and the same technique as
// `rpc-scope.test.ts`, and the lesson of lot 23: a list maintained by incident is the thing
// that drifts.
//
// NOT in this slice, and each excluded for a measured reason rather than for convenience:
//   * The `features` LOCKSTEP. Counted first: Atrium declares 8 Hermes capabilities and
//     upstream reports exactly 5 features as `false` (`admin_config_rw`, `jobs_admin`,
//     `memory_write_api`, `audio_api`, `realtime_voice`), and the two sets do not intersect.
//     A veto gate built today could not fire — the tautological guard of lot 25.
//   * The WS JSON-RPC surface, which needs AST extraction, and the runtime drift detector.
//     G-58 stays open, partially closed.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BENCH_GRANDFATHERED, COMPAT_MANIFEST } from "../src/compat.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import * as contractLib from "../scripts/lib/hermes-rest-contract.mjs";

const extractPayload = contractLib.extractPayload as (source: string) => string;
const parseContract = contractLib.parseContract as (payload: string) => {
  features: Record<string, unknown>;
  endpoints: Record<string, unknown>;
};

const PROTOCOL = new URL("../protocol/hermes/", import.meta.url);
const HERMES_SRC = new URL("../src/providers/hermes/", import.meta.url);

interface RestContract {
  version: string;
  upstreamTag: string | null;
  /** Older claimed versions PROVEN byte-identical by the vendoring script — earned coverage,
   *  not an excuse (see `--identical-to`). */
  verifiedIdenticalFor?: string[];
  /** What each entry of `verifiedIdenticalFor` was proven against — tag and commit. */
  identityProofs?: Record<string, { tag: string; commit: string }>;
  features: Record<string, boolean | string | { dynamic: string }>;
  endpoints: Record<string, { method: string; path: string }>;
}

function vendoredVersions(): string[] {
  return readdirSync(PROTOCOL, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function contractFor(version: string): RestContract {
  return JSON.parse(
    readFileSync(new URL(`${version}/rest-contract.json`, PROTOCOL), "utf8"),
  ) as RestContract;
}

/** Every `.ts` under the Hermes provider, RECURSIVELY. Scanning one flat directory was the
 *  first cut, and a helper moved into a subdirectory would have left the ratchet green while
 *  vouching for a surface it never read (raised in review). */
function hermesSourceFiles(dir: URL = HERMES_SRC, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...hermesSourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      out.push([
        `${prefix}${entry.name}`,
        readFileSync(new URL(entry.name, dir), "utf8"),
      ]);
    }
  }
  return out;
}

/**
 * Every HTTP path the Hermes provider builds, read out of its own source — CODE only.
 *
 * Deliberately OVER-INCLUSIVE and comment-free, in that order, because the two failure modes
 * are not symmetric. Matching by call SHAPE was the first cut and it missed silently: three
 * distinct helpers build paths here (`this.json(METHOD, path)`, a `${this.base}` template, and
 * `authedGet(path)`), and a ratchet that overlooks a helper vouches for a surface it never
 * looked at. Scanning for path-shaped tokens instead can only over-report, and an
 * over-reported path fails LOUDLY as an unclassified entry. Comments are stripped first, so
 * prose about a path is never filed as a dependency on it.
 *
 * Interpolations collapse to `{}` BEFORE the scan — `${encodeURIComponent(runId)}` contains
 * parentheses, which tore paths in half when the collapse came second. A path is then anything
 * absolute that STARTS a string or follows a closed interpolation, which is what covers both a
 * plain `"/v1/models"` and a `` `${this.base}/health` ``.
 *
 * NO prefix allowlist. The first cut anchored on `v1|api|health|auth`, so a perfectly ordinary
 * new endpoint — `/metrics`, `/internal/foo` — produced no entry at all and the ratchet stayed
 * green while the dependency went unclassified (raised in review). An allowlist of what to
 * look for is the same hand-kept list this whole approach exists to avoid.
 */
export function pathsIn(sources: Array<[string, string]>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [file, raw] of sources) {
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/([^:])\/\/.*$/gm, "$1")
      .replace(/\$\{[^{}]*\}/g, "{}");
    for (const m of src.matchAll(/[`"'}](\/[A-Za-z0-9._/{}-]+)/g)) {
      const shape = (m[1] as string).replace(/\/$/, "");
      // A bare interpolation carries no dependency, and neither does a token with no letters
      // in it — a template that merely starts with a slash is not an endpoint.
      if (shape === "/{}" || !/[a-z]/i.test(shape)) continue;
      const where = found.get(shape) ?? [];
      if (!where.includes(file)) where.push(file);
      found.set(shape, where);
    }
  }
  return found;
}

function constructedPaths(): Map<string, string[]> {
  return pathsIn(hermesSourceFiles());
}

/** Paths the API server's contract does NOT declare, each with the upstream SERVER it really
 *  belongs to and why Atrium depends on it. A path in neither the vendored `endpoints` map nor
 *  here fails the ratchet — the next undeclared dependency gets decided rather than discovered
 *  in production.
 *
 *  Read as a whole, this table IS the finding: Atrium's Hermes surface spans THREE upstream
 *  servers, and only one of them publishes a contract. */
const UNDECLARED_SURFACE: Record<string, { server: string; why: string }> = {
  "/v1/capabilities": {
    server: "api_server",
    why:
      "The contract endpoint itself — a map does not list itself. Atrium calls it from " +
      "`client.capabilities()`, which is currently unused; whether the runtime should read it " +
      "is a later slice.",
  },
  "/api/ws": {
    server: "tui_gateway",
    why:
      "The WS upgrade of `hermes serve` (tui_gateway/ws.py:19) — Atrium's DEFAULT transport, " +
      "and a surface the API server's contract says nothing about. The dashboard serves the " +
      "same path (web_server.py:17679), so the path alone does not name its server.",
  },
  "/api/files": {
    server: "dashboard web_server",
    why:
      "The managed-files listing. This server publishes NO contract and upstream supervises it " +
      "only when HERMES_DASHBOARD is set, so Atrium's agent-files tab rides an opt-in surface.",
  },
  "/api/files/read": {
    server: "dashboard web_server",
    why: "Managed-files read (web_server.py:2131). Same opt-in server.",
  },
  "/api/files/download": {
    server: "dashboard web_server",
    why: "Managed-files download (web_server.py:2166), query-parameterised. Same opt-in server.",
  },
  "/api/files/upload": {
    server: "dashboard web_server",
    why: "Managed-files upload (web_server.py:2202). Same opt-in server.",
  },
  "/auth/password-login": {
    server: "dashboard dashboard_auth",
    why:
      "The dashboard login (dashboard_auth/routes.py:466). Used by the managed-files fetcher, " +
      "and by the WS client ONLY in password mode — a static-token instance never calls it.",
  },
  "/api/auth/ws-ticket": {
    server: "dashboard dashboard_auth",
    why:
      "The single-use WS ticket (dashboard_auth/routes.py:615). Same password-mode-only " +
      "condition, which is why the default transport does not depend on the dashboard outright.",
  },
};

describe("the vendored Hermes REST contract", () => {
  it("covers every version the manifest claims to have validated", () => {
    // `validatedVersions` is a public promise that a version's contract was EXAMINED. The
    // examination artifact is this directory.
    const vendored = vendoredVersions();
    const byIdentity = new Set(
      vendored.flatMap((v) => contractFor(v).verifiedIdenticalFor ?? []),
    );
    // The SAME grandfathering the bench attestation uses, not a second list: 0.18.0 and 0.18.2
    // were claimed on a run that predates every mechanism in this wave, and inventing a
    // parallel exemption here would let the two drift apart.
    const grandfathered = new Set(BENCH_GRANDFATHERED.hermes ?? []);
    const claimed = COMPAT_MANIFEST.providers.hermes?.validatedVersions ?? [];
    expect(claimed.length).toBeGreaterThan(0);
    const unbacked = claimed.filter(
      (v) => !vendored.includes(v) && !byIdentity.has(v) && !grandfathered.has(v),
    );
    expect(
      unbacked,
      "a version claimed validated with no vendored contract and no grandfathering",
    ).toEqual([]);
    // …and the grandfathering must not quietly widen: every version it excuses is one this
    // wave inherited, never one added later.
    expect([...grandfathered].every((v) => claimed.includes(v))).toBe(true);
  });

  it("holds the gateway's own feature flags and endpoint map", () => {
    const contract = contractFor("0.19.0");
    // Spot-checked against the upstream literal rather than counted: a count would pass on a
    // truncated extraction, which is exactly what the brace-balancing in the vendoring script
    // exists to prevent.
    expect(contract.features.session_chat_streaming).toBe(true);
    expect(contract.features.admin_config_rw).toBe(false);
    expect(contract.endpoints.session_chat_stream).toEqual({
      method: "POST",
      path: "/api/sessions/{session_id}/chat/stream",
    });
    expect(contract.endpoints.run_stop).toEqual({
      method: "POST",
      path: "/v1/runs/{run_id}/stop",
    });
  });

  it("records that `run_stop` is DECLARED — which lot 45 proved is not the same as usable", () => {
    // The reason a `features` lockstep may only ever VETO, never grant: the gateway declares
    // `run_stop: true` and it is true of `POST /v1/runs`, while the run ids Atrium's SSE
    // transport holds are registered nowhere the stop handler looks. A declared capability is
    // not a reachable one.
    expect(contractFor("0.19.0").features.run_stop).toBe(true);
  });
});

describe("every path the bridge builds is accounted for", () => {
  it("is either in the gateway's own map or explicitly classified", () => {
    const contract = contractFor("0.19.0");
    const declared = new Set(
      Object.values(contract.endpoints).map((e) => e.path.replace(/\{[a-z_]+\}/g, "{}")),
    );
    const unaccounted: string[] = [];
    for (const [shape, files] of constructedPaths()) {
      if (declared.has(shape)) continue;
      if (shape in UNDECLARED_SURFACE) continue;
      unaccounted.push(`${shape} (${files.join(", ")})`);
    }
    expect(
      unaccounted,
      "a path the gateway does not declare and this repo has not classified — decide which " +
        "upstream surface it belongs to before it 404s in production",
    ).toEqual([]);
  });

  it("finds the paths it is supposed to find — the derivation is not vacuous", () => {
    // A regex that silently matched nothing would make the ratchet above pass forever. These
    // are paths the client demonstrably constructs.
    const shapes = new Set(constructedPaths().keys());
    for (const expected of [
      "/v1/models",
      "/health",
      "/api/sessions",
      "/api/sessions/{}/chat/stream",
      "/v1/runs/{}/stop",
      // The three the first, shape-matching derivation missed entirely.
      "/api/files/download",
      "/api/files/upload",
      "/api/auth/ws-ticket",
    ]) {
      expect(shapes, `the path derivation missed ${expected}`).toContain(expected);
    }
  });

  it("the classified exceptions are all still USED — a stale exemption is a lie", () => {
    // The other direction, and the one an allowlist normally rots in: an entry nobody
    // constructs any more would keep vouching for a dependency that no longer exists.
    const shapes = new Set(constructedPaths().keys());
    for (const shape of Object.keys(UNDECLARED_SURFACE)) {
      expect(shapes, `${shape} is classified as a dependency but nothing builds it`).toContain(
        shape,
      );
    }
  });

  it("names the two servers apart — the dashboard half is the opt-in one", () => {
    const dashboard = Object.entries(UNDECLARED_SURFACE).filter(([, v]) =>
      v.server.startsWith("dashboard"),
    );
    // SIX today: four managed-files paths, the login that mints their cookie, and the WS
    // ticket that login is a prerequisite for.
    expect(dashboard.map(([k]) => k).sort()).toEqual([
      "/api/auth/ws-ticket",
      "/api/files",
      "/api/files/download",
      "/api/files/read",
      "/api/files/upload",
      "/auth/password-login",
    ]);
    for (const [, v] of dashboard) expect(v.why.length).toBeGreaterThan(40);
  });
});

// ── The two ways a ratchet goes quietly blind ──
//
// Both raised in review, and both are silent-green failures rather than loud ones, which is
// what makes them worth pinning on synthetic sources: no real file exercises them today, and
// by the time one does the ratchet would already have stopped meaning anything.

describe("the derivation cannot be walked around", () => {
  it("a helper in a SUBDIRECTORY is still read", () => {
    // `hermesSourceFiles` recurses; this pins the scanner's half of that contract.
    const found = pathsIn([["net/agent-files.ts", 'authedGet("/api/files/rename")']]);
    expect([...found.keys()]).toContain("/api/files/rename");
  });

  it("a path behind an INTERPOLATED prefix is still a dependency", () => {
    // `/${PREFIX}/new-route` collapses to `/{}/new-route`, which the first pattern — anchored
    // on a literal `v1|api|health|auth` — could not see at all.
    const found = pathsIn([["client.ts", "fetch(`${base}/${PREFIX}/new-route`)"]]);
    expect([...found.keys()]).toContain("/{}/new-route");
  });

  it("an endpoint on a WHOLLY new prefix is seen", () => {
    // The allowlist's blind spot, and the reason there is no longer one: `/metrics` shares no
    // segment with anything Atrium calls today, and a ratchet that cannot see it would vouch
    // for a dependency nobody classified.
    const found = pathsIn([["client.ts", 'this.json("GET", "/metrics")']]);
    expect([...found.keys()]).toContain("/metrics");
    const nested = pathsIn([["client.ts", "fetch(`${this.base}/internal/foo`)"]]);
    expect([...nested.keys()]).toContain("/internal/foo");
  });

  it("…and an unclassified one of either kind FAILS the ratchet", () => {
    // The consequence, not the mechanism: a shape neither declared nor classified must be
    // unaccounted for. Composed here rather than by editing a real source file.
    const contract = contractFor("0.19.0");
    const declared = new Set(
      Object.values(contract.endpoints).map((e) => e.path.replace(/\{[a-z_]+\}/g, "{}")),
    );
    const invented = pathsIn([["net/new.ts", 'authedGet("/api/files/rename")']]);
    const unaccounted = [...invented.keys()].filter(
      (shape) => !declared.has(shape) && !(shape in UNDECLARED_SURFACE),
    );
    expect(unaccounted).toEqual(["/api/files/rename"]);
  });

  it("a bare interpolation is not mistaken for a path", () => {
    // `/{}` alone carries no dependency — a template that happens to start with a slash is not
    // an endpoint, and treating it as one would put permanent noise in the table.
    expect([...pathsIn([["x.ts", "`${a}/${b}`"]]).keys()]).toEqual([]);
  });
});

// ── The vendored contract has to be checkable, or it is just a file ──
//
// Raised in review: the ratchet above loads `rest-contract.json` and treats it as the
// authority for classifying routes, but nothing recomputed its hash or re-derived it. A JSON
// edited to declare a route that does not exist — with the excerpt and the provenance adjusted
// to match — stayed green. The OpenClaw side has `vendor-integrity.test.ts` for exactly this;
// this is its Hermes half.

describe("the vendored contract is verifiable, not merely present", () => {
  it("the excerpt still hashes to what PROVENANCE recorded", () => {
    for (const version of vendoredVersions()) {
      const prov = JSON.parse(
        readFileSync(new URL(`${version}/PROVENANCE.json`, PROTOCOL), "utf8"),
      ) as { restContract?: { sha256: string; excerpt: string } };
      // REQUIRED, not optional: skipping a directory without provenance let a future one ship
      // a self-consistent excerpt+JSON that nothing tied to upstream at all (raised in review).
      const rc = prov.restContract;
      if (rc === undefined) {
        throw new Error(
          `${version}: a vendored contract with no provenance vouches for nothing`,
        );
      }
      const bytes = readFileSync(new URL(`${version}/${rc.excerpt}`, PROTOCOL), "utf8");
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        `${version}: the vendored excerpt no longer matches its recorded hash`,
      ).toBe(rc.sha256);
    }
  });

  it("the JSON is exactly what the excerpt parses to — with the SAME reader", () => {
    // Re-derived rather than spot-checked: the JSON is the thing the ratchet trusts, so it
    // must be a function of the upstream bytes and nothing else. Sharing the parser with the
    // vendoring script is what stops a laxer second reader from agreeing with a hand edit.
    for (const version of vendoredVersions()) {
      const contract = contractFor(version);
      const excerpt = readFileSync(
        new URL(`${version}/rest-contract.source.py`, PROTOCOL),
        "utf8",
      );
      const derived = parseContract(extractPayload(excerpt));
      expect(derived.features, `${version}: features`).toEqual(contract.features);
      expect(derived.endpoints, `${version}: endpoints`).toEqual(contract.endpoints);
    }
  });

  it("a version covered BY IDENTITY carries the tag it was proven against", () => {
    // `verifiedIdenticalFor` earns coverage for an older claimed version, so it has to say
    // against WHAT — otherwise it is an assertion with no evidence behind it, which is the
    // thing `validatedVersions` was rescued from in lot 25.
    for (const version of vendoredVersions()) {
      const contract = contractFor(version);
      for (const other of contract.verifiedIdenticalFor ?? []) {
        const proof = (contract.identityProofs ?? {})[other];
        expect(proof, `${version}: no proof recorded for ${other}`).toBeTruthy();
        expect(proof?.tag).toBeTruthy();
        expect(proof?.commit).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("provenance names a tag and a commit, never neither", () => {
    for (const version of vendoredVersions()) {
      const prov = JSON.parse(
        readFileSync(new URL(`${version}/PROVENANCE.json`, PROTOCOL), "utf8"),
      ) as {
        restContract?: {
          upstreamCommit: string;
          upstreamTag: string;
          source: string;
          excerpt: string;
        };
      };
      const rc = prov.restContract;
      if (rc === undefined) throw new Error(`${version}: provenance is mandatory`);
      expect(rc.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(rc.upstreamTag).toBeTruthy();
      // The FILE it claims to come from and the excerpt it wrote, both named: provenance that
      // does not say what it read is provenance that cannot be re-checked against a checkout.
      expect(rc.source).toBe("gateway/platforms/api_server.py");
      expect(
        readFileSync(new URL(`${version}/${rc.excerpt}`, PROTOCOL), "utf8").length,
      ).toBeGreaterThan(200);
    }
  });
});

// ── Self-attestation is not attestation ──
//
// Raised in review, and it is the same limit `vendor-integrity.test.ts` already handles on the
// OpenClaw side: recomputing the hash of a local excerpt proves the excerpt was not edited
// after vendoring, not that it matches upstream. A concerted change to excerpt, hash and JSON
// stays green. So this VERIFIES where it can — against a reachable Hermes checkout, at the
// recorded tag and commit — and SAYS SO where it cannot, rather than implying a coverage it
// does not have.

describe("the vendored contract against the real upstream bytes", () => {
  const HERMES_ROOTS = [
    process.env.HERMES_SRC_DIR,
    `${process.env.HOME}/java/workspace_idea/hermes-upstream`,
  ].filter((r): r is string => typeof r === "string" && r.length > 0);

  const checkout = HERMES_ROOTS.find((r) =>
    existsSync(`${r}/gateway/platforms/api_server.py`),
  );

  it("the excerpt is the tag's own bytes, and the identity proofs hold", () => {
    if (checkout === undefined) {
      console.warn(
        "[hermes-rest-surface] upstream bytes UNVERIFIED — no Hermes checkout found. " +
          "The recorded hashes are self-attested here; set HERMES_SRC_DIR to verify them.",
      );
      return;
    }
    for (const version of vendoredVersions()) {
      const contract = contractFor(version);
      const prov = JSON.parse(
        readFileSync(new URL(`${version}/PROVENANCE.json`, PROTOCOL), "utf8"),
      ) as { restContract?: { upstreamTag: string; source: string; excerpt: string } };
      const rc = prov.restContract;
      if (rc === undefined) continue;
      const at = (ref: string): string =>
        execFileSync("git", ["-C", checkout, "show", `${ref}:${rc.source}`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
      const vendored = readFileSync(
        new URL(`${version}/${rc.excerpt}`, PROTOCOL),
        "utf8",
      ).replace(/\n$/, "");
      expect(
        extractPayload(at(rc.upstreamTag)),
        `${version}: the vendored excerpt is not what ${rc.upstreamTag} contains`,
      ).toBe(vendored);
      // …and every version claimed covered BY IDENTITY is re-proven from its own tag, rather
      // than trusted because a JSON field says so.
      for (const [other, proof] of Object.entries(contract.identityProofs ?? {})) {
        expect(
          extractPayload(at(proof.tag)),
          `${version}: ${other} (${proof.tag}) does not actually share this contract`,
        ).toBe(vendored);
      }
    }
  });
});
