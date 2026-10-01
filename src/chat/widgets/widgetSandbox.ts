// Inline widgets — the browser-side rules, kept free of React so each one is unit-tested
// (widgetSandbox.test.ts). Ported from the pinned upstream Control UI (OpenClaw
// v2026.9.6): ui/src/pages/chat/components/widget-card.ts (direct frame),
// ui/src/components/canvas-widget-view.ts + ui/src/lib/widget-sandbox-host.ts (proxy
// frame), ui/src/components/mcp-app-security.ts (prompt admission) and
// ui/src/lib/widget-theme.ts (theme tokens).
//
// TWO ISOLATION MODES.
//  - Simple (default): the document goes into an iframe `sandbox="allow-scripts
//    allow-forms"` via `srcdoc`. The frame's origin is OPAQUE — it can reach nothing of
//    Atrium's (no storage, no cookies, no DOM, no Convex token). NEVER
//    `allow-same-origin`: with it, a srcdoc frame would share Atrium's origin.
//  - Dedicated: a deployment serves Atrium's pinned copy of upstream's sandbox proxy
//    (deploy/widget-sandbox/) on an origin of its own (WIDGET_SANDBOX_ORIGIN). Atrium
//    frames that proxy (it may keep its own origin: it is not Atrium's) and hands it the
//    document over postMessage; the proxy renders it in ITS inner opaque srcdoc frame,
//    under the proxy's HTTP CSP.
// In both, a message from the widget is trusted only when it comes from THE frame's
// window with THE expected origin (`"null"` for the opaque frame, the sandbox origin
// for the proxy).

import proxyHtml from "../../../deploy/widget-sandbox/index.html?raw";
import proxyHeaders from "../../../deploy/widget-sandbox/headers.json";

// --- protocol constants (upstream wrapper and host) ------------------------------------

export const WIDGET_SIZE = "openclaw:widget-size";
export const WIDGET_THEME = "openclaw:widget-theme";
export const WIDGET_CHAT_HOST = "openclaw:widget-chat-host";
export const WIDGET_BRIDGE_READY = "openclaw:widget-bridge-ready";
export const WIDGET_PROMPT_OFFER = "openclaw:widget-prompt-offer";
export const WIDGET_PROMPT = "openclaw:widget-prompt";
export const WIDGET_PROMPT_HOST_READY = "openclaw:widget-prompt-host-ready";
export const WIDGET_BRIDGE_PORT_OFFER = "openclaw:widget-bridge-port-offer";
export const WIDGET_RUNTIME_ERROR = "openclaw:widget-runtime-error";
export const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
export const SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
export const SANDBOX_RESOURCE_LOADED = "ui/notifications/sandbox-resource-loaded";

/** The frame attributes of the SIMPLE mode. One constant, asserted by a test: the
 *  opaque origin is the whole isolation, and `allow-same-origin` would undo it. */
export const SIMPLE_FRAME_SANDBOX = "allow-scripts allow-forms";
/** The frame attributes of the DEDICATED mode (the proxy on its own origin — upstream
 *  canvas-widget-view.ts). Only ever used with a validated foreign origin. */
export const PROXY_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

export const WIDGET_FRAME_MIN_HEIGHT = 48;
export const WIDGET_FRAME_MAX_HEIGHT = 8000;
export const WIDGET_DEFAULT_HEIGHT = 320;
export const WIDGET_LOAD_TIMEOUT_MS = 10_000;

/** upstream `openclaw:widget-size`: a reported height is clamped 48–8000 (an abuse
 *  bound, not a layout preference). Null when the message is not a usable size. */
export function clampReportedHeight(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(WIDGET_FRAME_MAX_HEIGHT, Math.max(WIDGET_FRAME_MIN_HEIGHT, Math.trunc(raw)));
}

// --- message trust ---------------------------------------------------------------------

/** Is `event` a message from THIS widget frame? The source window must be the frame's
 *  own, and the origin the one the mode implies: `"null"` (opaque srcdoc) in simple
 *  mode, the configured sandbox origin in dedicated mode. Anything else — another
 *  frame, the page itself, a look-alike origin — is ignored. */
export function isFromWidgetFrame(
  event: { source: unknown; origin: string },
  frameWindow: unknown,
  expectedOrigin: string,
): boolean {
  return frameWindow != null && event.source === frameWindow && event.origin === expectedOrigin;
}

// --- dedicated sandbox origin ----------------------------------------------------------

export type SandboxOriginVerdict =
  | { mode: "simple"; reason: "unset" | "invalid" | "same-origin" | "insecure" }
  | { mode: "dedicated"; origin: string };

/**
 * Decide the isolation mode from the deployment setting.
 *
 * The dedicated mode frames the proxy WITH `allow-same-origin` — safe only because the
 * proxy's origin is not Atrium's. So an origin equal to Atrium's own (or to the Convex
 * HTTP origin the page talks to), a malformed value, a URL carrying a path/query/
 * credentials, or plain http under an https page is REFUSED, and the widget falls back
 * to the simple opaque frame. Never the other way round.
 */
export function resolveWidgetSandboxOrigin(
  raw: string | null | undefined,
  appOrigin: string,
  otherOrigins: readonly (string | null | undefined)[] = [],
): SandboxOriginVerdict {
  if (!raw || !raw.trim()) return { mode: "simple", reason: "unset" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { mode: "simple", reason: "invalid" };
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return { mode: "simple", reason: "invalid" };
  }
  const origin = url.origin;
  const sameAs = (o: string | null | undefined) => {
    if (!o) return false;
    try {
      return new URL(o).origin === origin;
    } catch {
      return false;
    }
  };
  if (sameAs(appOrigin) || otherOrigins.some(sameAs)) return { mode: "simple", reason: "same-origin" };
  if (url.protocol === "http:" && appOrigin.startsWith("https:")) {
    return { mode: "simple", reason: "insecure" };
  }
  return { mode: "dedicated", origin };
}

/** The proxy document's URL on the sandbox origin (served at `/`, deploy/widget-sandbox). */
export function proxyFrameUrl(origin: string): string {
  return `${origin}/`;
}

/** upstream WidgetSandboxHost: the proxy's readiness names the URL it was loaded from,
 *  and only a readiness for THIS frame's URL counts. */
export function isProxyReady(data: unknown, frameUrl: string): boolean {
  const d = data as { method?: unknown; params?: { sandboxUrl?: unknown } } | null;
  return d?.method === SANDBOX_PROXY_READY && d.params?.sandboxUrl === frameUrl;
}

export function resourceReadyMessage(html: string, renderId: string) {
  return { jsonrpc: "2.0", method: SANDBOX_RESOURCE_READY, params: { html, renderId } };
}

// --- simple-mode document ---------------------------------------------------------------

/** The descendant-frame guard upstream's proxy injects into every widget document
 *  (`buildSandboxDocumentGuardHtml(true)`), read from the vendored proxy itself so the
 *  simple mode cannot drift from it. */
function readProxyGuard(): string {
  const match = /const documentGuard = ("(?:[^"\\]|\\.)*");/.exec(proxyHtml);
  if (!match) throw new Error("vendored widget sandbox proxy has no documentGuard");
  return JSON.parse(match[1]!) as string;
}
export const DOCUMENT_GUARD_HTML = readProxyGuard();

/** The proxy's HTTP policy (headers.json) — the one its inner srcdoc frame inherits.
 *  In simple mode the srcdoc frame would inherit ATRIUM's page policy instead, so the
 *  same policy is carried by a `<meta>` (minus `frame-ancestors`, which a meta cannot
 *  express and which only concerns the proxy itself). */
export const SIMPLE_MODE_CSP = (proxyHeaders as Record<string, string>)["Content-Security-Policy"]!
  .split(";")
  .map((d) => d.trim())
  .filter((d) => d !== "" && !d.startsWith("frame-ancestors"))
  .join("; ");

const BLOCKED_DESCENDANT_SELECTOR = "iframe,frame,object,embed,portal,fencedframe,webview,browser";

/** Port of the proxy's `resolveLeadingDoctypeEnd` (sandbox-host.ts
 *  RESOLVE_LEADING_DOCTYPE_END_SOURCE): where the guard may be inserted. */
export function resolveLeadingDoctypeEnd(html: string): number {
  let index = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const whitespace = new Set([9, 10, 12, 13, 32]);
  for (;;) {
    while (index < html.length && whitespace.has(html.charCodeAt(index))) index += 1;
    if (html.slice(index, index + 4) !== "<!--") break;
    const commentEnd = html.indexOf("-->", index + 4);
    if (commentEnd < 0) return 0;
    index = commentEnd + 3;
  }
  if (html.slice(index, index + 9).toLowerCase() !== "<!doctype") return 0;
  let quote = "";
  for (let cursor = index + 9; cursor < html.length; cursor += 1) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return cursor + 1;
  }
  return 0;
}

export class WidgetDocumentRefused extends Error {}

/** Minimal parsed-document surface the descendant check needs (DOMParser's). */
export interface ParsedDocumentLike {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): Iterable<{ content: ParsedDocumentLike }>;
}

function hasBlockedDescendant(root: ParsedDocumentLike): boolean {
  if (root.querySelector(BLOCKED_DESCENDANT_SELECTOR)) return true;
  for (const template of root.querySelectorAll("template")) {
    if (hasBlockedDescendant(template.content)) return true;
  }
  return false;
}

/**
 * The simple-mode srcdoc: the proxy's own transform (refuse a document that embeds a
 * browsing context; insert the descendant guard after the doctype), plus the proxy's
 * policy as a meta. Throws WidgetDocumentRefused on a refused document.
 */
export function prepareSimpleModeDocument(
  html: string,
  parse: (html: string) => ParsedDocumentLike,
): string {
  if (hasBlockedDescendant(parse(html))) {
    throw new WidgetDocumentRefused("widget documents may not embed frames");
  }
  const at = resolveLeadingDoctypeEnd(html);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SIMPLE_MODE_CSP.replaceAll('"', "&quot;")}">`;
  return html.slice(0, at) + meta + DOCUMENT_GUARD_HTML + html.slice(at);
}

// --- theme ------------------------------------------------------------------------------

/** upstream `WIDGET_THEME_TOKENS` (src/shared/widget-theme.ts) — the ONLY names that
 *  cross the frame boundary. */
export const WIDGET_THEME_TOKENS = [
  "surface",
  "card",
  "elevated",
  "text",
  "text-strong",
  "muted",
  "border",
  "border-strong",
  "accent",
  "accent-fill",
  "accent-fg",
  "ok",
  "warn",
  "danger",
  "info",
  "radius",
  "radius-full",
  "scrollbar-size",
  "scrollbar-thumb-inset",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "font-body",
  "font-mono",
] as const;
export type WidgetThemeToken = (typeof WIDGET_THEME_TOKENS)[number];

/** Where each token comes from in Atrium: a CSS variable of the page (read computed, so
 *  a brand chart's inline overrides are included), or a constant. Atrium has no
 *  ok/warn/info colors, so those keep the widget's own palette values (upstream
 *  src/canvas/wrap.ts WIDGET_BASE_STYLES) for the current mode. */
const TOKEN_SOURCES: Record<
  WidgetThemeToken,
  { cssVar: string } | { value: string } | { light: string; dark: string }
> = {
  surface: { cssVar: "--background" },
  card: { cssVar: "--card" },
  elevated: { cssVar: "--popover" },
  text: { cssVar: "--foreground" },
  "text-strong": { cssVar: "--foreground" },
  muted: { cssVar: "--muted-foreground" },
  border: { cssVar: "--border" },
  "border-strong": { cssVar: "--ring" },
  accent: { cssVar: "--primary" },
  "accent-fill": { cssVar: "--primary" },
  "accent-fg": { cssVar: "--primary-foreground" },
  ok: { light: "#15803d", dark: "#22c55e" },
  warn: { light: "#b45309", dark: "#f59e0b" },
  danger: { cssVar: "--destructive" },
  info: { light: "#2563eb", dark: "#3b82f6" },
  radius: { cssVar: "--radius" },
  "radius-full": { value: "9999px" },
  "scrollbar-size": { value: "12px" },
  "scrollbar-thumb-inset": { value: "3px" },
  "scrollbar-thumb": { value: "color-mix(in srgb,var(--muted) 32%,transparent)" },
  "scrollbar-thumb-hover": { value: "color-mix(in srgb,var(--muted) 64%,transparent)" },
  "font-body": { cssVar: "--ui-font-sans" },
  "font-mono": { cssVar: "--ui-font-mono" },
};

export interface WidgetThemeMessage {
  type: typeof WIDGET_THEME;
  mode: "light" | "dark";
  tokens: Record<string, string>;
}

/** The full theme snapshot (upstream: every message is a full snapshot; an omitted
 *  token falls back to the widget's baked palette). Values are bounded like the
 *  wrapper bounds them (256 characters). */
export function buildWidgetThemeMessage(
  read: (cssVar: string) => string,
  mode: "light" | "dark",
): WidgetThemeMessage {
  const tokens: Record<string, string> = {};
  for (const token of WIDGET_THEME_TOKENS) {
    const src = TOKEN_SOURCES[token];
    const value =
      "cssVar" in src ? read(src.cssVar).trim() : "value" in src ? src.value : src[mode];
    if (value && value.length <= 256) tokens[token] = value;
  }
  return { type: WIDGET_THEME, mode, tokens };
}

// --- prompts from a widget (upstream mcp-app-security.ts) --------------------------------

export const WIDGET_PROMPT_MAX_CHARS = 4_000;
export const WIDGET_PROMPT_RATE_WINDOW_MS = 60_000;
export const WIDGET_PROMPT_RATE_MAX = 10;
const WIDGET_PROMPT_RATE_KEYS_MAX = 100;

/** Trimmed, 1–4000 characters, never a host command (`/…` or `!…`). */
export function resolveWidgetPromptText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > WIDGET_PROMPT_MAX_CHARS) return null;
  if (text.startsWith("/") || text.startsWith("!")) return null;
  return text;
}

/** 10 prompts per 60 s per key, at most 100 keys remembered. */
export class WidgetPromptLimiter {
  private readonly byKey = new Map<string, number[]>();
  allow(key: string, nowMs: number): boolean {
    const cutoff = nowMs - WIDGET_PROMPT_RATE_WINDOW_MS;
    const stamps = (this.byKey.get(key) ?? []).filter((ts) => ts > cutoff);
    if (!this.byKey.has(key) && this.byKey.size >= WIDGET_PROMPT_RATE_KEYS_MAX) {
      const oldest = this.byKey.keys().next().value;
      if (oldest !== undefined) this.byKey.delete(oldest);
    }
    if (stamps.length >= WIDGET_PROMPT_RATE_MAX) {
      this.byKey.set(key, stamps);
      return false;
    }
    stamps.push(nowMs);
    this.byKey.set(key, stamps);
    return true;
  }
}

/** The page-wide limiter (upstream keeps one module-level map too). */
export const widgetPromptLimiter = new WidgetPromptLimiter();

export type PromptAdmission =
  | { ok: true; text: string }
  | { ok: false; reason: "text" | "not-interactable" | "rate" };

/**
 * May this widget prompt be sent? Upstream `dispatchWidgetPrompt`: the text rules, the
 * frame connected + visible + FOCUSED (the person is interacting with it), then the
 * rate limit. User activation itself is enforced inside the wrapper
 * (`navigator.userActivation.isActive`), which Atrium cannot see.
 */
export function admitWidgetPrompt(
  raw: unknown,
  frame: { connected: boolean; visible: boolean; focused: boolean },
  rateKey: string,
  nowMs: number,
  limiter: WidgetPromptLimiter = widgetPromptLimiter,
): PromptAdmission {
  const text = resolveWidgetPromptText(raw);
  if (text === null) return { ok: false, reason: "text" };
  if (!frame.connected || !frame.visible || !frame.focused) {
    return { ok: false, reason: "not-interactable" };
  }
  if (!limiter.allow(rateKey, nowMs)) return { ok: false, reason: "rate" };
  return { ok: true, text };
}

/** upstream prompt-port adoption: only the FIRST offer of a document, and only once the
 *  frame has loaded — a later offer (a replacement document) is closed. */
export class PromptPortGate {
  private offered = false;
  private loaded = false;
  private pending: MessagePort | null = null;
  adopted: MessagePort | null = null;

  /** An offer arrived. Returns the port to adopt NOW, or null (buffered or closed). */
  offer(port: MessagePort | undefined): MessagePort | null {
    if (!port) return null;
    if (this.offered) {
      port.close();
      return null;
    }
    this.offered = true;
    if (!this.loaded) {
      this.pending = port;
      return null;
    }
    this.adopted = port;
    return port;
  }

  /** The frame loaded. Returns a buffered offer to adopt now, if any. */
  load(): MessagePort | null {
    this.loaded = true;
    if (this.pending && !this.adopted) {
      this.adopted = this.pending;
      this.pending = null;
      return this.adopted;
    }
    return null;
  }

  dispose(): void {
    this.pending?.close();
    this.adopted?.close();
    this.pending = null;
    this.adopted = null;
  }
}

/**
 * What happens to an ADMITTED widget prompt. The instance's confirmation setting and the
 * send function are read at the moment of each prompt (never captured when the widget
 * loaded — an administrator turning confirmation on applies to widgets already on
 * screen), and while one prompt awaits confirmation any other is ignored: a widget
 * cannot swap the text under the person's click.
 */
export class WidgetPromptController {
  private pendingText: string | null = null;

  constructor(
    private readonly deps: {
      /** The instance setting, read live. */
      mustConfirm: () => boolean;
      /** The conversation's send path for this widget, read live. */
      send: (text: string) => Promise<boolean>;
      /** The text now awaiting confirmation (null: none). */
      onPending: (text: string | null) => void;
      onFailed: () => void;
    },
  ) {}

  get pending(): string | null {
    return this.pendingText;
  }

  /** An admitted prompt arrived. */
  offer(text: string): "sent" | "pending" | "ignored" {
    if (this.pendingText !== null) return "ignored";
    if (this.deps.mustConfirm()) {
      this.pendingText = text;
      this.deps.onPending(text);
      return "pending";
    }
    this.dispatch(text);
    return "sent";
  }

  /** The person confirmed the pending prompt. */
  confirm(): void {
    const text = this.pendingText;
    if (text === null) return;
    this.pendingText = null;
    this.deps.onPending(null);
    this.dispatch(text);
  }

  cancel(): void {
    if (this.pendingText === null) return;
    this.pendingText = null;
    this.deps.onPending(null);
  }

  private dispatch(text: string): void {
    void this.deps.send(text).then(
      (sent) => {
        if (!sent) this.deps.onFailed();
      },
      () => this.deps.onFailed(),
    );
  }
}

/**
 * The `send.sendMessage` arguments of a widget's message: its text, a fresh idempotency
 * key, and the agent that produced the widget when it is known — and NOTHING else. The
 * composer's own path would add the person's staged quotes and resolve `@mentions` in
 * the text (a widget writing "@another-agent" would re-route the turn); this one never
 * does.
 */
export function widgetPromptSendArgs(
  chatId: string,
  text: string,
  routedAgent: { instanceName: string; agentId: string } | null,
  clientMessageId: string,
): {
  chatId: string;
  text: string;
  clientMessageId: string;
  routedAgent?: { instanceName: string; agentId: string };
} {
  return {
    chatId,
    text,
    clientMessageId,
    ...(routedAgent ? { routedAgent } : {}),
  };
}
