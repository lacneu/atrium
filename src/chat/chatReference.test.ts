import { describe, expect, it } from "vitest";
import { parseChatReferenceCandidate } from "./chatReference";

describe("parseChatReferenceCandidate", () => {
  it("accepts bare Convex-id-shaped tokens and env-labeled ones (whitespace-tolerant)", () => {
    const id = "m97d7wssw16tz5n1jqmhsms34h8afb9g";
    expect(parseChatReferenceCandidate(id)).toBe(id);
    expect(parseChatReferenceCandidate(`dev-${id}`)).toBe(`dev-${id}`);
    expect(parseChatReferenceCandidate(`  preprod_2.1-${id}\n`)).toBe(
      `preprod_2.1-${id}`,
    );
  });
  it("rejects ordinary pastes (sentences, URLs, short tokens, multiline)", () => {
    expect(parseChatReferenceCandidate("regarde cette conversation")).toBeNull();
    expect(
      parseChatReferenceCandidate("https://chat.example.com/chat/m97d7"),
    ).toBeNull();
    expect(parseChatReferenceCandidate("dev-abc")).toBeNull();
    expect(
      parseChatReferenceCandidate("m97d7wssw16tz5n1jqmhsms34h8afb9g\nsuite"),
    ).toBeNull();
    expect(parseChatReferenceCandidate("")).toBeNull();
  });
});
