# Changelog

All notable, user-facing changes are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow the lockstep repo
version shared by the frontend and bridge images.

> **Release-only.** This file is updated when cutting a release, not on every PR.
> Per-change detail belongs in the PR description / commit messages; a release
> aggregates them here.

## [0.68.0] — Send while it works: queued prompts, live turn activity, calm delegated turns

Feature and reliability release. Frontend + bridge + Convex (additive schema,
zero migration); no breaking changes. Self-hosters: this release needs BOTH
the image update and `npx convex deploy` (new tool-anchor fields on message
parts and a new streaming-text index).

- **Messages sent mid-turn are visible, editable cards.** A message sent
  while the assistant is still working now stacks as a translucent card just
  above the composer (with follow-ups nesting under it) instead of vanishing
  into a silent queue: each card can be deleted, or edited — its text returns
  to the composer, sending again re-queues it — until the agent picks it up.
  Queued turns dispatch strictly one at a time, in order; the end of the
  in-flight reply stays visible above the stack, and the jump-to-latest pill
  floats above the cards.
- **The in-flight reply shows the work as it happens.** The streaming bubble
  carries an elapsed-time clock ("Working for 1 min 12 s"), a shimmering
  label naming the active tool or phase, and collapsed activity summaries
  ("Read a file, ran 2 commands and searched…") interleaved at their true
  position inside the narrative — expandable to the full tool cards, on both
  providers. Historical messages render exactly as before, and the plan
  block now follows the Tools toggle, so the clean view stays message-only.
- **Parallel prompts no longer corrupt the running turn.** The queue drain
  now waits for the gateway to release its session lock, re-checks the chat
  right before dispatch (a sub-agent report arriving mid-drain re-parks the
  message instead of killing the delivery run), and a preempted delivery is
  closed cleanly with its partial text. This fixes the bubble frozen on
  "Generating…" until the 12-minute watchdog, the follow-up stuck behind it,
  and the finished reply that re-typed itself token by token after a reload.
- **Delegated turns read calmly.** While a sub-agent works the bubble keeps a
  designed waiting pill (animated dashed ring, orbiting accent); when the
  sub-agent finishes, "the agent is writing up the reply…" holds until the
  merged answer arrives, and the final report then appears in ONE step — the
  raw draft no longer streams in and rewrites itself mid-read. If the merged
  reply never comes, the sub-agent's own result still surfaces after a grace
  window, and a failed delegation shows immediately.
- **Bridge restarts clean up after themselves.** On boot each bridge sweeps
  its own orphaned streams — turns cut by the restart finalize with their
  partial text preserved instead of spinning forever — releases the job
  locks of service chats (document fetch / summarize / curate / convert),
  and drains any queue held behind them. Bounded work per boot, with the
  12-minute watchdog unchanged as the safety net.
- **A silently empty reply now retries itself.** When the gateway closes a
  run cleanly with no content and no activity at all (seen in production:
  three long reasoning runs of one agent all settling to blank bubbles), the
  turn no longer renders an empty "complete" bubble indistinguishable from
  "nothing to say": it is classified as an actionable error and automatically
  re-dispatched — bounded, zero-content turns only, same mechanism as the
  session-conflict retry. The reply usually lands on the retry; when it
  cannot, a clear error card explains instead of silence.
- **Crash fix, present since 0.65.** Draining a queued message could crash
  the whole thread view (seen as "the page reloads" with bubbles gone)
  through the bookmark gutter; the gutter is now isolated so the thread
  never remounts.
- **The subscription gauge reads one way.** The gauge now fills with the
  REMAINING quota and says so ("57% left") — previously the bar showed usage
  while the label showed the remainder, inviting the exact opposite reading.
- **Smoother thread motion.** Auto-follow scrolling and the queued-card
  stack ease into place instead of snapping on every event (and both respect
  reduced-motion).
- **Protocol drift is now diagnosable from the observability API.** The
  compat payload (and the MCP `get_compat` tool) carries the bridge's
  protocol-contract block: vendored contract version, coverage counts, and
  the live drift — the unknown payload field names behind the Settings
  "N unknown field(s)" badge (names only, never values). The three fields a
  2026.7.1 gateway flattens onto agent events (`spawnedCwd`, `label`,
  `displayName`) are now part of the known surface, so a current install
  reports zero drift again.

## [0.67.0] — Per-bridge ingest isolation is now the only mode

Security release (phase 2 of 2 — the narrow step). Cross-gateway write
isolation is no longer configurable: it is simply how Atrium works.
**Breaking for self-hosters still on the shared ingest secret** — see the
deployment note below before updating.

- **Per-bridge authentication only.** The ingest endpoint (bridge → Convex
  writes) now accepts exclusively a per-bridge secret, resolved to exactly one
  proven instance. The legacy shared `BRIDGE_INGEST_SECRET` path and the
  `BRIDGE_INGEST_REQUIRE_PER_BRIDGE` flag are gone from the backend, the
  bridge (which no longer falls back to the shared secret on 401), Helm and
  the compose scripts — an unknown or shared secret is a permanent 401.
- **Write authorization is enforced atomically, over the whole streaming
  surface.** Every message carries a durable ownership stamp (set when its
  stream starts, surviving finalization) checked inside each mutation — not
  just at the HTTP boundary — so a concurrent rebind can never let a stale
  frame from one gateway land in another gateway's chat. This closes the
  remaining races: late finalize/append/run-id writes, and a forged sub-agent
  anchor + announce can no longer seize a message another instance produced.
- **Turn routing is validated at the source.** A turn's routed agent is
  checked against the sender's effective grants (and the agent's
  dispatchability) before it is persisted, so a forged route never becomes
  ingest authorization; historical routes are re-validated against the
  owner's CURRENT grants on every write — revoking access (directly, via
  group scope, or by disabling an instance's agents) revokes the bridge's
  write access with it, via bounded indexed reads that stay cheap on large
  agent catalogues.
- **Legacy chats self-heal.** A chat created before instance binding is
  writable only by the instance dispatch would resolve it to; the first write
  from that instance stamps the binding and drops the pre-binding provider
  session (exactly what a rebind does), so the next turn never resumes
  another agent's thread. The `stampNullInstanceChats` migration now drops
  that stale session too.

**Deployment note (self-hosters):** deploy 0.67.0 ONLY after 0.66.0 is
confirmed live — the `migrations:stampNullInstanceChats` backfill has run
(`migrations:countNullInstanceChats` reports zero derivable chats left) AND
every bridge presents a per-bridge secret. After this update a bridge still on
the shared secret gets hard 401s: there is no fallback and no flag.

## [0.66.0] — Per-bridge ingest isolation: one gateway can never write another's data

Security release (phase 1 of 2 — the widen step: fully backward-compatible,
no behavior change for existing deployments). Convex + bridge; additive
schema, zero data migration required. Self-hosters: update BOTH the bridge
image and `npx convex deploy`, in either order (the bridge self-heals across
the version skew).

- **Every bridge now proves WHICH gateway it writes for.** The ingest endpoint
  (bridge → Convex writes: streaming text, parts, sub-agent rows, session
  meta) accepts the per-bridge secret that already authenticates the
  credentials endpoint — resolving it to exactly one instance — and
  authorizes EVERY write against that instance: a chat, message or sub-agent
  row belonging to another gateway is refused (403), in both directions,
  including per-turn multi-agent routing (an instance a turn was routed to
  may keep writing even after a later turn routes elsewhere) and sub-agent
  rows resolved by global keys (checked atomically inside the mutation). The
  legacy shared `BRIDGE_INGEST_SECRET` is still accepted during the
  transition, so existing bridges keep working unchanged.
- **Deploy-order resilience.** A new bridge presenting its per-bridge secret
  to a not-yet-updated backend retries once with the shared secret — ingest
  keeps flowing whichever of the image or `npx convex deploy` ships first.
- **Opt-in hardened mode, for phase 2.** `BRIDGE_INGEST_REQUIRE_PER_BRIDGE`
  (Convex env; exposed as `bridge.ingestRequirePerBridge` in Helm and in the
  compose env scripts, default false and explicitly reconciled so a rollback
  actually disables it) retires the shared secret entirely: per-bridge only,
  and a chat with no instance binding is no longer writable by anyone. Leave
  it OFF until every bridge presents a per-bridge secret and the migration
  below reports zero unbound chats.
- **One-time migration for legacy chats.** `npx convex run
  migrations:stampNullInstanceChats` stamps chats created before instance
  binding with exactly the instance dispatch would rebind them to
  (behavior-preserving; unresolvable chats are left untouched — they cannot
  be dispatched, so nothing writes to them), and `npx convex run
  migrations:countNullInstanceChats` verifies the result. Run both before
  ever enabling the hardened mode.

## [0.65.1] — Support tooling: resolve anomalies, read feedback threads

Operability release for the observability MCP and its API — follow-up to a
production triage session. No frontend changes; no breaking changes.
Self-hosters: `npx convex deploy` activates the feedback-thread field; the
updated MCP package ships the new tool.

- **Anomalies can be resolved over MCP.** The observability MCP server gains a
  `resolve_anomaly` tool (close or acknowledge, matching the existing
  `POST /api/v1/anomalies/resolve` route) — a support agent can now clear an
  anomaly it has handled instead of leaving it open forever.
- **Feedback reports expose their reply thread.** `GET /api/v1/feedback-report`
  now includes the report's conversation thread (author role/label, text,
  time), so a support agent reads what was already answered before replying —
  previously the thread length was visible but its content was unreachable
  over the API.

## [0.65.0] — Reply to a block: "here is what I am responding to"

Feature release. Frontend + Convex (additive schema, zero migration); no
breaking changes. Self-hosters: this release needs BOTH the image update and
`npx convex deploy` (new quote fields on messages and outbox).

- **Reply to a specific block of an answer.** Hovering a paragraph of an
  assistant answer offers "Reply to this block" beside the bookmark toggle
  (both on the hovered block's own line), and a header button next to the
  agent's name replies to the whole message — the same two levels as
  bookmarks. The chosen excerpt lands in the composer as a cancellable chip,
  and the sent message shows a collapsed quote header above its bubble;
  clicking either one scrolls back to (and flashes) the quoted block, with an
  honest notice when that message is no longer loaded. The agent receives the
  excerpt framed by a preamble so it treats the instruction as targeting that
  exact passage — on both providers. The preamble is a new entry in Settings ›
  Prompt injections ("Reply to a block"): editable per instance, and disabling
  it keeps just the bare markdown quote (never a silent drop). Your stored
  message stays clean — the framing only exists on the wire. The pinned
  (detached) composer carries the staged quote too: visible, cancellable, and
  sent with the deferred send.
- **The quote follows the conversation everywhere.** Regenerated and
  auto-retried turns re-send it; forking a conversation keeps the quote
  headers anchored to the copied messages; the rebuilt history after a session
  restart and the long-history summaries re-carry the same framing (so "fix
  this" keeps its target even months later); and the Markdown/JSON downloads
  plus cross-conversation reference exports print an "In reply to" line above
  each quoted turn.

## [0.64.0] — Scheduled calendar: your crons on a month or year grid

Feature release for the Scheduled tab and user preferences, plus fixes for
the 0.62.2 regressions that shipped through 0.63.0. Frontend + Convex
(additive schema and mutations, zero migration); no breaking changes.
Self-hosters: this release needs BOTH the image update and `npx convex
deploy` (new `profiles.timezone` field and text-size values).

- **Scheduled jobs get a calendar view (month + year).** Settings › Scheduled
  gains a list/calendar toggle (persisted): the month grid shows each cron's
  occurrences at their time, the year view shows 12 mini-months with per-day
  density dots (click one to open the month), and clicking an occurrence opens
  the same edit dialog as the list. Honest by design: recurring occurrences
  are ESTIMATED from each job's schedule (cron expressions — including
  tz-suffixed ones —, "every" cadences anchored on the gateway's next run,
  one-shots); the gateway-reported next run renders as a filled dot and is
  exact, and a footnote spells the difference out. Paused jobs are never
  extrapolated. The active filters apply to the calendar too. Built as a
  source-agnostic surface: future event sources (the user's own calendar,
  Twenty CRM) can join the crons without reworking the view.
- **Preferences: your time zone and two larger text sizes.** Settings ›
  Preferences gains a default time-zone choice (searchable IANA picker, same
  component as the cron editor; "browser time zone" stays the default) — it
  prefills schedule editing today and will drive calendar displays later. The
  text-size control gains two larger steps ("Huge" 137.5%, "Giant" 150%),
  applied to the whole interface and synced across devices like the existing
  sizes.
- **Fixes (Scheduled tab, regressions since 0.62.2).** Landing directly on
  Settings › Scheduled loaded the tab WITHOUT its stylesheet (lazy-loaded tabs
  each own their CSS; this one missed the import): the time-zone picker
  rendered as a raw unbounded list with no search box, its trigger lost its
  field styling, and the action buttons had no hover treatment. All fixed —
  the time-zone popover now sizes itself to the available space (pinned
  search box on top, scrolling list below) and its list actually scrolls
  inside the edit dialog (the dialog's scroll lock was swallowing wheel
  events on the portaled popover — same fix applied to the date picker).

## [0.63.0] — Folder hierarchy: organize conversations like files, keep a clean working set

Feature release: conversations get a real folder hierarchy with a Finder-like
browsing surface, while the left sidebar becomes a curated working set instead
of a mirror of the tree. Frontend + Convex only (no gateway involvement);
additive schema, zero migration — existing folders become roots and every
existing chat stays visible.

- **Folders now nest — to any depth.** A folder can hold sub-folders and
  conversations; the only structural rule is that a folder can never be moved
  into its own subtree (refused with a message). Deleting a folder removes its
  WHOLE subtree after a typed confirmation that spells out the recursive
  folder and conversation counts.
- **Every folder has a page, with three views.** Clicking a folder in the
  sidebar opens its page: a breadcrumb, "new conversation here" (the chat is
  born filed), "new sub-folder", and a persisted view toggle — **columns**
  (Finder-style, the default: one column per level from the root, auto-scrolled
  to the current level, always-visible scrollbar + edge shadows so horizontal
  overflow is obvious), **cards** (sub-folder tiles with recursive counts and
  last activity), and **list** (an indented, collapsible tree of the whole
  subtree). Folders and conversations carry context menus in all three views
  (open, rename, new sub-folder, move, color, delete / rename, pin, move,
  sidebar toggle, delete).
- **Full drag & drop, Finder conventions.** Drop a conversation or folder
  ONTO a folder (center band) to nest it; drop BETWEEN two items to choose its
  position (neighbours part to preview the slot); drop onto a breadcrumb
  segment to move it up a level; both at once — dragging into another
  container at a precise position re-parents and places it there.
- **The sidebar is a working set, not the tree.** A root folder's section
  lists the conversations of its whole subtree, each deep row naming its
  sub-folder (the "domain") in a small tinted label. Every conversation can be
  removed from / returned to the sidebar (it stays filed and searchable;
  pinned chats always show) — the toggle is always visible on the folder
  page's rows, so a ten-conversation folder is scannable at a glance.
- **Find and situate conversations anywhere.** Global search (⌘K) shows each
  result's folder path ("Client ACME › Devis"); a folder page's search box
  filters titles instantly AND deep-searches message bodies across the whole
  subtree (results land on the exact message); the chat header gains a
  clickable breadcrumb; and a filed conversation's sidebar menu gets "Open in
  folder view", which opens its folder with the row highlighted — the fast
  answer to "where does this conversation live?".

## [0.62.2] — Scheduled tab, refined: filters, clearer status, themed pickers

Corrective release for the Scheduled (crons) tab. Pure frontend; no breaking
changes.

- **Status and result are no longer conflated.** The jobs table now has two
  separate columns: "Status" carries only the job's state (Active / Paused) and
  a new "Last result" column carries the last run's outcome — OK, Failed,
  Running, an unknown gateway status shown as-is, or "—" for a job that has
  never run. The same result badge is reused in the run-history dialog, so the
  two never disagree.
- **Filter the list, then reset it — like the other tabs.** A filter bar over
  the jobs: search by name or agent, filter by state (active / paused) and by
  last result, with a Reset button that clears everything. Filtering is
  in-memory (the jobs are already loaded) and a group that is entirely filtered
  out says so instead of showing an empty table.
- **The edit dialog now follows the graphic charter.** Its fields, selects and
  message box take the chart's borders and focus ring. The time-zone field
  became a searchable list of IANA zones (type "toronto", "paris"…) instead of
  free text, and the one-shot date/time field is now a themed calendar +
  time picker (shadcn-based) replacing the OS-rendered native control — same
  saved value, so nothing changes on the gateway side. Weekday initials in the
  calendar follow the interface language.
- **Action buttons animate on hover.** The run / pause / edit / history / delete
  icons now have a charter-tinted hover (destructive tint on delete), honoring
  reduced-motion preferences.

## [0.62.1] — Talk, tuned: per-gateway activation, voice picker, mic sensitivity

Corrective release for the realtime voice lot. Additive; one operational
change (see the migration note).

- **Activation is now per gateway instance.** Realtime voice is enabled per
  instance (Settings › Platform › Voice › Talk — one switch per instance,
  like every other voice feature), replacing 0.62.0's deployment-wide toggle.
  Hermes instances state plainly that no talk surface exists. The conversation
  control now only renders on chats whose instance is enabled — and
  appears/disappears live when the switch flips (0.62.0 showed it wherever
  the gateway version allowed, and only failed on click). **Migration:** if
  you enabled talk on 0.62.0, re-enable it per instance.
- **Pick your voice and your mic sensitivity.** The talk control is now a
  compact pill styled like the agent selector: its body starts the
  conversation, its chevron opens per-user settings — the gateway's ten
  realtime voices (marin and cedar are the recommended picks) and a
  microphone-sensitivity preset (low / medium / high, for noisy or quiet
  rooms). Choices persist per browser and ride each session; the gateway
  validates everything and keeps owning the configuration (provider, model,
  default voice, realtime API key).
- **Fixes.** Enabling the instance switch no longer fails with "Invalid
  instance config"; the composer bar stays icon-only, immune to
  locale-dependent label widths.

## [0.62.0] — Talk to your agent: realtime voice conversations

Feature release: live two-way voice conversations with an agent, straight from
the composer — and voice-triggered agent tasks that land in the conversation
like any typed turn. Additive across frontend, Convex and bridge; no breaking
changes.

- **Realtime voice conversation in the composer.** Chats whose gateway
  supports realtime voice (OpenClaw 2026.7.1+) show a conversation button:
  one click opens a live WebRTC session with the agent's voice — speak,
  interrupt it mid-sentence (native barge-in), mute, hang up. The session
  token is an ephemeral secret minted by the gateway, which holds the
  realtime provider key; this deployment never sees or stores it. The mode is
  an explicit administrator opt-in (Settings › Platform › Voice › Talk tab,
  default off) and the button only renders on gateways that advertise the
  capability — a Hermes chat simply never shows it.
- **The voice can run real agent tasks.** Ask for something that needs tools
  ("what's the weather tomorrow?") and the voice model delegates to the
  chat's agent: a real agent run starts on the conversation's session, the
  voice acknowledges ("let me check"), then speaks the actual result. Long
  tasks keep going — the voice tells you the work continues and the thread
  keeps streaming.
- **Voice-triggered turns land in the thread — identically to typed turns.**
  The turn appears the moment the task starts (in-progress indicator),
  streams live, and renders through the exact same pipeline as a typed
  prompt: tool cards with inputs/outputs, generated files, error states. One
  implementation — future improvements to turn rendering apply to voice
  turns automatically.

## [0.61.0] — A composer built for dictation

Feature release: the composer becomes a first-class dictation surface. Pure
frontend; one additive chart token (`voice`); no breaking changes.

- **The composer morphs while you dictate.** Activating the mic transforms the
  composer in place: a voice-accent ring (chart-bound `voice` token), a live
  transcript ghost showing what the engine is hearing BEFORE it commits, and a
  growth cap that expands so long dictated prompts stay fully visible — while
  the conversation above remains readable and scrollable. The caret is
  auto-followed; a long spoken pause opens a new paragraph, so dictated
  prompts arrive structured.
- **Full-page focus mode, on demand.** A composer toggle opens the same
  composer — text, attachments, dictation, everything intact — across the
  whole page for heads-down dictation of long prompts; Escape (or the toggle)
  returns to the compact form.
- **Detach the composer and keep moving.** Pin the composer — whether you're
  dictating or typing — and it lifts out into a floating panel you can drag,
  resize, edit, and dictate into. Every conversation then shows a small note in
  place of its inline composer, so it's always clear which draft is in flight
  and where it belongs. Send from the panel and you land back in the target
  conversation; "dock it back" and the draft returns inline with nothing lost.
  The draft (and any live dictation) survives navigation, stays bound to its
  origin conversation, and is stopped and purged on any identity change.
  Attachments keep the draft inline (the panel carries text only). Works out of
  the box as a large, reliable typing target for external local dictation tools
  (e.g. OpenWhispr running local Whisper).

## [0.60.3] — A turn only attaches the files it actually produced

Corrective release — cross-conversation containment of the outbound file
scan (production reports). Bridge-only; no schema changes; no breaking
changes.

- **A concurrent conversation can no longer capture another mission's
  deliverables.** The end-of-turn file scan (the safety net that attaches a
  file the agent produced but forgot to announce) matched on freshness alone
  — in the shared per-instance outbound directory, a turn running in ANOTHER
  conversation at the wrong moment attached deliverables it had nothing to do
  with, and the owning conversation looked like it never received them
  (production reports, 2026-07-14/15). The scan now requires the turn to have
  actually NAMED the file — in its tool calls, their outputs, or its reply —
  which is precisely the footprint of the legitimate rescue case. Files left
  alone are counted in the bridge log for diagnosis.

## [0.60.2] — Plan progress survives back-to-back deliveries

Corrective release for 0.60.1. One guard relaxation; no schema changes; no
breaking changes.

- **A plan advance no longer gets lost between two deliveries.** When two
  sub-agent deliveries land back to back, the second can reopen the pipeline
  bubble before the first turn's estimated plan advance is recorded — the
  write-ownership guard then dropped that advance, and the plan card fell one
  step behind for the rest of the pipeline. An advance coming from a delivery
  already merged into the very same bubble is now accepted (a replayed
  delivery after a bridge restart stays deduplicated).

## [0.60.1] — Parallel delegations stay in one bubble; the spinner tells the truth

Corrective release for 0.60.0, from field retest of a real delegated
pipeline. No schema changes; no breaking changes.

- **Parallel delegations keep the pipeline in one bubble too.** A turn that
  fans out SEVERAL sub-agents at once (parallel review gates) used to orphan
  all of them — 0.60.0's chain anchoring only held for one spawn per turn,
  and the deliveries fragmented the thread again. The chain correlation now
  survives parallel spawns (the carrier turn stays certain even when which
  child is which is not), and deliveries landing back-to-back no longer race
  each other into fresh bubbles. With the pipeline back in one bubble, the
  work plan advances all the way to done again.
- **The activity spinner tells the truth.** A sub-agent killed by the gateway
  without a terminal signal used to keep the "working" spinner and the stop
  affordance armed indefinitely — leaving no way to tell whether anything was
  still running. Its delivery now settles the child on arrival (even a silent
  one), a child silent beyond the staleness TTL stops holding the spinner
  (long-running background tasks keep theirs), and a delivered child can no
  longer be repainted as "timed out" by a late watchdog.

## [0.60.0] — Delegated pipelines: one bubble, visible work, a moving plan

Reliability and visibility release for delegated (sub-agent) work, plus a
context-gauge correctness fix. Additive schema fields only; no breaking
changes.

- **Delegated pipelines land in ONE bubble.** When an agent chains sub-agents
  (audit, then rebuild, then review…), each intermediate delivery used to open
  its own assistant bubble — one prompt could fragment into seven blocks, out
  of any functional order. Children spawned inside a delivery turn now inherit
  the original turn's anchor, so every announce of the chain merges back into
  the bubble that answered you — with full replay dedup across bridge
  restarts.
- **Continuation turns show their work.** Delivery turns (sub-agent announces,
  background-task completions) carry no regular tool frames on the wire; their
  tool calls now surface as activity cards (name + outcome) derived from the
  gateway's item stream — including the `sessions_spawn` that keeps a chain
  going. A continuation that only ran tools is no longer silently discarded
  (its plan/spawn activity used to vanish entirely), and its text-less close
  no longer paints the merged reply as "interrupted" — while a real user Stop
  or a regeneration keeps its interrupted status.
- **The work plan keeps moving during delegated work.** The full plan content
  never reaches the wire on delivery turns, so the plan card used to freeze at
  its first state ("0/4 steps" through an entire pipeline). Each plan update
  observed on a delivery turn now advances the last known plan one step — and
  settles it when the pipeline finishes cleanly — clearly labeled as estimated
  progress in the card.
- **The context gauge shows the real window fill.** On long sessions managed
  by a context engine (LCM), the gateway's session counter is cumulative —
  the gauge could read absurd values ("859% - 3194.3k/372.0k", production
  report). The bridge now stamps the actual window usage of the last turn,
  and the gauge refuses to present a cumulative counter as a fill percentage.

## [0.59.0] — Collaborative documents: edit a delivered file, hand it back

Feature release. One additive table (`documentDrafts`); no breaking changes.

- **Edit delivered text documents in place.** The right-panel viewer gains an
  "Edit" mode for text documents (markdown, txt, csv, json, logs): change the
  content directly, auto-saved as YOUR draft — the delivered file itself stays
  untouched, so the conversation history remains exact. The rendered preview
  shows your draft (clearly badged), and the original is one "discard" away.
- **Hand the edited version back to the agent.** "Use in prompt" adds your
  edited document to the composer: as a file attachment on instances that
  support them, or as a safely fenced inline block on instances that do not
  (Hermes) — the loop works on EVERY gateway, no configuration required.
- **The panel follows the document, not a frozen file.** When the agent
  delivers a new version of the same document, the open viewer offers to
  switch to it in place — edit, send back, review, repeat: the canvas-style
  collaboration loop, Atrium-shaped.

## [0.58.0] — OpenClaw 2026.7.1 (release) validated

Compatibility release. No breaking changes; no schema changes.

- **OpenClaw 2026.7.1 (release) validated.** The shipped release passed the
  full live validation suite (9/9 scenarios: streaming contracts, tools,
  plan updates, media delivery, sub-agent announce merge, async tasks, cron,
  Hermes co-run) with zero contract drift from the previously validated
  release candidate. Gateways upgrading to 2026.7.1 are fully within the
  bridge's directly validated support range.

## [0.57.0] — Cross-conversation references

Feature release. No breaking changes; no schema changes.

- **Reference a conversation inside another one.** Every chat's ⋯ menu in the
  sidebar gains "Copy conversation reference" — an env-labeled identifier
  (`dev-…`) you can paste into ANY chat's composer. The paste is recognized
  automatically and attaches the referenced conversation as a markdown export
  (title, agent, chronological transcript), so the receiving agent can read
  the full verbatim — including conversations held with an agent on another
  gateway. Resolution is owner-scoped and silent: an unknown or foreign
  reference simply pastes as plain text. Long conversations export the newest
  window and say so in the file header.

## [0.56.0] — Conversation bookmarks; deliveries return to their turn

Feature + ordering release. No breaking changes; one additive table
(`chatBookmarks`) and one additive field (`chatReads.activeBookmarkId`).

- **Conversation bookmarks (IntelliJ-style).** Hover any block of a reply and
  click the gutter flag to place a bookmark — on a whole message (user turns,
  the reply's ⋯ menu) or on ONE paragraph/section inside a long delivered
  answer. Placed bookmarks show as amber markers (rename/delete via their
  popover), a floating x/y rail + mod+shift+↑/↓ navigate the ring, and
  reopening a chat lands directly on the bookmark you last worked at (deep
  links via `?m=` keep priority). A quiet flag in the sidebar shows which
  chats hold bookmarks. Bookmarks are per-user and never leave the account.
- **Background-task deliveries merge back into THEIR turn.** When a follow-up
  (and its reply) interleaved before a background task finished, the delivery
  used to open a fresh bubble at the bottom — reading as an out-of-order
  answer. An anchored delivery now reopens its own bubble even after the
  conversation moved on; only unanchored (inferred-chain) deliveries keep the
  conservative bottom fallback.
- **The "sub-agent is working" indicator sits under its turn.** It used to
  float at the bottom of the thread, where a queued follow-up made it read as
  belonging to the waiting message; it now anchors under the bubble that owns
  the running work (bottom fallback only when the anchor is unknown).

## [0.55.4] — The activity indicator survives between chain links

Feature/bug-fix release (Convex + bridge + frontend). No breaking changes.

- **The thread's activity indicator now stays alive across a sequential
  background chain** (e.g. slide-by-slide generation). Between two links the
  next task was invisible (the gateway emits no tool frames on delivery
  runs), so the spinner died until the next delivery. The task probe now
  also DISCOVERS the chat's live registry tasks (server-side session filter
  on `tasks.list`) and adopts them as anchored engagements before their
  delivery — the indicator runs continuously and the delivery merges through
  a proper anchor instead of the read-side chain fallback. The thread's
  reconcile poll gains a grace window (4 min after the last task activity)
  so it can see the next link even while nothing is locally running.
- **Fixed: the task reconcile never ran on multi-agent per-turn chats.** The
  probe read the chat-level instance name, which a routed chat doesn't have
  — it now falls back to the newest routed message's instance.
- **Fixed: a merged chain bubble visibly blanked and re-typed its whole
  content on every link.** Each delivery merge re-streams the accumulated
  text and the markdown typewriter reveal replayed it from scratch (reported
  live: ~10 rapid flashes at the end of a 67-slide chain). Merged bubbles now
  render instantly — the smoothing stays on for ordinary streaming.

## [0.55.3] — Support access self-heals; report references visible to admins

Bug-fix release (Convex + frontend). No breaking changes.

- **Fixed: built-in API-key roles went stale until an admin happened to visit
  the Roles tab.** A permission added to a built-in role definition (e.g.
  `feedback.respond` on the `agent` role) only reached existing deployments
  when the lazy role-seed ran — until then every key minted with that role
  got 403s on the new surface. Built-in roles now self-heal at auth time
  (the checked permission set is the union of the stored row and the code
  definition — built-ins are not admin-editable by design, the seed already
  overwrites any drift).
- **Built-in roles are now explicitly read-only** (server-enforced). Editing
  one appeared to work but was silently undone by the role seed — an
  ineffective revocation. The Roles matrix now explains this and points to
  custom roles for tailored permission sets.
- **Settings ▸ Observability ▸ Feedbacks now shows each report's shareable
  reference** (the `env-id` the reporter saw at submit time, and the id the
  key-authed support API takes). Without it, an admin had no way to hand a
  report to the support agent — the reporter's submit dialog was the only
  place the reference ever appeared.

## [0.55.2] — Sequential task chains keep one bubble

Bug-fix release (Convex only). No breaking changes.

- **Fixed: sequential background-task chains (e.g. slide-by-slide image
  generation) split into one bubble per delivery.** Measured live on OpenClaw
  2026.7.1: the gateway emits NO tool frames on delivery runs, so a task
  started inside one (deliver item N, start N+1 in that same run) is invisible
  to the bridge — no engagement is ever acked for it, and every subsequent
  delivery opened a fresh bubble with no anchor (reported on dev during a
  67-slide regeneration). Delivery runs without an engagement row now resolve
  their anchor through the CHAIN itself: the newest anchored same-tool
  engagement of the chat — or the last bubble already carrying that tool's
  delivery family — receives the next link, provided that anchor is still the
  conversation's last message (everything else keeps failing closed to a
  separate bubble). The merged link's row is anchored at merge time, and rows
  born inside a delivery/announce run denormalize their inherited anchor at
  creation, so chains stay resolvable in one hop.

## [0.55.1] — Background work you can trust: async tools tracked, merged and verified

Bug-fix release (Convex + bridge + frontend). No breaking changes; the schema
changes are additive.

- **Fixed: async tools (image/video generation…) broke the one-bubble
  contract.** A turn that started a gateway background task used to end with
  a false "empty response" error, show NO indicator while the task worked,
  and deliver the result as a separate bubble — with the sub-agents spawned
  during that delivery losing their metadata anchor (reported live on dev,
  root-caused from gateway logs + frame captures). Now: the async tool's
  structured ack ({async:true, taskId}) records an ENGAGEMENT anchored to the
  requesting turn; the thread indicator runs through the whole background
  window; the delivery run (`<tool>:<taskId>:ok`) merges into the requesting
  turn's bubble exactly like sub-agent announces (same fail-closed rules,
  same replay dedup); and a sub-agent spawned inside a silent delivery run
  inherits the engagement's anchor, so ITS result merges into the right
  bubble too.
- **The gateway's task registry is now the source of truth.** While an
  engagement spins, Atrium verifies it against the gateway (`tasks.get`
  through the bridge) instead of guessing: a task whose delivery frame was
  missed (bridge restart, dropped wake) settles from the registry's verdict;
  a registry-unknown OLD task is honestly marked lost; transient probe
  failures never touch local state; and an unverifiable task expires via a
  24h safety net instead of spinning forever. Background tasks show in the
  sub-agent monitor as informational "Background task" rows — and they never
  block sending new messages (only real sub-agent sessions hold the
  composer).
- **Fixed: pausing a Hermes cron made it disappear for good.** Hermes'
  `cron.manage` list API cannot show disabled jobs, so a cron paused from the
  Scheduled tab vanished from the table with no way to re-enable it from
  Atrium (validated live against the 0.18.2 bench: the pause itself works —
  the job just becomes invisible). The pause/resume toggle is therefore no
  longer offered on Hermes jobs (delete remains); the server refuses the
  underlying update fail-closed. Ask the agent in chat to pause/resume a
  Hermes cron; OpenClaw jobs keep the full toggle.

## [0.55.0] — Scheduled jobs managed end-to-end, and the agent's work plan live in the reply

Feature release (Convex + bridge + frontend). No breaking changes; the schema
changes are additive.

- **Watch the agent's plan unfold, live.** When a model maintains a work plan
  (the `update_plan` tool of GPT-5-family runs), the reply shows a "Plan —
  x/y steps" card with a progress bar: steps flip from pending to in-progress
  to completed in real time while the turn streams, each update's short
  "what changed" note included. Always visible (even with Tools off), the
  card folds to its one-line summary once every step is done — so the user
  can judge the planned vs delivered work at a glance.

- **When the agent creates or changes a cron, the reply shows it.** A turn
  that created, updated or removed scheduled jobs now carries a dedicated
  "Scheduled jobs" section in the reply — always visible, even with Tools
  off — listing each job with its operation (Created/Updated/Removed), name
  and schedule. Clicking one opens its LIVE detail in the right panel:
  status, human-readable schedule, next run, agent, delivery mode and the
  job's prompt, plus its recent run history.
- **Act on a cron right from the chat.** The detail panel offers Run now,
  Enable/Disable, Delete (with confirmation) and a jump to Settings >
  Scheduled — so a mis-scheduled job can be fixed the second the user
  notices it. A job deleted since the message still shows its message-time
  snapshot with an honest notice.
- **Settings > Scheduled graduates from read-only to full management.** Per
  job: run now, pause/resume, delete, and an editor for the name, the
  frequency (cron expression + timezone, "every N minutes/hours/days", or a
  one-shot date) and the job's message. A per-job History dialog shows the
  latest runs with their status, result summary, duration and errors.
  Untouched fields are never resent (no silent truncation of long prompts or
  sub-minute cadences); emptied required fields are refused loudly.
- **Cron syntax, translated for humans.** Wherever a schedule shows its cron
  expression (the detail panel, the Scheduled table), a plain-language line
  now sits under it — "30 9 * * 3" also reads "every Wednesday at 09:30", in
  the user's language with locale-correct day/month names and time format.
  The raw syntax always stays; expressions beyond the common shapes simply
  show no translation rather than a wrong one.
- **Scheduled jobs one click away.** The sidebar gains a "Scheduled" shortcut
  right above Library and Settings, landing on Settings > Scheduled.
- **Honest per-provider surface, version-gated.** OpenClaw gateways get the
  full management set (verified live against 2026.7.1); Hermes offers
  pause/resume and delete (its real `cron.manage` surface). Older gateways
  that can only LIST keep the read-only tab — actions never appear where the
  gateway can't honor them. Every mutation is ownership-checked server-side
  (the job's agent must be one of the caller's entitled agents, fail-closed)
  and audited. Long prompts and names are never silently truncated by an
  edit: oversized values are refused, and a prompt beyond the editor's
  round-trip limit keeps its message editing in chat only.

## [0.54.2] — You can see the background work, and set your own text size

Bug-fix and comfort release (Convex + bridge + frontend). No breaking changes;
the schema change is additive.

- **You can now SEE that background work is happening — even with Tools off.**
  While a delegated sub-agent is still working after the reply settled, and
  again while the gateway composes each result delivery, the thread shows a
  discreet animated indicator ("A sub-agent is working in the background…" /
  "The agent is finalizing its reply…"). It is independent of the Tools
  toggle, disappears the moment real streaming starts, never lingers on a
  reopened chat, and is robust to clock skew between browser and server.
- **Sub-agents spawned during a result delivery keep their metadata.** A
  follow-up sub-agent launched while the gateway was delivering a previous
  result used to appear with almost no details; it now carries its task,
  model/provider, cleanup mode and agent id, and stays attached to the message
  that spawned it — so multi-wave deliveries (result, then a relaunched
  sub-agent, then its result) all merge into the same bubble with full
  attribution in the sub-agent monitor.
- **Pick your text size.** Preferences now offers Small / Normal / Large /
  Extra-large text. The choice scales the entire interface proportionally,
  applies instantly, follows you across devices (stored with your profile),
  and is restored before first paint — no size jump on load, including on the
  sign-in screen.

## [0.54.1] — One question, one answer: sub-agent results land in the same bubble

Bug-fix and reliability release (Convex + bridge). No breaking changes; the
schema changes are additive.

- **Fixed: a delegated task no longer produces two replies.** When an agent
  handed work to a sub-agent and finished its own turn before the sub-agent
  was done, the sub-agent's result used to arrive as a SECOND assistant
  message minutes later. The result announcement now REOPENS the original
  reply and streams into it: one bubble carries the agent's acknowledgement,
  then the real result (text and generated files), with the unread dot /
  reply sound firing when the result actually lands. Falls back to the old
  separate-bubble behaviour whenever merging would be wrong (the conversation
  moved on, the original reply failed or was stopped, or another sub-agent
  result is still streaming in).
- **Interrupted deliveries recover.** If the bridge dies mid-result, the
  gateway's redelivery resumes into the same bubble without duplicating text
  or files; a redelivery of an already-delivered result is recognized and
  ignored (no duplicate messages, parts, or storage blobs). Stopping the
  delivery with the Stop button is final — a later redelivery won't reopen it.
- **Stream writes are generation-checked.** Every bridge write (text deltas,
  snapshots, tool/media parts, phase updates, finalize) now carries the run it
  belongs to, so a late or retried write from a previous turn can never
  corrupt a reply that was since reopened for a sub-agent result — including
  the user's Stop, which only ever settles the turn it targeted.

## [0.54.0] — Folders that talk back, and your agents' schedules in one place

Feature release (Convex + bridge + frontend). No breaking changes; the schema
changes are additive.

- **Project folders got a real context menu.** The ⋯ menu on a sidebar folder
  now offers Rename (dialog), a color swatch grid, and Delete (with the
  existing chat-count confirmation) — no more dead-end folders you can't
  rename.
- **Each folder carries a subtle color of its own.** Every project gets a
  stable auto-assigned tint (overridable from the menu, 8 presets); the folder
  shows a small swatch, and when open, its conversations are tied together by
  a thin tinted rail. Deliberately low-key: it separates folders at a glance
  without pulling the eye. All hues are theme-pack variables (`--oc-accent-*`)
  and tuned for both light and dark modes.
- **A folded folder now tells you what's happening inside.** A breathing pulse
  on the folder header means a conversation inside is generating right now; a
  dot means a reply landed that you haven't read. Both aggregate the folder's
  conversations and disappear when you open it (the rows then carry their own
  signals). Individual chat rows show the same in-flight pulse.
- **Replies no longer pop folders open.** An arrival in a conversation you
  filed away leaves the folder folded (the aggregate dot/pulse carries the
  signal); only "locate me" flashes — a branch you just created — may unfold
  the section. Stale flashes now self-expire instead of firing minutes later.
- **The whole sidebar row is clickable.** Opening a conversation no longer
  requires hitting the title: the provider badge, the age label and the empty
  space all navigate too (the drag handle and the ⋯ menu stay exempt), which
  makes narrow sidebars much more forgiving.
- **New "Library" shortcut in the sidebar** — jumps straight to Settings ▸
  Personal ▸ Files.
- **New Settings ▸ Personal ▸ Scheduled tab.** A read-only listing of the
  scheduled jobs (crons) your agents run on their gateways — name, agent,
  schedule, next run and paused/active state, grouped per gateway, on both
  OpenClaw and Hermes. You only see the jobs of agents you are entitled to;
  a job with no explicit agent resolves to the gateway's own default agent
  (fail-closed when unknown). Creating or changing a job stays a chat gesture —
  the agent's cron tool call is visible right in its reply — and the tab is
  capability-gated, so gateways that can't list jobs say so honestly instead
  of erroring.
- **Sidebar busy signal is cheap by construction.** The "generating right now"
  indicator reads one per-user index range — another user's streaming tokens
  never cost your sidebar anything.
- **Folders can be reordered by drag & drop — grab them anywhere.** No grip
  needed: pick up a conversation or a folder from any point of its row (4px of
  mouse travel starts the drag, so a plain click still opens/toggles; on touch
  a long-press picks up, so swipes keep scrolling). While dragging, the other
  folders slide apart to preview the drop slot and the order persists on
  release. Dropping a chat onto a folder header files it there too; keyboard
  reordering stays available through hidden focusable handles.
- **Folder headers read left-to-right again.** The folder's color now lives in
  its chevron (one glyph instead of chevron + swatch), the name starts right
  after it with the full row width (ellipsized when long), and the reorder
  actions menu stays on the right, hover-only. Chat rows follow the same
  convention and read title-first from the left edge.
- **Sidebar resizing is smooth now.** Dragging the sidebar (or the right
  panel) edge paints the width directly per animation frame instead of
  re-rendering the whole app per pixel — the stutter is gone; the width is
  saved once on release.
- **Clearer in-flight and unread language on the rows.** A conversation being
  generated shows a thin animated bar hugging the row's right edge ("this chat
  is moving"); an unseen reply shows a softly pinging dot in the same spot.
  Both take the folder's tint (or the theme's primary), fade out on hover, and
  respect reduced-motion. The new-conversation flash now derives its color
  from the active theme/folder as well.
- **Hover and active rows are readable on every theme.** Hovering or selecting
  a conversation now switches its text to the theme's paired accent foreground
  (no more white-on-white on themes with dark accents), hover reads lighter
  than the selected row, and the default Atrium theme's row contrast was
  raised so both states are actually visible.
- **The per-row gateway badge is gone.** With per-turn agent routing a single
  conversation can span gateways, so a chat-level OpenClaw/Hermes pill no
  longer means anything — the rows (and the matching preference) were
  simplified away.
- **The Settings link got its icon** (matching the Library shortcut above it).

## [0.53.0] — Agents you can understand at a glance

Feature release (Convex + frontend). No breaking changes; the schema change is
additive.

- **Agents get an understandable directory.** Admins can now write a one-or-
  two-sentence specialty blurb per agent (Settings ▸ Instances ▸ Manage
  agents); it shows as a subtitle under the agent in both pickers (new chat +
  per-turn selector), and the picker search matches it — typing a need
  ("pptx", "convert") finds the right specialist even when its name doesn't
  contain the term.
- **Fixed: designating the document-converter agent failed with "save
  failed".** The instance-config parser was missing `converterAgentId` from
  its allowlist, so the Chat-defaults ▸ Document converter select could never
  save (a 0.45 bug). The designation now round-trips — and it stays an
  Atrium-side setting (never dispatched to the bridge).
- **A reply's contextual menu now shows how long it took.** Under the
  timestamp, settled assistant replies show "Generated in 42 s" (timer icon;
  minutes/hours formatted human-readably). Streaming turns and branch copies
  show nothing — the duration is only shown when it is real.

## [0.52.0] — Ready for OpenClaw 2026.7.1 and Hermes 0.18.2 (gpt-5.6 era)

Compatibility release (bridge + Convex). No breaking changes.

- **OpenClaw 2026.7.1 is validated ahead of its release.** The full live bench
  suite ran against the published `2026.7.1-beta.2` image — chat round-trips,
  streaming, tool turns, sub-agents, inbound vision, outbound file delivery,
  explicit compaction (with the checkpoint surfacing in the compaction-history
  API) and post-compaction continuity. The bridge compat manifest now declares
  the `2026.5.19 → 2026.7.1` supported range, so instances upgrading to the
  2026.7.1 release stay fully within validated support the day it ships.
- **The gpt-5.6 model family works end to end.** Conversations, tool turns,
  sub-agent delegation and compaction were validated on `gpt-5.6-sol`; the
  chat's Advanced panel lists the 5.6 models from live discovery and the
  per-chat model knob switches to them; the context gauge follows the larger
  5.6 window (372k). A model your subscription does not serve yet surfaces a
  clean, actionable error — never a stuck turn.
- **Version strings with a pre-release tag are now understood.** A gateway
  announcing `2026.7.1-beta.2` used to be treated as an unknown version and
  dropped to the conservative capability floor (knobs, agent files and
  session compaction switched off). Pre-release versions now order
  semver-style — below their release, above everything older — on both the
  bridge and the Convex mirror, so betas resolve their real capabilities.
- **Hermes 0.18.2 is validated.** Send/streaming, session continuity, tool
  turns, `delegate_task` delegation, file delivery and composer uploads
  (file.attach) all re-validated live on the upgraded gateway; the manifest
  now declares `0.18.0 → 0.18.2`.
- **The vendored OpenClaw protocol contract moves to 2026.7.1.** The drift
  watch found exactly one new protocol field in the beta
  (`agent.effectiveResponseUsage`, session-config metadata) — it is now part
  of the known surface, so a 2026.7.1 install reports zero drift.

## [0.51.0] — CSV, log and JSON files get real renders in the document viewer

Feature release (frontend only). No breaking changes.

- **A CSV file opens as a real table.** In the document viewer, `.csv`/`.tsv`
  files render as a table with a sticky header and click-to-sort columns
  (numeric columns sort numerically; a third click restores file order).
  Parsing is RFC 4180-aware — quoted fields containing delimiters, doubled
  quotes and even newlines stay in one cell — and the delimiter is
  auto-detected (comma, semicolon or tab, so French-style `;` CSVs just work;
  a `.tsv` always splits on tabs). Very large files show the first 1 000 rows
  and 100 columns with honest "N of M" banners instead of freezing the panel.
- **A log file opens colorized.** `.log` files tint each line by severity —
  errors red, warnings amber, debug/trace dimmed — so scanning a long log for
  the failure takes a glance, not a search. Lines without a level marker stay
  neutral (`errors_total=0` is not an error).
- **A JSON file opens as a collapsible tree.** Keys bold, values colored by
  type, small nodes pre-expanded and deeper/large nodes loading lazily on
  expand (with a hard per-node cap and an explicit "+N more" line) — a large
  payload can't freeze the panel. 64-bit integer ids are displayed losslessly
  instead of silently rounded. Invalid (or preview-truncated) JSON falls back
  to the raw text with an explicit note.
- **Every rich render keeps a Raw toggle, and your choice is remembered per
  type.** The viewer's mode bar (Table/Colorized/Tree/Rendered vs Raw) now
  stores your last choice per file type on this browser: if you always want
  CSVs raw, they open raw — without affecting how markdown or JSON open.
- **The document panel can now open much wider.** Its maximum width follows
  your window (up to ~72% of it) instead of a fixed 900 px cap, so on a large
  screen you can pull the panel across most of the window to read a document
  comfortably — collapse the sidebar for even more room. The remembered width
  still re-fits automatically when the window shrinks.
- **Fixed: rows no longer peek above the pinned CSV header while scrolling** (a
  Chrome sticky-positioning quirk with collapsed table borders and padded
  scroll areas).

## [0.50.0] — The bridge status tells the whole truth

Feature release (frontend + Convex). No breaking changes.

- **The Bridge panel no longer says "operational" while your gateways are
  down.** During a gateway backup or maintenance, the bridge process is fine
  but its gateways stop answering — chats correctly showed the
  gateway-unreachable banner, yet Settings → Bridge kept a green "Bridge
  operational" header. The header (and the tab's status dot) now have a third,
  amber state: "Bridge reachable · N instance(s) unreachable", naming the
  affected instances and explaining that their conversations pause and resume
  automatically once the gateway (or that instance's dedicated bridge) is
  back. Red still means the bridge itself is down or erroring. The amber state
  reads the same per-instance signal that pauses the affected composers, only
  counts instances the discovery poll actually targets, and tolerates
  duplicate instance rows.

## [0.49.0] — Agent proposals land in Atrium; the app learns to tap you on the shoulder

Feature release (Convex + frontend + MCP). No breaking changes; the schema is
additive and the new MCP parameter is optional.

- **An agent's improvement proposal is now readable in Atrium — no more SSH to
  the gateway host.** `report_anomaly` (API + MCP) accepts optional
  `attachments` (up to 4 documents, 48k chars each — out-of-bounds is an
  explicit 400, never a silent truncation). The Anomalies tab shows a "Read
  the proposal" button that opens the full text in a dialog. The content is
  stored in its own child table and fetched on demand, so anomaly lists and
  scans stay light no matter how many proposals accumulate; the anomaly row
  itself carries only name + size.
- **Admins are notified the moment a user files a report.** A submitted
  feedback report now fans out a bell notification (with badge) to every
  admin, deep-linking to the Feedbacks tab — reference and category only,
  never the user's free-text comment.
- **Notification sounds and system notifications, per user (new "Notifications"
  preference group, all opt-in).** A synthesized Atrium sound signature plays
  on a new bell notification; a browser system notification can fire when the
  tab is in the background (enabling it triggers the browser permission
  prompt); and a discreet blip can mark a reply finishing in one of your
  conversations. Arrival detection is identity-based and baselined, so a page
  reload or an impersonation switch never replays old notifications.
- **Run several conversations at once.** When a reply finishes in a chat you
  are not looking at, its sidebar row flashes briefly and keeps a subtle dot
  until you open it; switching to the chat (or returning to the tab) clears
  it. A reply landing in a hidden tab keeps its unread state until you
  actually come back. Per-user read-state lives in its own table and query, so
  the hot chat-list query gains no extra reads; unread dots appear quietly as
  chats are visited (no wall of stale dots on upgrade).
- **Pick your text size.** Settings → Preferences gains a "Text size" control
  (Small / Normal / Large / Extra large) that scales the whole interface for
  reading comfort. The choice applies instantly, follows you across devices
  (stored on your profile, like the theme), and is cached locally so pages —
  including the sign-in screen — render at your size from the first paint.

## [0.48.0] — Files you can actually grab, markdown you can actually read

Feature + fix release (frontend + Convex + deploy docs). No breaking changes;
additive only.

- **Fixed: "show raw source" no longer reads "(no text)" on delegated
  replies.** When an agent delegates and the visible answer is the
  sub-agent's result, the raw-source view now shows that exact text (labeled
  as the sub-agent's raw result) instead of claiming the message is empty.
- **Fixed: the reply's ⋯ menu stays open on earlier messages.** On any message
  except the last one, opening the new contextual menu closed it again
  instantly (the hover-revealed action bar unmounted underneath it). The menu
  now holds the action bar visible while open.
- **File chips download again — with an explicit preview arrow.** Clicking a
  delivered file (its name or the new download icon) downloads it for real —
  including cross-origin storage files that used to just open in a tab — while
  modified clicks (Ctrl/Cmd/middle) keep their native link behavior. Files the
  right panel can display get an extra arrow at the far right that opens the
  preview. Routing every viewable file into the viewer had made the file
  itself hard to reach (live report: a delivered 22MB PPTX the user could not
  save).
- **Markdown files preview fully rendered.** Opening a `.md` file in the right
  panel now shows the interpreted document (the same rendering as chat
  replies), even when it was delivered with a generic text mime; a
  Rendered/Raw toggle at the top switches to the exact source.
- **API keys and feedback references now name their environment.** A minted
  observability key reads `oc_<env>_…` (e.g. `oc_prod_…`) and a feedback
  reference reads `<env>-<id>`, both from the deployment's `ATRIUM_ENV_LABEL`
  — the same unambiguous construction as a Convex deploy key, so a pasted
  identifier always tells you which environment it belongs to. Operators: set
  `ATRIUM_ENV_LABEL` (e.g. `dev` / `prod`) on each Convex deployment (the
  compose/Helm bootstrap scripts push it from your `.env`/values; blank leaves
  a previously set label unchanged — remove with
  `npx convex env remove ATRIUM_ENV_LABEL`). Unlabeled deployments keep the
  legacy shapes.

## [0.47.0] — Branching flows like ChatGPT

Feature release (frontend + Convex). No breaking changes.

- **Branching now lives in the reply's ⋯ menu, asks for a name, and keeps you
  where you are.** The branch action moved from a standalone icon into a new
  "More actions" contextual menu on each assistant reply. Picking it opens a
  small dialog asking for the new conversation's name (blank keeps the current
  title); on confirm the branch is created WITHOUT leaving the current chat —
  the new row pulses briefly at the top of the left panel so your eye catches
  exactly where it landed (its section auto-expands if folded), and a toast
  confirms it (useful when the sidebar is collapsed). Click the row whenever
  you want to continue the tangent; reduced-motion setups get a static
  highlight instead of the pulse.
- **The ⋯ menu sits at the end of the action row and carries more context.**
  Like ChatGPT: the menu opens with the message's date and time as a quiet
  header, and the "show raw source" toggle moved off the action bar into the
  menu. On a branched conversation, copied messages show their ORIGINAL time,
  not the copy time.

## [0.46.0] — Branch a conversation into a new chat

Feature release (frontend + Convex + bridge). No breaking changes; additive
schema only.

- **Branch from any reply into a new chat.** A new action on every assistant
  message forks the conversation: the new chat opens instantly with the same
  history up to that point (messages and their file attachments — no duplicated
  storage), so you can dig into a tangent while the original conversation
  continues untouched. The branched chat keeps the same agent, title and
  project; on your first message there, the agent is re-grounded with the
  carried history through the existing rehydration engine (rolling summary
  included when applicable) — on OpenClaw and Hermes alike. History carried is
  bounded to the visible window (the newest 200 messages before the branch
  point); a branch never includes anything said after it.
- **A branch is a full continuation, not a bare transcript copy.** The fork
  also carries your per-chat model/reasoning settings, the per-message agent
  attribution and last-used agent of a multi-agent conversation, delegated
  sub-agent result cards (display-only in the branch), and pasted-file
  visibility — and it lands at the top of the chat list like any new chat.
  Branching is refused on a reply still being written; operator rehydration
  kill-switches keep working (a branch never overrides them).
- **Hermes agents now recover their conversation on a fresh session.** When a
  Hermes chat opens a brand-new server session — a branched chat's first
  message, or an auto-recovery after the stored session vanished — the prompt
  now carries the conversation history (both transports), so the agent
  continues instead of starting cold. Session ids are persisted only once the
  gateway actually accepted the prompt, so a failed first send retries cleanly.

## [0.45.1] — Delegating turns no longer look like failures

Corrective release. Bridge only; no breaking changes.

- **A turn that hands off to a sub-agent is no longer shown as an error.** When
  an agent does its work and then calls `sessions_yield` to let a sub-agent
  finish and answer (the real reply then arrives as a separate follow-up
  message), the handing-off turn produces no text of its own — and was being
  flagged as an "empty response" error card, even though the conversation
  succeeded. An explicit yield is now recognized as a deliberate hand-off, so
  that turn finalizes cleanly. This also stops such turns from inflating the
  failure count in the Bridge connections stats (live prod, 2026-07-10).

- **The Bridge tab no longer flags a false "unknown protocol fields" warning.**
  The OpenClaw 2026.6.11 gateway stamps five sub-agent metadata fields onto its
  agent events (a child's role and control scope, its parent session key, its
  runtime, and the parent's child-session list). These are benign, additive
  fields the bridge already passed through untouched, but the protocol-drift
  detector had not yet learned them — so Settings ▸ Platform showed a red
  "5 unknown fields" badge. They are now part of the recognized 2026.6.11
  protocol surface, so a validated install reports zero drift again. Metadata
  field names only — no conversation content is ever inspected.

## [0.45.0] — Read documents in a side panel, without leaving the conversation

Feature release (frontend + Convex). No breaking changes; additive schema only.

- **A document viewer in the right panel.** Click a file in a conversation and it
  opens in a resizable side panel — the conversation stays live on the left, so
  you can read a report and keep chatting. PDFs render page-by-page with a
  thumbnail rail, pager and zoom (via an in-browser PDF engine, loaded on demand
  so it never slows startup); images, audio, video and text/code files render in
  place too. Works for files you send AND files an agent produces, on both
  OpenClaw and Hermes.

- **Office files (PowerPoint, Word, Excel) render as PDF — through your own
  agent.** When you open a .pptx/.docx/.xlsx, Atrium asks the instance's
  designated converter agent to turn it into a faithful PDF (using that agent's
  own skills — Atrium embeds no conversion software), then shows it in the same
  viewer. The result is cached, so it converts once and opens instantly after.
  Conversion is opt-in per instance: an admin designates the converter agent in
  Settings ▸ Platform (none = Office files stay download-only). If a conversion
  can't be produced, the panel falls back to a download link — never a dead
  spinner (a timeout and a per-user queue keep it honest even when several files
  are opened at once).

## [0.44.2] — Turns that heal themselves, alerts that catch real incidents

Stabilization release for the newly opened platform (frontend + Convex +
bridge). One additive schema field; no breaking changes.

- **A transient gateway session conflict no longer kills the turn.** An OpenClaw
  gateway can reject a message with "reply session initialization conflicted" —
  a short-lived internal race (e.g. while it flushes the previous turn's memory)
  that the gateway's own channels simply retry. Atrium now does the same: when a
  turn fails this way *before producing anything*, it is retried automatically
  (up to twice, ~5s then ~15s — the same delete-and-regenerate a user would do by
  hand, so the gateway session is cleanly reset first). The retry stands down the
  moment you move on (a new message, a delete, a manual regenerate) and never
  runs for the internal utility chats. If the conflict persists, the error card
  stays — now with a clear explanation and a "resend your message" hint instead
  of a raw gateway error (live incident, 2026-07-09).

- **Failed turns now count as failures in the Bridge connections stats.** The
  Settings ▸ Bridge connections table counted only transport-level send
  failures, so a user with two errored turns still read "0 échec(s)". Turn-level
  failures (a run that errors after its send was accepted) are now recorded
  against their connection — without affecting availability or the anti-deadlock
  health semantics — and the "échec(s)" figure includes every failure class.

- **The stream-errors detector now catches what real users actually hit.** A
  real user's two consecutive errored turns sat exactly under the old alert
  threshold of 3, so the admin was never notified of the platform's first real
  incident. Real errors now alert from 2; user Stops (aborted turns) no longer
  count toward the alert at all — pressing Stop is a choice, not a failure —
  though a mass-interrupt burst still raises a critical. The anomaly also now
  carries a sample correlation id, so the admin can jump straight from the
  notification to the failing turn in Traces.

- **Old trace windows are no longer silently empty.** Querying Traces (UI or
  API) with a from/to window only searched the newest ~500 events of the whole
  table, so investigating an incident more than a few hours old returned
  nothing — misleadingly. Windowed queries now range the time index directly:
  any window in the 14-day retention is addressable.

- **File readers now see every file of their agents — MEMORY.md and USER.md
  included.** A user granted the agent-files permission previously saw only the
  four rules files (AGENTS/SOUL/IDENTITY/TOOLS.md); memory-class files were
  hidden even in read, which blocked the legitimate "did my agent actually
  memorize my instructions?" check on a personal agent. The visibility model is
  now grant-aligned: a non-admin reads **all** files, but **only** for agents
  they already have chat access to — someone who can talk to an agent can ask it
  to print any of its files anyway, so the old depth filter protected nothing,
  while reading files of agents you *cannot* talk to stays forbidden. Writes are
  unchanged (admin-only, audited).

## [0.44.1] — No more heartbeat jitter on Safari and iOS

Corrective release. Frontend only; no breaking changes.

- **The whole page no longer trembles on Safari and iOS.** With the ambient
  effects on (the default), the brand "heartbeat" pulse drove a page-wide rhythm
  that WebKit — macOS Safari and *every* iOS browser (Chrome, Firefox and Edge on
  iOS are all WebKit) — mis-handled: it re-laid-out the whole document on each
  beat, so the left sidebar, the top bar and nearly everything jittered by a few
  pixels in time with the pulse. On those browsers the ambient beat is now frozen
  — the same fallback already used for the "reduce motion" accessibility setting —
  so the glows stay, just static, and the layout is rock-steady. Other browsers
  are unaffected and keep the animated ambience. (If you ever want the ambience
  off entirely, `localStorage.setItem("oc.ambiance","off")` then reload.)

## [0.44.0] — Disabled agents stay disabled, and a down instance says so

Reliability and access-control release. A one-time, self-healing data backfill
runs on first deploy (see below); no breaking changes.

- **A disabled agent is now unusable everywhere.** Disabling an agent for an
  instance (Platform ▸ Agents) previously only hid it from the picker — it could
  still be added to a group or granted to a user, and a group that carried it
  kept routing to it. A disabled agent is now blocked across the whole app: it
  can't be routed to, can't be added to a group, can't be granted to a user, and
  is shown greyed (not selectable) in the group and per-user access editors. An
  agent that was already the group/user default and then gets disabled stops
  being offered as a target. Enforcement is opt-in strict: an agent counts as
  usable only once explicitly enabled, so a newly discovered agent arrives
  disabled and an admin turns it on (Platform ▸ Agents) before anyone can use it.

- **Safe rollout for existing installs.** So the new rule never hides agents that
  predate it, a one-time background backfill stamps every already-discovered
  agent as enabled on first deploy; strict enforcement switches on only once that
  backfill has completed. The rollout is windowless and self-healing — agents
  stay visible throughout — and agents discovered during the rollout are handled
  correctly. Nothing for an operator to run.

- **A chat tells you when its instance is unreachable.** When one instance's
  gateway goes down — a backup, a restart, a network cut — chats on that instance
  now show an "instance unreachable" banner and disable the composer, instead of
  silently accepting a message that can't be delivered. This is scoped per
  instance and per provider: some OpenClaw or Hermes instances can be down while
  others stay fully usable, and a healthy instance is never affected by a down
  one. The signal is self-healing: it clears on its own within roughly two
  minutes of the gateway coming back (the activity-independent discovery poll),
  with no user send required. A total bridge outage still blocks globally as
  before.

## [0.43.2] — Read-aloud speed, language, and the voice test

Corrective release on the voice features. Frontend + one new Convex action;
no breaking changes.

- **Reading speed now applies to the gateway voice.** The per-instance speaking
  rate was only affecting the browser voices; it now also controls playback of
  gateway-synthesized audio.

- **"Test the voice" previews what you configured.** On a gateway-engine
  instance the test button now synthesizes the sample through that instance's
  own gateway voice (at the chosen speed) instead of always using a browser
  voice — so the preview matches what listeners will hear.

- **No more dead controls on the gateway engine.** A gateway instance
  synthesizes with its own gateway-side voice, which Atrium cannot override per
  request, so the language and auto-read controls (both browser-only) are now
  hidden on a gateway-engine instance instead of shown as settings that do
  nothing. To change a gateway voice or language, configure it on the gateway.

## [0.43.0] — Toggle dictation from the keyboard

Feature release. No breaking changes.

- **A user-definable dictation shortcut.** Each user can record a keyboard
  shortcut (Settings ▸ Personal ▸ Preferences, under the voice-input toggle)
  that starts and stops composer dictation — press it while typing, dictate,
  press again. Recording is capture-based (press the combination, Escape
  cancels): it requires a real modifier (⌘/Ctrl or ⌥/Alt) so a bare letter can
  never fire mid-typing, rejects the app's built-in shortcuts (search, new
  chat), and handles macOS composed keys (⌥D, ⇧5) correctly. The shortcut is
  stored on the user's profile, follows them across devices, and shows in the
  mic button's tooltip.

- **Documentation refresh: Hermes is a supported provider.** The README,
  architecture, bridge-protocol, and configuration docs now describe the
  two-provider, capability-driven model — what each provider (and each Hermes
  transport) supports, how the UI adapts, the per-instance credential model
  (encrypted at rest, attached via per-bridge secrets), and the voice and
  sub-agent monitoring features.

## [0.42.1] — Read-aloud you can see and stop

Corrective release on 0.42.0's voice features. Frontend only; no breaking
changes.

- **You always see which message is being read.** Reading is now a chat-wide
  state: the active message's speaker button pulses and its action row stays
  visible (it no longer hides when the pointer leaves), and a floating pill
  above the composer names the state — "Synthesizing voice…" during the
  gateway round-trip, then "Now reading".

- **Stopping is always one click away.** The pill carries an ever-present Stop
  button — no more hunting for a hover-hidden action row to silence an older
  message.

- **One reading at a time, reliably.** Starting a reading on another message
  stops the current one everywhere (sound and button state); a stopped or
  superseded gateway synthesis that resolves late can no longer start playing
  on its own, and the end of an old clip can no longer erase the indicator of
  the reading you just started. Auto-read reports through the same state.

## [0.42.0] — The gateway's own voice, per instance

Feature release. No breaking changes.

- **Read-aloud can now use the GATEWAY's voice.** Each instance picks its
  read-aloud engine in Settings ▸ Platform ▸ Voice: the browser's system
  voices (default) or the gateway's own TTS (OpenClaw `tts.convert` — Edge
  free-tier, OpenAI, ElevenLabs… whatever the gateway configures). The same
  "Read aloud" button drives both: with the gateway engine, Atrium synthesizes
  on demand through the bridge (a spinner shows the round-trip) and plays the
  real provider voice. Long replies read their opening (~2,500 chars). Hermes
  instances keep the browser engine (no synthesize-and-return RPC there yet).

## [0.41.1] — Settings ergonomics: navigable sub-tabs, a clearer Preferences screen

Corrective/UX release on 0.41.0. No breaking changes, no schema change.

- **The Voice tab is organised in sub-tabs — and they are URLs.** Read-aloud,
  dictation and realtime-talk are now three segmented sub-tabs (instead of
  stacked cards), each a navigable, shareable address; the Traces sub-tools
  (latency monitoring / activity traces) became navigable URLs the same way.

- **The mic's system switch is where you look for it.** Enabling the dictation
  pipeline (the system gate that kept "Saisie vocale" greyed in Preferences)
  now sits directly in the Voice ▸ Dictation sub-tab, with the gate state shown
  as a badge — no more hunting through the Preferences admin mode.

- **Quieter saves.** Saving a voice config no longer prints a confirmation
  line: the Save button greying back out is the feedback.

- **Preferences, restructured.** One card per category, real on/off switches,
  and a badge only on the exceptions (a customised row shows "Personnalisé" +
  reset, a constrained row shows its lock) — the "default" label no longer
  repeats on every line.

- **Settings opens on your own space.** Coming from a chat, Settings now lands
  on Personal ▸ Files instead of the first tab in order.

- **Tool spinners can no longer spin forever.** A tool whose completion event
  was lost (or an intermediate phase) used to keep its loading animation hours
  after the reply landed. Three-level fix: a settled turn renders every one of
  its tools as settled, a settled sub-agent card stops animating its tool list,
  and the Hermes bridge now flushes still-open tools to "completed" on every
  turn ending (success, error, stop). The fix also covers existing history.

- **The Bridge tab splits providers into navigable sub-tabs.** OpenClaw and
  Hermes each get their own sub-tab (a shareable URL, like the Voice and Traces
  sub-tabs); the bridge status banner and the usage table stay shared above.

- **The "Agents" settings group is now "Platform".** The group holds instances,
  bridge, agent files, chat defaults, voice and prompt injections — the new
  name says what it is.

## [0.41.0] — Voice in the browser: read replies aloud, dictate your messages

Feature release. No breaking changes.

- **Voice, per instance — read-aloud and dictation.** A new Settings ▸ Agents ▸
  Voice tab configures browser text-to-speech per instance (OpenClaw and Hermes
  alike): offer read-aloud, pick the voice language and speaking rate, and
  optionally auto-read completed replies — each user keeps a personal opt-out
  preference. Every assistant reply gains a "Read aloud" button, and the
  composer's mic is now real dictation (browser speech recognition — final
  transcripts land in the composer, a pulsing icon shows the hot mic). No API
  key and no gateway dependency: the engines run in the user's browser. The
  never-wired TTS/Talk placeholders left the Integrations tab, which is
  observability-only again; realtime two-way Talk is labelled "coming".

- **Chat defaults are now read-only.** The tab displays the gateway's session
  defaults but no longer writes the gateway's global config (that write
  contradicted Atrium's observe-don't-own stance and failed on some gateways).
  The Atrium-side settings on that page (summary threshold, curation) stay
  editable.

- **A leaner chat toolbar.** The subscription-quota gauge moved into the
  Advanced popover (with a transient inline fallback on a brand-new chat), and
  Settings ▸ Bridge now presents per-instance usage as a proper table
  (instance / provider / window / remaining / reset).

- **MoA cards read as a hierarchy.** The aggregator leads, its references nest
  beneath it in order, and each card is labelled by its role (MoA aggregator /
  MoA reference) instead of "Sous-agent".

- **The Bridge tab names each provider's support line.** The Hermes card now
  reads "Hermes supporté" instead of borrowing the OpenClaw label.

## [0.40.0] — Watch Hermes delegations and Mixture-of-Agents runs, structured

Feature release. No breaking changes.

- **Hermes delegations now light up the sub-agent monitor.** When a Hermes agent
  delegates work, the same "N sous-agents" panel used for OpenClaw shows a card
  per child — its goal, model, live tool activity, then its result (or the
  failure reason) — anchored to the delegating message.

- **Mixture-of-Agents runs are visible, structured.** On a Hermes MoA turn the
  panel shows one card per reference model ("MoA 1/2 — provider:model", with
  the answer each reference proposed) plus an aggregation card that closes when
  the final reply lands — on every outcome, including errors and stops. A
  `mixture_of_agents` marker also appears in the tools list. This surfaces a
  Hermes capability OpenClaw does not have.

- **Late-finishing children are never lost.** A child that completes after its
  parent turn already answered still lands its terminal in the monitor (the
  event lane stays open a couple of minutes), so cards no longer stay "running"
  and block the next send.

- **Agent files work on Hermes.** The Agent-files tab (Settings) now lists,
  reads and edits the identity files at the Hermes agent's home (SOUL.md,
  AGENTS.md, …) through the gateway's managed-files API, with the same
  concurrent-edit protection as OpenClaw (a stale editor gets a conflict, never
  a silent overwrite) and the same budget gauge.

- **Honest wording when a feature is provider-limited.** The Chat-defaults tab
  on a Hermes instance now says the provider does not offer the feature,
  instead of blaming an "unknown gateway version".

## [0.39.1] — Long Hermes reasoning turns no longer time out

Reliability fix. No breaking changes.

- **A Hermes turn that thinks for a long time before replying is kept alive.**
  When a Hermes agent streams only its reasoning for several minutes (no reply
  text or tool calls yet), the turn now sends a watchdog heartbeat driven by
  those real gateway frames, so the stuck-stream watchdog no longer wrongly
  marks a genuinely active turn as orphaned after 12 minutes. The heartbeat
  only fires on real gateway activity, so a dead bridge is still caught as
  intended.

## [0.39.0] — Hermes turns get tools, sub-agents, compaction, attachments, and file delivery

Feature release completing the Hermes WebSocket transport. Bridge-only — no
Convex or frontend changes to deploy. No breaking changes.

- **Tool activity is now visible on Hermes turns.** The agent's tool calls
  (terminal, file writes, delegations…) surface as the same expandable
  tool-activity cards OpenClaw turns show — name and status only; arguments and
  outputs stay on the gateway.

- **Sub-agent delegations show their lifecycle.** While a Hermes agent delegates
  work, the turn shows the same "awaiting sub-agents" indicator used for
  OpenClaw, the delegation itself appears as a tool call, and the status returns
  to normal generation when the child completes.

- **Mid-turn compactions are surfaced honestly.** When the gateway summarizes
  older context during a turn, the chat shows Atrium's standard "context was
  optimized" marker and phase pill instead of an unexplained pause.

- **Attachments work on Hermes (WebSocket transport).** Files and images
  attached in the composer are staged into the agent's session workspace before
  the prompt (images as vision input), so the agent can actually read what you
  sent. The attach button appears only where uploads truly work — it stays
  hidden on the REST transport, which has no upload channel.

- **Agents can deliver generated files back to you.** A delivery instruction
  tells the agent where to write files for the user; after the turn the bridge
  picks them up through the gateway's files API (streamed, size-capped even for
  chunked downloads, honoring the admin's outbound-media setting) and attaches
  them to the reply as downloadable chips — validated live with small files, a
  5 MB binary, and a generated PNG.

- **A tool-approval prompt no longer hangs the turn.** When the gateway holds a
  command for human approval, the turn now fails immediately with a clear,
  actionable message (configure `approvals.mode: off` on the gateway, or approve
  from the Hermes dashboard) instead of streaming forever. Operator note: run
  `hermes serve` from a writable working directory (e.g. the data volume), or
  attachment staging fails with a permission error.

## [0.38.0] — Hermes Agent support: a second provider, almost entirely in the bridge

Feature release. No breaking changes; OpenClaw instances are untouched.

- **New: Atrium can serve Hermes Agent instances alongside OpenClaw.** A Hermes
  instance (Nous Research's self-hosted agent) is registered like any instance —
  provider `hermes`, its gateway URL, and its credential — and its agent appears
  through the same discovery, chat, streaming, stop, and reset paths. Hermes
  authenticates by SUBSCRIPTION (device token), like OpenClaw, not a metered
  API key.

- **Two Hermes transports, selectable per instance — WebSocket by default.**
  The recommended WebSocket transport (Hermes's JSON-RPC gateway) brings richer
  streaming (a separate reasoning stream that never pollutes the reply),
  per-turn usage and context pressure feeding Atrium's gauge natively, clean
  server-side interrupts, and resumable sessions; its headless auth flow
  (password login → single-use ticket per connection) works against a hardened
  public bind. The REST transport (OpenAI-compatible API server) remains
  available as an option.

- **The UI adapts to Hermes automatically, with no per-provider code.** Because
  Hermes advertises only the capabilities it truly has (a real Stop, agent
  discovery), every OpenClaw-specific control gates itself OFF on a Hermes chat:
  the reasoning/model knobs, the chat-defaults admin tab, sub-agent monitoring,
  and the attachment button all disappear — driven entirely by the capability
  manifest the multi-provider design already had.

- **Robust turn lifecycle for Hermes's per-turn streaming transport.** Unlike
  OpenClaw's persistent socket, each Hermes turn is one streaming HTTP request.
  The bridge handles it end to end: reply-on-acceptance (so a queued follow-up
  waits), lazy session creation reused for continuity, a real server-side Stop,
  reset/regenerate that starts a fresh session, auto-recovery when a stored
  session has vanished, and actionable errors (auth, unreachable, no-response)
  instead of silent failures.

- **Almost everything lives in the bridge.** The only changes outside it are a
  few small hooks a provider genuinely needs from the backend (persisting the
  Hermes-minted session/run ids for continuity, reset, and stop targeting) and
  the attachment-button capability gate — proof the multi-provider foundation
  laid earlier held. A NAS install + OpenClaw-config-migration guide ships in the
  operator docs.

## [0.37.1] — Corrective: brand-colored paste shimmer, attachment preview, and a conversation loading skeleton

Corrective follow-up to 0.37.0's paste flow. No breaking changes.

- **The paste-confirmation shimmer now uses the active brand theme's color.** 0.37.0
  shipped it with a hardcoded accent that ignored the deployment's charte graphique; the
  flash now derives from the theme's primary token, so it matches every brand.

- **Verify an attachment before sending it.** Every pending text or image attachment chip
  gains an eye button opening the content full-size in a dialog — scrollable text
  (bounded for very large files, with an explicit "preview truncated" note), full image
  view. Completes the silent-paste flow: paste, see the chip flash, check its content,
  send. The preview guards against chip-reuse races (multi-attachment edits never show
  another file's content) and stays reachable on image thumbnails.

- **Opening a content-heavy conversation shows a loading skeleton.** A chat with a large
  history takes a few seconds to arrive in the browser and used to render as an EMPTY
  thread meanwhile ("is anything happening?"). Ghost message bubbles now shimmer in the
  brand color until the conversation lands (static under reduced-motion; announced to
  screen readers).

## [0.37.0] — Search lands on the exact message, quieter paste, resettable chat defaults

UX and operability release. No breaking changes.

- **Global search now lands on the exact matched message.** Selecting a message hit
  opens the conversation scrolled to that message with a highlight flash, and the exact
  searched words are marked inside it (CSS Custom Highlight API — degrades gracefully on
  older browsers). Search terms never enter the URL (they can be sensitive): they ride an
  ephemeral in-memory hand-off, so history and copied links stay clean.

- **Pasting a large text is confirmed by the attachment itself.** The "converted to
  attachment" toast is gone: the new chip shimmers briefly when it appears — you SEE the
  paste become the file. Screen-reader users keep a spoken confirmation (invisible live
  region), and a genuine attach failure still shows an error.

- **Chat defaults can be reset, and failures explain themselves.** Settings › Chat
  defaults gains a "Reset" button that removes the reasoning/speed defaults from the
  gateway config (its original behavior applies again). When a save fails, the error now
  carries the bridge's actual failure code (e.g. gateway disconnected/timeout) instead of
  a bare "Server Error" — this also improves every other admin error toast.

- **The protocol panel no longer flags config-dependent fields.** Two same-version
  gateways could show different "unknown field" counts: a gateway with chat defaults set
  stamps `thinkingLevel`/`fastMode` onto its frames (and spawn parameters appear on
  sub-agent frames). These are now recognized as documented wire metadata — the drift
  detector stays reserved for REAL protocol changes.

## [0.36.0] — Subscription quota, visible: a usage gauge in the chat and per-instance windows for admins

Transparency release. No breaking changes.

- **New: users can see the provider plan's remaining quota.** The chat header shows a
  compact gauge with the most constrained rate window of the instance the NEXT message
  will use (multi-agent chats follow the composer's selected agent, with per-option
  authorization), colored like the context meter and detailed per window on hover.
  The data is the gateway's own usage snapshot (the same numbers as its Control UI),
  captured content-free by the bridge during the existing discovery poll — no extra
  connections. A user preference ("Subscription usage gauge", ON by default,
  admin-overridable) controls it; admins additionally get every instance's quota
  windows in Settings › Bridge. This is what turns a raw "API rate limit reached"
  failure into something a user can anticipate.

- **The context-optimization marker explains itself instantly.** Its explanation used
  the browser's native tooltip, whose OS-imposed delay made it look absent; it now
  opens in ~150 ms like the other status tooltips.

## [0.35.0] — Delegation-aware turns: no false errors on sub-agent work, live phase detail, self-describing report references

Follow-up to 0.34.0's reliability work, driven by live stress-testing on two
environments. One corrective, two features; no breaking changes.

- **A turn that delegates to sub-agents is no longer painted as an error.** 0.34.0's
  empty-response guard misfired on the "announce" pattern — a parent agent that spawns
  sub-agents, ends its own turn silently, and replies later in a spontaneous turn (seen
  live on both test environments within hours). The guard now recognizes a parent whose
  own spawned children were observed working (correlated by exact child session key, with
  a tolerant fallback for gateways that omit it) and keeps the calm explanatory row
  instead of a red error card. The real reply still lands as its own turn.

- **New: the "processing" placeholder tells you what the agent is actually doing.** With
  the Tools view enabled, a silent in-flight turn now shows its live phase — catching up
  on conversation history, optimizing the context (compaction), waiting on delegated
  sub-agents, or the bridge actively checking a silent agent's status — instead of a
  generic "thinking". Phases that prove real agent activity also refresh the stuck-stream
  watchdog, so a legitimately long-working agent isn't reaped mid-task.

- **New: feedback references identify their deployment.** The reference a reporter
  copies now encodes the environment (e.g. `dev-…`, `prod-…`, via the ATRIUM_ENV_LABEL
  deployment variable) — support no longer guesses which deployment a report came from.
  Reports also carry the instance and agent that produced the reported turn, frozen at
  submit time so rerouting or deleting the chat never falsifies the evidence. All report
  APIs accept both the tagged and the bare form.

## [0.34.0] — A silent agent no longer loses its answer: turns self-heal by asking the gateway

Reliability release, closing the launch-blocking "blank bubble" class observed while
stress-testing: an agent that reasons silently for minutes had its turn closed empty,
and the real answer — still being produced gateway-side — was discarded. No breaking
changes.

- **Long-thinking turns now survive and deliver.** When an agent goes silent past the
  in-turn budget (raised 180 s → 240 s), Atrium no longer force-closes the turn: it keeps
  it open and actively queries the gateway for the run's real status, so the answer lands
  whenever it completes — whether it arrives over the live stream or has to be recovered
  from the gateway's transcript (e.g. after a connection blip that swallowed the final).
  Live-validated: a 7-minute mostly-silent turn now delivers its full 45k-character
  answer where it previously produced an empty bubble.

- **The recovery can never corrupt a conversation.** The status query is bound to its
  exact turn (a stale poll self-cancels when a new turn starts), cancels itself the
  moment the live stream resumes, only accepts a recovered answer once it is proven
  complete (stable across two consecutive polls), never substitutes a previous turn's
  reply for an unanchored one, and a real connection loss supersedes it with the
  dedicated socket-drop recovery. Its budget stays under the stuck-stream watchdog, so
  the two safety nets can no longer race each other.

- **No more silent blank bubbles, ever.** If a turn genuinely ends with nothing usable —
  no text, no delivered file — while the agent did work (tool calls, an attempted or
  failed file delivery, an undelivered generated image), it now shows an actionable
  error instead of an empty "completed" message, with guidance to retry, rephrase, or
  curate an over-eager agent's files. If the gateway never answers within the recovery
  window, the turn settles as a distinct, explained "response timeout" instead of a
  generic failure.

- **Operators can now see exactly why any turn ended.** Every turn's closing cause
  (real gateway terminal, silence, compaction timeout, abort, upstream error…) is
  recorded in the content-free pressure trace, turning "why is this bubble empty?"
  from guesswork into a one-lookup diagnosis.

## [0.33.0] — Atrium goes fully multi-language: user-language UI everywhere, per-instance content language

Internationalization release, preparing the arrival of many more languages. No breaking
changes: schema changes are additive, and existing notifications/error rows render as before.

- **Every piece of UI text now follows the user's language.** The last ~30 hardcoded
  strings were migrated to the translation system (time-range picker, confirmation
  dialogs, toasts, admin filter/field labels, settings tab names…), and all dates and
  numbers now format in the user's locale through one shared formatter — previously 23
  spots were pinned to French formatting regardless of the chosen language. A stricter
  per-file CI gate now enforces **zero** hardcoded literals (down from a tolerated 36).

- **New: a content language per instance.** The instructions Atrium generates *for
  agents* — the default prompt injections (including the file-curation brief), the
  conversation-history rehydration framing, and sub-agent digest labels — now follow a
  configurable content language: per-instance override (Settings › Prompt injections ›
  "Language of generated texts") → the app's default language → French. Built-in French
  **and English** templates ship for all five injections, the injections editor previews
  and resets in the effective language, and a per-turn routed chat follows the *routed*
  instance's language so a whole turn stays in one language.

- **Notifications are localized when read, not when written.** The bell renders each
  notification from a stable key + parameters in the *reader's current* language:
  switching languages re-translates past notifications, and every admin in a fan-out
  reads in their own language. (Also fixes a bell crash that a file-curation
  notification could trigger.)

- **Send failures show localized, actionable messages.** Dispatch errors (no agent
  assigned, service unavailable, attachment too large or rejected…) are now stored as
  stable codes and translated in the UI — they were previously frozen French sentences.
  The finer diagnostic codes are preserved for the observability API.

- **Adding a language is now a two-step, CI-guarded change.** One locale module drives
  the account/profile validation, both language pickers (labeled by each language's own
  name), the translation-parity gate (now derived from the Paraglide config, refusing
  orphan catalogs), and the first-paint `<html lang>` seed. A synchronization test turns
  every formerly-silent omission — the old process had five — into a CI failure.

## [0.32.0] — Agent-file curation, sturdier context-overflow handling, and text-first media

Feature + reliability release. Adds opt-in auto-management of over-budget agent files, hardens
how context overflows are classified and surfaced, and makes a reply's text appear before a large
attachment finishes uploading. No breaking changes; Convex changes are additive.

- **Agent files can be rationalized instead of silently truncated (opt-in, propose-and-approve).**
  When an agent file (MEMORY.md, AGENTS/SOUL/IDENTITY/TOOLS/USER) exceeds its budget, OpenClaw
  truncates it at injection and the tail is lost. A new **File curator** specialist agent type can
  now rewrite the file smaller while preserving the relevant content. The result is a **proposed**
  revision an admin reviews (full before/after + the removed-lines sample) and approves — the file
  is **never rewritten automatically**. Approving records a revertible revision; a concurrent edit
  is caught by compare-and-set. **Off by default**, enabled per instance in Settings › Chat
  defaults with a per-file budget; the "Rationalize" trigger + review live in Settings › Agent
  files. Copies of file content are purged from the job once it resolves (PII hygiene). Works over
  the provider-neutral file surface, so it is Hermes-ready.

- **Context overflows are classified and surfaced more reliably.** The overflow detector now
  recognizes every provider phrasing OpenClaw documents (previously it caught only two), so a hard
  overflow always shows the actionable "delegate to sub-agents / compact / new chat" card instead
  of a generic error. A **stuck compaction** (the gateway starts optimizing a large session then
  goes silent) now ends with a clear, actionable message rather than ~15 minutes of "thinking"
  followed by a blank reply. A lifecycle error that carries only a structured overflow code (no
  matching text) is now classified too, and the UI keeps a client-side fallback so a novel phrasing
  still gets the card.

- **A reply's text no longer waits behind a large media upload.** When an agent delivers a big
  file, the reply text now appears immediately and the attachment arrives once its upload finishes,
  instead of the text being held until the (potentially slow) upload completed. Media delivery is
  never dropped, part order is preserved, and a failed delivery is rescued by the deterministic
  outbound scan. Media traces now carry the fetch + upload durations (and the chat id) so a
  "the text lagged behind the video" report is diagnosable from the traces.

## [0.31.0] — User reports get a support loop: an agent can read, answer, and resolve them

Observability + support release. A key-authed service account (the gateway's meta/critic agent,
or any role holding the new support permission) can now work through the user-report inbox end
to end. No breaking changes; Convex changes are additive.

- **User reports can be listed, answered, and resolved by a support agent.** The support loop is
  now API-complete: a key-authed service account holding the new `feedback.respond` permission
  (granted to the built-in `agent` role, and grantable to custom roles in Settings › Roles) can
  list the open reports, read one by its reference, reply into its thread — the report owner is
  notified in Atrium, the reply attributed to a support agent — and mark it resolved. Resolution
  is idempotent and keeps the report and its thread visible to the owner (a "resolved" state in
  their notification bell and in the admin table), with an optional closing note that explains
  why. Three matching observability-MCP tools (`list_feedback_reports`, `reply_feedback_report`,
  `close_feedback_report`) make this the meta/critic gateway agent's inbox: check reports, fix or
  explain, answer, close. Every call is audit-logged (reference and lengths only, never content),
  a report the user withdrew refuses further replies, and reading the inbox requires the support
  permission (a report's free-text comment is user content, not metadata). Note for existing
  deployments: an already-seeded `agent` role picks up the new permission the next time an admin
  opens Settings › Access or mints a key.

## [0.30.1] — Corrective: a release re-run can no longer be blocked by npm's write-once wall

Corrective patch, release pipeline only — no runtime artifact changes. Lived on 0.30.0: the
MCP package's Trusted Publisher was misconfigured on the first pass, and the subsequent
"Re-run all jobs" re-ran the root npm publish too, which died on npm's write-once registry
("You cannot publish over the previously published versions") — leaving the GitHub Release
step permanently skipped for that tag. Both npm publish jobs now carry an idempotence guard:
if the tag's version is already on the registry, the job succeeds as a no-op instead of
failing, so any re-run converges to a green pipeline and the GitHub Release is always
created. The 0.30.0 release notes remain in the section below; that tag has no GitHub
Release page.

## [0.30.0] — The protocol matrix closes its last gaps; the observability MCP goes to npm

Observability release. The bridge's protocol contract now covers its whole vendored surface,
per-turn diagnostics get real usage numbers, and the observability MCP server becomes an
installable npm package. No breaking changes; Convex changes are additive.

- **The protocol matrix reads 0 gaps, and the "unknown fields" alarm is silenced for good
  reason.** The 22 unknown fields the drift detector flagged on live deployments are the
  gateway's session/run metadata flattened onto agent events (model, tokens, cost, status…) —
  now part of the documented wire envelope, so the detector stays armed for genuinely new
  fields only. The six declared gaps are closed: the terminal `stopReason` is recorded into the
  per-turn diagnostic trace (allowlisted values only — never a raw network string; diagnosis,
  never classification), and real post-turn usage (input/output/total tokens, cost) is consumed
  from the agent-event metadata when the gateway stamps it — per-turn cost read directly
  instead of by delta between turns. Settings › Bridge now shows
  41 handled · 50 deliberately ignored · 0 gaps.
- **The observability MCP server is published to npm as `@lacneu/atrium-mcp`.** Same
  tag-driven, lockstep release as the app images (npm Trusted Publishing / OIDC), so
  `npx @lacneu/atrium-mcp@<version>` always matches the deployed `/api/v1` surface — the
  building block for wiring the observability tools into an agent (the meta/critic agent
  pattern) without cloning the repo.

## [0.29.0] — A report's reference becomes actionable for support

Small observability release. The reference shown after submitting a report can now be used to
fetch the report itself: a key-authed diagnostic endpoint (`GET /api/v1/feedback-report`) and a
matching observability-MCP tool (`get_feedback_report`) return the frozen forensic snapshot by
reference — including after the reported message or its whole conversation has been deleted
(the report survives deletion, now pinned by a test). Requires `traces.read`; every read is
audit-logged with the reference only, never content.

## [0.28.2] — Corrective: message actions stay available while a reply is running

Corrective patch, frontend only. The per-message actions (copy, source view, report, delete)
used to disappear entirely while a reply was streaming — you could not copy an earlier answer
until the current turn finished. The action bars now stay available during a running turn; only
Delete is held while a reply streams (with an explanatory tooltip), since truncating and
regenerating mid-stream would race the running turn. Verified live: copying an earlier message
works while a reply streams, and the delete button re-enables the moment the turn settles.

## [0.28.1] — Corrective: a delivered answer is never repainted as a failed turn

Corrective patch, bridge only. When the gateway finished streaming a full reply and THEN failed
after it (observed live: the post-turn compaction timed out and emitted a context-overflow
error on the same run), Atrium showed the complete answer buried under an error card — while
the gateway's own Control UI showed the answer with a separate warning. A gateway error
arriving after real streamed content AND after the run's own end-of-generation signal now
finalizes the turn as complete: the answer stands, and the per-turn diagnostic trace keeps the
error class through a trace-only channel (never the message's error code, which would paint an
error card on a successful reply). A failure during generation or tool work, or before any
content, keeps its honest error card — a truncated reply is never silently marked complete.

## [0.28.0] — Large pastes become attachments: the context stays light

Robustness release focused on one high-impact behavior: what happens when a user pastes a huge
text into the composer. No breaking changes.

- **A huge pasted text no longer blows the agent's context.** Pasting a big log or document
  into the composer used to inline it into the prompt — a single paste could overflow the
  agent's context window before compaction had any chance to run (observed live on a pasted
  config log). A paste above ~8,000 characters (or 150 lines) is now automatically converted
  into a text attachment: the composer shows the file chip, a toast explains the conversion,
  and the agent receives the full content by reference through the existing attachment pipeline
  (with its gateway-derived size caps). Ordinary snippets keep pasting inline with zero
  friction — the same pattern Claude Code and VS Code use for large pastes. Verified live
  end-to-end: a 300-line pasted log became `texte-colle-1.txt`, and the agent opened and
  answered from the file while the prompt stayed light.
- **Auto-generated paste files are kept out of your file listing.** Files created by the
  paste-as-file conversion are stamped as auto-generated end-to-end and hidden by default in
  Settings › Files — the listing shows your real files. A toggle ("Show auto-generated files")
  reveals them, each tagged with an "Auto-generated" badge. Files from before this release are
  unmarked and keep appearing as regular files.
- **The conversion is careful about every edge.** Sending is held (Enter and the send button)
  until the pasted attachment has actually landed, including when several pastes overlap; while
  a reply is already running, a large paste is refused with a clear message (queued follow-ups
  are text-only) and the clipboard keeps the content; a paste that exceeds even the attachment
  cap fails loudly WITHOUT falling back to inlining; and a clipboard carrying files (an image
  copied from an office document) keeps the native file handling — nothing is silently dropped.

## [0.27.0] — A killed gateway no longer swallows the answer; images get a real viewer

Robustness + UX release. The headline fix closes a real observed gap: the gateway restarting
mid-reply used to silently swallow the finished answer; Atrium now recovers it. Plus an image
viewing overhaul and small fixes around error turns. No breaking changes.

- **A gateway restart mid-reply no longer swallows the answer.** When the gateway is restarted
  while a reply streams (a config change, an upgrade, a crash), it resumes the interrupted run
  after boot and finishes the answer — but that answer only landed in the gateway's own
  transcript, never in Atrium (observed live: 7 minutes of work invisible, while the gateway's
  own Control UI showed it). Atrium now detects the dropped connection, polls the session
  transcript over a fresh connection, and delivers the resumed run's real answer into the chat
  — verified live end-to-end (gateway killed mid-stream; the full reply appeared ~1 minute
  later). When the run could not be resumed, the turn settles honestly as "connection lost —
  retry" after a bounded wait instead of hanging.
- **Images show as thumbnails with a click-to-zoom viewer.** An image in a message (a user
  attachment or one generated by an agent) used to render full-width — thirty pasted images
  made a conversation unusable. Images now render as bounded thumbnails; clicking one opens a
  lightbox with fit/actual-size zoom, a fullscreen toggle, open-in-tab, and Escape/backdrop
  close. A pasted image in the composer shows a thumbnail preview instead of a generic file
  chip.
- **The copy button works on error turns.** On a turn that failed with no text, the copy action
  was silently disabled and read as a dead button; it now copies the displayed error message,
  and a genuinely empty action is visibly greyed rather than looking broken.
- **A report's reference is shown and copyable after submitting.** The feedback dialog now
  displays the submitted report's reference with a copy button, so a user can hand it to
  support (or paste it in any channel) instead of describing the report by memory.
- **Clearer wording on a dropped-connection turn.** The message no longer implies the reply
  will resume on its own — it tells you to send again or delete the turn to regenerate.

## [0.26.1] — Corrective: accents render correctly in generated text files

Corrective patch. A text file produced by an agent (or uploaded by a user) and opened in a
browser tab displayed mangled characters on every accent ("lâ€™historique" instead of
"l'historique"): the stored blob was UTF-8 but served without a charset, so browsers fell back
to Latin-1. Text-like uploads (markdown, plain text, CSV, JSON, XML, SVG) now carry an explicit
`charset=utf-8`, on both upload paths (agent-generated files through the bridge, user
attachments through the composer). Verified live end-to-end: an agent-generated French file now
serves as `text/markdown; charset=utf-8` and renders every accent correctly. Files stored
before this release keep their old header — re-generate them to fix their display. No other
changes.

## [0.26.0] — Launch hardening: dropped connections read honestly, richer diagnostics

Reliability pass ahead of opening Atrium to users, grounded in live testing on the dev
deployment. The common conversation path was hammered clean, a real dropped-connection failure
mode was fixed, and the operator diagnostics learned the new failure classes. No breaking
changes; Convex changes are additive.

- **A dropped gateway connection now reads as "connection lost — retry", not a user
  "Interrupted".** On the dev deployment a turn that ended because the gateway dropped its
  socket mid-reply (a large-session compaction that recreates the session, a restart, a network
  blip) was frozen as if the user had pressed Stop — misleading, since the user did nothing. A
  mid-turn connection drop now settles as a clear, localized "the connection dropped, this is
  not a stop on your side, retry" error. A user Stop is never mistaken for it (Stop keeps the
  socket open), and the close path is now logged so any unclear terminal is diagnosable on its
  next occurrence.
- **Streamed replies survive mid-stream refreshes without locking up.** A replacement delta (a
  full-content refresh the protocol allows) now replaces the accumulated text AND lets the
  stream continue — an earlier form could freeze a reply mid-way. Verified across a batch of
  normal turns (short, long, multi-tool, markdown-heavy) that all rendered flawlessly.
- **Hard context overflows are explained, and the trace tells the story.** The overflow error
  (which real gateways report as plain text with no machine class) is recognized and shown with
  an actionable headline that names the real cause — the context meter reflects the state
  *before* the turn, while the overflow happens mid-turn as tool results pile up — and the
  per-turn diagnostic trace now records how many tool calls the turn ran, so a hard overflow at
  a low pre-turn fill is explained at a glance instead of by hand.
- **The operator diagnostics name the new failure classes instead of "unknown".** The shared,
  PHI-safe error allowlist behind `/api/v1/chat-state` and the observability MCP now includes
  `connection_lost` and the gateway's hard classes (`context_length`, `rate_limit`, `timeout`,
  `refusal`), so a support diagnosis reads the real class instead of collapsing to "unknown".
- **Broader test coverage on the recent work.** Added unit coverage for the Stop route's error
  paths, the coalesced tool-call counting and per-turn cost in the pressure trace, the
  connection-lost close path, the overflow fallback classification, and the diagnostic
  allowlist.

## [0.25.0] — Compaction is not an interruption: honest turn survival and causal overflow reading

A reliability release grounded in live testing: a gateway that pauses a turn to compact its
context no longer reads as a user interruption, hard overflows are classified even on gateways
that never send an error taxonomy, and the observability trace now tells the overflow story
causally. No breaking changes; Convex changes are additive.

- **A turn that pauses for context compaction no longer settles as "Interrupted".** When an
  agent (or the gateway itself) compacts a session mid-turn, the gateway abandons the run and
  resumes it after the replay — an intermediate state Atrium previously froze as an
  interruption (observed live: the reply never arrived even though the agent kept working).
  Both trigger paths are now guarded: an abort signal arriving while a compaction is pending
  keeps the turn open (the resumed run finishes in the same message), and a connection drop in
  that window defers instead of aborting, settling honestly after a bounded grace only if the
  resume never lands. A user stop keeps interrupting immediately.
- **Hard context overflows are classified even without a gateway error taxonomy.** Live
  captures showed real gateways report an overflow as bare text with no machine-readable kind;
  the known phrasings are now recognized so the actionable headline and the observability
  marker fire anyway. The headline also explains the confusing part: the context meter shows
  the pre-turn state, while the overflow happens mid-turn as tool results accumulate — with
  the advice that matters (delegate to sub-agents, compact, or start fresh).
- **The per-turn pressure trace now reads causally.** It carries the number of tool calls the
  turn executed, so a hard overflow at a low pre-turn fill is immediately explained
  ("40% before the turn + 66 tool calls → overflowed mid-turn") instead of requiring a manual
  reconstruction. Tool counting matches the coalesced delivery of real tools.
- **Streamed text survives mid-stream refreshes.** A replacement delta (a full-content refresh
  the protocol allows) now replaces the accumulated text and lets the stream continue —
  previously it either corrupted the reply (appended) or silently dropped everything after the
  refresh. The protocol coverage matrix moves to 38 handled / 47 ignored / 6 gaps.
- **The bridge status card says "Bridge contract" instead of "Protocol".** The version shown
  there is the bridge↔Atrium exchange contract, not the gateway protocol of the provider
  section below — the two no longer share a name.

## [0.24.0] — The protocol contract on screen: coverage matrix, drift, and per-turn cost

Completes the protocol-contract initiative started in 0.22.0/0.23.0 and closes the last
observability gap on turn economics. No breaking changes; Convex changes are additive.

- **Settings ▸ Bridge now shows exactly what the bridge supports of the gateway protocol.**
  The provider card gains a "Protocol" section: the vendored contract version the bridge was
  built against, the coverage counts (fields handled / deliberately ignored / declared gaps —
  each gap listed behind a collapsible toggle with its reason recorded in the repo), and an
  "aligned" badge that flips to a red "N unknown field(s)" warning the day a connected gateway
  starts emitting protocol this bridge build does not understand. In multi-bridge deployments
  the drift of ALL bridges is merged (never first-bridge-wins), so a single drifting instance
  cannot hide behind an aligned one.
- **Each turn's cost is now visible to observability.** The per-turn context-pressure trace
  (`chat.gateway_pressure`) carries the session's cumulative cost before the turn, sourced from
  the session snapshot the bridge already fetches (zero extra gateway calls) — the difference
  between two consecutive turns' traces is the cost of the turn. Chosen over the protocol's
  `usage` field after live captures showed real gateways never populate it (the coverage
  manifest documents that finding); the session panel keeps showing the cumulative cost.

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
