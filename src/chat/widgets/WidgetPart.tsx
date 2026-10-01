// An inline widget in the assistant message body (OpenClaw `show_widget`).
//
// The message carries a descriptor (convex/widgets.ts). This component fetches the
// document for ONE view through `GET /api/v1/widget-view` (Convex authorizes it: the
// reader may read the chat AND the view is one of this message's widget parts), then
// renders it isolated — in an opaque srcdoc frame (simple mode), or through Atrium's
// pinned copy of upstream's sandbox proxy on a dedicated origin (WIDGET_SANDBOX_ORIGIN).
// Every rule it applies is in widgetSandbox.ts, unit-tested there.
//
// Host protocol (upstream Control UI, v2026.9.6): size (`openclaw:widget-size`, 48–8000),
// theme (`openclaw:widget-theme`, the 23-token allowlist, re-posted on every theme
// change), `openclaw:widget-chat-host`, the FIRST prompt port only (closing any
// bridge-port offer — the dashboard's, not ours), and a runtime-error notice.

import { useAuthToken } from "@convex-dev/auth/react";
import { useMessage } from "@assistant-ui/react";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, LayoutTemplate, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { convexCloudUrl, convexSiteUrl, widgetSandboxOriginSetting } from "@/lib/runtimeConfig";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import {
  PROXY_FRAME_SANDBOX,
  PromptPortGate,
  SIMPLE_FRAME_SANDBOX,
  WIDGET_BRIDGE_PORT_OFFER,
  WIDGET_BRIDGE_READY,
  WIDGET_CHAT_HOST,
  WIDGET_DEFAULT_HEIGHT,
  WIDGET_LOAD_TIMEOUT_MS,
  WIDGET_PROMPT,
  WIDGET_PROMPT_HOST_READY,
  WIDGET_PROMPT_OFFER,
  WIDGET_RUNTIME_ERROR,
  WIDGET_SIZE,
  SANDBOX_RESOURCE_LOADED,
  WidgetDocumentRefused,
  WidgetPromptController,
  admitWidgetPrompt,
  widgetPromptSendArgs,
  buildWidgetThemeMessage,
  clampReportedHeight,
  isFromWidgetFrame,
  isProxyReady,
  prepareSimpleModeDocument,
  proxyFrameUrl,
  resolveWidgetSandboxOrigin,
  resourceReadyMessage,
  type ParsedDocumentLike,
} from "./widgetSandbox";

interface WidgetPartProps {
  data?: { viewId?: string; title?: string; preferredHeight?: number };
}

type Load =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "error"; unavailable: boolean };

function currentThemeMessage() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return buildWidgetThemeMessage(
    (v) => styles.getPropertyValue(v),
    root.classList.contains("dark") ? "dark" : "light",
  );
}

function parseHtml(html: string): ParsedDocumentLike {
  return new DOMParser().parseFromString(html, "text/html") as unknown as ParsedDocumentLike;
}

/** Fetch one widget document for the signed-in reader. */
async function fetchWidgetDocument(
  token: string,
  args: { chatId: string; messageId: string; viewId: string },
  signal: AbortSignal,
): Promise<{ ok: true; html: string } | { ok: false; unavailable: boolean }> {
  const site = convexSiteUrl();
  if (!site) return { ok: false, unavailable: false };
  const q = new URLSearchParams(args);
  const res = await fetch(`${site.replace(/\/$/, "")}/api/v1/widget-view?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!res.ok) return { ok: false, unavailable: res.status === 404 };
  return { ok: true, html: await res.text() };
}

export function WidgetPart({ data }: WidgetPartProps) {
  const viewId = data?.viewId ?? "";
  const title = data?.title?.trim() || m.widget_default_title();
  const chatId = useMessage((msg) => (msg.metadata?.custom as { chatId?: string } | undefined)?.chatId ?? "");
  const messageId = useMessage(
    (msg) => (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId ?? "",
  );
  const routedAgent = useMessage((msg) => {
    const custom = msg.metadata?.custom as
      | { routedInstanceName?: string | null; routedAgentId?: string | null }
      | undefined;
    return custom?.routedInstanceName && custom.routedAgentId
      ? `${custom.routedInstanceName}\u0000${custom.routedAgentId}`
      : null;
  });
  const token = useAuthToken();
  // Read at fetch time through a ref: a session-token refresh must not refetch (and
  // reload, losing its state) a widget that is already shown.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = token !== null && token !== undefined && token !== "";
  // Decided per MESSAGE (the instance that stores THIS reply's documents), never by
  // the conversation's last route. Nothing is fetched or rendered until it is KNOWN
  // and on.
  const config = useQuery(
    api.widgets.widgetConfigForMessage,
    chatId && messageId ? { chatId, messageId } : "skip",
  );
  const effective = config?.effective === true;
  const sendMessage = useMutation(api.send.sendMessage);

  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [height, setHeight] = useState<number>(data?.preferredHeight ?? WIDGET_DEFAULT_HEIGHT);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [promptNotice, setPromptNotice] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const isolation = useMemo(
    () =>
      resolveWidgetSandboxOrigin(widgetSandboxOriginSetting(), window.location.origin, [
        convexSiteUrl(),
        convexCloudUrl(),
      ]),
    [],
  );
  const expectedOrigin = isolation.mode === "dedicated" ? isolation.origin : "null";
  const frameUrl = isolation.mode === "dedicated" ? proxyFrameUrl(isolation.origin) : null;

  // --- the document -----------------------------------------------------------------
  useEffect(() => {
    const token = tokenRef.current;
    if (!effective || !token || !chatId || !messageId || !viewId) return;
    const controller = new AbortController();
    let unmounted = false;
    // Bounded: a gateway that never answers ends on the Retry card, not a skeleton.
    const timer = window.setTimeout(() => controller.abort(), WIDGET_LOAD_TIMEOUT_MS * 2);
    setLoad({ state: "loading" });
    fetchWidgetDocument(token, { chatId, messageId, viewId }, controller.signal)
      .then((out) => {
        if (unmounted) return;
        setLoad(out.ok ? { state: "ready", html: out.html } : { state: "error", unavailable: out.unavailable });
      })
      .catch(() => {
        if (!unmounted) setLoad({ state: "error", unavailable: false });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      unmounted = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [effective, hasToken, chatId, messageId, viewId, attempt]);

  // Simple mode: the proxy's own transform, applied in-page (widgetSandbox.ts).
  const srcDoc = useMemo(() => {
    if (load.state !== "ready" || isolation.mode !== "simple") return null;
    try {
      return prepareSimpleModeDocument(load.html, parseHtml);
    } catch (err) {
      return err instanceof WidgetDocumentRefused ? "" : null;
    }
  }, [load, isolation.mode]);

  // --- host protocol ----------------------------------------------------------------
  const gateRef = useRef(new PromptPortGate());
  const renderIdRef = useRef<string | null>(null);

  const postHostState = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    // An opaque frame can only be addressed with "*"; the proxy with its own origin.
    const target = isolation.mode === "dedicated" ? isolation.origin : "*";
    win.postMessage(currentThemeMessage(), target);
    win.postMessage({ type: WIDGET_CHAT_HOST }, target);
  }, [isolation]);

  const promptKey = `${chatId}\u0000${viewId}\u0000${attempt}`;

  // LIVE values for the prompt path: a port adopted when the widget loaded must see
  // the confirmation setting and the send path as they are NOW.
  const mustConfirmRef = useRef(false);
  mustConfirmRef.current = config?.promptConfirm === true;
  // The widget's message goes back to the agent that produced the widget, as the
  // person, through the conversation's send mutation — with no staged quote, no
  // mention and no re-routing by its text (the composer's send path would take all
  // three). A running turn queues it, like any send.
  const sendRef = useRef<(text: string) => Promise<boolean>>(async () => false);
  sendRef.current = async (text: string) => {
    if (!chatId) return false;
    const [instanceName, agentId] = routedAgent?.split("\u0000") ?? [];
    try {
      const args = widgetPromptSendArgs(
        chatId,
        text,
        instanceName && agentId ? { instanceName, agentId } : null,
        crypto.randomUUID(),
      );
      await sendMessage({ ...args, chatId: args.chatId as Id<"chats"> });
      return true;
    } catch {
      return false;
    }
  };
  const [promptController] = useState(
    () =>
      new WidgetPromptController({
        mustConfirm: () => mustConfirmRef.current,
        send: (text) => sendRef.current(text),
        onPending: (text) => setPendingPrompt(text),
        onFailed: () => setPromptNotice(m.widget_prompt_failed()),
      }),
  );
  const onPrompt = useCallback(
    (raw: unknown) => {
      const frame = frameRef.current;
      const admission = admitWidgetPrompt(
        raw,
        {
          connected: frame?.isConnected === true,
          visible:
            frame !== null &&
            (typeof frame.checkVisibility === "function"
              ? frame.checkVisibility()
              : frame.getClientRects().length > 0),
          focused: frame !== null && frame.ownerDocument.activeElement === frame,
        },
        promptKey,
        Date.now(),
      );
      if (!admission.ok) return;
      promptController.offer(admission.text);
    },
    [promptKey, promptController],
  );

  const adoptPort = useCallback(
    (port: MessagePort | null) => {
      if (!port) return;
      port.addEventListener("message", (event: MessageEvent) => {
        const d = event.data as { type?: unknown; prompt?: unknown } | null;
        if (d?.type === WIDGET_PROMPT) onPrompt(d.prompt);
      });
      port.start();
      port.postMessage({ type: WIDGET_PROMPT_HOST_READY });
    },
    [onPrompt],
  );

  useEffect(() => {
    const gate = new PromptPortGate();
    gateRef.current = gate;
    return () => gate.dispose();
  }, [load, attempt]);

  useEffect(() => {
    if (load.state !== "ready") return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!isFromWidgetFrame(event, frame?.contentWindow, expectedOrigin)) return;
      const d = event.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return;
      // Dedicated mode: the proxy's own handshake (upstream WidgetSandboxHost).
      if (isolation.mode === "dedicated" && frameUrl) {
        if (isProxyReady(d, frameUrl)) {
          const renderId = crypto.randomUUID();
          renderIdRef.current = renderId;
          frame!.contentWindow!.postMessage(resourceReadyMessage(load.html, renderId), isolation.origin);
          adoptPort(gateRef.current.load());
          postHostState();
          return;
        }
        if (d.method === SANDBOX_RESOURCE_LOADED) return;
      }
      switch (d.type) {
        case WIDGET_SIZE: {
          const h = clampReportedHeight(d.height);
          if (h !== null) setHeight(h);
          return;
        }
        case WIDGET_BRIDGE_READY:
          postHostState();
          return;
        case WIDGET_PROMPT_OFFER:
          adoptPort(gateRef.current.offer(event.ports[0]));
          return;
        case WIDGET_BRIDGE_PORT_OFFER:
          // The dashboard bridge (data/actions/crons) is not offered inline.
          event.ports[0]?.close();
          return;
        case WIDGET_RUNTIME_ERROR:
          // Shown, never sent back to the agent (upstream wakes the session; deferred).
          if (typeof d.message === "string") setRuntimeError((prev) => prev ?? d.message!.toString().slice(0, 300));
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, expectedOrigin, isolation, frameUrl, adoptPort, postHostState]);

  // Re-post the theme on every theme change (mode class, or a chart's inline tokens).
  useEffect(() => {
    if (load.state !== "ready") return;
    const observer = new MutationObserver(() => postHostState());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [load.state, postHostState]);

  const onFrameLoad = useCallback(() => {
    if (isolation.mode === "simple") {
      adoptPort(gateRef.current.load());
      postHostState();
    }
  }, [isolation.mode, adoptPort, postHostState]);

  if (!viewId) return null;
  if (config === undefined) {
    // The conversation's widget state is not known yet: nothing is fetched, nothing runs.
    return (
      <figure className="oc-widget" aria-label={title}>
        <div
          className="oc-widget__skeleton"
          role="status"
          aria-label={m.widget_loading()}
          style={{ minHeight: data?.preferredHeight ?? WIDGET_DEFAULT_HEIGHT }}
        />
      </figure>
    );
  }
  if (!effective) {
    // Widgets are off for this conversation (or its instance): nothing is fetched.
    return (
      <div className="oc-widget oc-widget--off" role="note">
        <LayoutTemplate className="size-4" aria-hidden="true" />
        <span>{m.widget_hidden_off()}</span>
      </div>
    );
  }

  return (
    <figure className="oc-widget" aria-label={title}>
      <figcaption className="oc-widget__title">
        <LayoutTemplate className="size-4" aria-hidden="true" />
        <span>{title}</span>
      </figcaption>
      {load.state === "loading" ? (
        <div
          className="oc-widget__skeleton"
          role="status"
          aria-label={m.widget_loading()}
          style={{ minHeight: data?.preferredHeight ?? WIDGET_DEFAULT_HEIGHT }}
        />
      ) : load.state === "error" || srcDoc === "" ? (
        <div className="oc-widget__error" role="alert">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <span>
            {srcDoc === ""
              ? m.widget_refused()
              : load.state === "error" && load.unavailable
                ? m.widget_unavailable()
                : m.widget_load_failed()}
          </span>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw className="size-4" aria-hidden="true" />
            {m.widget_retry()}
          </Button>
        </div>
      ) : (
        <>
          {runtimeError ? (
            // Atrium's own sentence; the widget's text only behind a disclosure, so a
            // widget cannot dress its words as Atrium chrome.
            <details className="oc-widget__notice" role="status">
              <summary>{m.widget_runtime_error()}</summary>
              <code className="oc-widget__notice-detail">{runtimeError}</code>
            </details>
          ) : null}
          {isolation.mode === "simple" ? (
            srcDoc !== null ? (
              <iframe
                key={`${viewId}:${attempt}`}
                ref={frameRef}
                className="oc-widget__frame"
                title={title}
                sandbox={SIMPLE_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                srcDoc={srcDoc}
                style={{ height }}
                onLoad={onFrameLoad}
              />
            ) : null
          ) : (
            <iframe
              key={`${viewId}:${attempt}`}
              ref={frameRef}
              className="oc-widget__frame"
              title={title}
              sandbox={PROXY_FRAME_SANDBOX}
              referrerPolicy="origin"
              src={frameUrl!}
              style={{ height }}
            />
          )}
          {pendingPrompt !== null ? (
            <div className="oc-widget__confirm" role="alertdialog" aria-label={m.widget_prompt_confirm_title()}>
              <p className="oc-widget__confirm-text">{m.widget_prompt_confirm_body()}</p>
              <blockquote className="oc-widget__confirm-quote">{pendingPrompt}</blockquote>
              <div className="oc-widget__confirm-actions">
                <Button variant="ghost" size="sm" onClick={() => promptController.cancel()}>
                  {m.widget_prompt_cancel()}
                </Button>
                <Button size="sm" onClick={() => promptController.confirm()}>
                  {m.widget_prompt_send()}
                </Button>
              </div>
            </div>
          ) : null}
          {promptNotice ? (
            <p className="oc-widget__notice" role="status">
              {promptNotice}
            </p>
          ) : null}
        </>
      )}
    </figure>
  );
}
