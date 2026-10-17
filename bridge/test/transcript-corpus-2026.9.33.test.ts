// THE 2026.9.33 GOLDEN CORPUS (final design step 0) — one shape test per fixture, then the
// step-1 replay: what the row contract reads out of each captured row.
//
// The fixtures are promoted VERBATIM from the bench probe probe-refonte-20261016T165938Z
// (OpenClaw 2026.9.33 r5, runtime of production, token mode) by
// openclaw-notes/atrium/refonte-finale/promote-corpus-9.33.py; each carries its `_source`.
// The shape tests pin the facts the design rests on (§2.2): the files live only in the
// delivery-mirror ROW; the display order is not `seq`; a live `seq` is not an identity; the
// resume input is hidden; a cursor across the resume reads as a reset.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyArtifactDownloadError, readArtifactDownload } from "../src/providers/openclaw/artifact-download.js";
import { GatewayAnsweredError } from "../src/providers/openclaw/openclaw-client.js";
import {
  admitLiveRow,
  parseHistoryReply,
  rowDisplayFacts,
  toTranscriptRow,
  type TranscriptEnvelope,
} from "../src/providers/openclaw/transcript-rows.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/transcript-2026.9.33/${name}`, import.meta.url), "utf8")) as T;

type Msg = Record<string, unknown> & { __openclaw?: Record<string, unknown> };
const TAIL = fixture<{ reply: { sessionKey: string; messages: Msg[] } & Record<string, unknown> }>("chat-history-tail.json");
const MIRRORS = fixture<{ events: Array<{ t_ms: number; payload: Record<string, unknown> & { message: Msg } }> }>(
  "session-message-mirrors.json",
);
const EPHEMERAL = fixture<{ payload: Record<string, unknown> & { message: Msg } }>("session-message-ephemeral-aborted.json");
const SETTLE = fixture<{ entry: Msg }>("sessions-get-settle-entry.json");
const RESET = fixture<{ reply: unknown }>("chat-history-delta-reset.json");
const DOWNLOADS = fixture<{
  answers: Array<{
    artifactId: string;
    answer: unknown;
    ticketFetch: { status: number; sha256: string; bytes: number };
    ticketOnOtherId: { status: number };
    noAuthNoTicket: { status: number };
  }>;
  afterReset: { download: { ok: boolean; error: string } };
}>("artifacts-download.json");

const SAME = fixture<{ rows: Msg[]; copiedSha256: string }>("same-file-two-rows.json");
const RAW = fixture<{ managedFile: { ok: boolean; payload: unknown }; managedImage: { ok: boolean; payload: unknown }; notFound: { ok: boolean; error: { code: string; message: string; details: unknown } } }>(
  "artifacts-download-raw.json",
);

const SK = TAIL.reply.sessionKey;
const display = { sessionKey: SK };
const bySeq = (seq: number): Msg => {
  const m = TAIL.reply.messages.find((x) => x.__openclaw?.seq === seq);
  if (m === undefined) throw new Error(`no row seq ${seq}`);
  return m;
};
const ART_DOC = "artifact_managed_media_03d85d8e-b298-4812-b5a1-3fffb6ad2e8b";
const ART_IMG = "artifact_managed_image_0e844b10-2d50-44ce-a329-983b99c8b328";
const MEDIA_PATH = "/home/node/.openclaw/media/outbound/probe-refonte-a-2026-10-16t16-59-38-883z.txt";

describe("fixture shapes (step 0)", () => {
  it("chat-history-tail.json: a tail page of 25 identified rows; the resume input (seq 9) is hidden", () => {
    const read = parseHistoryReply(TAIL.reply);
    expect(read?.kind).toBe("page");
    expect(read?.rows).toHaveLength(25);
    expect(read?.unidentified).toBe(0);
    expect(read?.rows.map((r) => r.seq)).not.toContain(9);
    expect(read?.hasActiveRun).toBe(false);
  });

  it("chat-history-tail.json: the display order is not seq — nested activity (17, 24) precedes its mirror (16, 23)", () => {
    const seqs = TAIL.reply.messages.map((m) => m.__openclaw?.seq);
    expect(seqs.indexOf(17)).toBeLessThan(seqs.indexOf(16));
    expect(seqs.indexOf(24)).toBeLessThan(seqs.indexOf(23));
    const pos = (seq: number) => bySeq(seq).__openclaw?.transcriptPosition as Record<string, unknown>;
    expect(pos(17)).toMatchObject({ rawSeq: 28, activity: { afterRawSeq: 26, startOrder: 1 } });
    expect(pos(16)).toMatchObject({ rawSeq: 27 });
  });

  it("chat-history-tail.json: the mirror rows carry the files as BLOCKS (managed) or a MEDIA: line, nothing else", () => {
    const m16 = bySeq(16);
    expect(m16).toMatchObject({ model: "delivery-mirror", provider: "openclaw", stopReason: "stop" });
    expect((m16.content as Msg[]).map((b) => b.type)).toEqual(["text", "attachment", "image"]);
    expect(m16).not.toHaveProperty("openclawDelivery");
    const m23 = bySeq(23);
    expect((m23.content as Msg[]).map((b) => b.type)).toEqual(["text"]);
    expect(((m23.content as Msg[])[0]!.text as string).split("\n")[1]).toBe(`MEDIA:${MEDIA_PATH}`);
  });

  it("session-message-mirrors.json: the live rows are the durable rows (same id, seq, blocks)", () => {
    for (const { payload } of MIRRORS.events) {
      const durable = bySeq(payload.messageSeq as number);
      expect(payload.messageId).toBe(durable.__openclaw?.id);
      expect(payload.message.content).toEqual(durable.content);
      expect(payload.message.__openclaw).toEqual(durable.__openclaw);
    }
    // The mirror reached the live stream 8 s before the run ended (34.5 s vs 42.8 s).
    expect(MIRRORS.events.map((e) => e.payload.messageSeq)).toEqual([16, 23]);
  });

  it("session-message-ephemeral-aborted.json: a live seq 9 that no durable read returns — seq is not an identity", () => {
    const { payload } = EPHEMERAL;
    expect(payload.messageSeq).toBe(9);
    expect(payload.message).toMatchObject({ role: "assistant", stopReason: "aborted", errorMessage: "Agent run aborted" });
    const id = payload.messageId as string;
    expect(TAIL.reply.messages.some((m) => m.__openclaw?.id === id)).toBe(false);
    expect(SETTLE.entry.__openclaw?.seq).toBe(9);
    expect(SETTLE.entry.__openclaw?.id).not.toBe(id);
    // …and it came from another transcript source than every durable row.
    const src = (m: Msg) => (m.__openclaw?.transcriptPosition as { source: string }).source;
    expect(new Set(TAIL.reply.messages.map(src))).not.toContain(src(payload.message));
  });

  it("sessions-get-settle-entry.json: the resume input is a raw user row marked subagent_settle, display:false", () => {
    expect(SETTLE.entry).toMatchObject({
      role: "user",
      display: false,
      provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
    });
    expect(SETTLE.entry.idempotencyKey).toMatch(/:yield-1:user$/);
  });

  it("chat-history-delta-reset.json: a cursor across the resume reads as a reset", () => {
    expect(parseHistoryReply(RESET.reply)).toMatchObject({ kind: "reset", rows: [] });
  });

  it("artifacts-download.json: a managed artifact answers a ticketed URL on the managed route, readable with no credential", () => {
    for (const a of DOWNLOADS.answers) {
      const read = readArtifactDownload(a.answer);
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      expect(read.url).toMatch(/^\/api\/chat\/media\/outgoing\/[^/]+\/[0-9a-f-]{36}\/full\?mediaTicket=/);
      expect(a.ticketFetch.status).toBe(200);
      expect(a.ticketOnOtherId.status).toBe(401);
      expect(a.noAuthNoTicket.status).toBe(401);
    }
    expect(DOWNLOADS.answers.map((a) => a.artifactId)).toEqual([ART_DOC, ART_IMG]);
    expect(DOWNLOADS.afterReset.download).toEqual({ ok: false, error: "artifact not found" });
  });
});

describe("fixture shapes (step 0) — second capture, bench run 2026-10-16T18-14-42-224Z", () => {
  it("same-file-two-rows.json: one file sent by two rows — two artifactIds, the same label", () => {
    const ids = SAME.rows.slice(0, 2).map((m) => {
      const att = (m.content as Msg[]).find((b) => b.type === "attachment") as { attachment: { artifactId: string; label: string; sizeBytes: number } };
      return att.attachment;
    });
    expect(ids[0]!.artifactId).not.toBe(ids[1]!.artifactId);
    expect(ids[0]!.label).toBe(ids[1]!.label);
    expect(ids[0]!.sizeBytes).toBe(ids[1]!.sizeBytes);
    expect(SAME.rows.every((m) => m.model === "delivery-mirror")).toBe(true);
  });

  it("artifacts-download-raw.json: the managed answer shape, and the refusal's structured type", () => {
    for (const a of [RAW.managedFile, RAW.managedImage]) {
      expect(a.ok).toBe(true);
      expect(readArtifactDownload(a.payload)).toMatchObject({ ok: true, url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\/.+\/full\?mediaTicket=<redacted>$/) });
    }
    expect(RAW.notFound).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "artifact not found", details: { type: "artifact_not_found" } },
    });
  });
});

describe("the row contract replayed on the corpus (step 1)", () => {
  it("seq 16: one text and two files, by artifact id, with the facts the block states", () => {
    const row = toTranscriptRow(bySeq(16), undefined, display);
    expect(row?.blocks).toEqual([
      { type: "text", text: "PROBE_SEND_DONE Voici les deux fichiers demandés." },
      {
        type: "file",
        kind: "document",
        artifactId: ART_DOC,
        mimeType: "text/plain",
        sizeBytes: 16,
        label: "probe-refonte-a-2026-10-16t16-59-38-883z.txt",
      },
      {
        type: "file",
        kind: "image",
        artifactId: ART_IMG,
        mimeType: "image/png",
        sizeBytes: 1795,
        label: "probe-refonte-img-2026-10-16t16-59-38-883z.png",
      },
    ]);
    expect(row).toMatchObject({
      deliveryMirror: true,
      idempotencyKind: "message-tool",
      stopReason: "stop",
      transcriptPosition: { source: "M-WCtPtLqwIScHKjz_RlYtCESxjAfvCr8hzVGJfF3Hw", rawSeq: 27 },
    });
    // The artifact ids are the ones `artifacts.download` resolves (the identity join).
    const files = (row?.blocks ?? []).flatMap((b) => (b.type === "file" && b.artifactId ? [b.artifactId] : []));
    expect(files).toEqual(DOWNLOADS.answers.map((a) => a.artifactId));
  });

  it("seq 23: one text and one MEDIA: reference (by path, never fetched by name)", () => {
    const row = toTranscriptRow(bySeq(23), undefined, display);
    expect(row?.blocks).toEqual([
      { type: "text", text: "PROBE_SUMMARY Les deux fichiers ont été envoyés et le fichier texte vérifié." },
      {
        type: "file",
        kind: "document",
        mediaSource: MEDIA_PATH,
        mimeType: "text/plain",
        label: "probe-refonte-a-2026-10-16t16-59-38-883z.txt",
      },
    ]);
    // The cached text keeps no MEDIA: line and no server path.
    expect(row?.text).toBe("PROBE_SUMMARY Les deux fichiers ont été envoyés et le fichier texte vérifié.");
  });

  it("the live session.message of each mirror yields the same blocks as its durable row", () => {
    for (const { payload } of MIRRORS.events) {
      const live = toTranscriptRow(payload.message, payload as TranscriptEnvelope, display);
      const durable = toTranscriptRow(bySeq(payload.messageSeq as number), undefined, display);
      expect(live?.blocks).toEqual(durable?.blocks);
      expect(live?.entryId).toBe(durable?.entryId);
    }
  });

  it("the nested `message` tool rows yield their tool blocks; their run's code-mode exec rows yield theirs", () => {
    expect(toTranscriptRow(bySeq(17), undefined, display)?.blocks?.map((b) => [b.type, b.type === "tool" ? b.name : null])).toEqual([
      ["tool", "message"],
      ["tool", "message"],
    ]);
    const exec = toTranscriptRow(bySeq(19), undefined, display);
    expect(exec?.blocks).toEqual([{ type: "tool", toolCallId: expect.any(String), name: "exec", status: "call", input: expect.anything() }]);
  });

  it("the ephemeral aborted row: its error text and stop reason, no text block", () => {
    const { payload } = EPHEMERAL;
    const row = toTranscriptRow(payload.message, payload as TranscriptEnvelope, display);
    expect(row).toMatchObject({ stopReason: "aborted", errorMessage: "Agent run aborted" });
    // Blocks KNOWN and empty (codex review 4, finding 2): nothing to show but its error.
    expect(row?.blocks).toEqual([]);
    expect(row?.text).toBeUndefined();
  });

  it("the raw settle entry: provenance read-only, and the shadow/off reading carries none of it", () => {
    const on = toTranscriptRow(SETTLE.entry, undefined, display);
    expect(on).toMatchObject({ provenanceKind: "inter_session", provenanceSourceTool: "subagent_settle", idempotencyKind: "user" });
    const off = toTranscriptRow(SETTLE.entry);
    for (const field of ["provenanceKind", "provenanceSourceTool", "idempotencyKind", "transcriptPosition", "blocks"]) {
      expect(off).not.toHaveProperty(field);
    }
  });

  it("off/shadow (no display): a mirror row is identities only, exactly as before", () => {
    const row = toTranscriptRow(bySeq(16));
    expect(Object.keys(row ?? {}).sort()).toEqual(["entryId", "hidden", "role", "runId", "seq", "visible"]);
  });

  it("a mirror that carries its own files is visible and never hidden (CU-16 admits it as a previous run's row)", () => {
    expect(rowDisplayFacts(bySeq(16))).toEqual({ hidden: false, visible: true });
    const { payload } = MIRRORS.events[0]!;
    const admitted = admitLiveRow(payload, { activeRunId: "probe-refonte-80ee9278-2008-42a6-8293-e00368eb4de0", recentTerminalRunId: null, display });
    expect(admitted).toMatchObject({ admitted: true, why: "previous_run" });
    expect(admitted.row?.blocks?.filter((b) => b.type === "file")).toHaveLength(2);
  });
});

describe("Olivier's R4 decision on the corpus (storage stays faithful; the display dedup is step 3)", () => {
  it("the two rows that send the same file are two file blocks, by their two artifact ids — nothing merged at read", () => {
    const files = SAME.rows
      .slice(0, 2)
      .flatMap((m) => toTranscriptRow(m, undefined, display)?.blocks ?? [])
      .filter((b) => b.type === "file" && b.label === "bench-codemode-a.txt");
    expect(files).toHaveLength(2);
    expect(new Set(files.map((b) => (b.type === "file" ? b.artifactId : null))).size).toBe(2);
  });

  it("the last send of the run keeps its MEDIA: reference as its own file block", () => {
    const row = toTranscriptRow(SAME.rows[2], undefined, display);
    expect(row?.blocks?.map((b) => b.type)).toEqual(["text", "file"]);
    expect(row?.blocks?.[1]).toMatchObject({ mediaSource: "/home/node/.openclaw/media/outbound/bench-codemode-a.txt" });
  });

  it("the gateway's refusal of an unknown artifact classifies as artifact_not_found (gone)", async () => {
    const err = new GatewayAnsweredError(
      `${RAW.notFound.error.code}: ${RAW.notFound.error.message}`,
      RAW.notFound.error.details,
      RAW.notFound.error.code,
    );
    expect(classifyArtifactDownloadError(err)).toEqual({ ok: false, reason: "artifact_not_found" });
  });
});
