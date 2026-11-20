/// <reference types="vite/client" />
//
// The notice RENDERS what the bubble's metadata says, and nothing when it says nothing:
// a line with the Control UI's sentence, as a note, with the selected model as its detail.
// SSR render, no jsdom.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { m } from "@/paraglide/messages.js";

let custom: Record<string, unknown> | undefined;
vi.mock("@assistant-ui/react", () => ({
  useMessage: (select: (msg: { metadata?: { custom?: Record<string, unknown> } }) => unknown) =>
    select({ metadata: { custom } }),
}));

import { ModelFallbackNotice } from "./ModelFallbackNotice";

describe("ModelFallbackNotice", () => {
  beforeEach(() => {
    custom = undefined;
  });

  test("a bubble without the marker renders nothing", () => {
    expect(renderToStaticMarkup(createElement(ModelFallbackNotice))).toBe("");
    custom = { compaction: null };
    expect(renderToStaticMarkup(createElement(ModelFallbackNotice))).toBe("");
  });

  test("an active fallback renders its sentence as a note, with the selected model as its detail", () => {
    custom = { modelFallback: { state: "active", model: "openai/gpt-6.1-sol", selected: "openai/gpt-5.5" } };
    const html = renderToStaticMarkup(createElement(ModelFallbackNotice));
    expect(html).toContain('role="note"');
    expect(html).toContain(m.model_fallback_active({ model: "openai/gpt-6.1-sol" }));
    // The detail is what a screen reader announces with the label.
    expect(html).toContain(m.model_fallback_selected({ model: "openai/gpt-5.5" }));
  });

  test("a cleared fallback renders the other sentence, and no detail", () => {
    custom = { modelFallback: { state: "cleared", model: "openai/gpt-5.5" } };
    const html = renderToStaticMarkup(createElement(ModelFallbackNotice));
    expect(html).toContain(m.model_fallback_cleared({ model: "openai/gpt-5.5" }));
    expect(html).not.toContain(m.model_fallback_active({ model: "openai/gpt-5.5" }));
  });

  test("a model name is text, never markup", () => {
    custom = { modelFallback: { state: "active", model: "<img src=x onerror=1>" } };
    const html = renderToStaticMarkup(createElement(ModelFallbackNotice));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
