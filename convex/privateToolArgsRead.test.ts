// THE LEAK THAT WAS ALREADY IN THE DATABASE.
//
// The bridge stopped writing `sessions_yield.message` — the note an agent leaves
// for its own resumed turn, private by upstream's schema. That protects new turns
// and nothing else: every conversation that ran before the repair still holds the
// value, and the read projections handed it back to the chat, where `ToolCard`
// renders it. Reopening an old conversation showed it again.

import { describe, expect, it } from "vitest";
import {
  readableToolText,
  readableToolValue,
} from "./lib/privateToolArgs";

const PRIVATE = "Attendre la livraison puis vérifier les fichiers.";
const ACK = "Je te livre ça dès que c'est prêt.";

describe("a private note already on disk is not displayable", () => {
  it("strips it from a historic INPUT", () => {
    const out = readableToolValue(
      "sessions_yield",
      { message: PRIVATE, acknowledgment: ACK },
      "input",
    );
    expect(JSON.stringify(out)).not.toContain(PRIVATE);
    expect(JSON.stringify(out)).toContain(ACK);
  });

  it("strips it from a historic OUTPUT, echo included, on BOTH array names", () => {
    for (const key of ["content", "contentItems"] as const) {
      const out = readableToolValue(
        "sessions_yield",
        {
          [key]: [
            {
              type: "text",
              text: JSON.stringify({ status: "yielded", message: PRIVATE }),
            },
          ],
          details: { status: "yielded", message: PRIVATE, acknowledgment: ACK },
        },
        "output",
      );
      expect(JSON.stringify(out), key).not.toContain(PRIVATE);
      expect(JSON.stringify(out), key).toContain(ACK);
    }
  });

  it("strips it from a sub-agent panel's flat detail text", () => {
    const raw = JSON.stringify({ status: "yielded", message: PRIVATE, acknowledgment: ACK });
    const out = readableToolText("sessions_yield", raw, "output") ?? "";
    expect(out).not.toContain(PRIVATE);
    expect(out).toContain(ACK);
  });

  it("…but keeps a REFUSAL's public message in that same panel", () => {
    // The text path used to strip unconditionally while the value path kept it —
    // the two readers of one rule disagreed, and the panel censored the only
    // sentence saying why the card reads "deferred".
    const PUBLIC = "Earlier async tool results are still being delivered.";
    const raw = JSON.stringify({ status: "deferred", message: PUBLIC });
    expect(readableToolText("sessions_yield", raw, "output")).toContain(PUBLIC);
  });

  it("an INPUT is stripped whatever the status says", () => {
    // The private note lives in the CALL. Only the echo needs the status gate.
    const raw = JSON.stringify({ message: PRIVATE, acknowledgment: ACK });
    const out = readableToolText("sessions_yield", raw, "input") ?? "";
    expect(out).not.toContain(PRIVATE);
    expect(out).toContain(ACK);
  });

  it("does NOT censor upstream's public refusal message", () => {
    // `message` is also upstream's own explanation on a refusal path:
    // {status:"deferred", message:"Earlier async tool results are still being
    // delivered…"}. Deleting it removes the only sentence saying why.
    const PUBLIC = "Earlier async tool results are still being delivered.";
    const out = readableToolValue(
      "sessions_yield",
      { details: { status: "deferred", message: PUBLIC } },
      "output",
    );
    expect(JSON.stringify(out)).toContain(PUBLIC);
  });

  it("leaves every other tool alone — including one with its own `message`", () => {
    const value = { message: "Voici le résultat.", to: "user" };
    expect(readableToolValue("message", value, "input")).toBe(value);
    expect(readableToolText("exec", "message: ok", "output")).toBe("message: ok");
  });

  it("a TRUNCATED detail that still carries the note is dropped, not passed through", () => {
    // The sub-agent observer serializes the call and then CUTS it at 2 000 / 4 000
    // characters, so a historic detail routinely fails to parse WHILE carrying the
    // whole private note. Failing open there — the right rule for nested prose —
    // handed it to the panel and to the archive export.
    const full = JSON.stringify({
      status: "yielded",
      message: PRIVATE + " ".repeat(3000),
      acknowledgment: ACK,
    });
    const truncated = full.slice(0, 2000);
    expect(truncated).toContain(PRIVATE);
    expect(() => JSON.parse(truncated)).toThrow();
    for (const slot of ["input", "output"] as const) {
      const out = readableToolText("sessions_yield", truncated, slot);
      expect(out ?? "", slot).not.toContain(PRIVATE);
    }
  });

  it("a HISTORIC envelope carries its status nested — read it there", () => {
    // The observer serialized the whole envelope, so the status is not at the root:
    // `{contentItems:[{text:"{…status:yielded, message:…}"}], success:true}`. A
    // root-level check found none, called the call a refusal, and returned the note
    // untouched — the exact shape in this repo's captured sub-agent fixtures.
    const envelope = JSON.stringify({
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ status: "yielded", message: PRIVATE, acknowledgment: ACK }),
        },
      ],
      success: true,
    });
    const out = readableToolText("sessions_yield", envelope, "output") ?? "";
    expect(out, "the nested status must be found").not.toContain(PRIVATE);
    expect(out).toContain(ACK);
  });

  it("…and a nested REFUSAL status still protects its public message", () => {
    const PUBLIC = "Earlier async tool results are still being delivered.";
    const envelope = JSON.stringify({
      contentItems: [
        { type: "inputText", text: JSON.stringify({ status: "deferred", message: PUBLIC }) },
      ],
    });
    expect(readableToolText("sessions_yield", envelope, "output")).toContain(PUBLIC);
  });

  it("a truncated detail with NO private key is untouched", () => {
    // The drop is scoped to the leak; an ordinary truncated echo keeps its value.
    const truncated = JSON.stringify({ status: "yielded", acknowledgment: ACK }).slice(0, 30);
    expect(readableToolText("sessions_yield", truncated, "output")).toBe(truncated);
  });

  it("prose that merely quotes the key survives", () => {
    const prose = 'Je vérifie le champ "message" du formulaire.';
    const out = readableToolValue(
      "sessions_yield",
      { message: PRIVATE, acknowledgment: prose },
      "input",
    ) as { acknowledgment?: string };
    expect(out.acknowledgment).toBe(prose);
  });
});
