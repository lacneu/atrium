/// <reference types="vite/client" />
//
// Prose that is NOT the answer reaches the message BODY (lot 35, then 0.103.0).
//
// Lot 34 sealed Hermes' `message.interim` prose as a TOOL part. It was stored, and it was
// still lost: `InlineTurnActivity` renders nothing when `showTools` is false, and false is
// the DEFAULT (the deliberate "clean view"). So the fix saved the text where nobody could
// see it — the exact failure it existed to prevent, one layer further down.
//
// 0.103.0 tells two natures apart (`nature` on the part): the agent's WORK NOTE
// (`commentary`, and every part written before the field existed) and the MODEL'S REASONING
// (`thinking`). Both are content parts the body renders, outside the Tools toggle, each by
// its own component (ReasoningBlocks.tsx). This pins that routing: it is the seam where the
// previous mistake was made, and nothing else guards it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

function assistantWith(parts: ConvexMessageView["parts"], extra: Partial<ConvexMessageView> = {}): ConvexMessageView {
  return {
    _id: "m1",
    _creationTime: 0,
    chatId: "c1",
    role: "assistant",
    status: "complete",
    text: "La réponse finale.",
    updatedAt: 1,
    parts,
    ...extra,
  } as unknown as ConvexMessageView;
}

type Content = Array<{ type: string; text?: string; data?: { text: string; open?: boolean } }>;

describe("a work note lands in the BODY, not the activity row", () => {
  it("a part written before 0.103.0 (no nature) is a work note, shown in the body", () => {
    const content = convertConvexMessage(assistantWith([{ kind: "reasoning", text: "Je vérifie d'abord la configuration." }] as never)).content as Content;
    const note = content.find((c) => c.type === "data-commentary");
    expect(note?.data?.text, "a segment routed anywhere else is a segment nobody sees").toContain("configuration");
    // Never the model's reasoning: an old part is not re-labelled.
    expect(content.some((c) => c.type === "data-thinking")).toBe(false);
  });

  it("…and it is NOT diverted into the tool activity", () => {
    // The whole point: tool parts go to `metadata.custom.toolParts`, which the renderer
    // hides when the Tools toggle is off. A segment must never end up there.
    const converted = convertConvexMessage(assistantWith([{ kind: "reasoning", text: "Commentaire en cours" }] as never));
    const custom = (converted.metadata?.custom ?? {}) as { toolParts?: unknown[] };
    expect(custom.toolParts ?? []).toEqual([]);
  });

  it("the final reply is still delivered alongside it, in order", () => {
    const content = convertConvexMessage(assistantWith([{ kind: "reasoning", text: "Étape intermédiaire" }] as never)).content as Content;
    const kinds = content.map((c) => c.type);
    // Chronological: the segment precedes the answer it was produced before.
    expect(kinds.indexOf("data-commentary")).toBeLessThan(kinds.lastIndexOf("text"));
    expect(content.some((c) => c.type === "text" && c.text === "La réponse finale.")).toBe(true);
  });

  it("a work note with a place sits in the narrative, between what was said before and after", () => {
    const content = convertConvexMessage(
      assistantWith([{ kind: "reasoning", nature: "commentary", text: "Je lance la commande.", textOffset: 6 }] as never, { text: "Début.\nFin." }),
    ).content as Content;
    expect(content.map((c) => [c.type, c.text ?? c.data?.text])).toEqual([
      ["text", "Début."],
      ["data-commentary", "Je lance la commande."],
      ["text", "\nFin."],
    ]);
  });
});

describe("the model's reasoning: its own block, folded once the answer begins", () => {
  it("Hermes' reasoning of the turn sits above the reply, folded on a settled bubble", () => {
    const content = convertConvexMessage(assistantWith([{ kind: "reasoning", nature: "thinking", text: "Je compare." }] as never)).content as Content;
    expect(content.map((c) => c.type)).toEqual(["data-thinking", "text"]);
    expect(content[0]!.data).toMatchObject({ text: "Je compare.", open: false });
  });

  it("open while the bubble runs and no answer follows it; folded as soon as one does", () => {
    const running = convertConvexMessage(
      assistantWith([{ kind: "reasoning", nature: "thinking", text: "Je compare." }] as never, { status: "streaming", text: "" }),
    ).content as Content;
    expect(running.find((c) => c.type === "data-thinking")?.data?.open).toBe(true);
    const answering = convertConvexMessage(
      assistantWith([{ kind: "reasoning", nature: "thinking", text: "Je compare." }] as never, { status: "streaming", text: "La rép" }),
    ).content as Content;
    expect(answering.find((c) => c.type === "data-thinking")?.data?.open).toBe(false);
  });

  it("an empty reasoning is no block", () => {
    const content = convertConvexMessage(assistantWith([{ kind: "reasoning", nature: "thinking", text: "  " }] as never)).content as Content;
    expect(content.some((c) => c.type === "data-thinking")).toBe(false);
  });
});

describe("a segment cannot masquerade as something the USER wrote", () => {
  it("the renderers are registered on the assistant turn only", () => {
    // `plainComponents` dresses the USER and SYSTEM turns too. Registering the segment
    // there let a `reasoning` part render inside the user's own bubble, as if they had
    // typed it (raised in review). Read from the source, because the mistake was a single
    // line in a component map that no behavioural test could reach.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ConvexChat.tsx"), "utf8");
    const plain = src.slice(src.indexOf("const plainComponents = {"), src.indexOf("const assistantComponents = {"));
    expect(plain).not.toMatch(/ThinkingBlock|CommentaryNote|Reasoning/);
    const assistant = src.slice(src.indexOf("const assistantComponents = {"));
    expect(assistant.slice(0, 1600)).toMatch(/thinking: ThinkingBlock/);
    expect(assistant.slice(0, 1600)).toMatch(/commentary: CommentaryNote/);
  });
});
