// The ONE reconciliation of a bubble's view (codex review 6): what a row says wins for what
// it says; the live stream keeps what no row says yet.
import { describe, expect, test } from "vitest";
import { LAYOUT_MAX_FILES, type LayoutRow } from "./bubbleProjection";
import { reconcileToolParts, renderedFilePieces, type FilePiece } from "./viewReconcile";

const layout = (tools: Array<{ toolCallId: string; status: "call" | "result" | "error"; name?: string }>): LayoutRow[] => [
  { entryId: "r1", start: 0, end: 0, tools },
];

describe("reconcileToolParts", () => {
  test("a row's ERROR replaces the live phase; the card keeps its input and output (ui/src/lib/chat/tool-cards.ts)", () => {
    const live = [{ kind: "tool", name: "exec", phase: "started", toolCallId: "c1", input: { cmd: "ls" }, output: "partial" }];
    expect(reconcileToolParts(live, layout([{ toolCallId: "c1", status: "error" }]))).toEqual([
      { kind: "tool", name: "exec", phase: "error", toolCallId: "c1", input: { cmd: "ls" }, output: "partial" },
    ]);
  });
  test("a row's RESULT completes a live card still started", () => {
    const live = [{ kind: "tool", name: "exec", phase: "started", toolCallId: "c1" }];
    expect(reconcileToolParts(live, layout([{ toolCallId: "c1", status: "result" }]))[0]).toMatchObject({ phase: "completed" });
  });
  test("a row's RESULT does not undo a failure the live stream reported (0.101.2 audit)", () => {
    const live = [{ kind: "tool", name: "exec", phase: "error", toolCallId: "c1" }];
    expect(reconcileToolParts(live, layout([{ toolCallId: "c1", status: "result" }]))[0]).toMatchObject({ phase: "error" });
  });
  test("a call-only row says no outcome: the live phase stays", () => {
    const live = [{ kind: "tool", name: "exec", phase: "completed", toolCallId: "c1" }];
    expect(reconcileToolParts(live, layout([{ toolCallId: "c1", status: "call" }]))[0]).toMatchObject({ phase: "completed" });
  });
  test("a call a row names and no live part shows gets its card; a live card no row names stays", () => {
    const live = [{ kind: "tool", name: "exec", phase: "started", toolCallId: "live-only" }, { kind: "media", storageId: "s" }];
    expect(reconcileToolParts(live, layout([{ toolCallId: "c2", status: "error", name: "read" }]))).toEqual([
      ...live,
      { kind: "tool", name: "read", phase: "error", toolCallId: "c2" },
    ]);
  });
  test("no rows: the live parts as they are", () => {
    const live = [{ kind: "tool", name: "exec", phase: "started", toolCallId: "c1" }];
    expect(reconcileToolParts(live, undefined)).toEqual(live);
  });
});

describe("renderedFilePieces — the bound counts rendered pieces", () => {
  test("pieces a row shows are left to the row; derived first in row order, then live; bounded after", () => {
    const pieces: FilePiece[] = [
      { storageId: "live-1", order: 1 },
      { storageId: "row-shown", transcriptFileId: "f1", seq: 1, blockIndex: 0, order: 2 },
      { storageId: "derived-b", transcriptFileId: "f3", seq: 9, blockIndex: 0, order: 3 },
      { storageId: "derived-a", transcriptFileId: "f2", seq: 5, blockIndex: 1, order: 4 },
    ];
    expect(renderedFilePieces(pieces, new Set(["f1"])).map((p) => p.storageId)).toEqual(["derived-a", "derived-b", "live-1"]);
  });
  test("past the bound: the first LAYOUT_MAX_FILES rendered pieces", () => {
    const pieces: FilePiece[] = Array.from({ length: LAYOUT_MAX_FILES + 3 }, (_, i) => ({ storageId: `s${i}`, order: i }));
    const out = renderedFilePieces(pieces, new Set());
    expect(out).toHaveLength(LAYOUT_MAX_FILES);
    expect(out[0]!.storageId).toBe("s0");
  });
});
