// The drift detector's agent vocabulary is DERIVED from the vendored emission inventories,
// never typed (scripts/emission-vocabulary.mjs writes it; this file holds it to the
// derivation, element by element).
//
// THE DEFECT THIS GUARDS. `KNOWN_AGENT_STREAMS` was a hand-kept list from 2026.9.6, and
// four streams the gateway emits at 2026.9.36 (`acp`, `execution`, `fallback`, `notice`)
// were missing from it; no list of phases or `data` keys existed at all, so a new phase or
// key reached the wire with nothing to say so. The inventory reads the answer out of the
// code that emits the frames; this test makes the runtime literal agree with it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_EMISSION_VOCABULARY_VERSIONS,
  KNOWN_AGENT_ANY_STREAM_DATA_KEYS,
  KNOWN_AGENT_DATA_KEYS_BY_STREAM,
  KNOWN_AGENT_PHASES_BY_STREAM,
  KNOWN_AGENT_STREAMS,
  KNOWN_CHAT_CONTENT_PART_TYPES,
} from "../src/providers/openclaw/agent-emission-vocabulary.js";
import * as drift from "../src/providers/openclaw/protocol-drift.js";
import { promisedVersion } from "./helpers/vendored.js";
// @ts-expect-error — plain .mjs helper, no types
import { inventoryPairs, runtimeVocabulary } from "../scripts/lib/emission-vocabulary.mjs";
// @ts-expect-error — plain .mjs script, no types
import { expectedModule, inventoryVersions } from "../scripts/emission-vocabulary.mjs";

type Vocab = {
  streams: string[];
  phasesByStream: Record<string, string[]>;
  keysByStream: Record<string, string[]>;
  anyStreamKeys: string[];
  chatContentPartTypes: string[];
};

const VERSIONS = inventoryVersions() as string[];
const inventoryOf = (v: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../protocol/openclaw/${v}/agent-emissions.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
const VOCAB = runtimeVocabulary(VERSIONS.map(inventoryOf)) as Vocab;

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();
const recordOf = (r: Readonly<Record<string, ReadonlySet<string>>>): Record<string, string[]> =>
  Object.fromEntries(Object.keys(r).sort().map((k) => [k, sorted(r[k]!)]));

describe("agent vocabulary == the vendored emission inventories", () => {
  it("is derived from an inventory of the PROMISED version", () => {
    // The ratchet classifies the promised version's inventory; a vocabulary that did not
    // include it would judge the live wire against a contract nobody promised.
    expect(VERSIONS).toContain(promisedVersion());
    expect([...AGENT_EMISSION_VOCABULARY_VERSIONS]).toEqual(VERSIONS);
  });

  it("streams, element by element", () => {
    expect(sorted(KNOWN_AGENT_STREAMS)).toEqual(VOCAB.streams);
  });

  it("phases per stream, element by element", () => {
    expect(Object.keys(KNOWN_AGENT_PHASES_BY_STREAM).sort()).toEqual(Object.keys(VOCAB.phasesByStream));
    for (const [stream, phases] of Object.entries(VOCAB.phasesByStream)) {
      expect(sorted(KNOWN_AGENT_PHASES_BY_STREAM[stream]!), stream).toEqual(phases);
    }
  });

  it("data keys per stream, element by element", () => {
    expect(Object.keys(KNOWN_AGENT_DATA_KEYS_BY_STREAM).sort()).toEqual(Object.keys(VOCAB.keysByStream));
    for (const [stream, keys] of Object.entries(VOCAB.keysByStream)) {
      expect(sorted(KNOWN_AGENT_DATA_KEYS_BY_STREAM[stream]!), stream).toEqual(keys);
    }
    expect(sorted(KNOWN_AGENT_ANY_STREAM_DATA_KEYS)).toEqual(VOCAB.anyStreamKeys);
  });

  it("chat content-part types, element by element", () => {
    expect(sorted(KNOWN_CHAT_CONTENT_PART_TYPES)).toEqual(VOCAB.chatContentPartTypes);
  });

  it("the detector reads THESE sets — one definition, re-exported", () => {
    expect(drift.KNOWN_AGENT_STREAMS).toBe(KNOWN_AGENT_STREAMS);
    expect(drift.KNOWN_CHAT_CONTENT_PART_TYPES).toBe(KNOWN_CHAT_CONTENT_PART_TYPES);
  });

  it("the module is exactly what the generator writes", () => {
    const onDisk = readFileSync(
      new URL("../src/providers/openclaw/agent-emission-vocabulary.ts", import.meta.url),
      "utf8",
    );
    expect(onDisk, "stale — run `node scripts/emission-vocabulary.mjs --write`").toBe(expectedModule());
  });

  it("is not vacuous: the 2026.9.36 inventory names the streams the hand list missed", () => {
    for (const s of ["acp", "execution", "fallback", "notice", "run_status", "lifecycle"]) {
      expect(KNOWN_AGENT_STREAMS.has(s), s).toBe(true);
    }
    expect(KNOWN_AGENT_PHASES_BY_STREAM.lifecycle!.has("waiting-approval")).toBe(true);
    expect(KNOWN_AGENT_PHASES_BY_STREAM.tool!.has("input_delta")).toBe(true);
    expect(KNOWN_AGENT_DATA_KEYS_BY_STREAM.lifecycle!.has("executionSettled")).toBe(true);
  });
});

describe("the vocabulary reads the inventory the way the inventory reads itself", () => {
  // The library restates the inventory's text forms (`-`, `<opaque>`) instead of importing
  // them; its pairs must therefore be EXACTLY the extractor's own summary, plus the frames
  // the gateway fabricates (which the summary, built from emission rows, does not hold).
  for (const v of VERSIONS) {
    it(v, () => {
      const inv = inventoryOf(v) as {
        summary: Record<string, { phases: Record<string, { keys: Record<string, string> }> }>;
        transformations: { fabricated: { stream: string; phaseAbsent: boolean; phase: string | null }[] };
      };
      const fromSummary = new Set<string>();
      for (const [s, st] of Object.entries(inv.summary)) {
        for (const p of Object.keys(st.phases)) fromSummary.add(`${s}|${p}`);
      }
      for (const g of inv.transformations.fabricated) {
        fromSummary.add(`${g.stream}|${g.phaseAbsent ? "-" : g.phase ?? "<opaque>"}`);
      }
      const pairs = inventoryPairs(inv) as Map<string, { stream: string; phase: string; keys: Map<string, string> }>;
      expect(new Set([...pairs.values()].map((p) => `${p.stream}|${p.phase}`))).toEqual(fromSummary);
      // …and every key the summary lists for a pair is a key of that pair.
      for (const p of pairs.values()) {
        const summaryKeys = Object.keys(inv.summary[p.stream]?.phases[p.phase]?.keys ?? {});
        for (const k of summaryKeys) expect(p.keys.has(k), `${p.stream}/${p.phase}.${k}`).toBe(true);
      }
    });
  }
});
