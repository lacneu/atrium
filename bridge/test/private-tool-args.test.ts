// The redaction itself, pinned away from the sink so its edges are provable.
//
// The leak had THREE readers on the way to the screen (`args`, `argsText`,
// `result`), and the gateway echoes the call's JSON back inside the result's text
// content. A guard that only cleaned the structured copy would have moved the
// leak, not closed it.

import { describe, expect, it } from "vitest";

import { redactPrivateToolArgs } from "../src/core/private-tool-args.js";

const PRIVATE = "Attendre la livraison puis vérifier les fichiers.";
const ACK = "Je le prépare et je te le livre ici.";

describe("private tool arguments never reach the database", () => {
  it("drops `message` from a sessions_yield INPUT and keeps the acknowledgment", () => {
    const out = redactPrivateToolArgs("sessions_yield", {
      message: PRIVATE,
      acknowledgment: ACK,
    });
    expect(JSON.stringify(out)).not.toContain(PRIVATE);
    expect(out).toEqual({ acknowledgment: ACK });
  });

  it("drops it from the OUTPUT of a SUCCESSFUL yield, echo included", () => {
    // The real 2026-09-20 shape, verbatim: `details` carries the structured copy
    // and `content[0].text` carries the same object re-serialized.
    const out = redactPrivateToolArgs(
      "sessions_yield",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "yielded", message: PRIVATE, acknowledgment: ACK },
              null,
              2,
            ),
          },
        ],
        details: { status: "yielded", message: PRIVATE, acknowledgment: ACK },
      },
      "output",
    );
    const s = JSON.stringify(out);
    expect(s, "the echo is the leak that survives a key-only strip").not.toContain(
      PRIVATE,
    );
    expect(s).toContain(ACK);
    expect(s).toContain("yielded");
  });

  it("PROSE that merely quotes the key survives — it is not an echo", () => {
    // The first version blanked any string containing `"message"`, on a
    // fail-closed argument. Wrong here: the one tool this runs for has a
    // free-prose field written by the model, so an acknowledgment quoting the
    // word was silently replaced by an empty string. A guard that deletes the
    // sentence it exists to protect is broken, not closed.
    const prose = 'Je vérifie le champ "message" du formulaire et je reviens.';
    const out = redactPrivateToolArgs("sessions_yield", {
      message: PRIVATE,
      acknowledgment: prose,
    });
    expect(JSON.stringify(out)).not.toContain(PRIVATE);
    expect((out as { acknowledgment?: string }).acknowledgment).toBe(prose);
  });

  it("upstream's PUBLIC refusal message is not censored", () => {
    // `message` is also upstream's own explanation on the refusal paths:
    // {status:"deferred", message:"Earlier async tool results are still being
    // delivered…"} (sessions-yield-tool.ts:66-72). Stripping it deleted the only
    // sentence telling the reader why the card says "deferred".
    const PUBLIC =
      "Earlier async tool results are still being delivered. Finish this response to receive them.";
    const out = redactPrivateToolArgs(
      "sessions_yield",
      {
        content: [
          { type: "text", text: JSON.stringify({ status: "deferred", message: PUBLIC }) },
        ],
        details: { status: "deferred", message: PUBLIC },
      },
      "output",
    );
    expect(JSON.stringify(out)).toContain(PUBLIC);
  });

  it("leaves EVERY other tool untouched — including one with its own `message`", () => {
    // The allowlist is the point: a blanket key strip would gut the `message`
    // pseudo-tool, which IS the visible reply.
    const value = { message: "Voici le résultat.", to: "user" };
    expect(redactPrivateToolArgs("message", value)).toBe(value);
    expect(redactPrivateToolArgs("exec", value)).toBe(value);
  });

  it("survives a cyclic payload without costing the turn", () => {
    const a: Record<string, unknown> = { acknowledgment: ACK };
    a.self = a;
    expect(() => redactPrivateToolArgs("sessions_yield", a)).not.toThrow();
  });

  it("undefined stays undefined — an absent argument is not an empty one", () => {
    expect(redactPrivateToolArgs("sessions_yield", undefined)).toBeUndefined();
  });
});
