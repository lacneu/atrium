import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentAnchor } from "./MarkdownText";

// AgentAnchor is the `a` renderer Streamdown uses for AGENT-AUTHORED markdown links.
// `isNavigableHref` (the pure decision) is covered in markdownLinks.test.ts; this pins
// the RENDER-level behavior of the component itself: navigable links open safely in a
// new tab, non-navigable hrefs (file paths / bare names the agent mentions) render as
// plain text instead of a broken same-origin <a>, and the streamdown `node` prop never
// leaks onto the DOM. SSR render, no jsdom.
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(AgentAnchor, props));

describe("AgentAnchor — untrusted agent links", () => {
  it("opens a navigable http(s) link in a NEW tab with noopener noreferrer", () => {
    const html = render({ href: "https://example.com/x", children: "site" });
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("treats mailto: as navigable (new tab)", () => {
    const html = render({ href: "mailto:a@b.com", children: "mail" });
    expect(html).toMatch(/^<a /);
    expect(html).toContain('target="_blank"');
  });

  it("renders a non-navigable FILE PATH as plain text (span), not a broken <a>", () => {
    const html = render({ href: "/srv/media/out.pdf", children: "out.pdf" });
    expect(html).not.toContain("<a ");
    expect(html).toContain("<span");
    expect(html).toContain("out.pdf");
  });

  it("renders a bare filename as plain text (span)", () => {
    const html = render({ href: "rapport.docx", children: "rapport.docx" });
    expect(html).not.toContain("<a ");
    expect(html).toContain("rapport.docx");
  });

  it("never emits a javascript: anchor (defense in depth → span)", () => {
    const html = render({ href: "javascript:alert(1)", children: "x" });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
  });

  it("strips the streamdown `node` prop (no invalid DOM attribute)", () => {
    const html = render({
      href: "https://x.com",
      children: "y",
      node: { type: "element", tagName: "a" },
    });
    expect(html).not.toMatch(/\snode=/);
  });
});
