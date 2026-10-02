// Inline widgets — browser-side rules (widgetSandbox.ts) and the vendored sandbox proxy
// (deploy/widget-sandbox/). The proxy copy is held to the PINNED upstream by its own
// version hash: upstream's sandbox URL carries `v = sha256(JSON.stringify([headers,
// html]))`, and the value recorded in PROVENANCE is the one a live 2026.9.6 gateway
// returned from `canvas.document.view` (bridge/test/fixtures/widgets/).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_GUARD_HTML,
  HARDENED_MEDIA_SRC,
  PAGE_FRAME_POLICY_MARKER,
  PROXY_FRAME_SANDBOX,
  SERVED_PROXY_HEADERS,
  PromptPortGate,
  SIMPLE_FRAME_SANDBOX,
  SIMPLE_MODE_CSP,
  WIDGET_THEME_TOKENS,
  WidgetDocumentRefused,
  WidgetPromptController,
  WidgetPromptLimiter,
  admitWidgetPrompt,
  buildWidgetThemeMessage,
  clampReportedHeight,
  hardenWidgetCsp,
  installPageFramePolicy,
  pageFramePolicy,
  isFromWidgetFrame,
  isProxyReady,
  prepareSimpleModeDocument,
  proxyFrameUrl,
  resolveLeadingDoctypeEnd,
  resolveWidgetPromptText,
  resolveWidgetSandboxOrigin,
  widgetPromptSendArgs,
  type ParsedDocumentLike,
} from "./widgetSandbox";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const html = read("deploy/widget-sandbox/index.html");
const headers = JSON.parse(read("deploy/widget-sandbox/headers.json")) as Record<string, string>;
const provenance = JSON.parse(read("deploy/widget-sandbox/PROVENANCE.json")) as {
  version: string;
  sandboxPath: string;
  files: Record<string, string>;
};
const capture = JSON.parse(read("bridge/test/fixtures/widgets/canvas-view-2026.9.6.json")) as {
  ok: { payload: { sandboxUrl: string; html: string } };
};

describe("the vendored sandbox proxy is the pinned upstream one", () => {
  it("html + headers hash to upstream's own version of the proxy", () => {
    const version = createHash("sha256").update(JSON.stringify([headers, html])).digest("hex");
    expect(version).toBe(provenance.version);
  });

  it("that version is the one a live 2026.9.6 gateway announced in canvas.document.view", () => {
    const v = new URL(capture.ok.payload.sandboxUrl, "http://x").searchParams.get("v");
    expect(v).toBe(provenance.version);
    expect(capture.ok.payload.sandboxUrl).toBe(provenance.sandboxPath);
  });

  it("the file hash is recorded", () => {
    expect(createHash("sha256").update(html).digest("hex")).toBe(provenance.files["index.html"]);
  });

  it("both Caddy configurations send upstream's headers EXCEPT media-src, hardened — and nothing but the proxy", () => {
    const snippet = read("deploy/widget-sandbox/Caddyfile");
    const image = read("docker/Caddyfile");
    const block = (s: string) => s.slice(s.indexOf(":8081 {"));
    expect(block(image)).toBe(block(snippet));
    // The ONE difference from the vendored headers, stated directive by directive.
    const directives = (csp: string) => csp.split(";").map((d) => d.trim()).filter(Boolean);
    const upstream = directives(headers["Content-Security-Policy"]!);
    const served = directives(SERVED_PROXY_HEADERS["Content-Security-Policy"]!);
    expect(upstream).toContain("media-src 'self' data: https: blob:");
    expect(served).toEqual(
      upstream.map((d) => (d.startsWith("media-src") ? "media-src 'self' data: blob:" : d)),
    );
    expect({ ...SERVED_PROXY_HEADERS, "Content-Security-Policy": "" }).toEqual({
      ...headers,
      "Content-Security-Policy": "",
    });
    for (const [name, value] of Object.entries(SERVED_PROXY_HEADERS)) {
      expect(block(snippet)).toContain(`${name} "${value}"`);
    }
    expect(block(snippet)).not.toContain("https: blob:");
    expect(block(snippet)).toContain('respond "Not Found" 404');
  });
});

/** Every `Content-Security-Policy` a composed srcdoc carries (its `<meta>` tags). */
function metaPolicies(doc: string): string[] {
  return [...doc.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/gi)].map((m) =>
    m[1]!.replaceAll("&quot;", '"'),
  );
}
/** Does ONE policy let media load from `source`? (`media-src`, else `default-src`.) */
function policyAllowsMedia(policy: string, source: string): boolean {
  const directives = policy.split(";").map((d) => d.trim().split(/\s+/));
  const pick = directives.find((d) => d[0] === "media-src") ?? directives.find((d) => d[0] === "default-src");
  if (!pick) return true;
  const sources = pick.slice(1);
  return sources.includes(source) || sources.includes(new URL(source).protocol);
}

describe("HTTPS media is blocked in BOTH modes (no exfiltration through a media URL)", () => {
  const EXFIL = "https://attacker.example/?d=secret";

  it("the dedicated proxy's served policy refuses https media", () => {
    expect(policyAllowsMedia(SERVED_PROXY_HEADERS["Content-Security-Policy"]!, EXFIL)).toBe(false);
    expect(policyAllowsMedia(SERVED_PROXY_HEADERS["Content-Security-Policy"]!, "blob:x")).toBe(true);
  });

  it("the simple-mode srcdoc refuses it even when the widget's OWN meta allows it (strictest policy wins)", () => {
    // Upstream's wrapper (src/canvas/wrap.ts) puts its own meta in the document,
    // allowing https media.
    const doc =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src data: https: blob:"></head><body></body></html>';
    const none: ParsedDocumentLike = { querySelector: () => null, querySelectorAll: () => [] };
    const out = prepareSimpleModeDocument(doc, () => none);
    const policies = metaPolicies(out);
    expect(policies.length).toBe(2);
    // Atrium's policy comes first, before anything of the document's.
    expect(policies[0]).toBe(SIMPLE_MODE_CSP);
    expect(out.indexOf(SIMPLE_MODE_CSP.replaceAll('"', "&quot;"))).toBeLessThan(out.indexOf("media-src data: https:"));
    // Every policy is enforced: media loads only if ALL allow it.
    expect(policies.every((p) => policyAllowsMedia(p, EXFIL))).toBe(false);
    expect(policyAllowsMedia(SIMPLE_MODE_CSP, EXFIL)).toBe(false);
  });

  it("hardenWidgetCsp replaces media-src, or adds it, and touches nothing else", () => {
    expect(hardenWidgetCsp("default-src 'none'; media-src https: data:; connect-src 'none'")).toBe(
      `default-src 'none'; ${HARDENED_MEDIA_SRC}; connect-src 'none'`,
    );
    expect(hardenWidgetCsp("default-src 'none'")).toBe(`default-src 'none'; ${HARDENED_MEDIA_SRC}`);
    expect(HARDENED_MEDIA_SRC).not.toContain("https");
  });
});

describe("the isolation modes", () => {
  it("the simple frame NEVER gets allow-same-origin", () => {
    expect(SIMPLE_FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts", "allow-forms"]);
    expect(SIMPLE_FRAME_SANDBOX).not.toContain("allow-same-origin");
    // The proxy frame does — and is only used with a validated FOREIGN origin (below).
    expect(PROXY_FRAME_SANDBOX).toContain("allow-same-origin");
  });

  it("a dedicated origin must be a distinct, well-formed origin, else the simple frame", () => {
    const app = "https://atrium.example.com";
    expect(resolveWidgetSandboxOrigin(undefined, app)).toEqual({ mode: "simple", reason: "unset" });
    expect(resolveWidgetSandboxOrigin("https://widgets.example.com", app)).toEqual({
      mode: "dedicated",
      origin: "https://widgets.example.com",
    });
    expect(resolveWidgetSandboxOrigin("https://widgets.example.com/", app)).toMatchObject({ mode: "dedicated" });
    // Atrium's own origin: allow-same-origin would hand the widget the page.
    expect(resolveWidgetSandboxOrigin("https://atrium.example.com", app)).toEqual({
      mode: "simple",
      reason: "same-origin",
    });
    expect(resolveWidgetSandboxOrigin("https://ATRIUM.example.com:443/", app)).toMatchObject({ reason: "same-origin" });
    // The Convex HTTP origin the page talks to is refused too.
    expect(
      resolveWidgetSandboxOrigin("https://api.example.com", app, ["https://api.example.com"]),
    ).toMatchObject({ reason: "same-origin" });
    for (const bad of ["widgets.example.com", "https://w.example.com/proxy", "https://u:p@w.example.com", "javascript:alert(1)", "https://w.example.com/?x=1"]) {
      expect(resolveWidgetSandboxOrigin(bad, app)).toMatchObject({ mode: "simple", reason: "invalid" });
    }
    expect(resolveWidgetSandboxOrigin("http://widgets.example.com", app)).toEqual({ mode: "simple", reason: "insecure" });
    expect(resolveWidgetSandboxOrigin("http://127.0.0.1:18181", "http://localhost:5174")).toMatchObject({ mode: "dedicated" });
  });

  it("a message counts only from THE frame's window with THE mode's origin", () => {
    const frame = {};
    expect(isFromWidgetFrame({ source: frame, origin: "null" }, frame, "null")).toBe(true);
    expect(isFromWidgetFrame({ source: {}, origin: "null" }, frame, "null")).toBe(false);
    expect(isFromWidgetFrame({ source: frame, origin: "https://atrium.example.com" }, frame, "null")).toBe(false);
    expect(isFromWidgetFrame({ source: frame, origin: "https://w.example.com" }, frame, "https://w.example.com")).toBe(true);
    expect(isFromWidgetFrame({ source: null, origin: "null" }, null, "null")).toBe(false);
  });

  it("the proxy's readiness counts only for this frame's URL", () => {
    const url = proxyFrameUrl("https://w.example.com");
    expect(url).toBe("https://w.example.com/");
    expect(isProxyReady({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: url } }, url)).toBe(true);
    expect(isProxyReady({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: "https://w.example.com/x" } }, url)).toBe(false);
  });
});

describe("the simple-mode document (the proxy's transform, carried in-page)", () => {
  const noFrames: ParsedDocumentLike = { querySelector: () => null, querySelectorAll: () => [] };

  it("inserts the proxy's policy and descendant guard right after the doctype", () => {
    const doc = capture.ok.payload.html;
    const out = prepareSimpleModeDocument(doc, () => noFrames);
    const at = resolveLeadingDoctypeEnd(doc);
    expect(at).toBe("<!doctype html>".length);
    expect(out.slice(0, at)).toBe(doc.slice(0, at));
    expect(out.slice(at)).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; /);
    expect(out).toContain(DOCUMENT_GUARD_HTML);
    expect(out.endsWith(doc.slice(at))).toBe(true);
  });

  it("the guard is the vendored proxy's, and the policy is its header minus frame-ancestors", () => {
    expect(DOCUMENT_GUARD_HTML).toMatch(/^<script>\(\(\)=>\{/);
    expect(DOCUMENT_GUARD_HTML).toContain("RTCPeerConnection");
    expect(SIMPLE_MODE_CSP).toContain("connect-src 'none'");
    expect(SIMPLE_MODE_CSP).not.toContain("frame-ancestors");
    expect(SERVED_PROXY_HEADERS["Content-Security-Policy"]!.startsWith(SIMPLE_MODE_CSP)).toBe(true);
  });

  it("refuses a document that embeds a browsing context (also inside a template)", () => {
    const withFrame: ParsedDocumentLike = { querySelector: (s) => (s.includes("iframe") ? {} : null), querySelectorAll: () => [] };
    expect(() => prepareSimpleModeDocument("<iframe>", () => withFrame)).toThrow(WidgetDocumentRefused);
    const inTemplate: ParsedDocumentLike = {
      querySelector: () => null,
      querySelectorAll: () => [{ content: withFrame }],
    };
    expect(() => prepareSimpleModeDocument("<template><iframe></template>", () => inTemplate)).toThrow(WidgetDocumentRefused);
  });

  it("resolveLeadingDoctypeEnd is the proxy's own function", () => {
    const src = /const resolveLeadingDoctypeEnd = (\(html\) => \{[\s\S]*?\n\s*\});/.exec(html)?.[1];
    expect(src).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const upstream = new Function(`return ${src}`)() as (h: string) => number;
    for (const sample of [
      "<!doctype html><p>x",
      "﻿  <!-- c --> <!DOCTYPE html SYSTEM 'a>b'>x",
      "<p>no doctype",
      "<!-- unterminated",
      "<!doctype html",
      "",
    ]) {
      expect(resolveLeadingDoctypeEnd(sample)).toBe(upstream(sample));
    }
  });
});

describe("size and theme", () => {
  it("clamps a reported height to 48–8000", () => {
    expect(clampReportedHeight(10)).toBe(48);
    expect(clampReportedHeight(123.9)).toBe(123);
    expect(clampReportedHeight(1e9)).toBe(8000);
    expect(clampReportedHeight(0)).toBeNull();
    expect(clampReportedHeight("300")).toBeNull();
    expect(clampReportedHeight(Number.NaN)).toBeNull();
  });

  it("maps Atrium's variables onto exactly the upstream token allowlist, per mode", () => {
    expect(WIDGET_THEME_TOKENS).toHaveLength(23);
    const vars: Record<string, string> = { "--background": "oklch(1 0 0)", "--destructive": "red", "--primary": "blue" };
    const light = buildWidgetThemeMessage((v) => vars[v] ?? "", "light");
    expect(light.type).toBe("openclaw:widget-theme");
    expect(Object.keys(light.tokens).every((k) => (WIDGET_THEME_TOKENS as readonly string[]).includes(k))).toBe(true);
    expect(light.tokens.surface).toBe("oklch(1 0 0)");
    expect(light.tokens.danger).toBe("red");
    expect(light.tokens.ok).toBe("#15803d");
    // An unset variable is OMITTED — the widget falls back to its baked palette.
    expect(light.tokens.card).toBeUndefined();
    expect(buildWidgetThemeMessage((v) => vars[v] ?? "", "dark").tokens.ok).toBe("#22c55e");
    expect(buildWidgetThemeMessage(() => "x".repeat(300), "dark").tokens.surface).toBeUndefined();
  });
});

describe("prompts from a widget", () => {
  const live = { connected: true, visible: true, focused: true };

  it("text: trimmed, 1–4000 characters, never a host command", () => {
    expect(resolveWidgetPromptText("  hello  ")).toBe("hello");
    expect(resolveWidgetPromptText("   ")).toBeNull();
    expect(resolveWidgetPromptText("x".repeat(4001))).toBeNull();
    expect(resolveWidgetPromptText("x".repeat(4000))).toHaveLength(4000);
    expect(resolveWidgetPromptText("/reset")).toBeNull();
    expect(resolveWidgetPromptText(" !exec rm")).toBeNull();
    expect(resolveWidgetPromptText(42)).toBeNull();
  });

  it("the frame must be connected, visible AND focused", () => {
    const lim = new WidgetPromptLimiter();
    expect(admitWidgetPrompt("hi", { ...live, focused: false }, "k", 0, lim)).toEqual({ ok: false, reason: "not-interactable" });
    expect(admitWidgetPrompt("hi", { ...live, visible: false }, "k", 0, lim)).toEqual({ ok: false, reason: "not-interactable" });
    expect(admitWidgetPrompt("hi", { ...live, connected: false }, "k", 0, lim)).toEqual({ ok: false, reason: "not-interactable" });
    expect(admitWidgetPrompt("hi", live, "k", 0, lim)).toEqual({ ok: true, text: "hi" });
  });

  it("10 per 60 s per key", () => {
    const lim = new WidgetPromptLimiter();
    for (let i = 0; i < 10; i++) expect(admitWidgetPrompt("hi", live, "k", 1000 + i, lim).ok).toBe(true);
    expect(admitWidgetPrompt("hi", live, "k", 2000, lim)).toEqual({ ok: false, reason: "rate" });
    expect(admitWidgetPrompt("hi", live, "other", 2000, lim).ok).toBe(true);
    expect(admitWidgetPrompt("hi", live, "k", 1000 + 60_001, lim).ok).toBe(true);
  });

  it("only the FIRST prompt port of a document is adopted, and only once the frame loaded", () => {
    const port = () => {
      const p = { closed: false, close() { this.closed = true; } };
      return p as unknown as MessagePort & { closed: boolean };
    };
    const gate = new PromptPortGate();
    const first = port();
    expect(gate.offer(first)).toBeNull(); // before load: buffered
    const second = port();
    expect(gate.offer(second)).toBeNull();
    expect((second as unknown as { closed: boolean }).closed).toBe(true); // a later offer is closed
    expect(gate.load()).toBe(first); // adopted at load
    const late = port();
    expect(gate.offer(late)).toBeNull();
    expect((late as unknown as { closed: boolean }).closed).toBe(true);
    const g2 = new PromptPortGate();
    g2.load();
    const p = port();
    expect(g2.offer(p)).toBe(p); // after load: adopted at once
  });
});

describe("what happens to an admitted prompt", () => {
  const make = (confirm: { value: boolean }, sendOk = true) => {
    const sent: string[] = [];
    const pendingSeen: Array<string | null> = [];
    let failed = 0;
    const c = new WidgetPromptController({
      mustConfirm: () => confirm.value,
      send: async (t) => {
        sent.push(t);
        return sendOk;
      },
      onPending: (t) => pendingSeen.push(t),
      onFailed: () => failed++,
    });
    return { c, sent, pendingSeen, failed: () => failed };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("no confirmation by default: sent at once", async () => {
    const x = make({ value: false });
    expect(x.c.offer("hi")).toBe("sent");
    await flush();
    expect(x.sent).toEqual(["hi"]);
  });

  it("the setting is read LIVE: turned on after the widget loaded, it applies to the next prompt", async () => {
    const setting = { value: false };
    const x = make(setting);
    x.c.offer("one");
    setting.value = true;
    expect(x.c.offer("two")).toBe("pending");
    await flush();
    expect(x.sent).toEqual(["one"]);
    x.c.confirm();
    await flush();
    expect(x.sent).toEqual(["one", "two"]);
  });

  it("while one prompt awaits confirmation, another cannot replace it", async () => {
    const x = make({ value: true });
    expect(x.c.offer("benign")).toBe("pending");
    expect(x.c.offer("swapped")).toBe("ignored");
    expect(x.c.pending).toBe("benign");
    x.c.confirm();
    await flush();
    expect(x.sent).toEqual(["benign"]);
  });

  it("cancel sends nothing; a failed send is reported", async () => {
    const x = make({ value: true });
    x.c.offer("no");
    x.c.cancel();
    await flush();
    expect(x.sent).toEqual([]);
    expect(x.pendingSeen).toEqual(["no", null]);
    const y = make({ value: false }, false);
    y.c.offer("x");
    await flush();
    expect(y.failed()).toBe(1);
  });
});

describe("a widget's message is its own send, never the composer's", () => {
  it("text, idempotency key and the producing agent — no quotes, no mentions", () => {
    const args = widgetPromptSendArgs("c1", "Tell @bob the total", { instanceName: "alpha", agentId: "alice" }, "k1");
    expect(args).toEqual({
      chatId: "c1",
      text: "Tell @bob the total",
      clientMessageId: "k1",
      routedAgent: { instanceName: "alpha", agentId: "alice" },
    });
    expect(widgetPromptSendArgs("c1", "x", null, "k2")).toEqual({ chatId: "c1", text: "x", clientMessageId: "k2" });
  });

  it("the widget card never reaches the composer's send path (staged quotes, mention parsing)", () => {
    const src = readFileSync(resolve(__dirname, "WidgetPart.tsx"), "utf8");
    for (const composerPath of ["useThreadRuntime", "QueueSendContext", "takePendingQuotes", "takeMentionsForSend", ".append("]) {
      expect(src, composerPath).not.toContain(composerPath);
    }
    expect(src).toContain("api.send.sendMessage");
    // …and nothing is fetched until THIS message's widget state is known AND on.
    expect(src).toContain("if (!effective || !token || !chatId || !messageId || !viewId) return;");
    expect(src).toContain("const effective = config?.effective === true;");
    expect(src).toContain("api.widgets.widgetConfigForMessage");
    expect(src).not.toContain("api.widgets.widgetConfigForChat");
    // The token is read at fetch time: a refresh never refetches a shown widget.
    expect(src).toContain("const token = tokenRef.current;");
    expect(src).toContain("}, [effective, hasToken, chatId, messageId, viewId, attempt]);");
    expect(src).toContain("widgetPromptSendArgs(");
  });
});

describe("the page's frame-src: a widget cannot navigate itself to a server", () => {
  it("simple mode: no frame may navigate anywhere (srcdoc widgets are not fetched, so they still render)", () => {
    expect(pageFramePolicy({ mode: "simple", reason: "unset" })).toBe("frame-src 'none'");
    expect(pageFramePolicy({ mode: "simple", reason: "same-origin" })).toBe("frame-src 'none'");
  });

  it("dedicated mode: the sandbox origin, and nothing else", () => {
    expect(pageFramePolicy({ mode: "dedicated", origin: "https://widgets.example.com" })).toBe(
      "frame-src https://widgets.example.com",
    );
  });

  it("only frame-src is set — the policy must not restrict anything else the app loads", () => {
    for (const policy of [
      pageFramePolicy({ mode: "simple", reason: "unset" }),
      pageFramePolicy({ mode: "dedicated", origin: "https://w.example.com" }),
    ]) {
      expect(policy.split(";").map((d) => d.trim().split(/\s+/)[0])).toEqual(["frame-src"]);
    }
  });

  /** The few DOM members the installer touches. */
  function fakeDocument() {
    const head: { children: Array<Record<string, unknown>> } & Record<string, unknown> = { children: [] };
    head.querySelector = (sel: string) =>
      head.children.find((c) => sel.includes(PAGE_FRAME_POLICY_MARKER) && (c.attrs as Record<string, string>)[PAGE_FRAME_POLICY_MARKER] !== undefined) ?? null;
    head.prepend = (el: Record<string, unknown>) => head.children.unshift(el);
    const doc = {
      head,
      createElement: () => {
        const attrs: Record<string, string> = {};
        return { attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) } as Record<string, unknown>;
      },
    };
    return doc as unknown as Document & { head: typeof head };
  }

  it("installed as a CSP meta, FIRST in <head>, exactly once", () => {
    const doc = fakeDocument();
    installPageFramePolicy(doc, "frame-src 'none'");
    installPageFramePolicy(doc, "frame-src https://other.example.com");
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]).toMatchObject({ httpEquiv: "Content-Security-Policy", content: "frame-src 'none'" });
  });

  it("the app installs it at boot, BEFORE the app (and so any widget) can render", () => {
    const main = read("src/main.tsx");
    const install = main.indexOf("installPageFramePolicy(");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(main.indexOf("<RouterProvider"));
    expect(install).toBeLessThan(main.indexOf("new ConvexReactClient"));
  });
});
