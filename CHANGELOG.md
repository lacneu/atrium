# Changelog

All notable, user-facing changes are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow the lockstep repo
version shared by the frontend and bridge images.

> **Release-only.** This file is updated when cutting a release, not on every PR.
> Per-change detail belongs in the PR description / commit messages; a release
> aggregates them here.

## [0.23.0] — A Stop button that really stops, and protocol drift you can see

Two follow-ups to 0.22.0's reliability push. The Stop control ends the run at the gateway
itself (not just on screen), and operators get a live early-warning when a gateway starts
speaking newer protocol than the bridge understands. No breaking changes; Convex changes are
additive.

- **The Stop button now really stops the agent.** A stop control appears in the composer while
  a reply streams. Clicking it keeps the text received so far (the reply settles as
  "Interrupted"), releases the conversation for the next message, and — new — actually cancels
  the run at the gateway, targeting the exact run of that turn: the agent stops burning tokens
  on an answer that is no longer wanted, and a follow-up already queued cannot collide with a
  zombie run. Races are settled honestly in both directions: a reply that completed right
  before the stop stays complete; a stopped reply is never overwritten by a late completion.
- **Operators can see when a gateway speaks newer protocol than the bridge understands.** The
  bridge now classifies every incoming gateway event against the vendored protocol schema and
  reports unknown fields (names only, never content) on its `/capabilities` endpoint — the
  early warning for "the gateway was upgraded before the bridge image", which previously
  surfaced as unexplained UI weirdness. Frames are never rejected: detection is observe-only.

## [0.22.0] — No answer left behind: late sub-agent reports, classified failures

A reliability release closing the last ways a gateway's work could silently never reach the
user: reports produced after a turn ended now arrive as messages, hard failures are classified
and explained, and the bridge's protocol support is now machine-checked against the exact
gateway version it validates. No breaking changes; all Convex changes are additive.

- **Reports finished after the turn now arrive in the conversation.** When a sub-agent outlives
  its parent turn (delegation queue, `sessions_yield`), the gateway delivers the consolidated
  report — text and generated files — in a follow-up run AFTER the reply ended. Atrium previously
  dropped that delivery entirely: the user saw an empty reply, the file never appeared, and the
  late sub-agent sat "running" until it was mislabeled timed-out (observed live with a 24 KB
  analysis report that never displayed). These announce runs now open a spontaneous assistant
  message that streams like any turn — with one refinement: the message is only created once the
  report shows real content, so a gateway "nothing to say" sentinel produces no empty bubble at
  all. Duplicate retransmissions, overlaps with an in-flight user send, and preemption races are
  all handled (pinned on live-captured frames).
- **A sub-agent that recovers from a context overflow is no longer frozen as "failed".** When a
  gateway hits its context limit mid-run, it can abandon the attempt with an error, condense the
  oversized tool results and resume the same run to a clean finish (observed live: error at t+0,
  recovery, success 43 s later). Atrium previously locked the sub-agent card on that intermediate
  error forever — even though the child actually succeeded and delivered its result. The monitor
  now keeps observing after an error: the real success overwrites the provisional failure (result,
  final runtime/tokens/cost, error banner cleared) and feeds the recovered result into conversation
  summarization; a child that truly died keeps its original error, shown immediately.
- **Failed turns are classified and explained, not just red.** The gateway's error taxonomy
  (context overflow, provider rate limit, timeout, model refusal) now reaches the error card as an
  actionable, localized headline — e.g. a hard context overflow reads "the conversation is too
  large for this turn: retry, trim the request, or start a new chat" — with the raw technical
  message demoted to a detail line. Turns that failed or were aborted at the gateway also finalize
  immediately instead of hanging up to 3 minutes on a receive timeout. Observability
  distinguishes a hard, un-recovered overflow from the silently-handled compaction of 0.21.0 in
  the per-turn context-pressure trace.
- **The bridge's protocol support is now a checked contract, not tribal knowledge.** The exact
  gateway protocol schema of the validated OpenClaw version is vendored into the repo with a
  field-by-field coverage manifest (supported / deliberately ignored / known gap — each with its
  reason), enforced by a CI test: bumping the validated gateway version enumerates every new
  protocol field and fails until each one is triaged. Operators get a factual, always-current
  answer to "what does this bridge support against which gateway version".

## [0.21.0] — See what the gateway is doing: compaction visibility, clearer sub-agent status

A feature release focused on transparency: when the gateway works hard (summarizing a long
conversation's context, running several sub-agents), the user now SEES it instead of wondering
whether the agent will ever answer. No breaking changes; all Convex changes are additive.

- **The conversation shows when the gateway compacted its context.** When a session approaches the
  model's limit, gateways (OpenClaw today, Hermes tomorrow) summarize the older exchanges before or
  even during a reply — an invisible step that could take ~10 seconds and quietly shorten the
  agent's memory of old messages. Atrium now detects it (from data it already receives — zero extra
  gateway calls, zero hot-path cost) and renders a subtle "Context optimized by the gateway" divider
  on the affected reply. It appears live WHILE the gateway compacts (explaining the wait) and stays
  in the thread as an honest marker; its tooltip explains what was condensed and that recent
  exchanges are kept verbatim. Detection is content-free by construction and pinned on live
  captures, covering both pre-reply and mid-reply compactions.
- **Sub-agent statuses are unambiguous at a glance.** The multi-sub-agent summary now renders one
  colored pill per status — green "done" count, accent "running" count (with the spinner), red
  "failed" count — instead of unlabeled icon+number pairs; hover and screen readers announce
  "3 done / 1 failed". Completed sub-agents read as success (green), no longer as greyed-out. The
  sub-agent list now starts collapsed behind that summary, matching the tools and Sources
  accordions; expand it for the per-child detail.
- **No more misleading "0.00 $" on failed sub-agents.** Gateways compute a sub-agent's cost only at
  settle, so a child that crashed (e.g. context overflow) reports tokens but never its cost. The
  detail panel now says the cost was "not reported" instead of showing a false zero; a genuinely
  idle child still shows 0.00 $ and successful children keep their real cost.
- **Operators can debug context pressure remotely.** Each turn ships a content-free
  `chat.gateway_pressure` trace (session fill counters + fill percentage + whether the gateway
  compacted — written after the reply completes, never delaying it), and a new
  `get_compaction_history` MCP tool / `GET /api/v1/compaction-history` endpoint (traces.read)
  returns the gateway's compaction checkpoints for a chat on demand — when, why, and how many
  tokens each compaction condensed (e.g. "auto-threshold, 19,698 → 1,050"), never the summary text.
  The read is strictly non-intrusive: it never touches live chat sessions, and a gateway outage is
  reported as such (never disguised as "chat not found").

Deploy note: `npx convex deploy` (additive schema + new API route) + frontend image + bridge image
REQUIRED (compaction detection lives in the bridge) + MCP image for the new tool.

## [0.20.0] — Hybrid rehydration: long conversations without the token bill

A feature release. When a gateway session resets (daily/idle resets, agent switches), Atrium
re-grounds the agent by re-injecting the conversation. Until now that block was purely verbatim:
its cost grew with the model's context window (up to hundreds of kilocharacters re-sent on EVERY
cold start), and everything beyond the budget was silently dropped — long conversations lost their
beginning entirely. No breaking changes; all Convex changes are additive.

- **Session resumes now inject a rolling summary + the recent messages verbatim.** Atrium
  maintains, per conversation, a cumulative summary of the older exchanges and injects it alongside
  the verbatim recent tail — the agent keeps BOTH the long-term thread (decisions, facts, open
  questions from weeks ago) and full-fidelity recent context, within a hard cap (~60k characters)
  whatever the model's window size. Everything the block omits is explicitly marked; the agent is
  never silently misled about its context.
- **The summary is maintained by an agent you choose, off the hot path.** After a turn completes,
  when enough new content accumulated, Atrium dispatches a summarization turn in a dedicated hidden
  session. The admin can mark an agent as the instance's "Conversation summary" specialist (a new
  agent type, like the documentary type) — it then owns these jobs; otherwise each chat's own agent
  summarizes itself, so conversation content never crosses an agent boundary it hasn't already
  crossed (the dedicated agent must live on the same gateway). Resuming a session stays instant —
  it never waits for summarization; with no summary yet, rehydration falls back to the capped
  verbatim behavior. Works on every supported OpenClaw version: no gateway plugin, no GPU, no new
  credentials.
- **Admins control the summarization brief and the trigger volume.** A new `history_summary` entry
  in Settings ▸ Agents ▸ Prompt injections: customize Atrium's framing per instance, or disable it
  to send only the bare material (existing summary + new messages) to an agent whose own briefing
  already carries the instructions. The framing toggle never turns the feature off — that is the
  instance's rehydration switch (Bridge settings). Settings ▸ Agents ▸ Chat defaults adds a
  per-instance **summary threshold** (how much unsummarized conversation accumulates before a
  summary is generated automatically).
- **See, generate, and edit the summary from Session settings.** Each conversation's Session
  settings panel gains a "History summary" section: the current summary text (with who generated
  it and when), a **"Next summary" gauge** showing how close the conversation is to the automatic
  trigger, live processing indicators while a summary is being written, and a **"Generate summary"**
  action to trigger one on demand. The summary can be copied, opened in a full reading dialog, and
  **edited** — an edited summary is used as the basis for the next automatic pass.
- **Sub-agent results count as conversation content.** For conversations driven by sub-agents (where
  the visible answer is the sub-agent's result and the parent turn carries no text), the summary and
  the rehydration block now include those results — so resetting such a session no longer loses the
  work the sub-agents produced.
- **Clearer agent details.** The Session settings AGENT section now names the agent and its gateway
  instance for every user (not only multi-agent users), and the sub-agent panel shows the gateway
  instance the sub-agent ran on.
- **Deletion-aware.** Deleting a message that the summary covers resets the summary (it is rebuilt
  from scratch); an in-flight summarization job covering deleted content is cancelled and its
  copies purged. The hidden session retains no conversation copies beyond the job in progress.
- **Content-free observability, anomaly-wired.** New `chat.summary` trace events (dispatch/
  correlate/fail with reason codes, counts only) and the `openclaw.rehydrate` trace now records
  whether a summary rode along and its size. Three consecutive summarization failures for a chat
  raise a `chat.summary_failing` anomaly — visible in Settings ▸ Observabilité, queryable via the
  MCP tools, and pushed to every admin's notification bell; rehydration meanwhile falls back to
  the verbatim behavior, so users never feel the failure.

Deploy note: `npx convex deploy` (new table + additive fields) + frontend image (Settings UI) +
bridge image REQUIRED for the summarize engine (it echoes the turn identity the correlation relies
on and advertises the capability — against an older bridge the engine refuses to dispatch and the
panel says the bridge must be updated; rehydration itself keeps working).

## [0.19.3] — Deploy-verification built in: two version truths per image

A small operability release. No breaking changes; Convex changes are additive.

- **Every image now carries a second, independent version truth — and the UI flags a divergence.**
  Diagnosing "am I really running the build I think?" required shell access and guesswork. CI now
  freezes the stamped version AND the exact git commit into each image's environment; the bridge
  reports them on `/health` and `/capabilities`, and the Bridge status banner shows the version with
  the short commit — e.g. `0.19.3 (483fdb1)`. If the image's build version disagrees with what the
  running code reports (a stale pull, a cached container), the banner shows an explicit amber
  warning instead of letting the mismatch hide. The frontend's `/version.json` also gains the
  `revision` field, and branch-built bridge images no longer mislabel their env version as "main".
- **The composer placeholder follows the agent you select.** Switching the composer's agent chip now
  updates the placeholder instantly ("Message Pissey…"); it previously kept naming the chat's last
  responding agent.

Deploy note: Convex functions (additive fields), then the frontend and bridge images. The build/
runtime version comparison becomes active on images built AFTER this release.

## [0.19.2] — Truthful image versions and a provider-neutral composer

A small corrective release before the next feature cycle.

- **`:latest` images now self-report their real version.** An image pulled via `:latest` right after
  a release reported the PREVIOUS version number while actually containing the new code (the
  "banner says 0.19.0 but the fix is in" confusion): `:latest` is built from `main`, where the
  committed version lags one release behind. Branch builds are now stamped with an honest
  pre-release version derived from the nearest tag (e.g. `0.19.1-dev.1.g0663349`), and the frontend's
  `/version.json` follows the same truthful number. A release-tagged image still reports the exact
  release version.
- **The composer no longer names the gateway provider.** The input placeholder said "Message
  OpenClaw…" — but OpenClaw is one gateway among others (a Hermes adapter is planned), not the
  product you write to. The placeholder now uses the resolved assistant identity: the agent's name
  for multi-agent users ("Message Olivier…"), or the active chart's brand ("Message Atrium…").

Deploy note: frontend image only for the placeholder; the CI change takes effect on the next builds
(no deployment action).

## [0.19.1] — Close the stale-file gap on gateway-http deployments

A corrective release, bridge-only. Completes 0.19.0's "old files no longer re-attach themselves"
fix on gateway-http deployments.

- **Unverifiable file mentions are no longer delivered.** 0.19.0 gated mentioned-only files on their
  modification date — but on gateway-http deployments (the default) the gateway reports NO file
  dates at all (verified live: neither a modification time in the media probe nor a Last-Modified
  header), so the guard silently let everything through and old files from other conversations kept
  re-attaching. A path that is merely mentioned in tool output is now delivered only when the file
  can actually be verified as fresh; with no verifiable signal it is refused, with a distinct
  diagnostic code (`unverifiable_mention` in the `openclaw.media` trace) so the decision is
  auditable. Explicit `MEDIA:` deliveries and structured tool outputs are unaffected — including
  deliberately re-sending an old file.

Deploy note: bridge image only (no Convex, no frontend). After deploying, the previous repro shows
`dropped reason=unverifiable_mention` in the `openclaw.media` traces instead of `stored`.

## [0.19.0] — Honest gateway-outage handling, no more stale file re-delivery

A robustness and honesty release: the interface now tells the truth when a gateway goes down, old
files can no longer re-attach themselves to new turns, and the app self-heals after a deploy. No
breaking changes; Convex changes are additive. Deploy: Convex + frontend + bridge.

- **When an agent's gateway goes down, the chat says so.** Previously a dead gateway showed NOTHING:
  the in-flight spinner kept claiming "Atrium traite votre message…" until a long timeout. Now the
  chat shows a non-blocking warning banner ("la passerelle ne répond plus — un envoi échouera
  probablement") and the in-flight indicator switches to an honest "the gateway is not responding —
  this turn may time out". The signal is precisely scoped — to that chat's instance, agent, your own
  identity, and the turn actually in flight — so another agent's (or another user's) problem never
  shows you a false outage, and switching agents mid-outage updates the guidance. The composer stays
  usable (one dead gateway must never lock everyone out); attachment size limits now also follow the
  agent currently selected in the composer.
- **Old files no longer re-attach themselves to new conversations.** When the agent read or edited
  notes that merely MENTIONED previously delivered files (its memory citing OTHER conversations'
  deliveries), the bridge re-attached those old files to the current reply (the "bilan-news + IFOA
  out of nowhere" bug). A path that is only mentioned in tool output is now delivered ONLY if the
  file can be verified as produced during the current turn — and when the gateway provides no way to
  verify it (the gateway-http mode reports no file dates), the mention is NOT delivered at all. An
  explicit `MEDIA:` delivery (the documented convention, injected into every turn) always works —
  including deliberately re-sending an old file, even when the same path was mentioned earlier in
  the turn.
- **The app self-heals after a deploy.** Navigating to a lazily-loaded page right after a new release
  could show "Une erreur est survenue" (the page's chunk files had been replaced). The app now detects
  that case and reloads itself once automatically; the retry button performs a full reload too.
- **Sub-agent export offers the same formats as the conversation export.** The panel's export button
  is now a Markdown / JSON menu; the JSON includes the task, status, full configuration, telemetry,
  every tool call with input/output, and the result.
- **Session settings now detail the agent's configuration.** The AGENT section of "Réglages de
  session" shows the same configuration table as a sub-agent's advanced view: agent, instance, model,
  provider, gateway runtime, and reasoning (current + default).

Deploy note: Convex functions (`npx convex deploy`), then the frontend and bridge images. Convex
changes are additive (an optional query argument; no schema migration).

## [0.18.1] — Sub-agent tools on Codex-harness gateways

A small corrective release, bridge-only. No breaking changes; nothing to deploy besides the bridge
image.

- **Sub-agent tool calls now appear on gateways running the Codex harness runtime.** On a gateway
  whose models run through the Codex app-server (`agentRuntime: "codex"`), a sub-agent's tool calls
  are emitted in a different frame shape than the native OpenClaw runtime — so the panel showed a
  working sub-agent with no tools at all. The bridge now recognizes that shape too: the tool list,
  its running/done progress, a failed call's error state, and the call's description all show up —
  on both runtimes. (On the harness runtime the gateway does not expose the child's session
  config/telemetry, so those panel fields stay absent there; the model/provider still display, seeded
  from the spawn response.) Verified live against both runtimes, with the recognition driven by real
  captured gateway frames.

## [0.18.0] — Complete sub-agent parameters and run telemetry

A focused follow-up to 0.17.0: the sub-agent panel now reflects every spawn parameter the OpenClaw
gateway exposes (embedded/API runtime), plus the run's telemetry. No breaking changes; Convex changes
are additive (new optional fields on the sub-agent record). Deploy: Convex + frontend + bridge.

- **The sub-agent panel now shows every spawn parameter.** The "Avancé" detail gained the missing
  gateway parameters: the spawn label, the agent the child actually runs as (visible when a spawn
  delegates to another agent), the light-context flag, the child's workspace (shown as the workspace
  name only — the server's filesystem layout is never exposed), and the gateway session id (the join
  key for the gateway's own `/subagents log` inspection). The detail toggle now opens whenever ANY
  field was captured, so a newly-added parameter can never be silently unreachable.
- **Run telemetry: duration, tokens, and estimated cost.** A sub-agent's runtime, total token usage,
  and estimated cost now appear in its panel — refreshed at a bounded cadence while it works and
  final once it settles. Telemetry is captured without adding any database write traffic (it rides
  on writes that already happen).
- **The model appears as soon as the sub-agent is created.** The spawn's resolved model/provider now
  seed the panel immediately, instead of waiting for the child's first frame.
- **Interacting with an auto-archived sub-agent is now clearly unavailable.** A spawn with
  `cleanup: "delete"` is archived by the gateway right after it reports — sending it a follow-up
  could only fail. The panel's composer now disables with an explicit reason, and the server refuses
  such sends outright (covering every path, including Enter and direct API calls). The guard holds
  even for a child that finishes faster than its spawn record arrives.
- **Sub-agent capture hardening.** The session id is also read from gateway frame shapes that carry
  it top-level; a straggler spawn record arriving after a fast child finished can no longer create a
  phantom "running" entry or flip a failed child's status; and an unchanged workspace path no longer
  re-writes the record on every frame.

Deploy note: additive Convex fields on the sub-agent record (extended session config + telemetry).
Deploy the Convex functions (`npx convex deploy`), then the frontend and bridge images.

## [0.17.0] — Sub-agent panel, live interaction, and OpenClaw 2026.6.11

A sub-agent-focused release: a dedicated panel to watch — and talk to — the sub-agents an agent
spawns, plus broader gateway support and queue/UI polish. No breaking changes. Convex changes are
additive (sub-agent tables and a per-message dispatch-status projection). Deploy: Convex + frontend +
bridge.

- **Watch a sub-agent's full run in a dedicated side panel.** Opening a sub-agent's in-thread card now
  slides out a resizable right-column panel showing everything about that sub-agent's run: its live
  status, its static configuration (model, provider, reasoning, runtime, mode, sandbox, role, depth,
  gateway), every tool it calls with a running/done count, and its final result rendered as markdown —
  the same fidelity as a main-agent turn. The conversation auto-scrolls to keep the exchange in view.
- **Interact with a running sub-agent.** From the panel you can send a follow-up to a sub-agent while
  it works — including file attachments — using the same composer ergonomics as the main chat (drop
  files, toggle the tool detail).
- **Export a sub-agent's session.** A one-click download produces a self-contained Markdown of the
  sub-agent's task, configuration, each tool call (input and output), and its result — your own data,
  ready to share or archive.
- **A successful sub-agent spawn no longer reads "error".** OpenClaw flags a *successful*
  `sessions_spawn` result as an error even though the child was created; the tool card now recognizes
  the created child and reads "completed", so a working delegation is no longer shown as a failure.
- **A message you send while the agent is busy is clearly marked "waiting".** Queuing a follow-up
  mid-turn now shows an "En attente" badge on that message instead of a misleading "processing…"
  placeholder, so it is obvious the message is parked behind the running turn (and dispatches
  automatically when that turn ends).
- **OpenClaw 2026.6.11 is validated and supported.** The compatibility manifest recognizes 2026.6.11
  as a validated gateway version. Note for self-hosters: 2026.6.11 drops the bundled `searxng`
  web-search provider, so a gateway configured for it must install/enable an alternative provider or
  disable web search, otherwise the gateway refuses to start.
- **Returning to the app reopens your last conversation.** Exiting Settings, following the home link,
  or reloading "/" now reopens the chat you were last in (validated against your chat list) instead of
  the empty "select a conversation" pane.
- **The chat list shows placeholder rows while it loads** instead of flashing an empty sidebar, so the
  workspace takes shape immediately on boot.

Deploy note: This release touches Convex (new `subAgents` and `subAgentInteractions` tables plus a
per-message dispatch-status projection — additive), the frontend image, and the bridge image. Deploy
the Convex functions (`npx convex deploy`), then the frontend and bridge images.

## [0.16.0] — Sub-agent reliability, OTLP trace export, and chart authoring

A large release: multi-agent reliability, a new traces exporter, broader gateway support, and chart
authoring. No breaking changes for end users — but ONE coordinated cross-repo change (the gateway
channel rename) with a required deploy ORDER (see the deploy note). Convex changes are additive only
(a table + indexes, a content-free routing trace, a `"user"` anomaly source, a chart `bpm` field).

- **Switching agents mid-conversation now keeps the full context.** When you route a turn to a
  different agent — and especially when you switch back to one, or pick an agent for the first time in
  a chat — that agent could answer as if it had never seen the conversation ("I don't have the context
  of this 'yes' — tell me what you'd like me to do"). The bridge was misreading a freshly-routed agent's
  session as already warm and skipping the history replay. The newly-selected agent now receives the
  full prior conversation every time, including the tricky cases: switching back to a previously-used
  agent, a chat with no default agent, and after a first send that failed or a bridge restart. A
  consecutive turn to the *same* agent still reuses its warm session (no redundant replay).
- **The sub-agent monitor now sits with the message that spawned it.** Instead of one ever-growing pile
  of cards pinned above the prompt — which became unusable in a long conversation — each sub-agent's
  card now appears in context, under the message that launched it. A failed sub-agent is never lost: a
  compact "N en échec" indicator near the composer jumps you straight to it (and shows it even when its
  message has scrolled far out of view).
- **You can report a sub-agent that failed — or finished with a wrong result.** A flag on a finished or
  failed sub-agent files a report that captures that sub-agent's execution details for an administrator
  to analyze, surfaced in a new admin "Sub-agent reports" view with an audited read of the captured
  snapshot and a reply thread back to you. Re-reporting the same sub-agent is a no-op, and the captured
  text is bounded so a verbose failure can always be filed.
- **Routing and sub-agent problems are now diagnosable from the observability tools.** The chat-state
  and diagnose tools expose (content-free) the per-turn routing, the bridge's rehydration decision, the
  sub-agents a turn spawned and their statuses, and a join key that stitches a turn's send / dispatch /
  rehydrate events together — so a multi-agent routing or stuck/failed sub-agent issue can be
  reconstructed from the tools alone, without a live reproduction. A reported sub-agent failure also
  appears (content-free) in the anomalies stream.
- **Tracing endpoints reject embedded credentials.** An OTLP, Langfuse, or Opik endpoint URL that
  carries `user:pass@host` userinfo is now rejected when saved (put auth in the encrypted headers
  instead) — these endpoints are shown in the non-secret integrations status, so a credential pasted
  into the URL would have been stored in clear and exposed. Also fixed an OTLP exporter bug where a
  differently-cased operator `content-type` header could corrupt the JSON payload sent to the collector.
- **Export your traces to any OpenTelemetry backend.** Alongside Langfuse and Opik, Atrium can now ship
  its (redacted, metadata-only) traces to any OTLP/HTTP endpoint — Grafana Tempo, Jaeger, Datadog, or a
  collector — configured from the Integrations settings: an endpoint URL plus auth headers that are
  encrypted at rest. The spans carry neutral, vendor-agnostic attributes, so nothing Langfuse-specific
  leaks into a generic backend.
- **OpenClaw 2026.6.10 is a validated gateway version.** The bridge recognizes and is
  compatibility-tested against 2026.6.10 (including its new scoped device-pairing flow); previously
  validated versions keep working.
- **Atrium conversations use their own `atrium` gateway channel.** The session-key channel segment moved
  from `webchat` to `atrium`, so Atrium no longer shares a gateway memory namespace with other webchat
  clients. This is a coordinated change across the bridge, Convex, and the Hindsight plugin (see the
  deploy order below); re-keying resets each agent's codex thread once, while Convex + Hindsight memory
  are preserved.
- **Export any chart as a file.** Every chart in the Theme settings now has an export button that
  downloads it as `<name>.chart.json` — the exact shape the importer accepts — so a designer can export a
  chart (built-in or custom), edit it, and re-import it. The round-trip is guaranteed for every built-in.
- **Charts can carry a heartbeat.** A new `bpm` chart token — set with a "cardiac gauge" slider in the
  chart editor, or directly in the JSON — drives the ambient pulse (0 = static). It travels with
  export/import like any other token.
- **A living, brand-tinted ambiance, driven by a heartbeat.** With ambient effects on (the default), the
  app gently breathes on a shared cardiac rhythm: soft background glows and primary-button blooms pulse
  in time, and the sign-in card and the chat composer each sit in front of a luminous glow that slowly
  drifts behind them and pulses too. Everything is tinted by the active chart's color and paced by its
  `bpm` token — subtle in light,
  emissive in dark, and fully disabled under `prefers-reduced-motion`.
- **Returning to the chat reopens your last conversation.** Leaving Settings (or any return to the chat
  root -- the brand/home link, a reload to "/") now reopens the conversation you were on instead of the
  empty "select a conversation" pane. The last open chat is remembered per browser and restored only when
  it still exists for you (a deleted or another identity's chat is ignored).
- **The app loads progressively.** Instead of a blank loading bar, the interface takes shape at once --
  the top bar, sidebar, and main area render immediately while the profile loads, and the chat list shows
  a shimmer placeholder that fills in as it arrives (the persisted sidebar width / theme are reused, so
  nothing jumps when the data lands). The page feels instant even when data is slower.
- **The error screen fills the page.** When a page fails and the friendly "Une erreur est survenue" /
  "Page introuvable" fallback is shown full-page (caught above the app chrome), it now covers the whole
  viewport instead of leaving a blank white band below it.
- *Deploy — ORDER MATTERS (the channel rename is cross-repo): **(1)** deploy the Hindsight plugin first
  (it accepts both `atrium` and `webchat`); **(2)** `npx convex deploy` (additive only: a table +
  indexes, the content-free routing trace, the chart `bpm` field) and rebuild the frontend, bridge, AND
  MCP images; **(3)** add the `atrium:` entries to each gateway instance's `identityLinks`. The OTLP
  exporter's encrypted headers need `ATRIUM_SECRET_KEY` set on Convex (already required for encrypted
  gateway credentials).*

## [0.15.0] — Failed sub-agents no longer leave you stuck

Reliability and ergonomics release for the sub-agent experience (builds on 0.14.0's monitor). No
breaking changes; additive indexes + a maintenance cron.

- **No more blank replies when an agent delegates.** When an agent hands a turn to a sub-agent and
  has nothing to say yet, its reply used to render as an empty bubble — you couldn't tell whether it
  was thinking, waiting, or broken. Now that turn shows a clear state where the answer would be:
  "delegated to a sub-agent — waiting…", or, if the sub-agent failed, the short failure reason with
  an invitation to send a new message — never a blank bubble.
- **Failure reasons are readable, never raw.** A sub-agent's tool error can arrive as a multi-kilobyte
  security-notice blob; both the failed reply and the monitor card now show a short, clean reason
  (e.g. "web_fetch (401)") and never dump the raw wrapper text into the conversation.
- **You can keep talking to your main agent while a sub-agent works.** Previously a follow-up you
  sent while a sub-agent was still running could be mis-delivered into that sub-agent. Now such a
  message is held — and the composer tells you so ("En attente du sous-agent…", with your message
  parked visibly in the thread) instead of looking like nothing happened — then dispatched to your
  main agent as soon as the sub-agent finishes (or fails, or times out), in order. If a sub-agent's
  observer is ever lost, the hold self-heals within ~25 minutes and the stale sub-agent is shown as
  failed. *Deploy: `npx convex deploy` (two additive indexes + a maintenance cron) + rebuild the
  frontend AND bridge images.*

## [0.14.0] — See and monitor the sub-agents your agents spawn

Feature release. No breaking changes; an additive table and a new gateway capability.

- **You can now SEE the sub-agents a main agent spawns — and how they're doing.** When an agent
  delegates work to a sub-agent (OpenClaw's `sessions_spawn`), a live "Sous-agents" panel in the
  conversation shows one card per sub-agent: its task, its status (running / done), and its result.
  Previously a sub-agent ran invisibly — you only saw the spawn tool call, never the work itself.
- **A failed or stuck sub-agent is now impossible to miss.** If a sub-agent errors out or stops
  responding — leaving the main agent waiting — its failure surfaces with the error reason shown
  inline, EVEN in the clean content view, so you see the problem and can unblock the conversation
  without digging through tool details. The monitor never relies on the gateway re-announcing the
  result; it watches the sub-agent itself and flags a silent timeout on its own.
- **Sub-agent observation is read-only, isolated, and self-cleaning.** Atrium only observes a
  sub-agent's activity for the chat that actually spawned it (never another chat's), strips server
  paths from what it shows, bounds memory, and purges a chat's sub-agent data when the chat is
  deleted. It needs a gateway that supports sub-agents (OpenClaw ≥ 2026.5.19). *Deploy: `npx convex
  deploy` + rebuild the frontend AND bridge images.*

## [0.13.1] — Multi-agent chats stay usable when the original agent is revoked

Corrective release. No breaking changes.

- **A multi-agent conversation is no longer wrongly locked when its original agent is taken
  away.** If an admin revokes your access to the agent a multi-agent chat was first created
  with, the conversation now stays usable — you keep routing each turn to your other available
  agents (the lock only applies to a single-agent chat, or when you have no usable agent left
  at all). Previously such a chat was incorrectly shown read-only even though sending would
  have worked.

## [0.13.0] — Route one conversation to multiple specialized agents, turn by turn

Feature release. No breaking changes; a few optional schema fields are added and the
single-agent experience is unchanged.

- **A single conversation can now address different specialized agents, turn by turn.** A new
  agent selector in the composer lets you send each message to the agent best suited for it —
  switch to a specialist, get its answer, come back to your generalist — all in one thread,
  with the shared context carried across. Each assistant reply is labelled with the agent that
  produced it. The selector also shows the instance name when you have agents on more than one
  gateway, and the now-redundant agent chip was removed from the chat header (the selector
  carries that information).
- **The called agent always sees the full conversation.** Switching agents re-grounds the
  newly-addressed agent with the whole thread so it has the context — but only on a switch,
  not on every message, so a long multi-agent conversation never re-sends its entire history
  each turn (which would bloat the model's context).
- **Single-agent chats are untouched.** A chat that only ever uses one agent behaves exactly
  as before — no selector, no per-message label, no routing change — and a user with a single
  agent never sees the selector. Routing to an agent you are not entitled to is refused at the
  server trust boundary (the turn fails rather than silently switching). *Deploy: `npx convex
  deploy` + rebuild the frontend image.*

## [0.12.0] — Delivery recordings: first-class list + evolution KPI

The delivery-latency recorder's session list (Réglages ▸ Observabilité ▸ Traces ▸ Latence de
livraison ▸ Afficher les enregistrements) becomes a first-class, sortable/filterable table,
with a trend KPI across recordings. No change to what is recorded (content-free timestamps).

- **Sortable, filterable recordings table.** The bespoke list is now a real table with columns
  Début / Fin / Échantillons / Démarré par / Statut, all sortable. Above it: a status filter
  (tous / actif / terminé), a "démarré par" search, and a date-range filter that defaults to
  "All time" (so opening it never hides older recordings) with a reset.
- **Inline detail toggle + delete.** A leading eye column toggles each row's skew-corrected
  per-segment report (bridge / A / C) inline. A per-row menu deletes a recording (admins), and
  multiple recordings can be selected and deleted together — a bulk delete only ever removes
  rows still visible under the current filters.
- **Per-recording sample count + segment-p50 rollup.** Each recording now carries its total
  delta count (the "Échantillons" column) and a segment-p50 summary, computed once shortly
  after it stops (and refreshed as late frontend samples land), so the list + KPI read it
  cheaply without rescanning timings on every load.
- **Evolution KPI.** A compact trend of segment C and A p50 across the recent recordings,
  read from the per-recording rollup — to see how delivery latency evolves over time.
- *Deploy: `npx convex deploy` (schema `deliverySessions.count` / `.rollup` + functions) and
  REBUILD the frontend image. The bridge and MCP have NO code change — rebuild them only for
  lockstep `/api/v1/version` consistency (0.12.0).*

## [0.11.1] — Delivery recorder: segment C follows the displayed transport

A diagnostic refinement of the delivery-latency recorder for the SSE transport added in 0.11.0.
No user-facing behavior change (the recorder is opt-in, off by default).

- **Segment C measures the path the user saw first.** It now closes at `min(reactive receipt,
  SSE receipt)` per delta — the first appearance across the two coexisting legs: the reactive leg
  on short streams, the SSE leg on long ones (where the reactive full-text re-push lags and SSE
  wins the display). It never loses a sample if a leg replays/fails, and a reload's SSE replay
  (chunks below the displayed frontier) is excluded so it can't overwrite earlier measurements.
  The recorder correlator rides the SSE chunk ONLY during an active recording (zero cost
  otherwise). Segment C remains a skew-corrected APPROXIMATION — the SSE leg's t4 is stamped at
  parse, so under main-thread load it can read up to one render cycle early; within the
  recorder's existing noise floor, not a precise paint timestamp.
- *Deploy: `npx convex deploy` (schema `streamChunks.recTimingId` + functions) and REBUILD the
  frontend image. The bridge and MCP have NO code change — rebuild only for lockstep
  `/api/v1/version` consistency (0.11.1).*

## [0.11.0] — Live-stream transport: opt-in SSE / streamable-HTTP per gateway-instance

A second live-stream transport for assistant replies, selectable per gateway-instance. The
default is UNCHANGED (Convex's native reactive push), so existing chats behave exactly as
before — the new transport is opt-in.

- **SSE / streamable-HTTP transport (Plan B).** A standard Server-Sent-Events endpoint
  (`GET /api/v1/message-stream`) streams a reply incrementally over the wire, so non-Convex
  consumers (mobile, third-party) can read the live stream with standard tooling. Convex stays
  the entry point and durable store; the stream replays from a resumable cursor (`Last-Event-ID`)
  and an authoritative `final` event closes it. Backed by an append-only `streamChunks` log,
  garbage-collected on finalize and on message/chat deletion.
- **Per-instance transport choice.** Each gateway instance carries a `streamTransport`
  (`reactive` | `sse`, default `reactive`), edited in **Réglages ▸ Agents ▸ Instances ▸ ⋮ ▸
  Modifier l'instance**. A chat uses the transport of the instance it is ROUTED to (resolved the
  same way dispatch routes, so a legacy/unbound chat follows its effective instance). This is a
  frontend↔Convex display choice and is deliberately NOT part of the bridge config blob.
- **Seamless coexistence.** With SSE active, the reactive path stays the fallback: the display
  never regresses during a mid-stream reload (the SSE replay is gated by chunk sequence, not
  length) and never flashes another conversation's text on a chat/transport switch (the live
  state is keyed by message id). A failed SSE fetch silently falls back to reactive — no blank
  messages.
- *Managed Convex Cloud note: an SSE stream is a long-running action, so the number of CONCURRENT
  SSE streams is bounded by the plan's concurrent-actions limit (64 Free/Starter, 512 Pro);
  self-hosted has no such cap. That is why SSE is opt-in and reactive stays the default.*
- *Deploy: `npx convex deploy` (schema + functions) and REBUILD the frontend image. The bridge
  and MCP have NO code change this release — rebuild them only for lockstep `/api/v1/version`
  consistency (0.11.0).*

## [0.10.18] — Delivery recorder: bridge-internal segment now collects for snapshot streams

Corrective for 0.10.17 — a live run showed the new bridge-internal segment staying empty.

- **`setSnapshot` now carries t0.** 0.10.17 added the bridge-internal segment (frame receipt →
  send) but only on the delta path (`appendDelta`/flush). Gateways that stream by re-sending the
  whole text each frame — the common OpenClaw mode — go through `setSnapshot`, which had no t0, so
  the segment was empty for them. `setSnapshot` now stamps t0 at frame receipt, so bridge-internal
  collects regardless of streaming mode (delta or snapshot). Scope: t0 is the bridge write-side
  receipt — accurate in steady state; under sustained backpressure it under-reports the
  gateway-read backlog (already visible via the per-flush `waitedMs`/`postMs` logs).
- *Deploy: `npx convex deploy` + REBUILD the bridge, frontend and MCP images (lockstep 0.10.18).
  The **bridge image MUST be rebuilt** — a bridge predating the t0 work (e.g. a stale 0.10.16/0.10.17
  image) reports no bridge-internal data at all, which is what left the segment empty.*

## [0.10.17] — Delivery recorder: honest segments (no fake Convex-exec, + bridge-internal)

Follow-up to 0.10.16 after a live run exposed a misleading "B: 0 ms".

- **Removed the fake "Convex exec (B) = 0 ms".** It was a measurement artifact, not a real
  zero: Convex freezes `Date.now()` within a mutation (determinism), so the two stamps the
  recorder compared (`t2`, `t3`) were identical by construction → B was always 0. Real Convex
  execution time (≈17 ms p50 in practice) comes from Convex's own telemetry (insights / log
  streaming); the report now says so instead of showing a fabricated zero.
- **New "bridge internal" segment.** The recorder previously started the clock at the bridge's
  SEND moment; the time from when the bridge received a delta to when it forwarded it was
  invisible. That hop is single-clock (no skew) and is now measured and reported.
- The report's segments are now **bridge-internal → A (bridge→Convex) → C (Convex→frontend)**,
  each shown only when it can be computed; B is annotated as externally sourced.
- *Deploy: `npx convex deploy` + rebuild the bridge, frontend and MCP images (lockstep 0.10.17).*

## [0.10.16] — Delivery recorder: accurate bridge→Convex timing + hardening

Corrective + hardening follow-up to the delivery-latency recorder (0.10.14 / 0.10.15).

- **Segment A (bridge → Convex) is now accurate.** The bridge derived its clock skew by
  piggybacking the startAssistant round-trip, whose heavy server work biased the estimate
  and made A read negative. The bridge now calibrates via a dedicated lightweight
  `calibrate` op (no server writes), takes several samples and keeps the least-queued one,
  and re-calibrates periodically so a long-running bridge can't drift. The report also
  excludes any delta recorded before calibration completed rather than show an uncorrected A.
- **Hardening (from a multi-reviewer audit).** The report card formats dates in the browser
  locale; the report flags when its window is truncated; the frontend timing batch is
  server-capped; an auto-stopped session shows its effective stop time; the clipboard copy
  can't throw; the in-band dedup set is bounded across sessions; minor a11y on the session
  list. Scale tests added (linear recording, delete-at-scale).
- *Deploy: `npx convex deploy` + rebuild the bridge, frontend and MCP images (lockstep 0.10.16).*

## [0.10.15] — Delivery recorder: browse & delete sessions, copy a report, full MCP control

Follow-up to 0.10.14's delivery-latency recorder.

- **Browse recorded sessions.** Settings▸Traces now lists past recording sessions; pick
  one to view its report, and copy a report to the clipboard for sharing.
- **Delete sessions.** Admins can select one or several recorded sessions and delete them
  along with their timing rows; deleting the active session also stops recording.
- **Complete MCP control.** The MCP tool surface now covers the whole lifecycle —
  `start_delivery_record`, `stop_delivery_record`, `list_delivery_sessions`,
  `get_delivery_report`, `delete_delivery_sessions` (list/report require `traces.read`;
  start/stop/delete require `selfheal`).
- *Deploy: `npx convex deploy` + rebuild the frontend, MCP **and bridge** images. The
  bridge's code is unchanged here, but its version bumped to 0.10.15 in lockstep, so its
  image must be rebuilt for its /health & /capabilities to report the release version.*

## [0.10.14] — Measure streaming delivery latency end-to-end (bridge → Convex → frontend)

A controllable, content-free recorder that times the streaming pipeline per delta, so
"where does the time go in a slow reply?" has a measured answer instead of a guess. OFF
by default, with no cost on the streaming hot path until a session is running.

- **Record a session, read a report.** From Settings▸Traces an admin starts a recording;
  while it is active each streamed delta is timed across three segments — A (bridge →
  Convex), B (Convex execution), C (Convex → frontend) — correlated end to end and
  corrected for the three machines' clock offsets. The report shows p50 / p95 / max per
  segment, so a long reply can be attributed to the model/gateway versus Atrium's own
  delivery. The same controls are available over the MCP tools (`start_delivery_record`,
  `stop_delivery_record`, `get_delivery_report`) for diagnosing from outside the browser.
- **Content-free and safe by default.** Only timestamps and sizes are recorded — never
  message content. Nothing is recorded unless a session is active, and a session
  auto-stops after about ten minutes. Starting or stopping a recording is admin-only (or
  a service account holding `selfheal`); reading a report needs `traces.read`.
- *Deploy: `npx convex deploy` + rebuild the frontend, bridge and MCP images.*

## [0.10.13] — Tool-heavy chats stop lagging on the wire (the window no longer ships full tool outputs)

Corrective performance fix. No schema migration.

- **The chat window read no longer re-ships large tool outputs (and reasoning) over the
  network.** `listByChat`/`loadChatView` returns the whole recent message window and
  re-runs on any message change (e.g. each turn's finalize). It was including the FULL
  raw tool `output` for every message — one `web_search` turn alone carried ~89 KB of raw
  results, and the window re-pushed ~104 KB in full over the WebSocket on every change.
  Over a WAN this made the streamed reply visibly trail the gateway by several seconds —
  Atrium had received the text but was still "writing" while those big frames cleared.
  Now any tool `input`/`output` or `reasoning` text over 8 KB is **elided from the window
  read** (the full value stays in the database); the message shows a "(N KB — not shown
  here)" note in its place. The window stays small no matter how tool-heavy the history
  gets — measured: that 104 KB window drops to ~15 KB. Diagnosis was wire-level (a HAR
  capture of the Convex sync socket); smooth-reveal and delta cadence were ruled out by
  measurement first.
- *Deploy: `npx convex deploy` (the window read changed) + rebuild the frontend image (the
  card shows the size note).*

## [0.10.12] — Configure (or remove) the instructions Atrium injects into each turn

Feature release. No breaking changes; the stored config gains one optional field.

- **A new Settings ▸ Agents ▸ Injections tab lets admins adjust or disable the standing
  instructions Atrium splices into every gateway turn — per instance.** To make features
  work out of the box, Atrium prepends/appends a few instructions to the message the gateway
  sees: how to make a generated file downloadable (`MEDIA:` delivery), the "Attach source
  documents" fetch brief, and the received-files preamble. But if your gateway has ALREADY
  taught its agents these conventions, re-injecting them only bloats the turn's context for
  nothing (an extreme case overflowed a documentary fetch to ~260k tokens). The dedicated,
  full-width tab — roomy enough to manage the long instruction texts — lists instances from
  their records (NOT live bridge health), so you can configure an instance **before it is
  connected / made available to users**. Per injection you can:
  - **disable** it — turn it off when the gateway already instructs the agents. Disabling the
    documentary-fetch brief sends only the bare reference list (no framing), never an empty
    turn;
  - **customize** its text — e.g. tailor the documentary-fetch brief to how documents are
    reachable in your environment.
  Each injection carries a **help tooltip explaining its purpose and what breaks if you
  disable it**; each available **`{variable}` is a chip with its own help bubble** describing
  what it injects; a **Preview** shows the final text with the variables filled with example
  values (what the agent receives); a customized entry is flagged with a one-click reset. The
  list is registry-driven, so future injection points appear automatically. A bare Save never
  freezes the defaults as overrides (only your explicit changes persist), and a disabled or
  malformed entry safely falls back to the built-in default rather than silently dropping the
  instruction. *Deploy: `npx convex deploy` + rebuild the bridge AND frontend images.*

## [0.10.11] — Faster first load: admin/settings code is lazy-loaded (~25% smaller initial bundle)

Frontend optimization. No schema migration.

- **The admin/settings tab code no longer ships in the initial chat bundle.** All the
  Settings tabs (Users, Instances, Bridge, Roles, Groups, Traces, KPI, Anomalies, Audit,
  Feedbacks, Files, …) and their heavy deps (data tables, filters, instance/gateway config
  dialogs) are now lazy-loaded on demand — a chat user who never opens Settings never
  downloads them. The initial JS dropped **~531 → ~399 KB gzip (−25%)**, so first paint /
  time-to-interactive is faster for everyone. Each tab loads its own small chunk the first
  time it is opened (route-level via the router, paramless tabs under a Suspense boundary).
  Internally this split the 1.8k-line `AdminSettings` barrel into a light metadata module
  plus one file per tab. No behavior change — every tab renders and works exactly as before
  (verified by type-check, the full test suite, and manual exercise of the instance/config
  flows).
- Agent-image attachments now decode off the main thread (`decoding="async"`), a small
  smoothness win when an image lands mid-stream (on top of the existing `loading="lazy"`).
- *Deploy: rebuild the frontend image; run `npx convex deploy` for the lockstep version
  (the only Convex change since 0.10.10 is a dev-gated load-test seeder, inert in prod).*

## [0.10.10] — Streaming re-pushes ~3× less redundant data (coarser delta coalescing)

Network optimization. Bridge-only; no schema migration.

- **The bridge coalesces streamed text deltas over a wider window, cutting redundant
  live-text re-push.** Convex re-pushes the FULL live text on every streamed flush, so
  the cumulative bytes a client receives grow O(n²) with reply length (a ~1.8 KB reply
  pushed ~75× its own size). Widening the bridge's coalesce window from 50 ms to 150 ms
  posts ⅓ as many flushes → Convex re-pushes ⅓ as often → measured **~3× less** redundant
  bandwidth (push amplification 75→25 on that reply). The window is tunable via
  `OPENCLAW_DELTA_FLUSH_MS` (default 150); Streamdown's smooth reveal keeps the rendered
  text continuous between the coarser flushes, and the heartbeat stays far under the
  stuck-stream watchdog. This is the low-risk first step; a fundamental incremental-delivery
  rework (stop re-pushing the full text at all) is held pending whether long replies still
  lag over the WAN now that 0.10.9 removed the client-side parse cost. *Deploy: rebuild the
  bridge image (set `OPENCLAW_DELTA_FLUSH_MS` to tune); `npx convex deploy` for the lockstep
  version (no Convex code changed).*

## [0.10.9] — Streamed replies render in O(n) at any length, smooth restored

Corrective release. The fundamental fix for the streaming jank the 0.10.8 palliative
only softened. Frontend-only; no schema migration.

- **The assistant markdown renderer now parses incrementally, per block.** The reply
  was re-parsed as a whole markdown document on every streamed token — O(n²) that
  janked long replies (the 0.10.8 palliative cut it by turning the animation off and
  memoizing reconcile, but the re-parse itself remained). The renderer moves from
  `@assistant-ui/react-markdown` to `@assistant-ui/react-streamdown` (Streamdown),
  which splits the text into independent memoized blocks so only the LAST (growing)
  block re-parses per token → O(n). Measured (per-frame gap / dropped frames across one
  long streamed reply): **76% dropped → 6%** at ~4k chars, and a 500-block reply that
  was catastrophic under the palliative (~88 ms/frame, ~all frames dropped) now holds
  ~flat (~18 ms, ≤7%). **The smooth typewriter animation is restored** (the 0.10.8
  palliative had disabled it) — now cheap because the parse is O(n).
- **Untrusted-link handling is preserved**: agent links still open in a new tab with
  `rel="noopener noreferrer"`, and non-navigable file paths still render as plain text.
  HTML in agent output is sanitized by Streamdown's default chain (script tags, inline
  event handlers, `javascript:`/`data:` URIs, `<iframe>`/`<form>` are neutralized — pinned
  by a new test). NOTE: unlike the previous renderer (which escaped raw HTML to literal
  text), Streamdown now PARSES and renders agent HTML *sanitized* — a deliberate,
  threat-model-reviewed broadening.
- Code blocks gain a copy/download header (Streamdown's controls). Bundle grows ~108 KB
  gzip (Streamdown + its sanitizer); it sits on the critical render path, so it is not
  lazy-loaded. *Deploy: rebuild the frontend image; run `npx convex deploy` so the
  lockstep version stays honest (no Convex code changed).*

## [0.10.8] — Streaming replies stop slowing down as they grow (palliative)

Corrective release. Fixes the streaming reply that lagged more and more as it got
longer — visibly janky on long answers, while the OpenClaw Control UI stayed smooth.
Frontend-only; no schema migration.

- **The streamed markdown is no longer re-parsed from scratch on every token.** The
  assistant message re-rendered the WHOLE growing reply as markdown on each streamed
  token — an O(n²) cost that is invisible on short answers and increasingly janks long
  ones (measured: inter-frame gap 12 ms → 41 ms and dropped frames 2% → 76% across one
  long reply; plain text of the same length stayed flat, isolating the markdown re-parse
  as the cause — not the network, the backend, or the model). Two changes cut it:
  - **the smooth typewriter reveal is turned off** — it re-parsed the full text on every
    animation frame, multiplying the cost above the token rate. Text now appears
    chunk-as-it-arrives, closer to the Control UI. *Behaviour change: the gradual
    letter-by-letter animation is gone.*
  - **completed markdown blocks are memoized** (per block, keyed by parsed node), so
    finished paragraphs / lists / code blocks skip re-rendering on later tokens.

  Result on a medium reply: dropped frames **76% → 26%**. This is a **PALLIATIVE** —
  very long replies still degrade, and the redundant full-text re-push over the socket
  is untouched; a fundamental incremental-render + incremental-delivery rework follows in
  the next release. *Deploy: rebuild the frontend image; run `npx convex deploy` so the
  lockstep version stays honest (no Convex code changed).*

## [0.10.7] — "Joindre les documents" delivers files again (a clean session per fetch)

Corrective release. Fixes the documentary "attach source documents" action, which had
started returning only "Source introuvable". No schema migration.

- **Each documentary fetch now runs in a CLEAN session, so the agent reliably delivers
  the files.** "Joindre les documents" dispatches a fetch turn to a hidden, reused
  documentary chat. That single gateway session accumulated every prior fetch's
  references, files and tool runs; live data showed the agent delivering on a clean
  first turn, then returning ZERO files once the session was polluted (every reference →
  "Source introuvable"). Two changes give each fetch a fresh slate:
  - the gateway **session is rotated per fetch** (a fetch-specific routing id), so the
    agent never inherits a previous fetch's context;
  - **rehydration is disabled for documentary chats** — the bridge no longer re-prepends
    the hidden chat's prior turns (which would have re-polluted the rotated session).
  One hidden chat row is still reused (no chat churn); only the agent's working context
  resets. *Deploy: `npx convex deploy` — the fix is Convex-only; image rebuilds on the
  tag only re-stamp the version for lockstep.*

## [0.10.6] — The deployed-Convex version is honest from a plain `npx convex deploy`

Corrective release. Fixes the version diagnostic shipped in 0.10.5. No schema migration.

- **`/api/v1/version` now reports the real deployed version without any extra step.** In
  0.10.5 the Convex version constant lagged the release (it was meant to be stamped at
  deploy), so a normal `npx convex deploy` from the release tree served the *previous*
  version — a false mismatch with the 0.10.6 images, the exact thing the endpoint is
  meant to catch. The Convex functions are pushed manually from the COMMITTED tree (not a
  CI-built image), so the version is now committed in lockstep AT the release version:
  `scripts/set-version.mjs` bumps every artifact together (root, bridge, mcp, and the
  Convex `DEPLOYED_VERSION`) during release prep. A plain `npx convex deploy` from the
  release tree now serves the correct version, and a forgotten deploy still stands out as
  a mismatch with the image versions.

*Deploy: `npx convex deploy` (from the repo root) + rebuild the frontend AND bridge
images. No separate version-stamp step — the committed tree already carries 0.10.6.*

## [0.10.5] — See what is actually deployed, and which provenance fields reached Convex

Operability release. No breaking changes, no schema migration.

- **Every layer now self-reports its version — including the Convex functions.** The
  bridge and frontend ship their version baked into a Docker image, but the Convex
  functions are pushed by a SEPARATE step (`npx convex deploy`) that rebuilding images
  and restarting containers does NOT perform — so a forgotten function deploy was
  invisible until a feature silently failed. Now:
  - **`GET /api/v1/version`** (public, no auth, no PHI) returns the deployed Convex
    functions' version — `curl <convex-site>/api/v1/version`.
  - The **frontend image** serves **`/version.json`** (`curl <frontend-host>/version.json`)
    and carries **`ATRIUM_VERSION`** in its env (`docker exec <c> env | grep ATRIUM_VERSION`);
    it previously surfaced no version anywhere.
  - The **bridge image** carries **`ATRIUM_VERSION`** in its env too (it already
    self-reported via `/compat`).
  - `scripts/set-version.mjs` stamps the Convex version constant in lockstep with the
    image versions, so a mismatch between layers makes a missed deploy obvious at a glance.
- **The Sources diagnostic now shows exactly which provenance fields reached Convex.**
  The `get_chat_state` structure gains an additive, content-free **`present`** list per
  item — the KNOWN field NAMES that are set (e.g. `["file_name","title","text"]`), never
  any value. One observability call now reveals whether a document carried its `title`,
  `score`, or excerpt through the pipeline, instead of having to infer it. The existing
  `hasFileName` / `hasScore` booleans are unchanged (kept for the published contract).

*Deploy: from the repo root, `node scripts/set-version.mjs <version> && npx convex deploy`
(stamp THEN deploy, so the served version matches the code — the step image rebuilds
skip) + rebuild the frontend AND bridge images.*

## [0.10.4] — A LightRAG source document shows its readable name, not an opaque id

Feature release. No breaking changes, no schema migration (the stored provenance item
gains one optional field).

- **A source document now shows its readable name as the title, while keeping its id.**
  A LightRAG document used to appear titled by its opaque retrieval key (e.g.
  `gdrive/<hash>`). When the item now carries a human `title` (provenance/v1, additive —
  the openclaw-knowledge plugin parses it from the document's `File Name:` metadata
  header), the Sources panel shows that **name** as the heading and keeps the underlying
  reference as a muted **sub-line** beneath it. The id stays **searchable** (the search
  box still matches it) and stays the **stable key** the documentary-attach action and
  the "Source d'origine" fetch use — so titling a document never breaks selecting or
  fetching it. A context excerpt (not a findable document) shows no such sub-line. Pairs
  with **openclaw-knowledge 3.2.13**, which emits the title; documents without a title
  are unchanged. *Deploy: `npx convex deploy` + rebuild the frontend AND bridge images.*

## [0.10.3] — Backend-latency probe for traffic-independent perf trends

Observability release. No breaking changes, no schema migration, no UI change.

- **A synthetic backend-latency probe now tracks server-side execution latency,
  independent of traffic.** A fixed-cadence cron (every 5 min) times a representative,
  identity-free, content-free read (a bounded `messages` window) and records its
  server-side execution latency, rolled up into a new `convex.probe.latency.avg_ms` KPI.
  Because the cadence is fixed rather than driven by organic chat traffic (which is far
  too sparse to form a trend), a change in the trend is attributable to the **backend
  itself** — giving a clean apples-to-apples before/after for a NAS↔Convex-Cloud
  migration. Honestly scoped: this is server-side query *execution* latency (a
  backend-load proxy), NOT full client-perceived latency (network + render are excluded).
  A failed probe records a high sentinel so the average visibly spikes rather than
  silently dropping the sample. *Deploy: `npx convex deploy` registers the cron + KPI.*

## [0.10.2] — Each LightRAG source document shows the content it contributed

Contract clarification. No breaking changes, no schema migration, no UI change.

- **The Sources panel now shows the retrieved content (and score) of each source
  document a synthesizing retriever returned — not just an opaque id.** The provenance
  contract now specifies that, for a synthesizing retriever (LightRAG), a `documents`
  item's `text` carries the **per-document retrieved source content** (and a `score`
  when the retriever provides one), so a user sees the material the RAG actually pulled
  for each source — exactly what was missing when a document appeared as only a
  `gdrive/<id>`. This pairs with **openclaw-knowledge 3.2.11**, which emits it; Atrium's
  Sources card already rendered an item's excerpt + relevance bar, so this is a contract
  + published-schema (`GET /api/v1/schemas/provenance.v1`) clarification, not a UI
  change. The verbatim, truncated injected context stays a separate **Context** item —
  the two are complementary, and because the per-document content is a distinct field it
  is not subject to the context-blob truncation. *Deploy: `npx convex deploy` (refreshes
  the served schema); no frontend or bridge change.*

## [0.10.1] — Diagnose a Sources panel from the observability API

Maintenance release — observability only. No breaking changes, no schema migration, no
user-facing UI change.

- **The diagnostic chat-state API now explains a Sources panel without exposing its
  content.** Each provenance part in `GET /api/v1/chat-state` (and the `get_chat_state`
  MCP tool) now carries a SOC2-safe `structure`: per-item kind (document/context/memory)
  + `hasFileName`/`hasScore` booleans, item counts, and an allowlisted source/route —
  never a file name, excerpt, or score value. An operator can now diagnose, for example,
  "this reply's documents carry no relevance score" (a bare LightRAG-attribution turn —
  expected, since LightRAG attributes source files without a per-reference score) straight
  from the observability surface, instead of from a screenshot. *Deploy: `npx convex
  deploy` + republish the MCP package.*

## [0.10.0] — A published provenance contract, and correct Sources for synthesized context

Feature + corrective release. No breaking changes, no schema migration (the stored
provenance part gains one optional field).

- **The chat Sources panel now separates real source documents from synthesized
  context.** A LightRAG reply's knowledge-graph context was surfaced as a findable
  "document" named `lightrag-context` — counted as a document, and offering a
  "Source d'origine" fetch that could never resolve (it is not a real file). A
  synthesized context excerpt is now shown under its own **Context** section: labeled
  clearly, never attachable, and not counted as a document; real source documents stay
  findable + attachable. The reply whose only provenance is context still shows the
  Sources chip. The companion fix that makes the *real* LightRAG source documents
  reappear (instead of only the opaque blob) ships in the openclaw-knowledge plugin
  3.2.10+. *Deploy: `npx convex deploy` + rebuild the frontend AND bridge images.*
- **A published, versioned provenance contract — any plugin can surface its sources in
  Atrium.** What a context-injecting OpenClaw plugin emits (provenance/v1) is now an
  explicit JSON Schema with one shared classification rule, so a third-party plugin
  author can conform to it and it can no longer silently drift from what the UI and the
  server accept. A new endpoint serves the registered schemas — `GET /api/v1/schemas`
  (list) and `GET /api/v1/schemas/<id>` (one) — **public and cacheable**, like public
  API docs; the same is surfaced by the MCP tools `list_schemas` / `get_schema` and the
  CLI `atrium schemas` / `atrium schema --id provenance.v1`. The registry is extensible:
  publishing a future contract schema is one entry. *Deploy: `npx convex deploy` +
  republish the MCP package.*
- **An uploaded charte logo is auto-trimmed and split into light/dark variants.** Logo
  processing now trims surrounding transparency and derives the light- vs dark-mode
  variant from the image itself, so a custom chart's brand logo renders correctly on its
  avatar tile in both page modes. *Frontend-only.*
- **Notifications show when each was submitted.** The notification bell now displays the
  submission timestamp. *Frontend-only.*

## [0.9.1] — Correct avatar logo for dark-primary charts; lighter agent resolution at scale

Corrective release. No breaking changes, no schema migration.

- **The chat avatar now shows the right logo variant for a custom charte's colors.**
  The avatar tile paints the brand logo on the chart's *primary* color — not the page
  background — so a charte whose primary is dark (e.g. a terracotta brand) shown while
  the app is in light mode displayed the light-background logo on a dark tile (and the
  reverse in dark mode). The logo variant now follows the primary color's own polarity
  (read from the chart's primary / primary-foreground tokens), so it always matches the
  tile, in every page mode. Only affects custom charts with an uploaded logo — the
  default Atrium mark is unchanged. Frontend-only: rebuild the frontend image.
- **Resolving a groupless user's agents stays within the backend's limits on a large
  catalogue.** For a user in no group with no per-user selection, the effective set is
  "every discovered agent", and that pool was read from the database *twice* per
  resolution — once to list the agents, once to load their display details — on the chat
  list, the header chip, and the agent picker. On a deployment with a very large agent
  catalogue (thousands of agents) that double read could exceed Convex's per-query
  document limit and fail those views; it also doubled the read cost at every size. The
  pool is now read once and reused (and a redundant default-election scan was removed),
  which roughly doubles the headroom before the limit and halves the read work per
  resolution. Convex-only: `npx convex deploy` applies it without rebuilding any image.
  (Most deployments are nowhere near this size — discovered agents are few — but the fix
  is cheap and removes the cliff.)

## [0.9.0] — Streaming a reply no longer re-renders the whole conversation per token

Performance release. No breaking change. Adds a `streamingText` table — a plain
`npx convex deploy` applies it; there is no manual migration, and replies already
streaming across the deploy are handled gracefully (their text is preserved).

- **The live, token-by-token text of a reply now lives in its own table instead of on
  the message.** Previously every streamed token rewrote the assistant message, and the
  one heavy query that renders the open conversation (the most-recent-messages window)
  re-ran on each token — re-reading the whole window AND re-resolving a fresh signed
  download URL for every attachment in it, on every token. On a busy reply with files in
  view that was dozens to hundreds of full re-renders per turn. Now the streaming text is
  written to a dedicated row that the heavy query does not read, so it re-runs only when
  the message set actually changes (turn start and turn end); a tiny companion query
  carries just the live text and is the only thing that updates per token. The text you
  see is byte-identical and arrives just as live — the backend simply does far less work
  per token, which is most noticeable as smoother streaming and lower load on a
  resource-constrained self-hosted backend. This completes the streaming-load work begun
  in 0.8.1/0.8.2 (which cut what was *written* per frame); 0.9.0 cuts what was *re-read
  and re-rendered* per frame.
  - *Scope:* this targets latency *while a reply streams* in an open chat. It does not
    change the chat-list/sidebar query, so it is not a fix for sidebar load time.
  - *Deploy:* `npx convex deploy` + rebuild the frontend image. The bridge is unchanged.
    Let any in-flight replies finish before upgrading: a reply interrupted at the exact
    moment of the upgrade has no live-text row for the watchdog to find, so it may stay
    "thinking" and need a manual delete (any chat the per-chat reconcile is run on still
    recovers normally). New replies after the upgrade are unaffected.
  - The stuck-stream watchdog continues to recover an abandoned reply (its "still alive"
    heartbeat now follows the live-text row), so a dropped stream still self-heals.

## [0.8.2] — Lighter observability writes under load

Corrective release. No breaking changes, no schema migration.

- **No more one-trace-row-per-streaming-delta.** Each streaming frame
  (appendDelta/setSnapshot) used to write a `traceEvents` row on the ingest path —
  dozens per reply — which bloated the trace table, contended (write-conflicts) with
  the anomaly/KPI scans of that same table, and added a synchronous write to every
  frame's acknowledgment. Per-delta progress is no longer traced; the turn lifecycle
  stays observable via the start + finalize traces (status + final text length) and
  the dispatch / error / media traces. This lowers backend write pressure during a
  reply — most noticeable on a resource-constrained self-hosted backend sharing a box
  with other load. Convex-only: `npx convex deploy` applies it without rebuilding any
  image. (Diagnosed from prod telemetry: the underlying slowness was the self-hosted
  Convex backend hitting the NAS's physical limits while the box was also busy; this
  change reduces Atrium's own footprint, it does not add capacity.)
  - *Operator note:* the `openclaw.ingest` observability metric/trace volume drops
    ~10× per reply (it was dominated by per-delta rows). This is a metric-semantics
    change, not a real traffic decrease — don't read the step-down as a regression.

## [0.8.1] — Fix a "too many system operations" error; lighter streaming writes

Corrective release. No breaking changes, no schema migration.

- **Fixes a "too many system operations" error on chat pages.** Resolving a user's
  agents (the header chip, the sidebar lock state, and the new-chat picker all share
  one enrichment path) read every agent with a separate indexed query; on a deployment
  with many discovered agents that could exceed the backend's per-query budget and
  surface as "Une erreur est survenue" on a chat URL. The groupless "all agents" set —
  the one that grows with the catalogue — is now resolved in a single batched read,
  while restricted/group users keep their already-small per-grant reads. Convex-only:
  a `npx convex deploy` applies it without rebuilding any image.
- **Streaming writes less to the backend.** While a reply streams, the bridge now sends
  only the NEW text when a frame extends the previous one, instead of re-writing the
  whole message on every frame — cutting per-turn write load on the Convex backend
  (markedly lighter for agents that stream by re-sending full snapshots each frame). The
  streamed text is byte-identical and the "still alive" heartbeat is preserved; this only
  changes how the text reaches the backend, easing pressure on resource-constrained
  self-hosted deployments.

## [0.8.0] — Users list shows each member's agents at a glance

Polish release. No breaking changes, no schema migration.

- **Settings → Users now shows each member's available agents in the list.** The new
  Agents column displays the agents a user can actually reach — their cascade-resolved
  set (their groups' agents, the whole pool when they belong to no group, or their
  per-user selection) — as a compact, sortable set of chips. You can audit who can use
  what at a glance without opening each user, and it mirrors the Groups list's agents
  column so the two admin lists read the same way.
- **Per-user agent management moved into the row's actions menu.** "Manage agents" is
  now the first entry of each user's "…" menu (alongside Rename / View as / Delete),
  instead of a separate button in the row — the same pattern the Groups list already
  uses, so managing a user and managing a group now behave identically.

## [0.7.0] — Agent access by group, read-only chats, clearer tool output

Feature release. **One behavior change to know before you deploy:** how a user's
available agents are decided moved from additive to a *cascade* (below) — a user who
already had per-user agent grants may see their list narrow, and a chat bound to an
agent that is no longer theirs becomes read-only. Ships a Convex schema migration
(a new index, applied by `npx convex deploy`).

- **Agent visibility is now a cascade, scoped by group.** A user who belongs to one
  or more groups sees exactly their groups' shared agents; a user in no group sees
  every discovered agent; and a per-user selection in Settings → Users *restricts*
  within that set (select none = the whole pool, select some = exactly those).
  Previously a user's agents were the *union* of their direct grants and their
  groups'. Groups are now the way to scope which agents a member can use — e.g. per
  tenant; a member left in no group sees everything.
- **A chat bound to an agent you can no longer use is now READ-ONLY, not silently
  re-routed.** When an admin narrows your agents, a conversation pinned to a
  now-unavailable (but still-present) agent locks its composer and tells you why, and
  the sidebar marks it with a lock — instead of quietly answering from a *different*
  agent mid-conversation. A genuinely removed/deleted agent still falls back to your
  default as before. Enforced server-side on send and on regenerate.
- **Tool cards show a clear outcome instead of misleading raw JSON.** A bash/exec
  tool now renders "Done · exit 0 · 15 ms" (or a failure) plus a note that the
  gateway does not transmit the command's stdout to the chat — rather than dumping
  the `{status, exitCode, durationMs}` envelope as if it were the whole output.
  (Verified against OpenClaw 2026.6.5 and 2026.6.8 from captured frames, with a
  versioned contract test that flags a future version which DOES send the output.)
- **The per-user Access editor offers the right agents.** It now lists the user's
  pool (their groups' agents, or all agents when they have no group) to select
  within, and still surfaces any out-of-group direct grant (badged) so an admin can
  manage it.
- **"Bridge URL" is no longer mislabeled "optional".** The field routes an instance
  and falls back to the deployment `BRIDGE_URL` only for the sole / served instance;
  the label and hint now say so.
- **Agent enable/type toggles apply instantly.** Settings → Agents checkboxes use an
  optimistic update, so they no longer lag a round-trip before reflecting the change.

## [0.6.4] — MCP/CLI: per-instance health view + force-sync (admin + agent)

Convenience release. No breaking changes — additive.

- **A clear per-instance bridge/gateway health view, over the API/MCP/CLI.** New key-authed
  `bridge_status` (GET `/api/v1/bridge-status`, requires `bridge.read`; `atrium
  bridge-status` on the CLI) shows, per instance: whether a Bridge URL is configured, a
  per-instance health verdict (`ok` / `error` / `stale` / `unknown` / `no_bridge_url`,
  derived from THIS instance's own signals — never the global bridge state) plus a
  `degraded` flag, gateway version + last error, agent count + discovery freshness — the
  fast "what's wrong with my instances" check (e.g. `bridgeUrlConfigured: false` is exactly
  why a sync returns `no_bridge_url`).
- **Force a sync from the API/MCP/CLI — admin + agent only.** New `sync_instance` (POST
  `/api/v1/instances/sync`, requires `selfheal`; `atrium sync --instance NAME`) is the
  twin of the UI "Synchroniser" button: it pokes the bridge and pulls the instance's
  agents now, returning the exact outcome plus a plain-English `detail`. Gated by
  `selfheal`, which only the **admin** and **agent** service-account roles carry (never the
  read-only observer).

## [0.6.3] — "Synchroniser" tells you WHY it failed

Convenience release. No breaking changes — additive.

- **Actionable sync errors.** "Synchroniser maintenant" no longer shows a bare "Sync
  failed" you can't act on. It now names the exact cause and the fix: **no Bridge URL set
  for the instance**, **bridge unreachable**, **auth mismatch** (`BRIDGE_SHARED_SECRET` out
  of sync), **instance not served** by the bridge (its secret missing from
  `BRIDGE_INSTANCE_SECRETS`, or invalid credentials), or **`BRIDGE_SHARED_SECRET` missing
  on the Convex deployment**. The most common first-time miss — an instance with no Bridge
  URL — now says exactly that instead of a generic failure.

## [0.6.2] — Faster device onboarding: instant pairing + a "Synchroniser" button

Convenience release. No breaking changes — additive.

- **Faster pairing + a "Synchroniser maintenant" button — no waiting for the cron.**
  Setting or generating a credential now nudges the bridge to take it into account
  immediately (it resolves the instance and connects to the gateway), so the operator
  **pairing request appears within seconds** instead of on the next self-heal poll. After
  approving the pairing on the gateway, click **Synchroniser maintenant** in the
  Credentials dialog to pull the discovered agents into Atrium at once (otherwise the
  discovery cron does it within ~2 min) — finishing the instance setup without the wait.

## [0.6.1] — Generate a device identity from the UI

Convenience release. No breaking changes — additive.

- **"Generate" button for the gateway device identity.** The Credentials dialog
  (Settings → Agents → Instances) now mints the Ed25519 operator device for you: click
  **Generate** beside the device-identity field and Atrium creates the key server-side,
  stores it encrypted, and shows the `openclaw devices approve <id>` command to pair it on
  the gateway — no more running the `generate-device-identity.mjs` CLI. The private key is
  generated and kept server-side and never reaches the browser. The credential rows also
  lay out cleanly on small/mobile screens — the action buttons stay together instead of one
  wrapping onto its own line.

## [0.6.0] — One bridge, many gateways: gateway config moves to Convex

Breaking release. The bridge no longer reads its gateway URL or credentials from the
environment — they come from Convex, per a per-bridge secret. In exchange, a single
bridge can now serve several gateways/instances at once, and one gateway being down no
longer affects the others. Existing env-only deployments must migrate (steps below).

- **One bridge can serve multiple gateways.** A bridge is no longer pinned to a single
  gateway (the old "one bridge per gateway" model). List several per-bridge secrets and it
  serves several Convex instances at once — fetching each one's gateway URL, version, HTTP
  override and decrypted credentials from Convex. Running one bridge per gateway is still
  supported; it is just no longer required.
- **BREAKING: the bridge no longer reads gateway env.** `OPENCLAW_GATEWAY_URL`,
  `OPENCLAW_GATEWAY_VERSION`, `OPENCLAW_GATEWAY_HTTP_URL`, `OPENCLAW_TOKEN`,
  `OPENCLAW_DEVICE_IDENTITY` and `OPENCLAW_INSTANCE_NAME` are gone from the bridge
  environment. Each instance's gateway URL + version + HTTP override, and its operator
  token + Ed25519 device identity, are configured in Convex (Settings → Agents →
  Instances, with credentials stored AES-256-GCM-encrypted) and fetched at boot. This
  needs `ATRIUM_SECRET_KEY` on the Convex deployment to decrypt them.
- **`BRIDGE_INSTANCE_SECRETS` (per-bridge secrets list).** The bridge env takes a
  comma-separated list of per-bridge secrets, one per served instance; each is minted in
  the instance's Credentials dialog and unlocks only that instance's encrypted credentials
  (isolation preserved per secret).
- **Per-instance availability.** Each served gateway connects independently — one gateway
  being unreachable degrades only its own instance instead of the whole bridge.
- **The bridge always boots, even with an unconfigured or misconfigured instance.** A
  per-bridge secret that does not yet resolve (the instance is missing its gateway URL,
  operator token or device identity in Convex, or Convex is briefly unreachable at startup)
  no longer crash-loops the bridge. It starts anyway, serves whatever is valid, and RETRIES
  the rest — so once you finish configuring an instance in Convex it begins serving WITHOUT
  recreating the bridge. `GET /health` now lists each not-yet-served instance with the
  reason (e.g. a missing device identity), so you can see what is left to configure without
  reading container logs.
- **Breaking — env-only bridges no longer connect.** Configure each gateway in Convex:
  in Settings → Agents → Instances set its gateway URL + Bridge URL, enter the operator
  token + device identity under Credentials, and mint a per-bridge secret; set
  `ATRIUM_SECRET_KEY` on the Convex deployment; set `BRIDGE_INSTANCE_SECRETS` (the minted
  secret, or a comma-separated list for several instances) on the bridge — it reads NO
  gateway env. See `deploy/README.md`.

## [0.5.0] — UI-managed gateway credentials, mid-turn queue, document attachments & delegated groups

Feature release. No breaking changes — everything is additive and existing env-based
deployments keep working untouched. The headline: gateway credentials can now be
managed from the web UI. Alongside it, several conversation and admin features plus a
round of reliability hardening.

- **Gateway credentials from the UI (optional).** Per instance, Settings → Agents →
  Instances → Credentials now stores the operator token + Ed25519 device identity (a
  Hermes API key where applicable), **encrypted at rest** and never shown again. Mint a
  per-bridge secret there, set it as `BRIDGE_INSTANCE_SECRET` in the bridge env, blank
  out `OPENCLAW_TOKEN`/`OPENCLAW_DEVICE_IDENTITY`, and the bridge fetches its decrypted
  credentials at boot — each bridge reads only its OWN gateway's secrets, and rotating a
  stored credential takes effect on the next bridge restart. Requires `ATRIUM_SECRET_KEY`
  on the Convex deployment; leave it blank to keep the env-based flow unchanged. New
  "Gateway credentials: env vs UI-managed" guide in `deploy/README.md`, with
  `BRIDGE_INSTANCE_SECRET` wired through `.env.example`, Docker Compose and the Helm chart.
- **Send a follow-up while the assistant is still replying.** Mid-turn messages are
  queued and dispatched automatically, in order, as soon as the current turn ends — no
  waiting, and nothing you typed is lost.
- **Download the source files behind a reply.** From the Sources panel, "Joindre les
  documents" fetches the real documents a reply's sources point to and offers them as
  per-card downloads (via a documentary agent you're entitled to).
- **Cleaner default thread view.** The conversation defaults to a content-focused view;
  toggle **Outils** to reveal tool activity and the Sources panel.
- **Per-instance agent curation.** Admins enable/disable each discovered agent for an
  instance, choose the instance default, and tag agents with types (Conversational /
  Source documentaire); gateway-removed agents are marked and removable.
- **Delegated group management.** A non-admin granted `groups.manage` and set as a
  group's manager can manage that group's members, shared agents and charts; creating,
  renaming and deleting groups, and promoting managers, remain admin-only.
- **Charts by group and by domain.** Admins offer a pool of charts to a group; its
  manager selects a subset and a default; users pick from what their groups offer. A
  chart can also be the default for a host/domain, including the pre-auth login screen.
- **Reliable mid-turn ordering & cleanup.** A follow-up queued while a reply is still
  arriving now always renders — and rehydrates into the model — after that reply, never
  before it. Deleting or truncating a turn cleans up in logical order and releases any
  in-flight document fetch, so no orphaned, undispatchable messages or stuck "fetch in
  progress" locks remain.
- **Safer attachments & hidden helper chats.** An attachment too big for the gateway is
  rejected with a clear message (derived from the gateway's frame limit) instead of being
  silently dropped, and the internal document-fetch helper chat is excluded from both the
  sidebar and global search.
- **Per-instance credential isolation.** A bridge configured with the wrong instance's
  per-bridge secret refuses those credentials rather than connecting its gateway with
  another instance's token.

## [0.4.2] — Keyboard shortcuts & responsive sidebar, multi-gateway shared-fs media, and an at-rest secret cipher

Feature + operability release. No breaking changes; everything additive. Day-to-day
UI niceties (shortcuts, a sidebar that adapts to phones), shared-fs media that works
cleanly across multiple gateways with an unambiguous setup guide, and the encryption
groundwork for UI-configured gateway credentials.

- **Keyboard shortcuts, platform-aware.** Open the conversation search palette with
  **⌘K** (**Ctrl+K** on Windows/Linux) and start a new chat with **⌘⇧O**
  (**Ctrl+Shift+O**). The shortcut badge shown in the UI matches your OS automatically
  (⌘ symbols on macOS, `Ctrl+…` words elsewhere), and the new-chat shortcut works
  globally — including from Settings or with the sidebar collapsed.
- **Responsive sidebar with a mobile drawer.** The new-chat toolbar adapts to the
  available width — it shows the shortcut badge when there's room and degrades to a
  compact icon when space is tight, so it never overflows in any language. On phones
  (≤767px) the sidebar becomes an off-canvas drawer with a backdrop that closes when you
  pick a conversation, instead of squeezing the chat column.
- **The bridge's shared-fs media dirs are now keyed by instance.** A bridge serving
  instance `<I>` reads/writes `/home/node/.openclaw/media/<I>/{outbound,inbound}`,
  derived automatically from `OPENCLAW_INSTANCE_NAME`. With several gateways (one
  bridge per gateway), each bridge's mount is now distinct and self-documenting
  instead of every bridge pointing at the same flat path. The **agent-visible** path
  stays flat (`/home/node/.openclaw/media/{outbound,inbound}`) on purpose — that is
  what each gateway exposes and what its `openclaw.json` `file-transfer.allowReadPaths`
  whitelists. Existing setups are unaffected: an explicit `OPENCLAW_MEDIA_OUTBOUND_DIR`
  / `OPENCLAW_INBOUND_DIR` still wins, and with no instance name the dirs fall back to
  the flat path (the co-located dev case).
- **New setup guide: `deploy/SHARED_FS_MEDIA.md`.** A from-scratch, example-rich page:
  when to use shared-fs vs gateway-http, the four-path model (and *why* the agent path
  must stay flat), the per-instance mount convention, a worked **two-gateway** example
  with literal paths + compose, a deterministic step-by-step procedure (followable by a
  person or an AI installer), how to verify, and the gotchas (uid match, create the host
  dirs first, the agent's write-location convention).
- **Compose template + `.env.example` updated to match.** The bridge mounts are now
  instance-keyed, an inbound host-dir variable was added, and the comments spell out the
  bridge-vs-agent path split. The stale “single-gateway” note in `deploy/README.md` is
  corrected — multiple gateways are supported via a per-instance Bridge URL.
- **At-rest secret encryption (foundation, inert in this release).** Adds an AES-256-GCM
  secret cipher (Web Crypto) with a self-describing, crypto-agile envelope (so an
  external KMS — AWS KMS / Vault — can slot in later without a schema change) and optional
  context-binding. This is the groundwork for configuring gateway credentials from the
  Settings UI (encrypted in Convex) instead of bridge env vars. It is **not wired to
  anything yet** and requires **no new production config** — it ships as a tested building
  block, changing no current behavior.

## [0.4.1] — Upload progress and clean oversized-file rejection

Fix release. No breaking changes.

- **File uploads show progress and fail loudly when too large.** Attaching a file now
  displays an upload progress indicator, and a file that exceeds the gateway's inbound
  limit is rejected up front with a clear message instead of failing silently.

## [0.4.0] — Sortable & filterable admin tables, a real Connexions table, and withdrawable feedback

Feature release. No breaking changes; no data migration. Everything here is additive
and builds on 0.3.x's multi-instance / shared-fs foundation — mostly workflow and
readability improvements across Settings, plus a user-facing feedback control.

- **Sort any admin table by its columns.** The shared admin tables (Users, Instances,
  Traces, Anomalies, Integrations, Service accounts, Groups, Feedbacks…) now have
  click-to-sort headers: click to sort ascending, again for descending, a third time to
  clear. Sorting is type-aware — numbers compare numerically, versions compare as
  versions (so `2026.6.10` sorts after `2026.6.5`, not before), and empty values always
  fall to the bottom in both directions.
- **The bridge "Connexions" list is now a real table you can sort and filter.** Each
  connection is a row with sortable columns (target, state, instance, gateway host,
  gateway version, stats, last OK), a free-text filter over target/host, quick filters by
  state / instance / gateway version, and a one-click reset. The error detail of a failing
  connection is preserved as a sub-row, and each connection now shows **its own gateway
  version** (the bridge reports it per instance). The section is collapsed by default.
- **Reach a bridge instance's configuration from where you manage it.** In **Settings ›
  Agents › Bridge** the compatibility list shows one row per instance with a `⋮` menu that
  opens that instance's non-secret config in a modal; the **Settings › Agents › Instances**
  tab gained a matching "Configure bridge" row action that opens the same modal — so you
  configure an instance's media modes, caps and rehydration from either place. (Bridge
  secrets remain environment-only, never editable in the UI.)
- **Withdraw a feedback report you filed.** From the notification bell you can now close
  one of your own reports, with an optional reason — it disappears from your "My reports"
  list and stops badging the bell, and a later admin reply won't bring it back. The report
  is kept for the admin, who sees it tagged "Closed by user" with your reason. The bell now
  also shows the reported message and can jump straight to it in the conversation.
- **Deployment.** Changes the frontend (all of the above) and the Convex backend (the new
  feedback fields + the "close my report" mutation, and the per-instance gateway version on
  bridge health) — redeploy the frontend and run `npx convex deploy`. The bridge image is
  functionally unchanged; only its `.env.example` and the Compose/Helm docs were tidied —
  the per-instance media knobs introduced in 0.3.0 now live solely in Settings, so they
  were dropped from the example bridge environment (an env value still works as a fallback).

## [0.3.1] — Safer shared-fs setup: verify before save, clearer media mounts

Fix and operability release. No breaking changes; no data migration. Follows up on
0.3.0's shared-fs media with a safer Bridge config flow and much clearer deployment
docs (a single mount misconfiguration was easy to hit).

- **Verify shared-fs paths BEFORE saving.** The Bridge config editor's "verify paths"
  button now checks the media modes you've selected **in the form** — not the
  last-saved config — so you confirm the bridge can actually reach its shared
  directories before committing the change. Previously the check only ran against the
  saved config, so you had to save first and could persist a non-functional setup.
- **Clearer shared-fs media deployment (the most common misconfig).** A bridge's
  `OPENCLAW_MEDIA_OUTBOUND_DIR` is the **bridge's OWN** mount of the shared volume, not
  the gateway container's path — the two run in separate containers. Pointing it at the
  gateway path makes the bridge report `ENOENT` and silently drop every generated file.
  The `.env.example`, Compose, and Helm now spell this out, add
  `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT` (the agent's *write* view of the same volume)
  and the inbound shared-fs mount, and a new troubleshooting section walks through the
  `ENOENT` fix and the "not applicable (not shared-fs)" result.
- **Deployment.** Changes the Convex backend and the frontend (the verify-paths fix) —
  redeploy both and run `npx convex deploy`; the bridge image is functionally unchanged.
  Shared-fs media gains an optional `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT` (defaults to
  the gateway path); see the updated `deploy/` docs for the inbound/outbound mounts.

## [0.3.0] — Multi-instance gateways, large media over a shared filesystem, and reliable file delivery

Feature release. No breaking changes; no data migration. The single-gateway setup
keeps working unchanged — multi-instance, shared-fs media, and the new bridge
environment are all additive and opt-in (see Deployment).

- **Run several gateways, each on its own bridge.** Atrium can now route each chat to
  its instance's own bridge endpoint (Model M: one bridge per gateway), so adding a
  second OpenClaw — or an OpenClaw and a Hermes — no longer means one shared bridge.
  Each instance carries its own non-secret configuration (media mode, size caps,
  history rehydration, shared-fs paths) editable from **Settings › Agents › Bridge**
  and applied on the next turn **without restarting the bridge**. Bridge health is now
  reported per instance — one gateway being down no longer hides the others — and the
  Bridge tab is organized by provider. (A bridge's secrets — tokens, device identity,
  shared secrets — remain environment-only and are never editable in the UI.)
- **Send and receive large media (video, audio, big documents) over a shared
  filesystem.** In `shared-fs` mode the bridge streams a file by *reference* instead of
  inlining it, so attachments are no longer bounded by the ~25–32 MiB websocket/body
  limits: an inbound file is streamed to a mounted directory and its path is handed to
  the agent to read, and a file the agent produces is streamed back to storage. Vision
  images still ride inline (model-native). The default transport is unchanged.
- **Generated files reliably become a download.** When an agent produces a file, in
  `shared-fs` mode the bridge hosts it at the end of the turn from the shared outbound
  directory **whether or not the model emitted a `MEDIA:` line** — removing the most
  common reason a deliverable failed to appear. In `gateway-http` mode the `MEDIA:`
  directive now handles filenames **with spaces**, and an agent that writes a Markdown
  link to a local path no longer renders a link that opens the app home — non-URL
  references render as plain text. A misconfigured outbound directory now surfaces a
  warning instead of silently dropping every file.
- **Attachment size limits are enforced honestly.** The inbound attachment cap is
  derived from the gateway's actual frame limit and enforced consistently at the
  composer, in Convex, and at the bridge: a too-large file gets a clear "too large"
  message instead of being silently dropped or killing the gateway connection.
- **Per-chart brand logo.** The active chart now drives the top-bar logo and label, so
  a custom chart can show its own mark instead of the bundled Atrium one (uploaded
  logos are served as images only — no path or markup is exposed).
- **Path checks and field help for shared-fs.** The Bridge config editor gained a
  "verify paths" action that round-trips the bridge's own read/write access to the
  shared directories, plus a help tooltip on every field.
- **Multi-instance correctness hardening (review pass).** A per-instance config with
  unset fields no longer overrides a bridge's own environment defaults on every send;
  the env `BRIDGE_URL` fallback is scoped so a chat is never posted to a different
  instance's gateway; and a per-chat policy lookup is owner-scoped (no cross-user
  information).
- **Deployment.** Changes the Convex backend, the frontend, and the bridge image —
  redeploy all three together and run `npx convex deploy`. A new admin-only permission
  `bridge.config.write` gates the per-instance config editor. Multi-instance routing is
  opt-in: set `bridgeUrl` per instance (otherwise the single `BRIDGE_URL` env is used as
  before). Shared-fs media is opt-in: mount a shared directory into both the bridge and
  the gateway and set the bridge's inbound/outbound directory + agent-mount environment
  (`OPENCLAW_INBOUND_DIR`, `OPENCLAW_INBOUND_AGENT_MOUNT`,
  `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT`, `OPENCLAW_INBOUND_TTL_MS`) — point
  `OPENCLAW_MEDIA_OUTBOUND_DIR` at the bridge's OWN mount of the shared volume, not the
  gateway's container path. No data migration.

## [0.2.0] — Trace enrichment, a self-correction loop, and group management

Feature + reliability release. No breaking changes; no data migration. Trace
enrichment adds optional environment for the Opik/Langfuse integrations (see
Deployment).

- **See what an agent actually did — trace enrichment from Opik & Langfuse.** Atrium
  can now pull the *structure* of a turn's trace (span names, types, lifecycle,
  timing, the parent tree) back from a configured Opik or Langfuse and show it
  alongside its own traces — so an operator, or an agent debugging a report, sees the
  real message structure behind an anomaly. It is SOC2-safe by construction: it
  requests structure-only field groups and projects to an explicit allowlist, so no
  message text, input/output, or metadata is ever fetched. The new `get_integrations`
  reports which vendors are configured (never the keys), and `get_trace_enrichment`
  returns the structure for a turn.
- **A self-correction loop for stuck conversations.** A new `diagnose_chat` classifies
  a chat (healthy / stuck stream / dispatch error / attachment problem / bridge
  unavailable) with a suggested action, and `reconcile_chat` is the bounded
  corrective: it flips a hung "streaming" message to an error while preserving its
  text, releasing a UI that was stuck "thinking". Reconcile is gated behind a new,
  service-account-only `selfheal` permission (grantable in Settings › Roles) and is
  audited.
- **Generated-but-undelivered media is now visible.** When an agent generates an image
  natively but doesn't deliver it (no `MEDIA:`/`mediaUrls` directive), the turn used
  to finish with the image silently missing. Atrium now records a content-free
  diagnostic so the gap — the agent's missing delivery directive — is detectable
  instead of invisible. Delivering a file the documented way (write to the outbound
  dir, emit `MEDIA:`) is unchanged and works.
- **Clearer attachment and dispatch errors.** A failed send now carries a stable error
  code, and an attachment the gateway refuses for size or content shows a specific
  "file too large" / "attachment rejected" message with a hint, instead of a generic
  "an error occurred".
- **Group management — assign members and agents in bulk.** The Groups admin gained a
  Manage dialog to add or remove members and agents in bulk, with search, pagination,
  and select-all.
- **Bridge reliability hardening.** Building on 0.1.6's self-heal: one agent's error no
  longer makes *every* chat read-only (availability degrades rather than blocks, and
  recovers on its own); idle gateway sockets are reaped so a long-lived bridge can't
  exhaust file descriptors; each message's writes are isolated so one slow write can't
  wedge the others; every Convex write is bounded by a timeout; and streaming buffers
  are capped so a backpressured turn can't run the bridge out of memory.
- **Perceived performance.** The composer shows an immediate "sending…" state and a
  "this is taking longer than usual" hint on a slow turn.
- **Deployment.** Changes the Convex backend, the frontend, and the bridge image —
  redeploy all three together and run `npx convex deploy`. Trace enrichment is opt-in:
  set the vendor keys in the Convex environment (`LANGFUSE_PUBLIC_KEY` /
  `LANGFUSE_SECRET_KEY`, `OPIK_API_KEY` / `OPIK_WORKSPACE`) and, to read OpenClaw's own
  traces, `OPIK_OPENCLAW_PROJECT`; the compose env-push script now carries them. No
  data migration.

## [0.1.6] — Per-domain branding and a self-healing bridge

Feature + reliability release. No breaking changes; no data migration.

- **Brand each hostname with its own chart — sign-in screen included.** An admin can
  now map a domain (an exact `chat.acme.com` or a wildcard `*.acme.com`) to any public
  chart from Settings › Appearance. Atrium then applies that chart as the default on
  that host *before* sign-in, so a multi-domain self-host shows the right palette and
  logo on the login screen, not just after authentication. A signed-in user's own
  chart — and any chart shared through their groups — still takes precedence over the
  domain default.
- **Per-chart logo and name in the top bar.** The active chart now drives the top-bar
  brand: the bundled Atrium mark by default, or a custom name and uploaded logo
  (separate light/dark variants) for a custom chart. Logos are uploaded from
  Settings › Appearance › My charts; the server validates the image and stores it
  itself (PNG or WebP), then serves it as a plain image URL — the browser never hands
  the server a storage handle to delete.
- **The bridge survives a single error — no restart needed.** A process-level safety
  net stops one unhandled error from taking the whole bridge down, and the streaming
  loop now self-heals: if its connection machinery throws, the bridge closes and
  reconnects on the next message and finalizes any in-flight turn as aborted, instead
  of leaving that message stuck "thinking" forever. It also fails fast on boot if it
  cannot bind its port, rather than coming up half-started.
- **Deployment.** This release changes the Convex backend, the frontend, and the
  bridge image; redeploy all three together — the per-domain default couples the
  Convex backend and the frontend. No new environment variables and no data
  migration: domain mappings simply start empty.

## [0.1.5] — Sending a file no longer fails after a session roll

Corrective release (hotfix). No breaking changes; no migration.

- **Attaching a file no longer breaks the chat after a gateway/session roll.** When
  the OpenClaw session was fresh — e.g. right after a bridge restart or redeploy —
  the bridge re-sent the conversation's prior turns for context; on a turn that ALSO
  carried an attachment, that combination crashed the gateway and surfaced as "the
  chat service is momentarily unavailable (ref. bridge)". The bridge now skips that
  re-hydration on attachment turns, so file conversions and uploads go through.
  Text-only turns are unchanged and still receive the prior context.
- **New `OPENCLAW_REHYDRATION` operator kill-switch.** Set it to `off` (Compose
  `.env` or the Helm chart values) to disable session re-hydration entirely; the
  default keeps it on. Only the bridge image changes in this release — no Convex or
  frontend redeploy needed.

## [0.1.4] — File management and a refreshed sign-in

UX release. No breaking changes; no migration.

- **Outbound file links now open correctly.** A file produced by the agent opens in
  a NEW browser tab and is served with its real content type (PDFs and images render
  inline) instead of replacing the current page — a cross-origin quirk previously
  navigated the whole conversation away to the file.
- **Manage your files from Settings › Files.** Each file row now has an actions menu
  (⋮) to **download** it or **remove** it from your list — a soft delete that leaves
  the conversation where the file was exchanged untouched. A **Reset** button (top
  right of the filters) clears the active filters when any is set.
- **Refreshed sign-in screen.** A branded sign-in card with the Atrium logo and
  clearer Google / Microsoft sign-in buttons.

## [0.1.3] — Outbound files reach the chat without a shared filesystem

Corrective + capability release. Fixes agent-generated files not appearing in the
web chat. No breaking changes for new deployments; co-located shared-filesystem
setups need a one-line opt-in (below).

- **Agent-generated files now reach the chat by default — no shared filesystem.**
  The bridge fetches outbound attachments (PDFs, exports, generated documents) over
  HTTP from the gateway's `assistant-media` endpoint, so Atrium and your OpenClaw
  gateway can run on different hosts. Previously the only path was a read-only mount
  of the gateway's media directory, which silently dropped files whenever the two
  were not co-located — the production symptom this release fixes.
- **Configurable outbound-media transport (`OPENCLAW_MEDIA_MODE`).** Choose
  `gateway-http` (default, no shared disk), `shared-fs` (opt-in mount, for a
  co-located gateway), or `off`. New `OPENCLAW_GATEWAY_HTTP_URL` override (when the
  gateway's HTTP endpoint is on a different host/port) and an
  `OPENCLAW_MEDIA_FETCH_TIMEOUT_MS` connection timeout so an unresponsive gateway can
  never stall a turn. Against a gateway with no media route (pre-6.x), the bridge now
  logs a clear "switch to `shared-fs`" hint instead of failing silently.
- **Outbound-media diagnostics.** A new `openclaw.media` observability trace records
  each attachment's lifecycle — received / stored / dropped, with a structural reason
  — using codes and size buckets only, never a filename, path, or file content, so
  operators can tell *why* a file did not attach without exposing data.
- **Ambient visual effects (prototype, on by default).** Subtle, theme-tinted glows
  behind the conversation, on primary buttons, and on the sign-in screen, recolored
  from the active graphic chart. Turn them off with
  `localStorage.setItem("oc.ambiance", "off")` + reload; a proper per-user toggle
  lands once the look is finalized.
- **Self-hoster migration.** If your gateway shares a filesystem with Atrium and you
  relied on the media mount, set `OPENCLAW_MEDIA_MODE=shared-fs` (Helm:
  `bridge.media.enabled=true` sets it for you) and keep the read-only mount; the
  Compose mount is now opt-in. Everyone else needs no action — `gateway-http` is the
  default. Release notes are now curated from this changelog (see `RELEASE.md`).

## [0.1.2] — Sidebar bound, deployment hardening, automated releases

Reliability and operability release. No breaking changes; no API changes.

- **Sidebar loads reliably on large accounts.** The chat list now reads a bounded
  most-recent window (plus all pinned chats, any age) instead of every chat — fixing
  the "too many system operations" failure observed in production on heavy accounts.
  Archived chats can no longer crowd active chats out of the window.
- **Deployment hardening.** New `deploy/TROUBLESHOOTING.md` (the real first-bring-up
  footguns), a `convex-env-push.sh` helper that pushes the Convex *deployment* env,
  an auth-key generation utility (`generate-auth-keys.mjs`), and a clearer Compose
  `.env.example` / bootstrap.
- **Automated, tag-driven releases.** Pushing a `vX.Y.Z` tag now publishes
  `@lacneu/atrium` to npm (with provenance) + both Docker images, stamps the lockstep
  version across all artifacts, and creates the GitHub Release from this file — see
  `RELEASE.md`. GitHub Actions bumped off the deprecated Node 20 runtime.

## [0.1.1] — npm packaging fix

The `0.1.0` npm publish (a manual bootstrap of a brand-new scope) shipped without
the built `dist/` bundle. This release publishes `@lacneu/atrium` correctly — the
static `dist/` is included — via the automated, OIDC-based pipeline. No
application or Docker image changes: the `ghcr.io/lacneu/atrium` and
`atrium-bridge` images were already correct in `0.1.0`.

## [0.1.0] — Initial public release

First public, self-hostable release of Atrium: a multi-user web chat UI for AI
agent gateways. OpenClaw is the first supported provider (Hermes is next).

- React + Vite frontend (assistant-ui) backed by a self-hosted Convex deployment.
- Node/TypeScript bridge: operator WebSocket to an OpenClaw gateway, version-aware
  frame normalization into a stable streaming contract, validated against OpenClaw
  2026.5.19 / 2026.6.1 / 2026.6.5.
- Google / Microsoft Entra sign-in (`@convex-dev/auth`), email-domain gated;
  first sign-in from an allowed domain becomes admin.
- Multi-user / multi-agent / multi-instance routing.
- Bidirectional file exchange (inbound attachments, outbound generated media via
  Convex storage — no server paths exposed).
- Metadata-only observability: key-authed `/api/v1` + an MCP server (traces, KPIs,
  anomalies, diagnostics), never chat content.
- Full internationalization (French default, English) via Paraglide JS.
- Deployment: Docker Compose and Helm, fully environment-driven (`deploy/`).
