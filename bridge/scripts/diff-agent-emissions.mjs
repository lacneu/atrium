#!/usr/bin/env node
// Compare two agent-emission inventories (lib/derive-agent-emissions.mjs) and write a
// readable Markdown report: streams, phases and data keys added or removed, emission
// rows added, removed, modified or moved, and opaque entries that appeared.
//
//   node scripts/diff-agent-emissions.mjs <old.json> <new.json> [--out report.md]
//
// Comparison is by the inventory's STABLE keys — stream, phase, sorted key set, file and
// function label — never by line number: a version that only shifted code produces an
// empty "emission rows" section, and line moves are counted apart so they cannot drown
// a real change.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The (stream, phase) a row belongs to, as text. `-` = no phase key; `<opaque>` = unresolved. */
const streamText = (e) => e.stream ?? `<opaque${e.streamOpaque?.pattern ? `:${e.streamOpaque.pattern}` : ""}>`;
const phaseText = (e) => (e.phaseAbsent ? "-" : e.phase === null ? "<opaque>" : String(e.phase));
const pairText = (e) => `${streamText(e)} / ${phaseText(e)}`;
const keySet = (e) => e.keys.map((k) => k.key).join(",");
/** Line-free identity of a row's SHAPE (what reaches the wire). */
const shapeOf = (e) => `${streamText(e)}|${phaseText(e)}|${keySet(e)}`;
/** Line-free identity of a row's PLACE (who emits it). */
const placeOf = (e) => `${e.file}|${e.function}`;

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort(cmp);
}

/** stream → phase → Map<key, "always"|"optional"> over every row. */
function vocabulary(inv) {
  const out = new Map();
  for (const e of inv.emissions) {
    const s = streamText(e);
    const p = phaseText(e);
    if (!out.has(s)) out.set(s, new Map());
    const phases = out.get(s);
    if (!phases.has(p)) phases.set(p, new Map());
    const keys = phases.get(p);
    for (const k of e.keys) {
      const prev = keys.get(k.key);
      keys.set(k.key, prev === undefined ? (k.optional ? "optional" : "always") : prev === "always" && !k.optional ? "always" : "optional");
    }
  }
  return out;
}

const opaqueId = (o) => `${o.file}|${o.function}|${o.what}|${o.stream ?? ""}|${o.reason}`;
const escapeId = (o) => `${o.function}|${o.reason}`;
const familyId = (f) => `${f.kind}|${f.label}|${f.names.join(",")}|${(f.at ?? "").replace(/:\d+$/, "")}`;
const fabricatedId = (g) => `${g.stream}|${g.phaseAbsent ? "-" : g.phase}|${g.keys.join(",")}|${g.file}|${g.function}`;

/**
 * The report, as Markdown.
 * @param {object} a  older inventory
 * @param {object} b  newer inventory
 */
export function diffInventories(a, b) {
  const lines = [];
  const va = a.upstream?.version ?? "old";
  const vb = b.upstream?.version ?? "new";
  const push = (...l) => lines.push(...l);
  const list = (title, items, fmt = (x) => `\`${x}\``) => {
    push(`### ${title} (${items.length})`, "");
    if (items.length === 0) push("_none_", "");
    else push(...items.map((x) => `- ${fmt(x)}`), "");
  };

  push(`# Agent emissions: ${va} → ${vb}`, "");
  push(
    "| | " + va + " | " + vb + " |",
    "|---|---|---|",
    `| commit | ${a.upstream?.commit ?? "?"} | ${b.upstream?.commit ?? "?"} |`,
    `| emission rows | ${a.emissions.length} | ${b.emissions.length} |`,
    `| emission sites | ${a.emissions.reduce((n, e) => n + e.lines.length, 0)} | ${b.emissions.reduce((n, e) => n + e.lines.length, 0)} |`,
    `| streams | ${Object.keys(a.summary).length} | ${Object.keys(b.summary).length} |`,
    `| family members | ${a.family.length} | ${b.family.length} |`,
    `| opaque rows | ${a.opaque.length} | ${b.opaque.length} |`,
    `| unfollowed escapes | ${a.escapes.length} | ${b.escapes.length} |`,
    `| identifiers accounted (matched + homonyms / total) | ${a.completeness.matched} + ${a.completeness.homonyms} / ${a.completeness.identifiers} | ${b.completeness.matched} + ${b.completeness.homonyms} / ${b.completeness.identifiers} |`,
    "",
  );

  // ---- vocabulary ------------------------------------------------------------------------
  const vocA = vocabulary(a);
  const vocB = vocabulary(b);
  push("## Vocabulary", "");
  list("Streams added", setDiff(new Set(vocB.keys()), new Set(vocA.keys())));
  list("Streams removed", setDiff(new Set(vocA.keys()), new Set(vocB.keys())));
  const pairs = (voc) => new Set([...voc].flatMap(([s, ph]) => [...ph.keys()].map((p) => `${s} / ${p}`)));
  list("(stream, phase) added", setDiff(pairs(vocB), pairs(vocA)));
  list("(stream, phase) removed", setDiff(pairs(vocA), pairs(vocB)));
  const keyChanges = [];
  for (const [s, phB] of [...vocB].sort((x, y) => cmp(x[0], y[0]))) {
    for (const [p, kB] of [...phB].sort((x, y) => cmp(x[0], y[0]))) {
      const kA = vocA.get(s)?.get(p);
      if (!kA) continue;
      const added = setDiff(new Set(kB.keys()), new Set(kA.keys()));
      const removed = setDiff(new Set(kA.keys()), new Set(kB.keys()));
      const flipped = [...kB.keys()].filter((k) => kA.has(k) && kA.get(k) !== kB.get(k)).sort(cmp).map((k) => `${k}: ${kA.get(k)}→${kB.get(k)}`);
      if (added.length || removed.length || flipped.length) keyChanges.push({ s, p, added, removed, flipped });
    }
  }
  push(`### Data keys changed on an existing (stream, phase) (${keyChanges.length})`, "");
  if (keyChanges.length === 0) push("_none_", "");
  for (const c of keyChanges) {
    const parts = [];
    if (c.added.length) parts.push(`added ${c.added.map((k) => `\`${k}\``).join(", ")}`);
    if (c.removed.length) parts.push(`removed ${c.removed.map((k) => `\`${k}\``).join(", ")}`);
    if (c.flipped.length) parts.push(`presence ${c.flipped.map((k) => `\`${k}\``).join(", ")}`);
    push(`- \`${c.s} / ${c.p}\`: ${parts.join("; ")}`);
  }
  if (keyChanges.length) push("");
  // Keys of NEW pairs, so a new phase is not reported without its shape.
  const newPairs = setDiff(pairs(vocB), pairs(vocA));
  if (newPairs.length) {
    push("### Keys of the added (stream, phase)", "");
    for (const pr of newPairs) {
      const [s, p] = pr.split(" / ");
      const keys = vocB.get(s)?.get(p) ?? new Map();
      push(`- \`${pr}\`: ${[...keys].sort((x, y) => cmp(x[0], y[0])).map(([k, v]) => `\`${k}\`${v === "optional" ? "?" : ""}`).join(", ") || "_no data keys_"}`);
    }
    push("");
  }

  // ---- rows ------------------------------------------------------------------------------
  push("## Emission rows", "");
  const keysA = new Map(a.emissions.map((e) => [e.key, e]));
  const keysB = new Map(b.emissions.map((e) => [e.key, e]));
  const onlyA = a.emissions.filter((e) => !keysB.has(e.key));
  const onlyB = b.emissions.filter((e) => !keysA.has(e.key));
  // MODIFIED: same place and (stream, phase), different key set.
  const modified = [];
  const usedA = new Set();
  const usedB = new Set();
  for (const eb of onlyB) {
    const ea = onlyA.find((x) => !usedA.has(x) && placeOf(x) === placeOf(eb) && pairText(x) === pairText(eb));
    if (ea) {
      usedA.add(ea);
      usedB.add(eb);
      const ka = new Set(ea.keys.map((k) => k.key));
      const kb = new Set(eb.keys.map((k) => k.key));
      modified.push({ ea, eb, added: setDiff(kb, ka), removed: setDiff(ka, kb) });
    }
  }
  // MOVED: same shape, different place.
  const moved = [];
  for (const eb of onlyB) {
    if (usedB.has(eb)) continue;
    const ea = onlyA.find((x) => !usedA.has(x) && shapeOf(x) === shapeOf(eb));
    if (ea) {
      usedA.add(ea);
      usedB.add(eb);
      moved.push({ ea, eb });
    }
  }
  const fmtRow = (e) => `\`${pairText(e)}\` keys [${e.keys.map((k) => `${k.key}${k.optional ? "?" : ""}`).join(", ")}] — ${e.file}:${e.lines.join(",")} \`${e.function}\` via \`${e.emitter}\``;
  list("Rows added", onlyB.filter((e) => !usedB.has(e)), fmtRow);
  list("Rows removed", onlyA.filter((e) => !usedA.has(e)), fmtRow);
  push(`### Rows modified (same place and (stream, phase), other keys) (${modified.length})`, "");
  if (modified.length === 0) push("_none_", "");
  for (const m of modified) {
    push(`- \`${pairText(m.eb)}\` at ${m.eb.file} \`${m.eb.function}\`: ${m.added.length ? `+${m.added.join(", +")}` : ""}${m.added.length && m.removed.length ? " " : ""}${m.removed.length ? `−${m.removed.join(", −")}` : ""}`);
  }
  if (modified.length) push("");
  list("Rows moved (same shape, other file or function)", moved, (m) => `\`${pairText(m.eb)}\` [${keySet(m.eb)}]: ${m.ea.file} \`${m.ea.function}\` → ${m.eb.file} \`${m.eb.function}\``);
  const shifted = b.emissions.filter((e) => keysA.has(e.key) && keysA.get(e.key).lines.join(",") !== e.lines.join(","));
  push(`Unchanged rows whose line numbers moved: ${shifted.length} (not listed).`, "");

  // ---- opaque & escapes --------------------------------------------------------------------
  push("## Opaque entries", "");
  const oa = new Set(a.opaque.map(opaqueId));
  const ob = new Set(b.opaque.map(opaqueId));
  const fmtOpaque = (o) => `${o.what} at ${o.file}:${o.line} \`${o.function}\`${o.stream ? ` (stream ${o.stream})` : ""}: ${o.reason}${o.origin ? ` — from ${o.origin}` : ""}`;
  list("New opaque entries", b.opaque.filter((o) => !oa.has(opaqueId(o))), fmtOpaque);
  list("Opaque entries gone", a.opaque.filter((o) => !ob.has(opaqueId(o))), fmtOpaque);
  const ea = new Set(a.escapes.map(escapeId));
  const eb = new Set(b.escapes.map(escapeId));
  list("New unfollowed escapes", b.escapes.filter((o) => !ea.has(escapeId(o))), (o) => `${o.at} \`${o.function}\`: ${o.reason}`);
  list("Unfollowed escapes gone", a.escapes.filter((o) => !eb.has(escapeId(o))), (o) => `${o.at} \`${o.function}\`: ${o.reason}`);

  // ---- family ------------------------------------------------------------------------------
  push("## Emitter family", "");
  const fa = new Set(a.family.map(familyId));
  const fb = new Set(b.family.map(familyId));
  const fmtFam = (f) => `${f.kind} \`${f.label}\` (${f.names.join(", ")}) at ${f.at} → ${f.chain.slice(1).join(" → ")}`;
  list("Members added", b.family.filter((f) => !fa.has(familyId(f))), fmtFam);
  list("Members removed", a.family.filter((f) => !fb.has(familyId(f))), fmtFam);

  // ---- open entries ------------------------------------------------------------------------
  push("## Open entries (callers outside the analysed sources)", "");
  const openId = (o) => `${o.kind}|${o.label}|${(o.at ?? "").replace(/:\d+$/, "")}|${JSON.stringify(o.shapes)}`;
  const oea = new Set(a.openEntries.map(openId));
  const oeb = new Set(b.openEntries.map(openId));
  const fmtOpen = (o) => `${o.kind} \`${o.label}\` at ${o.at}: ${o.shapes.map((sh) => `${sh.streams.map((x) => (x.caller ? "<caller>" : x.value ?? "<opaque>")).join("|") || "∅"} [${sh.keys.map((k) => `${k.key}${k.optional ? "?" : ""}`).join(", ")}${sh.dataFromCaller ? `${sh.keys.length ? ", " : ""}…caller` : ""}]`).join("; ")}`;
  list("Open entries added or changed", b.openEntries.filter((o) => !oea.has(openId(o))), fmtOpen);
  list("Open entries removed or changed", a.openEntries.filter((o) => !oeb.has(openId(o))), fmtOpen);

  // ---- transformations ---------------------------------------------------------------------
  push("## Transformations after emission (bus enrichment, gateway relay)", "");
  const ga = new Set(a.transformations.fabricated.map(fabricatedId));
  const gb = new Set(b.transformations.fabricated.map(fabricatedId));
  const fmtFab = (g) => `\`${g.stream} / ${g.phaseAbsent ? "-" : g.phase}\` [${g.keys.join(", ")}] by \`${g.sender}\` at ${g.file}:${g.line} \`${g.function}\``;
  list("Gateway-fabricated frames added", b.transformations.fabricated.filter((g) => !ga.has(fabricatedId(g))), fmtFab);
  list("Gateway-fabricated frames removed", a.transformations.fabricated.filter((g) => !gb.has(fabricatedId(g))), fmtFab);
  const guardText = (gs) => (gs ?? []).map((g) => `${g.negated ? "not " : ""}${[g.stream ? `stream∈{${g.stream.join(",")}}` : "", g.phase ? `phase∈{${g.phase.join(",")}}` : ""].filter(Boolean).join(" & ")}`).join("; ");
  const rwId = (g) => `${g.scope}|${g.file}|${g.function}|${(g.added ?? [g.removed]).join(",")}|${guardText(g.guard)}`;
  const ra = new Set([...a.transformations.dataRewrites, ...a.transformations.dataRemovals].map(rwId));
  const rb = new Set([...b.transformations.dataRewrites, ...b.transformations.dataRemovals].map(rwId));
  const fmtRw = (g) => `${g.scope}: ${g.added ? `adds ${g.added.join(", ")}` : `removes ${g.removed}`}${g.guard?.length ? ` when ${guardText(g.guard)}` : ""} at ${g.file}:${g.line} \`${g.function}\``;
  list("Data rewrites added", [...b.transformations.dataRewrites, ...b.transformations.dataRemovals].filter((g) => !ra.has(rwId(g))), fmtRw);
  list("Data rewrites removed", [...a.transformations.dataRewrites, ...a.transformations.dataRemovals].filter((g) => !rb.has(rwId(g))), fmtRw);

  // ---- chat content parts ------------------------------------------------------------------
  push("## Chat content-part types (display projection)", "");
  for (const field of ["fabricated", "recognized"]) {
    const ta = new Set(a.chatContentParts[field].map((x) => x.type));
    const tb = new Set(b.chatContentParts[field].map((x) => x.type));
    list(`${field} types added`, setDiff(tb, ta));
    list(`${field} types removed`, setDiff(ta, tb));
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function main(argv) {
  const files = [];
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i += 1;
    } else files.push(argv[i]);
  }
  if (files.length !== 2) {
    process.stderr.write("usage: diff-agent-emissions.mjs <old.json> <new.json> [--out report.md]\n");
    process.exit(2);
  }
  const [a, b] = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const md = diffInventories(a, b);
  if (out) fs.writeFileSync(out, md);
  else process.stdout.write(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
