import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Streamdown } from "streamdown";

// `Streamdown` is the renderer behind `StreamdownTextPrimitive` (see MarkdownText.tsx).
// Assistant markdown is UNTRUSTED (agent-authored), and MarkdownText passes NO `security`
// prop, so streamdown falls back to its DEFAULT rehype chain (rehype-raw + rehype-sanitize
// + harden). Unlike the previous @assistant-ui/react-markdown path, that chain PARSES raw
// HTML — so this test pins that the default chain neutralizes the script-injection vectors,
// so a future streamdown bump can't silently regress sanitization. SSR render (no jsdom).
function render(md: string): string {
  return renderToStaticMarkup(createElement(Streamdown, { children: md }));
}

describe("agent markdown sanitization (streamdown default chain)", () => {
  it("strips <script> tags and their payload", () => {
    const html = render("hello <script>alert('xss')</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert('xss')");
    expect(html).toContain("hello");
  });

  it("neutralizes javascript: links (markdown and raw HTML)", () => {
    expect(render("[click](javascript:alert(1))")).not.toContain("javascript:");
    expect(render('<a href="javascript:alert(1)">click</a>')).not.toContain(
      "javascript:",
    );
  });

  it("strips inline event handlers", () => {
    const html = render('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("drops <iframe> / <form> elements", () => {
    const html = render(
      '<iframe src="https://evil.example"></iframe><form action="/x"><input></form>',
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<form");
  });

  it("blocks data: image URIs", () => {
    const html = render(
      '![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    );
    expect(html).not.toContain("data:text/html");
  });

  it("still renders benign formatting (sanity: it is not stripping everything)", () => {
    const html = render("# Title\n\n**bold** and `code`");
    expect(html).toContain("bold");
    expect(html).toContain("code");
    expect(html).toMatch(/<h1/);
  });
});
