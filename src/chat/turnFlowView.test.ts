// Interleaved-flow derivation (lot C). Each test fails if its invariant
// regresses: snap-to-paragraph (bookmark/quote-reply block stability),
// monotone cuts, whitespace merging, and every i18n label branch.

import { describe, expect, it } from "vitest";
import {
  stableCut,
  buildTurnFlow,
  activityLabel,
  dominantFamily,
  isLivePhase,
  type AnchoredActivity,
} from "./turnFlowView";
import type { ToolActivityPart } from "./toolActivityView";

const tool = (
  toolName: string,
  phase = "completed",
  id = toolName,
): ToolActivityPart => ({ toolCallId: id, toolName, phase });

const anchor = (
  offset: number,
  toolName: string,
  phase = "completed",
  id = toolName,
): AnchoredActivity => ({ offset, activity: tool(toolName, phase, id) });

const TEXT = "Premier paragraphe.\n\nDeuxième paragraphe.\n\nTroisième.";
//            0                  19  21                  41  43

describe("stableCut", () => {
  it("cuts at the EXACT offset (the Codex model: the tool interrupts the flow)", () => {
    expect(stableCut(TEXT, 5)).toBe(5);
    expect(stableCut(TEXT, 30)).toBe(30);
  });
  it("start/end stay put; negatives clamp to 0; a BEYOND-text offset keeps its identity", () => {
    expect(stableCut(TEXT, 0)).toBe(0);
    expect(stableCut(TEXT, TEXT.length)).toBe(TEXT.length);
    expect(stableCut(TEXT, -5)).toBe(0);
    // Out-of-order arrival (part before its text): the REQUESTED offset is the
    // stable identity — rendering clamps to the text at slice time instead.
    expect(stableCut(TEXT, 9999)).toBe(9999);
  });
  it("an offset INSIDE a fenced block pulls back to the fence START (never splits it)", () => {
    const text = "Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAprès.";
    const fenceStart = text.indexOf("```js");
    expect(stableCut(text, text.indexOf("const a"))).toBe(fenceStart);
  });
  it("an UNTERMINATED fence (streaming) protects to the end of text", () => {
    const text = "Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;";
    expect(stableCut(text, text.indexOf("const b"))).toBe(text.indexOf("```js"));
  });
  it("TILDE fences + info-string closers + shorter closers are handled", () => {
    const text = "A.\n\n~~~\nx\n```\ny\n~~~\n\nB.\n\n````\np\n```\nq\n````\n\nC.";
    // inside the tilde fence: pull back to its start
    expect(stableCut(text, text.indexOf("x"))).toBe(text.indexOf("~~~"));
    // inside the 4-backtick fence (3-backtick line is literal): pull back
    expect(stableCut(text, text.indexOf("q"))).toBe(text.indexOf("````"));
  });
  it("STABILITY: growing the text at the end never moves an earlier cut", () => {
    const base = "Un début de réponse";
    const offset = base.length;
    let text = base;
    const first = stableCut(text, offset);
    for (const chunk of [" qui continue.", "\n\nNouveau paragraphe.", "\n\n```js\ncode\n```"]) {
      text += chunk;
      expect(stableCut(text, offset)).toBe(first);
    }
  });
});

describe("buildTurnFlow", () => {
  it("no anchors -> single text segment (legacy fast path)", () => {
    expect(buildTurnFlow(TEXT, [])).toEqual([{ kind: "text", text: TEXT }]);
  });
  it("interleaves at the EXACT offset: text, activity, text", () => {
    const flow = buildTurnFlow(TEXT, [anchor(21, "exec")]);
    expect(flow.map((s) => s.kind)).toEqual(["text", "activity", "text"]);
    expect(flow[0]).toMatchObject({ text: "Premier paragraphe.\n\n" });
    expect(flow[2]).toMatchObject({
      text: "Deuxième paragraphe.\n\nTroisième.",
    });
  });
  it("STREAMING: a beyond-text anchor is DEFERRED (no early merge, no later insert)", () => {
    // Two tools with distinct future cuts, text not caught up yet.
    const flow1 = buildTurnFlow("01234567", [
      anchor(10, "read", "completed", "a"),
      anchor(25, "exec", "completed", "b"),
    ], { settled: false });
    expect(flow1.map((s) => s.kind)).toEqual(["text"]); // both deferred
    // Text reaches the first cut: only IT materializes.
    const flow2 = buildTurnFlow("0123456789 du texte", [
      anchor(10, "read", "completed", "a"),
      anchor(25, "exec", "completed", "b"),
    ], { settled: false });
    expect(flow2.map((s) => s.kind)).toEqual(["text", "activity", "text"]);
  });
  it("SETTLED: beyond-text cuts clamp and render (nothing is ever lost)", () => {
    const flow = buildTurnFlow("court", [anchor(999, "exec")], { settled: true });
    expect(flow.map((s) => s.kind)).toEqual(["text", "activity"]);
  });
  it("LATE anchor (text already past the offset): structural APPEND, no reorder", () => {
    // The reactive race the other way round: the overlay text is ahead when
    // the part lands. The last text segment SHORTENS (same index, same kind —
    // content change only, which streaming already exercises) and the new
    // activity + tail text APPEND at the end. Part COUNT never decreases and
    // no existing index changes kind/identity — the useClientLookup crash
    // class requires one of those.
    const text = "0123456789 un long texte qui continue bien au-delà.";
    const before = buildTurnFlow(text, [anchor(10, "read", "completed", "a")], {
      settled: false,
    });
    const after = buildTurnFlow(
      text,
      [
        anchor(10, "read", "completed", "a"),
        anchor(30, "exec", "completed", "b"), // late: text already past 30
      ],
      { settled: false },
    );
    const shape = (f: ReturnType<typeof buildTurnFlow>) =>
      f.map((s2) => (s2.kind === "activity" ? `A@${s2.cut}` : "T"));
    expect(shape(before)).toEqual(["T", "A@10", "T"]);
    expect(shape(after)).toEqual(["T", "A@10", "T", "A@30", "T"]);
    // Structural prefix preserved (kinds + activity identities).
    expect(shape(after).slice(0, shape(before).length)).toEqual(shape(before));
  });
  it("APPEND-ONLY under streaming growth: existing segments never move or shrink", () => {
    // Simulate the live sequence: text grows, anchors are fixed. The rendered
    // (kind, cut) prefix must never change — the useClientLookup crash class.
    const offsets = [10, 10, 25];
    const snapshots = [
      "0123456789",                                  // tool1+tool2 at 10 (end)
      "0123456789 plus du texte",                    // text grew past the cut
      "0123456789 plus du texte et la suite arrive", // tool3 lands at 25
    ];
    let prevShape: string[] = [];
    snapshots.forEach((text, step) => {
      const anchors = offsets
        .slice(0, step === 0 ? 2 : 3)
        .map((o, i) => anchor(o, "exec", "completed", `t${i}`));
      const flow = buildTurnFlow(text, anchors, { settled: false });
      const shape = flow.map((s) =>
        s.kind === "activity" ? `A@${s.cut}:${s.parts.length}` : "T",
      );
      expect(
        shape.slice(0, prevShape.length),
        `step ${step}: prefix must be stable`,
      ).toEqual(prevShape);
      prevShape = shape;
    });
  });
  it("an offset-0 tool renders BEFORE any text", () => {
    const flow = buildTurnFlow(TEXT, [anchor(0, "read")]);
    expect(flow[0]!.kind).toBe("activity");
    expect(flow[1]).toMatchObject({ kind: "text", text: TEXT });
  });
  it("same-cut anchors group into ONE activity", () => {
    const flow = buildTurnFlow(TEXT, [
      anchor(7, "read", "completed", "a"),
      anchor(7, "exec", "completed", "b"),
    ]);
    const groups = flow.filter((s) => s.kind === "activity");
    expect(groups).toHaveLength(1);
    expect(
      (groups[0] as { parts: ToolActivityPart[] }).parts.map(
        (p) => p.toolName,
      ),
    ).toEqual(["read", "exec"]);
  });
  it("cuts are MONOTONE: a later part with a SMALLER offset clamps forward (never reorders)", () => {
    const flow = buildTurnFlow(TEXT, [
      anchor(30, "exec", "completed", "a"),
      anchor(5, "read", "completed", "b"), // clamps to 30 -> same group
    ]);
    const groups = flow.filter((s) => s.kind === "activity");
    expect(groups).toHaveLength(1);
  });
  it("whitespace-only text between groups merges them", () => {
    const text = "Para.\n\n\n\nSuite.";
    const flow = buildTurnFlow(text, [
      anchor(7, "read", "completed", "a"),
      anchor(9, "exec", "completed", "b"), // only "\n\n" between the cuts
    ]);
    const groups = flow.filter((s) => s.kind === "activity");
    expect(groups).toHaveLength(1);
    expect((groups[0] as { parts: unknown[] }).parts).toHaveLength(2);
  });
  it("tool-first empty-text turn: activity only, no empty text segments", () => {
    const flow = buildTurnFlow("", [anchor(0, "exec")]);
    expect(flow).toHaveLength(1);
    expect(flow[0]!.kind).toBe("activity");
  });
});

describe("activityLabel (every i18n branch)", () => {
  it("live:false forces the settled phrasing (lost completion on a terminal turn)", () => {
    expect(activityLabel([tool("web_search", "start")], { live: false })).toBe(
      "A effectué une recherche",
    );
  });
  it("live group -> present-tense working label of the running tool", () => {
    expect(activityLabel([tool("exec", "start")])).toBe(
      "Exécute une commande…",
    );
    expect(activityLabel([tool("web_search", "running")])).toBe(
      "Recherche en cours…",
    );
  });
  it("settled singles per family", () => {
    expect(activityLabel([tool("read")])).toBe("A lu un fichier");
    expect(activityLabel([tool("exec")])).toBe("A exécuté une commande");
    expect(activityLabel([tool("web_search")])).toBe(
      "A effectué une recherche",
    );
    expect(activityLabel([tool("web_fetch")])).toBe("A consulté une page");
    expect(activityLabel([tool("write")])).toBe("A écrit un fichier");
    expect(activityLabel([tool("sessions_spawn")])).toBe(
      "A utilisé sessions_spawn",
    );
  });
  it("settled plurals per family", () => {
    expect(
      activityLabel([tool("read", "completed", "a"), tool("cat", "completed", "b")]),
    ).toBe("A lu 2 fichiers");
    expect(
      activityLabel([
        tool("exec", "completed", "a"),
        tool("bash", "completed", "b"),
      ]),
    ).toBe("A exécuté 2 commandes");
  });
  it("composed multi-family phrase joins with « et » last", () => {
    expect(
      activityLabel([
        tool("read", "completed", "a"),
        tool("exec", "completed", "b"),
        tool("bash", "completed", "c"),
        tool("web_search", "completed", "d"),
      ]),
    ).toBe("A lu un fichier, exécuté 2 commandes et effectué une recherche");
  });
});

describe("dominantFamily / isLivePhase", () => {
  it("majority family wins; ties break by declaration order", () => {
    expect(
      dominantFamily([
        tool("read", "completed", "a"),
        tool("exec", "completed", "b"),
        tool("bash", "completed", "c"),
      ]),
    ).toBe("exec");
    expect(
      dominantFamily([tool("read", "completed", "a"), tool("exec", "completed", "b")]),
    ).toBe("read");
  });
  it("isLivePhase accepts the wire 'start' and the client aliases", () => {
    expect(isLivePhase("start")).toBe(true);
    expect(isLivePhase("started")).toBe(true);
    expect(isLivePhase("running")).toBe(true);
    expect(isLivePhase("completed")).toBe(false);
    expect(isLivePhase(undefined)).toBe(false);
  });
});
