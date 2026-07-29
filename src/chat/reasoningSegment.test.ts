/// <reference types="vite/client" />
//
// An assistant SEGMENT reaches the message BODY (lot 35 — the half of G-43 lot 34 left
// open).
//
// Lot 34 sealed Hermes' `message.interim` prose as a TOOL part. It was stored, and it was
// still lost: `InlineTurnActivity` renders nothing when `showTools` is false, and false is
// the DEFAULT (the deliberate "clean view"). So the fix saved the text where nobody could
// see it — the exact failure it existed to prevent, one layer further down.
//
// The segment is a CONTENT part now (`kind:"reasoning"`), which `convertMessage` routes
// into the message body, outside the Tools toggle entirely. This pins that routing: it is
// the seam where the previous mistake was made, and nothing else guards it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

function assistantWith(parts: ConvexMessageView["parts"]): ConvexMessageView {
  return {
    _id: "m1",
    _creationTime: 0,
    chatId: "c1",
    role: "assistant",
    status: "complete",
    text: "La réponse finale.",
    updatedAt: 1,
    parts,
  } as unknown as ConvexMessageView;
}

describe("an assistant segment lands in the BODY, not the activity row", () => {
  it("a reasoning part becomes a content part", () => {
    const converted = convertConvexMessage(
      assistantWith([
        { kind: "reasoning", text: "Je vérifie d'abord la configuration." },
      ] as never),
    );
    const content = converted.content as Array<{ type: string; text?: string }>;
    const segment = content.find((c) => c.type === "reasoning");
    expect(segment, "a segment routed anywhere else is a segment nobody sees").toBeDefined();
    expect(segment?.text).toContain("configuration");
  });

  it("…and it is NOT diverted into the tool activity", () => {
    // The whole point: tool parts go to `metadata.custom.toolParts`, which the renderer
    // hides when the Tools toggle is off. A segment must never end up there.
    const converted = convertConvexMessage(
      assistantWith([
        { kind: "reasoning", text: "Commentaire en cours" },
      ] as never),
    );
    const custom = (converted.metadata?.custom ?? {}) as {
      toolParts?: unknown[];
    };
    expect(custom.toolParts ?? []).toEqual([]);
  });

  it("the final reply is still delivered alongside it, in order", () => {
    const converted = convertConvexMessage(
      assistantWith([
        { kind: "reasoning", text: "Étape intermédiaire" },
      ] as never),
    );
    const content = converted.content as Array<{ type: string; text?: string }>;
    const kinds = content.map((c) => c.type);
    // Chronological: the segment precedes the answer it was produced before.
    expect(kinds.indexOf("reasoning")).toBeLessThan(kinds.lastIndexOf("text"));
    expect(
      content.some((c) => c.type === "text" && c.text === "La réponse finale."),
    ).toBe(true);
  });
});

describe("a segment cannot masquerade as something the USER wrote", () => {
  it("the renderer is registered on the assistant turn only", () => {
    // `plainComponents` dresses the USER and SYSTEM turns too. Registering the segment
    // there let a `reasoning` part render inside the user's own bubble, as if they had
    // typed it (raised in review). Read from the source, because the mistake was a single
    // line in a component map that no behavioural test could reach.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "ConvexChat.tsx"),
      "utf8",
    );
    const plain = src.slice(
      src.indexOf("const plainComponents = {"),
      src.indexOf("const assistantComponents = {"),
    );
    expect(plain).not.toMatch(/Reasoning/);
    const assistant = src.slice(src.indexOf("const assistantComponents = {"));
    expect(assistant.slice(0, 900)).toMatch(/Reasoning: ReasoningSegment/);
  });
});
