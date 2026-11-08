// The EMISSION classification ratchet: every (stream, phase) pair and every `data` key the
// gateway can put on the `agent` channel is classified — handled, ignored or a named gap —
// before a version is promised.
//
// THE DEFECT THIS GUARDS. The per-version tooling compared the protocol's SCHEMAS, and
// `AgentEventSchema.data` has none upstream (`Record<string, unknown>`): which streams,
// phases and keys a frame carries was a hand-kept list, so a new phase or key reached the
// wire with nobody asked what Atrium does with it. The vendored inventory
// (protocol/openclaw/<version>/agent-emissions.json, derived from the emitting code) now
// says what CAN arrive; this registry (protocol/openclaw/emissions/<version>.json) says
// what Atrium does with each — and this test refuses the version until both agree.
//
//   1. COMPLETE: every pair of the promised version's inventory, every key an emission row
//      or a gateway-fabricated frame writes, and every key a gateway rewrite adds, has an
//      entry;
//   2. CURRENT: no entry names a pair, key or rewrite the inventory no longer emits — a
//      stale claim misleads exactly as much as a missing one;
//   3. TRUE AS FAR AS A TEST CAN SEE: `handled` carries an anchor present in the
//      comment-stripped bridge source (the coverage-truth rule, one helper) and a proof
//      this test VERIFIES — a golden capture that carries the pair or key, or a
//      deterministic test that names it and says why no capture can; `gap` names its
//      identifier and its impact; `ignored` says why, and a why that describes a breakage
//      is refused (the frame-discovery rule: that is a gap).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { anchorViolations } from "./helpers/coverage-rules.js";
import { promisedVersion } from "./helpers/vendored.js";
// @ts-expect-error — plain .mjs helper, no types
import { NO_PHASE, OPAQUE, guardAdmits, inventoryPairs, streamText } from "../scripts/lib/emission-vocabulary.mjs";

const STATUSES = ["handled", "ignored", "gap"] as const;
const PROOF_KINDS = ["golden-corpus", "deterministic-test"] as const;

interface Entry {
  status: (typeof STATUSES)[number];
  by?: string;
  why?: string;
  note?: string;
  gap?: string;
  anchor?: { file: string; token: string };
  proof?: { kind: string; ref: string; note?: string };
}
interface Registry {
  version: string;
  streams: Record<string, { phases: Record<string, Entry>; keys: Record<string, Entry> }>;
  rewrites: Record<string, Entry>;
}
interface Rewrite {
  scope: string;
  function: string;
  added: string[];
  guard: { stream?: string[]; phase?: string[]; negated: boolean }[];
}
interface Inventory {
  emissions: { stream: string | null; keys: { key: string }[] }[];
  transformations: { fabricated: { stream: string; keys: string[] }[]; dataRewrites: Rewrite[] };
}
type Pair = { stream: string; phase: string; keys: Map<string, string> };

const PROTOCOL = new URL("../protocol/openclaw/", import.meta.url);
const GOLDEN = new URL("./fixtures/golden/", import.meta.url);

/** A why that DESCRIBES A BREAKAGE is a gap (frame-discovery step 4, the offerHeaders
 *  lesson). Lexical, so it is a floor, not a judgment: it catches the plain admission
 *  ("the card is lost", "the label is wrong") that an `ignored` must never make. */
const BREAKAGE = /\b(broken|breaks?|bug(gy)?|defect(ive)?|wrong(ly)?|incorrect(ly)?|regression|misread|mis-?classif\w*|corrupt\w*|stale|lost|loses?|fail(s|ed)? to)\b/i;
const GAP_ID = /^[A-Z]{1,2}[0-9]{1,3}$/;
const MASKED_NAME = /^[xX]+$/;

const registryVersions = (): string[] =>
  existsSync(new URL("emissions/", PROTOCOL))
    ? readdirSync(new URL("emissions/", PROTOCOL))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
    : [];
const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf-8")) as T;
const registryOf = (v: string): Registry => readJson<Registry>(new URL(`emissions/${v}.json`, PROTOCOL));
const inventoryOf = (v: string): Inventory => readJson<Inventory>(new URL(`${v}/agent-emissions.json`, PROTOCOL));

const rewriteId = (rw: Rewrite, key: string): string => `${rw.scope}:${rw.function}:${key}`;

/** What the inventory says can arrive, in the registry's terms. */
function expected(inv: Inventory): {
  pairs: Map<string, Pair>;
  rowKeys: Map<string, Set<string>>;
  rewriteKeys: Map<string, Set<string>>;
  rewrites: Map<string, { rw: Rewrite; key: string }>;
} {
  const pairs = new Map<string, Pair>();
  for (const p of (inventoryPairs(inv) as Map<string, Pair>).values()) pairs.set(`${p.stream}\u0000${p.phase}`, p);
  // Keys WRITTEN by an emitter (a row) or by the gateway's own fabricated frame.
  const rowKeys = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, s: string, k: string): void => {
    if (!m.has(s)) m.set(s, new Set());
    m.get(s)!.add(k);
  };
  for (const e of inv.emissions) for (const k of e.keys) add(rowKeys, streamText(e) as string, k.key);
  for (const g of inv.transformations.fabricated) for (const k of g.keys) add(rowKeys, g.stream ?? OPAQUE, k);
  // Keys a rewrite ADDS after emission, on the pairs its guard admits.
  const rewriteKeys = new Map<string, Set<string>>();
  const rewrites = new Map<string, { rw: Rewrite; key: string }>();
  for (const rw of inv.transformations.dataRewrites) {
    for (const key of rw.added) {
      rewrites.set(rewriteId(rw, key), { rw, key });
      for (const p of pairs.values()) {
        if (guardAdmits(rw.guard, p.stream, p.phase)) add(rewriteKeys, p.stream, key);
      }
    }
  }
  return { pairs, rowKeys, rewriteKeys, rewrites };
}

/** Agent frames of one golden capture, keyed for the proof checks. */
const CAPTURES = new Map<string, { stream: string; phase: string; keys: string[] }[]>();
function captureOf(version: string, ref: string): { stream: string; phase: string; keys: string[] }[] | null {
  const [v, scenario] = ref.includes("/") ? (ref.split("/", 2) as [string, string]) : [version, ref];
  const url = new URL(`${v}/${scenario}.jsonl`, GOLDEN);
  const key = url.pathname;
  if (CAPTURES.has(key)) return CAPTURES.get(key)!;
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(v) || !/^[a-z0-9-]+$/.test(scenario) || !existsSync(url)) return null;
  const frames: { stream: string; phase: string; keys: string[] }[] = [];
  for (const line of readFileSync(url, "utf-8").split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const f = (JSON.parse(line) as { frame?: { type?: string; event?: string; payload?: Record<string, unknown> } }).frame;
    if (f?.type !== "event" || f.event !== "agent" || typeof f.payload?.stream !== "string") continue;
    const data = f.payload.data;
    const d = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    frames.push({
      stream: f.payload.stream,
      phase: "phase" in d ? String(d.phase) : NO_PHASE,
      keys: Object.keys(d).filter((k) => !MASKED_NAME.test(k)),
    });
  }
  CAPTURES.set(key, frames);
  return frames;
}

/** Every entry of a registry, with what it classifies. */
function entriesOf(reg: Registry): { where: string; e: Entry; kind: "pair" | "key" | "rewrite"; stream?: string; name: string }[] {
  const out: { where: string; e: Entry; kind: "pair" | "key" | "rewrite"; stream?: string; name: string }[] = [];
  for (const [s, st] of Object.entries(reg.streams)) {
    for (const [p, e] of Object.entries(st.phases ?? {})) out.push({ where: `${s} / ${p}`, e, kind: "pair", stream: s, name: p });
    for (const [k, e] of Object.entries(st.keys ?? {})) out.push({ where: `${s}.${k}`, e, kind: "key", stream: s, name: k });
  }
  for (const [id, e] of Object.entries(reg.rewrites ?? {})) out.push({ where: `rewrite ${id}`, e, kind: "rewrite", name: id });
  return out;
}

describe("emission classification — the registry and the inventory agree", () => {
  it("the meta-schema and this test agree on the enums (lockstep)", () => {
    const meta = readJson<{ $defs: { status: { enum: string[] }; proofKind: { enum: string[] } } }>(
      new URL("../protocol/emissions.schema.json", import.meta.url),
    );
    expect(meta.$defs.status.enum).toEqual([...STATUSES]);
    expect(meta.$defs.proofKind.enum).toEqual([...PROOF_KINDS]);
  });

  it("the PROMISED version has an inventory and a registry", () => {
    const v = promisedVersion();
    expect(existsSync(new URL(`${v}/agent-emissions.json`, PROTOCOL)), `no inventory for ${v} — vendor it`).toBe(true);
    expect(registryVersions(), `no emission registry for ${v} — classify its inventory`).toContain(v);
  });

  for (const version of registryVersions()) {
    describe(version, () => {
      const reg = registryOf(version);
      const inv = inventoryOf(version);
      const want = expected(inv);

      it("names its version", () => {
        expect(reg.version).toBe(version);
      });

      it("classifies EVERY emitted (stream, phase)", () => {
        const missing = [...want.pairs.values()]
          .filter((p) => reg.streams[p.stream]?.phases?.[p.phase] === undefined)
          .map((p) => `${p.stream} / ${p.phase}`);
        expect(missing, "unclassified emissions — classify each (frame-discovery)").toEqual([]);
      });

      it("classifies EVERY data key an emitter writes, and every key a rewrite adds", () => {
        const missing: string[] = [];
        for (const [s, keys] of want.rowKeys) {
          for (const k of keys) if (reg.streams[s]?.keys?.[k] === undefined) missing.push(`${s}.${k}`);
        }
        for (const id of want.rewrites.keys()) if (reg.rewrites?.[id] === undefined) missing.push(`rewrite ${id}`);
        expect(missing, "unclassified data keys — classify each (frame-discovery)").toEqual([]);
      });

      it("names nothing the version no longer emits", () => {
        const stale: string[] = [];
        for (const [s, st] of Object.entries(reg.streams)) {
          for (const p of Object.keys(st.phases ?? {})) {
            if (!want.pairs.has(`${s}\u0000${p}`)) stale.push(`${s} / ${p}`);
          }
          for (const k of Object.keys(st.keys ?? {})) {
            if (!want.rowKeys.get(s)?.has(k) && !want.rewriteKeys.get(s)?.has(k)) stale.push(`${s}.${k}`);
          }
        }
        for (const id of Object.keys(reg.rewrites ?? {})) if (!want.rewrites.has(id)) stale.push(`rewrite ${id}`);
        expect(stale, "entries for emissions this version no longer has — remove them").toEqual([]);
      });

      it("every entry carries the prose its status owes, and only handled carries anchor and proof", () => {
        const bad: string[] = [];
        for (const { where, e } of entriesOf(reg)) {
          if (!(STATUSES as readonly string[]).includes(e.status)) {
            bad.push(`${where}: unknown status ${JSON.stringify(e.status)}`);
            continue;
          }
          if (e.status === "handled" && !(e.by ?? "").trim()) bad.push(`${where}: handled requires \`by\``);
          if (e.status === "ignored") {
            if ((e.why ?? "").trim().length < 10) bad.push(`${where}: ignored requires a \`why\``);
            else if (BREAKAGE.test(e.why!)) {
              bad.push(`${where}: this why describes a breakage — that is a gap, not an ignored (${e.why!.match(BREAKAGE)![0]})`);
            }
          }
          if (e.status === "gap") {
            if (!GAP_ID.test(e.gap ?? "")) bad.push(`${where}: a gap names its écart identifier (e.g. F1), not ${JSON.stringify(e.gap)}`);
            if ((e.note ?? "").trim().length < 10) bad.push(`${where}: a gap states its impact (\`note\`)`);
          } else if (e.gap !== undefined) {
            bad.push(`${where}: only a gap carries a gap identifier`);
          }
          if (e.status !== "handled" && (e.anchor !== undefined || e.proof !== undefined)) {
            bad.push(`${where}: only handled carries an anchor or a proof`);
          }
        }
        expect(bad).toEqual([]);
      });

      it("a handled entry anchors code that exists (the coverage-truth rule)", () => {
        const handled = Object.fromEntries(entriesOf(reg).map(({ where, e }) => [where, e]));
        expect(anchorViolations(handled, `emissions ${version}`)).toEqual([]);
      });

      it("a handled entry's PROOF shows the pair or key — verified, not cited", () => {
        const bad: string[] = [];
        for (const x of entriesOf(reg)) {
          if (x.e.status !== "handled") continue;
          const p = x.e.proof;
          if (p === undefined) {
            bad.push(`${x.where}: handled requires a proof {kind, ref}`);
            continue;
          }
          if (p.kind === "golden-corpus") {
            const frames = captureOf(version, p.ref);
            if (frames === null) {
              bad.push(`${x.where}: no golden capture ${p.ref}`);
              continue;
            }
            let shown: boolean;
            if (x.kind === "pair") {
              shown = x.name !== OPAQUE && frames.some((f) => f.stream === x.stream && f.phase === x.name);
            } else if (x.kind === "key") {
              shown = frames.some((f) => f.stream === x.stream && f.keys.includes(x.name));
            } else {
              const rw = want.rewrites.get(x.name);
              shown =
                rw !== undefined &&
                frames.some((f) => f.keys.includes(rw.key) && guardAdmits(rw.rw.guard, f.stream, f.phase));
            }
            if (!shown) bad.push(`${x.where}: the capture ${p.ref} does not carry it — cite one that does, or a deterministic test`);
          } else if (p.kind === "deterministic-test") {
            if (!/^bridge\/test\/[A-Za-z0-9_./-]+\.test\.ts$/.test(p.ref) || p.ref.includes("..")) {
              bad.push(`${x.where}: a deterministic proof names a bridge test file, not ${p.ref}`);
              continue;
            }
            const at = new URL(`../../${p.ref}`, import.meta.url);
            if (!existsSync(at)) {
              bad.push(`${x.where}: proof file ${p.ref} does not exist`);
              continue;
            }
            if ((p.note ?? "").trim().length < 10) bad.push(`${x.where}: a deterministic proof says why no capture shows it`);
            // The test must at least NAME what it is said to prove.
            const named =
              x.kind === "pair" ? (x.name === NO_PHASE || x.name === OPAQUE ? x.stream! : x.name) : x.kind === "key" ? x.name : want.rewrites.get(x.name)?.key ?? x.name;
            if (!readFileSync(at, "utf-8").includes(named)) {
              bad.push(`${x.where}: ${p.ref} never names "${named}"`);
            }
          } else {
            bad.push(`${x.where}: unknown proof kind ${JSON.stringify(p.kind)}`);
          }
        }
        expect(bad).toEqual([]);
      });
    });
  }
});
