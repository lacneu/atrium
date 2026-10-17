/**
 * The closed vocabularies of an answered refusal's trace shape (dispatch-errors.ts
 * `GATEWAY_ERROR_CODES`, `GATEWAY_DETAIL_KEYS`) are UPSTREAM's, not ours.
 *
 * A trace administrators read may carry a gateway error code and the NAMES of a refusal's
 * `details` keys — and only names upstream declares (codex: a syntax filter let
 * `SYNTHETIC_SECRET_VALUE` through). So each list is confronted with its source:
 *  - always (CI included), the VENDORED schemas at `DRIFT_VENDORED_VERSION`: every key of
 *    `AgentDatabaseAdmissionRefusal` and of the worker error details is in the key list, and
 *    every worker error code is in the code list;
 *  - when the bench's checkout of that tag is reachable, `ErrorCodes` and every
 *    `*ErrorDetails` type of packages/gateway-protocol/src/gateway-error-details.ts — a
 *    module the bridge does not vendor — read through git objects at the tag. Without it the
 *    test says so instead of reporting a verification it has not done.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GATEWAY_DETAIL_KEYS, GATEWAY_ERROR_CODES } from "../src/core/dispatch-errors.js";
import { DRIFT_VENDORED_VERSION } from "../src/providers/openclaw/protocol-drift.js";
import * as admission from "../protocol/openclaw/2026.9.33/agent-database-admission.js";
import * as worker from "../protocol/openclaw/2026.9.33/worker-protocol-primitives.js";

type Schema = { anyOf?: Schema[]; properties?: Record<string, Schema>; const?: unknown };
const objects = (s: Schema): Schema[] => (s.anyOf ? s.anyOf.flatMap(objects) : [s]);

describe("the answered-refusal vocabularies are upstream's", () => {
  it("the vendored modules read here are the drift detector's version", () => {
    expect(DRIFT_VENDORED_VERSION).toBe("2026.9.33");
  });

  it("vendored: every documented details key and worker error code is in the lists", () => {
    const keys = new Set<string>();
    for (const o of objects(admission.AgentDatabaseAdmissionRefusalSchema as unknown as Schema)) {
      for (const k of Object.keys(o.properties ?? {})) keys.add(k);
    }
    const shape = worker.WorkerErrorShapeSchema as unknown as Schema;
    for (const k of Object.keys(shape.properties!.details!.properties ?? {})) keys.add(k);
    expect(keys.size).toBeGreaterThan(0);
    expect([...keys].filter((k) => !GATEWAY_DETAIL_KEYS.includes(k))).toEqual([]);
    const codes = objects(shape.properties!.code!).map((c) => c.const);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((c) => !GATEWAY_ERROR_CODES.includes(String(c)))).toEqual([]);
  });

  it(`upstream v${DRIFT_VENDORED_VERSION}: ErrorCodes and the *ErrorDetails keys, exactly`, () => {
    const parent =
      process.env.OPENCLAW_UPSTREAM_SRC_ROOT ??
      `${process.env.HOME}/java/workspace_idea/openclaw-notes/atrium/upstream-src`;
    const root = `${parent}/openclaw-${DRIFT_VENDORED_VERSION}`;
    let src: string;
    try {
      if (!existsSync(`${root}/.git`)) throw new Error(`no git checkout at ${root}`);
      src = execFileSync(
        "git",
        ["-C", root, "show", `v${DRIFT_VENDORED_VERSION}:packages/gateway-protocol/src/gateway-error-details.ts`],
        { encoding: "utf8" },
      );
    } catch (e) {
      console.warn(
        `[answered-refusal-vocabulary] UNVERIFIED against upstream: ${(e as Error).message}. ` +
          `Set OPENCLAW_UPSTREAM_SRC_ROOT to a directory holding openclaw-${DRIFT_VENDORED_VERSION}/.`,
      );
      return;
    }
    const codesBlock = /export const ErrorCodes = \{([\s\S]*?)\} as const;/.exec(src)?.[1];
    expect(codesBlock, "ErrorCodes moved or changed shape upstream").toBeDefined();
    const upstreamCodes = [...codesBlock!.matchAll(/^\s+([A-Z_]+):\s*"([A-Z_]+)"/gm)].map((m) => m[2]!);
    expect([...upstreamCodes].sort()).toEqual([...GATEWAY_ERROR_CODES].sort());

    const detailKeys = new Set<string>();
    for (const block of src.matchAll(/export type \w+ErrorDetails = \{([\s\S]*?)\};/g)) {
      for (const m of block[1]!.matchAll(/^\s+(\w+)\??:/gm)) detailKeys.add(m[1]!);
    }
    expect(detailKeys.size).toBeGreaterThan(5);
    expect([...detailKeys].filter((k) => !GATEWAY_DETAIL_KEYS.includes(k))).toEqual([]);
  });

  it("nothing in the key list is ours: each name comes from one of the two sources", () => {
    // The reverse direction, against the vendored half plus the upstream names written in
    // the list's comment — so a name added "just in case" fails here.
    const upstreamOnly = [
      "cause",
      "currentCount",
      "currentRevisionHash",
      "cwd",
      "expectedRevisionHash",
      "idempotencyKey",
      "jobId",
      "limit",
      "missingScope",
      "recoveryAction",
      "requiredScopes",
      "sessionId",
      "source",
    ];
    const vendored = new Set<string>();
    for (const o of objects(admission.AgentDatabaseAdmissionRefusalSchema as unknown as Schema)) {
      for (const k of Object.keys(o.properties ?? {})) vendored.add(k);
    }
    vendored.add("reason");
    expect(GATEWAY_DETAIL_KEYS.filter((k) => !vendored.has(k) && !upstreamOnly.includes(k))).toEqual([]);
  });
});
