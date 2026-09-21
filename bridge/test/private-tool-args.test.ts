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

  it("drops it from the OUTPUT, including the gateway's JSON echo", () => {
    // The real 2026-09-20 shape, verbatim: `details` carries the structured copy
    // and `content[0].text` carries the same object re-serialized.
    const out = redactPrivateToolArgs("sessions_yield", {
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
    });
    const s = JSON.stringify(out);
    expect(s, "the echo is the leak that survives a key-only strip").not.toContain(
      PRIVATE,
    );
    expect(s).toContain(ACK);
    expect(s).toContain("yielded");
  });

  it("a NON-JSON text that names the private key is refused whole", () => {
    // Fail CLOSED: we cannot tell where the value ends in free text, and this
    // only ever runs for an allowlisted tool.
    const out = redactPrivateToolArgs("sessions_yield", {
      content: [{ type: "text", text: `note "message" = ${PRIVATE}` }],
    });
    expect(JSON.stringify(out)).not.toContain(PRIVATE);
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
