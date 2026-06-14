/**
 * CONF-4a `/patch` + P2-4 "unsets survive like sets": the knob intent (sets +
 * `clears`) rides COMPLETE under `sessionSettings` — the same nested shape the
 * `/send` body carries (one source of truth). Pins the footguns:
 * (1) `false` is a VALID fastMode value (a falsy check would drop "Standard"),
 * (2) clears send a LITERAL null to `sessions.patch` (the verified 6.5 unset)
 *     and run BEFORE the remaining intent,
 * (3) the per-turn re-apply (applySessionSettings) ALSO applies persisted
 *     clears, so an unset lost to a bridge outage is repaired next turn,
 * (4) a clears entry outside the allowlist poisons the WHOLE body (400) —
 *     for /patch AND /send.
 */

import { describe, expect, it } from "vitest";

import {
  applyPatchIntent,
  applySessionSettings,
  parsePatchBody,
  parseSendBody,
  parseSessionSettings,
} from "../src/server.js";
import type { GatewayRequester } from "../src/conf.js";

const R = { agentId: "agent-a", canonical: "alice" };

/** Records sessions.patch calls in order; optionally fails the Nth call. */
function mockGateway(failAtCall?: number) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const conn: GatewayRequester = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (failAtCall !== undefined && calls.length === failAtCall) {
        throw new Error("patch failed");
      }
      return { payload: {} };
    },
  };
  return { conn, calls };
}

describe("parsePatchBody — sessionSettings.clears allowlist", () => {
  it("accepts a clears-only body (unset with no new value)", () => {
    const body = parsePatchBody(
      JSON.stringify({
        chatId: "c1",
        sessionSettings: { clears: ["thinkingLevel"] },
        ...R,
      }),
    );
    expect(body).toMatchObject({
      chatId: "c1",
      sessionSettings: {
        thinkingLevel: null,
        model: null,
        clears: ["thinkingLevel"],
      },
    });
  });

  it("accepts every allowlisted field, alone or combined", () => {
    const body = parsePatchBody(
      JSON.stringify({
        chatId: "c1",
        sessionSettings: { clears: ["thinkingLevel", "model", "fastMode"] },
        ...R,
      }),
    );
    expect(body?.sessionSettings.clears).toEqual([
      "thinkingLevel",
      "model",
      "fastMode",
    ]);
  });

  it("REJECTS any clears entry outside the allowlist (whole body -> 400)", () => {
    for (const clears of [
      ["verboseLevel"], // not clearable (pinned full for streaming)
      ["thinkingLevel", "elevatedLevel"], // one bad entry poisons the body
      ["label"],
      [42],
      "thinkingLevel", // not an array
    ]) {
      expect(
        parsePatchBody(
          JSON.stringify({ chatId: "c1", sessionSettings: { clears }, ...R }),
        ),
      ).toBeNull();
    }
  });

  it("an empty clears array alone is NOT a patch (nothing to do)", () => {
    expect(
      parsePatchBody(
        JSON.stringify({ chatId: "c1", sessionSettings: { clears: [] }, ...R }),
      ),
    ).toBeNull();
  });

  it("a malformed clears list poisons a /send body too (never drop an unset)", () => {
    const send = {
      chatId: "c1",
      openclawChatId: "oc1",
      text: "hi",
      clientMessageId: "m1",
      ...R,
    };
    expect(
      parseSendBody(
        JSON.stringify({ ...send, sessionSettings: { clears: ["evil"] } }),
      ),
    ).toBeNull();
    // ...while a VALID clears list rides into the send intent.
    expect(
      parseSendBody(
        JSON.stringify({ ...send, sessionSettings: { clears: ["model"] } }),
      )?.sessionSettings,
    ).toMatchObject({ clears: ["model"] });
  });
});

describe("parsePatchBody — fastMode knob (nested)", () => {
  it("parses fastMode=false as a REAL knob (false is a value, not absence)", () => {
    const body = parsePatchBody(
      JSON.stringify({ chatId: "c1", sessionSettings: { fastMode: false }, ...R }),
    );
    expect(body?.sessionSettings).toMatchObject({
      fastMode: false,
      thinkingLevel: null,
      model: null,
    });
  });

  it("parses fastMode=true", () => {
    expect(
      parsePatchBody(
        JSON.stringify({ chatId: "c1", sessionSettings: { fastMode: true }, ...R }),
      )?.sessionSettings,
    ).toMatchObject({ fastMode: true });
  });

  it("ignores a non-boolean fastMode (defensive) — body invalid if nothing else", () => {
    expect(
      parsePatchBody(
        JSON.stringify({ chatId: "c1", sessionSettings: { fastMode: "true" }, ...R }),
      ),
    ).toBeNull();
    expect(
      parsePatchBody(
        JSON.stringify({
          chatId: "c1",
          sessionSettings: { fastMode: 1, model: "gpt-5.5" },
          ...R,
        }),
      )?.sessionSettings,
    ).toMatchObject({ model: "gpt-5.5" });
  });
});

describe("parseSessionSettings — clears + fastMode intent", () => {
  it("keeps fastMode=false (presence by !== undefined, never falsy)", () => {
    expect(parseSessionSettings({ fastMode: false })).toEqual({
      thinkingLevel: null,
      model: null,
      fastMode: false,
    });
  });

  it("drops a non-boolean fastMode and stays null when nothing remains", () => {
    expect(parseSessionSettings({ fastMode: "yes" })).toBeNull();
    expect(parseSessionSettings({ fastMode: 0 })).toBeNull();
  });

  it("clears alone IS an intent; empty clears is the same as absent", () => {
    expect(parseSessionSettings({ clears: ["fastMode"] })).toEqual({
      thinkingLevel: null,
      model: null,
      clears: ["fastMode"],
    });
    expect(parseSessionSettings({ clears: [] })).toBeNull();
  });

  it("an out-of-allowlist clears entry returns the 'invalid' poison marker", () => {
    expect(parseSessionSettings({ clears: ["verboseLevel"] })).toBe("invalid");
    expect(parseSessionSettings({ model: "gpt-5.5", clears: [3] })).toBe("invalid");
  });
});

describe("applyPatchIntent — clears before intent, literal null sent", () => {
  it("sends sessions.patch {field: null} for each clear, THEN the intent", async () => {
    const { conn, calls } = mockGateway();
    await applyPatchIntent(conn, "sk", {
      clears: ["model", "fastMode"],
      thinkingLevel: "low",
      model: null,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "sessions.patch",
      "sessions.patch",
      "sessions.patch",
    ]);
    // Clears FIRST, each with the field PRESENT and literally null (the
    // verified unset shape) — not merely absent.
    expect(calls[0]!.params).toEqual({ key: "sk", model: null });
    expect("model" in calls[0]!.params).toBe(true);
    expect(calls[1]!.params).toEqual({ key: "sk", fastMode: null });
    // Then the remaining intent — and the clears are NOT re-sent by the
    // delegated applySessionSettings (exactly 3 calls total).
    expect(calls[2]!.params).toEqual({ key: "sk", thinkingLevel: "low" });
  });

  it("applies fastMode=false as a value (not skipped by a falsy check)", async () => {
    const { conn, calls } = mockGateway();
    await applyPatchIntent(conn, "sk", {
      thinkingLevel: null,
      model: null,
      fastMode: false,
    });
    expect(calls).toEqual([
      { method: "sessions.patch", params: { key: "sk", fastMode: false } },
    ]);
  });

  it("a failed CLEAR rejects (must surface as 502, never fake success)", async () => {
    const { conn } = mockGateway(1);
    await expect(
      applyPatchIntent(conn, "sk", {
        clears: ["thinkingLevel"],
        thinkingLevel: null,
        model: null,
      }),
    ).rejects.toThrow("patch failed");
  });

  it("a failed knob APPLY stays non-fatal (existing applySessionSettings contract)", async () => {
    const { conn, calls } = mockGateway(1);
    await expect(
      applyPatchIntent(conn, "sk", {
        thinkingLevel: "low",
        model: null,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1); // attempted, swallowed (logged) per UI-3 design
  });
});

describe("applySessionSettings — per-turn re-apply repairs persisted unsets (P2-4)", () => {
  it("applies clears (literal null) BEFORE the sets, from the SAME intent", async () => {
    const { conn, calls } = mockGateway();
    await applySessionSettings(conn, "sk", {
      thinkingLevel: null,
      model: "gpt-5.5",
      clears: ["thinkingLevel"],
    });
    expect(calls).toEqual([
      { method: "sessions.patch", params: { key: "sk", thinkingLevel: null } },
      { method: "sessions.patch", params: { key: "sk", model: "gpt-5.5" } },
    ]);
  });

  it("stays non-fatal when a clear fails (a turn must never break on re-apply)", async () => {
    const { conn, calls } = mockGateway(1);
    await expect(
      applySessionSettings(conn, "sk", {
        thinkingLevel: null,
        model: null,
        clears: ["fastMode"],
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
