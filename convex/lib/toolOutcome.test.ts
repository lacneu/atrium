import { describe, expect, it } from "vitest";
import { textIsYieldAcknowledgment, type YieldAckToolPart } from "./toolOutcome";

const ACK = "Oui. Je vérifie d'abord le corpus, puis je te l'explique.";
const yieldPart = (over: Partial<YieldAckToolPart> = {}): YieldAckToolPart => ({
  kind: "tool",
  name: "sessions_yield",
  phase: "completed",
  input: { acknowledgment: ACK, waitFor: "message" },
  output: { details: { status: "yielded", acknowledgment: ACK } },
  ...over,
});

describe("textIsYieldAcknowledgment", () => {
  it("is true when the bubble's whole text is a handed-off yield's acknowledgment", () => {
    expect(textIsYieldAcknowledgment(ACK, [yieldPart()])).toBe(true);
    // Whitespace is not a difference a reader sees.
    expect(textIsYieldAcknowledgment(`  ${ACK.replace(" ", "\n")} `, [yieldPart()])).toBe(true);
  });

  it("is false when the turn wrote its own words, or a continuation answered after it", () => {
    expect(textIsYieldAcknowledgment(`${ACK}\n\nVoici l'explication…`, [yieldPart()])).toBe(false);
    expect(textIsYieldAcknowledgment("Une vraie réponse.", [yieldPart()])).toBe(false);
    expect(textIsYieldAcknowledgment("", [yieldPart()])).toBe(false);
  });

  it("is false for a yield the gateway REFUSED, or one we cannot read", () => {
    // A refusal answers through a success-shaped result carrying `status:"error"`.
    expect(
      textIsYieldAcknowledgment(ACK, [yieldPart({ output: { details: { status: "error" } } })]),
    ).toBe(false);
    expect(textIsYieldAcknowledgment(ACK, [yieldPart({ phase: "error" })])).toBe(false);
    // An input elided from the view proves nothing.
    expect(textIsYieldAcknowledgment(ACK, [yieldPart({ input: undefined })])).toBe(false);
    // Another tool carrying the same words is not a hand-off.
    expect(textIsYieldAcknowledgment(ACK, [yieldPart({ name: "message" })])).toBe(false);
  });
});
