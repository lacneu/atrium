/// <reference types="vite/client" />
//
// The model-fallback notice says what the gateway's own Control UI says: the ACTIVE model
// while a fallback holds ("Fallback active: {model}", with the selected one as detail),
// the SELECTED model once it is cleared ("Fallback cleared: {model}").

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { modelFallbackView } from "./modelFallbackView";

describe("modelFallbackView", () => {
  test("an active fallback names the model that answered, and the one that was asked for", () => {
    expect(
      modelFallbackView({ state: "active", model: "openai/gpt-6.1-sol", selected: "openai/gpt-5.5" }),
    ).toStrictEqual({
      cleared: false,
      label: m.model_fallback_active({ model: "openai/gpt-6.1-sol" }),
      detail: m.model_fallback_selected({ model: "openai/gpt-5.5" }),
    });
  });

  test("the label carries the model's name", () => {
    expect(modelFallbackView({ state: "active", model: "openai/gpt-6.1-sol" })?.label).toContain(
      "openai/gpt-6.1-sol",
    );
    expect(modelFallbackView({ state: "active", model: "openai/gpt-6.1-sol" })?.detail).toBeNull();
  });

  test("a cleared fallback names the selected model, with nothing more to say", () => {
    expect(modelFallbackView({ state: "cleared", model: "openai/gpt-5.5", selected: "ignored" })).toStrictEqual({
      cleared: true,
      label: m.model_fallback_cleared({ model: "openai/gpt-5.5" }),
      detail: null,
    });
    expect(m.model_fallback_cleared({ model: "x" })).not.toBe(m.model_fallback_active({ model: "x" }));
  });

  test("no marker, an unknown state or an empty name shows nothing", () => {
    expect(modelFallbackView(null)).toBeNull();
    expect(modelFallbackView(undefined)).toBeNull();
    expect(modelFallbackView({ state: "active", model: "  " })).toBeNull();
    expect(modelFallbackView({ state: "weird" as never, model: "m" })).toBeNull();
  });
});
