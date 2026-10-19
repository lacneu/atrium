import { describe, expect, it } from "vitest";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
import { rowSegments } from "./rowLayoutView";

// A bubble the transcript rows composed is shown ROW BY ROW (final design §3.4, step 3):
// each row's text, its files just under it, then its tool cards — the order of
// `ui/src/lib/chat/message-normalizer.test.ts:501` ("text, attachment, text, attachment")
// at the scale of a bubble. What the display withholds (R4) is skipped by name.

const T1 = "PROBE_SEND_DONE Voici les deux fichiers.";
const T2 = "Délégation terminée.";

function denis(overrides: Partial<ConvexMessageView> = {}): ConvexMessageView {
  const text = `${T1}\n\n${T2}\n\nFichiers : a.txt, img.png`;
  return {
    _id: "m1" as ConvexMessageView["_id"],
    chatId: "c1" as ConvexMessageView["chatId"],
    _creationTime: 1,
    role: "assistant",
    status: "complete",
    text,
    updatedAt: 2,
    parts: [
      { kind: "tool", name: "message", phase: "completed", toolCallId: "msg-1" },
      { kind: "media", storageId: "s1", filename: "a.txt", mimeType: "text/plain", url: "https://store/a", transcriptFileId: "f1" },
      { kind: "media", storageId: "s2", filename: "img.png", mimeType: "image/png", url: "https://store/i", transcriptFileId: "f2" },
    ],
    // A current bridge's rows: their blocks are known (`blocks: true`).
    rowLayout: [
      { entryId: "r17", start: 0, end: 0, tools: [{ toolCallId: "msg-1", name: "message", status: "result" }], blocks: true },
      { entryId: "r16", start: 0, end: T1.length, files: [{ blockIndex: 1 }, { blockIndex: 2 }], blocks: true },
      { entryId: "r26", start: T1.length + 2, end: T1.length + 2 + T2.length, blocks: true },
    ],
    rowFiles: [
      { entryId: "r16", blockIndex: 1, fileId: "f1", state: "copied", sha256: "aa", label: "a.txt" },
      { entryId: "r16", blockIndex: 2, fileId: "f2", state: "copied", sha256: "bb", label: "img.png" },
    ],
    ...overrides,
  };
}

const types = (m: ConvexMessageView) =>
  (convertConvexMessage(m).content as ReadonlyArray<{ type: string; toolName?: string; text?: string }>).map((p) =>
    p.type === "tool-call" ? `tool:${p.toolName}` : p.type === "text" ? `text:${p.text}` : p.type,
  );

describe("rowSegments / convertConvexMessage — a bubble shown by its rows", () => {
  it("each row: its text, then its files, then its tool cards; the files' cache line is never shown", () => {
    expect(types(denis())).toEqual(["tool:__turn_flow__", `text:${T1}`, "file", "file", `text:${T2}`]);
  });

  it("a card a row shows is not repeated in the grouped tool block", () => {
    const custom = convertConvexMessage(denis()).metadata?.custom as { toolParts: unknown[]; allToolParts: unknown[] };
    expect(custom.toolParts).toEqual([]);
    expect(custom.allToolParts).toHaveLength(1);
  });

  it("a live tool part no row names (no id, the delivery lane's overlay) is not shown again", () => {
    const m = denis({ parts: [...denis().parts, { kind: "tool", name: "exec", phase: "completed" }] });
    expect(types(m)).toEqual(["tool:__turn_flow__", `text:${T1}`, "file", "file", `text:${T2}`]);
    const custom = convertConvexMessage(m).metadata?.custom as { toolParts: unknown[] };
    expect(custom.toolParts).toEqual([]);
  });

  // Codex review 8: a copied file shows from the copy itself (its URL read with the view),
  // whether a derived part was written yet or not.
  it("a copied file with no derived part yet is shown from its copy's URL", () => {
    const m = denis({
      rowFiles: [{ entryId: "r16", blockIndex: 1, fileId: "f1", state: "copied", label: "a.txt", url: "https://store/copy", storageId: "s-copy" }],
      parts: [],
    });
    const files = (convertConvexMessage(m).content as ReadonlyArray<Record<string, unknown>>).filter((p) => p.type === "file");
    expect(files[0]).toMatchObject({ data: "https://store/copy", storageId: "s-copy" });
    expect(files[0]).not.toHaveProperty("unavailable");
  });

  it("a file without a copy is shown as what it is (pending, gone, refused) — never hidden", () => {
    const m = denis({
      rowFiles: [
        { entryId: "r16", blockIndex: 1, fileId: "f1", state: "gone", reason: "artifact_not_found", label: "a.txt" },
        { entryId: "r16", blockIndex: 2, state: "pending", label: "img.png" },
      ],
      parts: [],
    });
    const files = (convertConvexMessage(m).content as ReadonlyArray<Record<string, unknown>>).filter((p) => p.type === "file");
    expect(files.map((f) => [f.unavailable, f.filename])).toEqual([
      ["gone", "a.txt"],
      ["pending", "img.png"],
    ]);
  });

  it("R4: a withheld duplicate file and a withheld repeated text are skipped, by name", () => {
    const m = denis({
      displayHidden: [
        { messageId: "m1", entryId: "r16", rule: "same_sha256_in_group", blockIndex: 2 },
        { messageId: "m1", entryId: "r26", rule: "repeated_text_in_group" },
      ],
    });
    expect(types(m)).toEqual(["tool:__turn_flow__", `text:${T1}`, "file"]);
    const seg = rowSegments(m)!;
    expect(seg.filter((s) => s.kind === "file").map((s) => (s.kind === "file" ? s.blockIndex : -1))).toEqual([1]);
  });

  it("R4 over a mixed group: a live file part withheld by its storage id is not rendered", () => {
    const m = denis({
      parts: [...denis().parts, { kind: "media", storageId: "s9", filename: "copie.txt", mimeType: "text/plain", url: "https://store/c" }],
      displayHidden: [{ messageId: "m1", rule: "same_sha256_in_group", storageId: "s9" }],
    });
    expect(types(m)).toEqual(["tool:__turn_flow__", `text:${T1}`, "file", "file", `text:${T2}`]);
    const legacy = denis({
      rowLayout: undefined,
      rowFiles: undefined,
      text: "suite",
      parts: [{ kind: "media", storageId: "s9", filename: "x.txt", mimeType: "text/plain", url: "https://store/x" }],
      displayHidden: [{ messageId: "m1", rule: "same_sha256_in_group", storageId: "s9" }],
    });
    expect(types(legacy)).toEqual(["text:suite"]);
  });

  // Codex review 1, finding 1 — deployment order Convex → frontend → bridge: a bubble whose
  // rows came from a 0.100.1 bridge (text only, no blocks) keeps its live tool cards.
  it("rows without blocks (a 0.100.1 bridge): the live tool cards stay shown", () => {
    const m = denis({
      rowLayout: [{ entryId: "a1", start: 0, end: 5 }],
      rowFiles: [],
      text: "Fait.",
      parts: [{ kind: "tool", name: "exec", phase: "completed", toolCallId: "call-1", textOffset: 0 }],
    });
    const custom = convertConvexMessage(m).metadata?.custom as { toolParts: Array<{ toolCallId?: string }> };
    expect(custom.toolParts.map((p) => p.toolCallId)).toEqual(["call-1"]);
    expect(types(m)).toEqual(["text:Fait."]);
  });

  // Codex review 3, finding 2 — decided ROW BY ROW: a bubble with an old row (no blocks)
  // and a new one (blocks) keeps the live card of the old row and shows the new row's card
  // under it, once.
  it("mixed rows: the row without blocks keeps its live card; the blocks row shows its own, once", () => {
    const m = denis({
      rowLayout: [
        { entryId: "a1", start: 0, end: 5 },
        { entryId: "a2", start: 5, end: 5, tools: [{ toolCallId: "call-new", name: "exec", status: "result" }], blocks: true },
      ],
      rowFiles: [],
      text: "Fait.",
      parts: [
        { kind: "tool", name: "exec", phase: "completed", toolCallId: "call-old", textOffset: 0 },
        { kind: "tool", name: "exec", phase: "completed", toolCallId: "call-new", textOffset: 5 },
      ],
    });
    const custom = convertConvexMessage(m).metadata?.custom as { toolParts: Array<{ toolCallId?: string }> };
    expect(custom.toolParts.map((p) => p.toolCallId)).toEqual(["call-old"]);
    expect(types(m)).toEqual(["text:Fait.", "tool:__turn_flow__"]);
  });

  // Codex review 5, finding 2: what the layout left out past its bounds is SAID, at the end —
  // never a file shown as pending.
  it("a layout cut at its bounds ends with a notice, and shows no unresolved file", () => {
    const m = denis({
      rowLayout: [{ entryId: "a1", start: 0, end: 5, blocks: true, cut: { rows: 2, files: 3 } }],
      rowFiles: [],
      text: "Fait.",
      parts: [],
    });
    const content = convertConvexMessage(m).content as ReadonlyArray<{ type: string; text?: string; unavailable?: string }>;
    expect(content.map((p) => p.type)).toEqual(["text", "text"]);
    expect(content[1]!.text).toContain("5");
    expect(content.some((p) => p.unavailable !== undefined)).toBe(false);
  });

  it("rows with blocks: the cards are the rows' own (a live card no row names is not shown again)", () => {
    const m = denis({
      rowLayout: denis().rowLayout,
      parts: [...denis().parts, { kind: "tool", name: "exec", phase: "completed" }],
    });
    const custom = convertConvexMessage(m).metadata?.custom as { toolParts: unknown[] };
    expect(custom.toolParts).toEqual([]);
  });

  // Codex review 1, finding 3 — a remote reference is shown from its URL, as is.
  it("a remote https reference is a file part loading its URL (never unavailable)", () => {
    const m = denis({
      rowLayout: [{ entryId: "g1", start: 0, end: 5, files: [{ blockIndex: 1, remoteUrl: "https://example.com/remote.png", label: "remote.png", mimeType: "image/png" }], blocks: true }],
      rowFiles: [{ entryId: "g1", blockIndex: 1, state: "remote", url: "https://example.com/remote.png", label: "remote.png", mimeType: "image/png" }],
      text: "Voici",
      parts: [],
    });
    const files = (convertConvexMessage(m).content as ReadonlyArray<Record<string, unknown>>).filter((p) => p.type === "file");
    expect(files).toEqual([expect.objectContaining({ data: "https://example.com/remote.png", filename: "remote.png", mimeType: "image/png" })]);
    expect(files[0]).not.toHaveProperty("unavailable");
  });

  it("a bubble without a layout renders exactly as before (text, then its file parts)", () => {
    const m = denis({ rowLayout: undefined, rowFiles: undefined, text: "ancien" });
    expect(rowSegments(m)).toBeNull();
    expect(types(m)).toEqual(["text:ancien", "file", "file"]);
  });
});

// ONE BLOCK PER RUN OF TOOL ROWS (0.101.1, prod report prod-ms7dc0ne…): a code-mode turn writes
// one row per call, and the Control UI shows consecutive tool-only message groups as ONE
// activity run (ui/src/pages/chat/chat-thread-grouping.ts:493-538). A text or a file between
// them ends the block. Each card keeps the parent its row recorded.
describe("rowSegments — consecutive tool rows are one block", () => {
  const tool = (toolCallId: string, name = "exec", parentToolCallId?: string) => ({
    toolCallId,
    name,
    status: "result" as const,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  });
  const bubble = (rowLayout: NonNullable<ConvexMessageView["rowLayout"]>, text = "Envoyé."): ConvexMessageView => ({
    _id: "m2" as ConvexMessageView["_id"],
    chatId: "c1" as ConvexMessageView["chatId"],
    _creationTime: 1,
    role: "assistant",
    status: "complete",
    text,
    updatedAt: 2,
    parts: [],
    rowLayout,
  });

  it("merges the tool rows that follow one another, and keeps the nesting", () => {
    const segs = rowSegments(
      bubble([
        { entryId: "a", start: 0, end: 0, tools: [tool("e1")], blocks: true },
        { entryId: "b", start: 0, end: 0, tools: [tool("e2"), tool("n1", "sessions_spawn", "e2")], blocks: true },
        { entryId: "c", start: 0, end: 0, tools: [tool("y1", "sessions_yield")], blocks: true },
      ]),
    );
    expect(segs).toEqual([
      { kind: "tools", entryId: "a", toolCallIds: ["e1", "e2", "n1", "y1"], parents: { n1: "e2" } },
    ]);
  });

  it("a text between two tool rows ends the block", () => {
    const segs = rowSegments(
      bubble([
        { entryId: "a", start: 0, end: 0, tools: [tool("e1")], blocks: true },
        { entryId: "b", start: 0, end: 7, blocks: true },
        { entryId: "c", start: 0, end: 0, tools: [tool("e2")], blocks: true },
      ]),
    );
    expect(segs?.map((s) => s.kind)).toEqual(["tools", "text", "tools"]);
  });

  it("the converted bubble carries one flow part per block, in rows mode, with the parents", () => {
    const msg = bubble([
      { entryId: "a", start: 0, end: 0, tools: [tool("e1")], blocks: true },
      { entryId: "b", start: 0, end: 0, tools: [tool("e2"), tool("n1", "message", "e2")], blocks: true },
    ]);
    msg.parts = [
      { kind: "tool", name: "exec", phase: "completed", toolCallId: "e1" },
      { kind: "tool", name: "exec", phase: "completed", toolCallId: "e2" },
      { kind: "tool", name: "message", phase: "completed", toolCallId: "n1" },
    ];
    const content = convertConvexMessage(msg).content as ReadonlyArray<{ type: string; toolName?: string; args?: { parts: Array<{ toolCallId: string; parentToolCallId?: string }>; rows?: boolean } }>;
    const flows = content.filter((p) => p.type === "tool-call" && p.toolName === "__turn_flow__");
    expect(flows).toHaveLength(1);
    expect(flows[0]!.args!.rows).toBe(true);
    expect(flows[0]!.args!.parts.map((p) => [p.toolCallId, p.parentToolCallId])).toEqual([
      ["e1", undefined],
      ["e2", undefined],
      ["n1", "e2"],
    ]);
  });
});

// R4 WITHHOLDS A REPEATED TEXT — the bubble still ANSWERED (0.101.1, seen on the bench: a
// resume repeating `PARALLEL_DONE` read "the agent acted but returned no answer").
describe("a bubble whose text is the withheld repeat of its group", () => {
  it("is marked as answered for the empty-state decision", () => {
    const msg: ConvexMessageView = {
      _id: "m3" as ConvexMessageView["_id"],
      chatId: "c1" as ConvexMessageView["chatId"],
      _creationTime: 1,
      role: "assistant",
      status: "complete",
      text: "PARALLEL_DONE",
      updatedAt: 2,
      parts: [],
      rowLayout: [{ entryId: "r9", start: 0, end: 13, blocks: true }],
      displayHidden: [{ messageId: "m3", rule: "repeated_text_in_group", entryId: "r9" }],
    } as unknown as ConvexMessageView;
    const converted = convertConvexMessage(msg) as unknown as { content: Array<{ type: string; text?: string }>; metadata: { custom: { repeatWithheld?: boolean } } };
    expect(converted.content.filter((p) => p.type === "text" && (p.text ?? "").includes("PARALLEL_DONE"))).toEqual([]);
    expect(converted.metadata.custom.repeatWithheld).toBe(true);
  });
});

// While a projected bubble is still being written (no rows yet), its live cards already form
// the Control UI's block: the family summary, and the nesting the live frames carry.
describe("a projected bubble being written", () => {
  it("marks its flow block rows-mode and keeps each live card's parent", () => {
    const msg: ConvexMessageView = {
      _id: "m4" as ConvexMessageView["_id"],
      chatId: "c1" as ConvexMessageView["chatId"],
      _creationTime: 1,
      role: "assistant",
      status: "streaming",
      text: "",
      updatedAt: 2,
      parts: [
        { kind: "tool", name: "exec", phase: "completed", toolCallId: "e1", textOffset: 0 },
        { kind: "tool", name: "exec", phase: "completed", toolCallId: "n1", parentToolCallId: "e1", textOffset: 0 },
      ],
    };
    const run = (projected: boolean) =>
      (convertConvexMessage(msg, null, null, null, { childRunIds: [], childKeys: [], lastUserAt: null, ...(projected ? { projected: true } : {}) }).content as ReadonlyArray<{
        type: string;
        toolName?: string;
        args?: { parts: Array<{ toolCallId: string; parentToolCallId?: string }>; rows?: boolean };
      }>).filter((p) => p.type === "tool-call" && p.toolName === "__turn_flow__");
    const [on] = run(true);
    expect(on!.args!.rows).toBe(true);
    expect(on!.args!.parts.map((p) => [p.toolCallId, p.parentToolCallId])).toEqual([["e1", undefined], ["n1", "e1"]]);
    const [off] = run(false);
    expect(off!.args!.rows).toBeUndefined();
  });
});
