/// <reference types="vite/client" />
//
// The gateway's status notices RENDER as a labelled note under the reply: one line per
// notice, as text. SSR render, no jsdom.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { m } from "@/paraglide/messages.js";

let custom: Record<string, unknown> | undefined;
vi.mock("@assistant-ui/react", () => ({
  useMessage: (select: (msg: { metadata?: { custom?: Record<string, unknown> } }) => unknown) =>
    select({ metadata: { custom } }),
}));

import { GatewayNotices } from "./GatewayNotices";

const render = () => renderToStaticMarkup(createElement(GatewayNotices));

describe("GatewayNotices", () => {
  beforeEach(() => {
    custom = undefined;
  });

  test("a bubble without a notice renders nothing", () => {
    expect(render()).toBe("");
    custom = { gatewayNotices: [] };
    expect(render()).toBe("");
  });

  test("each notice is a line of a note labelled as the gateway's", () => {
    custom = { gatewayNotices: ["Usage: 1230 in / 10 out", "Diagnostics: ok"] };
    const html = render();
    expect(html).toContain('role="note"');
    expect(html).toContain(`aria-label="${m.gateway_notice_label()}"`);
    expect(html.match(/oc-gateway-notices__line/g)).toHaveLength(2);
    expect(html).toContain("Usage: 1230 in / 10 out");
    expect(html).toContain("Diagnostics: ok");
  });

  test("a notice is text, never markup", () => {
    custom = { gatewayNotices: ["<img src=x onerror=1> **bold**"] };
    const html = render();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("**bold**");
  });
});
