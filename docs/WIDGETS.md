# Inline widgets

An OpenClaw agent can show a small, self-contained HTML (or SVG) document **inside
its reply** — a counter, a chart, a form, a table it computed. OpenClaw calls this
an inline widget; the agent produces it with its core `show_widget` tool. Atrium
renders it in the assistant message body, isolated from the page, sized to its
content and themed like the rest of the conversation.

Widgets are an OpenClaw feature. Hermes has none, and every widget control is hidden
on a Hermes instance.

## What happens during a turn

1. **The conversation asks for the tool.** Each conversation has its own socket to
   the gateway. When widgets are allowed for that conversation (see
   [Switches](#switches)) and the gateway version supports them, the bridge opens the
   socket with the `inline-widgets` client capability. The gateway only offers
   `show_widget` to an agent whose run was sent from a socket carrying that
   capability; without it, the agent has no widget tool at all.
2. **The agent shows a widget.** The gateway stores the document (a managed canvas
   document, `cv_<id>`) and tells every operator client where it is: a `canvas`
   preview part rides the chat stream, the tool result carries the same descriptor,
   and the agent may also write an `[embed ref="cv_…" /]` shortcode in its text.
3. **The bridge keeps one descriptor per view.** The carriers name the same view;
   the bridge turns them into a single `widget` message part (`viewId`, title,
   preferred height). The reply text is stored exactly as the agent wrote it,
   shortcode included: the browser hides a shortcode only when the message carries
   the widget part it names, and only outside Markdown code (a half-typed `[embed`
   at the end of a reply still being written is held back until it is complete).
   A shortcode that names no stored widget (another conversation's view, a URL, a
   reply sent with widgets off) stays visible text. Copy, quote and bookmarks
   take what is on screen (the rendered blocks); export and search read the stored
   text, so they keep the shortcode. The
   document itself never travels on the chat stream and is never stored in Convex.
   A reply made only of a widget, or only of its shortcode, is a complete reply: the fallback sentence some gateways send after it
   ("The tool run finished, but no final summary was produced…") does not replace it.
4. **Convex records which conversation the document belongs to.** Only the
   conversation's own `show_widget` result — reported on the socket that sent the
   turn — registers a view to it, and only if no other conversation registered it
   first. The other carriers prove nothing: the gateway projects a `canvas` part from
   any tool result whose text has the canvas shape, and a shortcode is model text, so
   either can name a document of another conversation. They are stored only for a
   view already registered to this conversation. A fork inherits the registrations of
   the replies it copies.
5. **The reader's browser fetches the document.** The widget card asks
   `GET /api/v1/widget-view` (Convex HTTP action, with the reader's session token).
   Convex checks that the reader can read the conversation, that the view is one of
   that message's widget parts, **and** that it is registered to that conversation,
   then asks the bridge, which asks the gateway (`canvas.document.view`). The
   document is returned to the browser as text (buffered, not streamed) and handed to
   the isolated frame. The fetch is limited per reader (60 per minute); the bridge
   keeps recently fetched documents in a small bounded cache and bounds how many it
   asks the gateway for at once.

The gateway's `canvas.document.view` has no notion of who may read which document:
any operator connection can read any document by id, and documents outlive the
gateway session. Steps 4 and 5 are what keep a reader to the widgets their
conversations produced. A widget part that reaches a conversation any other way — an
imported archive, say — is shown as unavailable and never fetched. A widget another
client (the gateway's own Control UI, for instance) produced in the same gateway
session is not shown in Atrium.

## Switches

| Where | Who | Default | Effect |
|---|---|---|---|
| Settings → Agents → instance → **Inline widgets** | administrator | on | Off: no conversation of the instance declares `inline-widgets`, and no widget is shown. |
| Settings → Agents → instance → **Confirm before a widget sends a message** | administrator | off | On: a message a widget wants to send is shown to the person, who sends or cancels it. |
| Conversation: composer **+** menu, or the conversation's menu in the sidebar → **Widgets in this conversation** | conversation owner | on (follows the instance) | Off for this conversation only. |

Both widget switches are read when a message is dispatched, so a change applies
from the **next message**: the bridge re-opens the conversation's socket with or
without the capability. A socket is never re-opened while a turn is still streaming
on it or while a voice call is live on it — the change then waits for the first
send that finds it idle. Until then an agent may still hold the widget tool, but
while widgets are off for the conversation Convex stores no widget part, so nothing
is shown or fetched.

A conversation whose widgets are off shows a short note where an earlier widget
used to be, and fetches nothing.

## Widgets that send a message

A widget can propose a message to the conversation (`sendPrompt(text)` inside the
widget, on a click by the person). Atrium applies the same checks as the OpenClaw
Control UI before anything is sent:

- the widget must have offered its prompt channel before any of its own code ran,
  and only the first offer of a document is accepted;
- the person must be interacting with it: the widget frame is visible and has
  focus, and the widget's own wrapper requires a user activation;
- the text is trimmed, between 1 and 4 000 characters, and never starts with `/`
  or `!` (no host commands);
- at most 10 messages per minute per widget.

The message is then sent as the person, to the agent that produced the widget —
with none of what the composer adds: no quote the person staged, no `@mention`
resolved from its text. While a turn is running it waits in the conversation's
queue like any message. With the instance's confirmation setting on, it is shown
first and sent only on confirmation; the setting applies to widgets already on
screen, and while one message awaits confirmation the widget cannot propose another.

A script error inside a widget is shown as a short note above it, in Atrium's own
words; the widget's error text is only shown when the person opens the note. It is
not reported back to the agent.

## Isolation

The document is agent-authored code. Atrium renders it in one of two ways; both
keep it away from the page, its storage and the session token.

### Simple mode (default)

Nothing to deploy. The document goes into an `<iframe sandbox="allow-scripts
allow-forms">` through `srcdoc`, inside the Atrium page. Such a frame has an
**opaque origin**: it can run its own scripts, but it cannot read Atrium's DOM,
storage, cookies or token. `allow-same-origin` is never set in this mode — with
it, a `srcdoc` frame would share Atrium's origin.

Before rendering, Atrium applies to the document what the OpenClaw sandbox proxy
applies to it: a document that embeds another browsing context (`iframe`,
`object`, `embed`, …) is refused, and the proxy's guard script and content
security policy (no network connections, no WebRTC, no frames, no form
submission; scripts, styles and fonts only from the proxy's allow-listed public
CDNs) are inserted at the top of the document. Messages from the frame are
accepted only when they come from that frame's window with the opaque origin
(`"null"`).

### Dedicated sandbox host (optional)

The same isolation the OpenClaw Control UI uses: a separate origin serves a small,
stateless proxy page; Atrium frames the proxy and hands it the document over
`postMessage`; the proxy renders it in **its own** opaque inner frame, under the
proxy's HTTP security headers rather than a `<meta>` policy. Atrium ships its copy
of that proxy, pinned to the OpenClaw version it is validated against:

| File | What it is |
|---|---|
| [`deploy/widget-sandbox/index.html`](../deploy/widget-sandbox/index.html) | The proxy page, byte for byte as the pinned gateway serves it. |
| [`deploy/widget-sandbox/headers.json`](../deploy/widget-sandbox/headers.json) | The response headers it must be served with. |
| [`deploy/widget-sandbox/PROVENANCE.json`](../deploy/widget-sandbox/PROVENANCE.json) | Upstream tag and commit, the source files' hashes, and the proxy **version** — upstream's own `sha256(JSON.stringify([headers, html]))`, which a test recomputes. |
| [`deploy/widget-sandbox/Caddyfile`](../deploy/widget-sandbox/Caddyfile) | A standalone Caddy site serving it. |

The frontend image already serves the proxy on its second port, **8081**
(`docker/Caddyfile`): `/` answers the proxy with its headers, every other path
answers 404. To use it:

1. Choose a **dedicated hostname**, e.g. `widgets.example.com`. It must be a
   different origin from Atrium's, from the Convex origins and from the gateway.
   Atrium refuses a sandbox origin equal to its own or to the Convex HTTP origin
   and falls back to the simple mode — framing the proxy with
   `allow-same-origin` on Atrium's origin would give the widget the page.
2. Put it behind **HTTPS** (Atrium also refuses an `http:` sandbox origin under an
   `https:` page).
3. Route it to the frontend container's port 8081:
   - Docker Compose: the port is published as `WIDGET_SANDBOX_PORT` (default
     `8789`); point your reverse proxy's `widgets.example.com` at it.
   - Helm: set `widgetSandbox.origin` and `widgetSandbox.ingress.enabled=true`
     with `widgetSandbox.ingress.host` (and its TLS); the chart adds the port to
     the frontend Service and an Ingress for the host.
   - Elsewhere: serve `index.html` at `/` with exactly the headers of
     `headers.json` (the Caddyfile shows how).
4. Set **`WIDGET_SANDBOX_ORIGIN=https://widgets.example.com`** on the frontend
   container. It is written into the runtime `/config.json` at start.

Reverse-proxy notes:

- Do not add a `Content-Security-Policy`, `X-Frame-Options`,
  `Cross-Origin-Embedder-Policy` or `Cross-Origin-Opener-Policy` of your own on
  the sandbox host, and do not strip or rewrite the proxy's: its
  `frame-ancestors http: https:` is what lets Atrium frame it, and its
  `connect-src 'none'` is what keeps a widget offline.
- The proxy identifies its parent from the `Referer` (Atrium frames it with
  `referrerpolicy="origin"`). A proxy that removes the `Referer` on the way in
  breaks it.
- Keep the path `/`: Atrium frames `https://<sandbox origin>/` and accepts the
  proxy's readiness only for that exact URL.
- The page is static and holds nothing; any cache in front of it only has to be
  refreshed when Atrium ships a new copy.

What breaks when it is misconfigured:

| Symptom | Cause |
|---|---|
| Widgets render in simple mode although an origin is set | The value is not a bare `https://host[:port]` origin, or it equals Atrium's or the Convex HTTP origin. |
| Skeleton, then "could not be loaded" | The sandbox host is unreachable, answers something other than the proxy at `/`, or a proxy in front removed the `Referer` or added a framing policy. |
| Widget visible but unstyled or offline | Expected: a widget has no network access; only the listed CDNs serve scripts, styles and fonts. |

## Operating notes

- **The gateway's own sandbox port must be free.** OpenClaw binds a sandbox
  listener on its port **+ 1** (or on `mcp.apps.sandboxPort`) when a widget
  document is first requested, inside the gateway's network namespace. If
  something else already listens there — a sidecar sharing the namespace, another
  gateway profile — `canvas.document.view` answers `UNAVAILABLE` for **every**
  widget, and Atrium shows "no longer available" on all of them. Atrium never
  loads that listener in the browser, but the gateway refuses to serve a document
  without it. Move it with the gateway's own CLI, e.g.
  `openclaw config set mcp.apps.sandboxPort 18791` (the gateway restarts to apply
  it).
- **Documents do not live forever.** A gateway keeps the 32 most recent widget
  documents per session and drops older ones; an old conversation's widget then
  answers "no longer available" with a Retry button. Deleting a gateway session
  does not delete its documents.
- **Size.** A document is at most 2 MiB on OpenClaw 2026.9.6 and 10 MiB from
  2026.9.7. Convex relays it through an HTTP action (responses up to 20 MiB) and
  never stores it: a Convex document is limited to 1 MiB.
- **Gateway versions.** The `inlineWidgets` capability resolves from the version
  the widget chain was validated live on (see
  [OPENCLAW_VERSION_COMPAT.md](OPENCLAW_VERSION_COMPAT.md)); an older gateway
  declares nothing and shows no widget control.

## Deliberate limits

- **MCP App previews** (an MCP server's `ui://` view shown in the reply) are not
  rendered; they use a different host protocol.
- **Dashboard surfaces** — pinning a widget to a session dashboard, session
  reports, A2UI, the dashboard bridge (`data`, `action`, `cron` from inside a
  widget) — are not offered: an inline widget only gets the prompt channel.
- A widget's script error is not reported back to the agent.
