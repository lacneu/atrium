import { describe, expect, it } from "vitest";
import { promptWithFreshSessionHistory } from "../src/providers/hermes/dispatch.js";
import type { ConvexWriter } from "../src/convex-writer.js";

// FRESH-session history carry on the Hermes path (chatFork parity with the
// OpenClaw rehydration): a branched/new chat's first Hermes prompt must carry
// the conversation history, with the SAME guards as OpenClaw (per-instance
// knob, attachment turns stay lean, best-effort on fetch failure).

function writerWith(
  history: string | null,
  opts?: { throws?: boolean },
): ConvexWriter {
  return {
    getRehydrationContext: async () => {
      if (opts?.throws) throw new Error("convex down");
      return { history, turnCount: 2 };
    },
  } as unknown as ConvexWriter;
}

const BODY = {
  chatId: "c1",
  agentId: "hermes-agent",
  canonical: "u",
  openclawChatId: null,
  text: "Et maintenant ?",
  // The current user message id -- REQUIRED for the prepend (it is how the
  // rehydration context excludes the already-persisted current message).
  messageId: "msg-user-1",
};

describe("promptWithFreshSessionHistory (Hermes fresh-session rehydration)", () => {
  it("a FRESH session prepends the chat history before the prompt", async () => {
    const out = await promptWithFreshSessionHistory(
      writerWith("[HISTORIQUE]\nuser: bonjour\nassistant: salut"),
      BODY,
      true,
    );
    expect(out).toBe("[HISTORIQUE]\nuser: bonjour\nassistant: salut\n\nEt maintenant ?");
  });

  it("a WARM session ships the bare prompt (no double-grounding)", async () => {
    const out = await promptWithFreshSessionHistory(writerWith("[H]"), BODY, false);
    expect(out).toBe("Et maintenant ?");
  });

  it("the per-instance rehydration knob disables the carry", async () => {
    const out = await promptWithFreshSessionHistory(
      writerWith("[H]"),
      { ...BODY, config: { rehydration: false } },
      true,
    );
    expect(out).toBe("Et maintenant ?");
  });

  it("an ATTACHMENT turn stays lean (mirror of the OpenClaw guard)", async () => {
    const out = await promptWithFreshSessionHistory(
      writerWith("[H]"),
      {
        ...BODY,
        attachments: [{ mimeType: "image/png", fileName: "x.png", content: "AAAA" }],
      },
      true,
    );
    expect(out).toBe("Et maintenant ?");
  });

  it("a context-fetch failure degrades to the bare prompt (a cold agent beats a failed send)", async () => {
    const out = await promptWithFreshSessionHistory(
      writerWith(null, { throws: true }),
      BODY,
      true,
    );
    expect(out).toBe("Et maintenant ?");
  });

  it("an EMPTY history (nothing to carry) ships the bare prompt", async () => {
    const out = await promptWithFreshSessionHistory(writerWith(null), BODY, true);
    expect(out).toBe("Et maintenant ?");
  });

  it("NO messageId (legacy caller) ships the bare prompt — no exclusion means the history would DUPLICATE the current message", async () => {
    const out = await promptWithFreshSessionHistory(
      writerWith("[H]\nuser: Et maintenant ?"),
      { ...BODY, messageId: undefined },
      true,
    );
    expect(out).toBe("Et maintenant ?");
  });
});
