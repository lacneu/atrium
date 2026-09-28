// Codex pass 14: with OPENCLAW_ENABLE_ANON_AUTH=1 a PUBLIC dev query checks neither
// identity nor chat access — anyone knowing a chat id can call it. What this lot added
// for the knowledge bench (collection names, the owner's handle, source ids, seating a
// participant) therefore lives on INTERNAL functions, which `npx convex run` reaches
// with the deployment's admin key and no client can call.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const DEV = readFileSync(new URL("./dev.ts", import.meta.url), "utf8");

/** The source of one exported function, up to the next top-level export. */
function exported(name: string): string {
  const start = DEV.indexOf(`export const ${name} =`);
  expect(start, `${name} is exported`).toBeGreaterThanOrEqual(0);
  const next = DEV.indexOf("\nexport ", start + 1);
  return DEV.slice(start, next === -1 ? undefined : next);
}

describe("public dev queries reveal ids and enums, never configuration", () => {
  test("inspectChat returns no provenance source family nor collection names", () => {
    const body = exported("inspectChat");
    expect(body).not.toMatch(/collections/);
    expect(body).not.toMatch(/retrieval/);
    expect(body).not.toMatch(/\bsource:\s*p\.part/);
  });

  test("the knowledge bench's helpers are internal functions", () => {
    expect(exported("inspectProvenanceDev")).toMatch(/^export const inspectProvenanceDev = internalQuery\(/);
    expect(exported("peekKnowledge")).toMatch(/^export const peekKnowledge = internalQuery\(/);
    expect(exported("seatParticipantDev")).toMatch(/^export const seatParticipantDev = internalMutation\(/);
  });
});
