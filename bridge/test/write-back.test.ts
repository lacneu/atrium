/**
 * UI-3 write-back: pure-function unit tests for the knob-patch path.
 *
 * The live browser run proved the happy path on one chat; these pin the edge
 * cases the live test does NOT exercise — empty/partial `/patch` bodies, the
 * "changing one knob never drops the other" intent shape, and the dedupe of
 * `models.list` ids across providers. Pure (no socket / no Convex).
 */

import { describe, expect, it } from "vitest";

import {
  parsePatchBody,
  parseSessionSettings,
  dedupeModels,
} from "../src/server.js";

describe("parsePatchBody", () => {
  // Every body now carries the per-turn routing (agentId + canonical) Convex
  // resolves; the parser requires it (no env fallback — Phase 2 prod fix).
  // The knob intent rides COMPLETE under `sessionSettings` — the same nested
  // shape as /send (one source of truth, P2-4); flat knob fields are gone.
  const R = { agentId: "agent-a", canonical: "alice" };

  it("parses a reasoning-only patch", () => {
    const body = parsePatchBody(
      JSON.stringify({
        chatId: "c1",
        openclawChatId: "oc1",
        sessionSettings: { thinkingLevel: "low" },
        ...R,
      }),
    );
    expect(body).toEqual({
      chatId: "c1",
      openclawChatId: "oc1",
      sessionSettings: { thinkingLevel: "low", model: null },
      agentId: "agent-a",
      canonical: "alice",
      instanceName: null,
    });
  });

  it("parses a model-only patch", () => {
    const body = parsePatchBody(
      JSON.stringify({ chatId: "c1", sessionSettings: { model: "gpt-5.5" }, ...R }),
    );
    expect(body).toMatchObject({
      chatId: "c1",
      sessionSettings: { model: "gpt-5.5", thinkingLevel: null },
    });
    expect(body?.openclawChatId).toBeNull();
  });

  it("rejects a body with NO knob (nothing to patch)", () => {
    expect(parsePatchBody(JSON.stringify({ chatId: "c1", ...R }))).toBeNull();
    expect(
      parsePatchBody(
        JSON.stringify({
          chatId: "c1",
          sessionSettings: { thinkingLevel: "", model: "" },
          ...R,
        }),
      ),
    ).toBeNull();
  });

  it("rejects FLAT knob fields (the pre-P2-4 body shape is gone)", () => {
    expect(
      parsePatchBody(JSON.stringify({ chatId: "c1", thinkingLevel: "low", ...R })),
    ).toBeNull();
    expect(
      parsePatchBody(JSON.stringify({ chatId: "c1", clears: ["model"], ...R })),
    ).toBeNull();
  });

  it("rejects a body missing chatId", () => {
    expect(
      parsePatchBody(
        JSON.stringify({ sessionSettings: { thinkingLevel: "low" }, ...R }),
      ),
    ).toBeNull();
  });

  it("rejects a body missing routing (agentId/canonical) — no env fallback", () => {
    expect(
      parsePatchBody(
        JSON.stringify({ chatId: "c1", sessionSettings: { thinkingLevel: "low" } }),
      ),
    ).toBeNull();
    expect(
      parsePatchBody(
        JSON.stringify({
          chatId: "c1",
          sessionSettings: { thinkingLevel: "low" },
          agentId: "agent-a",
        }),
      ),
    ).toBeNull(); // canonical still missing
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(parsePatchBody("{not json")).toBeNull();
    expect(parsePatchBody("null")).toBeNull();
    expect(parsePatchBody("42")).toBeNull();
  });

  it("ignores non-string knob values (defensive)", () => {
    const body = parsePatchBody(
      JSON.stringify({
        chatId: "c1",
        sessionSettings: { thinkingLevel: 3, model: "gpt-5.5" },
        ...R,
      }),
    );
    expect(body?.sessionSettings).toMatchObject({
      thinkingLevel: null,
      model: "gpt-5.5",
    });
  });
});

describe("parseSessionSettings", () => {
  it("returns null for non-objects / null", () => {
    expect(parseSessionSettings(null)).toBeNull();
    expect(parseSessionSettings("low")).toBeNull();
    expect(parseSessionSettings(undefined)).toBeNull();
  });

  it("returns null when no knob is present", () => {
    expect(parseSessionSettings({})).toBeNull();
    expect(parseSessionSettings({ thinkingLevel: "", model: "" })).toBeNull();
  });

  it("keeps both knobs when both present (no drop)", () => {
    expect(parseSessionSettings({ thinkingLevel: "low", model: "gpt-5.5" })).toEqual({
      thinkingLevel: "low",
      model: "gpt-5.5",
    });
  });

  it("keeps a single knob and nulls the other", () => {
    expect(parseSessionSettings({ thinkingLevel: "high" })).toEqual({
      thinkingLevel: "high",
      model: null,
    });
  });
});

describe("dedupeModels", () => {
  it("dedupes the same id across providers (first name wins)", () => {
    const out = dedupeModels([
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai" },
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      { id: "gpt-5.5", name: "gpt-5.5", provider: "openai-codex" },
    ]);
    expect(out).toEqual([
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
  });

  it("falls back to the id when name is missing/empty", () => {
    expect(dedupeModels([{ id: "x" }, { id: "y", name: "" }])).toEqual([
      { id: "x", label: "x" },
      { id: "y", label: "y" },
    ]);
  });

  it("drops entries with no valid id, and handles non-arrays", () => {
    expect(dedupeModels([{ name: "no id" }, { id: 7 }, { id: "ok" }])).toEqual([
      { id: "ok", label: "ok" },
    ]);
    expect(dedupeModels(undefined)).toEqual([]);
    expect(dedupeModels({ models: [] })).toEqual([]);
  });
});
